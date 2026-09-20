/**
 * UT Bot — per-pair config store (KV) + HTTP handlers.
 *
 * This KV record IS the per-pair gate the worker's scan loop reads and the
 * app's toggle UI writes. Single source, no second copy anywhere (the bot
 * needs none — per-pair on/off is a worker-side gate).
 *
 * KV layout (SIGNAL_CACHE):
 *   utbot:config -> {
 *     version: 1,
 *     updatedAt: ISO,
 *     pairs: {
 *       "BTC/USD": {
 *         enabled: true, timeframe: "15min", a: 1, c: 10,
 *         indicators: {
 *           utbot: { enabled: true },
 *           mkr:   { enabled: true, kernel: "Laplace", bandwidth: 14 },
 *         },
 *       },
 *       ...
 *     }
 *   }
 *   utbot:lastscan:<PAIR> -> close-time (ms) of the newest closed candle
 *     already processed for event emission (event idempotency across
 *     cron ticks and manual /api/signal calls; SHARED by all indicators —
 *     they all read the same candle boundary for a pair).
 *
 * Defaults (TradingView indicator defaults): enabled=true on first deploy,
 * timeframe 15min, a=1, c=10, every registry indicator enabled with its own
 * defaults. CFD mode: there is NO expiry anywhere — a setup stands until
 * the indicator flips to the opposite event.
 *
 * Auth posture: reads are public. Writes (POST) require the secret when
 * env.UTBOT_ADMIN_SECRET is configured (?secret= or x-utbot-secret header);
 * when unset, writes are allowed unauthenticated — matching the worker's
 * existing endpoint posture — and the deployer is expected to set the
 * secret. The response never echoes the secret.
 */

import { CONFIG, SCAN_PAIRS } from '../config.js';
import { sanitizePair } from '../utils/pairs.js';
import { jsonResponse } from '../utils/helpers.js';
import { INDICATORS } from '../strategy/registry.mjs';
import { MKR_KERNELS } from '../strategy/multiKernelRegression.mjs';

const TFS = CONFIG.UTBOT.TIMEFRAMES;

/** Per-indicator default config, from the registry + CONFIG constants. */
export function defaultIndicatorConfigs() {
  const out = {};
  for (const ind of INDICATORS) {
    out[ind.id] = { ...ind.defaultCfg };
  }
  if (out.mkr) {
    out.mkr.kernel = CONFIG.MKR.DEFAULT_KERNEL;
    out.mkr.bandwidth = CONFIG.MKR.DEFAULT_BANDWIDTH;
  }
  return out;
}

function sanitizeIndicatorConfigs(raw) {
  const d = defaultIndicatorConfigs();
  if (!raw || typeof raw !== 'object') return d;
  const out = d;
  // Per-indicator enabled gate (unknown ids ignored — registry is the source).
  for (const id of Object.keys(d)) {
    const r = raw[id];
    if (!r || typeof r !== 'object') continue;
    if (typeof r.enabled === 'boolean') out[id].enabled = r.enabled;
    else if (r.enabled === 'true') out[id].enabled = true;
    else if (r.enabled === 'false') out[id].enabled = false;
  }
  // MKR params (TradingView inputs: kernel select + bandwidth int >= 1).
  const m = raw.mkr;
  if (m && typeof m === 'object') {
    if (MKR_KERNELS.includes(m.kernel)) out.mkr.kernel = m.kernel;
    const bw = Math.trunc(Number(m.bandwidth));
    if (Number.isFinite(bw) && bw >= 1 && bw <= 200) out.mkr.bandwidth = bw;
  }
  return out;
}

export function defaultPairConfig() {
  return {
    enabled: true,
    timeframe: CONFIG.UTBOT.DEFAULT_TIMEFRAME,
    a: CONFIG.UTBOT.DEFAULT_A,
    c: CONFIG.UTBOT.DEFAULT_C,
    indicators: defaultIndicatorConfigs(),
  };
}

function sanitizePairConfig(raw) {
  const d = defaultPairConfig();
  if (!raw || typeof raw !== 'object') return d;
  const out = { ...d };
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  else if (raw.enabled === 'true') out.enabled = true;
  else if (raw.enabled === 'false') out.enabled = false;
  if (TFS.includes(raw.timeframe)) out.timeframe = raw.timeframe;
  const a = Number(raw.a);
  if (Number.isFinite(a) && a >= 0.1 && a <= 20) out.a = a;
  const c = Math.trunc(Number(raw.c));
  if (Number.isFinite(c) && c >= 1 && c <= 200) out.c = c;
  out.indicators = sanitizeIndicatorConfigs(
    raw.indicators && typeof raw.indicators === 'object'
      ? { ...d.indicators, ...raw.indicators }
      : raw.indicators,
  );
  return out;
}

/** Read the config store, merged over defaults for every scanned pair. */
export async function getUtBotConfig(env) {
  const pairs = {};
  for (const p of SCAN_PAIRS) pairs[p] = defaultPairConfig();
  let stored = null;
  if (env && env.SIGNAL_CACHE) {
    try { stored = await env.SIGNAL_CACHE.get(CONFIG.UTBOT.KV_CONFIG_KEY, 'json'); }
    catch (e) { stored = null; }
  }
  if (stored && typeof stored === 'object' && stored.pairs && typeof stored.pairs === 'object') {
    for (const key of Object.keys(stored.pairs)) {
      const pair = sanitizePair(key);
      if (pair && pairs[pair] !== undefined) pairs[pair] = sanitizePairConfig(stored.pairs[key]);
    }
  }
  return { version: 1, updatedAt: stored && stored.updatedAt ? stored.updatedAt : null, pairs };
}

export async function isPairEnabled(env, pair) {
  const cfg = await getUtBotConfig(env);
  const entry = cfg.pairs[pair];
  return entry ? entry.enabled === true : false;
}

function authorized(request, env) {
  const secret = env && env.UTBOT_ADMIN_SECRET ? String(env.UTBOT_ADMIN_SECRET).trim() : '';
  if (!secret) return true;   // no secret configured -> open (documented posture)
  const url = new URL(request.url);
  if (url.searchParams.get('secret') === secret) return true;
  const hdr = request.headers.get('x-utbot-secret');
  return hdr === secret;
}

/** GET /api/utbot/config — full merged config (public read). */
export async function handleUtBotConfigGet(env) {
  const cfg = await getUtBotConfig(env);
  return jsonResponse({ engine: CONFIG.ENGINE, defaults: defaultPairConfig(), ...cfg });
}

/**
 * POST /api/utbot/config — merge-write per-pair entries.
 * Body: { pairs: { "BTC/USD": { enabled: false }, ... } } (partial entries
 * are merged over current values; unknown pairs rejected; full objects
 * accepted so a params editor can ride the same endpoint later).
 */
export async function handleUtBotConfigPost(request, env) {
  if (!authorized(request, env)) return jsonResponse({ error: true, message: 'unauthorized' }, 401);
  if (!env || !env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'no KV' }, 503);
  let body = null;
  try { body = await request.json(); } catch (e) { body = null; }
  if (!body || typeof body !== 'object' || !body.pairs || typeof body.pairs !== 'object') {
    return jsonResponse({ error: true, message: 'body must be { pairs: { "<PAIR>": { enabled|timeframe|a|c|indicators } } }' }, 400);
  }
  const current = await getUtBotConfig(env);
  const updates = {};
  for (const key of Object.keys(body.pairs)) {
    const pair = sanitizePair(key);
    if (!pair || current.pairs[pair] === undefined) {
      return jsonResponse({ error: true, message: 'unknown pair: "' + key + '"' }, 400);
    }
    updates[pair] = sanitizePairConfig({ ...current.pairs[pair], ...body.pairs[key] });
  }
  const next = { version: 1, updatedAt: new Date().toISOString(), pairs: { ...current.pairs, ...updates } };
  try {
    await env.SIGNAL_CACHE.put(CONFIG.UTBOT.KV_CONFIG_KEY, JSON.stringify(next));
  } catch (e) {
    return jsonResponse({ error: true, message: 'KV write failed: ' + e.message }, 500);
  }
  return jsonResponse({ ok: true, engine: CONFIG.ENGINE, config: next });
}

// ── event-emission idempotency state ────────────────────────────────────────

export function lastScanKey(pair) {
  return CONFIG.UTBOT.KV_LASTSCAN_PREFIX + pair.replace(/\//g, '_').toUpperCase();
}

export async function getLastScanT(env, pair) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const v = await env.SIGNAL_CACHE.get(lastScanKey(pair));
    // NOTE: Number(null) === 0 in JS — a KV miss must stay null (the
    // fresh-deploy branch depends on it), never silently become 0.
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (e) { return null; }
}

export async function setLastScanT(env, pair, closeTMs) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    // 2 days is far beyond any outage the event window could bridge.
    await env.SIGNAL_CACHE.put(lastScanKey(pair), String(closeTMs), { expirationTtl: 48 * 3600 });
  } catch (e) { /* diagnostics must never break the scan */ }
}

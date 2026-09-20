/**
 * Multi-indicator cron scanner (every-15-minutes, aligned to candle closes)
 * + on-demand evaluation. THE LIVE SIGNAL PATH.
 *
 * Indicators come from the registry (src/strategy/registry.mjs) — currently
 * UT Bot Alerts (primary, exact TradingView port) and Multi Kernel
 * Regression [ChartPrime] (non-repaint port). The loop below is indicator-
 * AGNOSTIC: it runs every enabled registry entry over the same candle
 * window and lets each indicator speak only its own output.
 *
 * Every tick, for each config-enabled pair:
 *   1. fetch the pair's configured timeframe window ONCE (KV-cached, 300
 *      bars — UT Bot's Wilder recursion lead-in)
 *   2. run every enabled indicator -> event streams
 *   3. emit every NEW event (any indicator) whose candle closed after the
 *      stored last-scan close-time (idempotent across ticks and manual
 *      calls). Events on the SAME closed candle share ONE Telegram message
 *      (single-indicator text, or a combined "SIGNALS" text listing each
 *      indicator's own line):
 *      history save (one record per indicator event) -> Telegram push via
 *      the proven push plumbing (CFD style: indicator output only, no
 *      expiry/result messaging)
 *   4. write the latest snapshot (primary decision + per-indicator state)
 *      to the latest: cache
 *
 * Event timing = candle CLOSE confirmation. Events on a 1min/5min-
 * timeframe pair surface on the next 15-minute tick (up to 14 min late);
 * 15min pairs are exact to their boundary.
 */

import { CONFIG, SCAN_PAIRS, SCAN_CONFIG, ASSET_TYPE } from '../config.js';
import { sanitizePair, getAssetType } from '../utils/pairs.js';
import { CATALOG_PAIRS } from '../utils/pairCatalog.js';
import { isForexMarketOpen } from '../utils/session.js';
import { fetchCandlesWithCache, fetchCandles } from '../fetch/candles.js';
import { lastClosedIndexTf, TF_MS } from '../strategy/utBotAlerts.mjs';
import { INDICATORS } from '../strategy/registry.mjs';
import { writeLatest } from '../history/latestCache.js';
import { saveSignal, computeStats } from '../history/store.js';
import {
  pushSignalToSubscribers, SIGNAL_FORMATTERS, formatCombinedText, formatUtBotText,
} from './push.js';
import {
  getUtBotConfig, getLastScanT, setLastScanT,
} from './utbotConfig.js';
import { jsonResponse } from '../utils/helpers.js';

function mintSignalId() {
  return 'sig_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Convert a TwelveData candle row to the engine shape { t,o,h,l,c }. */
function toEngineCandles(rows) {
  return rows.map(c => ({
    t: new Date(String(c.datetime).replace(' ', 'T') + 'Z').getTime(),
    o: c.open, h: c.high, l: c.low, c: c.close,
  })).filter(k => Number.isFinite(k.t));
}

async function fetchWindow(pair, tf, env, ctx, assetType, noCache = false) {
  const limit = CONFIG.FETCH_LIMITS[tf] || CONFIG.UTBOT.WINDOW_BARS;
  if (noCache) {
    const res = await fetchCandles(pair, tf, limit, env, assetType);
    if (!res || res.error) throw new Error((res && res.error) || ('fetch failed ' + tf));
    const candles = toEngineCandles(res);
    if (candles.length === 0) throw new Error('empty window ' + tf);
    return candles;
  }
  const res = await fetchCandlesWithCache(pair, tf, limit, env, ctx, assetType);
  if (!res || res.error) throw new Error((res && res.error) || ('fetch failed ' + tf));
  const candles = toEngineCandles(res.candles);
  if (candles.length === 0) throw new Error('empty window ' + tf);
  return candles;
}

export function selectActivePairs(pairs = SCAN_PAIRS, forexOpen = isForexMarketOpen()) {
  const active = [];
  for (const raw of pairs) {
    const pair = sanitizePair(raw);
    if (!pair) continue;
    if (getAssetType(pair) === ASSET_TYPE.FOREX && !forexOpen) continue;
    active.push(pair);
  }
  return active;
}

/**
 * Enabled pairs straight from the config store (catalog order first, custom
 * search-added pairs after). The universe is NOT limited to the default 8 —
 * pairs switched on from the Telegram panel are scanned exactly the same.
 */
export function enabledPairsFromConfig(cfg) {
  const pairs = (cfg && cfg.pairs) || {};
  const keys = CATALOG_PAIRS.filter(p => pairs[p]).concat(
    Object.keys(pairs).filter(p => !CATALOG_PAIRS.includes(p)).sort(),
  );
  return keys.filter(p => pairs[p] && pairs[p].enabled === true);
}

/**
 * Run every enabled indicator over one candle window (registry-driven,
 * indicator-agnostic). Order follows the registry — deterministic for
 * message layout.
 */
function runIndicators(candles, cfg, meta) {
  const indCfg = cfg.indicators || {};
  const out = [];
  for (const ind of INDICATORS) {
    const icfg = { ...ind.defaultCfg, ...(indCfg[ind.id] || {}), a: cfg.a, c: cfg.c };
    if (icfg.enabled === false) continue;   // per-indicator gate (KV config)
    out.push({ id: ind.id, ind, cfg: icfg, series: ind.compute(candles, icfg, meta) });
  }
  return out;
}

/**
 * Evaluate one pair right now: compute every enabled indicator over the
 * configured timeframe, determine new events since the last processed
 * candle, and return the response object (also written to the latest:
 * cache). Never throws — failures come back as { error }.
 */
const LAG_RETRIES = CONFIG.UTBOT.LAG_RETRIES;
const LAG_SLEEP_MS = CONFIG.UTBOT.LAG_SLEEP_MS;

export async function evaluatePair(pair, env, ctx, now = Date.now(), pairCfg = null, lastScanT = null) {
  const assetType = getAssetType(pair);
  if (assetType === ASSET_TYPE.FOREX && !isForexMarketOpen()) {
    return { pair, marketStatus: 'CLOSED', signal: null, generatedAt: new Date().toISOString() };
  }

  const cfg = pairCfg || (await getUtBotConfig(env)).pairs[pair];
  const tf = cfg.timeframe;
  const tfMs = TF_MS[tf];

  let attempt = 0;
  while (true) {
    const candles = await fetchWindow(pair, tf, env, ctx, assetType, attempt > 0);
    const i = lastClosedIndexTf(candles, now, tfMs);
    if (i < 0) throw new Error('no closed ' + tf + ' candle');

    // Freshness retry: the just-closed boundary candle usually reaches the
    // feed 1-3s late; if the newest CLOSED candle is a full period behind
    // "now", sleep + re-fetch before emitting (same contract as the previous
    // engine — never emit on a stale window when we can avoid it).
    const newestCloseT = candles[i].t + tfMs;
    if (now - newestCloseT >= tfMs && attempt < LAG_RETRIES) {
      attempt++;
      await new Promise(res => setTimeout(res, LAG_SLEEP_MS));
      continue;
    }

    const outputs = runIndicators(candles, cfg, { tfMs });
    return buildResult(pair, assetType, candles, i, tf, tfMs, cfg, outputs, lastScanT);
  }
}

function buildResult(pair, assetType, candles, i, tf, tfMs, cfg, outputs, lastScanT) {
  const candle = candles[i];
  const closeT = candle.t + tfMs;

  // Pending events = every event (any indicator) whose candle closed
  // strictly after the last processed close-time. Missing state (fresh
  // deploy) -> only the newest closed candle is eligible (never replay
  // history). Covers multi-event gaps (e.g. a 1min-timeframe pair between
  // */15 ticks).
  const pending = [];
  for (const out of outputs) {
    for (const e of out.series.events) {
      const isNew = lastScanT === null ? e.i === i : e.closeT > lastScanT && e.closeT <= closeT;
      if (isNew) pending.push({ id: out.id, ind: out.ind, event: e });
    }
  }

  // Primary decision = UT Bot (CONFIG.ENGINE, app-facing back-compat).
  const utbotOut = outputs.find(o => o.id === 'utbot') || null;
  let decision = 'NO_TRADE';
  let newestEvent = null;
  if (utbotOut) {
    const utbotPending = pending.filter(p => p.id === 'utbot').map(p => p.event);
    newestEvent = utbotPending.length > 0 ? utbotPending[utbotPending.length - 1]
      : (utbotOut.series.buy[i] ? { type: 'buy' } : utbotOut.series.sell[i] ? { type: 'sell' } : null);
    decision = newestEvent && newestEvent.type === 'buy' ? 'BUY'
      : newestEvent && newestEvent.type === 'sell' ? 'SELL' : 'NO_TRADE';
  }

  const signal = {
    engine: CONFIG.ENGINE,
    finalSignal: decision,
    reason: decision === 'BUY' ? 'UT_BOT_BUY_CROSS'
      : decision === 'SELL' ? 'UT_BOT_SELL_CROSS' : 'UT_BOT_NO_EVENT',
    pair,
    market: assetType === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX',
    timeframe: tf,
    timestamp: new Date(closeT).toISOString(),
    currentPrice: candle.c,
    audit: {
      event: newestEvent ? newestEvent.type : null,
      key: cfg.a,
      atrPeriod: cfg.c,
      atr: utbotOut ? utbotOut.series.atr[i] : undefined,
      nLoss: utbotOut && utbotOut.series.atr[i] !== undefined ? cfg.a * utbotOut.series.atr[i] : undefined,
      stop: utbotOut ? utbotOut.series.stop[i] : undefined,
      stopPrev: utbotOut && i > 0 ? utbotOut.series.stop[i - 1] : null,
      pos: utbotOut ? utbotOut.series.pos[i] : undefined,
      posPrev: utbotOut && i > 0 ? utbotOut.series.pos[i - 1] : null,
      crossover: newestEvent ? (newestEvent.type === 'buy' ? 'above' : 'below') : null,
      timeframe: tf,
      eventCandle: { t: candle.t, closeT },
      barIndex: i,
      pendingEventCount: pending.length,
    },
    entryPrice: null, expiryMinutes: null, expiryTime: null, atrPercentile: null,
    indicators: {},
  };

  if (decision !== 'NO_TRADE') {
    signal.entryPrice = candle.c;
    signal.entryTime = new Date(closeT).toISOString();
    // CFD mode: NO expiry. The setup is valid until the indicator flips to
    // the opposite event — expiryMinutes/expiryTime stay null, so no pending
    // record is written and no result is ever produced.
  }

  // Per-indicator snapshot at the newest closed candle (API + latest cache).
  for (const out of outputs) {
    signal.indicators[out.id] = { enabled: true, ...out.ind.snapshot(out.series, i, out.cfg) };
  }

  return {
    pair,
    marketStatus: 'OPEN',
    signal,
    source: CONFIG.ENGINE,
    generatedAt: new Date().toISOString(),
    _pending: pending,
    _series: { i, closeT, newestClosedCloseT: closeT },
  };
}

/**
 * Emit a batch of pending events (any indicator) for one pair.
 *
 * Grouping contract: events that landed on the SAME closed candle share ONE
 * Telegram message — a single-indicator text when only one indicator fired,
 * a combined "SIGNALS" text listing each indicator's own line otherwise
 * (user requirement: each indicator gives its own single signal; when they
 * fire together, the signal says it). History keeps ONE record per
 * indicator event regardless of grouping.
 */
async function emitEvents(pair, cfg, pending, env) {
  const byClose = new Map();
  for (const item of pending) {
    const k = item.event.closeT;
    if (!byClose.has(k)) byClose.set(k, []);
    byClose.get(k).push(item);
  }
  const closeTs = [...byClose.keys()].sort((a, b) => a - b);

  for (const closeT of closeTs) {
    const group = byClose.get(closeT);
    const closeIso = new Date(closeT).toISOString();
    const market = getAssetType(pair) === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX';

    // One history record per indicator event (registry order, oldest event
    // first). Deduped records (re-poll of a live setup) still take part in
    // message decisions below only if at least one record is fresh — a
    // fully-deduped group pushes nothing.
    const items = [];
    for (const { id, ind, event } of group) {
      const icfg = { ...ind.defaultCfg, ...((cfg.indicators || {})[id] || {}), a: cfg.a, c: cfg.c };
      const sig = ind.toSignal(event, pair, icfg, {
        timestamp: closeIso,
        market,
        timeframe: cfg.timeframe,
      });
      const record = {
        id: mintSignalId(),
        pair,
        market: sig.market,
        engine: ind.engineTag,
        indicator: ind.id,
        direction: sig.finalSignal,      // CFD vocab: BUY/SELL
        entryPrice: sig.entryPrice,
        entryTime: sig.entryTime,
        expiryTime: sig.expiryTime,
        expiryMinutes: sig.expiryMinutes,
        atrPercentile: null,
        indicators: sig.audit,
        timestamp: sig.entryTime,
        currentPrice: sig.currentPrice,
        result: null, exitPrice: null, checkedAt: null, checks: 0,
      };
      const saved = await saveSignal(record, env);
      if (!saved.deduped) {
        sig.signalId = record.id;
        items.push({
          ind,
          name: ind.name,   // belt-and-braces: formatter must never print "undefined"
          sig,
          record,
          label: ind.eventLabel(event.type),
          detail: ind.detail(sig.audit),
        });
      } else {
        sig.signalId = saved.duplicateOf;
      }
    }

    if (items.length === 0) continue;    // every event already recorded

    let text, directionTag, signalId;
    if (items.length === 1) {
      const it = items[0];
      text = (SIGNAL_FORMATTERS[it.ind.id] || formatUtBotText)(it.sig);
      directionTag = it.record.direction;
      signalId = it.record.id;
    } else {
      text = formatCombinedText(items);
      directionTag = items.map(it => it.record.direction).join('+');
      signalId = items[0].record.id;
    }
    // Await the push (scan ticks are awaited — nested waitUntil could
    // freeze the isolate before sendMessage completes; proven lesson).
    await pushSignalToSubscribers({ signalId, pair, direction: directionTag, text }, env);
  }
}

/** Full scan of one pair: evaluate -> emit events -> latest: cache. */
export async function scanOnePair(pair, generationId, env, ctx, opts = {}) {
  try {
    const cfg = (await getUtBotConfig(env)).pairs[pair];
    // Per-pair gate (app/bot toggle). opts.force previews a disabled pair
    // (bot "Scan now"): evaluate WITHOUT pushing and without recording
    // events, so nothing reaches subscribers for a pair that is off.
    if (!cfg || (cfg.enabled !== true && !opts.force)) return null;

    const now = opts.now || Date.now();
    const lastScanT = await getLastScanT(env, pair);
    const result = await evaluatePair(pair, env, ctx, now, cfg, lastScanT);
    if (!result || result.error) {
      console.warn('scanOnePair ' + pair + ' error: ' + (result && result.message ? result.message : 'unknown'));
      return null;
    }
    if (!result.signal) return null;   // market closed — nothing to cache

    const { _pending, _series, ...cleanResult } = result;

    if (!opts.noPush && _pending.length > 0) {
      await emitEvents(pair, cfg, _pending, env);
    }

    // Advance the idempotency cursor to the newest closed candle we've
    // processed, whether or not it carried an event (shared by all
    // indicators — they all read the same candle boundary for the pair).
    await setLastScanT(env, pair, _series.newestClosedCloseT);

    await writeLatest(pair, cleanResult, { generationId, generatedAt: result.generatedAt, opportunistic: false }, env);
    return cleanResult;
  } catch (e) {
    console.warn('scanOnePair exception ' + pair + ': ' + e.message);
    return null;
  }
}

/** every-15-minutes cron entry. */
export async function scheduledScan(env, ctx) {
  const startTime = Date.now();
  if (!env || !env.SIGNAL_CACHE) return { ok: 0, failed: 0, aborted: true };

  const generationId = 'gen_' + Date.now().toString(36);
  const cfg = await getUtBotConfig(env);
  // Config gate first: disabled pairs are skipped entirely (no fetch).
  // Universe = every config pair (catalog + custom), not just the default 8.
  const enabledPairs = enabledPairsFromConfig(cfg);
  const activePairs = selectActivePairs(enabledPairs);
  let ok = 0, failed = 0, processed = 0;

  for (let i = 0; i < activePairs.length; i += SCAN_CONFIG.BATCH_SIZE) {
    if (Date.now() - startTime > SCAN_CONFIG.MAX_SCAN_DURATION_MS) break;
    const batch = activePairs.slice(i, i + SCAN_CONFIG.BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(pair => scanOnePair(pair, generationId, env, ctx)));
    for (const r of results) {
      processed++;
      if (r.status === 'fulfilled' && r.value) ok++;
      else failed++;
    }
    if (i + SCAN_CONFIG.BATCH_SIZE < activePairs.length) {
      await new Promise(res => setTimeout(res, SCAN_CONFIG.BATCH_DELAY_MS));
    }
  }
  console.log('scheduledScan ' + generationId + ': ' + ok + ' ok, ' + failed + ' failed, '
    + processed + ' processed, ' + (Date.now() - startTime) + 'ms');
  return { ok, failed, processed, generationId };
}

// ── HTTP handlers ────────────────────────────────────────────────────────────
export async function handleSignal(pair, env, ctx, opts = {}) {
  const preferCache = opts.preferCache === true;
  if (preferCache && env.SIGNAL_CACHE) {
    try {
      const cached = await env.SIGNAL_CACHE.get('latest:' + pair.replace(/\//g, '_').toUpperCase(), 'json');
      if (cached && !cached.stale) return jsonResponse(cached);
    } catch (e) { /* fall through to fresh evaluation */ }
  }
  try {
    const result = await scanOnePair(pair, null, env, ctx, { noPush: opts.noPush === true });
    if (!result) return jsonResponse({ error: true, message: 'evaluation failed (fetch or market closed)' }, 502);
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: true, message: e.message }, 500);
  }
}

export async function handleBatch(url, env, ctx) {
  const raw = (url.searchParams.get('pairs') || SCAN_PAIRS.join(',')).split(',');
  const pairs = raw.map(p => sanitizePair(p.trim())).filter(Boolean).slice(0, 12);
  const out = {};
  await Promise.allSettled(pairs.map(async p => {
    out[p] = await scanOnePair(p, 'batch_' + Date.now().toString(36), env, ctx, { noPush: true });
  }));
  return jsonResponse({ cached: false, signals: out, pairCount: Object.keys(out).length, timestamp: new Date().toISOString() });
}

export async function handleStats(url, env) {
  const rawPair = url.searchParams.get('pair');
  if (rawPair) {
    const pair = sanitizePair(rawPair);
    if (!pair) return jsonResponse({ error: true, message: 'Invalid pair' }, 400);
    return jsonResponse(await computeStats(pair, env));
  }
  const all = {};
  for (const p of SCAN_PAIRS) all[p] = await computeStats(p, env);
  return jsonResponse({ engine: CONFIG.ENGINE, pairs: all, timestamp: new Date().toISOString() });
}

// ── scan watchdog (cron resilience) ─────────────────────────────────────────
// The cron trigger is platform-managed and has been observed going SILENT
// while the worker itself stayed healthy (2026-09-20: scheduled invocations
// stopped at 07:00 UTC; engine/fetch/push all fine). The watchdog gives the
// scan a second way to run: ANY fetch-path request (bot tap, app poll,
// health check) opportunistically runs a catch-up scheduledScan when the
// newest scan cursor is stale. Correctness under concurrency is inherited
// from the existing layers: saveSignal() dedupes re-polls and the push lock
// (30 min per chat+pair+direction) swallows duplicate deliveries.

const WD_LOCK_KEY = 'scan:watchdog:lock';
const WD_LOCK_TTL_S = 600;        // 10 min — one catch-up per lock window
// Probe cursors on always-on markets (crypto advances every candle; forex
// cursors legitimately idle on weekends).
const WD_PROBE_PAIRS = ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD'];
// Healthy cadence = a scan lands within ~1 min after every 15-min boundary.
// Two full periods stale means the cron did not run.
const WD_STALE_MS = 31 * 60 * 1000;

/**
 * Fire-and-forget from the fetch handler (ctx.waitUntil). Never throws,
 * never blocks the response, no-ops quickly while the cron is healthy.
 */
export async function runScanWatchdog(env, ctx, now = Date.now()) {
  if (!env || !env.SIGNAL_CACHE) return { ran: false, reason: 'no KV' };
  try {
    const locked = await env.SIGNAL_CACHE.get(WD_LOCK_KEY);
    if (locked) return { ran: false, reason: 'locked' };

    let newest = 0;
    for (const p of WD_PROBE_PAIRS) {
      const t = await getLastScanT(env, p);
      if (t && t > newest) newest = t;
    }
    if (now - newest <= WD_STALE_MS) return { ran: false, reason: 'fresh', newest };

    await env.SIGNAL_CACHE.put(WD_LOCK_KEY, String(now), { expirationTtl: WD_LOCK_TTL_S });
    console.warn('scan watchdog: newest cursor ' + (newest ? new Date(newest).toISOString() : 'none')
      + ' is stale -> catch-up scheduledScan');
    const r = await scheduledScan(env, ctx);
    console.warn('scan watchdog: catch-up done ' + JSON.stringify({ ok: r.ok, failed: r.failed }));
    return { ran: true, result: r };
  } catch (e) {
    console.warn('scan watchdog error: ' + e.message);
    return { ran: false, reason: 'error: ' + e.message };
  }
}

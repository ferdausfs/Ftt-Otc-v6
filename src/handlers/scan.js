/**
 * FTT3 — cron scanner (every-5-minutes, aligned to 5m candle closes) + on-demand signal.
 *
 * Every tick, for each active pair:
 *   1. fetch the three candle windows (1m/5m/15m, KV-cached, key rotation)
 *   2. evaluateSignal() — C1 bias -> C2 cross -> C3 vol gate, dynamic expiry
 *   3. write the decision (CALL/PUT/NO_TRADE + audit) to the latest: cache
 *   4. CALL/PUT only: dedup-guarded history save -> Telegram push
 *
 * The engine can only fire on 5m boundaries, so scanning every 5 minutes is
 * the exact cadence the strategy needs — no wasted credits in between.
 */

import { CONFIG, SCAN_PAIRS, SCAN_CONFIG, ASSET_TYPE } from '../config.js';
import { sanitizePair, getAssetType } from '../utils/pairs.js';
import { isForexMarketOpen } from '../utils/session.js';
import { fetchCandlesWithCache, fetchCandles } from '../fetch/candles.js';
import { evaluateSignal, precompute, lastClosedIndex, MS_1M } from '../strategy/engine.mjs';
import { writeLatest } from '../history/latestCache.js';
import { saveSignal, computeStats } from '../history/store.js';
import { pushSignalToSubscribers, formatSignalText } from './push.js';
import { jsonResponse } from '../utils/helpers.js';

const TIMEFRAMES = ['15min', '5min', '1min'];

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
  if (noCache) {
    // Retry path: a cached window would pin the same stale candle set for the
    // whole TTL (50s for 1min) — longer than the lag-retry loop itself.
    const res = await fetchCandles(pair, tf, CONFIG.FETCH_LIMITS[tf], env, assetType);
    if (!res || res.error) throw new Error((res && res.error) || ('fetch failed ' + tf));
    const candles = toEngineCandles(res);
    if (candles.length === 0) throw new Error('empty window ' + tf);
    return candles;
  }
  const res = await fetchCandlesWithCache(pair, tf, CONFIG.FETCH_LIMITS[tf], env, ctx, assetType);
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
 * Evaluate one pair right now. Returns the response object also written to
 * the latest: cache. Never throws — failures come back as { error }.
 *
 * Boundary-lag retries: the every-5-minutes cron fires exactly on the boundary, but the
 * just-closed 1m candle usually reaches TwelveData's feed 1-3s later. When the
 * fetched window's last closed candle is NOT the boundary candle we sleep and
 * re-fetch a few times before giving up — otherwise every cron tick would
 * systematically miss its own boundary.
 */
const LAG_RETRIES = 3;
const LAG_SLEEP_MS = 5000;

export async function evaluatePair(pair, env, ctx, now = Date.now()) {
  const assetType = getAssetType(pair);
  if (assetType === ASSET_TYPE.FOREX && !isForexMarketOpen()) {
    return { pair, marketStatus: 'CLOSED', signal: null, generatedAt: new Date().toISOString() };
  }

  let attempt = 0;
  while (true) {
    // Attempt 0 uses the KV cache (cheap for manual calls); every lag retry
    // fetches direct — a cached 1min window outlives the retry interval.
    const [c15, c5, c1] = await Promise.all(
      TIMEFRAMES.map(tf => fetchWindow(pair, tf, env, ctx, assetType, attempt > 0)),
    );
    const i = lastClosedIndex(c1, now);
    if (i < 0) throw new Error('no closed 1m candle');

    const r = evaluateSignal(c15, c5, c1, i, precompute({ c15, c5, c1 }));
    if (r.reason !== 'NOT_5M_BOUNDARY' || attempt >= LAG_RETRIES) {
      return buildResult(pair, assetType, c15, c5, c1, i, r);
    }
    attempt++;
    await new Promise(res => setTimeout(res, LAG_SLEEP_MS));
  }
}

function buildResult(pair, assetType, c15, c5, c1, i, r) {
  const entryCloseT = c1[i].t + MS_1M;

  const signal = {
    engine: CONFIG.ENGINE,
    finalSignal: r.decision,
    reason: r.reason,
    pair,
    market: assetType === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX',
    timestamp: new Date(entryCloseT).toISOString(),
    currentPrice: c1[i].c,
    audit: r.audit,
    entryPrice: null, expiryMinutes: null, expiryTime: null, atrPercentile: null,
  };

  if (r.decision === 'CALL' || r.decision === 'PUT') {
    signal.entryPrice = c1[i].c;
    signal.entryTime = new Date(entryCloseT).toISOString();
    signal.expiryMinutes = r.audit.expiry.minutes;
    signal.expiryTime = new Date(entryCloseT + r.audit.expiry.minutes * MS_1M).toISOString();
    signal.atrPercentile = r.audit.expiry.atrPercentile;
  }
  return {
    pair,
    marketStatus: assetType === ASSET_TYPE.CRYPTO ? 'OPEN' : 'OPEN',
    signal,
    source: 'FTT3',
    generatedAt: new Date().toISOString(),
  };
  return result;
}

/** Full scan of one pair: evaluate -> latest: cache -> history -> push. */
export async function scanOnePair(pair, generationId, env, ctx, opts = {}) {
  try {
    const result = await evaluatePair(pair, env, ctx, opts.now || Date.now());
    if (!result || result.error) {
      console.warn('scanOnePair ' + pair + ' error: ' + (result && result.message ? result.message : 'unknown'));
      return null;
    }
    if (!result.signal) return null;   // market closed — nothing to cache

    const sig = result.signal;
    if ((sig.finalSignal === 'CALL' || sig.finalSignal === 'PUT') && !opts.noPush) {
      const record = {
        id: mintSignalId(),
        pair,
        market: sig.market,
        engine: CONFIG.ENGINE,
        direction: sig.finalSignal,
        entryPrice: sig.entryPrice,
        entryTime: sig.entryTime,
        expiryTime: sig.expiryTime,
        expiryMinutes: sig.expiryMinutes,
        atrPercentile: sig.atrPercentile,
        indicators: sig.audit,
        timestamp: sig.entryTime,
        currentPrice: sig.currentPrice,
        result: null, exitPrice: null, checkedAt: null, checks: 0,
      };
      const saved = await saveSignal(record, env);
      if (!saved.deduped) {
        sig.signalId = record.id;
        // Await the push (scan ticks are awaited — see previous worker's
        // waitUntil lesson: nested waitUntil could freeze before sendMessage).
        await pushSignalToSubscribers({ ...sig, signalId: record.id, text: formatSignalText(sig) }, env);
      } else {
        sig.signalId = saved.duplicateOf;
      }
    }

    await writeLatest(pair, result, { generationId, generatedAt: result.generatedAt, opportunistic: false }, env);
    return result;
  } catch (e) {
    console.warn('scanOnePair exception ' + pair + ': ' + e.message);
    return null;
  }
}

/** every-5-minutes cron entry. */
export async function scheduledScan(env, ctx) {
  const startTime = Date.now();
  if (!env || !env.SIGNAL_CACHE) return { ok: 0, failed: 0, aborted: true };

  const generationId = 'gen_' + Date.now().toString(36);
  const activePairs = selectActivePairs();
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
  console.log('scheduledScan ' + generationId + ': ' + ok + ' ok, ' + failed + ' failed, ' + processed + ' processed, ' + (Date.now() - startTime) + 'ms');
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

/**
 * UT Bot Alerts — cron scanner (every-5-minutes, aligned to candle closes)
 * + on-demand evaluation. THE LIVE SIGNAL PATH (FTT3 retired — see
 * src/strategy/engine.mjs for the retired engine, kept for the audit record).
 *
 * Every tick, for each config-enabled pair:
 *   1. fetch the pair's configured timeframe window (KV-cached, 300 bars so
 *      the Wilder recursion matches TradingView's full-history run to float
 *      precision)
 *   2. computeUtBot() — exact Pine port (trailing stop, crossovers, events)
 *   3. emit every NEW buy/sell event whose candle closed after the stored
 *      last-scan close-time (idempotent across ticks and manual calls):
 *      history save -> Telegram push via the proven push plumbing
 *   4. write the latest snapshot (decision + full audit) to the latest: cache
 *
 * Event timing = candle CLOSE confirmation — the moment the TradingView
 * marker stops flickering and becomes final. Events on a 1min-timeframe pair
 * surface on the next 5-minute tick (up to 4 min late); 5min/15min pairs are
 * exact to their boundary.
 */

import { CONFIG, SCAN_PAIRS, SCAN_CONFIG, ASSET_TYPE } from '../config.js';
import { sanitizePair, getAssetType } from '../utils/pairs.js';
import { isForexMarketOpen } from '../utils/session.js';
import { fetchCandlesWithCache, fetchCandles } from '../fetch/candles.js';
import {
  computeUtBot, lastClosedIndexTf, eventToSignal, TF_MS,
} from '../strategy/utBotAlerts.mjs';
import { writeLatest } from '../history/latestCache.js';
import { saveSignal, computeStats } from '../history/store.js';
import { pushSignalToSubscribers, formatUtBotText } from './push.js';
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
 * Evaluate one pair right now: compute the UT Bot series over the configured
 * timeframe, determine new events since the last processed candle, and
 * return the response object (also written to the latest: cache). Never
 * throws — failures come back as { error }.
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

    const series = computeUtBot(candles, { a: cfg.a, c: cfg.c }, { tfMs });
    return buildResult(pair, assetType, candles, i, tf, tfMs, cfg, series, lastScanT);
  }
}

function buildResult(pair, assetType, candles, i, tf, tfMs, cfg, series, lastScanT) {
  const candle = candles[i];
  const closeT = candle.t + tfMs;

  // Pending events = every event whose candle closed strictly after the last
  // processed close-time. Missing state (fresh deploy) -> only the newest
  // closed candle is eligible (never replay history). Covers multi-event
  // gaps (e.g. a 1min-timeframe pair between */5 ticks).
  const pendingEvents = series.events.filter(e =>
    lastScanT === null ? e.i === i : e.closeT > lastScanT && e.closeT <= closeT);

  const newestEvent = pendingEvents.length > 0 ? pendingEvents[pendingEvents.length - 1]
    : (series.buy[i] ? { type: 'buy' } : series.sell[i] ? { type: 'sell' } : null);
  // NOTE: when lastScanT is set and newest closed candle was already
  // processed, newestEvent stays null even if series.buy[i] fired then —
  // the decision reflects "new pending signal", not history.
  const decision = newestEvent && newestEvent.type === 'buy' ? 'CALL'
    : newestEvent && newestEvent.type === 'sell' ? 'PUT' : 'NO_TRADE';

  const signal = {
    engine: CONFIG.ENGINE,
    finalSignal: decision,
    reason: decision === 'CALL' ? 'UT_BOT_BUY_CROSS'
      : decision === 'PUT' ? 'UT_BOT_SELL_CROSS' : 'UT_BOT_NO_EVENT',
    pair,
    market: assetType === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX',
    timeframe: tf,
    timestamp: new Date(closeT).toISOString(),
    currentPrice: candle.c,
    audit: {
      event: newestEvent ? newestEvent.type : null,
      key: cfg.a,
      atrPeriod: cfg.c,
      atr: series.atr[i],
      nLoss: series.atr[i] === undefined ? undefined : cfg.a * series.atr[i],
      stop: series.stop[i],
      stopPrev: i > 0 ? series.stop[i - 1] : null,
      pos: series.pos[i],
      posPrev: i > 0 ? series.pos[i - 1] : null,
      crossover: newestEvent ? (newestEvent.type === 'buy' ? 'above' : 'below') : null,
      timeframe: tf,
      eventCandle: { t: candle.t, closeT },
      barIndex: i,
      pendingEventCount: pendingEvents.length,
    },
    entryPrice: null, expiryMinutes: null, expiryTime: null, atrPercentile: null,
  };

  if (decision !== 'NO_TRADE') {
    signal.entryPrice = candle.c;
    signal.entryTime = new Date(closeT).toISOString();
    signal.expiryMinutes = cfg.expiryMinutes;
    signal.expiryTime = new Date(closeT + cfg.expiryMinutes * 60000).toISOString();
  }
  return {
    pair,
    marketStatus: 'OPEN',
    signal,
    source: CONFIG.ENGINE,
    generatedAt: new Date().toISOString(),
    _pendingEvents: pendingEvents,
    _series: { i, closeT, newestClosedCloseT: closeT },
  };
}

/** Full scan of one pair: evaluate -> emit events -> latest: cache. */
export async function scanOnePair(pair, generationId, env, ctx, opts = {}) {
  try {
    const cfg = (await getUtBotConfig(env)).pairs[pair];
    if (!cfg || cfg.enabled !== true) return null;   // per-pair gate (app toggle)

    const now = opts.now || Date.now();
    const lastScanT = await getLastScanT(env, pair);
    const result = await evaluatePair(pair, env, ctx, now, cfg, lastScanT);
    if (!result || result.error) {
      console.warn('scanOnePair ' + pair + ' error: ' + (result && result.message ? result.message : 'unknown'));
      return null;
    }
    if (!result.signal) return null;   // market closed — nothing to cache

    const { _pendingEvents, _series, ...cleanResult } = result;

    if (!opts.noPush && _pendingEvents.length > 0) {
      // Emit oldest-first so Telegram order matches chart order.
      for (const event of _pendingEvents) {
        const closeIso = new Date(event.closeT).toISOString();
        const sig = eventToSignal(event, pair, {
          timestamp: closeIso,
          market: getAssetType(pair) === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX',
          a: cfg.a, c: cfg.c,
          timeframe: cfg.timeframe,
          expiryMinutes: cfg.expiryMinutes,
          expiryTime: new Date(event.closeT + cfg.expiryMinutes * 60000).toISOString(),
        });
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
          atrPercentile: null,
          indicators: sig.audit,
          timestamp: sig.entryTime,
          currentPrice: sig.currentPrice,
          result: null, exitPrice: null, checkedAt: null, checks: 0,
        };
        const saved = await saveSignal(record, env);
        if (!saved.deduped) {
          sig.signalId = record.id;
          // Await the push (scan ticks are awaited — nested waitUntil could
          // freeze the isolate before sendMessage completes; proven lesson).
          await pushSignalToSubscribers({ ...sig, signalId: record.id, text: formatUtBotText(sig) }, env);
        } else {
          sig.signalId = saved.duplicateOf;
        }
      }
    }

    // Advance the idempotency cursor to the newest closed candle we've
    // processed, whether or not it carried an event.
    await setLastScanT(env, pair, _series.newestClosedCloseT);

    await writeLatest(pair, cleanResult, { generationId, generatedAt: result.generatedAt, opportunistic: false }, env);
    return cleanResult;
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
  const cfg = await getUtBotConfig(env);
  // Config gate first: disabled pairs are skipped entirely (no fetch).
  const enabledPairs = SCAN_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled === true);
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

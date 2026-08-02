import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../config.js';
import { jsonResponse, generateDummySignal, formatTimeUntil } from '../utils/helpers.js';
import { sanitizePair, getAssetType, isExoticPair, getOTCBasePair } from '../utils/pairs.js';
import { detectTradingSession, isForexMarketOpen, getForexHoliday, getNextForexOpen, checkNewsBlackout } from '../utils/session.js';
import { fetchCandlesWithCache } from '../fetch/candles.js';
import { buildMultiTimeframeSignal } from '../signal/engine.js';
import { buildMultiTimeframeSignalOTC } from '../signal/otcEngine.js';
import { saveSignalToHistory } from '../history/stats.js';
import { isTripped } from '../history/circuitBreaker.js';
import { pushSignalToSubscribers } from './pushToSubscribers.js';
import { detectCorrelationConflicts } from '../analysis/filters.js';
import { readLatest, writeLatest, enrichAge, isStale } from '../history/latestCache.js';
import {
  VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS,
  HISTORY_CONFIG,
} from '../config.js';
// R7.1: private shadow admission (standard engine only).
import { getEngineAudit } from '../signal/r71shadow.js';
import { maybeAdmitD2ShadowObservation } from '../signal/d2shadow.js';
import { admitShadowObservation } from '../history/r71store.js';

function generateSignalId() {
  return 'sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

/**
 * R7.1 — admit a private structure-suppressed shadow observation when the
 * standard production engine is NO_TRADE (both pre-AI and post-AI) but the
 * deterministic no-structure shadow produces a BUY/SELL. Runs off the live
 * response path (ctx.waitUntil) and is fully fail-open. Standard engine only:
 * OTC signals carry no engine audit, so getEngineAudit() returns null.
 */
async function maybeAdmitShadowObservation(signal, pair, assetType, env) {
  try {
    const audit = getEngineAudit(signal);
    if (!audit || !audit.isolatedObservationEligible || !audit.shadowTradeContext) return null;
    const stc = audit.shadowTradeContext;
    if (!stc.expiryTime) return null;
    const obsId = 'r71_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return await admitShadowObservation({
      id: obsId,
      pair,
      assetType,
      direction: stc.direction,
      entryPrice: stc.entryPrice,
      expiryTime: stc.expiryTime,
      bestTF: stc.bestTF,
      shadowConfidence: stc.confidence,
      attribution: audit.attribution,
      auditSummary: {
        decisionScope: audit.decisionScope,
        comparability: audit.comparability,
        diagnostic: audit.diagnostic,
        productionPreAiDirection: audit.productionPreAiDirection,
        shadowConfidence: audit.shadowConfidence,
      },
    }, env);
  } catch (e) {
    console.warn('R7.1 shadow admission error (fail-open): ' + e.message);
    return null;
  }
}

/**
 * B5 §3.2 — how fresh was the candle data behind this signal?
 * 3 timeframes are fetched, so cacheHits is 0..3.
 */
function classifyEntrySource(cacheHits) {
  if (cacheHits === 0) return 'FRESH_API';
  if (cacheHits === 1 || cacheHits === 2) return 'CACHE_PARTIAL';
  if (cacheHits === 3) return 'CACHE_ALL';
  return null;
}

/**
 * PHASE 10 — persist, then push only if the record was genuinely new.
 *
 * saveSignalToHistory() returns {deduped:true} when its 30-minute guard decides
 * this is a re-poll of an existing setup. /api/signal mints a fresh signalId on
 * every call (App auto-refresh 60s, Bot cron 5min, every manual view), so
 * pushing unconditionally would fire many Telegram messages for one setup.
 * Chaining the push behind the save result means subscribers are notified
 * exactly when a new row lands in history.
 */
async function saveAndPush(signal, pair, isOTC, env, signalId, entrySource, response) {
  let saveResult = null;
  try {
    saveResult = await saveSignalToHistory(signal, pair, isOTC, env, signalId, entrySource);
  } catch (e) {
    console.warn('saveAndPush: save failed for ' + pair + ': ' + e.message);
    return;
  }
  if (saveResult && saveResult.deduped) return;   // re-poll — already announced
  try {
    await pushSignalToSubscribers({ ...response, id: signalId, pair, signal }, env);
  } catch (e) {
    console.warn('saveAndPush: push failed for ' + pair + ': ' + e.message);
  }
}

/**
 * Phase 7 — /api/signal entry point.
 *
 * Default behaviour is unchanged: a fresh engine run (the "force refresh" path),
 * now labelled `cached:false, forceRefresh:true` so a client can tell the two
 * apart.
 *
 * With `?preferCache=true` the cron-warmed `latest:` entry is served when it is
 * fresh; on a miss or a stale entry we fall through to a normal generation and
 * opportunistically warm the cache for the next reader.
 */
export async function handleSignal(pair, env, ctx, opts) {
  const preferCache = !!(opts && opts.preferCache);

  if (preferCache) {
    const cached = await readLatest(pair, env);
    if (cached && !isStale(cached)) {
      return jsonResponse({ ...enrichAge(cached), cached: true, forceRefresh: false });
    }
  }

  const result = await handleSignalRaw(pair, env, ctx);

  if (preferCache && result && !result.error && result.signal
      && result.source !== 'DUMMY_FALLBACK') {
    // Warm the cache for whoever asks next. Marked opportunistic so it is
    // distinguishable from a cron-generated entry.
    const write = writeLatest(pair, result, { opportunistic: true }, env);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }

  return jsonResponse({ ...result, cached: false, forceRefresh: !preferCache });
}

export async function handleSignalRaw(pair, env, ctx) {
  const assetType = getAssetType(pair);
  if (assetType === ASSET_TYPE_OTC) return await handleSignalRawOTC(pair, env, ctx);

  const session = detectTradingSession();
  const exotic  = assetType === ASSET_TYPE.FOREX ? isExoticPair(pair) : false;
  let holidayWarning = null;

  if (assetType === ASSET_TYPE.FOREX) {
    const holiday    = getForexHoliday();
    const marketOpen = isForexMarketOpen();
    if (!marketOpen) {
      const nextOpen = getNextForexOpen();
      return {
        pair, assetType: 'FOREX', marketStatus: 'CLOSED',
        message: 'Forex market is currently CLOSED (Weekend)',
        details: 'Forex operates Sunday 22:00 UTC to Friday 22:00 UTC.',
        nextOpen: nextOpen.toISOString(), opensIn: formatTimeUntil(nextOpen),
        nextOpenReadable: 'Sunday ' + nextOpen.toUTCString(),
        advice: 'Wait for market open or trade Crypto (24/7).',
        cryptoAlternative: 'Try /api/signal?pair=BTC/USD',
        signal: null, timestamp: new Date().toISOString(),
      };
    }
    if (holiday) holidayWarning = 'Today is ' + holiday + '. Forex liquidity may be very low.';
  }

  const newsBlock = checkNewsBlackout(assetType);
  const timeframes = ['1min', '5min', '15min'];
  const candleData = {}; const errors = {};
  let totalFailures = 0; let cacheHits = 0;

  const tfFetches = await Promise.all(timeframes.map(tf => fetchCandlesWithCache(pair, tf, 100, env, ctx, assetType)));
  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i]; const data = tfFetches[i];
    if (data.error) { errors[tf] = data.error; totalFailures++; }
    else { if (data._fromCache) cacheHits++; candleData[tf] = data.candles || data; }
  }

  if (totalFailures === timeframes.length) {
    return { pair, assetType, signal: generateDummySignal(pair), source: 'DUMMY_FALLBACK', errors, timestamp: new Date().toISOString() };
  }

  const signal = await buildMultiTimeframeSignal(pair, candleData, assetType, env);
  if (holidayWarning) signal.holidayWarning = holidayWarning;
  if (assetType === ASSET_TYPE.FOREX && session.quality === 'LOW')
    signal.sessionWarning = 'Low liquidity session. Best: London (07-16 UTC), NY (12-21 UTC).';
  if (exotic) signal.exoticWarning = 'Exotic pair. Higher spreads. Confidence reduced.';

  // R7.1: admit a private structure-suppressed shadow observation off the live
  // response path (fail-open). Standard engine only.
  if (ctx && env && env.SIGNAL_CACHE) {
    ctx.waitUntil(maybeAdmitShadowObservation(signal, pair, assetType, env));
    // D2 Shadow: track would-be signals that Phase-D2 negative filters blocked
    // (standard engine only, fail-open, private d2 KV namespace).
    ctx.waitUntil(maybeAdmitD2ShadowObservation(signal, pair, assetType, env));
  }

  const dataStatus = {};
  for (const tf of timeframes)
    dataStatus[tf] = candleData[tf] ? candleData[tf].length + ' candles' : 'FAILED: ' + (errors[tf] || 'unknown');

  const entrySource = classifyEntrySource(cacheHits);

  // ── B2: per-pair circuit breaker (check site 1 of 2) ──
  // Cooldown suppresses the trade but the row is still persisted with
  // cbShadow:true (§3.3) so the counterfactual WR stays measurable.
  const cb = signal.finalSignal !== 'NO_TRADE'
    ? await isTripped(pair, env)
    : { tripped: false };

  if (cb.tripped) {
    const wouldBeSignal = signal.finalSignal;
    signal.finalSignal    = 'NO_TRADE';
    signal.circuitBreaker = {
      tripped: true, cooldownUntil: cb.cooldownUntil,
      lossStreak: cb.lossStreak, wouldBeSignal, cbShadow: true,
    };
    const shadowId = env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
    if (shadowId) {
      ctx.waitUntil(saveSignalToHistory(
        { ...signal, finalSignal: wouldBeSignal, cbShadow: true },
        pair, false, env, shadowId, entrySource));
    }
    return {
      ...(shadowId ? { id: shadowId } : {}),
      pair, assetType, marketStatus: 'OPEN', session, isExoticPair: exotic, signal,
      circuitBreaker: signal.circuitBreaker,
      source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
      timestamp: new Date().toISOString(),
      nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
      cacheHits, entrySource, dataStatus,
    };
  }

  const signalId = signal.finalSignal !== 'NO_TRADE' && env?.SIGNAL_CACHE && ctx
    ? generateSignalId()
    : null;

  const result = {
    ...(signalId ? { id: signalId } : {}),
    pair, assetType, marketStatus: 'OPEN', session, isExoticPair: exotic, signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits, entrySource, dataStatus,
  };

  if (signalId)
    ctx.waitUntil(saveAndPush(signal, pair, false, env, signalId, entrySource, result));

  return result;
}

async function handleSignalRawOTC(pair, env, ctx) {
  const basePair = getOTCBasePair(pair);
  const exotic   = isExoticPair(basePair);
  const session  = detectTradingSession();
  const timeframes = ['1min', '5min', '15min'];
  const candleData = {}; const errors = {};
  let totalFailures = 0; let cacheHits = 0;

  const tfFetches = await Promise.all(timeframes.map(tf => fetchCandlesWithCache(basePair, tf, 100, env, ctx, ASSET_TYPE.FOREX)));
  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i]; const data = tfFetches[i];
    if (data.error) { errors[tf] = data.error; totalFailures++; }
    else { if (data._fromCache) cacheHits++; candleData[tf] = data.candles || data; }
  }

  if (totalFailures === timeframes.length)
    return { pair, assetType: ASSET_TYPE_OTC, isOTC: true, signal: generateDummySignal(pair), source: 'DUMMY_FALLBACK', errors, timestamp: new Date().toISOString() };

  const signal = await buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env);
  if (exotic) signal.exoticWarning = 'Exotic OTC pair. Very high spreads. Confidence heavily reduced.';

  const dataStatus = {};
  for (const tf of timeframes)
    dataStatus[tf] = candleData[tf] ? candleData[tf].length + ' candles (from ' + basePair + ')' : 'FAILED: ' + (errors[tf] || 'unknown');

  const entrySource = classifyEntrySource(cacheHits);

  // ── B2: per-pair circuit breaker (check site 2 of 2, OTC) ──
  const cb = signal.finalSignal !== 'NO_TRADE'
    ? await isTripped(pair, env)
    : { tripped: false };

  if (cb.tripped) {
    const wouldBeSignal = signal.finalSignal;
    signal.finalSignal    = 'NO_TRADE';
    signal.circuitBreaker = {
      tripped: true, cooldownUntil: cb.cooldownUntil,
      lossStreak: cb.lossStreak, wouldBeSignal, cbShadow: true,
    };
    const shadowId = env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
    if (shadowId) {
      ctx.waitUntil(saveSignalToHistory(
        { ...signal, finalSignal: wouldBeSignal, cbShadow: true },
        pair, true, env, shadowId, entrySource));
    }
    return {
      ...(shadowId ? { id: shadowId } : {}),
      pair, basePair, assetType: ASSET_TYPE_OTC, isOTC: true,
      otcBroker: 'Olymp Trade (synthetic price)', marketStatus: 'OPEN (OTC 24/7)',
      session, isExoticPair: exotic, signal,
      circuitBreaker: signal.circuitBreaker,
      source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
      dataNote: 'Candle data from ' + basePair + ' (real market). OTC price may differ.',
      timestamp: new Date().toISOString(),
      nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
      cacheHits, entrySource, dataStatus,
    };
  }

  const signalId = signal.finalSignal !== 'NO_TRADE' && env?.SIGNAL_CACHE && ctx
    ? generateSignalId()
    : null;

  const otcResult = {
    ...(signalId ? { id: signalId } : {}),
    pair, basePair, assetType: ASSET_TYPE_OTC, isOTC: true,
    otcBroker: 'Olymp Trade (synthetic price)', marketStatus: 'OPEN (OTC 24/7)',
    session, isExoticPair: exotic, signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    dataNote: 'Candle data from ' + basePair + ' (real market). OTC price may differ.',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits, entrySource, dataStatus,
  };

  if (signalId)
    ctx.waitUntil(saveAndPush(signal, pair, true, env, signalId, entrySource, otcResult));

  return otcResult;
}

export async function handleBatch(url, env, ctx) {
  const rawPairs = url.searchParams.get('pairs') || '';
  const pairList = rawPairs.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (pairList.length === 0)
    return jsonResponse({ error: true, message: 'No pairs provided. Use ?pairs=EUR/USD,GBP/JPY,BTC/USD', example: '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD' }, 400);

  const validPairs = []; const invalidPairs = [];
  for (const p of pairList) { const c = sanitizePair(p); if (c) validPairs.push(c); else invalidPairs.push(p); }
  const capped = validPairs.slice(0, CONFIG.BATCH_MAX_PAIRS);

  const results = await Promise.all(capped.map(pair =>
    handleSignalRaw(pair, env, ctx).then(s => ({ pair, signal: s })).catch(e => ({ pair, error: e.message }))
  ));

  const summary = {};
  const pairDirs = {};
  for (const r of results) {
    summary[r.pair] = r.signal || { error: r.error };
    if (r.signal && r.signal.signal) pairDirs[r.pair] = r.signal.signal.finalSignal || 'NO_TRADE';
  }

  return jsonResponse({
    batch: true, requestedPairs: pairList.length, processedPairs: capped.length,
    cappedAt: CONFIG.BATCH_MAX_PAIRS, invalidPairs,
    skippedPairs: validPairs.slice(CONFIG.BATCH_MAX_PAIRS),
    correlationAnalysis: detectCorrelationConflicts(pairDirs),
    results: summary, timestamp: new Date().toISOString(),
  });
}

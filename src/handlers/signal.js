import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../config.js';
import { jsonResponse, generateDummySignal, formatTimeUntil } from '../utils/helpers.js';
import { sanitizePair, getAssetType, isExoticPair, getOTCBasePair } from '../utils/pairs.js';
import { detectTradingSession, isForexMarketOpen, getForexHoliday, getNextForexOpen, checkNewsBlackout } from '../utils/session.js';
import { fetchCandlesWithCache } from '../fetch/candles.js';
import { buildMultiTimeframeSignal } from '../signal/engine.js';
import { buildMultiTimeframeSignalOTC } from '../signal/otcEngine.js';
import { saveSignalToHistory } from '../history/stats.js';
import { detectCorrelationConflicts } from '../analysis/filters.js';
import {
  VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS,
  HISTORY_CONFIG,
} from '../config.js';

export async function handleSignal(request, env, ctx) {
  const url = new URL(request.url);
  const pair = url.searchParams.get('pair') || 'EUR/USD';
  const result = await handleSignalRaw(pair, env, ctx);
  return jsonResponse(result);
}

export async function handleSignalRaw(requestOrPair, env, ctx) {
  let pair;
  if (typeof requestOrPair === 'string') {
    pair = requestOrPair;
  } else {
    const url = new URL(requestOrPair.url);
    pair = url.searchParams.get('pair') || 'EUR/USD';
  }
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

  const dataStatus = {};
  for (const tf of timeframes)
    dataStatus[tf] = candleData[tf] ? candleData[tf].length + ' candles' : 'FAILED: ' + (errors[tf] || 'unknown');

  const result = {
    pair, assetType, marketStatus: 'OPEN', session, isExoticPair: exotic, signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits, dataStatus,
  };

  if (signal.finalSignal !== 'NO_TRADE' && env.SIGNAL_HISTORY && ctx)
    ctx.waitUntil(saveSignalToHistory(signal, pair, false, env));

  return result;
}

export async function handleSignalRawOTC(requestOrPair, env, ctx) {
  let pair;
  if (typeof requestOrPair === 'string') {
    pair = requestOrPair;
  } else {
    const url = new URL(requestOrPair.url);
    pair = url.searchParams.get('pair') || 'EUR/USD-OTC';
  }
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

  const otcResult = {
    pair, basePair, assetType: ASSET_TYPE_OTC, isOTC: true,
    otcBroker: 'Olymp Trade (synthetic price)', marketStatus: 'OPEN (OTC 24/7)',
    session, isExoticPair: exotic, signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    dataNote: 'Candle data from ' + basePair + ' (real market). OTC price may differ.',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits, dataStatus,
  };

  if (signal.finalSignal !== 'NO_TRADE' && env.SIGNAL_HISTORY && ctx)
    ctx.waitUntil(saveSignalToHistory(signal, pair, true, env));

  return otcResult;
}

export async function handleBatch(request, env, ctx) {
  const url = new URL(request.url);
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

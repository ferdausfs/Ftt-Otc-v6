// ============================================================
// SIGNAL ENDPOINT
// GET /api/signal?pair=EUR/USD
// GET /api/signal?pair=EURUSD-OTC  (OTC)
// GET /api/signal?pair=BTC/USD     (Crypto)
// ============================================================
import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../config/trading.js';
import { jsonResponse } from '../utils/response.js';
import { sanitizePair, getAssetType, isExoticPair } from '../utils/pair.js';
import { detectTradingSession, isForexMarketOpen, getForexHoliday, getNextForexOpen, formatTimeUntil } from '../market/session.js';
import { checkNewsBlackout } from '../market/filters.js';
import { fetchCandlesWithCache } from '../fetcher/candles.js';
import { buildMultiTimeframeSignal } from '../analysis/multiTF.js';
import { handleSignalRawOTC } from '../otc/handler.js';
import { saveSignalToHistory } from '../history/storage.js';
import { generateDummySignal } from '../utils/helpers.js';

// ============================================
// SIGNAL HANDLER
// ============================================

async function handleSignal(pair, env, ctx) {
  const result = await handleSignalRaw(pair, env, ctx);
  return jsonResponse(result);
}

async function handleSignalRaw(pair, env, ctx) {
  const assetType = getAssetType(pair);

  // ── OTC ROUTING (v6.7.0) ──────────────────────────────────────
  if (assetType === ASSET_TYPE_OTC) {
    return await handleSignalRawOTC(pair, env, ctx);
  }
  // ─────────────────────────────────────────────────────────────

  const session = detectTradingSession();
  const exotic = assetType === ASSET_TYPE.FOREX ? isExoticPair(pair) : false;
  let holidayWarning = null;

  if (assetType === ASSET_TYPE.FOREX) {
    const holiday = getForexHoliday();
    const marketOpen = isForexMarketOpen();

    if (!marketOpen) {
      const nextOpen = getNextForexOpen();
      return {
        pair: pair,
        assetType: 'FOREX',
        marketStatus: 'CLOSED',
        message: 'Forex market is currently CLOSED (Weekend)',
        details: 'Forex operates Sunday 22:00 UTC to Friday 22:00 UTC.',
        nextOpen: nextOpen.toISOString(),
        opensIn: formatTimeUntil(nextOpen),
        nextOpenReadable: 'Sunday ' + nextOpen.toUTCString(),
        advice: 'Wait for market open or trade Crypto pairs (24/7).',
        cryptoAlternative: 'Try /api/signal?pair=BTC/USD',
        signal: null,
        timestamp: new Date().toISOString(),
      };
    }

    if (holiday) {
      holidayWarning = 'Today is ' + holiday + '. Forex liquidity may be very low.';
    }
  }

  // [v6.2] News blackout check (FOREX only)
  const newsBlock = checkNewsBlackout(assetType);

  const timeframes = ['1min', '5min', '15min'];
  const candleData = {};
  const errors = {};
  let totalFailures = 0;
  let cacheHits = 0;

  // [v6.3-fix] Parallel fetch — all 3 timeframes at once
  const tfFetches = await Promise.all(
    timeframes.map(function (tf) {
      return fetchCandlesWithCache(pair, tf, 100, env, ctx, assetType);
    })
  );
  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i];
    const data = tfFetches[i];
    if (data.error) {
      errors[tf] = data.error;
      totalFailures++;
    } else {
      if (data._fromCache) cacheHits++;
      candleData[tf] = data.candles || data;
    }
  }

  if (totalFailures === timeframes.length) {
    return {
      pair: pair,
      assetType: assetType,
      signal: generateDummySignal(pair),
      source: 'DUMMY_FALLBACK',
      errors: errors,
      timestamp: new Date().toISOString(),
    };
  }

  const signal = await buildMultiTimeframeSignal(candleData, pair, assetType, session, exotic, newsBlock, env);

  if (holidayWarning) signal.holidayWarning = holidayWarning;

  if (assetType === ASSET_TYPE.FOREX && session.quality === 'LOW') {
    signal.sessionWarning = 'Low liquidity session. Best: London (07-16 UTC), NY (12-21 UTC).';
  }

  if (exotic) {
    signal.exoticWarning = 'Exotic pair. Higher spreads. Confidence reduced.';
  }

  const dataStatus = {};
  for (let j = 0; j < timeframes.length; j++) {
    const tfk = timeframes[j];
    dataStatus[tfk] = candleData[tfk]
      ? candleData[tfk].length + ' candles'
      : 'FAILED: ' + (errors[tfk] || 'unknown');
  }

  const result = {
    pair: pair,
    assetType: assetType,
    marketStatus: 'OPEN',
    session: session,
    isExoticPair: exotic,
    signal: signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits: cacheHits,
    dataStatus: dataStatus,
  };

  // [v6.9.0] Save signal to history (async, non-blocking)
  if (signal.finalSignal !== 'NO_TRADE' && env.SIGNAL_CACHE && ctx) {
    ctx.waitUntil(saveSignalToHistory(result, env));
  }

  return result;
}

// ============================================
// API KEYS

export { handleSignal, handleSignalRaw };

// ============================================================
// HEALTH & PAIRS ENDPOINTS
// GET /  or  GET /health  →  system status
// GET /api/pairs          →  all supported pairs
// ============================================================
import { CONFIG, HISTORY_CONFIG, ASSET_TYPE } from '../config/trading.js';
import { VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS } from '../constants/pairs.js';
import { jsonResponse } from '../utils/response.js';
import { getApiKeys } from '../fetcher/keys.js';
import { isForexMarketOpen, getForexHoliday, detectTradingSession } from '../market/session.js';
import { checkNewsBlackout } from '../market/filters.js';

// ============================================
// HANDLERS
// ============================================

function handleHealth(env) {
  const keyCount = getApiKeys(env).length;
  const keySource = env.TWELVEDATA_API_KEYS ? 'TWELVEDATA_API_KEYS (JSON array)' : 'TWELVEDATA_API_KEY_N (individual vars)';
  const forexOpen = isForexMarketOpen();
  const holiday = getForexHoliday();
  const session = detectTradingSession();
  const newsBlock = checkNewsBlackout(ASSET_TYPE.FOREX);

  return jsonResponse({
    status: 'healthy',
    version: '6.9.0',
    timestamp: new Date().toISOString(),
    apiKeys: { configured: keyCount, source: keySource, status: keyCount > 0 ? 'ready' : 'NO KEYS' },
    bindings: {
      kvCache: env.SIGNAL_CACHE ? 'ready' : 'NOT CONFIGURED',
      rateLimiter: env.RATE_LIMITER ? 'ready' : 'KV fallback',
      cerebrasAI: env.CEREBRAS_API_KEY ? 'ready (v6.5.0 AI layer enabled)' : 'NOT CONFIGURED (add CEREBRAS_API_KEY secret)',
    },
    currentSession: session,
    newsBlackout: newsBlock || { blocked: false, label: 'NONE' },
    markets: {
      forex: {
        status: forexOpen ? 'OPEN' : 'CLOSED',
        holiday: holiday || 'NONE',
        currencies: VALID_FOREX_CURRENCIES.length,
        possiblePairs: VALID_FOREX_CURRENCIES.length * (VALID_FOREX_CURRENCIES.length - 1),
        hours: 'Mon-Fri 24h (Sun 22:00 UTC to Fri 22:00 UTC)',
      },
      crypto: {
        status: 'ALWAYS OPEN (24/7)',
        bases: CRYPTO_BASES,
        quotes: CRYPTO_QUOTES,
        topPairs: POPULAR_CRYPTO_PAIRS.slice(0, 10),
      },
    },
    filters: {
      minConfidenceFloor: CONFIG.MIN_CONFIDENCE_FLOOR + '%',
      volumeSpikeMultiplier: CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER + 'x',
      newsBlackoutMargin: CONFIG.NEWS_BLACKOUT_MINUTES + ' min',
      batchMaxPairs: CONFIG.BATCH_MAX_PAIRS,
    },
    history: {
      enabled:          env.SIGNAL_CACHE ? true : false,
      maxPerPair:       HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR,
      winRateLookback:  HISTORY_CONFIG.WIN_RATE_LOOKBACK,
      resultCheckDelay: HISTORY_CONFIG.RESULT_CHECK_DELAY + 's after expiry',
      cronRequired:     'Add to wrangler.toml: [triggers] crons = ["* * * * *"]',
      endpoints: {
        history: '/api/history?pair=EUR/USD&limit=20',
        stats:   '/api/stats?pair=EUR/USD',
        report:  '/api/report?id=SIGNAL_ID&result=WIN (OTC manual)',
      },
    },
    indicators: [
      'EMA(5/10/20)', 'SMA(50)', 'RSI(14)', 'MACD(12,26,9)',
      'Stochastic(14,3,3)', 'ADX(14)+DI+DI_Cross', 'Williams%R(14)',
      'CCI(20)', 'MFI(14)', 'ATR(14)', 'Bollinger(20,2)',
      'PivotPoints(ATR-based)', 'CandlestickPatterns', 'RSI/MACD Divergence',
      'SessionDetection', 'TrendContextFilter', 'WeightedScoring',
      '[v6.2] ConfidenceFloor', '[v6.2] VolumeSpikeFilter',
      '[v6.2] NewsBlackout', '[v6.2] CandleConsistency',
    ],
  });
}

function handlePairs() {
  const majorBases = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];
  const majorPairs = [];
  for (const b of majorBases) {
    for (const q of majorBases) {
      if (b !== q) majorPairs.push(b + '/' + q);
    }
  }

  const exoticQuotes = ['SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'TRY', 'ZAR', 'MXN', 'SGD', 'HKD', 'CNH', 'THB', 'INR', 'BRL'];
  const crossPairs = [];
  for (const b of ['EUR', 'USD', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']) {
    for (const q of exoticQuotes) {
      crossPairs.push(b + '/' + q);
    }
  }

  const allCryptoPairs = [];
  for (const b of CRYPTO_BASES) {
    for (const q of CRYPTO_QUOTES) {
      if (b !== q) allCryptoPairs.push(b + '/' + q);
    }
    for (const q of ['AUD', 'CAD', 'CHF', 'NZD', 'HKD', 'SGD']) {
      allCryptoPairs.push(b + '/' + q);
    }
  }

  return jsonResponse({
    forex: {
      currencies: VALID_FOREX_CURRENCIES,
      currencyCount: VALID_FOREX_CURRENCIES.length,
      totalPossiblePairs: VALID_FOREX_CURRENCIES.length * (VALID_FOREX_CURRENCIES.length - 1),
      majorPairs: majorPairs.slice(0, 30),
      crossExoticExamples: crossPairs.slice(0, 30),
      marketHours: 'Sunday 22:00 UTC to Friday 22:00 UTC',
    },
    crypto: {
      bases: CRYPTO_BASES,
      quotes: CRYPTO_QUOTES,
      totalPairs: allCryptoPairs.length,
      popularPairs: POPULAR_CRYPTO_PAIRS,
      allPairs: allCryptoPairs,
      marketHours: '24/7 — Never closes',
    },
    usage: {
      forexExample: '/api/signal?pair=EUR/USD',
      cryptoExample: '/api/signal?pair=BTC/USD',
      exoticExample: '/api/signal?pair=USD/TRY',
      batchExample: '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD',
      formats: ['EUR/USD', 'EURUSD', 'BTC/USD', 'BTCUSD', 'eur/usd'],
    },
  });
}

export { handleHealth, handlePairs };

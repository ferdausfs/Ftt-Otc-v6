/**
 * FTT Signal Worker v6.1 — Multi-Timeframe Binary Trading (Forex + Crypto)
 * FIXED VERSION — All bugs resolved
 *
 * FIXES APPLIED:
 * 1. Regex escape fix: /[A-Z]{3}\/[A-Z]{3}/ was broken by markdown escaping
 * 2. handlePairs() had duplicate/broken format array
 * 3. getAssetType() missing null safety
 * 4. sanitizePair() regex patterns fixed
 * 5. safeLastTwo() logic fix for proper prev detection
 * 6. calculateStochastic() SMA on null-padded arrays fixed
 * 7. detectCandlestickPatterns() division by zero protection
 * 8. buildMultiTimeframeSignal() undefined variable access fixed
 * 9. analyzeTimeframe() missing return path edge case
 * 10. Rate limiter KV error handling improved
 * 11. fetchCandles() AbortSignal compatibility fix
 * 12. All template literal escaping fixed
 * 13. THREE_BLACK_CROWS double-push typo fixed
 * 14. [v6.1] DURATION_CONFIG reduced — binary-appropriate expiry (1min→max 5m, 5min→max 20m, 15min→max 30m)
 * 15. [v6.1] Score-based dur+1/dur+2 bonus removed — expiry no longer inflated by signal score
 * 16. [v6.1] HTF conflict → hard NO_TRADE block (was 0.7x penalty only)
 * 17. [v6.1] MIXED timeframe alignment → NO_TRADE (was generating directional signal)
 */

// ============================================
// CONFIG
// ============================================

const CONFIG = {
  API_BASE_URL: 'https://api.twelvedata.com',
  REFRESH_INTERVAL: 60000,
  REQUEST_TIMEOUT: 12000,
  MAX_RETRIES: 3,

  MIN_CONFLUENCE: 3,
  MIN_CATEGORY_SCORE: 0.3,

  CACHE_TTL: {
    '1min': 60,
    '5min': 300,
    '15min': 900,
  },

  RATE_LIMIT_MAX_REQUESTS: 30,
  RATE_LIMIT_WINDOW_SECONDS: 60,

  ATR_PERIOD: 14,
  RSI_PERIOD: 14,
  STOCH_PERIOD: 14,
  STOCH_SMOOTH_K: 3,
  STOCH_SMOOTH_D: 3,
  ADX_PERIOD: 14,
  CCI_PERIOD: 20,
  MFI_PERIOD: 14,
  WILLIAMS_PERIOD: 14,
  BB_PERIOD: 20,
  BB_STD_DEV: 2,

  DIVERGENCE_LOOKBACK: 30,
  DIVERGENCE_MIN_BARS: 5,

  CATEGORY_WEIGHTS: {
    trend: 1.8,
    momentum: 1.4,
    macd: 1.2,
    stochastic: 1.0,
    bands: 1.0,
    adx: 1.3,
    patterns: 1.1,
    divergence: 1.5,
    pivots: 0.8,
    volume: 0.5,
  },

  TF_WEIGHTS: {
    '15min': 3.0,
    '5min': 2.0,
    '1min': 1.0,
  },

  EXOTIC_CURRENCIES: [
    'TRY', 'ZAR', 'MXN', 'BRL', 'PLN', 'HUF', 'CZK', 'RON', 'BGN',
    'HRK', 'ISK', 'RUB', 'UAH', 'CNH', 'CNY', 'KRW', 'TWD', 'THB',
    'MYR', 'PHP', 'IDR', 'INR', 'VND', 'PKR', 'BDT', 'LKR', 'CLP',
    'COP', 'PEN', 'ARS', 'EGP', 'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'MAD',
  ],
  EXOTIC_CONFIDENCE_PENALTY: 10,
};

const ASSET_TYPE = {
  FOREX: 'FOREX',
  CRYPTO: 'CRYPTO',
};

const SCORE_THRESHOLDS = {
  FOREX: 3.0,
  CRYPTO: 2.5,
};

const VOLATILITY_THRESHOLDS = {
  FOREX: {
    atrVeryHigh: 0.20,
    atrHigh: 0.10,
    atrLow: 0.05,
    atrDead: 0.02,
    atrVolatile: 0.20,
    atrDeadMarket: 0.02,
    bbSqueeze: 0.05,
    bbHighVol: 0.50,
    bbFilterDead: 0.03,
    bbFilterLow: 0.05,
    bbFilterMed: 0.08,
    minTradableATR: 0.015,
  },
  CRYPTO: {
    atrVeryHigh: 5.0,
    atrHigh: 3.0,
    atrLow: 1.0,
    atrDead: 0.3,
    atrVolatile: 5.0,
    atrDeadMarket: 0.3,
    bbSqueeze: 2.0,
    bbHighVol: 10.0,
    bbFilterDead: 1.0,
    bbFilterLow: 2.0,
    bbFilterMed: 3.0,
    minTradableATR: 0.1,
  },
};

// [v6.1] Reduced for binary trading — 1-2 candle expiry is ideal
const DURATION_CONFIG = {
  FOREX: {
    '1min':  { base: 2, min: 1, max: 5 },   // was base:5, max:15 → now max 5 min
    '5min':  { base: 2, min: 1, max: 4 },   // was base:3, max:8  → now max 20 min
    '15min': { base: 1, min: 1, max: 2 },   // was base:2, max:4  → now max 30 min
  },
  CRYPTO: {
    '1min':  { base: 2, min: 1, max: 4 },   // was base:4, max:12 → now max 4 min
    '5min':  { base: 2, min: 1, max: 3 },   // was base:3, max:6  → now max 15 min
    '15min': { base: 1, min: 1, max: 2 },   // was base:2, max:4  → now max 30 min
  },
};

const CANDLE_MINUTES = {
  '1min': 1,
  '5min': 5,
  '15min': 15,
};

const TIMEFRAME_MAP = {
  '1min': '1min',
  '5min': '5min',
  '15min': '15min',
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
};

// ============================================
// FOREX CURRENCIES
// ============================================

const VALID_FOREX_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'RON', 'BGN', 'HRK', 'ISK', 'RUB', 'TRY', 'UAH',
  'HKD', 'SGD', 'CNH', 'CNY', 'KRW', 'TWD', 'THB', 'MYR', 'PHP', 'IDR', 'INR', 'VND', 'PKR', 'BDT', 'LKR',
  'MXN', 'BRL', 'CLP', 'COP', 'PEN', 'ARS',
  'AED', 'SAR', 'ILS', 'JOD', 'KWD', 'BHD', 'OMR', 'QAR',
  'ZAR', 'EGP', 'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'MAD',
];

// ============================================
// CRYPTO CONFIG
// ============================================

const CRYPTO_BASES = [
  'BTC', 'ETH', 'BNB', 'XRP', 'SOL',
  'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK',
];

const CRYPTO_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'USDT', 'BTC'];

const POPULAR_CRYPTO_PAIRS = [
  'BTC/USD', 'ETH/USD', 'BNB/USD', 'XRP/USD', 'SOL/USD',
  'ADA/USD', 'DOGE/USD', 'AVAX/USD', 'DOT/USD', 'LINK/USD',
  'BTC/EUR', 'ETH/EUR', 'BTC/GBP', 'ETH/GBP',
  'ETH/BTC', 'BNB/BTC', 'XRP/BTC', 'SOL/BTC',
  'ADA/BTC', 'DOGE/BTC', 'AVAX/BTC', 'DOT/BTC', 'LINK/BTC',
];

// ============================================
// MAIN HANDLER
// ============================================

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/signal' || path === '/signal') {
        const rl = await checkRateLimit(request, env);
        if (rl) return applyCors(rl, corsHeaders);
      }

      let response;

      if (path === '/' || path === '/health') {
        response = handleHealth(env);
      } else if (path === '/api/signal' || path === '/signal') {
        const rawPair = url.searchParams.get('pair') || 'EUR/USD';
        const pair = sanitizePair(rawPair);
        if (!pair) {
          response = jsonResponse({
            error: true,
            message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.',
            validForexCurrencies: VALID_FOREX_CURRENCIES,
            validCryptoBases: CRYPTO_BASES,
            validCryptoQuotes: CRYPTO_QUOTES,
            examples: ['EUR/USD', 'GBP/JPY', 'BTC/USD', 'ETH/EUR', 'SOL/USDT'],
          }, 400);
        } else {
          response = await handleSignal(pair, env, ctx);
        }
      } else if (path === '/api/pairs') {
        response = handlePairs();
      } else {
        response = jsonResponse({
          status: 'ok',
          message: 'FTT Signal Worker v6.0 — Forex + Crypto Multi-Timeframe (Accuracy Upgraded)',
          endpoints: {
            health: '/',
            signal: '/api/signal?pair=EUR/USD',
            signalCrypto: '/api/signal?pair=BTC/USD',
            pairs: '/api/pairs',
          },
          supportedAssets: ['FOREX (40+ currencies)', 'CRYPTO (Top 10)'],
          timestamp: new Date().toISOString(),
        });
      }

      return applyCors(response, corsHeaders);
    } catch (error) {
      console.error('Fatal:', error);
      return applyCors(
        jsonResponse({ error: true, message: 'Internal server error' }, 500),
        corsHeaders
      );
    }
  },
};

// ============================================
// CORS
// ============================================

function applyCors(response, corsHeaders) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    h.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h,
  });
}

// ============================================
// RATE LIMITING
// ============================================

async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse(
          { error: true, message: 'Rate limit exceeded.', retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS },
          429
        );
      }
      return null;
    } catch (e) {
      console.warn('Rate limiter err:', e.message);
    }
  }

  if (env.SIGNAL_CACHE) {
    try {
      const kvKey = 'rl:' + ip;
      const now = Math.floor(Date.now() / 1000);
      const stored = await env.SIGNAL_CACHE.get(kvKey, 'json');
      let reqs = (stored && Array.isArray(stored))
        ? stored.filter(function (t) { return t > now - CONFIG.RATE_LIMIT_WINDOW_SECONDS; })
        : [];
      if (reqs.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
        return jsonResponse(
          { error: true, message: 'Rate limit exceeded.', retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS },
          429
        );
      }
      reqs.push(now);
      await env.SIGNAL_CACHE.put(kvKey, JSON.stringify(reqs), {
        expirationTtl: CONFIG.RATE_LIMIT_WINDOW_SECONDS + 10,
      });
      return null;
    } catch (e) {
      console.warn('KV RL err:', e.message);
      return null;
    }
  }
  return null;
}

// ============================================
// INPUT SANITIZATION
// ============================================

function sanitizePair(input) {
  if (!input || typeof input !== 'string') return null;
  const c = input.replace(/[^A-Za-z/]/g, '').toUpperCase();

  const slashPattern = /^[A-Z]{3}\/[A-Z]{3}$/;
  if (slashPattern.test(c)) {
    const parts = c.split('/');
    const b = parts[0];
    const q = parts[1];
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q) {
      return c;
    }
  }

  const noSlashPattern = /^[A-Z]{6}$/;
  if (noSlashPattern.test(c)) {
    const b = c.slice(0, 3);
    const q = c.slice(3, 6);
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q) {
      return b + '/' + q;
    }
  }

  if (c.includes('/')) {
    const parts = c.split('/');
    if (parts.length === 2) {
      const b = parts[0];
      const q = parts[1];
      if (CRYPTO_BASES.includes(b) && (CRYPTO_QUOTES.includes(q) || VALID_FOREX_CURRENCIES.includes(q)) && b !== q) {
        return c;
      }
    }
  }

  for (const base of CRYPTO_BASES) {
    if (c.startsWith(base)) {
      const quote = c.slice(base.length);
      if ((CRYPTO_QUOTES.includes(quote) || VALID_FOREX_CURRENCIES.includes(quote)) && base !== quote) {
        return base + '/' + quote;
      }
    }
  }

  return null;
}

function getAssetType(pair) {
  if (!pair || typeof pair !== 'string') return ASSET_TYPE.FOREX;
  const parts = pair.split('/');
  const base = parts[0] || '';
  if (CRYPTO_BASES.includes(base)) return ASSET_TYPE.CRYPTO;
  return ASSET_TYPE.FOREX;
}

function isExoticPair(pair) {
  if (!pair) return false;
  const parts = pair.split('/');
  const base = parts[0] || '';
  const quote = parts[1] || '';
  return CONFIG.EXOTIC_CURRENCIES.includes(base) || CONFIG.EXOTIC_CURRENCIES.includes(quote);
}

// ============================================
// SESSION DETECTION
// ============================================

function detectTradingSession() {
  const now = new Date();
  const hour = now.getUTCHours();

  const sessions = [];

  if (hour >= 0 && hour < 9) sessions.push('ASIAN');
  if (hour >= 7 && hour < 16) sessions.push('LONDON');
  if (hour >= 12 && hour < 21) sessions.push('NEW_YORK');
  if (hour >= 21 || hour < 6) sessions.push('SYDNEY');

  let overlap = 'NONE';
  if (sessions.includes('LONDON') && sessions.includes('NEW_YORK')) {
    overlap = 'LONDON_NY';
  } else if (sessions.includes('ASIAN') && sessions.includes('LONDON')) {
    overlap = 'ASIAN_LONDON';
  }

  let quality = 'LOW';
  if (overlap === 'LONDON_NY') quality = 'HIGHEST';
  else if (sessions.includes('LONDON')) quality = 'HIGH';
  else if (sessions.includes('NEW_YORK')) quality = 'HIGH';
  else if (overlap === 'ASIAN_LONDON') quality = 'MEDIUM';
  else if (sessions.includes('ASIAN')) quality = 'MEDIUM';

  return { sessions: sessions, overlap: overlap, quality: quality, hour: hour };
}

// ============================================
// FOREX MARKET HOURS
// ============================================

function isForexMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;

  return true;
}

function getForexHoliday() {
  const now = new Date();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (m === 11 && d === 25) return 'Christmas Day';
  if (m === 0 && d === 1) return "New Year's Day";
  return null;
}

function getNextForexOpen() {
  const now = new Date();
  const next = new Date(now);

  if (now.getUTCDay() === 0 && now.getUTCHours() < 22) {
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0
    ));
  }

  while (true) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCDay() === 0) break;
  }
  next.setUTCHours(22, 0, 0, 0);

  return next;
}

function formatTimeUntil(target) {
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return 'Opening soon...';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return days + 'd ' + remHours + 'h ' + mins + 'm';
  }
  return hours + 'h ' + mins + 'm';
}

// ============================================
// HANDLERS
// ============================================

function handleHealth(env) {
  const keyCount = getApiKeys(env).length;
  const forexOpen = isForexMarketOpen();
  const holiday = getForexHoliday();
  const session = detectTradingSession();

  return jsonResponse({
    status: 'healthy',
    version: '6.1.0',
    timestamp: new Date().toISOString(),
    apiKeys: { configured: keyCount, status: keyCount > 0 ? 'ready' : 'NO KEYS' },
    bindings: {
      kvCache: env.SIGNAL_CACHE ? 'ready' : 'NOT CONFIGURED',
      rateLimiter: env.RATE_LIMITER ? 'ready' : 'KV fallback',
    },
    currentSession: session,
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
    indicators: [
      'EMA(5/10/20)', 'SMA(50)', 'RSI(14)', 'MACD(12,26,9)',
      'Stochastic(14,3,3)', 'ADX(14)+DI+DI_Cross', 'Williams%R(14)',
      'CCI(20)', 'MFI(14)', 'ATR(14)', 'Bollinger(20,2)',
      'PivotPoints(ATR-based)', 'CandlestickPatterns', 'RSI/MACD Divergence',
      'SessionDetection', 'TrendContextFilter', 'WeightedScoring',
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
      formats: ['EUR/USD', 'EURUSD', 'BTC/USD', 'BTCUSD', 'eur/usd'],
    },
  });
}

// ============================================
// SIGNAL HANDLER
// ============================================

async function handleSignal(pair, env, ctx) {
  const assetType = getAssetType(pair);
  const session = detectTradingSession();
  const exotic = assetType === ASSET_TYPE.FOREX ? isExoticPair(pair) : false;
  let holidayWarning = null;

  if (assetType === ASSET_TYPE.FOREX) {
    const holiday = getForexHoliday();
    const marketOpen = isForexMarketOpen();

    if (!marketOpen) {
      const nextOpen = getNextForexOpen();
      return jsonResponse({
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
      });
    }

    if (holiday) {
      holidayWarning = 'Today is ' + holiday + '. Forex liquidity may be very low.';
    }
  }

  const timeframes = ['1min', '5min', '15min'];
  const candleData = {};
  const errors = {};
  let totalFailures = 0;
  let cacheHits = 0;

  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i];
    const data = await fetchCandlesWithCache(pair, tf, 100, env, ctx);
    if (data.error) {
      errors[tf] = data.error;
      totalFailures++;
    } else {
      if (data._fromCache) cacheHits++;
      candleData[tf] = data.candles || data;
    }
  }

  if (totalFailures === timeframes.length) {
    return jsonResponse({
      pair: pair,
      assetType: assetType,
      signal: generateDummySignal(pair),
      source: 'DUMMY_FALLBACK',
      errors: errors,
      timestamp: new Date().toISOString(),
    });
  }

  const signal = buildMultiTimeframeSignal(candleData, pair, assetType, session, exotic);

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

  return jsonResponse({
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
  });
}

// ============================================
// API KEYS
// ============================================

function getApiKeys(env) {
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = env['TWELVEDATA_API_KEY_' + i];
    if (k && typeof k === 'string' && k.trim().length > 0) keys.push(k.trim());
  }
  if (keys.length === 0 && env.TWELVEDATA_API_KEY) {
    keys.push(env.TWELVEDATA_API_KEY.trim());
  }
  return keys;
}

// ============================================
// KV CACHING
// ============================================

async function fetchCandlesWithCache(pair, tf, limit, env, ctx) {
  const cacheKey = 'c:' + pair + ':' + tf + ':' + limit;
  const ttl = CONFIG.CACHE_TTL[tf] || 60;

  if (env.SIGNAL_CACHE) {
    try {
      const cached = await env.SIGNAL_CACHE.get(cacheKey, 'json');
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return { candles: cached, _fromCache: true };
      }
    } catch (e) {
      console.warn('Cache read err:', e.message);
    }
  }

  const result = await fetchCandles(pair, tf, limit, env);
  if (result.error) return result;

  if (env.SIGNAL_CACHE && ctx && Array.isArray(result) && result.length > 0) {
    ctx.waitUntil(
      env.SIGNAL_CACHE.put(cacheKey, JSON.stringify(result), {
        expirationTtl: Math.max(60, ttl),
      }).catch(function (e) { console.warn('Cache write err:', e.message); })
    );
  }
  return { candles: result, _fromCache: false };
}

// ============================================
// DATA FETCHING
// ============================================

async function fetchCandles(pair, tf, limit, env) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: 'No API keys configured.' };

  const symbol = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
  const interval = TIMEFRAME_MAP[tf] || tf;
  const maxAttempts = Math.min(CONFIG.MAX_RETRIES, apiKeys.length);
  const startIdx = Math.floor(Date.now() / 1000) % apiKeys.length;
  let lastError = '';

  for (let a = 0; a < maxAttempts; a++) {
    const ki = (startIdx + a) % apiKeys.length;
    try {
      const u = new URL('/time_series', CONFIG.API_BASE_URL);
      u.searchParams.set('symbol', symbol);
      u.searchParams.set('interval', interval);
      u.searchParams.set('outputsize', String(limit));
      u.searchParams.set('apikey', apiKeys[ki]);
      u.searchParams.set('format', 'JSON');

      const controller = new AbortController();
      const timeoutId = setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT);

      let res;
      try {
        res = await fetch(u.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        if (res.status === 429) { lastError = 'TwelveData rate limited'; continue; }
        lastError = 'HTTP ' + res.status;
        continue;
      }

      const data = await res.json();
      if (data.status === 'error') {
        lastError = data.message || 'API error';
        continue;
      }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
        lastError = 'No data';
        continue;
      }

      const candles = data.values
        .map(function (c) {
          return {
            datetime: c.datetime,
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close),
            volume: parseFloat(c.volume || 0),
          };
        })
        .reverse();

      const valid = candles.every(function (c) {
        return isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close);
      });

      if (!valid) {
        lastError = 'Invalid data';
        continue;
      }
      return candles;
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'Timeout' : e.message;
      continue;
    }
  }
  return { error: 'All ' + maxAttempts + ' attempts failed: ' + lastError };
}

// ============================================
// TECHNICAL INDICATORS LIBRARY
// ============================================

function calculateSMA(data, period) {
  if (!data || data.length < period) return new Array(data ? data.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  r.push(s / period);
  for (let i = period; i < data.length; i++) {
    s += data[i] - data[i - period];
    r.push(s / period);
  }
  return r;
}

function calculateEMA(data, period) {
  if (!data || data.length === 0) return [];
  if (data.length < period) return new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  const r = new Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  let ema = s / period;
  r.push(ema);
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    r.push(ema);
  }
  return r;
}

function calculateRSI(data, period) {
  if (!period) period = 14;
  if (!data || data.length < period + 1) {
    return new Array(data ? data.length : 0).fill(null);
  }
  const ch = [];
  for (let i = 1; i < data.length; i++) ch.push(data[i] - data[i - 1]);
  let ag = 0;
  let al = 0;
  for (let i = 0; i < period; i++) {
    if (ch[i] > 0) ag += ch[i];
    else al += Math.abs(ch[i]);
  }
  ag /= period;
  al /= period;
  const rsi = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period; i < ch.length; i++) {
    const g = ch[i] > 0 ? ch[i] : 0;
    const l = ch[i] < 0 ? Math.abs(ch[i]) : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    rsi.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return new Array(data.length - rsi.length).fill(null).concat(rsi);
}

function calculateMACD(data) {
  if (!data || data.length === 0) return { macdLine: [], signalLine: [], histogram: [] };
  const e12 = calculateEMA(data, 12);
  const e26 = calculateEMA(data, 26);
  const ml = e12.map(function (v, i) {
    return (v === null || e26[i] === null) ? null : v - e26[i];
  });
  const vals = [];
  const idxs = [];
  ml.forEach(function (v, i) {
    if (v !== null) { vals.push(v); idxs.push(i); }
  });
  const se = calculateEMA(vals, 9);
  const sl = new Array(ml.length).fill(null);
  idxs.forEach(function (idx, j) { sl[idx] = se[j]; });
  const hist = ml.map(function (v, i) {
    return (v === null || sl[i] === null) ? null : v - sl[i];
  });
  return { macdLine: ml, signalLine: sl, histogram: hist };
}

function calculateATR(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period + 1) {
    return new Array(candles ? candles.length : 0).fill(null);
  }
  const tr = [null];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  let atr = s / period;
  const r = new Array(period).fill(null);
  r.push(atr);
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    r.push(atr);
  }
  return r;
}

function calculateBollingerBands(data, period, mult) {
  if (!period) period = 20;
  if (!mult) mult = 2;
  if (!data || data.length === 0) {
    return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
  }
  const n = data.length;
  const u = new Array(n).fill(null);
  const m = new Array(n).fill(null);
  const l = new Array(n).fill(null);
  const bw = new Array(n).fill(null);
  const pb = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j];
    const sma = s / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += Math.pow(data[j] - sma, 2);
    const sd = Math.sqrt(sq / period);
    m[i] = sma;
    u[i] = sma + mult * sd;
    l[i] = sma - mult * sd;
    bw[i] = sma > 0 ? ((u[i] - l[i]) / sma) * 100 : 0;
    const rng = u[i] - l[i];
    pb[i] = rng > 0 ? (data[i] - l[i]) / rng : 0.5;
  }
  return { upper: u, middle: m, lower: l, bandwidth: bw, percentB: pb };
}

function calculateStochastic(candles, kP, sK, sD) {
  if (!kP) kP = 14;
  if (!sK) sK = 3;
  if (!sD) sD = 3;
  if (!candles || candles.length < kP) {
    return { k: new Array(candles ? candles.length : 0).fill(null), d: [] };
  }
  const rawK = new Array(kP - 1).fill(null);
  for (let i = kP - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    rawK.push(rng > 0 ? ((candles[i].close - lo) / rng) * 100 : 50);
  }

  const validRawK = [];
  const validIdxK = [];
  for (let i = 0; i < rawK.length; i++) {
    if (rawK[i] !== null) {
      validRawK.push(rawK[i]);
      validIdxK.push(i);
    }
  }
  const smoothedK = calculateSMA(validRawK, sK);
  const k = new Array(rawK.length).fill(null);
  for (let i = 0; i < smoothedK.length; i++) {
    if (smoothedK[i] !== null) {
      k[validIdxK[i]] = smoothedK[i];
    }
  }

  const validK = [];
  const validIdxD = [];
  for (let i = 0; i < k.length; i++) {
    if (k[i] !== null) {
      validK.push(k[i]);
      validIdxD.push(i);
    }
  }
  const smoothedD = calculateSMA(validK, sD);
  const d = new Array(k.length).fill(null);
  for (let i = 0; i < smoothedD.length; i++) {
    if (smoothedD[i] !== null) {
      d[validIdxD[i]] = smoothedD[i];
    }
  }

  return { k: k, d: d };
}

function calculateADX(candles, period) {
  if (!period) period = 14;
  const n = candles ? candles.length : 0;
  if (n < period * 2 + 1) {
    return {
      adx: new Array(n).fill(null),
      plusDI: new Array(n).fill(null),
      minusDI: new Array(n).fill(null),
    };
  }

  const pDM = [0];
  const mDM = [0];
  const tr = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  function ws(arr, p) {
    const r = new Array(arr.length).fill(null);
    let s = 0;
    for (let i = 1; i <= p; i++) s += arr[i];
    r[p] = s;
    for (let i = p + 1; i < arr.length; i++) {
      r[i] = r[i - 1] - r[i - 1] / p + arr[i];
    }
    return r;
  }

  const sTR = ws(tr, period);
  const sPDM = ws(pDM, period);
  const sMDM = ws(mDM, period);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);

  for (let i = period; i < n; i++) {
    if (sTR[i] && sTR[i] > 0) {
      plusDI[i] = (sPDM[i] / sTR[i]) * 100;
      minusDI[i] = (sMDM[i] / sTR[i]) * 100;
      const ds = plusDI[i] + minusDI[i];
      dx[i] = ds > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / ds) * 100 : 0;
    }
  }

  const adx = new Array(n).fill(null);
  let adxS = 0;
  let adxC = 0;
  let adxI = -1;
  for (let i = period; i < n; i++) {
    if (dx[i] !== null) {
      adxS += dx[i];
      adxC++;
      if (adxC === period) {
        adx[i] = adxS / period;
        adxI = i;
        break;
      }
    }
  }
  if (adxI > 0) {
    for (let i = adxI + 1; i < n; i++) {
      if (dx[i] !== null && adx[i - 1] !== null) {
        adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
      }
    }
  }

  return { adx: adx, plusDI: plusDI, minusDI: minusDI };
}

function calculateWilliamsR(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period) {
    return new Array(candles ? candles.length : 0).fill(null);
  }
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    r.push(rng > 0 ? ((hi - candles[i].close) / rng) * -100 : -50);
  }
  return r;
}

function calculateCCI(candles, period) {
  if (!period) period = 20;
  if (!candles || candles.length < period) {
    return new Array(candles ? candles.length : 0).fill(null);
  }
  const tp = candles.map(function (c) { return (c.high + c.low + c.close) / 3; });
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < tp.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += tp[j];
    const mean = s / period;
    let mad = 0;
    for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - mean);
    mad /= period;
    r.push(mad > 0 ? (tp[i] - mean) / (0.015 * mad) : 0);
  }
  return r;
}

function calculateMFI(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period + 1) {
    return new Array(candles ? candles.length : 0).fill(null);
  }
  const tp = candles.map(function (c) { return (c.high + c.low + c.close) / 3; });
  const mf = candles.map(function (c, i) { return tp[i] * c.volume; });
  const r = new Array(period).fill(null);
  for (let i = period; i < candles.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += mf[j];
      else if (tp[j] < tp[j - 1]) neg += mf[j];
    }
    r.push(neg > 0 ? 100 - 100 / (1 + pos / neg) : 100);
  }
  return r;
}

function calculatePivotPoints(candles) {
  if (!candles || candles.length < 2) {
    return { pivot: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
  }
  const lb = Math.min(20, candles.length - 1);
  const sc = candles.slice(-lb - 1, -1);
  let sh = -Infinity;
  let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (const c of sc) {
    if (c.high > sh) sh = c.high;
    if (c.low < sl) sl = c.low;
  }
  const p = (sh + sl + scl) / 3;
  const rng = sh - sl;
  return {
    pivot: p,
    r1: 2 * p - sl,
    r2: p + rng,
    r3: sh + 2 * (p - sl),
    s1: 2 * p - sh,
    s2: p - rng,
    s3: sl - 2 * (sh - p),
  };
}

// ============================================
// CANDLESTICK PATTERNS — FIX #13: THREE_BLACK_CROWS double-push typo fixed
// ============================================

function detectCandlestickPatterns(candles) {
  const patterns = [];
  if (!candles || candles.length < 3) return patterns;
  const n = candles.length;
  const c0 = candles[n - 1];
  const c1 = candles[n - 2];
  const c2 = candles[n - 3];
  const b0 = c0.close - c0.open;
  const b1 = c1.close - c1.open;
  const b2 = c2.close - c2.open;
  const ab0 = Math.abs(b0);
  const ab1 = Math.abs(b1);
  const r0 = (c0.high - c0.low) || 0.00001;
  const r1 = (c1.high - c1.low) || 0.00001;
  const bp0 = ab0 / r0;
  const bp1 = ab1 / r1;
  const uw0 = c0.high - Math.max(c0.open, c0.close);
  const lw0 = Math.min(c0.open, c0.close) - c0.low;

  if (b1 < 0 && b0 > 0 && c0.open <= c1.close && c0.close >= c1.open && ab0 > ab1) {
    patterns.push({ name: 'BULLISH_ENGULFING', direction: 'BUY', strength: 2.0 });
  }
  if (b1 > 0 && b0 < 0 && c0.open >= c1.close && c0.close <= c1.open && ab0 > ab1) {
    patterns.push({ name: 'BEARISH_ENGULFING', direction: 'SELL', strength: 2.0 });
  }
  if (bp0 < 0.35 && lw0 > ab0 * 2 && uw0 < ab0 * 0.5) {
    patterns.push({ name: 'HAMMER', direction: 'BUY', strength: 1.5 });
  }
  if (bp0 < 0.35 && uw0 > ab0 * 2 && lw0 < ab0 * 0.5) {
    patterns.push({ name: 'SHOOTING_STAR', direction: 'SELL', strength: 1.5 });
  }
  if (bp0 < 0.1) {
    patterns.push({ name: 'DOJI', direction: 'NEUTRAL', strength: 0.5 });
  }
  if (lw0 > r0 * 0.6 && uw0 < r0 * 0.15 && bp0 < 0.3) {
    patterns.push({ name: 'PIN_BAR_BULLISH', direction: 'BUY', strength: 1.8 });
  }
  if (uw0 > r0 * 0.6 && lw0 < r0 * 0.15 && bp0 < 0.3) {
    patterns.push({ name: 'PIN_BAR_BEARISH', direction: 'SELL', strength: 1.8 });
  }

  const r2v = (c2.high - c2.low) || 0.00001;
  if (b2 < 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 > 0 && bp0 > 0.5 && c0.close > (c2.open + c2.close) / 2) {
    patterns.push({ name: 'MORNING_STAR', direction: 'BUY', strength: 2.5 });
  }
  if (b2 > 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 < 0 && bp0 > 0.5 && c0.close < (c2.open + c2.close) / 2) {
    patterns.push({ name: 'EVENING_STAR', direction: 'SELL', strength: 2.5 });
  }
  if (b2 > 0 && b1 > 0 && b0 > 0 && c1.close > c2.close && c0.close > c1.close && bp0 > 0.5 && bp1 > 0.5) {
    patterns.push({ name: 'THREE_WHITE_SOLDIERS', direction: 'BUY', strength: 2.0 });
  }
  // FIX #13: was `patterns.pushpatterns.push(...)` — corrected to single push
  if (b2 < 0 && b1 < 0 && b0 < 0 && c1.close < c2.close && c0.close < c1.close && bp0 > 0.5 && bp1 > 0.5) {
    patterns.push({ name: 'THREE_BLACK_CROWS', direction: 'SELL', strength: 2.0 });
  }

  return patterns;
}

// ============================================
// DIVERGENCE DETECTION
// ============================================

function detectRSIDivergence(candles, rsiVals, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !rsiVals || candles.length < lookback) return null;
  const n = candles.length;
  const st = n - lookback;
  const pL = [];
  const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (rsiVals[i] === null) continue;
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i - 2].low &&
      candles[i].low <= candles[i + 1].low && candles[i].low <= candles[i + 2].low) {
      pL.push({ idx: i, price: candles[i].low, rsi: rsiVals[i] });
    }
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i - 2].high &&
      candles[i].high >= candles[i + 1].high && candles[i].high >= candles[i + 2].high) {
      pH.push({ idx: i, price: candles[i].high, rsi: rsiVals[i] });
    }
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1];
    const p = pL[pL.length - 2];
    if (r.price < p.price && r.rsi > p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lastCandle = candles[n - 1];
      if (lastCandle.close > lastCandle.open) {
        return { type: 'BULLISH_RSI_DIVERGENCE', direction: 'BUY', strength: 2.0, confirmed: true };
      }
      return { type: 'BULLISH_RSI_DIVERGENCE', direction: 'BUY', strength: 1.0, confirmed: false };
    }
  }

  if (pH.length >= 2) {
    const r = pH[pH.length - 1];
    const p = pH[pH.length - 2];
    if (r.price > p.price && r.rsi < p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lastCandle = candles[n - 1];
      if (lastCandle.close < lastCandle.open) {
        return { type: 'BEARISH_RSI_DIVERGENCE', direction: 'SELL', strength: 2.0, confirmed: true };
      }
      return { type: 'BEARISH_RSI_DIVERGENCE', direction: 'SELL', strength: 1.0, confirmed: false };
    }
  }
  return null;
}

function detectMACDDivergence(candles, hist, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !hist || candles.length < lookback) return null;
  const n = candles.length;
  const st = n - lookback;
  const pL = [];
  const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (hist[i] === null) continue;
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low) {
      pL.push({ idx: i, price: candles[i].low, macd: hist[i] });
    }
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high) {
      pH.push({ idx: i, price: candles[i].high, macd: hist[i] });
    }
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1];
    const p = pL[pL.length - 2];
    if (r.price < p.price && r.macd > p.macd) {
      const lastCandle = candles[n - 1];
      const confirmed = lastCandle.close > lastCandle.open;
      return { type: 'BULLISH_MACD_DIV', direction: 'BUY', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1];
    const p = pH[pH.length - 2];
    if (r.price > p.price && r.macd < p.macd) {
      const lastCandle = candles[n - 1];
      const confirmed = lastCandle.close < lastCandle.open;
      return { type: 'BEARISH_MACD_DIV', direction: 'SELL', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  return null;
}

// ============================================
// MARKET CONDITION DETECTION
// ============================================

function detectMarketCondition(adxVal, bbBW, atr, lastClose, assetType) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const cond = [];

  if (adxVal !== null) {
    if (adxVal >= 40) cond.push('STRONG_TREND');
    else if (adxVal >= 25) cond.push('TRENDING');
    else if (adxVal >= 15) cond.push('WEAK_TREND');
    else cond.push('RANGING');
  }

  if (bbBW !== null) {
    if (bbBW < vt.bbSqueeze) cond.push('SQUEEZE');
    else if (bbBW > vt.bbHighVol) cond.push('HIGH_VOLATILITY');
  }

  if (atr !== null && lastClose > 0) {
    const ap = (atr / lastClose) * 100;
    if (ap > vt.atrVolatile) cond.push('VOLATILE');
    else if (ap < vt.atrDeadMarket) cond.push('DEAD_MARKET');
  }

  return cond.length === 0 ? ['NORMAL'] : cond;
}

function isTrendingMarket(adxVal) {
  if (adxVal === null) return null;
  return adxVal >= 25;
}

function detectDICrossover(adxIndicator) {
  if (!adxIndicator || !adxIndicator.plusDI || !adxIndicator.minusDI) return null;

  const lastPlusDI = safeLastTwo(adxIndicator.plusDI);
  const lastMinusDI = safeLastTwo(adxIndicator.minusDI);

  if (lastPlusDI.last === null || lastPlusDI.prev === null ||
    lastMinusDI.last === null || lastMinusDI.prev === null) return null;

  if (lastPlusDI.prev <= lastMinusDI.prev && lastPlusDI.last > lastMinusDI.last) {
    return { type: 'BULLISH_DI_CROSS', direction: 'BUY', strength: 1.5 };
  }

  if (lastMinusDI.prev <= lastPlusDI.prev && lastMinusDI.last > lastPlusDI.last) {
    return { type: 'BEARISH_DI_CROSS', direction: 'SELL', strength: 1.5 };
  }

  return null;
}

// ============================================
// CALCULATE ALL INDICATORS
// ============================================

function calculateAllIndicators(candles) {
  const closes = candles.map(function (c) { return c.close; });
  return {
    ema5: calculateEMA(closes, 5),
    ema10: calculateEMA(closes, 10),
    ema20: calculateEMA(closes, 20),
    sma50: calculateSMA(closes, 50),
    rsi: calculateRSI(closes, CONFIG.RSI_PERIOD),
    macd: calculateMACD(closes),
    atr: calculateATR(candles, CONFIG.ATR_PERIOD),
    bollinger: calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV),
    stochastic: calculateStochastic(candles, CONFIG.STOCH_PERIOD, CONFIG.STOCH_SMOOTH_K, CONFIG.STOCH_SMOOTH_D),
    adx: calculateADX(candles, CONFIG.ADX_PERIOD),
    williamsR: calculateWilliamsR(candles, CONFIG.WILLIAMS_PERIOD),
    cci: calculateCCI(candles, CONFIG.CCI_PERIOD),
    mfi: calculateMFI(candles, CONFIG.MFI_PERIOD),
    pivots: calculatePivotPoints(candles),
    patterns: detectCandlestickPatterns(candles),
  };
}

// ============================================
// SAFE VALUE HELPERS
// ============================================

function safeLastValue(arr) {
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return arr[i];
  }
  return null;
}

function safeLastTwo(arr) {
  if (!arr || arr.length === 0) return { last: null, prev: null };
  let last = null;
  let prev = null;
  let foundFirst = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
      if (!foundFirst) {
        last = arr[i];
        foundFirst = true;
      } else {
        prev = arr[i];
        break;
      }
    }
  }
  return { last: last, prev: prev };
}

function safeLastN(arr, n) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
      result.unshift(arr[i]);
    }
  }
  return result;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function r2(v) { return Math.round(v * 100) / 100; }
function fmt(v, d) { if (!d) d = 5; return v !== null ? v.toFixed(d) : 'N/A'; }

function getNextCandleClose(now, candleMinutes) {
  const ms = candleMinutes * 60000;
  const currentSlot = Math.floor(now.getTime() / ms);
  return new Date((currentSlot + 1) * ms);
}

function formatDuration(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
}

// ============================================
// CANDLE-BASED DURATION
// ============================================

function calculateCandleDuration(indicators, direction, candles, timeframe, assetType, score) {
  const durCfg = DURATION_CONFIG[assetType] || DURATION_CONFIG.FOREX;
  const cfg = durCfg[timeframe] || { base: 3, min: 1, max: 10 };
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  let dur = cfg.base;

  // [v6.1] Score-based bonus REMOVED — was inflating expiry unnecessarily
  // signalScore >= 8 → dur+2 and signalScore >= 5 → dur+1 removed

  const rsi = safeLastValue(indicators.rsi);
  if (rsi !== null) {
    if (rsi > 80 || rsi < 20) dur -= 2;
    else if (rsi > 70 || rsi < 30) dur -= 1;
  }

  const stochK = safeLastValue(indicators.stochastic.k);
  if (stochK !== null) {
    if (stochK > 90 || stochK < 10) dur -= 1;
  }

  const atr = safeLastValue(indicators.atr);
  if (atr !== null && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > 0) {
      const atrPct = (atr / lastClose) * 100;
      if (atrPct > vt.atrVeryHigh) dur -= 2;
      else if (atrPct > vt.atrHigh) dur -= 1;
      else if (atrPct < vt.atrDead) dur += 2;
      else if (atrPct < vt.atrLow) dur += 1;
    }
  }

  const adxVal = safeLastValue(indicators.adx.adx);
  if (adxVal !== null) {
    if (adxVal >= 40) dur += 1;
    else if (adxVal < 15) dur -= 1;
  }

  const bbBW = safeLastValue(indicators.bollinger.bandwidth);
  if (bbBW !== null && bbBW < vt.bbSqueeze) dur += 1;

  if (indicators.patterns) {
    const strongNames = [
      'MORNING_STAR', 'EVENING_STAR', 'THREE_WHITE_SOLDIERS',
      'THREE_BLACK_CROWS', 'BULLISH_ENGULFING', 'BEARISH_ENGULFING'
    ];
    const strongP = indicators.patterns.filter(function (p) {
      return strongNames.indexOf(p.name) !== -1;
    });
    if (strongP.length > 0) dur += 1;
  }

  if (timeframe === '15min' && adxVal !== null && adxVal < 20) dur -= 1;
  if (timeframe === '1min' && adxVal !== null && adxVal >= 30) dur += 1;

  return Math.max(cfg.min, Math.min(cfg.max, Math.round(dur)));
}

// ============================================
// SIGNAL GRADE
// ============================================

function getSignalGrade(confidence, avgConf, alignment) {
  let sc = 0;
  sc += Math.min(40, confidence * 0.4);
  sc += Math.min(35, avgConf * 5);
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') sc += 25;
  else if (alignment.indexOf('MOSTLY') === 0) sc += 12;

  if (sc >= 85) return { grade: 'A+', label: 'EXCELLENT', description: 'Very high probability setup.' };
  if (sc >= 75) return { grade: 'A', label: 'STRONG', description: 'High probability with multiple confirmations.' };
  if (sc >= 60) return { grade: 'B', label: 'GOOD', description: 'Solid setup. Suitable for trading.' };
  if (sc >= 45) return { grade: 'C', label: 'MODERATE', description: 'Some conflicts. Trade with caution.' };
  if (sc >= 30) return { grade: 'D', label: 'WEAK', description: 'Low confidence. Consider skipping.' };
  return { grade: 'F', label: 'AVOID', description: 'Very weak. Do NOT trade.' };
}

// ============================================
// TIE RESOLUTION
// ============================================

function resolveTieWithTolerance(details) {
  let tU = 0;
  let tD = 0;
  let cU = 0;
  let cD = 0;
  const tfKeys = Object.keys(details);
  for (let i = 0; i < tfKeys.length; i++) {
    const tf = tfKeys[i];
    const s = details[tf];
    const w = CONFIG.TF_WEIGHTS[tf] || 1.0;
    tU += s.score.up * w;
    tD += s.score.down * w;
    cU += ((s.confluenceDetail && s.confluenceDetail.bullish) || 0) * w;
    cD += ((s.confluenceDetail && s.confluenceDetail.bearish) || 0) * w;
  }
  const total = tU + tD;
  if (tU > tD && cU >= cD) return { direction: 'BUY', confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU && cD >= cU) return { direction: 'SELL', confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  if (tU > tD) return { direction: 'BUY', confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU) return { direction: 'SELL', confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  return { direction: 'NO_TRADE', confidence: 50 };
}

// ============================================
// DUMMY FALLBACK
// ============================================

function generateDummySignal(pair) {
  const seed = (new Date().getMinutes() + pair.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 0)) % 10;
  const dir = seed < 4 ? 'BUY' : seed < 8 ? 'SELL' : 'NO_TRADE';
  return {
    finalSignal: dir,
    confidence: '0%',
    grade: { grade: 'F', label: 'DUMMY', description: 'Fallback — no real data.' },
    marketCondition: ['UNKNOWN'],
    alignment: 'NONE',
    recommendations: {},
    bestTimeframe: { timeframe: 'N/A' },
    votes: { BUY: 0, SELL: 0, NO_TRADE: 0, total: 0 },
    timeframeAnalysis: {},
    method: 'DUMMY_FALLBACK',
    warning: 'All API calls failed. Zero reliability.',
  };
}

// ============================================
// JSON RESPONSE
// ============================================

function jsonResponse(data, status) {
  if (!status) status = 200;
  return new Response(JSON.stringify(data, null, 2), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

// ============================================
// BUILD MULTI-TIMEFRAME SIGNAL (v6.0)
// ============================================

function buildMultiTimeframeSignal(candleData, pair, assetType, session, exotic) {
  const now = new Date();
  const tfResults = {};
  const votes = [];

  // Step 0: Higher-TF Trend from 15min
  let higherTFTrend = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfIndicators = calculateAllIndicators(candleData['15min']);
    const htfEma5 = safeLastValue(htfIndicators.ema5);
    const htfEma20 = safeLastValue(htfIndicators.ema20);
    const htfAdx = safeLastValue(htfIndicators.adx.adx);
    const htfPlusDI = safeLastValue(htfIndicators.adx.plusDI);
    const htfMinusDI = safeLastValue(htfIndicators.adx.minusDI);

    if (htfEma5 !== null && htfEma20 !== null && htfAdx !== null && htfAdx >= 20) {
      if (htfEma5 > htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfPlusDI > htfMinusDI) {
        higherTFTrend = 'BUY';
      } else if (htfEma5 < htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfMinusDI > htfPlusDI) {
        higherTFTrend = 'SELL';
      }
    }
  }

  // Step 1: Analyze each timeframe
  const tfKeys = Object.keys(candleData);
  for (let t = 0; t < tfKeys.length; t++) {
    const tf = tfKeys[t];
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;

    const indicators = calculateAllIndicators(candles);
    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend);

    const durationCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType, analysis.score);
    const candleMin = CANDLE_MINUTES[tf] || 1;
    const durationMinutes = durationCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durationMinutes * 60000);
    const nextCandleClose = getNextCandleClose(now, candleMin);

    analysis.expiry = {
      candles: durationCandles,
      candleSize: candleMin + 'min',
      totalMinutes: durationMinutes,
      expiryTime: expiryTime.toISOString(),
      humanReadable: formatDuration(durationMinutes),
      nextCandleClose: nextCandleClose.toISOString(),
    };

    const lastCandle = candles[candles.length - 1];
    analysis.entry = {
      price: lastCandle.close,
      candleTime: lastCandle.datetime,
      candleDirection: lastCandle.close >= lastCandle.open ? 'BULLISH' : 'BEARISH',
    };

    analysis.higherTFTrend = higherTFTrend;
    analysis.alignedWithHTF = (higherTFTrend === null || analysis.direction === 'NO_TRADE' || analysis.direction === higherTFTrend);

    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf: tf, alignedWithHTF: analysis.alignedWithHTF });
  }

  // Step 2: Weighted Multi-TF Voting
  let weightedBuy = 0;
  let weightedSell = 0;
  let totalWeight = 0;
  const activeDirs = [];

  for (let v = 0; v < votes.length; v++) {
    const vote = votes[v];
    const w = CONFIG.TF_WEIGHTS[vote.tf] || 1.0;
    totalWeight += w;

    if (vote.direction === 'BUY') {
      weightedBuy += w * (vote.score.up || 1);
      activeDirs.push('BUY');
    } else if (vote.direction === 'SELL') {
      weightedSell += w * (vote.score.down || 1);
      activeDirs.push('SELL');
    }
  }

  // Alignment check
  const allBuy = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'BUY'; });
  const allSell = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'SELL'; });
  let alignment = 'MIXED';
  let alignmentBonus = 0;

  if (allBuy) {
    alignment = 'ALL_BULLISH';
    alignmentBonus = 15;
  } else if (allSell) {
    alignment = 'ALL_BEARISH';
    alignmentBonus = 15;
  } else if (!allBuy && !allSell && activeDirs.length >= 2) {
    const bc = activeDirs.filter(function (d) { return d === 'BUY'; }).length;
    const sc = activeDirs.filter(function (d) { return d === 'SELL'; }).length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = 7; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = 7; }
  }

  // Step 3: Decision
  let finalDirection;
  let confidence;
  const totalWeightedScore = weightedBuy + weightedSell;

  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    confidence = totalWeightedScore > 0 ? Math.round((weightedBuy / totalWeightedScore) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    confidence = totalWeightedScore > 0 ? Math.round((weightedSell / totalWeightedScore) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction;
    confidence = tie.confidence;
  }

  // Higher-TF alignment bonus/penalty
  // [v6.1] HTF CONFLICT → HARD NO_TRADE BLOCK (was -10 confidence penalty only)
  if (higherTFTrend !== null && finalDirection !== 'NO_TRADE' && finalDirection !== higherTFTrend) {
    finalDirection = 'NO_TRADE';
    confidence = 0;
  } else if (higherTFTrend !== null && finalDirection === higherTFTrend) {
    confidence = Math.min(99, confidence + 5);
  }

  confidence = Math.min(99, confidence + alignmentBonus);

  // [v6.1] MIXED alignment → NO_TRADE (was generating directional signal in conflicted state)
  if (alignment === 'MIXED') {
    finalDirection = 'NO_TRADE';
    confidence = 0;
  }

  // Session quality adjustment
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === 'LOW') confidence = Math.max(25, confidence - 8);
    else if (session.quality === 'HIGHEST') confidence = Math.min(99, confidence + 3);
  }

  // Exotic pair penalty
  if (exotic) {
    confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY);
  }

  // Step 4: Grade
  const avgConf = votes.reduce(function (s, v) { return s + (v.confluence || 0); }, 0) / Math.max(votes.length, 1);
  const grade = getSignalGrade(confidence, avgConf, alignment);

  // Step 5: Market Condition
  const htf = candleData['15min'] || candleData['5min'] || candleData['1min'];
  let marketCondition = ['UNKNOWN'];
  if (htf && htf.length > 0) {
    const hi = calculateAllIndicators(htf);
    marketCondition = detectMarketCondition(
      safeLastValue(hi.adx.adx),
      safeLastValue(hi.bollinger.bandwidth),
      safeLastValue(hi.atr),
      htf[htf.length - 1].close,
      assetType
    );
  }

  // Dead market filter
  if (marketCondition.indexOf('DEAD_MARKET') !== -1 && confidence < 75) {
    finalDirection = 'NO_TRADE';
    confidence = Math.min(confidence, 30);
  }

  // Step 6: Best Timeframe
  const best = findBestTimeframe(tfResults, finalDirection);

  // Step 7: Per-TF Recommendations
  const recommendations = {};
  const recKeys = Object.keys(tfResults);
  for (let r = 0; r < recKeys.length; r++) {
    const rtf = recKeys[r];
    const rec = tfResults[rtf];
    recommendations[rtf] = {
      direction: rec.direction,
      score: rec.score,
      confluence: rec.confluence + '/10 categories',
      alignedWithHTF: rec.alignedWithHTF,
      expiry: rec.expiry,
      entry: rec.entry,
      patterns: (rec.categoryScores && rec.categoryScores.patterns && rec.categoryScores.patterns.detected) ? rec.categoryScores.patterns.detected : [],
      divergence: {
        rsi: (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.rsi) ? rec.categoryScores.divergence.rsi : 'NONE',
        macd: (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.macd) ? rec.categoryScores.divergence.macd : 'NONE',
      },
      diCrossover: (rec.categoryScores && rec.categoryScores.adx && rec.categoryScores.adx.diCross) ? rec.categoryScores.adx.diCross : 'NONE',
    };
  }

  return {
    finalSignal: finalDirection,
    confidence: confidence + '%',
    grade: grade,
    assetType: assetType,
    marketCondition: marketCondition,
    alignment: alignment,
    higherTFTrend: higherTFTrend || 'NEUTRAL',
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ['24/7'], quality: 'N/A' },
    recommendations: recommendations,
    bestTimeframe: best,
    votes: {
      BUY: votes.filter(function (v) { return v.direction === 'BUY'; }).length,
      SELL: votes.filter(function (v) { return v.direction === 'SELL'; }).length,
      NO_TRADE: votes.filter(function (v) { return v.direction === 'NO_TRADE'; }).length,
      total: votes.length,
      weightedBuy: r2(weightedBuy),
      weightedSell: r2(weightedSell),
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    method: 'WEIGHTED_MULTI_TF_v6.1',
    generatedAt: now.toISOString(),
  };
}

// ============================================
// FIND BEST TIMEFRAME
// ============================================

function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null;
  let bestScore = -1;
  let bestConf = -1;

  const keys = Object.keys(tfResults);
  for (let i = 0; i < keys.length; i++) {
    const tf = keys[i];
    const r = tfResults[tf];
    if (r.direction === finalDirection || finalDirection === 'NO_TRADE') {
      const score = r.direction === 'BUY' ? r.score.up : r.direction === 'SELL' ? r.score.down : 0;
      const alignBonus = r.alignedWithHTF ? 1 : 0;
      const effectiveConf = r.confluence + alignBonus;

      if (effectiveConf > bestConf || (effectiveConf === bestConf && score > bestScore)) {
        bestTF = tf;
        bestScore = score;
        bestConf = effectiveConf;
      }
    }
  }

  if (!bestTF) {
    for (let i = 0; i < keys.length; i++) {
      const tf = keys[i];
      const r = tfResults[tf];
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) {
        bestTF = tf;
        bestScore = score;
        bestConf = r.confluence;
      }
    }
  }

  if (!bestTF) return { timeframe: 'N/A', reason: 'No analyzable timeframe' };

  const best = tfResults[bestTF];
  return {
    timeframe: bestTF,
    direction: best.direction,
    score: bestScore,
    confluence: best.confluence,
    alignedWithHTF: best.alignedWithHTF,
    expiry: best.expiry,
    reason: 'Strongest ' + best.direction + ' signal with ' + best.confluence + '/10 confluence' + (best.alignedWithHTF ? ' (aligned with higher TF)' : ''),
  };
}

// ============================================
// TIMEFRAME ANALYSIS v6.0
// ============================================

function analyzeTimeframe(indicators, candles, timeframe, assetType, higherTFTrend) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const minScoreThreshold = SCORE_THRESHOLDS[assetType] || 3.0;
  const weights = CONFIG.CATEGORY_WEIGHTS;

  const ema5 = safeLastValue(indicators.ema5);
  const ema10 = safeLastValue(indicators.ema10);
  const ema20 = safeLastValue(indicators.ema20);
  const sma50 = safeLastValue(indicators.sma50);
  const rsi = safeLastValue(indicators.rsi);
  const macdHistData = safeLastTwo(indicators.macd.histogram);
  const macdHist = macdHistData.last;
  const prevMacdHist = macdHistData.prev;
  const macdLineData = safeLastTwo(indicators.macd.macdLine);
  const macdLine = macdLineData.last;
  const macdSignalData = safeLastTwo(indicators.macd.signalLine);
  const macdSignal = macdSignalData.last;
  const atr = safeLastValue(indicators.atr);
  const bbUpper = safeLastValue(indicators.bollinger.upper);
  const bbLower = safeLastValue(indicators.bollinger.lower);
  const bbMiddle = safeLastValue(indicators.bollinger.middle);
  const bbBandwidth = safeLastValue(indicators.bollinger.bandwidth);
  const bbPercentB = safeLastValue(indicators.bollinger.percentB);
  const stochK = safeLastValue(indicators.stochastic.k);
  const stochD = safeLastValue(indicators.stochastic.d);
  const prevStochKData = safeLastTwo(indicators.stochastic.k);
  const prevStochK = prevStochKData.prev;
  const adxVal = safeLastValue(indicators.adx.adx);
  const plusDI = safeLastValue(indicators.adx.plusDI);
  const minusDI = safeLastValue(indicators.adx.minusDI);
  const williamsR = safeLastValue(indicators.williamsR);
  const cci = safeLastValue(indicators.cci);
  const mfi = safeLastValue(indicators.mfi);
  const pivots = indicators.pivots;
  const patterns = indicators.patterns;

  if (ema5 === null || ema20 === null) {
    return {
      direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
      confluence: 0, reason: 'Insufficient data', timeframe: timeframe, assetType: assetType,
      categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 10 }, volatilityMultiplier: 0,
    };
  }

  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle.close;
  const trending = isTrendingMarket(adxVal);

  let upScore = 0;
  let downScore = 0;
  let upCat = 0;
  let downCat = 0;
  const catScores = {};

  // Dead market check
  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct < vt.minTradableATR) {
      return {
        direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
        confluence: 0, reason: 'Dead market — ATR too low',
        timeframe: timeframe, assetType: assetType, deadMarket: true,
        categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 10 }, volatilityMultiplier: 0,
      };
    }
  }

  // === CAT 1: TREND ===
  var tU = 0;
  var tD = 0;
  if (ema5 > ema20) tU += 1; else if (ema5 < ema20) tD += 1;
  if (ema10 !== null) { if (ema10 > ema20) tU += 0.5; else if (ema10 < ema20) tD += 0.5; }
  if (sma50 !== null) { if (lastClose > sma50) tU += 0.75; else if (lastClose < sma50) tD += 0.75; }
  if (ema10 !== null) {
    if (ema5 > ema10 && ema10 > ema20) tU += 0.75;
    else if (ema5 < ema10 && ema10 < ema20) tD += 0.75;
  }
  var ema5Vals = safeLastN(indicators.ema5, 3);
  if (ema5Vals.length >= 3) {
    var slope = ema5Vals[2] - ema5Vals[0];
    if (slope > 0) tU += 0.25; else if (slope < 0) tD += 0.25;
  }
  tU *= weights.trend;
  tD *= weights.trend;
  upScore += tU; downScore += tD;
  if (tU > tD && Math.abs(tU - tD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (tD > tU && Math.abs(tD - tU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.trend = { up: r2(tU), down: r2(tD) };

  // === CAT 2: MOMENTUM (RSI/Williams/MFI) ===
  var mU = 0;
  var mD = 0;
  if (rsi !== null) {
    if (trending === true) {
      if (rsi >= 60 && rsi < 80) mU += 1.0;
      else if (rsi >= 50 && rsi < 60) mU += 0.5;
      else if (rsi > 40 && rsi < 50) mD += 0.5;
      else if (rsi > 20 && rsi <= 40) mD += 1.0;
      else if (rsi >= 80) mU += 0.3;
      else if (rsi <= 20) mD += 0.3;
    } else if (trending === false) {
      if (rsi >= 75) mD += 1.5;
      else if (rsi >= 65) mD += 0.75;
      else if (rsi <= 25) mU += 1.5;
      else if (rsi <= 35) mU += 0.75;
      else if (rsi >= 55) mU += 0.25;
      else if (rsi <= 45) mD += 0.25;
    } else {
      if (rsi >= 75) mD += 1.0;
      else if (rsi >= 60) mU += 0.5;
      else if (rsi <= 25) mU += 1.0;
      else if (rsi <= 40) mD += 0.5;
    }
  }
  if (williamsR !== null) {
    if (trending === true) {
      if (williamsR > -30) mU += 0.3; else if (williamsR < -70) mD += 0.3;
    } else {
      if (williamsR > -20) mD += 0.5;
      else if (williamsR < -80) mU += 0.5;
      else if (williamsR > -50) mU += 0.25;
      else mD += 0.25;
    }
  }
  if (mfi !== null) {
    var hasVolume = assetType === ASSET_TYPE.CRYPTO || lastCandle.volume > 0;
    if (hasVolume) {
      if (mfi >= 80) mD += 0.5;
      else if (mfi <= 20) mU += 0.5;
      else if (mfi >= 55) mU += 0.25;
      else if (mfi <= 45) mD += 0.25;
    }
  }
  mU *= weights.momentum;
  mD *= weights.momentum;
  upScore += mU; downScore += mD;
  if (mU > mD && Math.abs(mU - mD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mD > mU && Math.abs(mD - mU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.momentum = { up: r2(mU), down: r2(mD), context: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN' };

  // === CAT 3: MACD ===
  var mcU = 0;
  var mcD = 0;
  if (macdHist !== null) {
    if (macdHist > 0) mcU += 0.75; else if (macdHist < 0) mcD += 0.75;
    if (prevMacdHist !== null) {
      if (macdHist > 0 && macdHist > prevMacdHist) mcU += 0.4;
      else if (macdHist < 0 && macdHist < prevMacdHist) mcD += 0.4;
      else if (macdHist > 0 && macdHist < prevMacdHist) mcU += 0.1;
      else if (macdHist < 0 && macdHist > prevMacdHist) mcD += 0.1;
    }
  }
  if (macdLine !== null && macdSignal !== null) {
    if (macdLine > macdSignal) mcU += 0.5; else if (macdLine < macdSignal) mcD += 0.5;
    var prevMacdLine = macdLineData.prev;
    if (prevMacdLine !== null) {
      if (prevMacdLine <= 0 && macdLine > 0) mcU += 0.5;
      else if (prevMacdLine >= 0 && macdLine < 0) mcD += 0.5;
    }
  }
  mcU *= weights.macd;
  mcD *= weights.macd;
  upScore += mcU; downScore += mcD;
  if (mcU > mcD && Math.abs(mcU - mcD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mcD > mcU && Math.abs(mcD - mcU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.macd = { up: r2(mcU), down: r2(mcD) };

  // === CAT 4: STOCHASTIC ===
  var sU = 0;
  var sD = 0;
  if (stochK !== null && stochD !== null) {
    if (trending === true) {
      if (stochK > stochD && stochK > 40 && stochK < 70) sU += 0.75;
      else if (stochK < stochD && stochK > 30 && stochK < 60) sD += 0.75;
      if (prevStochK !== null && prevStochK < 30 && stochK > 30 && stochK > stochD) sU += 0.75;
      if (prevStochK !== null && prevStochK > 70 && stochK < 70 && stochK < stochD) sD += 0.75;
    } else {
      if (stochK > 80 && stochD > 80) sD += 0.75;
      else if (stochK < 20 && stochD < 20) sU += 0.75;
      if (stochK > stochD) sU += 0.5; else if (stochK < stochD) sD += 0.5;
      if (prevStochK !== null) {
        if (stochK > prevStochK) sU += 0.25; else if (stochK < prevStochK) sD += 0.25;
      }
      if (stochK < 20 && stochK > stochD) sU += 0.5;
      if (stochK > 80 && stochK < stochD) sD += 0.5;
    }
  }
  sU *= weights.stochastic;
  sD *= weights.stochastic;
  upScore += sU; downScore += sD;
  if (sU > sD && Math.abs(sU - sD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (sD > sU && Math.abs(sD - sU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.stochastic = { up: r2(sU), down: r2(sD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 5: BOLLINGER + CCI ===
  var bU = 0;
  var bD = 0;
  if (bbUpper !== null && bbLower !== null && bbMiddle !== null) {
    if (trending === true) {
      if (lastClose >= bbUpper) {
        if (ema5 > ema20) bU += 0.75; else bD += 0.5;
      } else if (lastClose <= bbLower) {
        if (ema5 < ema20) bD += 0.75; else bU += 0.5;
      } else if (lastClose > bbMiddle) {
        bU += 0.25;
      } else if (lastClose < bbMiddle) {
        bD += 0.25;
      }
    } else {
      if (lastClose >= bbUpper) bD += 1.0;
      else if (lastClose <= bbLower) bU += 1.0;
      else if (lastClose > bbMiddle) bU += 0.25;
      else if (lastClose < bbMiddle) bD += 0.25;
    }
    if (bbPercentB !== null) {
      if (trending !== true) {
        if (bbPercentB > 1.0) bD += 0.5;
        else if (bbPercentB < 0.0) bU += 0.5;
      } else {
        if (bbPercentB > 1.0 && ema5 > ema20) bU += 0.25;
        else if (bbPercentB < 0.0 && ema5 < ema20) bD += 0.25;
      }
    }
  }
  if (cci !== null) {
    if (trending === true) {
      if (cci > 150) bU += 0.5; else if (cci > 100) bU += 0.35;
      else if (cci < -150) bD += 0.5; else if (cci < -100) bD += 0.35;
    } else {
      if (cci > 150) bD += 0.5; else if (cci > 100) bD += 0.35;
      else if (cci < -150) bU += 0.5; else if (cci < -100) bU += 0.35;
      else if (cci > 50) bU += 0.15; else if (cci < -50) bD += 0.15;
    }
  }
  bU *= weights.bands;
  bD *= weights.bands;
  upScore += bU; downScore += bD;
  if (bU > bD && Math.abs(bU - bD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (bD > bU && Math.abs(bD - bU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.bands = { up: r2(bU), down: r2(bD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 6: ADX + DI ===
  var aU = 0;
  var aD = 0;
  var diCross = null;
  if (adxVal !== null && plusDI !== null && minusDI !== null) {
    if (plusDI > minusDI) aU += 0.75; else if (minusDI > plusDI) aD += 0.75;
    if (adxVal >= 25) {
      if (plusDI > minusDI) aU += 0.75; else aD += 0.75;
    }
    var adxLastTwo = safeLastTwo(indicators.adx.adx);
    if (adxLastTwo.last !== null && adxLastTwo.prev !== null) {
      if (adxLastTwo.last > adxLastTwo.prev && adxLastTwo.last >= 20) {
        if (plusDI > minusDI) aU += 0.5; else aD += 0.5;
      } else if (adxLastTwo.last < adxLastTwo.prev && adxLastTwo.last < 25) {
        aU *= 0.7;
        aD *= 0.7;
      }
    }
    diCross = detectDICrossover(indicators.adx);
    if (diCross) {
      if (diCross.direction === 'BUY') aU += diCross.strength;
      else if (diCross.direction === 'SELL') aD += diCross.strength;
    }
  }
  aU *= weights.adx;
  aD *= weights.adx;
  upScore += aU; downScore += aD;
  if (aU > aD && Math.abs(aU - aD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (aD > aU && Math.abs(aD - aU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.adx = { up: r2(aU), down: r2(aD), diCross: diCross ? diCross.type : 'NONE' };

  // === CAT 7: CANDLESTICK PATTERNS ===
  var pU = 0;
  var pD = 0;
  if (patterns && patterns.length > 0) {
    for (var pi = 0; pi < patterns.length; pi++) {
      var pat = patterns[pi];
      var adjustedStrength = pat.strength;
      if (trending === true) {
        var isContinuation =
          (pat.direction === 'BUY' && ema5 > ema20) ||
          (pat.direction === 'SELL' && ema5 < ema20);
        adjustedStrength *= isContinuation ? 1.3 : 0.6;
      }
      if (pat.direction === 'BUY') pU += adjustedStrength;
      else if (pat.direction === 'SELL') pD += adjustedStrength;
    }
  }
  var bodySize = Math.abs(lastCandle.close - lastCandle.open);
  var totalRange = (lastCandle.high - lastCandle.low) || 0.00001;
  if (bodySize / totalRange > 0.6) {
    if (lastCandle.close > lastCandle.open) pU += 0.5; else pD += 0.5;
  }
  pU = Math.min(pU, 3.0);
  pD = Math.min(pD, 3.0);
  pU *= weights.patterns;
  pD *= weights.patterns;
  upScore += pU; downScore += pD;
  if (pU > pD && Math.abs(pU - pD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pD > pU && Math.abs(pD - pU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.patterns = {
    up: r2(pU), down: r2(pD),
    detected: patterns ? patterns.map(function (p) { return p.name; }) : []
  };

  // === CAT 8: DIVERGENCE ===
  var dvU = 0;
  var dvD = 0;
  var rDiv = detectRSIDivergence(candles, indicators.rsi);
  var mDiv = detectMACDDivergence(candles, indicators.macd.histogram);

  if (rDiv) {
    var rStr = rDiv.confirmed ? rDiv.strength : rDiv.strength * 0.5;
    if (rDiv.direction === 'BUY') dvU += rStr; else dvD += rStr;
  }
  if (mDiv) {
    var mStr = mDiv.confirmed ? mDiv.strength : mDiv.strength * 0.5;
    if (mDiv.direction === 'BUY') dvU += mStr; else dvD += mStr;
  }
  dvU = Math.min(dvU, 2.5);
  dvD = Math.min(dvD, 2.5);
  dvU *= weights.divergence;
  dvD *= weights.divergence;
  upScore += dvU; downScore += dvD;
  if (dvU > dvD && Math.abs(dvU - dvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (dvD > dvU && Math.abs(dvD - dvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.divergence = {
    up: r2(dvU), down: r2(dvD),
    rsi: rDiv ? rDiv.type : 'NONE',
    rsiConfirmed: rDiv ? rDiv.confirmed : false,
    macd: mDiv ? mDiv.type : 'NONE',
    macdConfirmed: mDiv ? mDiv.confirmed : false,
  };

  // === CAT 9: PIVOT POINTS ===
  var pvU = 0;
  var pvD = 0;
  if (pivots && pivots.pivot !== null) {
    if (lastClose > pivots.pivot) pvU += 0.5; else if (lastClose < pivots.pivot) pvD += 0.5;

    var proximityThreshold = atr !== null ? atr * 0.5 : lastClose * 0.002;

    if (pivots.s1 && Math.abs(lastClose - pivots.s1) < proximityThreshold) pvU += 0.75;
    if (pivots.s2 && Math.abs(lastClose - pivots.s2) < proximityThreshold) pvU += 1.0;
    if (pivots.r1 && Math.abs(lastClose - pivots.r1) < proximityThreshold) pvD += 0.75;
    if (pivots.r2 && Math.abs(lastClose - pivots.r2) < proximityThreshold) pvD += 1.0;

    if (pivots.r1 && pivots.pivot && lastClose > pivots.pivot && lastClose < pivots.r1) pvU += 0.25;
    if (pivots.s1 && pivots.pivot && lastClose < pivots.pivot && lastClose > pivots.s1) pvD += 0.25;
  }
  pvU = Math.min(pvU, 2.0);
  pvD = Math.min(pvD, 2.0);
  pvU *= weights.pivots;
  pvD *= weights.pivots;
  upScore += pvU; downScore += pvD;
  if (pvU > pvD && Math.abs(pvU - pvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pvD > pvU && Math.abs(pvD - pvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.pivots = { up: r2(pvU), down: r2(pvD) };

  // === CAT 10: VOLUME ===
  var vU = 0;
  var vD = 0;
  var hasReliableVolume = assetType === ASSET_TYPE.CRYPTO ||
    (candles.length >= 20 && candles.slice(-20).some(function (c) { return c.volume > 0; }));

  if (hasReliableVolume && candles.length >= 20) {
    var rv = candles.slice(-20).map(function (c) { return c.volume; });
    var av = rv.reduce(function (a, b) { return a + b; }, 0) / rv.length;

    if (av > 0 && lastCandle.volume > av * 1.5) {
      if (lastCandle.close > lastCandle.open) vU += 0.75;
      else if (lastCandle.close < lastCandle.open) vD += 0.75;
    }

    if (candles.length >= 5) {
      var lv = candles.slice(-5).map(function (c) { return c.volume; });
      var avgRecent = (lv[3] + lv[4]) / 2;
      var avgOlder = (lv[0] + lv[1]) / 2;
      if (avgOlder > 0 && avgRecent > avgOlder * 1.2) {
        if (lastCandle.close > candles[candles.length - 5].close) vU += 0.25;
        else vD += 0.25;
      }
    }

    if (patterns && patterns.length > 0 && av > 0 && lastCandle.volume > av * 1.3) {
      for (var vpi = 0; vpi < patterns.length; vpi++) {
        if (patterns[vpi].direction === 'BUY') vU += 0.15;
        else if (patterns[vpi].direction === 'SELL') vD += 0.15;
      }
    }
  }

  vU *= weights.volume;
  vD *= weights.volume;
  upScore += vU; downScore += vD;
  if (vU > vD && Math.abs(vU - vD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (vD > vU && Math.abs(vD - vU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.volume = {
    up: r2(vU), down: r2(vD),
    reliable: hasReliableVolume,
    skipped: !hasReliableVolume ? 'No reliable volume data (forex)' : null,
  };

  // === VOLATILITY FILTER ===
  var volMult = 1.0;
  if (bbBandwidth !== null) {
    if (bbBandwidth < vt.bbFilterDead) volMult = 0.4;
    else if (bbBandwidth < vt.bbFilterLow) volMult = 0.6;
    else if (bbBandwidth < vt.bbFilterMed) volMult = 0.8;
  }
  upScore *= volMult;
  downScore *= volMult;

  // === HIGHER-TF PENALTY ===
  var htfPenalty = 1.0;
  if (higherTFTrend !== null) {
    var thisTFDir = upScore > downScore ? 'BUY' : downScore > upScore ? 'SELL' : null;
    if (thisTFDir !== null && thisTFDir !== higherTFTrend) {
      htfPenalty = 0.7;
      if (thisTFDir === 'BUY') upScore *= 0.7;
      else downScore *= 0.7;
    }
  }

  // === DECISION ===
  var scoreDiff = Math.abs(upScore - downScore);
  var confluence = Math.max(upCat, downCat);
  var direction;

  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) {
    direction = 'BUY';
  } else if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) {
    direction = 'SELL';
  } else if (scoreDiff >= 2.5 && confluence >= 2) {
    direction = upScore > downScore ? 'BUY' : 'SELL';
  } else {
    direction = 'NO_TRADE';
  }

  // === BUILD INDICATOR SUMMARY ===
  var emaAlignment = 'MIXED';
  if (ema10 !== null) {
    if (ema5 > ema10 && ema10 > ema20) emaAlignment = 'BULLISH';
    else if (ema5 < ema10 && ema10 < ema20) emaAlignment = 'BEARISH';
  }

  return {
    direction: direction,
    score: { up: r2(upScore), down: r2(downScore), diff: r2(scoreDiff) },
    confluence: confluence,
    confluenceDetail: { bullish: upCat, bearish: downCat, total: 10 },
    categoryScores: catScores,
    volatilityMultiplier: volMult,
    htfPenalty: htfPenalty < 1.0 ? 'COUNTER_TREND_PENALTY' : 'NONE',
    marketContext: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN',
    assetType: assetType,
    indicators: {
      ema5: fmt(ema5),
      ema10: fmt(ema10),
      ema20: fmt(ema20),
      sma50: fmt(sma50),
      emaAlignment: emaAlignment,
      rsi: fmt(rsi, 2),
      stochK: fmt(stochK, 2),
      stochD: fmt(stochD, 2),
      macdHist: fmt(macdHist, 6),
      macdLine: fmt(macdLine, 6),
      macdSignal: fmt(macdSignal, 6),
      adx: fmt(adxVal, 2),
      plusDI: fmt(plusDI, 2),
      minusDI: fmt(minusDI, 2),
      williamsR: fmt(williamsR, 2),
      cci: fmt(cci, 2),
      mfi: fmt(mfi, 2),
      atr: fmt(atr, 6),
      bbUpper: fmt(bbUpper),
      bbMiddle: fmt(bbMiddle),
      bbLower: fmt(bbLower),
      bbBandwidth: bbBandwidth !== null ? bbBandwidth.toFixed(4) + '%' : 'N/A',
      bbPercentB: fmt(bbPercentB, 4),
      pivot: pivots.pivot !== null ? pivots.pivot.toFixed(5) : 'N/A',
      r1: pivots.r1 !== null ? pivots.r1.toFixed(5) : 'N/A',
      r2val: pivots.r2 !== null ? pivots.r2.toFixed(5) : 'N/A',
      s1: pivots.s1 !== null ? pivots.s1.toFixed(5) : 'N/A',
      s2: pivots.s2 !== null ? pivots.s2.toFixed(5) : 'N/A',
      patterns: patterns ? patterns.map(function (p) { return p.name; }) : [],
    },
    timeframe: timeframe,
  };
}

/**
 * FTT Signal Worker v6.6.0 — Multi-Timeframe Binary Trading (Forex + Crypto)
 *
 * v6.3 additions:
 * 1. S/R level detection (swing high/low clustering) — CAT 11
 * 2. Fair Value Gap (FVG) detection + hard block on opposing FVG
 * 3. Parallel API fetching — all 3 timeframes fetched simultaneously
 *
 * v6.3.2 critical bug fixes:
 * 11. sanitizePair() — BTCUSD/ETHUSD (no-slash crypto) reject bug fixed
 * 12. detectFVG() — scanBack index calculation corrected (wrong candle triplet)
 * 13. FVG block TF priority — 1min first (was 5min → wrong TF for block decision)
 * 14. CAT 11 S/R strength normalized (0–1.0 range) — was inflating scores 3x
 *
 * v6.4.0 accuracy improvements:
 * A1. S/R nearThresh tightened: atr*1.0 → atr*0.5
 * A2. FVG hard block removed → confidence penalty (-20)
 * A3. HTF hard block conditioned on ADX>=25
 * A4. Confidence formula rebuilt: NO_TRADE TF weights in denominator
 * A5. Entry candle confirmation penalty
 * A6. MIN_CONFIDENCE_FLOOR: 65 → 62
 *
 * v6.5.0 — Cerebras AI validation layer
 * v6.5.1 — getApiKeys() JSON array support
 * v6.5.2 — FVG dead-market TF bug fix
 *
 * v6.6.0 — Market Regime System:
 * C1. detectMarketRegime() — 4 regimes: TRENDING / RANGING / BREAKOUT / VOLATILE
 * C2. getRegimeWeights()   — dynamic category weights per regime
 *     TRENDING  : trend↑, sr↓, oscillator normal
 *     RANGING   : sr↑↑, oscillator↑, trend↓ — S/R bounce is primary signal
 *     BREAKOUT  : bands↑↑, volume↑, trend↑, sr↓
 *     VOLATILE  : all weights×0.7 — unstable, penalize everything
 * C3. Regime passed into analyzeTimeframe → weights applied per TF
 * C4. Alignment bonus regime-aware: RANGING/VOLATILE → +5 max (was +15)
 * C5. Confidence hard cap: 99% → 92% (realistic upper bound)
 * C6. AI concerns → boost removed + extra -5 penalty
 * C7. marketRegime + regimeAdvice added to signal response
 *
 * v6.6.1 — 20-candle context for Cerebras AI:
 *
 * v6.7.0 — OTC Hybrid Layer (Olymp Trade):
 * O1. Full OTC pair support: EURUSD-OTC / EUR/USD-OTC / EURUSDOTC
 * O2. OTC-specific category weights (price action primary)
 * O3. 5 OTC patterns: ConsecCandles / WickRejection / RoundNumber / SizeAnomaly / TimeContext
 * O4. HTF block disabled for OTC (synthetic price does not trend)
 * O5. OTC Cerebras prompt — mean reversion focused
 * O6. 24/7 trading — no market hours restriction
 * O7. OTC confidence cap 88%, floor 60%
 *
 * v6.8.0 — Phase 1 Enhancements:
 * P1. Candle Quality Filter — body/wick ratio weights TF vote strength
 *     Strong body ×1.15, Doji ×0.75, wick-heavy ×0.82 (skips dead-market TFs)
 * P2. Session-specific Weights — pair currency × active session multiplier
 *     EUR/GBP best in London, JPY best in Asian, CAD/USD best in NY
 * P3. Correlation Filter — batch detects positive/negative correlation conflicts
 * P4. Dual AI Validation — Cerebras + Groq run in parallel
 *     Both agree + no concerns → +8 boost | Both agree + concerns → -5
 *     Disagree → combined NO_TRADE + -10 penalty
 * P5. Camarilla Pivot Points — H1-H4 / L1-L4 levels
 *     Applied after volMult×srPenalty (market-quality aware)
 *     OTC weight 1.5 (broker respects round number levels)
 *
 * v6.9.0 — Phase 2: Signal History & Win/Loss Tracking:
 * H1. saveSignalToHistory() — KV store e signal automatically save
 * H2. scheduledTracker() — Cron job: expired signal fetch + win/loss record
 * H3. Dynamic confidence per pair — last 20 signal win rate e adjust
 * H4. /api/history?pair=EUR/USD — stored signal history endpoint
 * H5. /api/stats — pair/session/TF wise win rate stats
 * H6. /api/report — manual OTC win/loss report endpoint
 * H7. wrangler.toml cron: "* * * * *" (every minute)
 *
 * Bug fixes in v6.8.0:
 * F1. checkNewsBlackout — OTC pairs now correctly bypass news blackout
 * F2. Camarilla score — now applied after volMult×srPenalty (was before)
 * F3. analyzeTimeframeOTC — camarilla included in reweight loop
 * F4. Candle Quality — dead-market TFs skipped (1min dead → use 5min/15min)
 * D1. buildIndicatorSnapshot() now includes 20 compact candles per TF (1min/5min/15min)
 * D2. Compact format: U/B:O/H/L/C — token efficient (~525 extra tokens, ~975 signals/day)
 * D3. Price structure summary per TF: HH-HL / LH-LL / Consolidation / Expanding
 * D4. AI now sees recent price action + structure, not just calculated indicators
 */

// ============================================
// CONFIG
// ============================================

const CONFIG = {
  API_BASE_URL: 'https://api.twelvedata.com',
  REFRESH_INTERVAL: 60000,
  REQUEST_TIMEOUT: 12000,
  MAX_RETRIES: 3,

  MIN_CONFLUENCE: 5,
  MIN_CATEGORY_SCORE: 0.3,

  // [v6.4] Confidence floor — below this → NO_TRADE (lowered from 65 → 62)
  MIN_CONFIDENCE_FLOOR: 62,

  // [v6.2] Volume spike filter — ratio above this triggers anomaly check
  VOLUME_SPIKE_FILTER_MULTIPLIER: 3.5,

  // [v6.2] News blackout margin in minutes either side of known event windows
  NEWS_BLACKOUT_MINUTES: 15,

  // [v6.2] Max pairs for batch endpoint
  BATCH_MAX_PAIRS: 3,

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
    sr: 1.4,
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


// ============================================
// OTC CONFIG (v6.7.0)
// ============================================

const ASSET_TYPE_OTC = 'FOREX_OTC';

const OTC_SUFFIXES = ['-OTC', 'OTC'];

const OTC_SUPPORTED_BASE_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD',
  'EUR/GBP', 'EUR/JPY', 'EUR/CHF', 'EUR/AUD', 'EUR/CAD', 'EUR/NZD',
  'GBP/JPY', 'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD',
  'AUD/JPY', 'AUD/CHF', 'AUD/CAD', 'AUD/NZD',
  'NZD/JPY', 'NZD/CHF', 'NZD/CAD',
  'CAD/JPY', 'CAD/CHF', 'CHF/JPY',
  'USD/SEK', 'USD/NOK', 'USD/DKK', 'USD/SGD', 'USD/HKD',
  'USD/TRY', 'USD/ZAR', 'USD/MXN',
  'EUR/SEK', 'EUR/NOK', 'EUR/PLN', 'EUR/TRY',
];

const OTC_CATEGORY_WEIGHTS = {
  trend:      0.4,   // EMA trend — OTC ignores macro trend
  momentum:   2.2,   // RSI/Williams/CCI — mean reversion core
  macd:       0.5,   // Lagging — weak in OTC
  stochastic: 2.0,   // Extreme bounce — very reliable OTC
  bands:      1.8,   // BB touch/rejection — OTC respects bands
  adx:        0.3,   // Trend strength — irrelevant OTC
  patterns:   2.5,   // Price action — PRIMARY signal
  divergence: 1.8,   // Reversal divergence — useful
  pivots:     1.2,   // S/R bounce — broker respects levels
  volume:     0.0,   // Skip — meaningless OTC
  sr:         2.0,   // Swing S/R — core OTC signal
  camarilla:  1.5,   // Round number levels — broker uses these
};

const OTC_SCORE_THRESHOLD = 2.2;
const OTC_MIN_CONFLUENCE  = 4;
const OTC_CONFIDENCE_FLOOR = 60;
const OTC_CONFIDENCE_CAP   = 88;
const OTC_EXOTIC_PENALTY   = 15;

const OTC_DURATION_CONFIG = {
  '1min':  { base: 2, min: 2, max: 3 },
  '5min':  { base: 2, min: 2, max: 2 },
  '15min': { base: 1, min: 1, max: 2 },
};

// ============================================
// [v6.9.0] PHASE 2 — HISTORY & TRACKING CONSTANTS
// ============================================

const HISTORY_CONFIG = {
  MAX_SIGNALS_PER_PAIR: 50,      // KV তে per pair কতটা signal রাখব
  WIN_RATE_LOOKBACK:    20,       // Dynamic confidence এ কতটা signal দেখব
  RESULT_CHECK_DELAY:   90,       // Signal expiry এর কত সেকেন্ড পরে result check করব
  CONFIDENCE_BONUS_THRESHOLD: 0.65,  // Win rate এর উপরে → bonus
  CONFIDENCE_PENALTY_THRESHOLD: 0.45, // Win rate এর নিচে → penalty
  CONFIDENCE_BONUS:    6,         // Max bonus points
  CONFIDENCE_PENALTY: -10,        // Max penalty points
  KV_SIGNAL_PREFIX:   'sig:',     // Signal KV key prefix
  KV_STATS_PREFIX:    'stats:',   // Stats KV key prefix
  KV_PENDING_PREFIX:  'pending:', // Pending result check prefix
};

// ============================================
// [v6.8.0] PHASE 1 — CONSTANTS
// ============================================

// P2: Session-specific pair weights
// Pair currency → best session → weight boost map
const SESSION_PAIR_WEIGHTS = {
  EUR: { LONDON: 1.3, LONDON_NY: 1.4, NEW_YORK: 1.1, ASIAN: 0.8, SYDNEY: 0.7 },
  GBP: { LONDON: 1.4, LONDON_NY: 1.3, NEW_YORK: 1.1, ASIAN: 0.7, SYDNEY: 0.7 },
  JPY: { ASIAN: 1.4, ASIAN_LONDON: 1.3, LONDON: 1.1, NEW_YORK: 0.9, SYDNEY: 1.2 },
  AUD: { SYDNEY: 1.3, ASIAN: 1.2, ASIAN_LONDON: 1.1, LONDON: 0.9, NEW_YORK: 0.8 },
  NZD: { SYDNEY: 1.3, ASIAN: 1.2, ASIAN_LONDON: 1.1, LONDON: 0.9, NEW_YORK: 0.8 },
  CAD: { NEW_YORK: 1.3, LONDON_NY: 1.4, LONDON: 1.0, ASIAN: 0.8, SYDNEY: 0.7 },
  CHF: { LONDON: 1.2, LONDON_NY: 1.3, NEW_YORK: 1.0, ASIAN: 0.8, SYDNEY: 0.7 },
  USD: { LONDON_NY: 1.4, NEW_YORK: 1.3, LONDON: 1.1, ASIAN: 0.8, SYDNEY: 0.7 },
};

// P3: Correlation groups — pairs that move together
const CORRELATION_GROUPS = [
  ['EUR/USD', 'GBP/USD', 'AUD/USD', 'NZD/USD'],   // USD quote — positive correlation
  ['USD/JPY', 'USD/CHF', 'USD/CAD'],               // USD base — positive correlation
  ['EUR/USD', 'USD/CHF'],                           // EUR/USD vs USD/CHF — negative correlation
  ['GBP/USD', 'EUR/GBP'],                          // GBP pairs
  ['AUD/USD', 'NZD/USD', 'AUD/NZD'],               // Commodity currencies
];

// Negative correlation pairs — opposite directions expected
const NEGATIVE_CORRELATIONS = [
  ['EUR/USD', 'USD/CHF'],
  ['GBP/USD', 'USD/JPY'],
  ['AUD/USD', 'USD/CAD'],
];

// ============================================
// [v6.2] HIGH-IMPACT NEWS WINDOWS (UTC recurring schedule)
// Blocks signal generation ±NEWS_BLACKOUT_MINUTES around these windows.
// Based on known recurring high-impact releases.
// ============================================

const HIGH_IMPACT_NEWS_WINDOWS = [
  // US major data (NFP, CPI, Retail Sales, PPI): Mon–Fri 12:15–13:30 UTC
  { days: [1, 2, 3, 4, 5], startHour: 12, startMin: 15, endHour: 13, endMin: 30, label: 'US Economic Data Window' },
  // Fed / ECB / BOE decisions & press conf: Tue–Thu 17:45–19:30 UTC
  { days: [2, 3, 4], startHour: 17, startMin: 45, endHour: 19, endMin: 30, label: 'Central Bank Decision Window' },
  // ECB / BOE rate decisions: Thu 11:45–12:30 UTC
  { days: [4], startHour: 11, startMin: 45, endHour: 12, endMin: 30, label: 'ECB/BOE Rate Window' },
  // Asian market open volatility window: Mon 21:45–22:30 UTC
  { days: [0, 1], startHour: 21, startMin: 45, endHour: 22, endMin: 30, label: 'Week Open Spike Window' },
];

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
    '1min':  { base: 2, min: 1, max: 5 },
    '5min':  { base: 2, min: 1, max: 4 },
    '15min': { base: 1, min: 1, max: 2 },
  },
  CRYPTO: {
    '1min':  { base: 2, min: 1, max: 4 },
    '5min':  { base: 2, min: 1, max: 3 },
    '15min': { base: 1, min: 1, max: 2 },
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
  // [v6.9.0] Cron trigger — runs every minute to check expired signals
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTracker(env));
  },

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

      if (path === '/api/signal' || path === '/signal' || path === '/api/batch') {
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
      } else if (path === '/api/batch') {
        // [v6.2] Multi-pair batch endpoint
        response = await handleBatch(url, env, ctx);
      } else if (path === '/api/pairs') {
        response = handlePairs();
      } else if (path === '/api/history') {
        // [v6.9.0] Signal history endpoint
        response = await handleHistory(url, env);
      } else if (path === '/api/stats') {
        // [v6.9.0] Win rate stats endpoint
        response = await handleStats(url, env);
      } else if (path === '/api/report') {
        // [v6.9.0] Manual OTC win/loss report
        response = await handleReport(url, env);
      } else {
        response = jsonResponse({
          status: 'ok',
          message: 'FTT Signal Worker v6.9.0 — Forex + Crypto + OTC + History Tracking',
          endpoints: {
            health:    '/',
            signal:    '/api/signal?pair=EUR/USD',
            signalOTC: '/api/signal?pair=EURUSD-OTC',
            crypto:    '/api/signal?pair=BTC/USD',
            batch:     '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD',
            pairs:     '/api/pairs',
            history:   '/api/history?pair=EUR/USD&limit=20',
            stats:     '/api/stats?pair=EUR/USD',
            report:    '/api/report?id=SIGNAL_ID&result=WIN',
          },
          supportedAssets: ['FOREX (40+ currencies)', 'CRYPTO (Top 10)', 'OTC (Olymp Trade)'],
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

// OTC helpers
function isOTCInput(input) {
  if (!input || typeof input !== 'string') return false;
  const u = input.toUpperCase();
  return u.endsWith('-OTC') || u.endsWith('OTC');
}

function stripOTCSuffix(input) {
  if (!input) return input;
  let s = input.toUpperCase().trim();
  if (s.endsWith('-OTC')) return s.slice(0, -4);
  if (s.endsWith('OTC'))  return s.slice(0, -3);
  return s;
}

function getOTCBasePair(pair) {
  if (!pair) return pair;
  if (pair.endsWith('-OTC')) return pair.slice(0, -4);
  return pair;
}

function sanitizePair(input) {
  if (!input || typeof input !== 'string') return null;

  const otcFlag  = isOTCInput(input);
  const baseInput = otcFlag ? stripOTCSuffix(input) : input;
  const c = baseInput.replace(/[^A-Za-z/]/g, '').toUpperCase();

  // --- Slash format ---
  const slashPattern = /^[A-Z]{3,}\/[A-Z]{3,}$/;
  if (slashPattern.test(c)) {
    const parts = c.split('/');
    const b = parts[0]; const q = parts[1];
    if (!otcFlag && CRYPTO_BASES.includes(b) && (CRYPTO_QUOTES.includes(q) || VALID_FOREX_CURRENCIES.includes(q)) && b !== q) return c;
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q) {
      return otcFlag ? b + '/' + q + '-OTC' : c;
    }
    return null;
  }

  // --- No-slash crypto (only when not OTC) ---
  if (!otcFlag) {
    for (const base of CRYPTO_BASES) {
      if (c.startsWith(base) && c.length > base.length) {
        const quote = c.slice(base.length);
        if ((CRYPTO_QUOTES.includes(quote) || VALID_FOREX_CURRENCIES.includes(quote)) && base !== quote) return base + '/' + quote;
      }
    }
  }

  // --- Forex 6-char ---
  const noSlashPattern = /^[A-Z]{6}$/;
  if (noSlashPattern.test(c)) {
    const b = c.slice(0, 3); const q = c.slice(3, 6);
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q) {
      return otcFlag ? b + '/' + q + '-OTC' : b + '/' + q;
    }
  }

  return null;
}

function getAssetType(pair) {
  if (!pair || typeof pair !== 'string') return ASSET_TYPE.FOREX;
  if (pair.endsWith('-OTC')) return ASSET_TYPE_OTC;
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
// [v6.2] NEWS BLACKOUT DETECTION
// Returns null if safe, or { label, minutesUntilClear } if blocked
// Only applies to FOREX — crypto trades 24/7 with no scheduled events
// ============================================

function checkNewsBlackout(assetType) {
  // OTC and Crypto trade 24/7 — no news blackout applies
  if (assetType === ASSET_TYPE.CRYPTO) return null;
  if (assetType === ASSET_TYPE_OTC)    return null;

  const now = new Date();
  const day = now.getUTCDay();       // 0=Sun, 1=Mon … 6=Sat
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const nowTotalMin = hour * 60 + minute;
  const margin = CONFIG.NEWS_BLACKOUT_MINUTES;

  for (const win of HIGH_IMPACT_NEWS_WINDOWS) {
    if (!win.days.includes(day)) continue;

    const winStart = Math.max(0, win.startHour * 60 + win.startMin - margin);
    const winEnd   = Math.min(1439, win.endHour * 60 + win.endMin + margin);

    if (nowTotalMin >= winStart && nowTotalMin <= winEnd) {
      const clearMin = winEnd - nowTotalMin;
      return {
        blocked: true,
        label: win.label,
        minutesUntilClear: clearMin,
        message: 'Signal blocked: ' + win.label + '. Clears in ~' + clearMin + ' min.',
      };
    }
  }
  return null;
}

// ============================================
// [v6.2] VOLUME SPIKE ANOMALY FILTER
// Detects abnormal volume spike without strong candle body (stop hunt / news spike)
// Only reliable for CRYPTO — skipped for FOREX
// ============================================

function isVolumeSpikeAnomaly(candles, assetType) {
  // Only meaningful for Crypto — Forex volume unreliable, OTC volume meaningless
  if (assetType !== ASSET_TYPE.CRYPTO) return false;
  if (!candles || candles.length < 21) return false;

  const lastCandle = candles[candles.length - 1];
  const sample = candles.slice(-21, -1);
  const avgVol = sample.reduce(function (a, c) { return a + c.volume; }, 0) / sample.length;

  if (avgVol <= 0) return false;

  const ratio = lastCandle.volume / avgVol;
  if (ratio > CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER) {
    const body  = Math.abs(lastCandle.close - lastCandle.open);
    const range = (lastCandle.high - lastCandle.low) || 0.00001;
    const bodyRatio = body / range;
    // Spike with weak body → anomalous (wick candle = stop hunt / liquidity grab)
    if (bodyRatio < 0.45) return true;
  }
  return false;
}

// ============================================
// [v6.2] RECENT CANDLE CONSISTENCY CHECK
// Checks if the last N candles are consistent with the proposed direction.
// Returns a multiplier: 1.0 (consistent) → 0.7 (inconsistent)
// ============================================

function recentCandleConsistency(candles, direction, lookback) {
  if (!lookback) lookback = 4;
  if (!candles || candles.length < lookback + 1 || direction === 'NO_TRADE') return 1.0;

  const recent = candles.slice(-lookback);
  let aligned = 0;
  for (var i = 0; i < recent.length; i++) {
    var c = recent[i];
    var bullish = c.close > c.open;
    if (direction === 'BUY' && bullish)  aligned++;
    if (direction === 'SELL' && !bullish) aligned++;
  }
  var ratio = aligned / lookback;
  if (ratio >= 0.75) return 1.0;
  if (ratio >= 0.5)  return 0.9;
  if (ratio >= 0.25) return 0.8;
  return 0.7;
}

// ============================================
// [v6.2] ENTRY REASON SUMMARY — plain text
// ============================================

function generateEntryReason(direction, catScores, indicatorSummary, alignment, higherTFTrend, marketContext) {
  if (direction === 'NO_TRADE') return 'No clear setup — entry conditions not met.';

  var reasons = [];

  // Trend
  if (catScores.trend) {
    var tS = direction === 'BUY' ? catScores.trend.up : catScores.trend.down;
    if (tS >= 3.0) reasons.push('Strong EMA stack aligned ' + direction);
    else if (tS >= 1.5) reasons.push('EMA trend favors ' + direction);
  }

  // RSI
  var rsiVal = parseFloat(indicatorSummary.rsi);
  if (!isNaN(rsiVal)) {
    if (direction === 'BUY' && rsiVal <= 30) reasons.push('RSI oversold (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'BUY' && rsiVal >= 55 && rsiVal < 70) reasons.push('RSI bullish momentum (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal >= 70) reasons.push('RSI overbought (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal <= 45 && rsiVal > 30) reasons.push('RSI bearish momentum (' + rsiVal.toFixed(0) + ')');
  }

  // MACD
  if (catScores.macd) {
    var mS = direction === 'BUY' ? catScores.macd.up : catScores.macd.down;
    if (mS >= 1.5) reasons.push(direction === 'BUY' ? 'MACD bullish crossover/expansion' : 'MACD bearish crossover/expansion');
  }

  // ADX
  if (catScores.adx) {
    var aS = direction === 'BUY' ? catScores.adx.up : catScores.adx.down;
    if (aS >= 1.5) {
      var adxNum = parseFloat(indicatorSummary.adx);
      if (!isNaN(adxNum) && adxNum >= 25) reasons.push('ADX trending (' + adxNum.toFixed(0) + ') with DI support');
      if (catScores.adx.diCross && catScores.adx.diCross !== 'NONE') reasons.push('DI crossover: ' + catScores.adx.diCross);
    }
  }

  // Stochastic
  if (catScores.stochastic) {
    var stS = direction === 'BUY' ? catScores.stochastic.up : catScores.stochastic.down;
    if (stS >= 0.8) reasons.push('Stochastic confirms ' + direction);
  }

  // Patterns
  if (catScores.patterns && catScores.patterns.detected && catScores.patterns.detected.length > 0) {
    var pats = catScores.patterns.detected.filter(function (p) { return p !== 'DOJI'; });
    if (pats.length > 0) reasons.push('Pattern: ' + pats.join(', '));
  }

  // Divergence
  if (catScores.divergence) {
    if (catScores.divergence.rsi !== 'NONE') {
      reasons.push('RSI divergence' + (catScores.divergence.rsiConfirmed ? ' (confirmed)' : ' (unconfirmed)'));
    }
    if (catScores.divergence.macd !== 'NONE') {
      reasons.push('MACD divergence' + (catScores.divergence.macdConfirmed ? ' (confirmed)' : ' (unconfirmed)'));
    }
  }

  // Higher TF alignment
  if (higherTFTrend && higherTFTrend === direction) reasons.push('15min HTF trend aligned');

  // Overall alignment
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') {
    reasons.push('All timeframes agree');
  } else if (alignment === 'MOSTLY_BULLISH' || alignment === 'MOSTLY_BEARISH') {
    reasons.push('Majority timeframes agree');
  }

  // Market context
  if (marketContext === 'TRENDING') reasons.push('Trending market');
  else if (marketContext === 'RANGING') reasons.push('Range-bound market');

  if (reasons.length === 0) return direction + ' signal from weighted indicator confluence.';
  return reasons.join(' · ');
}

// ============================================
// [v6.2] CANDLE COUNTDOWN
// Returns seconds until the current candle closes + next candle close ISO string
// ============================================

function getCandleCountdown(candleMinutes) {
  var now = Date.now();
  var ms = candleMinutes * 60000;
  var nextCloseMs = Math.ceil(now / ms) * ms;
  var secondsLeft = Math.max(0, Math.round((nextCloseMs - now) / 1000));
  return {
    secondsLeft: secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    label: secondsLeft >= 60
      ? Math.floor(secondsLeft / 60) + 'm ' + (secondsLeft % 60) + 's'
      : secondsLeft + 's',
    nextCandleClose: new Date(nextCloseMs).toISOString(),
  };
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

// ============================================
// [v6.2] BATCH HANDLER
// /api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD
// Runs up to BATCH_MAX_PAIRS in parallel
// ============================================

async function handleBatch(url, env, ctx) {
  const rawPairs = url.searchParams.get('pairs') || '';
  const pairList = rawPairs
    .split(',')
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0 });

  if (pairList.length === 0) {
    return jsonResponse({
      error: true,
      message: 'No pairs provided. Use ?pairs=EUR/USD,GBP/JPY,BTC/USD',
      example: '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD',
    }, 400);
  }

  const validPairs = [];
  const invalidPairs = [];
  for (var i = 0; i < pairList.length; i++) {
    var clean = sanitizePair(pairList[i]);
    if (clean) validPairs.push(clean);
    else invalidPairs.push(pairList[i]);
  }

  const capped = validPairs.slice(0, CONFIG.BATCH_MAX_PAIRS);

  // Run all signals in parallel
  const promises = capped.map(function (pair) {
    return handleSignalRaw(pair, env, ctx).then(function (signal) {
      return { pair: pair, signal: signal };
    }).catch(function (e) {
      return { pair: pair, error: e.message };
    });
  });

  const results = await Promise.all(promises);

  const summary = {};
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    summary[r.pair] = r.signal || { error: r.error };
  }

  // [v6.8.0] P3: Correlation analysis across batch results
  var pairDirections = {};
  for (var cr = 0; cr < results.length; cr++) {
    var rr = results[cr];
    if (rr.signal && rr.signal.signal) {
      pairDirections[rr.pair] = rr.signal.signal.finalSignal || 'NO_TRADE';
    }
  }
  var correlationAnalysis = detectCorrelationConflicts(pairDirections);

  return jsonResponse({
    batch: true,
    requestedPairs: pairList.length,
    processedPairs: capped.length,
    cappedAt: CONFIG.BATCH_MAX_PAIRS,
    invalidPairs: invalidPairs,
    skippedPairs: validPairs.slice(CONFIG.BATCH_MAX_PAIRS),
    correlationAnalysis: correlationAnalysis,
    results: summary,
    timestamp: new Date().toISOString(),
  });
}

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
// ============================================

function getApiKeys(env) {
  // JSON array থেকে keys নাও — TWELVEDATA_API_KEYS বা TWELVEDATA_API_KEY দুটোই চেক করো
  const jsonSources = [env.TWELVEDATA_API_KEYS, env.TWELVEDATA_API_KEY];
  for (const src of jsonSources) {
    if (src && typeof src === 'string' && src.trim().startsWith('[')) {
      try {
        const keys = JSON.parse(src);
        if (Array.isArray(keys) && keys.length > 0) {
          const filtered = keys.map(k => k.trim()).filter(k => k.length > 0);
          if (filtered.length > 0) return filtered;
        }
      } catch (e) {
        console.warn('API key JSON parse error:', e.message);
      }
    }
  }
  // Fallback: আলাদা variable format TWELVEDATA_API_KEY_1 … _10
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = env['TWELVEDATA_API_KEY_' + i];
    if (k && typeof k === 'string' && k.trim().length > 0) keys.push(k.trim());
  }
  // Single plain key
  if (keys.length === 0 && env.TWELVEDATA_API_KEY && !env.TWELVEDATA_API_KEY.trim().startsWith('[')) {
    keys.push(env.TWELVEDATA_API_KEY.trim());
  }
  return keys;
}

// ============================================
// KV CACHING
// ============================================

async function fetchCandlesWithCache(pair, tf, limit, env, ctx, assetType) {
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

  const result = await fetchCandles(pair, tf, limit, env, assetType);
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

async function fetchCandles(pair, tf, limit, env, assetType) {
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
            volume: assetType === ASSET_TYPE.CRYPTO ? parseFloat(c.volume || 0) : 0,
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
    if (rawK[i] !== null) { validRawK.push(rawK[i]); validIdxK.push(i); }
  }
  const smoothedK = calculateSMA(validRawK, sK);
  const k = new Array(rawK.length).fill(null);
  for (let i = 0; i < smoothedK.length; i++) {
    if (smoothedK[i] !== null) k[validIdxK[i]] = smoothedK[i];
  }

  const validK = [];
  const validIdxD = [];
  for (let i = 0; i < k.length; i++) {
    if (k[i] !== null) { validK.push(k[i]); validIdxD.push(i); }
  }
  const smoothedD = calculateSMA(validK, sD);
  const d = new Array(k.length).fill(null);
  for (let i = 0; i < smoothedD.length; i++) {
    if (smoothedD[i] !== null) d[validIdxD[i]] = smoothedD[i];
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

  const pDM = [0]; const mDM = [0]; const tr = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const h = candles[i].high; const l = candles[i].low; const pc = candles[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  function ws(arr, p) {
    const r = new Array(arr.length).fill(null);
    let s = 0;
    for (let i = 1; i <= p; i++) s += arr[i];
    r[p] = s;
    for (let i = p + 1; i < arr.length; i++) r[i] = r[i - 1] - r[i - 1] / p + arr[i];
    return r;
  }

  const sTR = ws(tr, period); const sPDM = ws(pDM, period); const sMDM = ws(mDM, period);
  const plusDI = new Array(n).fill(null); const minusDI = new Array(n).fill(null); const dx = new Array(n).fill(null);

  for (let i = period; i < n; i++) {
    if (sTR[i] && sTR[i] > 0) {
      plusDI[i]  = (sPDM[i] / sTR[i]) * 100;
      minusDI[i] = (sMDM[i] / sTR[i]) * 100;
      const ds = plusDI[i] + minusDI[i];
      dx[i] = ds > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / ds) * 100 : 0;
    }
  }

  const adx = new Array(n).fill(null);
  let adxS = 0; let adxC = 0; let adxI = -1;
  for (let i = period; i < n; i++) {
    if (dx[i] !== null) {
      adxS += dx[i]; adxC++;
      if (adxC === period) { adx[i] = adxS / period; adxI = i; break; }
    }
  }
  if (adxI > 0) {
    for (let i = adxI + 1; i < n; i++) {
      if (dx[i] !== null && adx[i - 1] !== null) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }

  return { adx: adx, plusDI: plusDI, minusDI: minusDI };
}

function calculateWilliamsR(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity; let lo = Infinity;
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
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
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
  if (!candles || candles.length < period + 1) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map(function (c) { return (c.high + c.low + c.close) / 3; });
  const mf = candles.map(function (c, i) { return tp[i] * c.volume; });
  const r = new Array(period).fill(null);
  for (let i = period; i < candles.length; i++) {
    let pos = 0; let neg = 0;
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
  let sh = -Infinity; let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (const c of sc) {
    if (c.high > sh) sh = c.high;
    if (c.low < sl) sl = c.low;
  }
  const p = (sh + sl + scl) / 3;
  const rng = sh - sl;
  return {
    pivot: p, r1: 2 * p - sl, r2: p + rng, r3: sh + 2 * (p - sl),
    s1: 2 * p - sh, s2: p - rng, s3: sl - 2 * (sh - p),
  };
}

// ============================================
// [v6.3] SUPPORT & RESISTANCE LEVELS
// Swing high/low detection with ATR clustering
// ============================================

function detectSRLevels(candles, atr) {
  if (!candles || candles.length < 10) return { supports: [], resistances: [] };
  const n = candles.length;
  const lookback = 3; // bars each side to confirm swing
  const clusterDist = atr !== null ? atr * 0.6 : candles[n - 1].close * 0.002;
  const lastClose = candles[n - 1].close;

  const rawHighs = [];
  const rawLows  = [];

  // Find swing highs and lows
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true; let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) rawHighs.push(candles[i].high);
    if (isLow)  rawLows.push(candles[i].low);
  }

  // Cluster nearby levels
  function cluster(levels) {
    if (!levels.length) return [];
    levels.sort(function (a, b) { return a - b; });
    const groups = [[levels[0]]];
    for (let i = 1; i < levels.length; i++) {
      const last = groups[groups.length - 1];
      const avg  = last.reduce(function (s, v) { return s + v; }, 0) / last.length;
      if (Math.abs(levels[i] - avg) <= clusterDist) last.push(levels[i]);
      else groups.push([levels[i]]);
    }
    return groups.map(function (g) {
      return {
        price: g.reduce(function (s, v) { return s + v; }, 0) / g.length,
        strength: g.length, // how many swing points cluster here
      };
    }).sort(function (a, b) { return b.strength - a.strength; }).slice(0, 5);
  }

  const resistances = cluster(rawHighs).filter(function (r) { return r.price > lastClose; });
  const supports    = cluster(rawLows).filter(function (s)  { return s.price < lastClose; });

  return { supports: supports, resistances: resistances, clusterDist: clusterDist };
}

// ============================================
// [v6.3] FAIR VALUE GAP (FVG) DETECTION
// 3-candle imbalance — price leaves a gap the market tends to fill
// Bullish FVG: candle[i].low > candle[i-2].high
// Bearish FVG: candle[i].high < candle[i-2].low
// ============================================

function detectFVG(candles) {
  if (!candles || candles.length < 3) return { bullish: [], bearish: [], active: null };
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  const scanBack  = Math.min(30, n - 1);
  const bullishFVGs = [];
  const bearishFVGs = [];

  // FIX: iterate from end backwards — i is index of 3rd candle in triplet
  // c0=candles[i-2], c1=candles[i-1] (impulse body), c2=candles[i]
  for (let i = n - 1; i >= 2 && i >= n - 1 - scanBack; i--) {
    const c0  = candles[i - 2];
    const c2  = candles[i];
    const age = n - 1 - i; // 0 = most recent

    // Bullish FVG: bottom of c2 is above top of c0 → upward gap
    if (c2.low > c0.high) {
      const top      = c2.low;
      const bottom   = c0.high;
      const midpoint = (top + bottom) / 2;
      const filled   = lastClose < bottom; // fully below gap = mitigated
      if (!filled) {
        bullishFVGs.push({ top, bottom, midpoint, age });
      }
    }

    // Bearish FVG: top of c2 is below bottom of c0 → downward gap
    if (c2.high < c0.low) {
      const top      = c0.low;
      const bottom   = c2.high;
      const midpoint = (top + bottom) / 2;
      const filled   = lastClose > top; // fully above gap = mitigated
      if (!filled) {
        bearishFVGs.push({ top, bottom, midpoint, age });
      }
    }
  }

  // Sort: most recent first (lowest age)
  bullishFVGs.sort((a, b) => a.age - b.age);
  bearishFVGs.sort((a, b) => a.age - b.age);

  // Determine if current price is INSIDE an active FVG
  var active = null;

  // Bullish FVG: demand imbalance — supports BUY
  for (var bi = 0; bi < bullishFVGs.length; bi++) {
    var bf = bullishFVGs[bi];
    if (lastClose >= bf.bottom && lastClose <= bf.top) {
      active = { type: 'BULLISH', fvg: bf };
      break;
    }
  }

  // Bearish FVG: supply imbalance — supports SELL
  if (!active) {
    for (var si = 0; si < bearishFVGs.length; si++) {
      var sf = bearishFVGs[si];
      if (lastClose >= sf.bottom && lastClose <= sf.top) {
        active = { type: 'BEARISH', fvg: sf };
        break;
      }
    }
  }

  // Nearest unmitigated FVGs (most recent = index 0 after sort)
  var nearestBullish = bullishFVGs.length ? bullishFVGs[0] : null;
  var nearestBearish = bearishFVGs.length ? bearishFVGs[0] : null;

  return {
    bullish: bullishFVGs,
    bearish: bearishFVGs,
    active: active,
    nearestBullish: nearestBullish,
    nearestBearish: nearestBearish,
  };
}

// ============================================
// CANDLESTICK PATTERNS
// ============================================

function detectCandlestickPatterns(candles) {
  const patterns = [];
  if (!candles || candles.length < 3) return patterns;
  const n = candles.length;
  const c0 = candles[n - 1]; const c1 = candles[n - 2]; const c2 = candles[n - 3];
  const b0 = c0.close - c0.open; const b1 = c1.close - c1.open; const b2 = c2.close - c2.open;
  const ab0 = Math.abs(b0); const ab1 = Math.abs(b1);
  const r0 = (c0.high - c0.low) || 0.00001; const r1 = (c1.high - c1.low) || 0.00001;
  const bp0 = ab0 / r0; const bp1 = ab1 / r1;
  const uw0 = c0.high - Math.max(c0.open, c0.close);
  const lw0 = Math.min(c0.open, c0.close) - c0.low;

  if (b1 < 0 && b0 > 0 && c0.open <= c1.close && c0.close >= c1.open && ab0 > ab1)
    patterns.push({ name: 'BULLISH_ENGULFING', direction: 'BUY', strength: 2.0 });
  if (b1 > 0 && b0 < 0 && c0.open >= c1.close && c0.close <= c1.open && ab0 > ab1)
    patterns.push({ name: 'BEARISH_ENGULFING', direction: 'SELL', strength: 2.0 });
  if (bp0 < 0.35 && lw0 > ab0 * 2 && uw0 < ab0 * 0.5)
    patterns.push({ name: 'HAMMER', direction: 'BUY', strength: 1.5 });
  if (bp0 < 0.35 && uw0 > ab0 * 2 && lw0 < ab0 * 0.5)
    patterns.push({ name: 'SHOOTING_STAR', direction: 'SELL', strength: 1.5 });
  if (bp0 < 0.1)
    patterns.push({ name: 'DOJI', direction: 'NEUTRAL', strength: 0.5 });
  if (lw0 > r0 * 0.6 && uw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: 'PIN_BAR_BULLISH', direction: 'BUY', strength: 1.8 });
  if (uw0 > r0 * 0.6 && lw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: 'PIN_BAR_BEARISH', direction: 'SELL', strength: 1.8 });

  const r2v = (c2.high - c2.low) || 0.00001;
  if (b2 < 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 > 0 && bp0 > 0.5 && c0.close > (c2.open + c2.close) / 2)
    patterns.push({ name: 'MORNING_STAR', direction: 'BUY', strength: 2.5 });
  if (b2 > 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 < 0 && bp0 > 0.5 && c0.close < (c2.open + c2.close) / 2)
    patterns.push({ name: 'EVENING_STAR', direction: 'SELL', strength: 2.5 });
  if (b2 > 0 && b1 > 0 && b0 > 0 && c1.close > c2.close && c0.close > c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: 'THREE_WHITE_SOLDIERS', direction: 'BUY', strength: 2.0 });
  if (b2 < 0 && b1 < 0 && b0 < 0 && c1.close < c2.close && c0.close < c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: 'THREE_BLACK_CROWS', direction: 'SELL', strength: 2.0 });

  return patterns;
}

// ============================================
// DIVERGENCE DETECTION
// ============================================

function detectRSIDivergence(candles, rsiVals, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !rsiVals || candles.length < lookback) return null;
  const n = candles.length; const st = n - lookback;
  const pL = []; const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (rsiVals[i] === null) continue;
    if (candles[i].low <= candles[i-1].low && candles[i].low <= candles[i-2].low &&
        candles[i].low <= candles[i+1].low && candles[i].low <= candles[i+2].low)
      pL.push({ idx: i, price: candles[i].low, rsi: rsiVals[i] });
    if (candles[i].high >= candles[i-1].high && candles[i].high >= candles[i-2].high &&
        candles[i].high >= candles[i+1].high && candles[i].high >= candles[i+2].high)
      pH.push({ idx: i, price: candles[i].high, rsi: rsiVals[i] });
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1]; const p = pL[pL.length - 2];
    if (r.price < p.price && r.rsi > p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close > lc.open;
      return { type: 'BULLISH_RSI_DIVERGENCE', direction: 'BUY', strength: confirmed ? 2.0 : 1.0, confirmed: confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1]; const p = pH[pH.length - 2];
    if (r.price > p.price && r.rsi < p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close < lc.open;
      return { type: 'BEARISH_RSI_DIVERGENCE', direction: 'SELL', strength: confirmed ? 2.0 : 1.0, confirmed: confirmed };
    }
  }
  return null;
}

function detectMACDDivergence(candles, hist, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !hist || candles.length < lookback) return null;
  const n = candles.length; const st = n - lookback;
  const pL = []; const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (hist[i] === null) continue;
    if (candles[i].low <= candles[i-1].low && candles[i].low <= candles[i+1].low)
      pL.push({ idx: i, price: candles[i].low, macd: hist[i] });
    if (candles[i].high >= candles[i-1].high && candles[i].high >= candles[i+1].high)
      pH.push({ idx: i, price: candles[i].high, macd: hist[i] });
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1]; const p = pL[pL.length - 2];
    if (r.price < p.price && r.macd > p.macd) {
      const confirmed = candles[n - 1].close > candles[n - 1].open;
      return { type: 'BULLISH_MACD_DIV', direction: 'BUY', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1]; const p = pH[pH.length - 2];
    if (r.price > p.price && r.macd < p.macd) {
      const confirmed = candles[n - 1].close < candles[n - 1].open;
      return { type: 'BEARISH_MACD_DIV', direction: 'SELL', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  return null;
}

// ============================================
// [v6.6.0] MARKET REGIME DETECTION
// 4 regimes: TRENDING / RANGING / BREAKOUT / VOLATILE
// ============================================

function detectMarketRegime(adxVal, bbBandwidth, atr, lastClose, assetType, prevBbBandwidth) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;

  // VOLATILE: ATR very high → unstable, unpredictable
  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct > vt.atrVeryHigh) return 'VOLATILE';
  }

  // BREAKOUT: BB was squeezed, now expanding fast
  if (bbBandwidth !== null && prevBbBandwidth !== null) {
    const expanding  = bbBandwidth > prevBbBandwidth * 1.25;
    const wasSqueezed = prevBbBandwidth < vt.bbSqueeze * 1.5;
    if (wasSqueezed && expanding) return 'BREAKOUT';
  }

  // TRENDING: ADX >= 25 → directional move
  if (adxVal !== null && adxVal >= 25) return 'TRENDING';

  // RANGING: ADX < 20 → oscillating market
  return 'RANGING';
}

// ============================================
// [v6.6.0] DYNAMIC WEIGHTS BY REGIME
// ============================================

function getRegimeWeights(regime) {
  if (regime === 'TRENDING') {
    return {
      trend: 2.4, momentum: 1.4, macd: 1.6, stochastic: 0.7,
      bands: 0.8, adx: 1.8, patterns: 1.2, divergence: 1.5,
      pivots: 0.6, volume: 0.7, sr: 0.8,
    };
  }
  if (regime === 'RANGING') {
    return {
      trend: 0.8, momentum: 1.8, macd: 0.8, stochastic: 1.8,
      bands: 1.4, adx: 0.8, patterns: 1.3, divergence: 1.8,
      pivots: 1.2, volume: 0.5, sr: 2.2,
    };
  }
  if (regime === 'BREAKOUT') {
    return {
      trend: 2.0, momentum: 1.2, macd: 1.4, stochastic: 0.6,
      bands: 2.0, adx: 1.6, patterns: 1.0, divergence: 0.8,
      pivots: 0.7, volume: 1.2, sr: 0.7,
    };
  }
  if (regime === 'VOLATILE') {
    return {
      trend: 1.2, momentum: 1.0, macd: 0.8, stochastic: 0.8,
      bands: 0.9, adx: 1.0, patterns: 0.8, divergence: 1.0,
      pivots: 0.6, volume: 0.4, sr: 1.0,
    };
  }
  // Default fallback = CONFIG base
  return {
    trend: 1.8, momentum: 1.4, macd: 1.2, stochastic: 1.0,
    bands: 1.0, adx: 1.3, patterns: 1.1, divergence: 1.5,
    pivots: 0.8, volume: 0.5, sr: 1.4,
  };
}

// ============================================
// [v6.6.0] REGIME ADVICE
// ============================================

function getRegimeAdvice(regime, direction) {
  if (regime === 'TRENDING')
    return direction === 'NO_TRADE'
      ? 'Trending — wait for pullback entry'
      : 'Trending — trade with trend, momentum expiry';
  if (regime === 'RANGING')
    return direction === 'NO_TRADE'
      ? 'Ranging — wait for S/R boundary'
      : 'Ranging — trade at S/R only, short expiry';
  if (regime === 'BREAKOUT')
    return direction === 'NO_TRADE'
      ? 'Breakout forming — wait for candle close'
      : 'Breakout — ride momentum, avoid counter-trades';
  if (regime === 'VOLATILE')
    return 'High volatility — reduce size or skip';
  return '';
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
  const lastPlusDI  = safeLastTwo(adxIndicator.plusDI);
  const lastMinusDI = safeLastTwo(adxIndicator.minusDI);
  if (lastPlusDI.last === null || lastPlusDI.prev === null ||
      lastMinusDI.last === null || lastMinusDI.prev === null) return null;

  if (lastPlusDI.prev <= lastMinusDI.prev && lastPlusDI.last > lastMinusDI.last)
    return { type: 'BULLISH_DI_CROSS', direction: 'BUY', strength: 1.5 };
  if (lastMinusDI.prev <= lastPlusDI.prev && lastMinusDI.last > lastPlusDI.last)
    return { type: 'BEARISH_DI_CROSS', direction: 'SELL', strength: 1.5 };
  return null;
}

// ============================================
// CALCULATE ALL INDICATORS
// ============================================

function calculateAllIndicators(candles) {
  const closes = candles.map(function (c) { return c.close; });
  const atrArr  = calculateATR(candles, CONFIG.ATR_PERIOD);
  const atrLast = atrArr[atrArr.length - 1] || null;
  return {
    ema5:       calculateEMA(closes, 5),
    ema10:      calculateEMA(closes, 10),
    ema20:      calculateEMA(closes, 20),
    sma50:      calculateSMA(closes, 50),
    rsi:        calculateRSI(closes, CONFIG.RSI_PERIOD),
    macd:       calculateMACD(closes),
    atr:        atrArr,
    bollinger:  calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV),
    stochastic: calculateStochastic(candles, CONFIG.STOCH_PERIOD, CONFIG.STOCH_SMOOTH_K, CONFIG.STOCH_SMOOTH_D),
    adx:        calculateADX(candles, CONFIG.ADX_PERIOD),
    williamsR:  calculateWilliamsR(candles, CONFIG.WILLIAMS_PERIOD),
    cci:        calculateCCI(candles, CONFIG.CCI_PERIOD),
    mfi:        calculateMFI(candles, CONFIG.MFI_PERIOD),
    pivots:     calculatePivotPoints(candles),
    camarilla:  calculateCamarillaPivots(candles),   // [v6.8.0] P5
    patterns:   detectCandlestickPatterns(candles),
    sr:         detectSRLevels(candles, atrLast),
    fvg:        detectFVG(candles),
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
  let last = null; let prev = null; let foundFirst = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
      if (!foundFirst) { last = arr[i]; foundFirst = true; }
      else { prev = arr[i]; break; }
    }
  }
  return { last: last, prev: prev };
}

function safeLastN(arr, n) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) result.unshift(arr[i]);
  }
  return result;
}

// ============================================
// HELPERS
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
// [v6.2] CANDLE DURATION — volatility regime + momentum aware
// ============================================

function calculateCandleDuration(indicators, direction, candles, timeframe, assetType) {
  const durCfg = DURATION_CONFIG[assetType] || DURATION_CONFIG.FOREX;
  const cfg = durCfg[timeframe] || { base: 3, min: 1, max: 10 };
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  let dur = cfg.base;

  const rsi = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr = safeLastValue(indicators.atr);
  const adxVal = safeLastValue(indicators.adx.adx);
  const bbBW = safeLastValue(indicators.bollinger.bandwidth);

  // RSI extremes → shorter hold (reversal risk)
  if (rsi !== null) {
    if (rsi > 82 || rsi < 18) dur -= 2;
    else if (rsi > 72 || rsi < 28) dur -= 1;
  }

  // Stochastic extremes → shorter hold
  if (stochK !== null) {
    if (stochK > 92 || stochK < 8) dur -= 1;
  }

  // ATR-based volatility regime
  if (atr !== null && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > 0) {
      const atrPct = (atr / lastClose) * 100;
      if (atrPct > vt.atrVeryHigh) dur -= 2;      // Very volatile → exit fast
      else if (atrPct > vt.atrHigh) dur -= 1;
      else if (atrPct < vt.atrDead) dur += 2;     // Dead → needs more time
      else if (atrPct < vt.atrLow) dur += 1;
    }
  }

  // ADX trend strength → strong trend allows holding longer
  if (adxVal !== null) {
    if (adxVal >= 40) dur += 1;
    else if (adxVal < 15) dur -= 1;
  }

  // [v6.2] Squeeze → candle about to expand, hold slightly longer
  if (bbBW !== null && bbBW < vt.bbSqueeze) dur += 1;

  // [v6.2] Strong pattern → 1 extra candle buffer
  if (indicators.patterns) {
    const strongNames = ['MORNING_STAR', 'EVENING_STAR', 'THREE_WHITE_SOLDIERS',
      'THREE_BLACK_CROWS', 'BULLISH_ENGULFING', 'BEARISH_ENGULFING'];
    const hasStrong = indicators.patterns.some(function (p) { return strongNames.indexOf(p.name) !== -1; });
    if (hasStrong) dur += 1;
  }

  // [v6.2] Momentum alignment: MACD + RSI both strongly aligned → hold 1 more
  if (rsi !== null && direction === 'BUY' && rsi >= 55 && rsi <= 68) dur += 1;
  if (rsi !== null && direction === 'SELL' && rsi <= 45 && rsi >= 32) dur += 1;

  // TF-specific caps
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
  if (sc >= 75) return { grade: 'A',  label: 'STRONG',    description: 'High probability with multiple confirmations.' };
  if (sc >= 60) return { grade: 'B',  label: 'GOOD',      description: 'Solid setup. Suitable for trading.' };
  if (sc >= 45) return { grade: 'C',  label: 'MODERATE',  description: 'Some conflicts. Trade with caution.' };
  if (sc >= 30) return { grade: 'D',  label: 'WEAK',      description: 'Low confidence. Consider skipping.' };
  return { grade: 'F', label: 'AVOID', description: 'Very weak. Do NOT trade.' };
}

// ============================================
// TIE RESOLUTION
// ============================================

function resolveTieWithTolerance(details) {
  let tU = 0; let tD = 0; let cU = 0; let cD = 0;
  const tfKeys = Object.keys(details);
  for (let i = 0; i < tfKeys.length; i++) {
    const tf = tfKeys[i]; const s = details[tf]; const w = CONFIG.TF_WEIGHTS[tf] || 1.0;
    tU += s.score.up * w;  tD += s.score.down * w;
    cU += ((s.confluenceDetail && s.confluenceDetail.bullish) || 0) * w;
    cD += ((s.confluenceDetail && s.confluenceDetail.bearish) || 0) * w;
  }
  const total = tU + tD;
  if (tU > tD && cU >= cD) return { direction: 'BUY',  confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU && cD >= cU) return { direction: 'SELL', confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  if (tU > tD) return { direction: 'BUY',  confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
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
    finalSignal: dir, confidence: '0%',
    grade: { grade: 'F', label: 'DUMMY', description: 'Fallback — no real data.' },
    marketCondition: ['UNKNOWN'], alignment: 'NONE', recommendations: {},
    bestTimeframe: { timeframe: 'N/A' },
    votes: { BUY: 0, SELL: 0, NO_TRADE: 0, total: 0 },
    timeframeAnalysis: {}, method: 'DUMMY_FALLBACK',
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
// [v6.5.0] CEREBRAS AI VALIDATION LAYER
// Sends full indicator snapshot to Cerebras llama3.1-8b.
// Returns independent BUY/SELL/NO_TRADE verdict.
// On any error/timeout → returns { status: 'UNAVAILABLE' }
// ============================================

async function callCerebrasValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };

  // Build a compact but information-rich prompt
  var prompt = [
    'You are an expert binary options trading analyst. Analyze the following technical indicator snapshot for ' + pair + ' (' + assetType + ').',
    '',
    '=== ENGINE SIGNAL ===',
    'Direction: ' + engineSignal.direction,
    'Confidence: ' + engineSignal.confidence,
    'Alignment: ' + engineSignal.alignment,
    'HTF Trend (15min): ' + engineSignal.higherTFTrend,
    'Market condition: ' + (engineSignal.marketCondition || []).join(', '),
    '',
    '=== INDICATOR SNAPSHOT (best timeframe: ' + engineSignal.bestTF + ') ===',
    'EMA alignment: ' + indicatorSnapshot.emaAlignment,
    'EMA5/10/20: ' + indicatorSnapshot.ema5 + ' / ' + indicatorSnapshot.ema10 + ' / ' + indicatorSnapshot.ema20,
    'RSI(14): ' + indicatorSnapshot.rsi,
    'MACD histogram: ' + indicatorSnapshot.macdHist,
    'ADX: ' + indicatorSnapshot.adx + '  (+DI ' + indicatorSnapshot.plusDI + '  -DI ' + indicatorSnapshot.minusDI + ')',
    'Stochastic K/D: ' + indicatorSnapshot.stochK + ' / ' + indicatorSnapshot.stochD,
    'Williams %R: ' + indicatorSnapshot.williamsR,
    'CCI: ' + indicatorSnapshot.cci,
    'BB %B: ' + indicatorSnapshot.bbPercentB + '  Bandwidth: ' + indicatorSnapshot.bbBandwidth,
    'ATR: ' + indicatorSnapshot.atr,
    'S/R context: ' + indicatorSnapshot.srContext,
    'FVG active: ' + indicatorSnapshot.fvgActive,
    'Candlestick patterns: ' + (indicatorSnapshot.patterns.length ? indicatorSnapshot.patterns.join(', ') : 'NONE'),
    'RSI divergence: ' + indicatorSnapshot.rsiDiv,
    'MACD divergence: ' + indicatorSnapshot.macdDiv,
    'Pivot: ' + indicatorSnapshot.pivot + '  R1: ' + indicatorSnapshot.r1 + '  S1: ' + indicatorSnapshot.s1,
    '',
    '=== PRICE STRUCTURE (last 20 candles) ===',
    '1min  structure: ' + indicatorSnapshot.structure1min,
    '5min  structure: ' + indicatorSnapshot.structure5min,
    '15min structure: ' + indicatorSnapshot.structure15min,
    '',
    '=== RAW CANDLES — compact format (U=bullish B=bearish O/H/L/C, newest last) ===',
    '1min  (20): ' + indicatorSnapshot.candles1min,
    '5min  (20): ' + indicatorSnapshot.candles5min,
    '15min (20): ' + indicatorSnapshot.candles15min,
    '',
    '=== YOUR TASK ===',
    'Based ONLY on these indicators, give your independent analysis.',
    'Consider: Are the indicators consistent? Any contradictions? Is this a high-probability setup?',
    'Respond in STRICT JSON only — no markdown, no extra text:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 8000); // 8s timeout

    var res;
    try {
      res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY,
        },
        body: JSON.stringify({
          model: 'llama3.1-8b',
          max_tokens: 120,
          temperature: 0.05, // near-deterministic for trading decisions
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      return { status: 'API_ERROR', httpStatus: res.status };
    }

    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content.trim()
      : null;

    if (!text) return { status: 'EMPTY_RESPONSE' };

    // Strip any accidental markdown fences
    text = text.replace(/```json|```/g, '').trim();

    // Find JSON object in response
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'PARSE_ERROR', raw: text.slice(0, 100) };

    var parsed = JSON.parse(jsonMatch[0]);

    // Validate fields
    var validSignals = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSignal = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!validSignals.includes(aiSignal)) aiSignal = 'NO_TRADE';
    var aiConf = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : 50;

    return {
      status: 'OK',
      signal: aiSignal,
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: 'cerebras/llama3.1-8b',
    };

  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

// ============================================
// [v6.5.0] BUILD INDICATOR SNAPSHOT for Cerebras
// Pulls best-TF indicators into a flat object
// ============================================

function buildIndicatorSnapshot(tfResults, candleData, finalDirection, bestTF) {
  var best = tfResults[bestTF] || tfResults['5min'] || tfResults['1min'] || tfResults['15min'];
  if (!best) return null;

  var ind = best.indicators || {};
  var catScores = best.categoryScores || {};

  // [v6.6.1] Build compact 20-candle string per TF
  // Format: "U/B:O/H/L/C" — U=bullish, B=bearish, prices 5 decimal
  function compactCandles(candles, count) {
    if (!candles || candles.length === 0) return 'N/A';
    var recent = candles.slice(-count);
    return recent.map(function(c) {
      var dir = c.close >= c.open ? 'U' : 'B';
      var o = c.open.toFixed(5);
      var h = c.high.toFixed(5);
      var l = c.low.toFixed(5);
      var cl = c.close.toFixed(5);
      return dir + ':' + o + '/' + h + '/' + l + '/' + cl;
    }).join(' ');
  }

  // [v6.6.1] Price structure from last 20 candles
  function priceStructure(candles) {
    if (!candles || candles.length < 6) return 'UNKNOWN';
    var recent = candles.slice(-20);
    var highs = recent.map(function(c) { return c.high; });
    var lows  = recent.map(function(c) { return c.low;  });
    var n = recent.length;
    // Compare first half vs second half
    var midH1 = Math.max.apply(null, highs.slice(0, Math.floor(n/2)));
    var midH2 = Math.max.apply(null, highs.slice(Math.floor(n/2)));
    var midL1 = Math.min.apply(null, lows.slice(0, Math.floor(n/2)));
    var midL2 = Math.min.apply(null, lows.slice(Math.floor(n/2)));
    var higherHigh = midH2 > midH1;
    var higherLow  = midL2 > midL1;
    var lowerHigh  = midH2 < midH1;
    var lowerLow   = midL2 < midL1;
    if (higherHigh && higherLow)  return 'HH-HL (Bullish structure)';
    if (lowerHigh  && lowerLow)   return 'LH-LL (Bearish structure)';
    if (higherHigh && lowerLow)   return 'Expanding (Volatile)';
    if (lowerHigh  && higherLow)  return 'Contracting (Consolidation)';
    return 'Mixed structure';
  }

  // [v6.6.1] Nearest S/R distance in pips
  function srDistance(catSc, atr) {
    var ctx = catSc.sr && catSc.sr.context ? catSc.sr.context : 'NO_LEVEL';
    if (!atr || atr === 'N/A') return ctx;
    return ctx;
  }

  var candles1  = candleData['1min']  || [];
  var candles5  = candleData['5min']  || [];
  var candles15 = candleData['15min'] || [];

  return {
    emaAlignment:  ind.emaAlignment  || 'UNKNOWN',
    ema5:          ind.ema5          || 'N/A',
    ema10:         ind.ema10         || 'N/A',
    ema20:         ind.ema20         || 'N/A',
    rsi:           ind.rsi           || 'N/A',
    macdHist:      ind.macdHist      || 'N/A',
    adx:           ind.adx           || 'N/A',
    plusDI:        ind.plusDI        || 'N/A',
    minusDI:       ind.minusDI       || 'N/A',
    stochK:        ind.stochK        || 'N/A',
    stochD:        ind.stochD        || 'N/A',
    williamsR:     ind.williamsR     || 'N/A',
    cci:           ind.cci           || 'N/A',
    bbPercentB:    ind.bbPercentB    || 'N/A',
    bbBandwidth:   ind.bbBandwidth   || 'N/A',
    atr:           ind.atr           || 'N/A',
    pivot:         ind.pivot         || 'N/A',
    r1:            ind.r1            || 'N/A',
    s1:            ind.s1            || 'N/A',
    srContext:     (catScores.sr && catScores.sr.context)             || 'NO_LEVEL',
    fvgActive:     (catScores.fvg && catScores.fvg.active)            || 'NONE',
    patterns:      (catScores.patterns && catScores.patterns.detected) || [],
    rsiDiv:        (catScores.divergence && catScores.divergence.rsi)  || 'NONE',
    macdDiv:       (catScores.divergence && catScores.divergence.macd) || 'NONE',
    // [v6.6.1] 20 candle compact + structure
    candles1min:   compactCandles(candles1,  20),
    candles5min:   compactCandles(candles5,  20),
    candles15min:  compactCandles(candles15, 20),
    structure1min:  priceStructure(candles1),
    structure5min:  priceStructure(candles5),
    structure15min: priceStructure(candles15),
  };
}

// ============================================
// BUILD MULTI-TIMEFRAME SIGNAL (v6.5.0)
// ============================================

async function buildMultiTimeframeSignal(candleData, pair, assetType, session, exotic, newsBlock, env) {
  const now = new Date();
  const tfResults = {};
  const votes = [];

  // Step 0: Higher-TF Trend from 15min
  let higherTFTrend = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfIndicators = calculateAllIndicators(candleData['15min']);
    const htfEma5   = safeLastValue(htfIndicators.ema5);
    const htfEma20  = safeLastValue(htfIndicators.ema20);
    const htfAdx    = htfIndicators.adx ? safeLastValue(htfIndicators.adx.adx)     : null;
    const htfPlusDI = htfIndicators.adx ? safeLastValue(htfIndicators.adx.plusDI)  : null;
    const htfMinusDI= htfIndicators.adx ? safeLastValue(htfIndicators.adx.minusDI) : null;

    if (htfEma5 !== null && htfEma20 !== null && htfAdx !== null && htfAdx >= 20) {
      if (htfEma5 > htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfPlusDI > htfMinusDI)
        higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfMinusDI > htfPlusDI)
        higherTFTrend = 'SELL';
    }
  }

  // [v6.6.0] Step 0b: Detect Market Regime from 15min candles
  // Regime determines dynamic weights for all TF analyses
  var marketRegime = 'RANGING'; // default
  if (candleData['15min'] && candleData['15min'].length >= 3) {
    var regimeCandles = candleData['15min'];
    var rInd = calculateAllIndicators(regimeCandles);
    var rAdx = safeLastValue(rInd.adx.adx);
    var rBbBW = safeLastValue(rInd.bollinger.bandwidth);
    var rBbBWPrev = null;
    var rBbBWArr = rInd.bollinger.bandwidth;
    // Get second-to-last valid bandwidth for breakout detection
    if (rBbBWArr) {
      var bwVals = [];
      for (var bi = rBbBWArr.length - 1; bi >= 0 && bwVals.length < 2; bi--) {
        if (rBbBWArr[bi] !== null && !isNaN(rBbBWArr[bi])) bwVals.push(rBbBWArr[bi]);
      }
      if (bwVals.length >= 2) rBbBWPrev = bwVals[1];
    }
    var rAtr = safeLastValue(rInd.atr);
    var rLastClose = regimeCandles[regimeCandles.length - 1].close;
    marketRegime = detectMarketRegime(rAdx, rBbBW, rAtr, rLastClose, assetType, rBbBWPrev);
  }

  // Step 1: Analyze each timeframe
  const tfKeys = Object.keys(candleData);
  for (let t = 0; t < tfKeys.length; t++) {
    const tf = tfKeys[t];
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;

    const indicators = calculateAllIndicators(candles);
    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend, marketRegime);

    const durationCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType);
    const candleMin = CANDLE_MINUTES[tf] || 1;
    const durationMinutes = durationCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durationMinutes * 60000);
    const nextCandleClose = getNextCandleClose(now, candleMin);

    // [v6.2] Candle countdown
    const countdown = getCandleCountdown(candleMin);

    analysis.expiry = {
      candles: durationCandles,
      candleSize: candleMin + 'min',
      totalMinutes: durationMinutes,
      expiryTime: expiryTime.toISOString(),
      humanReadable: formatDuration(durationMinutes),
      nextCandleClose: nextCandleClose.toISOString(),
      countdown: countdown,
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

  // [v6.8.0] P1+P2: Candle Quality + Session Weight multipliers
  var sessionMult = getSessionWeightMultiplier(pair, session);

  // P1: Skip dead market TFs for candle quality check — dead candles are misleadingly Doji-like
  var qualityCandles = [];
  if (candleData['1min']  && tfResults['1min']  && !tfResults['1min'].deadMarket)  qualityCandles = candleData['1min'];
  else if (candleData['5min']  && tfResults['5min']  && !tfResults['5min'].deadMarket)  qualityCandles = candleData['5min'];
  else if (candleData['15min'] && tfResults['15min'] && !tfResults['15min'].deadMarket) qualityCandles = candleData['15min'];
  else qualityCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];

  var candleQualityMult = getCandleQualityMultiplier(qualityCandles);

  // Step 2: Weighted Multi-TF Voting
  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0; let totalWeight = 0;
  const activeDirs = [];

  for (let v = 0; v < votes.length; v++) {
    const vote = votes[v];
    // [v6.8.0] Apply session + candle quality multipliers to TF weight
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * sessionMult * candleQualityMult;
    totalWeight += w;
    if (vote.direction === 'BUY')  { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else { weightedNoTrade += w; }
  }

  // Alignment — [v6.6.0] bonus reduced for RANGING/VOLATILE (misleading in those regimes)
  const allBuy  = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'BUY'; });
  const allSell = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'SELL'; });
  let alignment = 'MIXED'; let alignmentBonus = 0;

  // Base bonus by alignment type
  var fullBonus    = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 15 : 5;
  var partialBonus = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 7  : 3;

  if (allBuy)  { alignment = 'ALL_BULLISH'; alignmentBonus = fullBonus; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = fullBonus; }
  else if (!allBuy && !allSell && activeDirs.length >= 2) {
    const bc = activeDirs.filter(function (d) { return d === 'BUY'; }).length;
    const sc = activeDirs.filter(function (d) { return d === 'SELL'; }).length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = partialBonus; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = partialBonus; }
  }

  // Step 3: Decision
  let finalDirection;
  let confidence;
  const totalWeightedScore = weightedBuy + weightedSell;

  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    // [v6.4] NO_TRADE weight counts as partial resistance in denominator
    // Prevents 1-TF BUY + 2-TF NO_TRADE giving 100% confidence
    var buyDenom = weightedBuy + weightedSell + (weightedNoTrade * 0.6);
    confidence = buyDenom > 0 ? Math.round((weightedBuy / buyDenom) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    var sellDenom = weightedBuy + weightedSell + (weightedNoTrade * 0.6);
    confidence = sellDenom > 0 ? Math.round((weightedSell / sellDenom) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction; confidence = tie.confidence;
  }

  // [v6.4] HTF conflict — hard block ONLY if 15min trend is strong (ADX>=25)
  // Weak HTF trend = apply confidence penalty only, not full NO_TRADE
  if (higherTFTrend !== null && finalDirection !== 'NO_TRADE' && finalDirection !== higherTFTrend) {
    var htfResult15 = tfResults['15min'];
    var htfADXVal = htfResult15 && htfResult15.indicators ? parseFloat(htfResult15.indicators.adx) : null;
    if (htfADXVal !== null && !isNaN(htfADXVal) && htfADXVal >= 25) {
      // Strong HTF trend — hard block counter-signals
      finalDirection = 'NO_TRADE'; confidence = 0;
    } else {
      // Weak/uncertain HTF trend — just penalize confidence
      confidence = Math.max(0, confidence - 18);
    }
  } else if (higherTFTrend !== null && finalDirection === higherTFTrend) {
    confidence = Math.min(92, confidence + 5);
  }

  confidence = Math.min(92, confidence + alignmentBonus); // [v6.6.0] hard cap 92%

  // [v6.1] MIXED → NO_TRADE
  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }

  // Session quality
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === 'LOW') confidence = Math.max(25, confidence - 8);
    else if (session.quality === 'HIGHEST') confidence = Math.min(92, confidence + 3);
  }

  // Exotic penalty
  if (exotic) confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY);

  // [v6.2] Candle consistency check
  const primaryCandles = candleData['5min'] || candleData['1min'] || candleData['15min'];
  var consistencyMult = 1.0;
  if (primaryCandles && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 4);
    if (consistencyMult < 1.0) {
      confidence = Math.round(confidence * consistencyMult);
    }
  }

  // [v6.2] Volume spike anomaly filter
  var volumeSpikeBlocked = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles) {
    volumeSpikeBlocked = isVolumeSpikeAnomaly(primaryCandles, assetType);
    if (volumeSpikeBlocked) {
      finalDirection = 'NO_TRADE';
      confidence = 0;
    }
  }

  // [v6.5.2] FVG penalty — find first TF that actually has fvg data (skip dead market TFs)
  // Bug fix: dead market 1min has categoryScores:{} — was truthy so 5min/15min fvg never checked
  var fvgBlocked = false;
  var fvgBlockDetail = '';
  var fvgCheckTF = null;
  var fvgTFOrder = ['1min', '5min', '15min'];
  for (var fi = 0; fi < fvgTFOrder.length; fi++) {
    var candidate = tfResults[fvgTFOrder[fi]];
    if (candidate && candidate.categoryScores && candidate.categoryScores.fvg) {
      fvgCheckTF = candidate;
      break;
    }
  }
  if (finalDirection !== 'NO_TRADE' && fvgCheckTF && fvgCheckTF.categoryScores && fvgCheckTF.categoryScores.fvg) {
    var activeFVGType = fvgCheckTF.categoryScores.fvg.active; // 'BULLISH' | 'BEARISH' | 'NONE'
    if (activeFVGType && activeFVGType !== 'NONE') {
      if (finalDirection === 'BUY' && activeFVGType === 'BEARISH') {
        fvgBlocked = true;
        fvgBlockDetail = 'BUY confidence reduced: inside bearish FVG (supply imbalance) on ' + fvgCheckTF.timeframe;
        confidence = Math.max(0, confidence - 20); // penalty, not hard block
      }
      if (finalDirection === 'SELL' && activeFVGType === 'BULLISH') {
        fvgBlocked = true;
        fvgBlockDetail = 'SELL confidence reduced: inside bullish FVG (demand imbalance) on ' + fvgCheckTF.timeframe;
        confidence = Math.max(0, confidence - 20);
      }
      // After penalty: if confidence falls below floor, then block
      if (fvgBlocked && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
        finalDirection = 'NO_TRADE';
        confidence = 0;
      }
    }
  }

  // [v6.2] News blackout → force NO_TRADE for FOREX
  var newsBlocked = false;
  if (newsBlock && newsBlock.blocked && finalDirection !== 'NO_TRADE') {
    newsBlocked = true;
    finalDirection = 'NO_TRADE';
    confidence = 0;
  }

  // [v6.4] Entry candle confirmation — if last 1min candle strongly opposes signal, penalize
  // A strong body candle against the signal direction is a warning sign
  var entryCandlePenalty = false;
  if (finalDirection !== 'NO_TRADE') {
    var entryCheckCandles = candleData['1min'] || candleData['5min'] || candleData['15min'];
    if (entryCheckCandles && entryCheckCandles.length >= 2) {
      var lastC    = entryCheckCandles[entryCheckCandles.length - 1];
      var prevC    = entryCheckCandles[entryCheckCandles.length - 2];
      var lastBody = Math.abs(lastC.close - lastC.open);
      var lastRange = (lastC.high - lastC.low) || 0.00001;
      var bodyRatio = lastBody / lastRange;
      var lastBullish = lastC.close > lastC.open;
      // Only penalize if strong body (bodyRatio > 0.55) AND prev candle also against signal
      var prevBullish = prevC.close > prevC.open;
      var bothAgainst = (finalDirection === 'BUY'  && !lastBullish && !prevBullish) ||
                        (finalDirection === 'SELL' &&  lastBullish &&  prevBullish);
      if (bothAgainst && bodyRatio > 0.55) {
        entryCandlePenalty = true;
        confidence = Math.max(0, confidence - 10);
        // Re-check floor after penalty
        if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
          finalDirection = 'NO_TRADE';
          confidence = 0;
        }
      }
    }
  }

  // Grade
  const avgConf = votes.reduce(function (s, v) { return s + (v.confluence || 0); }, 0) / Math.max(votes.length, 1);
  const grade = getSignalGrade(confidence, avgConf, alignment);

  // Market condition — reuse from tfResults (no redundant calculateAllIndicators call)
  const htfTFResult = tfResults['15min'] || tfResults['5min'] || tfResults['1min'];
  let marketCondition = ['UNKNOWN'];
  let marketContext = 'UNKNOWN';
  if (htfTFResult) {
    const htfCandles = candleData['15min'] || candleData['5min'] || candleData['1min'];
    const adxHtf = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.adx) : null;
    const bbBWHtf = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.bbBandwidth) : null;
    const atrHtf  = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.atr) : null;
    const lastCloseHtf = htfCandles ? htfCandles[htfCandles.length - 1].close : null;
    if (lastCloseHtf !== null) {
      marketCondition = detectMarketCondition(
        isNaN(adxHtf) ? null : adxHtf,
        isNaN(bbBWHtf) ? null : bbBWHtf,
        isNaN(atrHtf) ? null : atrHtf,
        lastCloseHtf, assetType
      );
    }
    marketContext = (!isNaN(adxHtf) && adxHtf !== null) ? (adxHtf >= 25 ? 'TRENDING' : 'RANGING') : 'UNKNOWN';
  }

  // Dead market filter — runs before confidence floor so ordering is clean
  if (finalDirection !== 'NO_TRADE' && marketCondition.indexOf('DEAD_MARKET') !== -1 && confidence < 75) {
    finalDirection = 'NO_TRADE';
    confidence = Math.min(confidence, 30);
  }

  // [v6.2] Minimum confidence floor
  var belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    belowFloor = true;
    finalDirection = 'NO_TRADE';
    // Keep confidence value visible so user sees why it was blocked
  }

  // [v6.9.0] H3 — Dynamic confidence adjustment from historical win rate
  if (finalDirection !== 'NO_TRADE' && env && env.SIGNAL_CACHE) {
    var dynAdj = await getDynamicConfidenceAdjustment(pair, env);
    if (dynAdj !== 0) {
      confidence = Math.max(0, Math.min(92, confidence + dynAdj));
      filtersApplied.push('DYNAMIC_CONF_ADJ: ' + (dynAdj > 0 ? '+' : '') + dynAdj + ' (historical win rate)');
      // Re-check floor after dynamic adjustment
      if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR && finalDirection !== 'NO_TRADE') {
        finalDirection = 'NO_TRADE';
        confidence     = 0;
        filtersApplied.push('BELOW_FLOOR_AFTER_DYN_ADJ');
      }
    }
  }

  // Best timeframe
  const best = findBestTimeframe(tfResults, finalDirection);

  // Per-TF recommendations
  const recommendations = {};
  const recKeys = Object.keys(tfResults);
  for (let r = 0; r < recKeys.length; r++) {
    const rtf = recKeys[r];
    const rec = tfResults[rtf];
    recommendations[rtf] = {
      direction:      rec.direction,
      score:          rec.score,
      confluence:     rec.confluence + '/11 categories',
      alignedWithHTF: rec.alignedWithHTF,
      expiry:         rec.expiry,
      entry:          rec.entry,
      patterns: (rec.categoryScores && rec.categoryScores.patterns && rec.categoryScores.patterns.detected)
        ? rec.categoryScores.patterns.detected : [],
      divergence: {
        rsi:  (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.rsi)  ? rec.categoryScores.divergence.rsi  : 'NONE',
        macd: (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.macd) ? rec.categoryScores.divergence.macd : 'NONE',
      },
      diCrossover: (rec.categoryScores && rec.categoryScores.adx && rec.categoryScores.adx.diCross)
        ? rec.categoryScores.adx.diCross : 'NONE',
    };
  }

  // [v6.2] Entry reason — build from best available TF analysis
  var bestTFAnalysis = tfResults[best.timeframe] || null;
  var entryReason = generateEntryReason(
    finalDirection,
    bestTFAnalysis ? bestTFAnalysis.categoryScores : {},
    bestTFAnalysis ? bestTFAnalysis.indicators : {},
    alignment,
    higherTFTrend,
    marketContext
  );

  // [v6.2] Build filter audit trail
  var filtersApplied = [];
  if (newsBlocked)         filtersApplied.push('NEWS_BLACKOUT: ' + (newsBlock ? newsBlock.label : ''));
  if (volumeSpikeBlocked)  filtersApplied.push('VOLUME_SPIKE_ANOMALY');
  if (fvgBlocked)          filtersApplied.push('FVG_PENALTY: ' + fvgBlockDetail);
  if (belowFloor)          filtersApplied.push('CONFIDENCE_BELOW_FLOOR (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
  if (consistencyMult < 1.0) filtersApplied.push('CANDLE_INCONSISTENCY (mult=' + consistencyMult + ')');
  if (alignment === 'MIXED') filtersApplied.push('MIXED_ALIGNMENT');
  if (entryCandlePenalty)  filtersApplied.push('ENTRY_CANDLE_PENALTY (-10 confidence)');
  if (sessionMult !== 1.0) filtersApplied.push('SESSION_WEIGHT (x' + sessionMult.toFixed(2) + ' — ' + (session.overlap !== 'NONE' ? session.overlap : session.sessions[0]) + ')');
  if (candleQualityMult !== 1.0) filtersApplied.push('CANDLE_QUALITY (x' + candleQualityMult.toFixed(2) + ')');

  // [v6.8.0] P4 — DUAL AI VALIDATION (Cerebras + Groq in parallel)
  var aiValidation = { status: 'SKIPPED' };
  var aiAgreed = null;

  if (finalDirection !== 'NO_TRADE') {
    var snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    var engineSignalSummary = {
      direction:       finalDirection,
      confidence:      confidence + '%',
      alignment:       alignment,
      higherTFTrend:   higherTFTrend || 'NEUTRAL',
      marketCondition: marketCondition,
      bestTF:          best.timeframe,
    };

    // Run both AIs in parallel — whichever finishes first used, no serial wait
    var aiResults = await Promise.all([
      callCerebrasValidation(pair, assetType, engineSignalSummary, snapshot, env),
      callGroqValidation(pair, assetType, engineSignalSummary, snapshot, env),
    ]);

    var cerebrasResult = aiResults[0];
    var groqResult     = aiResults[1];
    var dualResult     = combineDualAIResults(cerebrasResult, groqResult, finalDirection);

    aiValidation = dualResult; // full dual result in response

    var combinedAI = dualResult.combined;
    if (combinedAI && combinedAI.status === 'OK') {
      aiAgreed = dualResult.combinedAgreed;

      if (aiAgreed) {
        if (!combinedAI.concerns) {
          // Both agree, no concerns — stronger boost if both agreed
          var boost = (combinedAI.agreement === 'BOTH_AGREE') ? 8 : 5;
          confidence = Math.min(92, confidence + boost);
          filtersApplied.push('DUAL_AI_BOOST: ' + combinedAI.agreement + ' → +' + boost + ' (' + combinedAI.signal + ' ' + combinedAI.confidence + '%)');
        } else {
          confidence = Math.max(0, confidence - 5);
          filtersApplied.push('DUAL_AI_AGREE_WITH_CONCERNS: ' + combinedAI.concerns);
        }
      } else if (combinedAI.signal !== 'NO_TRADE') {
        confidence = Math.max(0, confidence - 15);
        filtersApplied.push('DUAL_AI_PENALTY: disagrees (AI=' + combinedAI.signal + ' ' + combinedAI.confidence + '%)');
        if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
          finalDirection = 'NO_TRADE';
          confidence = 0;
          filtersApplied.push('BELOW_FLOOR_AFTER_DUAL_AI (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
        }
      } else {
        // AIs disagree or NO_TRADE
        confidence = Math.max(0, confidence - 10);
        filtersApplied.push('DUAL_AI_SOFT_PENALTY: AIs uncertain/conflicting');
      }
      if (aiValidation.combinedAgreed !== undefined) aiValidation.agrees = aiValidation.combinedAgreed;
    }
  }

  // Re-run grade after AI adjustments (confidence may have changed)
  const finalGrade = getSignalGrade(confidence, avgConf, alignment);

  return {
    finalSignal:    finalDirection,
    confidence:     confidence + '%',
    grade:          finalGrade,
    assetType:      assetType,
    marketRegime:   marketRegime,                              // [v6.6.0]
    regimeAdvice:   getRegimeAdvice(marketRegime, finalDirection), // [v6.6.0]
    marketCondition: marketCondition,
    alignment:      alignment,
    higherTFTrend:  higherTFTrend || 'NEUTRAL',
    entryReason:    entryReason,
    filtersApplied: filtersApplied,
    newsBlackout:   newsBlock || null,
    aiValidation:   aiValidation,          // [v6.5.0]
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ['24/7'], quality: 'N/A' },
    recommendations: recommendations,
    bestTimeframe: best,
    votes: {
      BUY:      votes.filter(function (v) { return v.direction === 'BUY'; }).length,
      SELL:     votes.filter(function (v) { return v.direction === 'SELL'; }).length,
      NO_TRADE: votes.filter(function (v) { return v.direction === 'NO_TRADE'; }).length,
      total:    votes.length,
      weightedBuy:      r2(weightedBuy),
      weightedSell:     r2(weightedSell),
      weightedNoTrade:  r2(weightedNoTrade),
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    sessionWeight:    sessionMult,
    candleQuality:    candleQualityMult,
    method:      'WEIGHTED_MULTI_TF_v6.9.0',
    generatedAt: now.toISOString(),
  };
}

// ============================================
// FIND BEST TIMEFRAME
// ============================================

function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null; let bestScore = -1; let bestConf = -1;
  const keys = Object.keys(tfResults);

  for (let i = 0; i < keys.length; i++) {
    const tf = keys[i]; const r = tfResults[tf];
    if (r.direction === finalDirection || finalDirection === 'NO_TRADE') {
      const score = r.direction === 'BUY' ? r.score.up : r.direction === 'SELL' ? r.score.down : 0;
      const effectiveConf = r.confluence + (r.alignedWithHTF ? 1 : 0);
      if (effectiveConf > bestConf || (effectiveConf === bestConf && score > bestScore)) {
        bestTF = tf; bestScore = score; bestConf = effectiveConf;
      }
    }
  }

  if (!bestTF) {
    for (let i = 0; i < keys.length; i++) {
      const tf = keys[i]; const r = tfResults[tf];
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) { bestTF = tf; bestScore = score; bestConf = r.confluence; }
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
    reason: 'Strongest ' + best.direction + ' signal with ' + best.confluence + '/11 confluence' +
      (best.alignedWithHTF ? ' (aligned with higher TF)' : ''),
  };
}

// ============================================
// TIMEFRAME ANALYSIS v6.2
// ============================================

function analyzeTimeframe(indicators, candles, timeframe, assetType, higherTFTrend, marketRegime) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const minScoreThreshold = SCORE_THRESHOLDS[assetType] || 3.0;
  // [v6.6.0] Use regime-specific weights instead of static CONFIG weights
  const weights = getRegimeWeights(marketRegime || 'RANGING');

  const ema5   = safeLastValue(indicators.ema5);
  const ema10  = safeLastValue(indicators.ema10);
  const ema20  = safeLastValue(indicators.ema20);
  const sma50  = safeLastValue(indicators.sma50);
  const rsi    = safeLastValue(indicators.rsi);
  const macdHistData   = safeLastTwo(indicators.macd.histogram);
  const macdHist       = macdHistData.last;
  const prevMacdHist   = macdHistData.prev;
  const macdLineData   = safeLastTwo(indicators.macd.macdLine);
  const macdLine       = macdLineData.last;
  const macdSignalData = safeLastTwo(indicators.macd.signalLine);
  const macdSignal     = macdSignalData.last;
  const atr            = safeLastValue(indicators.atr);
  const bbUpper        = safeLastValue(indicators.bollinger.upper);
  const bbLower        = safeLastValue(indicators.bollinger.lower);
  const bbMiddle       = safeLastValue(indicators.bollinger.middle);
  const bbBandwidth    = safeLastValue(indicators.bollinger.bandwidth);
  const bbPercentB     = safeLastValue(indicators.bollinger.percentB);
  const stochK         = safeLastValue(indicators.stochastic.k);
  const stochD         = safeLastValue(indicators.stochastic.d);
  const prevStochKData = safeLastTwo(indicators.stochastic.k);
  const prevStochK     = prevStochKData.prev;
  const adxVal         = safeLastValue(indicators.adx.adx);
  const plusDI         = safeLastValue(indicators.adx.plusDI);
  const minusDI        = safeLastValue(indicators.adx.minusDI);
  const williamsR      = safeLastValue(indicators.williamsR);
  const cci            = safeLastValue(indicators.cci);
  const mfi            = safeLastValue(indicators.mfi);
  const pivots         = indicators.pivots;
  const patterns       = indicators.patterns;
  const sr             = indicators.sr   || { supports: [], resistances: [] }; // [v6.3]
  const fvg            = indicators.fvg  || { active: null };                  // [v6.3]

  if (ema5 === null || ema20 === null) {
    return {
      direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
      confluence: 0, reason: 'Insufficient data', timeframe: timeframe, assetType: assetType,
      categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 11 }, volatilityMultiplier: 0,
    };
  }

  const lastCandle = candles[candles.length - 1];
  const lastClose  = lastCandle.close;
  const trending   = isTrendingMarket(adxVal);

  let upScore = 0; let downScore = 0; let upCat = 0; let downCat = 0;
  const catScores = {};

  // Dead market check
  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct < vt.minTradableATR) {
      return {
        direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
        confluence: 0, reason: 'Dead market — ATR too low',
        timeframe: timeframe, assetType: assetType, deadMarket: true,
        categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 11 }, volatilityMultiplier: 0,
      };
    }
  }

  // === CAT 1: TREND ===
  var tU = 0; var tD = 0;
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
  tU *= weights.trend; tD *= weights.trend;
  upScore += tU; downScore += tD;
  if (tU > tD && Math.abs(tU - tD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (tD > tU && Math.abs(tD - tU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.trend = { up: r2(tU), down: r2(tD) };

  // === CAT 2: MOMENTUM ===
  var mU = 0; var mD = 0;
  if (rsi !== null) {
    if (trending === true) {
      if (rsi >= 60 && rsi < 80) mU += 1.0; else if (rsi >= 50 && rsi < 60) mU += 0.5;
      else if (rsi > 40 && rsi < 50) mD += 0.5; else if (rsi > 20 && rsi <= 40) mD += 1.0;
      else if (rsi >= 80) mU += 0.3; else if (rsi <= 20) mD += 0.3;
    } else if (trending === false) {
      if (rsi >= 75) mD += 1.5; else if (rsi >= 65) mD += 0.75;
      else if (rsi <= 25) mU += 1.5; else if (rsi <= 35) mU += 0.75;
      else if (rsi >= 55) mU += 0.25; else if (rsi <= 45) mD += 0.25;
    } else {
      if (rsi >= 75) mD += 1.0; else if (rsi >= 60) mU += 0.5;
      else if (rsi <= 25) mU += 1.0; else if (rsi <= 40) mD += 0.5;
    }
  }
  if (williamsR !== null) {
    if (trending === true) {
      if (williamsR > -30) mU += 0.3; else if (williamsR < -70) mD += 0.3;
    } else {
      if (williamsR > -20) mD += 0.5; else if (williamsR < -80) mU += 0.5;
      else if (williamsR > -50) mU += 0.25; else mD += 0.25;
    }
  }
  if (mfi !== null) {
    var hasVolume = assetType === ASSET_TYPE.CRYPTO || lastCandle.volume > 0;
    if (hasVolume) {
      if (mfi >= 80) mD += 0.5; else if (mfi <= 20) mU += 0.5;
      else if (mfi >= 55) mU += 0.25; else if (mfi <= 45) mD += 0.25;
    }
  }
  mU *= weights.momentum; mD *= weights.momentum;
  upScore += mU; downScore += mD;
  if (mU > mD && Math.abs(mU - mD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mD > mU && Math.abs(mD - mU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.momentum = { up: r2(mU), down: r2(mD), context: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN' };

  // === CAT 3: MACD ===
  var mcU = 0; var mcD = 0;
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
  mcU *= weights.macd; mcD *= weights.macd;
  upScore += mcU; downScore += mcD;
  if (mcU > mcD && Math.abs(mcU - mcD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mcD > mcU && Math.abs(mcD - mcU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.macd = { up: r2(mcU), down: r2(mcD) };

  // === CAT 4: STOCHASTIC ===
  var sU = 0; var sD = 0;
  if (stochK !== null && stochD !== null) {
    if (trending === true) {
      if (stochK > stochD && stochK > 40 && stochK < 70) sU += 0.75;
      else if (stochK < stochD && stochK > 30 && stochK < 60) sD += 0.75;
      if (prevStochK !== null && prevStochK < 30 && stochK > 30 && stochK > stochD) sU += 0.75;
      if (prevStochK !== null && prevStochK > 70 && stochK < 70 && stochK < stochD) sD += 0.75;
    } else {
      if (stochK > 80 && stochD > 80) sD += 0.75; else if (stochK < 20 && stochD < 20) sU += 0.75;
      if (stochK > stochD) sU += 0.5; else if (stochK < stochD) sD += 0.5;
      if (prevStochK !== null) { if (stochK > prevStochK) sU += 0.25; else if (stochK < prevStochK) sD += 0.25; }
      if (stochK < 20 && stochK > stochD) sU += 0.5;
      if (stochK > 80 && stochK < stochD) sD += 0.5;
    }
  }
  sU *= weights.stochastic; sD *= weights.stochastic;
  upScore += sU; downScore += sD;
  if (sU > sD && Math.abs(sU - sD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (sD > sU && Math.abs(sD - sU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.stochastic = { up: r2(sU), down: r2(sD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 5: BOLLINGER + CCI ===
  var bU = 0; var bD = 0;
  if (bbUpper !== null && bbLower !== null && bbMiddle !== null) {
    if (trending === true) {
      if (lastClose >= bbUpper) { if (ema5 > ema20) bU += 0.75; else bD += 0.5; }
      else if (lastClose <= bbLower) { if (ema5 < ema20) bD += 0.75; else bU += 0.5; }
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    } else {
      if (lastClose >= bbUpper) bD += 1.0; else if (lastClose <= bbLower) bU += 1.0;
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    }
    if (bbPercentB !== null) {
      if (trending !== true) {
        if (bbPercentB > 1.0) bD += 0.5; else if (bbPercentB < 0.0) bU += 0.5;
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
  bU *= weights.bands; bD *= weights.bands;
  upScore += bU; downScore += bD;
  if (bU > bD && Math.abs(bU - bD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (bD > bU && Math.abs(bD - bU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.bands = { up: r2(bU), down: r2(bD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 6: ADX + DI ===
  var aU = 0; var aD = 0; var diCross = null;
  if (adxVal !== null && plusDI !== null && minusDI !== null) {
    if (plusDI > minusDI) aU += 0.75; else if (minusDI > plusDI) aD += 0.75;
    if (adxVal >= 25) { if (plusDI > minusDI) aU += 0.75; else aD += 0.75; }
    var adxLastTwo = safeLastTwo(indicators.adx.adx);
    if (adxLastTwo.last !== null && adxLastTwo.prev !== null) {
      if (adxLastTwo.last > adxLastTwo.prev && adxLastTwo.last >= 20) {
        if (plusDI > minusDI) aU += 0.5; else aD += 0.5;
      } else if (adxLastTwo.last < adxLastTwo.prev && adxLastTwo.last < 25) {
        aU *= 0.7; aD *= 0.7;
      }
    }
    diCross = detectDICrossover(indicators.adx);
    if (diCross) {
      if (diCross.direction === 'BUY') aU += diCross.strength;
      else if (diCross.direction === 'SELL') aD += diCross.strength;
    }
  }
  aU *= weights.adx; aD *= weights.adx;
  upScore += aU; downScore += aD;
  if (aU > aD && Math.abs(aU - aD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (aD > aU && Math.abs(aD - aU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.adx = { up: r2(aU), down: r2(aD), diCross: diCross ? diCross.type : 'NONE' };

  // === CAT 7: CANDLESTICK PATTERNS ===
  var pU = 0; var pD = 0;
  if (patterns && patterns.length > 0) {
    for (var pi = 0; pi < patterns.length; pi++) {
      var pat = patterns[pi];
      var adjustedStrength = pat.strength;
      if (trending === true) {
        var isCont = (pat.direction === 'BUY' && ema5 > ema20) || (pat.direction === 'SELL' && ema5 < ema20);
        adjustedStrength *= isCont ? 1.3 : 0.6;
      }
      if (pat.direction === 'BUY') pU += adjustedStrength;
      else if (pat.direction === 'SELL') pD += adjustedStrength;
    }
  }
  var bodySize   = Math.abs(lastCandle.close - lastCandle.open);
  var totalRange = (lastCandle.high - lastCandle.low) || 0.00001;
  if (bodySize / totalRange > 0.6) {
    if (lastCandle.close > lastCandle.open) pU += 0.5; else pD += 0.5;
  }
  pU = Math.min(pU, 3.0); pD = Math.min(pD, 3.0);
  pU *= weights.patterns; pD *= weights.patterns;
  upScore += pU; downScore += pD;
  if (pU > pD && Math.abs(pU - pD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pD > pU && Math.abs(pD - pU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.patterns = { up: r2(pU), down: r2(pD), detected: patterns ? patterns.map(function (p) { return p.name; }) : [] };

  // === CAT 8: DIVERGENCE ===
  var dvU = 0; var dvD = 0;
  var rDiv = detectRSIDivergence(candles, indicators.rsi);
  var mDiv = detectMACDDivergence(candles, indicators.macd.histogram);
  if (rDiv) { var rStr = rDiv.confirmed ? rDiv.strength : rDiv.strength * 0.5; if (rDiv.direction === 'BUY') dvU += rStr; else dvD += rStr; }
  if (mDiv) { var mStr = mDiv.confirmed ? mDiv.strength : mDiv.strength * 0.5; if (mDiv.direction === 'BUY') dvU += mStr; else dvD += mStr; }
  dvU = Math.min(dvU, 2.5); dvD = Math.min(dvD, 2.5);
  dvU *= weights.divergence; dvD *= weights.divergence;
  upScore += dvU; downScore += dvD;
  if (dvU > dvD && Math.abs(dvU - dvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (dvD > dvU && Math.abs(dvD - dvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.divergence = {
    up: r2(dvU), down: r2(dvD),
    rsi: rDiv ? rDiv.type : 'NONE', rsiConfirmed: rDiv ? rDiv.confirmed : false,
    macd: mDiv ? mDiv.type : 'NONE', macdConfirmed: mDiv ? mDiv.confirmed : false,
  };

  // === CAT 9: PIVOT POINTS ===
  var pvU = 0; var pvD = 0;
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
  pvU = Math.min(pvU, 2.0); pvD = Math.min(pvD, 2.0);
  pvU *= weights.pivots; pvD *= weights.pivots;
  upScore += pvU; downScore += pvD;
  if (pvU > pvD && Math.abs(pvU - pvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pvD > pvU && Math.abs(pvD - pvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.pivots = { up: r2(pvU), down: r2(pvD) };

  // === CAT 10: VOLUME ===
  var vU = 0; var vD = 0;
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
      var avgOlder  = (lv[0] + lv[1]) / 2;
      if (avgOlder > 0 && avgRecent > avgOlder * 1.2) {
        if (lastCandle.close > candles[candles.length - 5].close) vU += 0.25; else vD += 0.25;
      }
    }
    if (patterns && patterns.length > 0 && av > 0 && lastCandle.volume > av * 1.3) {
      for (var vpi = 0; vpi < patterns.length; vpi++) {
        if (patterns[vpi].direction === 'BUY') vU += 0.15;
        else if (patterns[vpi].direction === 'SELL') vD += 0.15;
      }
    }
  }
  vU *= weights.volume; vD *= weights.volume;
  upScore += vU; downScore += vD;
  if (vU > vD && Math.abs(vU - vD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (vD > vU && Math.abs(vD - vU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.volume = {
    up: r2(vU), down: r2(vD), reliable: hasReliableVolume,
    skipped: !hasReliableVolume ? 'No reliable volume data (forex)' : null,
  };

  // === [v6.3] CAT 11: SUPPORT & RESISTANCE ===
  var srU = 0; var srD = 0;
  var srContext = 'NO_LEVEL'; // NEAR_SUPPORT | NEAR_RESISTANCE | BETWEEN | NO_LEVEL
  if (atr !== null && atr > 0) {
    var nearThresh = atr * 0.5; // [v6.4] tightened from 1.0 → 0.5 (prevents over-wide S/R detection)
    var nearSupport = null; var nearResistance = null;

    // Find nearest support BELOW price
    for (var si2 = 0; si2 < sr.supports.length; si2++) {
      var sup = sr.supports[si2];
      if (lastClose > sup.price && Math.abs(lastClose - sup.price) <= nearThresh) {
        nearSupport = sup; break;
      }
    }
    // Find nearest resistance ABOVE price
    for (var ri2 = 0; ri2 < sr.resistances.length; ri2++) {
      var res = sr.resistances[ri2];
      if (lastClose < res.price && Math.abs(lastClose - res.price) <= nearThresh) {
        nearResistance = res; break;
      }
    }

    if (nearSupport && !nearResistance) {
      var proximity  = 1 - (Math.abs(lastClose - nearSupport.price) / nearThresh);
      // FIX 4: normalize strength 0.0–1.0 (strength=1→0.33, 2→0.67, 3+→1.0)
      // Prevents CAT 11 dominating all other categories
      var normStrS   = Math.min(nearSupport.strength / 3, 1.0);
      srU += 2.0 * proximity * normStrS;
      srContext = 'NEAR_SUPPORT';
    } else if (nearResistance && !nearSupport) {
      var proximity2 = 1 - (Math.abs(lastClose - nearResistance.price) / nearThresh);
      // FIX 4: normalize strength
      var normStrR   = Math.min(nearResistance.strength / 3, 1.0);
      srD += 2.0 * proximity2 * normStrR;
      srContext = 'NEAR_RESISTANCE';
    } else if (nearSupport && nearResistance) {
      srContext = 'BETWEEN';
    } else {
      srContext = 'NO_LEVEL';
    }
  }
  srU = Math.min(srU, 2.0); srD = Math.min(srD, 2.0); // cap at 2.0 (was 3.0)
  srU *= weights.sr || 1.4; srD *= weights.sr || 1.4;   // max after weight = 2.8
  upScore += srU; downScore += srD;
  if (srU > srD && Math.abs(srU - srD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (srD > srU && Math.abs(srD - srU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.sr = { up: r2(srU), down: r2(srD), context: srContext };

  // [v6.3.1] S/R context penalty
  var srPenalty = 1.0;
  if (srContext === 'BETWEEN') srPenalty = 0.85;
  else if (srContext === 'NO_LEVEL') srPenalty = 0.90;

  // === [v6.3] FVG CONTEXT in analyzeTimeframe ===
  // [v6.3.1] Score penalty removed — hard block in buildMultiTimeframeSignal is sufficient.
  // Double-penalizing (score cut + hard block) was over-filtering strong signals.
  catScores.fvg = {
    active: fvg.active ? fvg.active.type : 'NONE',
    bullishCount: fvg.bullish ? fvg.bullish.length : 0,
    bearishCount: fvg.bearish ? fvg.bearish.length : 0,
  };

  // === VOLATILITY FILTER ===
  var volMult = 1.0;
  if (bbBandwidth !== null) {
    if (bbBandwidth < vt.bbFilterDead) volMult = 0.4;
    else if (bbBandwidth < vt.bbFilterLow) volMult = 0.6;
    else if (bbBandwidth < vt.bbFilterMed) volMult = 0.8;
  }
  // [v6.3.1] Apply srPenalty + volMult here — isolated from category score accumulation
  upScore *= volMult * srPenalty; downScore *= volMult * srPenalty;

  // === [v6.8.0] P5: CAMARILLA PIVOT SCORING ===
  // Applied AFTER volMult+srPenalty so dead/choppy market naturally reduces Camarilla influence
  var camScore = { up: 0, down: 0, level: 'NONE' };
  if (indicators.camarilla && atr !== null) {
    camScore = scoreCamarillaLevels(indicators.camarilla, lastClose, atr);
    var camW = (weights.sr || 1.4) * volMult * srPenalty; // scale with market quality
    upScore   += camScore.up   * camW * 0.6;
    downScore += camScore.down * camW * 0.6;
  }
  catScores.camarilla = { up: r2(camScore.up), down: r2(camScore.down), level: camScore.level };

  // === HIGHER-TF PENALTY ===
  var htfPenalty = 1.0;
  if (higherTFTrend !== null) {
    var thisTFDir = upScore > downScore ? 'BUY' : downScore > upScore ? 'SELL' : null;
    if (thisTFDir !== null && thisTFDir !== higherTFTrend) {
      htfPenalty = 0.7;
      if (thisTFDir === 'BUY') upScore *= 0.7; else downScore *= 0.7;
    }
  }

  // === DECISION ===
  var scoreDiff  = Math.abs(upScore - downScore);
  var confluence = Math.max(upCat, downCat);
  var direction;

  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) direction = 'BUY';
  else if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) direction = 'SELL';
  else if (scoreDiff >= 4.0 && confluence >= 4) direction = upScore > downScore ? 'BUY' : 'SELL';
  else direction = 'NO_TRADE';

  // === EMA ALIGNMENT SUMMARY ===
  var emaAlignment = 'MIXED';
  if (ema10 !== null) {
    if (ema5 > ema10 && ema10 > ema20) emaAlignment = 'BULLISH';
    else if (ema5 < ema10 && ema10 < ema20) emaAlignment = 'BEARISH';
  }

  return {
    direction: direction,
    score: { up: r2(upScore), down: r2(downScore), diff: r2(scoreDiff) },
    confluence: confluence,
    confluenceDetail: { bullish: upCat, bearish: downCat, total: 11 },
    categoryScores: catScores,
    volatilityMultiplier: volMult,
    htfPenalty: htfPenalty < 1.0 ? 'COUNTER_TREND_PENALTY' : 'NONE',
    marketContext: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN',
    assetType: assetType,
    indicators: {
      ema5: fmt(ema5), ema10: fmt(ema10), ema20: fmt(ema20), sma50: fmt(sma50),
      emaAlignment: emaAlignment,
      rsi: fmt(rsi, 2), stochK: fmt(stochK, 2), stochD: fmt(stochD, 2),
      macdHist: fmt(macdHist, 6), macdLine: fmt(macdLine, 6), macdSignal: fmt(macdSignal, 6),
      adx: fmt(adxVal, 2), plusDI: fmt(plusDI, 2), minusDI: fmt(minusDI, 2),
      williamsR: fmt(williamsR, 2), cci: fmt(cci, 2), mfi: assetType === ASSET_TYPE.CRYPTO ? fmt(mfi, 2) : 'N/A (Forex)', atr: fmt(atr, 6),
      bbUpper: fmt(bbUpper), bbMiddle: fmt(bbMiddle), bbLower: fmt(bbLower),
      bbBandwidth: bbBandwidth !== null ? bbBandwidth.toFixed(4) : 'N/A',
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


// ============================================
// [v6.8.0] P1 — CANDLE QUALITY FILTER
// Body strength বিশ্লেষণ করে signal weight adjust করে
// Strong body = বেশি weight, Doji/wick heavy = কম weight
// ============================================

function getCandleQualityMultiplier(candles) {
  if (!candles || candles.length < 3) return 1.0;

  var last  = candles[candles.length - 1];
  var prev1 = candles[candles.length - 2];
  var prev2 = candles[candles.length - 3];

  function bodyRatio(c) {
    var body  = Math.abs(c.close - c.open);
    var range = (c.high - c.low) || 0.00001;
    return body / range;
  }

  function wickRatio(c) {
    var body      = Math.abs(c.close - c.open);
    var range     = (c.high - c.low) || 0.00001;
    var upperWick = c.high - Math.max(c.open, c.close);
    var lowerWick = Math.min(c.open, c.close) - c.low;
    var totalWick = upperWick + lowerWick;
    return range > 0 ? totalWick / range : 0;
  }

  var br0 = bodyRatio(last);
  var br1 = bodyRatio(prev1);
  var wr0 = wickRatio(last);

  // Strong body last 2 candles — high quality
  if (br0 >= 0.65 && br1 >= 0.55) return 1.15;

  // Good body, low wick
  if (br0 >= 0.55 && wr0 <= 0.35) return 1.08;

  // Moderate
  if (br0 >= 0.40) return 1.0;

  // Doji or wick-heavy — reduce quality
  if (br0 < 0.15) return 0.75; // Doji
  if (wr0 >= 0.70) return 0.82; // Wick dominant

  return 0.92;
}

// ============================================
// [v6.8.0] P2 — SESSION-SPECIFIC WEIGHT MULTIPLIER
// Pair এর currency আর current session দেখে weight adjust করে
// ============================================

function getSessionWeightMultiplier(pair, session) {
  if (!pair || !session) return 1.0;

  var parts = pair.replace('-OTC', '').split('/');
  var base  = parts[0] || '';
  var quote = parts[1] || '';

  // Active session — single or overlap
  var activeSession = session.overlap !== 'NONE' ? session.overlap : (session.sessions[0] || 'UNKNOWN');

  // Check base currency weight
  var baseWeights  = SESSION_PAIR_WEIGHTS[base]  || {};
  var quoteWeights = SESSION_PAIR_WEIGHTS[quote] || {};

  var baseW  = baseWeights[activeSession]  || 1.0;
  var quoteW = quoteWeights[activeSession] || 1.0;

  // Average of both currencies — if either is active, boost
  var mult = Math.max(baseW, quoteW);

  // Cap between 0.7 and 1.4
  return Math.max(0.7, Math.min(1.4, mult));
}

// ============================================
// [v6.8.0] P3 — CORRELATION FILTER
// Batch signal এ correlated pairs detect করে
// Same direction correlated = ok
// Opposite direction correlated = warning + confidence penalty
// ============================================

function detectCorrelationConflicts(pairSignals) {
  // pairSignals = { 'EUR/USD': 'BUY', 'GBP/USD': 'SELL', ... }
  var conflicts = [];
  var warnings  = [];

  // Check positive correlation groups
  for (var gi = 0; gi < CORRELATION_GROUPS.length; gi++) {
    var group = CORRELATION_GROUPS[gi];
    var groupSignals = [];
    for (var pi = 0; pi < group.length; pi++) {
      var p = group[pi];
      if (pairSignals[p] && pairSignals[p] !== 'NO_TRADE') {
        groupSignals.push({ pair: p, dir: pairSignals[p] });
      }
    }
    if (groupSignals.length >= 2) {
      var dirs = groupSignals.map(function(s) { return s.dir; });
      var hasBuy  = dirs.indexOf('BUY')  !== -1;
      var hasSell = dirs.indexOf('SELL') !== -1;
      if (hasBuy && hasSell) {
        conflicts.push({
          type:    'POSITIVE_CORRELATION_CONFLICT',
          group:   group,
          signals: groupSignals,
          message: 'Correlated pairs disagree — signal reliability reduced',
        });
      }
    }
  }

  // Check negative correlations — here opposite is EXPECTED, same is warning
  for (var ni = 0; ni < NEGATIVE_CORRELATIONS.length; ni++) {
    var negPair = NEGATIVE_CORRELATIONS[ni];
    var s1 = pairSignals[negPair[0]];
    var s2 = pairSignals[negPair[1]];
    if (s1 && s2 && s1 !== 'NO_TRADE' && s2 !== 'NO_TRADE') {
      if (s1 === s2) {
        warnings.push({
          type:    'NEGATIVE_CORRELATION_SAME_DIR',
          pairs:   negPair,
          signals: [s1, s2],
          message: negPair[0] + ' and ' + negPair[1] + ' both ' + s1 + ' — unusual (negative correlation)',
        });
      }
    }
  }

  return { conflicts: conflicts, warnings: warnings, hasConflict: conflicts.length > 0 };
}

// ============================================
// [v6.8.0] P4 — GROQ AI VALIDATION
// Second AI validator — parallel with Cerebras
// Model: llama-3.1-8b-instant (fast, free tier available)
// ============================================

async function callGroqValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.GROQ_API_KEY) return { status: 'NO_KEY' };

  var prompt = [
    'Expert binary options analyst. Analyze ' + pair + ' (' + assetType + ').',
    'Engine says: ' + engineSignal.direction + ' @ ' + engineSignal.confidence + ' confidence.',
    'Alignment: ' + engineSignal.alignment + ' | HTF: ' + (engineSignal.higherTFTrend || 'N/A'),
    '',
    'Indicators:',
    'EMA: ' + indicatorSnapshot.emaAlignment + ' | RSI: ' + indicatorSnapshot.rsi,
    'MACD hist: ' + indicatorSnapshot.macdHist + ' | ADX: ' + indicatorSnapshot.adx,
    'Stoch K/D: ' + indicatorSnapshot.stochK + '/' + indicatorSnapshot.stochD,
    'BB %B: ' + indicatorSnapshot.bbPercentB + ' BW: ' + indicatorSnapshot.bbBandwidth,
    'Williams: ' + indicatorSnapshot.williamsR + ' | CCI: ' + indicatorSnapshot.cci,
    'Patterns: ' + (indicatorSnapshot.patterns.length ? indicatorSnapshot.patterns.join(',') : 'NONE'),
    'RSI div: ' + indicatorSnapshot.rsiDiv + ' | S/R: ' + indicatorSnapshot.srContext,
    'Structure 1min: ' + indicatorSnapshot.structure1min,
    'Structure 5min: ' + indicatorSnapshot.structure5min,
    '',
    'Candles 1min: ' + indicatorSnapshot.candles1min,
    'Candles 5min: ' + indicatorSnapshot.candles5min,
    '',
    'Respond ONLY in JSON: {"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 15 words","concerns":"max 10 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 6000);
    var res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + env.GROQ_API_KEY,
        },
        body: JSON.stringify({
          model:       'llama-3.1-8b-instant',
          max_tokens:  100,
          temperature: 0.05,
          messages:    [{ role: 'user', content: prompt }],
        }),
      });
    } finally { clearTimeout(tid); }

    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };

    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: 'EMPTY_RESPONSE' };
    text = text.replace(/```json|```/g, '').trim();
    var jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return { status: 'PARSE_ERROR' };
    var parsed  = JSON.parse(jm[0]);
    var valid   = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSig   = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!valid.includes(aiSig)) aiSig = 'NO_TRADE';
    var aiConf  = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return { status: 'OK', signal: aiSig, confidence: aiConf, reason: parsed.reason || null, concerns: parsed.concerns || null, model: 'groq/llama-3.1-8b-instant' };
  } catch(e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

// Dual AI result combiner
// Cerebras + Groq দুটোর result মিলিয়ে final AI verdict দেয়
function combineDualAIResults(cerebras, groq, engineDirection) {
  var result = { cerebras: cerebras, groq: groq, combined: null, combinedAgreed: null };

  var cOk = cerebras && cerebras.status === 'OK';
  var gOk = groq     && groq.status     === 'OK';

  if (!cOk && !gOk) {
    result.combined = { status: 'BOTH_UNAVAILABLE', signal: 'NO_TRADE', confidence: 0 };
    return result;
  }

  if (cOk && !gOk) {
    result.combined = cerebras;
    result.combinedAgreed = cerebras.signal === engineDirection;
    return result;
  }

  if (!cOk && gOk) {
    result.combined = groq;
    result.combinedAgreed = groq.signal === engineDirection;
    return result;
  }

  // Both OK — combine
  if (cerebras.signal === groq.signal) {
    // Both agree — average confidence, stronger signal
    var avgConf = Math.round((cerebras.confidence + groq.confidence) / 2);
    result.combined = {
      status:     'OK',
      signal:     cerebras.signal,
      confidence: avgConf,
      reason:     cerebras.reason || groq.reason,
      concerns:   cerebras.concerns || groq.concerns,
      agreement:  'BOTH_AGREE',
      model:      'dual (Cerebras + Groq)',
    };
  } else {
    // Disagree — conservative: use NO_TRADE or lower confidence one
    var lowerConf = Math.min(cerebras.confidence, groq.confidence);
    result.combined = {
      status:     'OK',
      signal:     'NO_TRADE',
      confidence: lowerConf,
      reason:     'Cerebras=' + cerebras.signal + ' vs Groq=' + groq.signal + ' — AIs disagree',
      concerns:   'Conflicting AI signals — skip trade',
      agreement:  'AIs_DISAGREE',
      model:      'dual (Cerebras + Groq)',
    };
  }

  result.combinedAgreed = result.combined.signal === engineDirection;
  return result;
}

// ============================================
// [v6.8.0] P5 — CAMARILLA PIVOT POINTS
// Regular pivot এর পাশাপাশি Camarilla levels
// OTC এবং short expiry trading এ বেশি accurate
// ============================================

function calculateCamarillaPivots(candles) {
  if (!candles || candles.length < 2) return null;

  var lb  = Math.min(20, candles.length - 1);
  var sc  = candles.slice(-lb - 1, -1);
  var sh  = -Infinity; var sl = Infinity; var scl = sc[sc.length - 1].close;

  for (var i = 0; i < sc.length; i++) {
    if (sc[i].high > sh) sh = sc[i].high;
    if (sc[i].low  < sl) sl = sc[i].low;
  }

  var rng = sh - sl;

  return {
    h4: scl + rng * 1.1 / 2,
    h3: scl + rng * 1.1 / 4,
    h2: scl + rng * 1.1 / 6,
    h1: scl + rng * 1.1 / 12,
    l1: scl - rng * 1.1 / 12,
    l2: scl - rng * 1.1 / 6,
    l3: scl - rng * 1.1 / 4,
    l4: scl - rng * 1.1 / 2,
    close: scl,
  };
}

// Camarilla level থেকে signal score দেয়
function scoreCamarillaLevels(camPivots, lastClose, atr) {
  if (!camPivots || !lastClose || !atr || atr <= 0) return { up: 0, down: 0, level: 'NONE' };

  var thresh = atr * 0.4;
  var up = 0; var down = 0; var level = 'NONE';

  // Near L3/L4 = strong BUY (support bounce)
  if (Math.abs(lastClose - camPivots.l4) < thresh) { up += 1.8; level = 'L4_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l3) < thresh) { up += 1.3; level = 'L3_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l2) < thresh) { up += 0.7; level = 'L2_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l1) < thresh) { up += 0.4; level = 'L1_SUPPORT'; }

  // Near H3/H4 = strong SELL (resistance bounce)
  if (Math.abs(lastClose - camPivots.h4) < thresh) { down += 1.8; level = 'H4_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h3) < thresh) { down += 1.3; level = 'H3_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h2) < thresh) { down += 0.7; level = 'H2_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h1) < thresh) { down += 0.4; level = 'H1_RESISTANCE'; }

  return { up: up, down: down, level: level };
}

// ============================================
// OTC FUNCTIONS (v6.7.0)
// ============================================

function countConsecutiveCandles(candles) {
  if (!candles || candles.length < 2) return { count: 0, direction: null };
  const last = candles[candles.length - 1];
  const lastBull = last.close >= last.open;
  let count = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    const c = candles[i];
    const bull = c.close >= c.open;
    if (bull === lastBull) count++;
    else break;
  }
  return { count: count, direction: lastBull ? 'BUY' : 'SELL' };
}

function detectWickRejection(candles) {
  if (!candles || candles.length < 1) return null;
  const c = candles[candles.length - 1];
  const body       = Math.abs(c.close - c.open);
  const totalRange = c.high - c.low;
  if (totalRange <= 0) return null;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  if (totalRange < 0.00005) return null;
  const upperRatio = upperWick / totalRange;
  const lowerRatio = lowerWick / totalRange;
  if (upperRatio >= 0.55 && upperWick > body * 2) {
    return { type: 'UPPER_WICK_REJECTION', direction: 'SELL', strength: upperRatio >= 0.7 ? 2.0 : 1.2, wickRatio: Math.round(upperRatio * 100) / 100 };
  }
  if (lowerRatio >= 0.55 && lowerWick > body * 2) {
    return { type: 'LOWER_WICK_REJECTION', direction: 'BUY', strength: lowerRatio >= 0.7 ? 2.0 : 1.2, wickRatio: Math.round(lowerRatio * 100) / 100 };
  }
  return null;
}

function detectRoundNumberProximity(lastClose, atr) {
  if (!lastClose || !atr || atr <= 0) return null;
  const levels = [];
  for (const step of [0.00100, 0.00500, 0.01000]) {
    const rounded   = Math.round(lastClose / step) * step;
    const dist      = Math.abs(lastClose - rounded);
    const threshold = atr * 0.3;
    if (dist < threshold) {
      levels.push({
        level:     Math.round(rounded * 100000) / 100000,
        distance:  Math.round(dist * 100000) / 100000,
        stepType:  step === 0.01000 ? 'BIG_FIGURE' : step === 0.00500 ? 'HALF_FIGURE' : 'MINOR',
        proximity: Math.round((1 - dist / threshold) * 100) / 100,
      });
    }
  }
  if (levels.length === 0) return null;
  levels.sort(function(a, b) { return b.proximity - a.proximity; });
  return levels[0];
}

function detectCandleSizeAnomaly(candles) {
  if (!candles || candles.length < 10) return null;
  const last    = candles[candles.length - 1];
  const sample  = candles.slice(-11, -1);
  const avgBody = sample.reduce(function(s, c) { return s + Math.abs(c.close - c.open); }, 0) / sample.length;
  if (avgBody <= 0) return null;
  const lastBody = Math.abs(last.close - last.open);
  const ratio    = lastBody / avgBody;
  if (ratio >= 2.5) {
    return { anomaly: true, bodyRatio: Math.round(ratio * 100) / 100, likelyDirection: last.close > last.open ? 'SELL' : 'BUY', strength: ratio >= 4.0 ? 'STRONG' : 'MODERATE' };
  }
  return null;
}

function getOTCTimeContext() {
  const now    = new Date();
  const minute = now.getUTCMinutes();
  if (minute <= 2 || minute >= 57)  return { quality: 'AVOID',    reason: 'Hour boundary — spike risk',    penaltyPct: 12 };
  if (minute >= 28 && minute <= 32) return { quality: 'MODERATE', reason: 'Half-hour mark',                penaltyPct: 0  };
  if ((minute >= 10 && minute <= 25) || (minute >= 35 && minute <= 55)) return { quality: 'GOOD', reason: 'Stable OTC window', penaltyPct: -3 };
  return { quality: 'NORMAL', reason: 'Standard window', penaltyPct: 0 };
}

function analyzeOTCPatterns(candles, atr, lastClose) {
  const result = { consecutiveCandles: null, wickRejection: null, roundNumber: null, sizeAnomaly: null, timeContext: null, otcBonusUp: 0, otcBonusDown: 0, otcSignals: [], confluenceBonus: 0 };

  const consec = countConsecutiveCandles(candles);
  result.consecutiveCandles = consec;
  if (consec.count >= 3) {
    const reverseDir = consec.direction === 'BUY' ? 'down' : 'up';
    const bonus = consec.count >= 5 ? 1.5 : consec.count >= 4 ? 1.0 : 0.6;
    if (reverseDir === 'up') result.otcBonusUp += bonus; else result.otcBonusDown += bonus;
    result.otcSignals.push('CONSEC_' + consec.count + '_' + consec.direction + '_REVERSAL');
  }

  const wick = detectWickRejection(candles);
  result.wickRejection = wick;
  if (wick) {
    if (wick.direction === 'BUY') result.otcBonusUp += wick.strength; else result.otcBonusDown += wick.strength;
    result.otcSignals.push(wick.type);
  }

  const round = detectRoundNumberProximity(lastClose, atr);
  result.roundNumber = round;
  if (round) {
    result.otcBonusUp   += round.proximity * 0.4;
    result.otcBonusDown += round.proximity * 0.4;
    result.otcSignals.push('ROUND_LEVEL_' + round.stepType);
  }

  const anomaly = detectCandleSizeAnomaly(candles);
  result.sizeAnomaly = anomaly;
  if (anomaly) {
    const bonus = anomaly.strength === 'STRONG' ? 1.2 : 0.7;
    if (anomaly.likelyDirection === 'BUY') result.otcBonusUp += bonus; else result.otcBonusDown += bonus;
    result.otcSignals.push('SIZE_ANOMALY_' + anomaly.strength);
  }

  result.timeContext = getOTCTimeContext();

  const upC  = [wick && wick.direction === 'BUY' ? 1 : 0, consec.count >= 3 && consec.direction === 'SELL' ? 1 : 0, anomaly && anomaly.likelyDirection === 'BUY' ? 1 : 0].reduce(function(a,b){return a+b;},0);
  const dnC  = [wick && wick.direction === 'SELL' ? 1 : 0, consec.count >= 3 && consec.direction === 'BUY' ? 1 : 0, anomaly && anomaly.likelyDirection === 'SELL' ? 1 : 0].reduce(function(a,b){return a+b;},0);
  if (upC >= 2)  { result.confluenceBonus =  8; result.otcSignals.push('OTC_CONFLUENCE_BUY');  }
  if (dnC >= 2)  { result.confluenceBonus = -8; result.otcSignals.push('OTC_CONFLUENCE_SELL'); }

  return result;
}

function calculateOTCCandleDuration(indicators, direction, candles, timeframe) {
  const cfg    = OTC_DURATION_CONFIG[timeframe] || { base: 2, min: 1, max: 3 };
  let dur      = cfg.base;
  const rsi    = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr    = safeLastValue(indicators.atr);
  if (rsi    !== null && (rsi > 80 || rsi < 20)) dur -= 1;
  if (stochK !== null && (stochK > 90 || stochK < 10)) dur -= 1;
  if (atr !== null && candles.length > 0) {
    const lc = candles[candles.length - 1].close;
    if (lc > 0 && (atr / lc) * 100 > 0.15) dur -= 1;
  }
  return Math.max(cfg.min, Math.min(cfg.max, dur));
}

function analyzeTimeframeOTC(indicators, candles, timeframe) {
  var result = analyzeTimeframe(indicators, candles, timeframe, ASSET_TYPE.FOREX, null, 'RANGING');
  // rangingWeights = base weights used in analyzeTimeframe('RANGING') — used to reverse-scale scores
  var rangingWeights = { trend: 0.8, momentum: 1.8, macd: 0.8, stochastic: 1.8, bands: 1.4, adx: 0.8, patterns: 1.3, divergence: 1.8, pivots: 1.2, volume: 0.5, sr: 2.2, camarilla: 0.84 };
  // camarilla base = sr_weight(2.2) * 0.6 * volMult(~0.64 avg) ≈ 0.84
  var otcW = OTC_CATEGORY_WEIGHTS;
  var newUpScore = 0; var newDownScore = 0;
  // [v6.8.0] camarilla included — OTC respects round S/R levels strongly
  var cats = ['trend','momentum','macd','stochastic','bands','adx','patterns','divergence','pivots','volume','sr','camarilla'];

  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var catData = result.categoryScores[cat];
    if (!catData) continue;
    var rW  = rangingWeights[cat] || 1.0;
    var otW = otcW[cat] !== undefined ? otcW[cat] : 0;
    if (rW > 0) {
      var rawUp   = (catData.up   || 0) / rW;
      var rawDown = (catData.down || 0) / rW;
      newUpScore   += rawUp   * otW;
      newDownScore += rawDown * otW;
      result.categoryScores[cat] = Object.assign({}, catData, { up: r2(rawUp * otW), down: r2(rawDown * otW), otcWeight: otW });
    }
  }

  var scoreDiff  = Math.abs(newUpScore - newDownScore);
  var upCatCount = 0; var downCatCount = 0;
  for (var ci2 = 0; ci2 < cats.length; ci2++) {
    var catD = result.categoryScores[cats[ci2]];
    if (!catD) continue;
    if ((catD.up || 0) > (catD.down || 0) && Math.abs((catD.up || 0) - (catD.down || 0)) >= CONFIG.MIN_CATEGORY_SCORE) upCatCount++;
    else if ((catD.down || 0) > (catD.up || 0) && Math.abs((catD.down || 0) - (catD.up || 0)) >= CONFIG.MIN_CATEGORY_SCORE) downCatCount++;
  }

  var confluence = Math.max(upCatCount, downCatCount);
  var direction;
  if (newUpScore >= OTC_SCORE_THRESHOLD && newUpScore > newDownScore && upCatCount >= OTC_MIN_CONFLUENCE) direction = 'BUY';
  else if (newDownScore >= OTC_SCORE_THRESHOLD && newDownScore > newUpScore && downCatCount >= OTC_MIN_CONFLUENCE) direction = 'SELL';
  else if (scoreDiff >= 3.0 && confluence >= 3) direction = newUpScore > newDownScore ? 'BUY' : 'SELL';
  else direction = 'NO_TRADE';

  result.direction  = direction;
  result.score      = { up: r2(newUpScore), down: r2(newDownScore), diff: r2(scoreDiff) };
  result.confluence = confluence;
  result.confluenceDetail = { bullish: upCatCount, bearish: downCatCount, total: 11 };
  result.otcWeighted = true;
  return result;
}

async function callCerebrasValidationOTC(pair, engineSignal, snapshot, otcPatterns, env) {
  if (!env || !env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };
  var basePair = getOTCBasePair(pair);
  var otcSummary = [
    '=== OTC CONTEXT ===',
    'Consecutive candles: ' + (otcPatterns.consecutiveCandles ? otcPatterns.consecutiveCandles.count + ' × ' + otcPatterns.consecutiveCandles.direction : 'N/A'),
    'Wick rejection: '  + (otcPatterns.wickRejection  ? otcPatterns.wickRejection.type  + ' (ratio=' + otcPatterns.wickRejection.wickRatio  + ')' : 'NONE'),
    'Round number: '    + (otcPatterns.roundNumber    ? otcPatterns.roundNumber.stepType + ' (proximity=' + otcPatterns.roundNumber.proximity + ')' : 'NONE'),
    'Size anomaly: '    + (otcPatterns.sizeAnomaly    ? 'YES expect ' + otcPatterns.sizeAnomaly.likelyDirection + ' (' + otcPatterns.sizeAnomaly.strength + ')' : 'NONE'),
    'Time quality: '    + (otcPatterns.timeContext     ? otcPatterns.timeContext.quality  + ' — ' + otcPatterns.timeContext.reason : 'N/A'),
    'OTC signals: '     + (otcPatterns.otcSignals.length ? otcPatterns.otcSignals.join(', ') : 'NONE'),
  ].join('\n');

  var prompt = [
    '=== OTC BINARY TRADING ANALYSIS ===',
    'Pair: ' + basePair + ' (OTC — Olymp Trade synthetic)',
    'Engine signal: ' + engineSignal.direction + ' @ ' + engineSignal.confidence,
    '',
    '=== IMPORTANT OTC RULES ===',
    '1. SYNTHETIC price — broker controls it. Trend-following is UNRELIABLE.',
    '2. Mean reversion is primary — price returns to mean after extremes.',
    '3. Focus on: patterns, RSI/Stoch extremes, BB touches, S/R bounces.',
    '4. 3+ consecutive same-direction candles = high reversal probability.',
    '5. Long wicks = broker pushed price and pulled back = reversal signal.',
    '',
    '=== INDICATORS ===',
    'EMA alignment: ' + snapshot.emaAlignment,
    'RSI(14): ' + snapshot.rsi,
    'Stoch K/D: ' + snapshot.stochK + ' / ' + snapshot.stochD,
    'Williams %R: ' + snapshot.williamsR,
    'CCI: ' + snapshot.cci,
    'BB %B: ' + snapshot.bbPercentB + '  BW: ' + snapshot.bbBandwidth,
    'MACD hist: ' + snapshot.macdHist,
    'ATR: ' + snapshot.atr,
    'Patterns: ' + (snapshot.patterns.length ? snapshot.patterns.join(', ') : 'NONE'),
    'RSI div: ' + snapshot.rsiDiv + '  MACD div: ' + snapshot.macdDiv,
    'S/R: ' + snapshot.srContext,
    '',
    '=== PRICE STRUCTURE ===',
    '1min: '  + snapshot.structure1min,
    '5min: '  + snapshot.structure5min,
    '15min: ' + snapshot.structure15min,
    '',
    otcSummary,
    '',
    '=== RAW CANDLES ===',
    '1min (20): '  + snapshot.candles1min,
    '5min (20): '  + snapshot.candles5min,
    '',
    'Respond in STRICT JSON only:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var timeoutId  = setTimeout(function() { controller.abort(); }, 8000);
    var res;
    try {
      res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY },
        body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: 120, temperature: 0.05, messages: [{ role: 'user', content: prompt }] }),
      });
    } finally { clearTimeout(timeoutId); }
    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };
    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: 'EMPTY_RESPONSE' };
    text = text.replace(/```json|```/g, '').trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'PARSE_ERROR', raw: text.slice(0, 100) };
    var parsed   = JSON.parse(jsonMatch[0]);
    var validSig = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSig    = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!validSig.includes(aiSig)) aiSig = 'NO_TRADE';
    var aiConf   = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return { status: 'OK', signal: aiSig, confidence: aiConf, reason: parsed.reason || null, concerns: parsed.concerns || null, model: 'cerebras/llama3.1-8b', mode: 'OTC' };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

async function buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env) {
  const now       = new Date();
  const tfResults = {};
  const votes     = [];

  let htfContext = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfInd  = calculateAllIndicators(candleData['15min']);
    const htfEma5 = safeLastValue(htfInd.ema5);
    const htfEma20= safeLastValue(htfInd.ema20);
    if (htfEma5 !== null && htfEma20 !== null) htfContext = htfEma5 > htfEma20 ? 'BUY_BIAS' : 'SELL_BIAS';
  }

  const tfKeys = Object.keys(candleData);
  for (let t = 0; t < tfKeys.length; t++) {
    const tf = tfKeys[t]; const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = calculateAllIndicators(candles);
    const analysis   = analyzeTimeframeOTC(indicators, candles, tf);
    const durCandles = calculateOTCCandleDuration(indicators, analysis.direction, candles, tf);
    const candleMin  = CANDLE_MINUTES[tf] || 1;
    const durMins    = durCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durMins * 60000);
    analysis.expiry  = { candles: durCandles, candleSize: candleMin + 'min', totalMinutes: durMins, expiryTime: expiryTime.toISOString(), humanReadable: formatDuration(durMins), nextCandleClose: getNextCandleClose(now, candleMin).toISOString(), countdown: getCandleCountdown(candleMin) };
    const lastCandle  = candles[candles.length - 1];
    analysis.entry    = { price: lastCandle.close, candleTime: lastCandle.datetime, candleDirection: lastCandle.close >= lastCandle.open ? 'BULLISH' : 'BEARISH' };
    analysis.higherTFTrend  = htfContext;
    analysis.alignedWithHTF = true;
    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf: tf, alignedWithHTF: true });
  }

  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0;
  const activeDirs = [];
  for (let v = 0; v < votes.length; v++) {
    const vote = votes[v];
    const w    = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * otcCandleQuality; // candle quality applied
    if (vote.direction === 'BUY')       { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell     += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else                                { weightedNoTrade  += w; }
  }

  const allBuy  = activeDirs.length > 0 && activeDirs.every(function(d){return d==='BUY';});
  const allSell = activeDirs.length > 0 && activeDirs.every(function(d){return d==='SELL';});
  let alignment = 'MIXED'; let alignmentBonus = 0;
  if (allBuy)  { alignment = 'ALL_BULLISH'; alignmentBonus = 8; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = 8; }
  else if (activeDirs.length >= 2) {
    const bc = activeDirs.filter(function(d){return d==='BUY';}).length;
    const sc = activeDirs.filter(function(d){return d==='SELL';}).length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = 4; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = 4; }
  }

  let finalDirection; let confidence;
  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    var bd = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = bd > 0 ? Math.round((weightedBuy / bd) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    var sd = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = sd > 0 ? Math.round((weightedSell / sd) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction; confidence = tie.confidence;
  }

  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }
  confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus);

  // Primary candles for OTC pattern analysis — prefer 1min for freshness
  const primaryCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];
  const lastClose      = primaryCandles.length > 0 ? primaryCandles[primaryCandles.length - 1].close : 0;
  const atrVal         = primaryCandles.length > 0 ? safeLastValue(calculateATR(primaryCandles, CONFIG.ATR_PERIOD)) : null;
  const otcPatterns    = analyzeOTCPatterns(primaryCandles, atrVal, lastClose);

  // [v6.8.0] Candle quality also applied in OTC voting
  var otcCandleQuality = getCandleQualityMultiplier(primaryCandles);

  if (finalDirection !== 'NO_TRADE') {
    const pb = finalDirection === 'BUY' ? otcPatterns.otcBonusUp - otcPatterns.otcBonusDown : otcPatterns.otcBonusDown - otcPatterns.otcBonusUp;
    if (pb > 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.round(pb * 3));
    else if (pb < 0) confidence = Math.max(0, confidence + Math.round(pb * 3));
    if (otcPatterns.confluenceBonus !== 0) {
      const bonusDir = otcPatterns.confluenceBonus > 0 ? 'BUY' : 'SELL';
      if (finalDirection === bonusDir) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(otcPatterns.confluenceBonus));
      else { confidence = Math.max(0, confidence - Math.abs(otcPatterns.confluenceBonus)); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
    }
  }

  if (finalDirection !== 'NO_TRADE' && otcPatterns.timeContext) {
    const tp = otcPatterns.timeContext.penaltyPct;
    if (tp > 0) { confidence = Math.max(0, confidence - tp); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
    else if (tp < 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(tp));
  }

  var consistencyMult = 1.0;
  if (primaryCandles.length > 0 && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 3);
    if (consistencyMult < 1.0) confidence = Math.round(confidence * consistencyMult);
  }

  var entryCandlePenalty = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles.length >= 2) {
    var lC = primaryCandles[primaryCandles.length - 1]; var pC = primaryCandles[primaryCandles.length - 2];
    var lBody = Math.abs(lC.close - lC.open); var lRange = (lC.high - lC.low) || 0.00001;
    var bRatio = lBody / lRange; var lBull = lC.close > lC.open; var pBull = pC.close > pC.open;
    var bothAgainst = (finalDirection === 'BUY' && !lBull && !pBull) || (finalDirection === 'SELL' && lBull && pBull);
    if (bothAgainst && bRatio > 0.55) { entryCandlePenalty = true; confidence = Math.max(0, confidence - 10); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
  }

  if (exotic) confidence = Math.max(20, confidence - OTC_EXOTIC_PENALTY);

  var belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < OTC_CONFIDENCE_FLOOR) { belowFloor = true; finalDirection = 'NO_TRADE'; }

  var filtersApplied = [];
  if (belowFloor)              filtersApplied.push('OTC_BELOW_FLOOR (' + OTC_CONFIDENCE_FLOOR + '%)');
  if (alignment === 'MIXED')   filtersApplied.push('MIXED_ALIGNMENT');
  if (entryCandlePenalty)      filtersApplied.push('ENTRY_CANDLE_PENALTY (-10)');
  if (consistencyMult < 1)     filtersApplied.push('CANDLE_INCONSISTENCY (x' + consistencyMult + ')');
  if (exotic)                  filtersApplied.push('EXOTIC_OTC_PENALTY (-' + OTC_EXOTIC_PENALTY + ')');
  if (otcCandleQuality !== 1.0) filtersApplied.push('OTC_CANDLE_QUALITY (x' + otcCandleQuality.toFixed(2) + ')');
  if (otcPatterns.otcSignals.length > 0) filtersApplied.push('OTC_PATTERNS: ' + otcPatterns.otcSignals.join(', '));

  const best = findBestTimeframe(tfResults, finalDirection);
  const recommendations = {};
  const recKeys = Object.keys(tfResults);
  for (let r = 0; r < recKeys.length; r++) {
    const rtf = recKeys[r]; const rec = tfResults[rtf];
    recommendations[rtf] = { direction: rec.direction, score: rec.score, confluence: rec.confluence + '/11', expiry: rec.expiry, entry: rec.entry, patterns: (rec.categoryScores && rec.categoryScores.patterns && rec.categoryScores.patterns.detected) ? rec.categoryScores.patterns.detected : [] };
  }

  const avgConf  = votes.reduce(function(s,v){return s+(v.confluence||0);},0) / Math.max(votes.length,1);
  var bestTFAn   = tfResults[best.timeframe] || null;
  var entryReason = generateEntryReason(finalDirection, bestTFAn ? bestTFAn.categoryScores : {}, bestTFAn ? bestTFAn.indicators : {}, alignment, null, 'RANGING');
  if (otcPatterns.otcSignals.length > 0) entryReason += ' · OTC: ' + otcPatterns.otcSignals.slice(0, 3).join(', ');

  var aiValidation = { status: 'SKIPPED' };
  if (finalDirection !== 'NO_TRADE') {
    var snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    var engSig   = { direction: finalDirection, confidence: confidence + '%', alignment: alignment, bestTF: best.timeframe };
    aiValidation = await callCerebrasValidationOTC(pair, engSig, snapshot, otcPatterns, env);
    if (aiValidation.status === 'OK') {
      const aiAgreed = aiValidation.signal === finalDirection;
      aiValidation.agrees = aiAgreed;
      if (aiAgreed) {
        if (!aiValidation.concerns) { confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + 8); filtersApplied.push('OTC_AI_BOOST: agrees (' + aiValidation.signal + ' ' + aiValidation.confidence + '%)'); }
        else { confidence = Math.max(0, confidence - 5); filtersApplied.push('OTC_AI_AGREE_WITH_CONCERNS: ' + aiValidation.concerns); }
      } else if (aiValidation.signal !== 'NO_TRADE') {
        confidence = Math.max(0, confidence - 20);
        filtersApplied.push('OTC_AI_PENALTY: disagrees (AI=' + aiValidation.signal + ')');
        if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; filtersApplied.push('OTC_BELOW_FLOOR_AFTER_AI'); }
      } else { confidence = Math.max(0, confidence - 10); filtersApplied.push('OTC_AI_SOFT_PENALTY: uncertain'); }
    }
  }

  const finalGrade = getSignalGrade(confidence, avgConf, alignment);
  return {
    finalSignal: finalDirection, confidence: confidence + '%', grade: finalGrade,
    assetType: ASSET_TYPE_OTC, isOTC: true,
    otcNote: 'Synthetic pair — mean reversion + price action. Olymp Trade.',
    marketRegime: 'OTC_SYNTHETIC',
    regimeAdvice: finalDirection === 'NO_TRADE' ? 'OTC — wait for clearer pattern' : 'OTC — short expiry (2-3 candles), price action based',
    marketCondition: ['OTC_SYNTHETIC'], alignment: alignment,
    higherTFTrend: htfContext || 'N/A (OTC — not used)',
    entryReason: entryReason, filtersApplied: filtersApplied, newsBlackout: null,
    aiValidation: aiValidation,
    session: { sessions: ['OTC_24/7'], quality: 'N/A' },
    otcPatterns: { consecutiveCandles: otcPatterns.consecutiveCandles, wickRejection: otcPatterns.wickRejection, roundNumber: otcPatterns.roundNumber, sizeAnomaly: otcPatterns.sizeAnomaly, timeContext: otcPatterns.timeContext, signals: otcPatterns.otcSignals, confluenceBonus: otcPatterns.confluenceBonus },
    recommendations: recommendations, bestTimeframe: best,
    votes: { BUY: votes.filter(function(v){return v.direction==='BUY';}).length, SELL: votes.filter(function(v){return v.direction==='SELL';}).length, NO_TRADE: votes.filter(function(v){return v.direction==='NO_TRADE';}).length, total: votes.length, weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade) },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults, method: 'OTC_HYBRID_v6.8.0', generatedAt: now.toISOString(),
  };
}

async function handleSignalRawOTC(pair, env, ctx) {
  const basePair = getOTCBasePair(pair);
  const exotic   = isExoticPair(basePair);
  const session  = detectTradingSession();
  const timeframes = ['1min', '5min', '15min'];
  const candleData = {}; const errors = {};
  let totalFailures = 0; let cacheHits = 0;

  const tfFetches = await Promise.all(timeframes.map(function(tf) {
    return fetchCandlesWithCache(basePair, tf, 100, env, ctx, ASSET_TYPE.FOREX);
  }));

  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i]; const data = tfFetches[i];
    if (data.error) { errors[tf] = data.error; totalFailures++; }
    else { if (data._fromCache) cacheHits++; candleData[tf] = data.candles || data; }
  }

  if (totalFailures === timeframes.length) {
    return { pair: pair, assetType: ASSET_TYPE_OTC, isOTC: true, signal: generateDummySignal(pair), source: 'DUMMY_FALLBACK', errors: errors, timestamp: new Date().toISOString() };
  }

  const signal = await buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env);
  if (exotic) signal.exoticWarning = 'Exotic OTC pair. Very high spreads. Confidence heavily reduced.';

  const dataStatus = {};
  for (let j = 0; j < timeframes.length; j++) {
    const tfk = timeframes[j];
    dataStatus[tfk] = candleData[tfk] ? candleData[tfk].length + ' candles (from ' + basePair + ')' : 'FAILED: ' + (errors[tfk] || 'unknown');
  }

  const otcResult = {
    pair: pair, basePair: basePair, assetType: ASSET_TYPE_OTC, isOTC: true,
    otcBroker: 'Olymp Trade (synthetic price)',
    marketStatus: 'OPEN (OTC 24/7)',
    session: session, isExoticPair: exotic, signal: signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    dataNote: 'Candle data from ' + basePair + ' (real market). OTC price may differ.',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits: cacheHits, dataStatus: dataStatus,
  };

  // [v6.9.0] Save OTC signal to history (manual result reporting via /api/report)
  if (signal.finalSignal !== 'NO_TRADE' && env.SIGNAL_CACHE && ctx) {
    ctx.waitUntil(saveSignalToHistory(otcResult, env));
  }

  return otcResult;
}

// ============================================================
// [v6.9.0] PHASE 2 — SIGNAL HISTORY & WIN/LOSS TRACKING
// ============================================================

// Generate unique signal ID
function generateSignalId(pair, timestamp) {
  var ts   = new Date(timestamp).getTime();
  var hash = pair.replace(/[^A-Z]/g, '').slice(0, 6);
  var rand = Math.floor(Math.random() * 9000 + 1000);
  return hash + '_' + ts + '_' + rand;
}

// ============================================================
// H1 — Save signal to KV history
// ============================================================
async function saveSignalToHistory(result, env) {
  if (!env.SIGNAL_CACHE) return;

  try {
    var pair      = result.pair;
    var signal    = result.signal;
    var isOTC     = result.isOTC || false;
    var now       = result.timestamp || new Date().toISOString();
    var signalId  = generateSignalId(pair, now);

    // Best TF expiry time — used for result checking
    var expiryTime = null;
    var bestTF     = signal.bestTimeframe;
    if (bestTF && bestTF.expiry && bestTF.expiry.expiryTime) {
      expiryTime = bestTF.expiry.expiryTime;
    }

    // Entry price from best TF
    var entryPrice = null;
    if (bestTF && bestTF.expiry) {
      var btfKey = bestTF.timeframe;
      var btfRec = signal.recommendations && signal.recommendations[btfKey];
      if (btfRec && btfRec.entry) entryPrice = btfRec.entry.price;
    }

    var record = {
      id:           signalId,
      pair:         pair,
      isOTC:        isOTC,
      direction:    signal.finalSignal,
      confidence:   signal.confidence,
      grade:        signal.grade ? signal.grade.grade : 'N/A',
      entryPrice:   entryPrice,
      expiryTime:   expiryTime,
      bestTF:       bestTF ? bestTF.timeframe : 'N/A',
      alignment:    signal.alignment,
      marketRegime: signal.marketRegime,
      session:      result.session ? result.session.sessions : [],
      sessionQuality: result.session ? result.session.quality : 'N/A',
      aiAgreed:     signal.aiValidation ? signal.aiValidation.combinedAgreed : null,
      timestamp:    now,
      result:       null,   // WIN / LOSS / UNKNOWN — filled later
      exitPrice:    null,
      checkedAt:    null,
    };

    // Save to pair history list
    var histKey  = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var existing = null;
    try {
      existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    } catch(e) { existing = null; }

    var history = Array.isArray(existing) ? existing : [];
    history.unshift(record); // newest first
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR) {
      history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
    }

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    // Save to pending queue (for result checking) — only non-OTC
    if (!isOTC && expiryTime) {
      var pendingKey = HISTORY_CONFIG.KV_PENDING_PREFIX + signalId;
      await env.SIGNAL_CACHE.put(pendingKey, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 2, // 2 hours — auto cleanup
      });
    }

    console.log('Signal saved:', signalId, pair, signal.finalSignal);
  } catch(e) {
    console.warn('saveSignalToHistory error:', e.message);
  }
}

// ============================================================
// H2 — Scheduled Cron Tracker
// Runs every minute — checks expired pending signals
// ============================================================
async function scheduledTracker(env) {
  if (!env.SIGNAL_CACHE) return;

  try {
    // List all pending signal keys
    var pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return;

    var now = Date.now();
    var checked = 0;

    for (var ki = 0; ki < pendingList.keys.length; ki++) {
      var kvKey = pendingList.keys[ki].name;
      try {
        var record = await env.SIGNAL_CACHE.get(kvKey, 'json');
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvKey);
          continue;
        }

        var expiryMs  = new Date(record.expiryTime).getTime();
        var checkAfterMs = expiryMs + (HISTORY_CONFIG.RESULT_CHECK_DELAY * 1000);

        // Not expired yet — skip
        if (now < checkAfterMs) continue;

        // Expired — fetch result candle price
        var exitPrice = await fetchExpiryPrice(record.pair, record.expiryTime, env);
        if (exitPrice === null) {
          // Price fetch failed — mark UNKNOWN and remove pending
          await updateSignalResult(record, 'UNKNOWN', null, env);
          await env.SIGNAL_CACHE.delete(kvKey);
          continue;
        }

        // Determine WIN / LOSS
        var winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null) {
          if (record.direction === 'BUY') {
            winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          } else if (record.direction === 'SELL') {
            winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
          }
        }

        await updateSignalResult(record, winLoss, exitPrice, env);
        await env.SIGNAL_CACHE.delete(kvKey); // Remove from pending
        await updatePairStats(record.pair, winLoss, record, env); // Update stats

        checked++;
        if (checked >= 10) break; // Max 10 per cron run to avoid timeout
      } catch(e) {
        console.warn('Cron check error for ' + kvKey + ':', e.message);
        try { await env.SIGNAL_CACHE.delete(kvKey); } catch(e2) {}
      }
    }

    if (checked > 0) console.log('Cron: checked ' + checked + ' expired signals');
  } catch(e) {
    console.warn('scheduledTracker error:', e.message);
  }
}

// Fetch the close price of the candle at expiry time
async function fetchExpiryPrice(pair, expiryTimeISO, env) {
  try {
    var apiKeys = getApiKeys(env);
    if (apiKeys.length === 0) return null;

    // Use 1min candle — fetch 5 candles around expiry to find the right one
    var symbol   = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
    var apiKey   = apiKeys[0];
    var u = new URL('/time_series', CONFIG.API_BASE_URL);
    u.searchParams.set('symbol',     symbol);
    u.searchParams.set('interval',   '1min');
    u.searchParams.set('outputsize', '5');
    u.searchParams.set('apikey',     apiKey);
    u.searchParams.set('format',     'JSON');

    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 8000);
    var res;
    try {
      res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    } finally { clearTimeout(tid); }

    if (!res.ok) return null;
    var data = await res.json();
    if (!data.values || !Array.isArray(data.values) || data.values.length === 0) return null;

    // Find candle closest to expiry time
    var expiryMs = new Date(expiryTimeISO).getTime();
    var closest  = null;
    var minDiff  = Infinity;

    for (var i = 0; i < data.values.length; i++) {
      var c    = data.values[i];
      var cMs  = new Date(c.datetime).getTime();
      var diff = Math.abs(cMs - expiryMs);
      if (diff < minDiff) { minDiff = diff; closest = c; }
    }

    // Accept if within 2 minutes of expiry
    if (closest && minDiff <= 120000) {
      return parseFloat(closest.close);
    }
    return null;
  } catch(e) {
    console.warn('fetchExpiryPrice error:', e.message);
    return null;
  }
}

// Update signal result in pair history KV
async function updateSignalResult(record, winLoss, exitPrice, env) {
  try {
    var histKey  = HISTORY_CONFIG.KV_SIGNAL_PREFIX + record.pair.replace(/\//g, '_').replace(/-/g, '_');
    var existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(existing)) return;

    for (var i = 0; i < existing.length; i++) {
      if (existing[i].id === record.id) {
        existing[i].result    = winLoss;
        existing[i].exitPrice = exitPrice;
        existing[i].checkedAt = new Date().toISOString();
        break;
      }
    }

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(existing), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  } catch(e) {
    console.warn('updateSignalResult error:', e.message);
  }
}

// ============================================================
// H3 — Dynamic Confidence Adjustment per Pair
// Last N signal এর win rate দেখে confidence adjust করে
// ============================================================
async function getDynamicConfidenceAdjustment(pair, env) {
  if (!env.SIGNAL_CACHE) return 0;

  try {
    var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');
    if (!stats || typeof stats.winRate !== 'number' || stats.sampleSize < 5) return 0;

    var wr = stats.winRate;

    if (wr >= 0.70) return HISTORY_CONFIG.CONFIDENCE_BONUS;          // 70%+ → +6
    if (wr >= HISTORY_CONFIG.CONFIDENCE_BONUS_THRESHOLD) return 3;   // 65-70% → +3
    if (wr <= 0.35) return HISTORY_CONFIG.CONFIDENCE_PENALTY;        // 35%- → -10
    if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5; // 35-45% → -5
    return 0; // 45-65% → neutral
  } catch(e) {
    return 0;
  }
}

// Update pair stats after result
async function updatePairStats(pair, winLoss, record, env) {
  if (!env.SIGNAL_CACHE || winLoss === 'UNKNOWN') return;
  try {
    var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');

    if (!stats) {
      stats = {
        pair:       pair,
        totalSignals: 0,
        wins:       0,
        losses:     0,
        winRate:    0,
        sampleSize: 0,
        bySession:  {},
        byTF:       {},
        byRegime:   {},
        lastUpdated: null,
      };
    }

    stats.totalSignals++;
    if (winLoss === 'WIN')  stats.wins++;
    if (winLoss === 'LOSS') stats.losses++;

    var decided = stats.wins + stats.losses;
    stats.winRate    = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
    stats.sampleSize = Math.min(decided, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
    stats.lastUpdated = new Date().toISOString();

    // Session breakdown
    var sessions = record.session || [];
    for (var si = 0; si < sessions.length; si++) {
      var sess = sessions[si];
      if (!stats.bySession[sess]) stats.bySession[sess] = { wins: 0, losses: 0, winRate: 0 };
      if (winLoss === 'WIN')  stats.bySession[sess].wins++;
      if (winLoss === 'LOSS') stats.bySession[sess].losses++;
      var sd = stats.bySession[sess].wins + stats.bySession[sess].losses;
      stats.bySession[sess].winRate = sd > 0 ? Math.round((stats.bySession[sess].wins / sd) * 1000) / 1000 : 0;
    }

    // TF breakdown
    var tf = record.bestTF || 'N/A';
    if (!stats.byTF[tf]) stats.byTF[tf] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === 'WIN')  stats.byTF[tf].wins++;
    if (winLoss === 'LOSS') stats.byTF[tf].losses++;
    var td = stats.byTF[tf].wins + stats.byTF[tf].losses;
    stats.byTF[tf].winRate = td > 0 ? Math.round((stats.byTF[tf].wins / td) * 1000) / 1000 : 0;

    // Regime breakdown
    var regime = record.marketRegime || 'UNKNOWN';
    if (!stats.byRegime[regime]) stats.byRegime[regime] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === 'WIN')  stats.byRegime[regime].wins++;
    if (winLoss === 'LOSS') stats.byRegime[regime].losses++;
    var rd = stats.byRegime[regime].wins + stats.byRegime[regime].losses;
    stats.byRegime[regime].winRate = rd > 0 ? Math.round((stats.byRegime[regime].wins / rd) * 1000) / 1000 : 0;

    await env.SIGNAL_CACHE.put(statsKey, JSON.stringify(stats), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 days
    });
  } catch(e) {
    console.warn('updatePairStats error:', e.message);
  }
}

// ============================================================
// H4 — History Endpoint Handler
// GET /api/history?pair=EUR/USD&limit=20
// ============================================================
async function handleHistory(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var rawPair = url.searchParams.get('pair') || 'EUR/USD';
  var pair    = sanitizePair(rawPair);
  if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);

  var limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  try {
    var histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var history = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(history)) history = [];

    var limited  = history.slice(0, limit);
    var decided  = limited.filter(function(s) { return s.result === 'WIN' || s.result === 'LOSS'; });
    var wins     = decided.filter(function(s) { return s.result === 'WIN'; }).length;
    var winRate  = decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 1000 : null;

    return jsonResponse({
      pair:      pair,
      total:     history.length,
      showing:   limited.length,
      decided:   decided.length,
      pending:   limited.filter(function(s) { return s.result === null; }).length,
      winRate:   winRate,
      signals:   limited,
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    return jsonResponse({ error: true, message: 'History fetch error: ' + e.message }, 500);
  }
}

// ============================================================
// H5 — Stats Endpoint Handler
// GET /api/stats?pair=EUR/USD (pair optional — all pairs if omitted)
// ============================================================
async function handleStats(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var rawPair = url.searchParams.get('pair');

  try {
    if (rawPair) {
      // Single pair stats
      var pair = sanitizePair(rawPair);
      if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);

      var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
      var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');

      if (!stats) {
        return jsonResponse({
          pair:    pair,
          message: 'No stats yet. Signal history will build up over time.',
          stats:   null,
          timestamp: new Date().toISOString(),
        });
      }

      // Add dynamic confidence adjustment info
      var confAdj = await getDynamicConfidenceAdjustment(pair, env);
      stats.dynamicConfidenceAdjustment = confAdj > 0 ? '+' + confAdj : String(confAdj);

      return jsonResponse({ pair: pair, stats: stats, timestamp: new Date().toISOString() });
    } else {
      // All pairs — list all stats keys
      var allStats = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_STATS_PREFIX });
      if (!allStats || !allStats.keys || allStats.keys.length === 0) {
        return jsonResponse({ message: 'No stats yet.', pairs: [], timestamp: new Date().toISOString() });
      }

      var summary = [];
      for (var ki = 0; ki < allStats.keys.length; ki++) {
        try {
          var st = await env.SIGNAL_CACHE.get(allStats.keys[ki].name, 'json');
          if (st) summary.push({
            pair:         st.pair,
            winRate:      st.winRate,
            totalSignals: st.totalSignals,
            wins:         st.wins,
            losses:       st.losses,
            lastUpdated:  st.lastUpdated,
          });
        } catch(e) {}
      }

      summary.sort(function(a, b) { return (b.winRate || 0) - (a.winRate || 0); });

      return jsonResponse({
        totalPairs: summary.length,
        pairs:      summary,
        timestamp:  new Date().toISOString(),
      });
    }
  } catch(e) {
    return jsonResponse({ error: true, message: 'Stats error: ' + e.message }, 500);
  }
}

// ============================================================
// H6 — Manual OTC Report Endpoint
// GET /api/report?id=SIGNAL_ID&result=WIN
// OTC এর জন্য — manual win/loss report
// ============================================================
async function handleReport(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var signalId = url.searchParams.get('id');
  var result   = (url.searchParams.get('result') || '').toUpperCase();

  if (!signalId) return jsonResponse({ error: true, message: 'Signal ID required: ?id=SIGNAL_ID' }, 400);
  if (!['WIN', 'LOSS'].includes(result)) {
    return jsonResponse({ error: true, message: 'result must be WIN or LOSS' }, 400);
  }

  try {
    // Search through all history keys to find this signal ID
    var allKeys = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX });
    if (!allKeys || !allKeys.keys || allKeys.keys.length === 0) {
      return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);
    }

    var found = false;
    var foundRecord = null;

    for (var ki = 0; ki < allKeys.keys.length; ki++) {
      try {
        var histKey = allKeys.keys[ki].name;
        var history = await env.SIGNAL_CACHE.get(histKey, 'json');
        if (!Array.isArray(history)) continue;

        for (var i = 0; i < history.length; i++) {
          if (history[i].id === signalId) {
            foundRecord          = history[i];
            history[i].result   = result;
            history[i].checkedAt = new Date().toISOString();
            history[i].reportedManually = true;
            await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), {
              expirationTtl: 60 * 60 * 24 * 30,
            });
            found = true;
            break;
          }
        }
        if (found) break;
      } catch(e) {}
    }

    if (!found) return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);

    // Update stats for this pair
    if (foundRecord) {
      await updatePairStats(foundRecord.pair, result, foundRecord, env);
    }

    return jsonResponse({
      success:  true,
      signalId: signalId,
      pair:     foundRecord ? foundRecord.pair : 'N/A',
      result:   result,
      message:  'Result recorded. Stats updated.',
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    return jsonResponse({ error: true, message: 'Report error: ' + e.message }, 500);
  }
}

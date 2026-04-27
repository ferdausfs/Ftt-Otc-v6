// ============================================================
// TRADING CONFIG — Main tuneable parameters
// Edit here to change confidence floors, timeframes, weights
// ============================================================
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

// ============================================================
// OTC CONFIG — Olymp Trade specific settings (v6.7.0)
// ============================================================

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

// ============================================================
// HISTORY CONFIG — KV storage settings (v6.9.0)
// ============================================================
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

// ============================================================
// SESSION & CORRELATION CONFIG (v6.8.0)
// ============================================================
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

// ============================================================
// ASSET / VOLATILITY / DURATION THRESHOLDS
// ============================================================
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

export {
  CONFIG,
  ASSET_TYPE_OTC, OTC_SUFFIXES, OTC_SUPPORTED_BASE_PAIRS,
  OTC_CATEGORY_WEIGHTS, OTC_SCORE_THRESHOLD, OTC_MIN_CONFLUENCE,
  OTC_CONFIDENCE_FLOOR, OTC_CONFIDENCE_CAP, OTC_EXOTIC_PENALTY, OTC_DURATION_CONFIG,
  HISTORY_CONFIG,
  SESSION_PAIR_WEIGHTS, CORRELATION_GROUPS, NEGATIVE_CORRELATIONS, HIGH_IMPACT_NEWS_WINDOWS,
  ASSET_TYPE, SCORE_THRESHOLDS, VOLATILITY_THRESHOLDS, DURATION_CONFIG,
  CANDLE_MINUTES, TIMEFRAME_MAP,
};

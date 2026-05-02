/**
 * FTT Signal Worker v6.9.1 — All configuration & constants
 */

export const CONFIG = {
  API_BASE_URL: 'https://api.twelvedata.com',
  REFRESH_INTERVAL: 60000,
  REQUEST_TIMEOUT: 12000,
  MAX_RETRIES: 3,

  MIN_CONFLUENCE: 5,
  MIN_CATEGORY_SCORE: 0.3,
  MIN_CONFIDENCE_FLOOR: 72,
  VOLUME_SPIKE_FILTER_MULTIPLIER: 2.8,

  NEWS_BLACKOUT_MINUTES: 15,
  BATCH_MAX_PAIRS: 3,

  CACHE_TTL: { '1min': 60, '5min': 300, '15min': 900 },

  RATE_LIMIT_MAX_REQUESTS: 30,
  RATE_LIMIT_WINDOW_SECONDS: 60,

  ATR_PERIOD: 14, RSI_PERIOD: 14, STOCH_PERIOD: 14,
  STOCH_SMOOTH_K: 3, STOCH_SMOOTH_D: 3, ADX_PERIOD: 14,
  CCI_PERIOD: 20, MFI_PERIOD: 14, WILLIAMS_PERIOD: 14,
  BB_PERIOD: 20, BB_STD_DEV: 2,

  DIVERGENCE_LOOKBACK: 30,
  DIVERGENCE_MIN_BARS: 5,

  CATEGORY_WEIGHTS: {
    trend: 1.2, momentum: 2.0, macd: 1.0, stochastic: 1.8,
    bands: 1.2, adx: 1.0, patterns: 1.5, divergence: 1.8,
    pivots: 0.8, volume: 0.3, sr: 1.5,
  },

  TF_WEIGHTS: { '15min': 1.5, '5min': 2.5, '1min': 2.0 },

  EXOTIC_CURRENCIES: [
    'TRY','ZAR','MXN','BRL','PLN','HUF','CZK','RON','BGN',
    'HRK','ISK','RUB','UAH','CNH','CNY','KRW','TWD','THB',
    'MYR','PHP','IDR','INR','VND','PKR','BDT','LKR','CLP',
    'COP','PEN','ARS','EGP','NGN','KES','GHS','TZS','UGX','MAD',
  ],
  EXOTIC_CONFIDENCE_PENALTY: 10,
};

// ── OTC CONFIG ──────────────────────────────────────────────
export const ASSET_TYPE_OTC = 'FOREX_OTC';
export const OTC_SUFFIXES = ['-OTC', 'OTC'];

export const OTC_SUPPORTED_BASE_PAIRS = [
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','USD/CAD','AUD/USD','NZD/USD',
  'EUR/GBP','EUR/JPY','EUR/CHF','EUR/AUD','EUR/CAD','EUR/NZD',
  'GBP/JPY','GBP/CHF','GBP/AUD','GBP/CAD','GBP/NZD',
  'AUD/JPY','AUD/CHF','AUD/CAD','AUD/NZD',
  'NZD/JPY','NZD/CHF','NZD/CAD','CAD/JPY','CAD/CHF','CHF/JPY',
  'USD/SEK','USD/NOK','USD/DKK','USD/SGD','USD/HKD',
  'USD/TRY','USD/ZAR','USD/MXN',
  'EUR/SEK','EUR/NOK','EUR/PLN','EUR/TRY',
];

export const OTC_CATEGORY_WEIGHTS = {
  trend: 0.4, momentum: 2.2, macd: 0.5, stochastic: 2.0,
  bands: 1.8, adx: 0.3, patterns: 2.8, divergence: 1.8,
  pivots: 1.2, volume: 0.0, sr: 2.2, camarilla: 1.5,
};

export const OTC_SCORE_THRESHOLD  = 2.8;
export const OTC_MIN_CONFLUENCE   = 5;
export const OTC_CONFIDENCE_FLOOR = 68;
export const OTC_CONFIDENCE_CAP   = 88;
export const OTC_EXOTIC_PENALTY   = 15;

export const OTC_DURATION_CONFIG = {
  '1min':  { base: 2, min: 2, max: 3 },
  '5min':  { base: 2, min: 2, max: 2 },
  '15min': { base: 1, min: 1, max: 2 },
};

// ── HISTORY CONFIG ──────────────────────────────────────────
export const HISTORY_CONFIG = {
  MAX_SIGNALS_PER_PAIR:           50,
  WIN_RATE_LOOKBACK:              20,
  RESULT_CHECK_DELAY:             90,
  CONFIDENCE_BONUS_THRESHOLD:     0.65,
  CONFIDENCE_PENALTY_THRESHOLD:   0.45,
  CONFIDENCE_BONUS:               6,
  CONFIDENCE_PENALTY:            -10,
  KV_SIGNAL_PREFIX:               'sig:',
  KV_STATS_PREFIX:                'stats:',
  KV_PENDING_PREFIX:              'pending:',
};

// ── SESSION WEIGHTS ─────────────────────────────────────────
export const SESSION_PAIR_WEIGHTS = {
  EUR: { LONDON:1.3, LONDON_NY:1.4, NEW_YORK:1.1, ASIAN:0.8, SYDNEY:0.7 },
  GBP: { LONDON:1.4, LONDON_NY:1.3, NEW_YORK:1.1, ASIAN:0.7, SYDNEY:0.7 },
  JPY: { ASIAN:1.4, ASIAN_LONDON:1.3, LONDON:1.1, NEW_YORK:0.9, SYDNEY:1.2 },
  AUD: { SYDNEY:1.3, ASIAN:1.2, ASIAN_LONDON:1.1, LONDON:0.9, NEW_YORK:0.8 },
  NZD: { SYDNEY:1.3, ASIAN:1.2, ASIAN_LONDON:1.1, LONDON:0.9, NEW_YORK:0.8 },
  CAD: { NEW_YORK:1.3, LONDON_NY:1.4, LONDON:1.0, ASIAN:0.8, SYDNEY:0.7 },
  CHF: { LONDON:1.2, LONDON_NY:1.3, NEW_YORK:1.0, ASIAN:0.8, SYDNEY:0.7 },
  USD: { LONDON_NY:1.4, NEW_YORK:1.3, LONDON:1.1, ASIAN:0.8, SYDNEY:0.7 },
};

export const CORRELATION_GROUPS = [
  ['EUR/USD','GBP/USD','AUD/USD','NZD/USD'],
  ['USD/JPY','USD/CHF','USD/CAD'],
  ['EUR/USD','USD/CHF'],
  ['GBP/USD','EUR/GBP'],
  ['AUD/USD','NZD/USD','AUD/NZD'],
];

export const NEGATIVE_CORRELATIONS = [
  ['EUR/USD','USD/CHF'],
  ['GBP/USD','USD/JPY'],
  ['AUD/USD','USD/CAD'],
];

// ── NEWS WINDOWS ────────────────────────────────────────────
export const HIGH_IMPACT_NEWS_WINDOWS = [
  { days:[1,2,3,4,5], startHour:12, startMin:15, endHour:13, endMin:30, label:'US Economic Data Window' },
  { days:[2,3,4], startHour:17, startMin:45, endHour:19, endMin:30, label:'Central Bank Decision Window' },
  { days:[4], startHour:11, startMin:45, endHour:12, endMin:30, label:'ECB/BOE Rate Window' },
  { days:[0,1], startHour:21, startMin:45, endHour:22, endMin:30, label:'Week Open Spike Window' },
];

// ── ASSET TYPES ─────────────────────────────────────────────
export const ASSET_TYPE = { FOREX: 'FOREX', CRYPTO: 'CRYPTO' };

export const SCORE_THRESHOLDS = { FOREX: 3.0, CRYPTO: 2.5 };

export const VOLATILITY_THRESHOLDS = {
  FOREX: {
    atrVeryHigh:0.20, atrHigh:0.10, atrLow:0.05, atrDead:0.02,
    atrVolatile:0.20, atrDeadMarket:0.02,
    bbSqueeze:0.05, bbHighVol:0.50,
    bbFilterDead:0.03, bbFilterLow:0.05, bbFilterMed:0.08,
    minTradableATR:0.015,
  },
  CRYPTO: {
    atrVeryHigh:5.0, atrHigh:3.0, atrLow:1.0, atrDead:0.15,
    atrVolatile:5.0, atrDeadMarket:0.15,  // was 0.3 — BTC at $78k has ~0.17% ATR normally
    bbSqueeze:0.3, bbHighVol:3.0,          // was 2.0/10.0 — BTC squeeze is ~0.2-0.4%
    bbFilterDead:0.12,  // <0.12% = truly dead (almost no movement)
    bbFilterLow:0.25,   // <0.25% = very tight squeeze
    bbFilterMed:0.50,   // <0.50% = mild squeeze
    minTradableATR:0.05,  // was 0.1 — BTC $39/78k = 0.05%, still tradable
  },
};

export const DURATION_CONFIG = {
  FOREX:  { '1min':{base:2,min:1,max:5}, '5min':{base:2,min:1,max:4}, '15min':{base:1,min:1,max:2} },
  CRYPTO: { '1min':{base:2,min:1,max:4}, '5min':{base:2,min:1,max:3}, '15min':{base:1,min:1,max:2} },
};

export const CANDLE_MINUTES = { '1min':1, '5min':5, '15min':15 };

export const TIMEFRAME_MAP = {
  '1min':'1min', '5min':'5min', '15min':'15min',
  '1m':'1min', '5m':'5min', '15m':'15min',
};

// ── FOREX CURRENCIES ────────────────────────────────────────
export const VALID_FOREX_CURRENCIES = [
  'EUR','USD','GBP','JPY','AUD','NZD','CAD','CHF',
  'SEK','NOK','DKK','PLN','HUF','CZK','RON','BGN','HRK','ISK','RUB','TRY','UAH',
  'HKD','SGD','CNH','CNY','KRW','TWD','THB','MYR','PHP','IDR','INR','VND','PKR','BDT','LKR',
  'MXN','BRL','CLP','COP','PEN','ARS',
  'AED','SAR','ILS','JOD','KWD','BHD','OMR','QAR',
  'ZAR','EGP','NGN','KES','GHS','TZS','UGX','MAD',
];

// ── CRYPTO CONFIG ────────────────────────────────────────────
export const CRYPTO_BASES = [
  'BTC','ETH','BNB','XRP','SOL','ADA','DOGE','AVAX','DOT','LINK',
];
export const CRYPTO_QUOTES = ['USD','EUR','GBP','JPY','USDT','BTC'];
export const POPULAR_CRYPTO_PAIRS = [
  'BTC/USD','ETH/USD','BNB/USD','XRP/USD','SOL/USD',
  'ADA/USD','DOGE/USD','AVAX/USD','DOT/USD','LINK/USD',
  'BTC/EUR','ETH/EUR','BTC/GBP','ETH/GBP',
  'ETH/BTC','BNB/BTC','XRP/BTC','SOL/BTC',
  'ADA/BTC','DOGE/BTC','AVAX/BTC','DOT/BTC','LINK/BTC',
];

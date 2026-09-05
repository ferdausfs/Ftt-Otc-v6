/**
 * FTT Signal Worker FTT3-v1.0.0 — configuration.
 *
 * FTT3 is a full replacement engine: three conditions on three timeframes and
 * an ATR-percentile expiry ladder, nothing else. This file holds ONLY plumbing
 * constants (fetch, cache, scan cadence, history KV layout) plus the fixed
 * asset vocabularies the pair sanitizer needs. Every strategy constant lives
 * in src/strategy/engine.mjs and is committed there.
 */

export const CONFIG = {
  ENGINE: 'FTT3',
  VERSION: 'FTT3-v1.0.0',

  API_BASE_URL: 'https://api.twelvedata.com',
  REQUEST_TIMEOUT: 12000,

  // Timeframes the engine reads. The engine itself defines the indicators.
  TIMEFRAME_MAP: { '1min': '1min', '5min': '5min', '15min': '15min' },
  // Candle windows fetched per scan (cache-keyed by pair+tf+limit).
  FETCH_LIMITS: { '1min': 150, '5min': 60, '15min': 80 },
  // KV cache TTL per interval (seconds). 1min stays just under one candle so
  // the */2 result checker always sees a fresh last candle.
  CACHE_TTL: { '1min': 50, '5min': 240, '15min': 840 },

  // Rate limiting (middleware/rateLimit.js — unchanged plumbing).
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_MAX_REQUESTS: 30,
};

// Top-level alias: fetch/candles.js imports TIMEFRAME_MAP directly.
export const TIMEFRAME_MAP = CONFIG.TIMEFRAME_MAP;

/**
 * Scanned universe = exactly the pairs the FTT3 backtest validated
 * (4 crypto + 4 forex, real markets only — no OTC anywhere in FTT3).
 */
export const SCAN_PAIRS = [
  'BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD',
];

/** every-5-minutes scanner settings (kept from the previous worker's proven cadence). */
export const SCAN_CONFIG = {
  KV_LATEST_PREFIX: 'latest:',
  LATEST_TTL_SECONDS: 600,        // 10 min = 2x cron interval
  BATCH_SIZE: 4,                  // parallel pairs per batch
  BATCH_DELAY_MS: 400,
  MAX_SCAN_DURATION_MS: 55000,    // hard stop per cron tick
  SCAN_INTERVAL_SECONDS: 300,     // mirrors the */5 cron
};

/** Signal history + result checking (KV layout unchanged from the old worker). */
export const HISTORY_CONFIG = {
  MAX_SIGNALS_PER_PAIR: 500,
  WIN_RATE_LOOKBACK: 20,
  RESULT_CHECK_DELAY: 90,         // seconds after expiryTime before first check
  KV_SIGNAL_PREFIX: 'sig:',
  KV_STATS_PREFIX: 'stats:',
  KV_PENDING_PREFIX: 'pending:',
  PENDING_TTL_MS: 2 * 60 * 60 * 1000,
  PENDING_MAX_CHECKS: 10,         // transient-fetch retry budget before UNKNOWN
};

// ── Asset vocabularies (unchanged — the pair sanitizer depends on these) ────
export const ASSET_TYPE = { FOREX: 'FOREX', CRYPTO: 'CRYPTO' };
export const ASSET_TYPE_OTC = 'FOREX_OTC';
export const OTC_SUFFIXES = ['-OTC', 'OTC'];

export const VALID_FOREX_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'RON', 'BGN', 'HRK', 'ISK', 'RUB', 'TRY', 'UAH',
  'HKD', 'SGD', 'CNH', 'CNY', 'KRW', 'TWD', 'THB', 'MYR', 'PHP', 'IDR', 'INR',
  'MXN', 'BRL', 'CLP', 'COP', 'ARS', 'PKR', 'BDT', 'LKR', 'EGP', 'NGN', 'KES', 'GHS',
  'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'ILS', 'ZAR', 'VND',
];

export const CRYPTO_BASES = [
  'BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK',
];

export const CRYPTO_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'USDT', 'BTC'];

export const POPULAR_CRYPTO_PAIRS = [
  'BTC/USD', 'ETH/USD', 'BNB/USD', 'XRP/USD', 'SOL/USD',
  'ADA/USD', 'DOGE/USD', 'AVAX/USD', 'DOT/USD', 'LINK/USD',
  'BTC/EUR', 'ETH/EUR', 'BTC/GBP', 'ETH/GBP',
  'ETH/BTC', 'BNB/BTC', 'XRP/BTC', 'SOL/BTC',
];

export const EXOTIC_CURRENCIES = [
  'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'TRY', 'ZAR', 'MXN', 'SGD', 'HKD', 'CNH', 'THB', 'INR', 'BRL',
];

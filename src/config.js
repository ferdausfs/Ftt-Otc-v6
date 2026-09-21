/**
 * FTT Signal Worker UT-BOT-v1.0.0 — configuration.
 *
 * Live engine: UT Bot Alerts (src/strategy/utBotAlerts.mjs) — an exact port
 * of the TradingView indicator (defaults a=1, c=10, Heikin Ashi off), event-
 * driven on candle closes. The retired FTT3 engine lives on in
 * src/strategy/engine.mjs + git history for the audit record; it is no
 * longer imported by the live signal path. This file holds ONLY plumbing
 * constants (fetch, cache, scan cadence, history KV layout, UT Bot config
 * store) plus the fixed asset vocabularies the pair sanitizer needs.
 */

export const CONFIG = {
  ENGINE: 'UT-BOT',              // primary engine (history ledger back-compat)
  VERSION: 'MULTI-IND-v1.7.1',

  API_BASE_URL: 'https://api.twelvedata.com',
  REQUEST_TIMEOUT: 12000,

  // Timeframes the engine reads. The engine itself defines the indicators.
  TIMEFRAME_MAP: { '1min': '1min', '5min': '5min', '15min': '15min' },
  // Candle windows fetched per scan (cache-keyed by pair+tf+limit).
  // 300 bars = UT Bot lead-in depth (see CONFIG.UTBOT.WINDOW_BARS).
  // 520 rows: MKR tv mode re-fits over the newest 500 CLOSED candles
  // (script max_bars_back = 500) — same call count, bigger window.
  FETCH_LIMITS: { '1min': 520, '5min': 520, '15min': 520 },
  // KV cache TTL per interval (seconds). 1min stays just under one candle so
  // manual re-polls always see a fresh last candle.
  CACHE_TTL: { '1min': 50, '5min': 240, '15min': 840 },

  // Rate limiting (middleware/rateLimit.js — unchanged plumbing).
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_MAX_REQUESTS: 30,

  // ── UT Bot Alerts (primary indicator) ─────────────────────────────────────
  // Indicator defaults = TradingView defaults (a=1 Key Value, c=10 ATR
  // period, Heikin Ashi out of scope). Per-pair overrides come from the KV
  // config store (utbot:config), written by the app's toggle UI.
  // CFD mode: NO expiry anywhere — a setup stands until the indicator flips.
  UTBOT: {
    TIMEFRAMES: ['1min', '5min', '15min'],
    DEFAULT_TIMEFRAME: '15min',
    DEFAULT_A: 1,
    DEFAULT_C: 10,
    KV_CONFIG_KEY: 'utbot:config',
    KV_LASTSCAN_PREFIX: 'utbot:lastscan:',
    // Window depth: the Wilder ATR / trailing-stop recursion is path-
    // dependent; 300 bars of lead-in puts the seed influence below 1e-12
    // (decays as (1-1/c)^bars for c=10), matching TradingView's full-history
    // computation to float precision.
    WINDOW_BARS: 300,
    LAG_RETRIES: 3,              // same boundary-lag retry contract as before
    LAG_SLEEP_MS: 5000,
  },

  // ── Multi Kernel Regression [ChartPrime] (second indicator) ──────────────
  // Non-repaint port (src/strategy/multiKernelRegression.mjs): kernel-
  // weighted MA of the last `bandwidth` closes; labels "Up"/"Down" on the
  // MA's slope flip (ta.crossover/crossunder vs its own prior value).
  // Defaults = TradingView defaults (Laplace, bandwidth 14, source close).
  MKR: {
    DEFAULT_KERNEL: 'Laplace',
    DEFAULT_BANDWIDTH: 14,
    DEFAULT_DEVIATIONS: 2.0,
  },
};

// Top-level alias: fetch/candles.js imports TIMEFRAME_MAP directly.
export const TIMEFRAME_MAP = CONFIG.TIMEFRAME_MAP;

/**
 * Scanned universe (unchanged from the audited universe — 4 crypto + 4
 * forex, real markets only, no OTC). Each pair is individually gated by the
 * UT Bot KV config store (utbot:config); disabled pairs are skipped.
 */
export const SCAN_PAIRS = [
  'BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD',
];

/**
 * Pairs seeded ENABLED in the KV config store — the audited 8. The bot's
 * full universe is much larger (src/utils/pairCatalog.js: majors, minors,
 * exotics, crypto — everything TwelveData serves and the sanitizer accepts);
 * those extra pairs are seeded enabled:false and switched on from the
 * Telegram panel (Select Pair / Search). Keeping the default scan set fixed
 * protects the TwelveData quota: only user-enabled pairs consume credits.
 */
export const DEFAULT_ENABLED_PAIRS = SCAN_PAIRS.slice();

/** every-15-minutes scanner settings (cadence = the 15-min cron; the engine
 *  emits UT Bot events on candle closes instead of FTT3 boundary conditions). */
export const SCAN_CONFIG = {
  KV_LATEST_PREFIX: 'latest:',
  LATEST_TTL_SECONDS: 1800,       // 30 min = 2x cron interval
  BATCH_SIZE: 4,                  // parallel pairs per batch
  BATCH_DELAY_MS: 400,
  MAX_SCAN_DURATION_MS: 55000,    // hard stop per cron tick
  SCAN_INTERVAL_SECONDS: 900,     // mirrors the */15 cron
};

/** Signal history ledger (KV layout unchanged; results are never messaged). */
export const HISTORY_CONFIG = {
  MAX_SIGNALS_PER_PAIR: 500,
  WIN_RATE_LOOKBACK: 20,
  KV_SIGNAL_PREFIX: 'sig:',
  KV_STATS_PREFIX: 'stats:',
  KV_PENDING_PREFIX: 'pending:',
  PENDING_TTL_MS: 2 * 60 * 60 * 1000,
  PENDING_MAX_CHECKS: 10,         // transient-fetch retry budget before UNKNOWN
  // Legacy only: the pre-CFD checker is retired (no */2 cron); the tracker
  // drains any stale pending:<id> records silently if ever invoked.
  RESULT_CHECK_DELAY: 90,
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

/**
 * FTT Signal Worker v6.9.1 — All configuration & constants
 */

export const CONFIG = {
  API_BASE_URL: 'https://api.twelvedata.com',
  REFRESH_INTERVAL: 60000,
  REQUEST_TIMEOUT: 12000,
  // MAX_RETRIES: reserved (fetch layer now uses apiKeys.length; kept for backward-compat)
  MAX_RETRIES: 3,

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE FEATURES (Phase F round 2, 2026-08-10) — INPUT-side multipliers/gates.
  //
  // These are the "missing edge" features: hour-of-day WR context, RSI×direction
  // chasing gate, volatility-state (BB-bandwidth) factor, ATR-percentile state,
  // session-range position, and the pair recent-form gate. They adjust the
  // ENGINE confidence BEFORE the calibrated output layer (calibration.js) maps
  // it to grade/confidence — they never replace or double-calibrate that layer
  // (R3). Every threshold lives here (R4) so the weekly self-calibration refresh
  // is a data change, not a code change.
  //
  // Derivation (TRAIN 08-01..06, n=4462 — see scripts/feature_validation.py):
  //   HOUR_MULTIPLIERS: wr_h / base_wr, clamped [0.85, 1.10], quantized to 1.0
  //     within ±0.02. Bad hours (mult 0.85): 10,15,16,19,20,23. Good (1.10):
  //     01,09,17,21. NOTE: the earlier "bad hours 0-3,10,15,16" hypothesis was
  //     TESTED and REJECTED — hours 0-3 are not bad on TRAIN (01:00 = 48.7% is
  //     the best hour) and the reviewer list REVERSES on HOLDOUT (52.1% vs
  //     45.1%). The train-derived map holds out-of-sample (see PR table).
  //   RSI_DIRECTION_GATE: reviewer instrumented evidence BUY+RSI>55 = 32.3%
  //     (chasing). SELL+RSI<45 slice measured 47.4% (above pool) — flagged for
  //     weekly refresh; shipped symmetric per spec with lighter net effect via
  //     the confidence floor (mode=penalty ×0.85 blocks only sub-85 signals).
  //     Extreme mean-rev logic (<30 / >70) is preserved BY CONSTRUCTION: those
  //     values fall outside the gate's firing range.
  //   VOL_STATE: reviewer instrumented evidence BB>0.8% = 54.3% vs BB 0.2-0.8%
  //     = 35-36% (n=66, provisional). CRYPTO thresholds are the reviewer units;
  //     FOREX scaled ~1/4 (typical forex BB bandwidth 0.03-0.10%).
  //   RECENT_FORM: TRAIN 35.0% (n=1072) vs 44.4% (n=3242) — non-overlapping
  //     CIs; HOLDOUT 43.7% vs 49.8% — consistent direction (+6.1 pts).
  // ─────────────────────────────────────────────────────────────────────────
  EDGE_FEATURES: {
    enabled: true,

    // A1 — hour-of-day confidence multiplier (UTC hour of signal time).
    HOUR_MULTIPLIERS: {
      0: 1.04, 1: 1.10, 2: 1.04, 3: 0.96, 4: 0.96, 5: 0.92,
      6: 1.00, 7: 1.05, 8: 1.04, 9: 1.10, 10: 0.85, 11: 1.00,
      12: 0.95, 13: 1.00, 14: 1.00, 15: 0.85, 16: 0.85, 17: 1.10,
      18: 1.05, 19: 0.85, 20: 0.89, 21: 1.10, 22: 1.08, 23: 0.87,
    },

    // A2 — session-range position: where is price within today's high/low?
    // Near an extreme → mean-reversion bonus; mid → neutral. Needs candle
    // datetimes; no-op when today's candles are insufficient (minCandles) or
    // the day range is flat (minRangePct of price).
    SESSION_RANGE: {
      enabled: true,
      extremeLow: 0.15,       // position <= 0.15 → near the day low
      extremeHigh: 0.85,      // position >= 0.85 → near the day high
      extremeMult: 1.05,      // mean-rev bonus at extremes
      minCandles: 20,
      minRangePct: 0.0005,    // 0.05% of price — flatter days are no-ops
    },

    // B4 — RSI × direction gate (chasing filter).
    // BUY with best-TF RSI > buyMaxRsi → chasing (penalty or block).
    // SELL with best-TF RSI < sellMinRsi → same.
    RSI_DIRECTION_GATE: {
      enabled: true,
      mode: 'penalty',        // 'penalty' (×penaltyMult) | 'block' (hard NO_TRADE)
      buyMaxRsi: 55,
      sellMinRsi: 45,
      penaltyMult: 0.85,
    },

    // B5 — volatility state via BB bandwidth % ((upper-lower)/mid × 100).
    // bb <= deadSqueezeBlock → dead-squeeze: hard block (engine's DEAD_MARKET
    //   soft-block handles the confidence<65 case; this is the strong version).
    // dead < bb <= squeezeMax → mid/choppy squeeze: ×squeezeMult.
    // bb > squeezeMax → high-vol/normal: no penalty.
    VOL_STATE: {
      enabled: true,
      deadSqueezeBlock: { FOREX: 0.04, CRYPTO: 0.20 },
      squeezeMax:       { FOREX: 0.08, CRYPTO: 0.80 },
      squeezeMult: 0.90,
    },

    // B6 — ATR percentile: current ATR vs its own `window`-bar history.
    // pct < squeezePct → squeeze state ×squeezeMult; pct > expansionPct →
    // expansion ×expansionMult; else neutral.
    ATR_PERCENTILE: {
      enabled: true,
      window: 50,
      minSamples: 20,
      squeezePct: 30,
      expansionPct: 80,
      squeezeMult: 0.95,
      expansionMult: 1.05,
    },

    // C8 — recent-form gate: pair rolling-20 WR (worker history, /api/stats).
    // Rolling WR < badWr with >= minSample decided trades → ×badMult.
    RECENT_FORM: {
      enabled: true,
      minSample: 10,
      badWr: 0.35,
      badMult: 0.85,
    },

    // Cumulative multiplier clamps (product of all edge multipliers above).
    MAX_TOTAL_MULT: 1.12,
    MIN_TOTAL_MULT: 0.55,
  },

  // ── SELF-CALIBRATION (C7) — weekly refresh of the calibration tables. ────
  // Mechanism: the Monday 00:00 UTC cron recomputes WR tables from the last
  // WINDOW_DAYS of decided history in KV (sig:*), writes them to calib:latest.
  // The engine reads calib:latest per signal and uses it as the ACTIVE
  // calibration (structWR / confBucketWR for the calibrated output layer, and
  // hourWR for the hour multipliers). Static CALIB + EDGE_FEATURES values are
  // the fallback and the initial values. Refresh cadence: weekly (CRON), or
  // on demand via recomputeCalibration() (admin / test hook).
  SELF_CALIB: {
    enabled: true,
    KV_KEY: 'calib:latest',
    WINDOW_DAYS: 14,          // recompute from the last 14 days, not lifetime
    MIN_OBS: 100,             // < this many decided rows → keep previous tables
    MIN_CELL_OBS: 30,         // per struct/conf-bucket minimum to replace a cell
    MIN_HOUR_OBS: 20,         // per-hour minimum before an hour multiplier overrides
    MAX_AGE_DAYS: 8,          // calib:latest older than this is ignored by the engine
    CRON: '0 0 * * 1',        // Monday 00:00 UTC (wrangler.toml [triggers])
    HOUR_MULT_MIN: 0.85,
    HOUR_MULT_MAX: 1.10,
  },

  MIN_CONFLUENCE: 5,
  MIN_CATEGORY_SCORE: 0.3,
  MIN_CONFIDENCE_FLOOR: 72,

  // Phase F (2026-08-02): D2 bad-pair block SUSPENDED. USD/JPY, AUD/USD, DOT/USD
  // must keep producing forward signals so the Phase F window (7–14 fresh days,
  // ≥50 platform-matched observations) can validate them. Branch stays in code
  // behind this flag for a one-line re-enable after the window.
  D2_BAD_PAIR_BLOCK_ENABLED: false,

  // Phase F (2026-08-15): RANGING + ALIGNED structure is the single biggest
  // losing cell in the forward window (41.2% WR, n=1639, CI 38.9–43.6 — the CI
  // upper bound is decisively below breakeven 55.6%). Blocking it (same D2 hard
  // block mechanism as TRENDING) removes ~39% of signals but lifts pooled WR
  // ~44.3% → ~46.3% (post-calibration era ~48.5% → ~50.4%). Data-backed;
  // evidence: reports/SCORING_INVERSION_AUDIT_2026-08-15.md. Flagged for a
  // one-line rollback (set false) without a redeploy of the branch logic.
  D2_RANGING_ALIGNED_BLOCK_ENABLED: true,

  // Phase F (2026-08-04): Forex SELL probe instrumentation. Tracks every
  // forex SELL with its signal-time context (regime/session/HTF/RSI) in a
  // private KV namespace so the forward window can decide whether forex SELL
  // is systematically wrong — WITHOUT changing production behavior.
  FOREX_SELL_PROBE_ENABLED: true,

  // ── SELECTIVITY GATE (2026-08-21) ──────────────────────────
  // Quality-over-quantity Telegram push filter (evidence-backed, Phase F
  // forward data ~6.3k decided). Controls ONLY the push; history + /api
  // responses still record/return everything (see analysis/selectivity.js).
  //   PENDING_ENTRY (entryDist>=0.05%): 57.9% WR (n=178)  vs INSTANT 46.9%
  //   ATR pctile < 50:                   53.6% WR (n=289)
  //   FOREX:                              34.0% WR (n=949)  vs CRYPTO 45.2%
  //   TRENDING:                           38.8% WR (n=798)
  SELECTIVITY_GATE: {
    enabled: true,              // one-line kill switch
    cryptoOnly: true,           // suppress forex pushes entirely
    excludeTrending: true,      // suppress TRENDING-regime pushes
    requirePendingEntry: true,  // only push wait-for-pullback (dist>=0.05%)
    pendingEntryMinDistancePct: 0.05,
    maxAtrPercentile: 50,       // suppress high-vol (>=50th pctile); null=off
  },
  VOLUME_SPIKE_FILTER_MULTIPLIER: 2.8,

  NEWS_BLACKOUT_MINUTES: 15,
  BATCH_MAX_PAIRS: 3,

  // B0-4: 1min TTL 60 -> 120 (halves 1min API pull rate; cron is */2 so a
  // 120s cache still serves fresh-enough candles for every scheduled tick)
  CACHE_TTL: { '1min': 120, '5min': 300, '15min': 900 },

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

// ── PHASE 7: CRON SIGNAL SCANNER ────────────────────────────
// Pairs the 5-min scanner keeps warm in KV. Every entry was verified live
// against /api/signal on 2026-07-29 — all 14 return FULL_DATA.
// Forex entries are skipped automatically while the market is closed.
export const SCAN_PAIRS = [
  // Crypto — 24/7
  'BTC/USD', 'ETH/USD', 'BNB/USD', 'XRP/USD', 'SOL/USD', 'ADA/USD',
  'DOGE/USD', 'AVAX/USD', 'DOT/USD', 'LINK/USD',
  // Forex majors — market-hours gated
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD',
];

export const SCAN_CONFIG = {
  KV_LATEST_PREFIX:      'latest:',   // distinct from sig: / stats: / pending: / c: / rr: / cb: / quota:
  LATEST_TTL_SECONDS:    600,         // 10 min = 2x cron interval
  BATCH_SIZE:            3,           // parallel pairs per batch (AI rate-limit safety)
  BATCH_DELAY_MS:        500,         // pause between batches
  MAX_SCAN_DURATION_MS:  90000,       // hard stop so one cron tick can never run away
  SCAN_INTERVAL_SECONDS: 300,         // informational, mirrors the */5 cron
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
  MAX_SIGNALS_PER_PAIR:           500,   // Phase 11: raised from 50 for Phase C slice analysis
  WIN_RATE_LOOKBACK:              20,
  RESULT_CHECK_DELAY:             90,
  CONFIDENCE_BONUS_THRESHOLD:     0.65,
  CONFIDENCE_PENALTY_THRESHOLD:   0.45,
  CONFIDENCE_BONUS:               6,
  CONFIDENCE_PENALTY:            -10,
  KV_SIGNAL_PREFIX:               'sig:',
  KV_STATS_PREFIX:                'stats:',
  KV_PENDING_PREFIX:              'pending:',
  // B0-3: pending records live 2h; retry-cap gives up after 15 failed checks
  PENDING_TTL_MS:                 2 * 60 * 60 * 1000,
  PENDING_MAX_CHECKS:             15,
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

// Phase D1: expiry raised to 15-30min (was 1-10min). Short expiry = noise;
// 15-30min lets trends develop and indicators become meaningful.
export const DURATION_CONFIG = {
  FOREX:  { '1min':{base:20,min:15,max:30}, '5min':{base:4,min:3,max:6}, '15min':{base:2,min:1,max:2} },
  CRYPTO: { '1min':{base:20,min:15,max:30}, '5min':{base:4,min:3,max:6}, '15min':{base:2,min:1,max:2} },
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

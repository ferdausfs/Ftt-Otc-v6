var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/analysis/calibration.js
var calibration_exports = {};
__export(calibration_exports, {
  CALIB: () => CALIB,
  CALIB_GRADE_DEFS: () => GRADE_DEFS,
  getCalibratedGradeAndConfidence: () => getCalibratedGradeAndConfidence,
  getCalibratedScore: () => getCalibratedScore,
  scoreToCalibratedConfidence: () => scoreToCalibratedConfidence,
  scoreToGrade: () => scoreToGrade
});
function getConfBucket(confidence) {
  let c = confidence;
  if (typeof c === "string") {
    const m = c.match(/([\d.]+)/);
    if (m) c = parseFloat(m[1]);
  }
  if (typeof c !== "number" || isNaN(c)) c = 72;
  if (c < 75) return "72-75";
  if (c < 80) return "76-79";
  if (c < 84) return "80-83";
  if (c < 88) return "84-87";
  return "88+";
}
function getStructWR(overall, regime, tables) {
  if (regime && CALIB.structWRByRegime[regime]) {
    const v2 = CALIB.structWRByRegime[regime][overall];
    if (typeof v2 === "number") return v2;
  }
  if (!overall) return tables && tables.base || CALIB.base;
  const v = tables && tables.structWR && tables.structWR[overall];
  if (typeof v === "number") return v;
  const s = CALIB.structWR[overall];
  if (typeof s === "number") return s;
  return tables && tables.base || CALIB.base;
}
function getConfBucketWR(bucket, tables) {
  const v = tables && tables.confBucketWR && tables.confBucketWR[bucket];
  if (typeof v === "number") return v;
  const s = CALIB.confBucketWR[bucket];
  if (typeof s === "number") return s;
  return tables && tables.base || CALIB.base;
}
function getCalibratedScore(confidence, structureOverall, regime = null, tables = null) {
  const bucket = getConfBucket(confidence);
  const sWR = getStructWR(structureOverall, regime, tables);
  const cWR = getConfBucketWR(bucket, tables);
  return (sWR + cWR) / 2;
}
function scoreToCalibratedConfidence(score) {
  const t = CALIB.confThresholds;
  const v = CALIB.confValues;
  if (score < t.t1) return v["72-75"];
  if (score < t.t2) return v["76-79"];
  if (score < t.t3) return v["80-83"];
  if (score < t.t4) return v["84-87"];
  return v["88-92"];
}
function scoreToGrade(score) {
  const g = CALIB.gradeThresholds;
  if (score >= g.Aplus) return "A+";
  if (score >= g.A) return "A";
  if (score >= g.B) return "B";
  return "C";
}
function getCalibratedGradeAndConfidence(confidence, structureOverall, regime = null, tables = null) {
  const score = getCalibratedScore(confidence, structureOverall, regime, tables);
  const calConf = scoreToCalibratedConfidence(score);
  const gradeLetter = scoreToGrade(score);
  const grade = { ...GRADE_DEFS[gradeLetter] };
  const order = ["F", "D", "C", "B", "A", "A+"];
  const cap = (g, maxGrade) => {
    const gi = order.indexOf(g.grade);
    const mi = order.indexOf(maxGrade);
    if (gi > mi) {
      const capped = GRADE_DEFS[maxGrade];
      return { ...capped, description: capped.description + " (Structure conflict \u2014 capped from " + g.grade + " to " + maxGrade + ")" };
    }
    return g;
  };
  let finalGrade = grade;
  if (regime === "TRENDING") {
    if (structureOverall === "MIXED") finalGrade = cap(finalGrade, "B");
  } else {
    if (structureOverall === "ALIGNED") {
      finalGrade = cap(finalGrade, "C");
    } else if (structureOverall === "MIXED") {
      finalGrade = cap(finalGrade, "B");
    }
  }
  return {
    score,
    calibratedConfidence: calConf,
    grade: finalGrade
  };
}
var CALIB, GRADE_DEFS;
var init_calibration = __esm({
  "src/analysis/calibration.js"() {
    CALIB = {
      // base WR TRAIN
      base: 0.4175257731958763,
      // struct overall WR TRAIN 08-01..06
      structWR: {
        ALIGNED: 0.39355812783090083,
        AGAINST: 0.46642685851318944,
        MIXED: 0.4214765100671141,
        NEUTRAL: 0.44029850746268656,
        // fallback for unknown / N/A etc
        "N/A": 0.4175257731958763,
        UNKNOWN: 0.4175257731958763
      },
      // REGIME-CONDITIONAL structure WR (2026-08-15, Phase F forward 08-01..15).
      // The pooled structWR above bakes in a RANGING bias (RANGING is ~75% of the
      // window and in RANGING the structure verdict is INVERTED: ALIGNED 41.2% is
      // the worst cell, AGAINST 50.1% the best — mean-reversion). In TRENDING the
      // verdict flips back (ALIGNED 51.4% best). A single pooled table therefore
      // mis-ranks trending signals. Cells with n < 50 are omitted → getStructWR
      // falls back to the pooled table for them (no invented numbers).
      // Source: reports/SCORING_INVERSION_AUDIT_2026-08-15.md.
      structWRByRegime: {
        RANGING: {
          ALIGNED: 0.412,
          // n=1639  CI 38.9-43.6
          AGAINST: 0.501,
          // n=752   CI 46.6-53.7
          MIXED: 0.443,
          // n=1247  CI 41.5-47.0
          NEUTRAL: 0.422
          // n=135   CI 34.2-50.7
        },
        TRENDING: {
          ALIGNED: 0.514,
          // n=245   CI 45.2-57.6
          MIXED: 0.42
          // n=100   CI 32.8-51.8
          // AGAINST/NEUTRAL n<50 → fall back to pooled (no invented cells)
        }
      },
      // raw confidence bucket WR TRAIN
      confBucketWR: {
        "72-75": 0.4164904862579281,
        "76-79": 0.43714609286523215,
        "80-83": 0.3671607753705815,
        "84-87": 0.41927990708478513,
        "88+": 0.44692737430167595
      },
      // grade thresholds on calibrated score (avg(structWR, confBucketWR))
      // derived to make WR(A+)>WR(A)>WR(B)>WR(C) on TRAIN+VAL with n>=50 in VAL
      // TRAIN quantiles gave: A+ >=0.435, A >=0.42, B >=0.385, else C
      // gives TRAIN 47.2>42.7>40.9>32.3, VAL 54.8>51.3>44.7>42.8
      gradeThresholds: {
        Aplus: 0.435,
        A: 0.42,
        B: 0.385
      },
      // confidence thresholds on calibrated score for mapping to 72-92 buckets
      // chosen to make confidence buckets monotonic on TRAIN and VAL
      // thresholds from quantiles that gave TRAIN 37.2<43.1<43.6<43.8<45.9 and VAL 41.4<48.9<50.8<51.4<56.6
      confThresholds: {
        t1: 0.4153521103480665,
        // <t1 => 72-75
        t2: 0.4202427510662884,
        // <t2 => 76-79
        t3: 0.42037820857594965,
        // <t3 => 80-83
        t4: 0.4428533827989873
        // <t4 => 84-87 else 88-92
      },
      // fixed confidence values per bucket (center of bucket) to keep report in 72-92
      confValues: {
        "72-75": 73,
        "76-79": 77,
        "80-83": 81,
        "84-87": 85,
        "88-92": 90
      },
      // version for traceability
      version: "calib-v1-2026-08-09-train-0801-0806",
      trainWindow: "2026-08-01..06",
      holdoutWindow: "2026-08-07..09"
    };
    GRADE_DEFS = {
      "A+": { grade: "A+", label: "EXCELLENT", description: "Very high probability setup \u2014 calibrated." },
      "A": { grade: "A", label: "STRONG", description: "High probability with multiple confirmations \u2014 calibrated." },
      "B": { grade: "B", label: "GOOD", description: "Solid setup. Suitable for trading \u2014 calibrated." },
      "C": { grade: "C", label: "MODERATE", description: "Some conflicts. Trade with caution \u2014 calibrated." },
      "D": { grade: "D", label: "WEAK", description: "Low confidence. Consider skipping." },
      "F": { grade: "F", label: "AVOID", description: "Very weak. Do NOT trade." }
    };
  }
});

// src/utils/cors.js
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
function applyCors(response, corsHeaders = CORS_HEADERS) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: h
  });
}

// src/utils/helpers.js
function safeLastValue(arr) {
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== void 0 && !isNaN(arr[i])) return arr[i];
  }
  return null;
}
function safeLastTwo(arr) {
  if (!arr || arr.length === 0) return { last: null, prev: null };
  let last = null;
  let prev = null;
  let foundFirst = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== void 0 && !isNaN(arr[i])) {
      if (!foundFirst) {
        last = arr[i];
        foundFirst = true;
      } else {
        prev = arr[i];
        break;
      }
    }
  }
  return { last, prev };
}
function safeLastN(arr, n) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
    if (arr[i] !== null && arr[i] !== void 0 && !isNaN(arr[i])) result.unshift(arr[i]);
  }
  return result;
}
function r2(v) {
  return Math.round(v * 100) / 100;
}
function fmt(v, d = 5) {
  return v !== null ? v.toFixed(d) : "N/A";
}
function formatDuration(minutes) {
  if (minutes < 60) return minutes + " min";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? h + "h " + m + "min" : h + "h";
}
function formatTimeUntil(target) {
  const now = /* @__PURE__ */ new Date();
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return "Opening soon...";
  const hours = Math.floor(diff / 36e5);
  const mins = Math.floor(diff % 36e5 / 6e4);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return days + "d " + hours % 24 + "h " + mins + "m";
  }
  return hours + "h " + mins + "m";
}
function getNextCandleClose(now, candleMinutes) {
  const ms = candleMinutes * 6e4;
  const currentSlot = Math.floor(now.getTime() / ms);
  return new Date((currentSlot + 1) * ms);
}
function getCandleCountdown(candleMinutes) {
  const now = Date.now();
  const ms = candleMinutes * 6e4;
  const nextCloseMs = Math.ceil(now / ms) * ms;
  const secondsLeft = Math.max(0, Math.round((nextCloseMs - now) / 1e3));
  return {
    secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    label: secondsLeft >= 60 ? Math.floor(secondsLeft / 60) + "m " + secondsLeft % 60 + "s" : secondsLeft + "s",
    nextCandleClose: new Date(nextCloseMs).toISOString()
  };
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }
  });
}
function generateDummySignal(pair) {
  const seed = ((/* @__PURE__ */ new Date()).getMinutes() + pair.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % 10;
  const dir = seed < 4 ? "BUY" : seed < 8 ? "SELL" : "NO_TRADE";
  return {
    finalSignal: dir,
    confidence: "0%",
    grade: { grade: "F", label: "DUMMY", description: "Fallback \u2014 no real data." },
    marketCondition: ["UNKNOWN"],
    alignment: "NONE",
    recommendations: {},
    bestTimeframe: { timeframe: "N/A" },
    votes: { BUY: 0, SELL: 0, NO_TRADE: 0, total: 0 },
    timeframeAnalysis: {},
    method: "DUMMY_FALLBACK",
    warning: "All API calls failed. Zero reliability."
  };
}

// src/config.js
var CONFIG = {
  API_BASE_URL: "https://api.twelvedata.com",
  REFRESH_INTERVAL: 6e4,
  REQUEST_TIMEOUT: 12e3,
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
      0: 1.04,
      1: 1.1,
      2: 1.04,
      3: 0.96,
      4: 0.96,
      5: 0.92,
      6: 1,
      7: 1.05,
      8: 1.04,
      9: 1.1,
      10: 0.85,
      11: 1,
      12: 0.95,
      13: 1,
      14: 1,
      15: 0.85,
      16: 0.85,
      17: 1.1,
      18: 1.05,
      19: 0.85,
      20: 0.89,
      21: 1.1,
      22: 1.08,
      23: 0.87
    },
    // A2 — session-range position: where is price within today's high/low?
    // Near an extreme → mean-reversion bonus; mid → neutral. Needs candle
    // datetimes; no-op when today's candles are insufficient (minCandles) or
    // the day range is flat (minRangePct of price).
    SESSION_RANGE: {
      enabled: true,
      extremeLow: 0.15,
      // position <= 0.15 → near the day low
      extremeHigh: 0.85,
      // position >= 0.85 → near the day high
      extremeMult: 1.05,
      // mean-rev bonus at extremes
      minCandles: 20,
      minRangePct: 5e-4
      // 0.05% of price — flatter days are no-ops
    },
    // B4 — RSI × direction gate (chasing filter).
    // BUY with best-TF RSI > buyMaxRsi → chasing (penalty or block).
    // SELL with best-TF RSI < sellMinRsi → same.
    RSI_DIRECTION_GATE: {
      enabled: true,
      mode: "penalty",
      // 'penalty' (×penaltyMult) | 'block' (hard NO_TRADE)
      buyMaxRsi: 55,
      sellMinRsi: 45,
      penaltyMult: 0.85
    },
    // B5 — volatility state via BB bandwidth % ((upper-lower)/mid × 100).
    // bb <= deadSqueezeBlock → dead-squeeze: hard block (engine's DEAD_MARKET
    //   soft-block handles the confidence<65 case; this is the strong version).
    // dead < bb <= squeezeMax → mid/choppy squeeze: ×squeezeMult.
    // bb > squeezeMax → high-vol/normal: no penalty.
    VOL_STATE: {
      enabled: true,
      deadSqueezeBlock: { FOREX: 0.04, CRYPTO: 0.2 },
      squeezeMax: { FOREX: 0.08, CRYPTO: 0.8 },
      squeezeMult: 0.9
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
      expansionMult: 1.05
    },
    // C8 — recent-form gate: pair rolling-20 WR (worker history, /api/stats).
    // Rolling WR < badWr with >= minSample decided trades → ×badMult.
    RECENT_FORM: {
      enabled: true,
      minSample: 10,
      badWr: 0.35,
      badMult: 0.85
    },
    // Cumulative multiplier clamps (product of all edge multipliers above).
    MAX_TOTAL_MULT: 1.12,
    MIN_TOTAL_MULT: 0.55
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
    KV_KEY: "calib:latest",
    WINDOW_DAYS: 14,
    // recompute from the last 14 days, not lifetime
    MIN_OBS: 100,
    // < this many decided rows → keep previous tables
    MIN_CELL_OBS: 30,
    // per struct/conf-bucket minimum to replace a cell
    MIN_HOUR_OBS: 20,
    // per-hour minimum before an hour multiplier overrides
    MAX_AGE_DAYS: 8,
    // calib:latest older than this is ignored by the engine
    CRON: "0 0 * * 1",
    // Monday 00:00 UTC (wrangler.toml [triggers])
    HOUR_MULT_MIN: 0.85,
    HOUR_MULT_MAX: 1.1
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
  VOLUME_SPIKE_FILTER_MULTIPLIER: 2.8,
  NEWS_BLACKOUT_MINUTES: 15,
  BATCH_MAX_PAIRS: 3,
  // B0-4: 1min TTL 60 -> 120 (halves 1min API pull rate; cron is */2 so a
  // 120s cache still serves fresh-enough candles for every scheduled tick)
  CACHE_TTL: { "1min": 120, "5min": 300, "15min": 900 },
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
    trend: 1.2,
    momentum: 2,
    macd: 1,
    stochastic: 1.8,
    bands: 1.2,
    adx: 1,
    patterns: 1.5,
    divergence: 1.8,
    pivots: 0.8,
    volume: 0.3,
    sr: 1.5
  },
  TF_WEIGHTS: { "15min": 1.5, "5min": 2.5, "1min": 2 },
  EXOTIC_CURRENCIES: [
    "TRY",
    "ZAR",
    "MXN",
    "BRL",
    "PLN",
    "HUF",
    "CZK",
    "RON",
    "BGN",
    "HRK",
    "ISK",
    "RUB",
    "UAH",
    "CNH",
    "CNY",
    "KRW",
    "TWD",
    "THB",
    "MYR",
    "PHP",
    "IDR",
    "INR",
    "VND",
    "PKR",
    "BDT",
    "LKR",
    "CLP",
    "COP",
    "PEN",
    "ARS",
    "EGP",
    "NGN",
    "KES",
    "GHS",
    "TZS",
    "UGX",
    "MAD"
  ],
  EXOTIC_CONFIDENCE_PENALTY: 10
};
var SCAN_PAIRS = [
  // Crypto — 24/7
  "BTC/USD",
  "ETH/USD",
  "BNB/USD",
  "XRP/USD",
  "SOL/USD",
  "ADA/USD",
  "DOGE/USD",
  "AVAX/USD",
  "DOT/USD",
  "LINK/USD",
  // Forex majors — market-hours gated
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "AUD/USD"
];
var SCAN_CONFIG = {
  KV_LATEST_PREFIX: "latest:",
  // distinct from sig: / stats: / pending: / c: / rr: / cb: / quota:
  LATEST_TTL_SECONDS: 600,
  // 10 min = 2x cron interval
  BATCH_SIZE: 3,
  // parallel pairs per batch (AI rate-limit safety)
  BATCH_DELAY_MS: 500,
  // pause between batches
  MAX_SCAN_DURATION_MS: 9e4,
  // hard stop so one cron tick can never run away
  SCAN_INTERVAL_SECONDS: 300
  // informational, mirrors the */5 cron
};
var ASSET_TYPE_OTC = "FOREX_OTC";
var OTC_CATEGORY_WEIGHTS = {
  trend: 0.4,
  momentum: 2.2,
  macd: 0.5,
  stochastic: 2,
  bands: 1.8,
  adx: 0.3,
  patterns: 2.8,
  divergence: 1.8,
  pivots: 1.2,
  volume: 0,
  sr: 2.2,
  camarilla: 1.5
};
var OTC_SCORE_THRESHOLD = 2.8;
var OTC_MIN_CONFLUENCE = 5;
var OTC_CONFIDENCE_FLOOR = 68;
var OTC_CONFIDENCE_CAP = 88;
var OTC_EXOTIC_PENALTY = 15;
var OTC_DURATION_CONFIG = {
  "1min": { base: 2, min: 2, max: 3 },
  "5min": { base: 2, min: 2, max: 2 },
  "15min": { base: 1, min: 1, max: 2 }
};
var HISTORY_CONFIG = {
  MAX_SIGNALS_PER_PAIR: 500,
  // Phase 11: raised from 50 for Phase C slice analysis
  WIN_RATE_LOOKBACK: 20,
  RESULT_CHECK_DELAY: 90,
  CONFIDENCE_BONUS_THRESHOLD: 0.65,
  CONFIDENCE_PENALTY_THRESHOLD: 0.45,
  CONFIDENCE_BONUS: 6,
  CONFIDENCE_PENALTY: -10,
  KV_SIGNAL_PREFIX: "sig:",
  KV_STATS_PREFIX: "stats:",
  KV_PENDING_PREFIX: "pending:",
  // B0-3: pending records live 2h; retry-cap gives up after 15 failed checks
  PENDING_TTL_MS: 2 * 60 * 60 * 1e3,
  PENDING_MAX_CHECKS: 15
};
var SESSION_PAIR_WEIGHTS = {
  EUR: { LONDON: 1.3, LONDON_NY: 1.4, NEW_YORK: 1.1, ASIAN: 0.8, SYDNEY: 0.7 },
  GBP: { LONDON: 1.4, LONDON_NY: 1.3, NEW_YORK: 1.1, ASIAN: 0.7, SYDNEY: 0.7 },
  JPY: { ASIAN: 1.4, ASIAN_LONDON: 1.3, LONDON: 1.1, NEW_YORK: 0.9, SYDNEY: 1.2 },
  AUD: { SYDNEY: 1.3, ASIAN: 1.2, ASIAN_LONDON: 1.1, LONDON: 0.9, NEW_YORK: 0.8 },
  NZD: { SYDNEY: 1.3, ASIAN: 1.2, ASIAN_LONDON: 1.1, LONDON: 0.9, NEW_YORK: 0.8 },
  CAD: { NEW_YORK: 1.3, LONDON_NY: 1.4, LONDON: 1, ASIAN: 0.8, SYDNEY: 0.7 },
  CHF: { LONDON: 1.2, LONDON_NY: 1.3, NEW_YORK: 1, ASIAN: 0.8, SYDNEY: 0.7 },
  USD: { LONDON_NY: 1.4, NEW_YORK: 1.3, LONDON: 1.1, ASIAN: 0.8, SYDNEY: 0.7 }
};
var CORRELATION_GROUPS = [
  ["EUR/USD", "GBP/USD", "AUD/USD", "NZD/USD"],
  ["USD/JPY", "USD/CHF", "USD/CAD"],
  ["EUR/USD", "USD/CHF"],
  ["GBP/USD", "EUR/GBP"],
  ["AUD/USD", "NZD/USD", "AUD/NZD"]
];
var NEGATIVE_CORRELATIONS = [
  ["EUR/USD", "USD/CHF"],
  ["GBP/USD", "USD/JPY"],
  ["AUD/USD", "USD/CAD"]
];
var HIGH_IMPACT_NEWS_WINDOWS = [
  { days: [1, 2, 3, 4, 5], startHour: 12, startMin: 15, endHour: 13, endMin: 30, label: "US Economic Data Window" },
  { days: [2, 3, 4], startHour: 17, startMin: 45, endHour: 19, endMin: 30, label: "Central Bank Decision Window" },
  { days: [4], startHour: 11, startMin: 45, endHour: 12, endMin: 30, label: "ECB/BOE Rate Window" },
  { days: [0, 1], startHour: 21, startMin: 45, endHour: 22, endMin: 30, label: "Week Open Spike Window" }
];
var ASSET_TYPE = { FOREX: "FOREX", CRYPTO: "CRYPTO" };
var SCORE_THRESHOLDS = { FOREX: 3, CRYPTO: 2.5 };
var VOLATILITY_THRESHOLDS = {
  FOREX: {
    atrVeryHigh: 0.2,
    atrHigh: 0.1,
    atrLow: 0.05,
    atrDead: 0.02,
    atrVolatile: 0.2,
    atrDeadMarket: 0.02,
    bbSqueeze: 0.05,
    bbHighVol: 0.5,
    bbFilterDead: 0.03,
    bbFilterLow: 0.05,
    bbFilterMed: 0.08,
    minTradableATR: 0.015
  },
  CRYPTO: {
    atrVeryHigh: 5,
    atrHigh: 3,
    atrLow: 1,
    atrDead: 0.15,
    atrVolatile: 5,
    atrDeadMarket: 0.15,
    // was 0.3 — BTC at $78k has ~0.17% ATR normally
    bbSqueeze: 0.3,
    bbHighVol: 3,
    // was 2.0/10.0 — BTC squeeze is ~0.2-0.4%
    bbFilterDead: 0.12,
    // <0.12% = truly dead (almost no movement)
    bbFilterLow: 0.25,
    // <0.25% = very tight squeeze
    bbFilterMed: 0.5,
    // <0.50% = mild squeeze
    minTradableATR: 0.05
    // was 0.1 — BTC $39/78k = 0.05%, still tradable
  }
};
var DURATION_CONFIG = {
  FOREX: { "1min": { base: 20, min: 15, max: 30 }, "5min": { base: 4, min: 3, max: 6 }, "15min": { base: 2, min: 1, max: 2 } },
  CRYPTO: { "1min": { base: 20, min: 15, max: 30 }, "5min": { base: 4, min: 3, max: 6 }, "15min": { base: 2, min: 1, max: 2 } }
};
var CANDLE_MINUTES = { "1min": 1, "5min": 5, "15min": 15 };
var TIMEFRAME_MAP = {
  "1min": "1min",
  "5min": "5min",
  "15min": "15min",
  "1m": "1min",
  "5m": "5min",
  "15m": "15min"
};
var VALID_FOREX_CURRENCIES = [
  "EUR",
  "USD",
  "GBP",
  "JPY",
  "AUD",
  "NZD",
  "CAD",
  "CHF",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "HUF",
  "CZK",
  "RON",
  "BGN",
  "HRK",
  "ISK",
  "RUB",
  "TRY",
  "UAH",
  "HKD",
  "SGD",
  "CNH",
  "CNY",
  "KRW",
  "TWD",
  "THB",
  "MYR",
  "PHP",
  "IDR",
  "INR",
  "VND",
  "PKR",
  "BDT",
  "LKR",
  "MXN",
  "BRL",
  "CLP",
  "COP",
  "PEN",
  "ARS",
  "AED",
  "SAR",
  "ILS",
  "JOD",
  "KWD",
  "BHD",
  "OMR",
  "QAR",
  "ZAR",
  "EGP",
  "NGN",
  "KES",
  "GHS",
  "TZS",
  "UGX",
  "MAD"
];
var CRYPTO_BASES = [
  "BTC",
  "ETH",
  "BNB",
  "XRP",
  "SOL",
  "ADA",
  "DOGE",
  "AVAX",
  "DOT",
  "LINK"
];
var CRYPTO_QUOTES = ["USD", "EUR", "GBP", "JPY", "USDT", "BTC"];
var POPULAR_CRYPTO_PAIRS = [
  "BTC/USD",
  "ETH/USD",
  "BNB/USD",
  "XRP/USD",
  "SOL/USD",
  "ADA/USD",
  "DOGE/USD",
  "AVAX/USD",
  "DOT/USD",
  "LINK/USD",
  "BTC/EUR",
  "ETH/EUR",
  "BTC/GBP",
  "ETH/GBP",
  "ETH/BTC",
  "BNB/BTC",
  "XRP/BTC",
  "SOL/BTC",
  "ADA/BTC",
  "DOGE/BTC",
  "AVAX/BTC",
  "DOT/BTC",
  "LINK/BTC"
];

// src/utils/pairs.js
function isOTCInput(input) {
  if (!input || typeof input !== "string") return false;
  const u = input.toUpperCase();
  return u.endsWith("-OTC") || u.endsWith("OTC");
}
function stripOTCSuffix(input) {
  if (!input) return input;
  let s = input.toUpperCase().trim();
  if (s.endsWith("-OTC")) return s.slice(0, -4);
  if (s.endsWith("OTC")) return s.slice(0, -3);
  return s;
}
function getOTCBasePair(pair) {
  if (!pair) return pair;
  if (pair.endsWith("-OTC")) return pair.slice(0, -4);
  return pair;
}
function sanitizePair(input) {
  if (!input || typeof input !== "string") return null;
  const otcFlag = isOTCInput(input);
  const baseInput = otcFlag ? stripOTCSuffix(input) : input;
  const c = baseInput.replace(/[^A-Za-z/]/g, "").toUpperCase();
  const slashPattern = /^[A-Z]{3,}\/[A-Z]{3,}$/;
  if (slashPattern.test(c)) {
    const [b, q] = c.split("/");
    if (!otcFlag && CRYPTO_BASES.includes(b) && (CRYPTO_QUOTES.includes(q) || VALID_FOREX_CURRENCIES.includes(q)) && b !== q) return c;
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q)
      return otcFlag ? b + "/" + q + "-OTC" : c;
    return null;
  }
  if (!otcFlag) {
    for (const base of CRYPTO_BASES) {
      if (c.startsWith(base) && c.length > base.length) {
        const quote = c.slice(base.length);
        if ((CRYPTO_QUOTES.includes(quote) || VALID_FOREX_CURRENCIES.includes(quote)) && base !== quote)
          return base + "/" + quote;
      }
    }
  }
  const noSlashPattern = /^[A-Z]{6}$/;
  if (noSlashPattern.test(c)) {
    const b = c.slice(0, 3);
    const q = c.slice(3, 6);
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q)
      return otcFlag ? b + "/" + q + "-OTC" : b + "/" + q;
  }
  return null;
}
function getAssetType(pair) {
  if (!pair || typeof pair !== "string") return ASSET_TYPE.FOREX;
  if (pair.endsWith("-OTC")) return ASSET_TYPE_OTC;
  const base = pair.split("/")[0] || "";
  if (CRYPTO_BASES.includes(base)) return ASSET_TYPE.CRYPTO;
  return ASSET_TYPE.FOREX;
}
function isExoticPair(pair) {
  if (!pair) return false;
  const [base, quote] = pair.split("/");
  return CONFIG.EXOTIC_CURRENCIES.includes(base || "") || CONFIG.EXOTIC_CURRENCIES.includes(quote || "");
}

// src/middleware/rateLimit.js
async function checkRateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return jsonResponse({ error: true, message: "Rate limit exceeded.", retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS }, 429);
      return null;
    } catch (e) {
      console.warn("Rate limiter err:", e.message);
    }
  }
  if (env.SIGNAL_CACHE) {
    try {
      const kvKey = "rl:" + ip;
      const now = Math.floor(Date.now() / 1e3);
      const stored = await env.SIGNAL_CACHE.get(kvKey, "json");
      let reqs = stored && Array.isArray(stored) ? stored.filter((t) => t > now - CONFIG.RATE_LIMIT_WINDOW_SECONDS) : [];
      if (reqs.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS)
        return jsonResponse({ error: true, message: "Rate limit exceeded.", retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS }, 429);
      reqs.push(now);
      await env.SIGNAL_CACHE.put(kvKey, JSON.stringify(reqs), { expirationTtl: CONFIG.RATE_LIMIT_WINDOW_SECONDS + 10 });
      return null;
    } catch (e) {
      console.warn("KV RL err:", e.message);
      return null;
    }
  }
  return null;
}

// src/utils/session.js
function detectTradingSession() {
  const now = /* @__PURE__ */ new Date();
  const hour = now.getUTCHours();
  const sessions = [];
  if (hour >= 0 && hour < 9) sessions.push("ASIAN");
  if (hour >= 7 && hour < 16) sessions.push("LONDON");
  if (hour >= 12 && hour < 21) sessions.push("NEW_YORK");
  if (hour >= 21 || hour < 6) sessions.push("SYDNEY");
  let overlap = "NONE";
  if (sessions.includes("LONDON") && sessions.includes("NEW_YORK")) overlap = "LONDON_NY";
  else if (sessions.includes("ASIAN") && sessions.includes("LONDON")) overlap = "ASIAN_LONDON";
  let quality = "LOW";
  if (overlap === "LONDON_NY") quality = "HIGHEST";
  else if (sessions.includes("LONDON")) quality = "HIGH";
  else if (sessions.includes("NEW_YORK")) quality = "HIGH";
  else if (overlap === "ASIAN_LONDON") quality = "MEDIUM";
  else if (sessions.includes("ASIAN")) quality = "MEDIUM";
  return { sessions, overlap, quality, hour };
}
function isForexMarketOpen() {
  const now = /* @__PURE__ */ new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;
  return true;
}
function getForexHoliday() {
  const now = /* @__PURE__ */ new Date();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (m === 11 && d === 25) return "Christmas Day";
  if (m === 0 && d === 1) return "New Year's Day";
  return null;
}
function getNextForexOpen() {
  const now = /* @__PURE__ */ new Date();
  const next = new Date(now);
  if (now.getUTCDay() === 0 && now.getUTCHours() < 22) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0));
  }
  while (true) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCDay() === 0) break;
  }
  next.setUTCHours(22, 0, 0, 0);
  return next;
}
function checkNewsBlackout(assetType) {
  if (assetType === ASSET_TYPE.CRYPTO) return null;
  if (assetType === ASSET_TYPE_OTC) return null;
  const now = /* @__PURE__ */ new Date();
  const day = now.getUTCDay();
  const nowTotalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const margin = CONFIG.NEWS_BLACKOUT_MINUTES;
  for (const win of HIGH_IMPACT_NEWS_WINDOWS) {
    if (!win.days.includes(day)) continue;
    const winStart = Math.max(0, win.startHour * 60 + win.startMin - margin);
    const winEnd = Math.min(1439, win.endHour * 60 + win.endMin + margin);
    if (nowTotalMin >= winStart && nowTotalMin <= winEnd) {
      const clearMin = winEnd - nowTotalMin;
      return {
        blocked: true,
        label: win.label,
        minutesUntilClear: clearMin,
        message: "Signal blocked: " + win.label + ". Clears in ~" + clearMin + " min."
      };
    }
  }
  return null;
}

// src/fetch/keys.js
function getApiKeys(env) {
  if (!env) return [];
  const jsonSources = [env.TWELVEDATA_API_KEYS, env.TWELVEDATA_API_KEY];
  for (const src of jsonSources) {
    if (src && typeof src === "string" && src.trim().startsWith("[")) {
      try {
        const keys = JSON.parse(src);
        if (Array.isArray(keys) && keys.length > 0) {
          const filtered = keys.map((k) => String(k).trim()).filter((k) => k.length > 0);
          if (filtered.length > 0) return dedupe(filtered);
        }
      } catch (e) {
        console.warn("API key JSON parse error:", e.message);
      }
    }
  }
  const numbered = [];
  for (const envKey of Object.keys(env)) {
    const m = envKey.match(/^TWELVEDATA_API_KEY_(\d+)$/);
    if (m) {
      const val = env[envKey];
      if (val && typeof val === "string" && val.trim().length > 0) {
        numbered.push({ idx: parseInt(m[1], 10), key: val.trim() });
      }
    }
  }
  if (numbered.length > 0) {
    numbered.sort((a, b) => a.idx - b.idx);
    return dedupe(numbered.map((n) => n.key));
  }
  if (env.TWELVEDATA_API_KEY && typeof env.TWELVEDATA_API_KEY === "string" && !env.TWELVEDATA_API_KEY.trim().startsWith("[")) {
    const single = env.TWELVEDATA_API_KEY.trim();
    return single.length > 0 ? [single] : [];
  }
  return [];
}
function dedupe(arr) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const k of arr) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}
async function getNextRotationIndex(env, keyCount) {
  if (!env || !env.SIGNAL_CACHE || !keyCount || keyCount <= 1) return 0;
  try {
    const raw = await env.SIGNAL_CACHE.get("rr:idx");
    const parsed = parseInt(raw || "0", 10);
    const cur = Number.isFinite(parsed) ? parsed : 0;
    const next = (cur + 1) % keyCount;
    const p = env.SIGNAL_CACHE.put("rr:idx", String(next), { expirationTtl: 7 * 24 * 3600 });
    if (p && typeof p.catch === "function") p.catch(() => {
    });
    return (cur % keyCount + keyCount) % keyCount;
  } catch (e) {
    return 0;
  }
}
async function readRotationIndex(env) {
  if (!env || !env.SIGNAL_CACHE) return -1;
  try {
    const raw = await env.SIGNAL_CACHE.get("rr:idx");
    const parsed = parseInt(raw || "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (e) {
    return -1;
  }
}

// src/history/quota.js
function todayKey() {
  return "quota:" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
async function incrementQuota(env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const key = todayKey();
    const parsed = parseInt(await env.SIGNAL_CACHE.get(key) || "0", 10);
    const cur = Number.isFinite(parsed) ? parsed : 0;
    await env.SIGNAL_CACHE.put(key, String(cur + 1), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) {
  }
}
async function readQuota(env) {
  if (!env || !env.SIGNAL_CACHE) return -1;
  try {
    const parsed = parseInt(await env.SIGNAL_CACHE.get(todayKey()) || "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (e) {
    return -1;
  }
}

// src/history/circuitBreaker.js
var COOLDOWN_MS = 6 * 60 * 60 * 1e3;
var CB_TTL_S = 7 * 24 * 3600;
async function isTripped(pair, env) {
  return { tripped: false, disabled: true };
}
async function applyResult(pair, winLoss, env) {
  return;
}

// src/handlers/pushToSubscribers.js
var PUSH_LOG_PREFIX = "pushLog:";
var PUSH_LOCK_PREFIX = "pushLock:";
var PUSH_LOG_TTL_S = 24 * 3600;
var PUSH_LOCK_TTL_S = 30 * 60;
var LAST_ATTEMPT_KEY = "push:lastAttempt";
var DELIVERED_24H_KEY = "push:delivered24h";
var TOKEN_CHECK_KEY = "push:tokenCheck";
var TOKEN_CHECK_TTL_S = 300;
var TELEGRAM_API = "https://api.telegram.org";
var SELF_URL = "https://fttotcv6.umuhammadiswa.workers.dev";
function botToken(env) {
  return env && env.BOT_TOKEN ? String(env.BOT_TOKEN).trim() : "";
}
function normPair(p) {
  return String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function confPct(sig) {
  return parseInt(String(sig && sig.confidence || "0%").replace("%", ""), 10) || 0;
}
function normalizeAutoUsers(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const entry of raw) {
    if (entry == null) continue;
    if (typeof entry === "number" && isFinite(entry)) {
      ids.push(String(Math.trunc(entry)));
      continue;
    }
    if (typeof entry === "string") {
      const s = entry.trim();
      if (!s) continue;
      ids.push(s.startsWith("u:") ? s.slice(2) : s);
      continue;
    }
    if (typeof entry === "object") {
      const v = entry.chatId ?? entry.id ?? entry.cid ?? entry.chat_id;
      if (v == null) continue;
      const s = String(v).trim();
      if (s) ids.push(s.startsWith("u:") ? s.slice(2) : s);
    }
  }
  return ids;
}
function isAutoEnabled(user) {
  if (!user) return false;
  return user.autoEnabled === true || user.autoEnabled === 1 || user.autoEnabled === "true";
}
function lockKey(chatId, signal) {
  return PUSH_LOCK_PREFIX + chatId + ":" + normPair(signal.pair) + ":" + signal.signal.finalSignal;
}
async function releasePushLock(chatId, signal, env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    await env.SIGNAL_CACHE.delete(lockKey(chatId, signal));
  } catch (e) {
    console.warn("push: lock release failed: " + e.message);
  }
}
async function recordPushAttempt(env, rec) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    await env.SIGNAL_CACHE.put(
      LAST_ATTEMPT_KEY,
      JSON.stringify({ ...rec, at: (/* @__PURE__ */ new Date()).toISOString() }),
      { expirationTtl: 7 * 24 * 3600 }
    );
  } catch (e) {
    console.warn("push: lastAttempt write failed: " + e.message);
  }
}
async function recordDelivery(env, signalId, pair, n) {
  if (!env || !env.SIGNAL_CACHE || !n) return;
  try {
    let arr = await env.SIGNAL_CACHE.get(DELIVERED_24H_KEY, "json");
    if (!Array.isArray(arr)) arr = [];
    const now = Date.now();
    arr = arr.filter((x) => x && x.at && now - new Date(x.at).getTime() < 24 * 3600 * 1e3);
    arr.push({ id: signalId, pair, n, at: (/* @__PURE__ */ new Date()).toISOString() });
    if (arr.length > 500) arr = arr.slice(-500);
    await env.SIGNAL_CACHE.put(DELIVERED_24H_KEY, JSON.stringify(arr), { expirationTtl: 48 * 3600 });
  } catch (e) {
    console.warn("push: delivered24h write failed: " + e.message);
  }
}
function passGrade(sig, f) {
  if (!f || f === "ALL") return true;
  const g = sig && sig.grade && sig.grade.grade || "";
  if (!g) return false;
  return f === "A" ? ["A+", "A"].includes(g) : f === "AB" ? ["A+", "A", "B"].includes(g) : true;
}
function passConf(sig, min) {
  if (!min) return true;
  return confPct(sig) >= min;
}
function passAI(sig, aiOnly) {
  if (!aiOnly) return true;
  if (!sig || !sig.aiValidation) return false;
  const v = sig.aiValidation;
  const status = v.status || v.combined && v.combined.status;
  const agreed = v.agrees !== void 0 ? v.agrees : v.combinedAgreed;
  return status === "OK" && agreed === true;
}
async function getMatchingSubscribers(signal, env, diag = null) {
  if (diag && !Array.isArray(diag.skips)) diag.skips = [];
  if (!env || !env.BOT_KV) {
    if (diag) diag.skips.push({ reason: "no-bot-kv" });
    return [];
  }
  const sig = signal && signal.signal;
  if (!sig) {
    if (diag) diag.skips.push({ reason: "no-signal" });
    return [];
  }
  let autoUsers;
  try {
    autoUsers = await env.BOT_KV.get("auto_users", "json");
  } catch (e) {
    console.warn("push: auto_users read failed: " + e.message);
    if (diag) diag.skips.push({ reason: "auto-users-read-failed", error: e.message });
    return [];
  }
  const ids = normalizeAutoUsers(autoUsers);
  if (diag) {
    diag.autoUsersRawType = Array.isArray(autoUsers) ? "array" : typeof autoUsers;
    diag.autoUsersCount = ids.length;
  }
  if (ids.length === 0) {
    if (diag) diag.skips.push({ reason: "auto-users-empty" });
    return [];
  }
  const want = normPair(signal.pair);
  const matches = [];
  for (const cid of ids) {
    try {
      const user = await env.BOT_KV.get("u:" + cid, "json");
      if (!user) {
        if (diag) diag.skips.push({ chatId: String(cid), reason: "no-user-record" });
        continue;
      }
      if (!isAutoEnabled(user)) {
        if (diag) diag.skips.push({ chatId: String(cid), reason: "auto-disabled" });
        continue;
      }
      const watched = [user.pair, ...Array.isArray(user.watchlist) ? user.watchlist : []].filter(Boolean).map(normPair);
      const watchAll = user.watchAll === true || user.watchAll === 1 || user.watchAll === "true";
      if (!watchAll && !watched.includes(want)) {
        if (diag) diag.skips.push({
          chatId: String(cid),
          reason: "pair-not-watched",
          want,
          pair: user.pair || null,
          watchlist: Array.isArray(user.watchlist) ? user.watchlist : []
        });
        continue;
      }
      if (!passConf(sig, user.minConfidence)) {
        if (diag) diag.skips.push({ chatId: String(cid), reason: "min-confidence", min: user.minConfidence });
        continue;
      }
      if (!passGrade(sig, user.gradeFilter)) {
        if (diag) diag.skips.push({ chatId: String(cid), reason: "grade-filter", filter: user.gradeFilter });
        continue;
      }
      if (!passAI(sig, user.aiOnlyMode)) {
        if (diag) diag.skips.push({ chatId: String(cid), reason: "ai-only" });
        continue;
      }
      matches.push({ chatId: String(cid), channelId: user.channelId || null, fxMode: user.fxMode || "ftt" });
    } catch (e) {
      console.warn("push: user read failed for " + cid + ": " + e.message);
      if (diag) diag.skips.push({ chatId: String(cid), reason: "user-read-failed", error: e.message });
    }
  }
  return matches;
}
async function claimPushLock(chatId, signal, env) {
  if (!env.SIGNAL_CACHE) return true;
  const key = lockKey(chatId, signal);
  try {
    const held = await env.SIGNAL_CACHE.get(key);
    if (held) return false;
    await env.SIGNAL_CACHE.put(key, signal.id, { expirationTtl: PUSH_LOCK_TTL_S });
    return true;
  } catch (e) {
    console.warn("push: lock check failed: " + e.message);
    return true;
  }
}
async function pushSignalToSubscribers(signal, env) {
  const diag = { skips: [] };
  const out = await pushSignalToSubscribersInner(signal, env, diag);
  await recordPushAttempt(env, {
    signalId: signal && signal.id || null,
    pair: signal && signal.pair || null,
    dir: signal && signal.signal && signal.signal.finalSignal || null,
    skipped: out.skipped || null,
    pushed: out.pushed || 0,
    matched: out.matched || 0,
    error: out.error || null,
    telegramError: out.telegramError || null,
    skips: diag.skips
  });
  return out;
}
async function pushSignalToSubscribersInner(signal, env, diag) {
  if (!signal || !signal.id) return { pushed: 0, skipped: "no-id" };
  const sig = signal.signal;
  if (!sig || !["BUY", "SELL"].includes(sig.finalSignal)) {
    return { pushed: 0, skipped: "not-actionable" };
  }
  if (!env || !botToken(env)) {
    return { pushed: 0, skipped: "no-token" };
  }
  try {
    const subscribers = await getMatchingSubscribers(signal, env, diag);
    if (subscribers.length === 0) return { pushed: 0, skipped: "no-match", matched: 0 };
    const eligible = [];
    for (const sub of subscribers) {
      if (await claimPushLock(sub.chatId, signal, env)) eligible.push(sub);
      else if (diag) diag.skips.push({ chatId: sub.chatId, reason: "locked" });
    }
    if (eligible.length === 0) return { pushed: 0, skipped: "locked", matched: subscribers.length };
    const results = await Promise.allSettled(
      eligible.map(async (sub) => {
        let msgSignal = signal;
        if ((sub.fxMode === "fx" || sub.fxMode === "both") && !signal.signal.fxLevels) {
          try {
            const fx = await fetch(
              `${SELF_URL}/api/signal?pair=${encodeURIComponent(signal.pair)}&mode=fx&nopush=1`,
              { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8e3) }
            );
            if (fx.ok) {
              const fd = await fx.json();
              if (fd && fd.signal && fd.signal.fxLevels) msgSignal = fd;
            }
          } catch (e) {
            console.warn("push: fx fetch failed (fallback FTT): " + e.message);
          }
        }
        const fxOnly = sub.fxMode === "fx";
        const message = formatSignalMessage(msgSignal, { fx: sub.fxMode === "fx" || sub.fxMode === "both", fxOnly });
        try {
          await sendTelegramMessage(sub.chatId, message, env);
        } catch (e) {
          await releasePushLock(sub.chatId, signal, env);
          throw e;
        }
        return { sub, message };
      })
    );
    const delivered = [];
    const telegramErrors = [];
    results.forEach((r) => {
      if (r.status === "fulfilled" && r.value) delivered.push(r.value);
      else if (r.status === "rejected") {
        telegramErrors.push(String(r.reason && r.reason.message || r.reason || "send-failed"));
      }
    });
    await Promise.allSettled(
      delivered.filter((d) => d.sub.channelId).map((d) => sendTelegramMessage(d.sub.channelId, d.message, env))
    );
    if (delivered.length > 0 && env.SIGNAL_CACHE) {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await env.SIGNAL_CACHE.put(
        PUSH_LOG_PREFIX + signal.id,
        JSON.stringify(delivered.map((d) => ({ chatId: d.sub.chatId, sentAt: now }))),
        { expirationTtl: PUSH_LOG_TTL_S }
      );
      await recordDelivery(env, signal.id, signal.pair, delivered.length);
    }
    console.log("Phase 10 push: " + signal.id + " " + signal.pair + " " + sig.finalSignal + " -> " + delivered.length + "/" + eligible.length + " delivered (" + subscribers.length + " matched)" + (telegramErrors.length ? " telegramErrors=" + telegramErrors[0] : ""));
    const skipped = delivered.length === 0 ? telegramErrors.length ? "telegram-fail" : "no-delivery" : void 0;
    return {
      pushed: delivered.length,
      matched: subscribers.length,
      skipped,
      telegramError: telegramErrors[0] || null
    };
  } catch (e) {
    console.warn("pushSignalToSubscribers error: " + e.message);
    return { pushed: 0, error: e.message };
  }
}
async function pushResultToSubscribers(record, winLoss, exitPrice, env) {
  if (!record || !record.id) return { pushed: 0 };
  if (!["WIN", "LOSS"].includes(winLoss)) return { pushed: 0, skipped: "undecided" };
  if (!env || !botToken(env) || !env.SIGNAL_CACHE) return { pushed: 0, skipped: "not-configured" };
  try {
    const logKey = PUSH_LOG_PREFIX + record.id;
    const log = await env.SIGNAL_CACHE.get(logKey, "json");
    if (!Array.isArray(log) || log.length === 0) return { pushed: 0, skipped: "never-pushed" };
    const message = formatResultMessage(record, winLoss, exitPrice);
    const results = await Promise.allSettled(
      log.map((entry) => sendTelegramMessage(entry.chatId, message, env))
    );
    const delivered = results.filter((r) => r.status === "fulfilled").length;
    await env.SIGNAL_CACHE.delete(logKey).catch(() => {
    });
    console.log("Phase 10 result push: " + record.id + " " + winLoss + " -> " + delivered + "/" + log.length);
    return { pushed: delivered };
  } catch (e) {
    console.warn("pushResultToSubscribers error: " + e.message);
    return { pushed: 0, error: e.message };
  }
}
function formatSignalMessage(signal, opts = {}) {
  const sig = signal.signal;
  const dir = sig.finalSignal;
  const emoji = dir === "BUY" ? "\u{1F7E2}" : "\u{1F534}";
  const idShort = String(signal.id || "").slice(-4);
  const bestTF = sig.bestTimeframe && sig.bestTimeframe.timeframe || "5min";
  const rec = sig.recommendations && sig.recommendations[bestTF] || {};
  const entry = rec.entry && rec.entry.price;
  const isFx = opts.fx === true || sig.mode === "fx";
  const isBoth = opts.fx === true && opts.fxOnly !== true;
  const levels = sig.fxLevels || null;
  const expMin = rec.expiry && rec.expiry.totalMinutes;
  const countdown = rec.expiry && rec.expiry.countdown && rec.expiry.countdown.label;
  const grade = sig.grade && sig.grade.grade || "";
  const label = sig.grade && sig.grade.label || "";
  const confNum = parseInt(String(sig.confidence || "0%").replace("%", "")) || 0;
  const filled = Math.round(confNum / 10);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
  const barEmoji = confNum >= 85 ? "\u{1F7E2}" : confNum >= 70 ? "\u{1F7E1}" : "\u{1F534}";
  const sv = sig.structureVerdict;
  const lines = [];
  lines.push("\u{1F4CC} Signal No. " + idShort);
  lines.push("\u{1F4CA} " + signal.pair + " | " + bestTF + (isFx ? isBoth ? " | \u{1F504} BOTH" : " | \u{1F4B9} FX" : " | \u23F1 FTT"));
  lines.push("\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
  lines.push(emoji + " " + dir + "  " + (sig.confidence || "") + "  " + (grade + " " + label).trim());
  lines.push(barEmoji + " " + bar);
  if (entry != null) lines.push("\u{1F4B0} Entry: " + entry);
  if (isFx && levels && levels.sl && levels.tp) {
    lines.push("\u{1F6D1} SL: " + levels.sl);
    lines.push("\u{1F3AF} TP: " + levels.tp + "  (1:" + (levels.rr || "2.5") + ")");
  }
  if (isFx && opts.fxOnly === true) {
  } else {
    if (expMin != null) lines.push("\u23F0 Expiry: " + expMin + " min");
    if (countdown) lines.push("\u{1F550} Candle closes: " + countdown);
  }
  if (sig.higherTFTrend) lines.push("\u{1F4C8} HTF: " + sig.higherTFTrend);
  if (sig.marketRegime) lines.push("\u{1F7E1} Regime: " + sig.marketRegime);
  if (sig.regimeAdvice) lines.push("\u{1F4A1} " + sig.regimeAdvice);
  if (sv && sv.overall && sv.overall !== "N/A") {
    const sE = sv.overall === "ALIGNED" ? "\u2705" : sv.overall === "AGAINST" ? "\u26A0\uFE0F" : sv.overall === "MIXED" ? "\u{1F500}" : "\u27A1\uFE0F";
    let sLine = sE + " Structure: " + sv.overall;
    if (sv.direction && sv.direction !== "NEUTRAL") sLine += " (" + sv.direction + " " + (sv.strength || "") + ")";
    lines.push(sLine);
  }
  if (sig.entryReason) {
    lines.push("");
    lines.push("\u{1F4DD} " + sig.entryReason);
  }
  lines.push("");
  lines.push("\u23F3 Result will be tracked automatically");
  lines.push("\u26A1 Live push \xB7 fresh generation");
  return lines.join("\n");
}
function formatResultMessage(record, winLoss, exitPrice) {
  const emoji = winLoss === "WIN" ? "\u{1F3C6}" : "\u274C";
  const idShort = String(record.id || "").slice(-4);
  const entry = record.entryPrice;
  const dir = record.direction;
  let deltaStr = "N/A";
  if (exitPrice != null && entry != null && isFinite(exitPrice) && isFinite(entry)) {
    const delta = dir === "BUY" ? exitPrice - entry : entry - exitPrice;
    const digits = Math.abs(entry) >= 100 ? 2 : 5;
    deltaStr = (delta >= 0 ? "+" : "") + delta.toFixed(digits);
  }
  return [
    "\u{1F3AF} Result: " + winLoss + " " + emoji,
    "",
    "\u{1F4CC} Signal No. " + idShort,
    "\u{1F4CA} " + record.pair + " \xB7 " + dir,
    "Entry: " + (entry != null ? entry : "?") + " \u2192 Exit: " + (exitPrice != null ? exitPrice : "?"),
    "\u0394: " + deltaStr
  ].join("\n");
}
async function sendTelegramMessage(chatId, text, env) {
  const token = botToken(env);
  const url = TELEGRAM_API + "/bot" + token + "/sendMessage";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text || ""),
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("Telegram sendMessage failed: chatId=" + chatId + " status=" + res.status + " body=" + body.slice(0, 200));
    throw new Error("Telegram " + res.status + (body ? " " + body.slice(0, 120) : ""));
  }
  return res.json().catch(() => ({}));
}
async function validateBotToken(env) {
  if (!botToken(env)) return { ok: false, reason: "missing", checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (env.SIGNAL_CACHE) {
    try {
      const cached = await env.SIGNAL_CACHE.get(TOKEN_CHECK_KEY, "json");
      if (cached && cached.checkedAt && Date.now() - new Date(cached.checkedAt).getTime() < TOKEN_CHECK_TTL_S * 1e3) {
        return cached;
      }
    } catch (e) {
    }
  }
  try {
    const res = await fetch(TELEGRAM_API + "/bot" + botToken(env) + "/getMe", {
      signal: AbortSignal.timeout(5e3)
    });
    const body = await res.json().catch(() => ({}));
    const result = res.ok && body.ok ? { ok: true, reason: null, username: body.result && body.result.username, checkedAt: (/* @__PURE__ */ new Date()).toISOString() } : {
      ok: false,
      reason: "invalid",
      status: res.status,
      description: body.description || null,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (env.SIGNAL_CACHE) {
      await env.SIGNAL_CACHE.put(TOKEN_CHECK_KEY, JSON.stringify(result), {
        expirationTtl: TOKEN_CHECK_TTL_S
      }).catch(() => {
      });
    }
    return result;
  } catch (e) {
    return { ok: false, reason: "error", error: e.message, checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
  }
}
async function getSubscriberSnapshot(env) {
  const out = [];
  if (!env || !env.BOT_KV) return out;
  let autoUsers;
  try {
    autoUsers = await env.BOT_KV.get("auto_users", "json");
  } catch (e) {
    return [{ error: e.message }];
  }
  for (const cid of normalizeAutoUsers(autoUsers)) {
    try {
      const user = await env.BOT_KV.get("u:" + cid, "json");
      out.push({
        chatId: String(cid),
        found: !!user,
        autoEnabled: isAutoEnabled(user),
        pair: user && user.pair || null,
        watchlist: user && Array.isArray(user.watchlist) ? user.watchlist : [],
        gradeFilter: user && user.gradeFilter || "ALL",
        minConfidence: user && user.minConfidence || 0,
        aiOnlyMode: !!(user && user.aiOnlyMode),
        fxMode: user && user.fxMode || "ftt"
      });
    } catch (e) {
      out.push({ chatId: String(cid), found: false, error: e.message });
    }
  }
  return out;
}
async function getPushStats(env, opts = {}) {
  const token = botToken(env);
  const enabled = !!token;
  const stats = {
    pushEnabled: enabled,
    botKvBound: !!(env && env.BOT_KV),
    noTokenReason: enabled ? null : env && env.BOT_TOKEN ? "empty" : "missing",
    tokenValid: null,
    tokenUsername: null,
    pushesLast24h: null,
    pushLogsOpen: null,
    subscriberCount: null,
    subscribers: [],
    lastAttempt: null
  };
  if (!env || !env.SIGNAL_CACHE) {
    if (env && env.BOT_KV) {
      try {
        const autoUsers = await env.BOT_KV.get("auto_users", "json");
        const ids = normalizeAutoUsers(autoUsers);
        stats.subscriberCount = ids.length;
        stats.subscribers = await getSubscriberSnapshot(env);
      } catch (e) {
      }
    }
    return stats;
  }
  try {
    const list = await env.SIGNAL_CACHE.list({ prefix: PUSH_LOG_PREFIX });
    stats.pushLogsOpen = (list && list.keys || []).length;
  } catch (e) {
  }
  try {
    const arr = await env.SIGNAL_CACHE.get(DELIVERED_24H_KEY, "json");
    if (Array.isArray(arr)) {
      const now = Date.now();
      stats.pushesLast24h = arr.filter((x) => x && x.at && now - new Date(x.at).getTime() < 24 * 3600 * 1e3).reduce((n, x) => n + (x.n || 1), 0);
    } else {
      stats.pushesLast24h = stats.pushLogsOpen;
    }
  } catch (e) {
    stats.pushesLast24h = stats.pushLogsOpen;
  }
  try {
    stats.lastAttempt = await env.SIGNAL_CACHE.get(LAST_ATTEMPT_KEY, "json");
  } catch (e) {
  }
  if (env.BOT_KV) {
    try {
      const autoUsers = await env.BOT_KV.get("auto_users", "json");
      const ids = normalizeAutoUsers(autoUsers);
      stats.subscriberCount = ids.length;
      stats.subscribers = await getSubscriberSnapshot(env);
    } catch (e) {
    }
  }
  if (opts.validateToken && enabled) {
    const probe = await validateBotToken(env);
    stats.tokenValid = !!probe.ok;
    stats.tokenUsername = probe.username || null;
    if (!probe.ok) stats.noTokenReason = probe.reason || "invalid";
  }
  return stats;
}

// src/analysis/grade.js
init_calibration();
function getSignalGrade(confidence, avgConf, alignment, structureOverall, regime) {
  const cal = getCalibratedGradeAndConfidence(confidence, structureOverall, regime);
  return cal.grade;
}
function resolveTieWithTolerance(details) {
  let tU = 0;
  let tD = 0;
  let cU = 0;
  let cD = 0;
  for (const tf of Object.keys(details)) {
    const s = details[tf];
    const w = CONFIG.TF_WEIGHTS[tf] || 1;
    tU += s.score.up * w;
    tD += s.score.down * w;
    cU += (s.confluenceDetail && s.confluenceDetail.bullish || 0) * w;
    cD += (s.confluenceDetail && s.confluenceDetail.bearish || 0) * w;
  }
  const total = tU + tD;
  if (tU > tD && cU >= cD) return { direction: "BUY", confidence: total > 0 ? Math.round(tU / total * 100) : 50 };
  if (tD > tU && cD >= cU) return { direction: "SELL", confidence: total > 0 ? Math.round(tD / total * 100) : 50 };
  if (tU > tD) return { direction: "BUY", confidence: total > 0 ? Math.round(tU / total * 100) : 50 };
  if (tD > tU) return { direction: "SELL", confidence: total > 0 ? Math.round(tD / total * 100) : 50 };
  return { direction: "NO_TRADE", confidence: 50 };
}

// src/analysis/filters.js
function isVolumeSpikeAnomaly(candles, assetType) {
  if (assetType !== ASSET_TYPE.CRYPTO) return false;
  if (!candles || candles.length < 21) return false;
  const lastCandle = candles[candles.length - 1];
  const sample = candles.slice(-21, -1);
  const avgVol = sample.reduce((a, c) => a + c.volume, 0) / sample.length;
  if (avgVol <= 0) return false;
  const ratio = lastCandle.volume / avgVol;
  if (ratio > CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER) {
    const body = Math.abs(lastCandle.close - lastCandle.open);
    const range = lastCandle.high - lastCandle.low || 1e-5;
    if (body / range < 0.45) return true;
  }
  return false;
}
function recentCandleConsistency(candles, direction, lookback = 4) {
  if (!candles || candles.length < lookback + 1 || direction === "NO_TRADE") return 1;
  const recent = candles.slice(-lookback);
  let aligned = 0;
  for (const c of recent) {
    const bullish = c.close > c.open;
    if (direction === "BUY" && bullish) aligned++;
    if (direction === "SELL" && !bullish) aligned++;
  }
  const ratio = aligned / lookback;
  if (ratio >= 0.75) return 1;
  if (ratio >= 0.5) return 0.9;
  if (ratio >= 0.25) return 0.8;
  return 0.7;
}
function generateEntryReason(direction, catScores, indicatorSummary, alignment, higherTFTrend, marketContext) {
  if (direction === "NO_TRADE") return "No clear setup \u2014 entry conditions not met.";
  const reasons = [];
  if (catScores.trend) {
    const tS = direction === "BUY" ? catScores.trend.up : catScores.trend.down;
    if (tS >= 3) reasons.push("Strong EMA stack aligned " + direction);
    else if (tS >= 1.5) reasons.push("EMA trend favors " + direction);
  }
  const rsiVal = parseFloat(indicatorSummary.rsi);
  if (!isNaN(rsiVal)) {
    if (direction === "BUY" && rsiVal <= 30) reasons.push("RSI oversold (" + rsiVal.toFixed(0) + ")");
    else if (direction === "BUY" && rsiVal >= 55 && rsiVal < 70) reasons.push("RSI bullish momentum (" + rsiVal.toFixed(0) + ")");
    else if (direction === "SELL" && rsiVal >= 70) reasons.push("RSI overbought (" + rsiVal.toFixed(0) + ")");
    else if (direction === "SELL" && rsiVal <= 45 && rsiVal > 30) reasons.push("RSI bearish momentum (" + rsiVal.toFixed(0) + ")");
  }
  if (catScores.macd) {
    const mS = direction === "BUY" ? catScores.macd.up : catScores.macd.down;
    if (mS >= 1.5) reasons.push(direction === "BUY" ? "MACD bullish crossover/expansion" : "MACD bearish crossover/expansion");
  }
  if (catScores.adx) {
    const aS = direction === "BUY" ? catScores.adx.up : catScores.adx.down;
    if (aS >= 1.5) {
      const adxNum = parseFloat(indicatorSummary.adx);
      if (!isNaN(adxNum) && adxNum >= 25) reasons.push("ADX trending (" + adxNum.toFixed(0) + ") with DI support");
      if (catScores.adx.diCross && catScores.adx.diCross !== "NONE") reasons.push("DI crossover: " + catScores.adx.diCross);
    }
  }
  if (catScores.stochastic) {
    const stS = direction === "BUY" ? catScores.stochastic.up : catScores.stochastic.down;
    if (stS >= 0.8) reasons.push("Stochastic confirms " + direction);
  }
  if (catScores.patterns && catScores.patterns.detected && catScores.patterns.detected.length > 0) {
    const pats = catScores.patterns.detected.filter((p) => p !== "DOJI");
    if (pats.length > 0) reasons.push("Pattern: " + pats.join(", "));
  }
  if (catScores.divergence) {
    if (catScores.divergence.rsi !== "NONE") reasons.push("RSI divergence" + (catScores.divergence.rsiConfirmed ? " (confirmed)" : " (unconfirmed)"));
    if (catScores.divergence.macd !== "NONE") reasons.push("MACD divergence" + (catScores.divergence.macdConfirmed ? " (confirmed)" : " (unconfirmed)"));
  }
  if (higherTFTrend && higherTFTrend === direction) reasons.push("15min HTF trend aligned");
  if (alignment === "ALL_BULLISH" || alignment === "ALL_BEARISH") reasons.push("All timeframes agree");
  else if (alignment === "MOSTLY_BULLISH" || alignment === "MOSTLY_BEARISH") reasons.push("Majority timeframes agree");
  if (marketContext === "TRENDING") reasons.push("Trending market");
  else if (marketContext === "RANGING") reasons.push("Range-bound market");
  return reasons.length === 0 ? direction + " signal from weighted indicator confluence." : reasons.join(" \xB7 ");
}
function getCandleQualityMultiplier(candles) {
  if (!candles || candles.length < 3) return 1;
  const last = candles[candles.length - 1];
  const prev1 = candles[candles.length - 2];
  function bodyRatio(c) {
    const body = Math.abs(c.close - c.open);
    return body / (c.high - c.low || 1e-5);
  }
  function wickRatio(c) {
    const range = c.high - c.low || 1e-5;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    return (upperWick + lowerWick) / range;
  }
  const br0 = bodyRatio(last);
  const br1 = bodyRatio(prev1);
  const wr0 = wickRatio(last);
  if (br0 >= 0.65 && br1 >= 0.55) return 1.15;
  if (br0 >= 0.55 && wr0 <= 0.35) return 1.08;
  if (br0 >= 0.4) return 1;
  if (br0 < 0.15) return 0.75;
  if (wr0 >= 0.7) return 0.82;
  return 0.92;
}
function getSessionWeightMultiplier(pair, session, assetType) {
  if (!pair || !session) return 1;
  if (assetType && assetType !== ASSET_TYPE.FOREX) return 1;
  const parts = pair.replace("-OTC", "").split("/");
  const base = parts[0] || "";
  const quote = parts[1] || "";
  const activeSession = session.overlap !== "NONE" ? session.overlap : session.sessions[0] || "UNKNOWN";
  const baseWeights = SESSION_PAIR_WEIGHTS[base] || {};
  const quoteWeights = SESSION_PAIR_WEIGHTS[quote] || {};
  const mult = Math.max(baseWeights[activeSession] || 1, quoteWeights[activeSession] || 1);
  return Math.max(0.7, Math.min(1.4, mult));
}
function detectCorrelationConflicts(pairSignals) {
  const conflicts = [];
  const warnings = [];
  for (const group of CORRELATION_GROUPS) {
    const groupSigs = group.map((p) => ({ pair: p, signal: pairSignals[p] })).filter((x) => x.signal && x.signal !== "NO_TRADE");
    if (groupSigs.length >= 2) {
      const buys = groupSigs.filter((x) => x.signal === "BUY").map((x) => x.pair);
      const sells = groupSigs.filter((x) => x.signal === "SELL").map((x) => x.pair);
      if (buys.length > 0 && sells.length > 0)
        conflicts.push({ group, conflict: "BUY vs SELL", buyPairs: buys, sellPairs: sells, warning: "Correlated pairs conflict \u2014 reduce position" });
    }
  }
  for (const [p1, p2] of NEGATIVE_CORRELATIONS) {
    const s1 = pairSignals[p1];
    const s2 = pairSignals[p2];
    if (s1 && s2 && s1 !== "NO_TRADE" && s2 !== "NO_TRADE" && s1 === s2)
      warnings.push({ pairs: [p1, p2], signal: s1, note: "Negatively correlated \u2014 same direction is unusual" });
  }
  return { conflicts, warnings, hasConflict: conflicts.length > 0 };
}
var FX_RR_DEFAULT = 2.5;
var FX_SL_ATR_MULT_DEFAULT = 1;
function computeFxLevels({ entry, atr, direction, rr = FX_RR_DEFAULT, slAtrMult = FX_SL_ATR_MULT_DEFAULT }) {
  if (entry === null || entry === void 0 || !isFinite(entry)) return null;
  if (atr === null || atr === void 0 || !isFinite(atr) || atr <= 0) return null;
  if (direction !== "BUY" && direction !== "SELL") return null;
  const stopDist = atr * slAtrMult;
  const tpDist = stopDist * rr;
  let sl, tp;
  if (direction === "BUY") {
    sl = entry - stopDist;
    tp = entry + tpDist;
  } else {
    sl = entry + stopDist;
    tp = entry - tpDist;
  }
  const dec = Math.abs(entry) < 10 ? 5 : Math.abs(entry) < 1e3 ? 4 : 2;
  const round = (v) => Number(v.toFixed(dec));
  return {
    entry: round(entry),
    sl: round(sl),
    tp: round(tp),
    rr,
    slAtrMult,
    atr: Number(atr.toFixed(dec))
  };
}

// src/indicators/regime.js
function detectMarketRegime(adxVal, bbBandwidth, atr, lastClose, assetType, prevBbBandwidth) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  if (atr !== null && lastClose > 0) {
    const atrPct = atr / lastClose * 100;
    if (atrPct > vt.atrVeryHigh) return "VOLATILE";
  }
  if (bbBandwidth !== null && prevBbBandwidth !== null) {
    const expanding = bbBandwidth > prevBbBandwidth * 1.25;
    const wasSqueezed = prevBbBandwidth < vt.bbSqueeze * 1.5;
    if (wasSqueezed && expanding) return "BREAKOUT";
  }
  if (adxVal !== null && adxVal >= 25) return "TRENDING";
  return "RANGING";
}
function getRegimeWeights(regime) {
  const map = {
    TRENDING: { trend: 2.4, momentum: 1.4, macd: 1.6, stochastic: 0.7, bands: 0.8, adx: 1.8, patterns: 1.2, divergence: 1.5, pivots: 0.6, volume: 0.7, sr: 0.8 },
    RANGING: { trend: 0.8, momentum: 1.8, macd: 0.8, stochastic: 1.8, bands: 1.4, adx: 0.8, patterns: 1.3, divergence: 1.8, pivots: 1.2, volume: 0.5, sr: 2.2 },
    BREAKOUT: { trend: 2, momentum: 1.2, macd: 1.4, stochastic: 0.6, bands: 2, adx: 1.6, patterns: 1, divergence: 0.8, pivots: 0.7, volume: 1.2, sr: 0.7 },
    VOLATILE: { trend: 1.2, momentum: 1, macd: 0.8, stochastic: 0.8, bands: 0.9, adx: 1, patterns: 0.8, divergence: 1, pivots: 0.6, volume: 0.4, sr: 1 }
  };
  return map[regime] || { trend: 1.8, momentum: 1.4, macd: 1.2, stochastic: 1, bands: 1, adx: 1.3, patterns: 1.1, divergence: 1.5, pivots: 0.8, volume: 0.5, sr: 1.4 };
}
function getRegimeAdvice(regime, direction) {
  if (regime === "TRENDING")
    return direction === "NO_TRADE" ? "Trending \u2014 wait for pullback entry" : "Trending \u2014 trade with trend, momentum expiry";
  if (regime === "RANGING")
    return direction === "NO_TRADE" ? "Ranging \u2014 wait for S/R boundary" : "Ranging \u2014 trade at S/R only, short expiry";
  if (regime === "BREAKOUT")
    return direction === "NO_TRADE" ? "Breakout forming \u2014 wait for candle close" : "Breakout \u2014 ride momentum, avoid counter-trades";
  if (regime === "VOLATILE")
    return "High volatility \u2014 reduce size or skip";
  return "";
}
function detectMarketCondition(adxVal, bbBW, atr, lastClose, assetType) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const cond = [];
  if (adxVal !== null) {
    if (adxVal >= 40) cond.push("STRONG_TREND");
    else if (adxVal >= 25) cond.push("TRENDING");
    else if (adxVal >= 15) cond.push("WEAK_TREND");
    else cond.push("RANGING");
  }
  if (bbBW !== null) {
    if (bbBW < vt.bbSqueeze) cond.push("SQUEEZE");
    else if (bbBW > vt.bbHighVol) cond.push("HIGH_VOLATILITY");
  }
  if (atr !== null && lastClose > 0) {
    const ap = atr / lastClose * 100;
    if (ap > vt.atrVolatile) cond.push("VOLATILE");
    else if (ap < vt.atrDeadMarket) cond.push("DEAD_MARKET");
  }
  return cond.length === 0 ? ["NORMAL"] : cond;
}
function isTrendingMarket(adxVal) {
  if (adxVal === null) return null;
  return adxVal >= 25;
}
function detectDICrossover(adxIndicator) {
  if (!adxIndicator || !adxIndicator.plusDI || !adxIndicator.minusDI) return null;
  const lastPlusDI = safeLastTwo(adxIndicator.plusDI);
  const lastMinusDI = safeLastTwo(adxIndicator.minusDI);
  if (lastPlusDI.last === null || lastPlusDI.prev === null || lastMinusDI.last === null || lastMinusDI.prev === null) return null;
  if (lastPlusDI.prev <= lastMinusDI.prev && lastPlusDI.last > lastMinusDI.last)
    return { type: "BULLISH_DI_CROSS", direction: "BUY", strength: 1.5 };
  if (lastMinusDI.prev <= lastPlusDI.prev && lastMinusDI.last > lastPlusDI.last)
    return { type: "BEARISH_DI_CROSS", direction: "SELL", strength: 1.5 };
  return null;
}

// src/signal/voteFilters.js
function decideTfDirection(upScore, downScore, upCat, downCat, minScoreThreshold) {
  const scoreDiff = Math.abs(upScore - downScore);
  const confluence = Math.max(upCat, downCat);
  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) return "BUY";
  if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) return "SELL";
  if (scoreDiff >= 4 && (upScore > downScore ? upCat : downCat) >= CONFIG.MIN_CONFLUENCE)
    return upScore > downScore ? "BUY" : "SELL";
  return "NO_TRADE";
}
async function runDeterministicVoteAndFilters(ctx) {
  const {
    votes,
    candleData,
    tfResults,
    higherTFTrend,
    marketRegime,
    session,
    sessionMult,
    candleQualityMult,
    exotic,
    assetType,
    newsBlock,
    newsBlocked,
    pair,
    env
  } = ctx;
  const filtersApplied = [];
  let weightedBuy = 0;
  let weightedSell = 0;
  let weightedNoTrade = 0;
  const activeDirs = [];
  for (const vote of votes) {
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1) * sessionMult * candleQualityMult;
    if (vote.direction === "BUY") {
      weightedBuy += w * (vote.score.up || 1);
      activeDirs.push("BUY");
    } else if (vote.direction === "SELL") {
      weightedSell += w * (vote.score.down || 1);
      activeDirs.push("SELL");
    } else {
      weightedNoTrade += w;
    }
  }
  const allBuy = activeDirs.length > 0 && activeDirs.every((d) => d === "BUY");
  const allSell = activeDirs.length > 0 && activeDirs.every((d) => d === "SELL");
  let alignment = "MIXED";
  let alignmentBonus = 0;
  const fullBonus = marketRegime === "TRENDING" || marketRegime === "BREAKOUT" ? 8 : 3;
  const partialBonus = marketRegime === "TRENDING" || marketRegime === "BREAKOUT" ? 4 : 2;
  if (allBuy) {
    alignment = "ALL_BULLISH";
    alignmentBonus = fullBonus;
  } else if (allSell) {
    alignment = "ALL_BEARISH";
    alignmentBonus = fullBonus;
  } else if (!allBuy && !allSell && activeDirs.length >= 2) {
    const bc = activeDirs.filter((d) => d === "BUY").length;
    const sc = activeDirs.filter((d) => d === "SELL").length;
    if (bc > sc) {
      alignment = "MOSTLY_BULLISH";
      alignmentBonus = partialBonus;
    }
    if (sc > bc) {
      alignment = "MOSTLY_BEARISH";
      alignmentBonus = partialBonus;
    }
  }
  let finalDirection;
  let confidence;
  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = "BUY";
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round(weightedBuy / d * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = "SELL";
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round(weightedSell / d * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction;
    confidence = tie.confidence;
  }
  const rawDirection = finalDirection;
  const rawConfidence = confidence;
  confidence = Math.min(92, confidence + alignmentBonus);
  if (alignment === "MIXED") {
    finalDirection = "NO_TRADE";
    confidence = 0;
    filtersApplied.push("MIXED_ALIGNMENT");
  }
  if (higherTFTrend !== null && finalDirection !== "NO_TRADE" && finalDirection !== higherTFTrend) {
    const htf15 = tfResults["15min"];
    const htfADX = htf15 && htf15.indicators ? parseFloat(htf15.indicators.adx) : null;
    if (htfADX !== null && !isNaN(htfADX) && htfADX >= 25) {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("HTF_HARD_BLOCK (ADX=" + htfADX.toFixed(0) + ")");
    } else {
      confidence = Math.max(0, confidence - 18);
      filtersApplied.push("HTF_SOFT_PENALTY -18");
    }
  } else if (higherTFTrend !== null && finalDirection === higherTFTrend) {
    confidence = Math.min(92, confidence + 5);
  }
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === "LOW") {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("SESSION_LOW_QUALITY_BLOCK");
    }
  }
  if (exotic) {
    confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY);
    filtersApplied.push("EXOTIC_PENALTY -" + CONFIG.EXOTIC_CONFIDENCE_PENALTY);
  }
  const primaryCandles = candleData["5min"] || candleData["1min"] || candleData["15min"];
  let consistencyMult = 1;
  if (primaryCandles && finalDirection !== "NO_TRADE") {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 4);
    if (consistencyMult < 1) {
      confidence = Math.round(confidence * consistencyMult);
      filtersApplied.push("CANDLE_INCONSISTENCY (x" + consistencyMult + ")");
    }
  }
  let volumeSpikeBlocked = false;
  if (finalDirection !== "NO_TRADE" && primaryCandles) {
    volumeSpikeBlocked = isVolumeSpikeAnomaly(primaryCandles, assetType);
    if (volumeSpikeBlocked) {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("VOLUME_SPIKE_ANOMALY");
    }
  }
  let fvgBlocked = false;
  const fvgCheckTF = tfResults["15min"] || tfResults["5min"] || tfResults["1min"];
  if (finalDirection !== "NO_TRADE" && fvgCheckTF && fvgCheckTF.categoryScores && fvgCheckTF.categoryScores.fvg) {
    const activeFVGType = fvgCheckTF.categoryScores.fvg.active;
    if (activeFVGType && activeFVGType !== "NONE") {
      if (finalDirection === "BUY" && activeFVGType === "BEARISH") {
        fvgBlocked = true;
        confidence = Math.max(0, confidence - 20);
        filtersApplied.push("FVG_PENALTY -20 (inside bearish FVG)");
      }
      if (finalDirection === "SELL" && activeFVGType === "BULLISH") {
        fvgBlocked = true;
        confidence = Math.max(0, confidence - 20);
        filtersApplied.push("FVG_PENALTY -20 (inside bullish FVG)");
      }
    }
  }
  const htfTFResult = tfResults["15min"] || tfResults["5min"] || tfResults["1min"];
  let marketCondition = ["UNKNOWN"];
  let marketContext = "UNKNOWN";
  if (htfTFResult) {
    const htfCandles = candleData["15min"] || candleData["5min"] || candleData["1min"];
    const adxH = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.adx) : null;
    const bbBWH = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.bbBandwidth) : null;
    const atrH = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.atr) : null;
    const lcH = htfCandles ? htfCandles[htfCandles.length - 1].close : null;
    if (lcH !== null) marketCondition = detectMarketCondition(isNaN(adxH) ? null : adxH, isNaN(bbBWH) ? null : bbBWH, isNaN(atrH) ? null : atrH, lcH, assetType);
    marketContext = !isNaN(adxH) && adxH !== null ? adxH >= 25 ? "TRENDING" : "RANGING" : "UNKNOWN";
  }
  const isDeadMarket = marketCondition.includes("DEAD_MARKET");
  if (finalDirection !== "NO_TRADE" && isDeadMarket && confidence < 65) {
    finalDirection = "NO_TRADE";
    confidence = Math.min(confidence, 30);
    filtersApplied.push("DEAD_MARKET_HARD_BLOCK (conf<65)");
  }
  let belowFloor = false;
  if (finalDirection !== "NO_TRADE" && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    belowFloor = true;
    finalDirection = "NO_TRADE";
    filtersApplied.push("CONFIDENCE_BELOW_FLOOR (" + CONFIG.MIN_CONFIDENCE_FLOOR + "%)");
  }
  if (finalDirection !== "NO_TRADE" && candleQualityMult < 0.8) {
    confidence = Math.max(0, confidence - 15);
    filtersApplied.push("LOW_CANDLE_QUALITY_PENALTY -15");
    if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("BELOW_FLOOR_AFTER_QUALITY_PENALTY");
    }
  }
  if (finalDirection !== "NO_TRADE" && env && env.SIGNAL_CACHE) {
    const dynAdj = await getDynamicConfidenceAdjustment(pair, env);
    if (dynAdj !== 0) {
      confidence = Math.max(0, Math.min(92, confidence + dynAdj));
      filtersApplied.push("DYNAMIC_CONF_ADJ: " + (dynAdj > 0 ? "+" : "") + dynAdj);
      if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR && finalDirection !== "NO_TRADE") {
        finalDirection = "NO_TRADE";
        confidence = 0;
        filtersApplied.push("BELOW_FLOOR_AFTER_DYN_ADJ");
      }
    }
  }
  if (newsBlocked && finalDirection !== "NO_TRADE") {
    finalDirection = "NO_TRADE";
    confidence = 0;
    filtersApplied.push("NEWS_BLACKOUT: " + (newsBlock?.label || ""));
  }
  return {
    finalDirection,
    confidence,
    rawDirection,
    rawConfidence,
    filtersApplied,
    belowFloor,
    volumeSpikeBlocked,
    fvgBlocked,
    weightedBuy,
    weightedSell,
    weightedNoTrade,
    alignment,
    alignmentBonus,
    marketCondition,
    marketContext,
    isDeadMarket,
    activeDirs
  };
}

// src/signal/r71shadow.js
var SHADOW_TF = /* @__PURE__ */ Symbol("r71.shadowTf");
var ENGINE_AUDIT = /* @__PURE__ */ Symbol("r71.engineAudit");
function attachShadowTf(analysis, raw) {
  if (!analysis || typeof analysis !== "object") return;
  Object.defineProperty(analysis, SHADOW_TF, { value: raw, enumerable: false, configurable: true, writable: true });
}
function getShadowTfRaw(analysis) {
  if (!analysis || typeof analysis !== "object") return null;
  const v = analysis[SHADOW_TF];
  return v && typeof v === "object" ? v : null;
}
function getEngineAudit(signal) {
  if (!signal || typeof signal !== "object") return null;
  const v = signal[ENGINE_AUDIT];
  return v && typeof v === "object" ? v : null;
}
function attachEngineAudit(signal, audit) {
  if (!signal || typeof signal !== "object") return;
  Object.defineProperty(signal, ENGINE_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}
function classifyAttribution(prodDir, shadowDir) {
  const p = prodDir === "BUY" || prodDir === "SELL" ? prodDir : "NO_TRADE";
  const s = shadowDir === "BUY" || shadowDir === "SELL" ? shadowDir : "NO_TRADE";
  if (p === s) return "UNCHANGED";
  if (p !== "NO_TRADE" && s === "NO_TRADE") return "STRUCTURE_CREATED";
  if (p === "NO_TRADE" && s !== "NO_TRADE") return "STRUCTURE_SUPPRESSED";
  return "STRUCTURE_REDIRECTED";
}
function buildTimeframeAudit(tf, analysis) {
  const raw = getShadowTfRaw(analysis);
  if (!raw) return null;
  const structure = analysis.structure || null;
  const minScoreThreshold = SCORE_THRESHOLDS[analysis.assetType] || 3;
  const shadowCoreDirection = raw.shadowCoreDirection || decideTfDirection(raw.preStructUp, raw.preStructDown, raw.preStructUpCat, raw.preStructDownCat, minScoreThreshold);
  const shadowCoreConfluence = Math.max(raw.preStructUpCat, raw.preStructDownCat);
  const shadowEngineScore = {
    up: raw.shadowEngineScoreUp !== void 0 ? raw.shadowEngineScoreUp : raw.preStructUp,
    down: raw.shadowEngineScoreDown !== void 0 ? raw.shadowEngineScoreDown : raw.preStructDown
  };
  const mult = structure && structure.multiplier ? structure.multiplier : { direction: null, value: 1 };
  return {
    tf,
    productionPreHardBlockDirection: raw.preHardBlockDirection,
    productionFinalDirection: analysis.direction,
    shadowCoreDirection,
    productionScore: analysis.score,
    // { up, down, diff }
    productionConfluence: analysis.confluence,
    shadowCoreScore: { up: raw.preStructUp, down: raw.preStructDown },
    shadowCoreConfluence,
    shadowEngineScore,
    shadowCandleConfirmed: raw.shadowCandleConfirmed !== void 0 ? raw.shadowCandleConfirmed : true,
    shadowConfirmationPenaltyApplied: !!raw.shadowConfirmationPenaltyApplied,
    multiplier: {
      direction: mult.direction,
      value: mult.value,
      appliedUp: raw.structureMultUp,
      appliedDown: raw.structureMultDn
    },
    structureBias: structure ? structure.bias : null,
    bos: structure && structure.bos ? structure.bos.type : "NONE",
    choch: structure && structure.choch ? structure.choch.type : "NONE",
    sweep: structure && structure.sweep ? structure.sweep.type : "NONE",
    structureSummary: structure ? structure.summary : null,
    categoryVoteApplied: raw.categoryVoteApplied,
    voteDirection: raw.voteDirection,
    hardBlocked: raw.hardBlocked,
    hardBlockReason: raw.hardBlockReason,
    // ── divergence association at TF level (§D honesty flags) ──
    multiplierOrVoteChangedDirection: raw.preHardBlockDirection !== shadowCoreDirection,
    hardBlockChangedDirection: !!(raw.hardBlocked && raw.preHardBlockDirection !== analysis.direction),
    freshness: raw.freshness || null
  };
}
async function computeEngineAudit(inputs) {
  const {
    tfResults,
    candleData,
    assetType,
    pair,
    higherTFTrend,
    marketRegime,
    session,
    sessionMult,
    candleQualityMult,
    exotic,
    newsBlock,
    newsBlocked,
    env,
    productionPreAi,
    productionPostAi
  } = inputs;
  const timeframeAudits = {};
  for (const tf of Object.keys(tfResults)) {
    const a = buildTimeframeAudit(tf, tfResults[tf]);
    if (a) timeframeAudits[tf] = a;
  }
  const shadowVotes = [];
  for (const tf of Object.keys(tfResults)) {
    const analysis = tfResults[tf];
    const raw = getShadowTfRaw(analysis);
    const alignedWithHTF = analysis.alignedWithHTF;
    if (!raw) {
      shadowVotes.push({ direction: "NO_TRADE", score: { up: 0, down: 0 }, confluence: 0, tf, alignedWithHTF });
      continue;
    }
    const minScoreThreshold = SCORE_THRESHOLDS[analysis.assetType] || 3;
    const shadowDir = raw.shadowCoreDirection || decideTfDirection(raw.preStructUp, raw.preStructDown, raw.preStructUpCat, raw.preStructDownCat, minScoreThreshold);
    const engUp = raw.shadowEngineScoreUp !== void 0 ? raw.shadowEngineScoreUp : raw.preStructUp;
    const engDown = raw.shadowEngineScoreDown !== void 0 ? raw.shadowEngineScoreDown : raw.preStructDown;
    shadowVotes.push({
      direction: shadowDir,
      score: { up: engUp, down: engDown },
      confluence: Math.max(raw.preStructUpCat, raw.preStructDownCat),
      tf,
      alignedWithHTF
    });
  }
  const shadowCtx = {
    votes: shadowVotes,
    candleData,
    tfResults,
    higherTFTrend,
    marketRegime,
    session,
    sessionMult,
    candleQualityMult,
    exotic,
    assetType,
    newsBlock,
    newsBlocked,
    pair,
    env
  };
  const shadowDet = await runDeterministicVoteAndFilters(shadowCtx);
  const attribution = classifyAttribution(productionPreAi.finalDirection, shadowDet.finalDirection);
  const aiAlteredDirection = productionPostAi.finalDirection !== productionPreAi.finalDirection;
  let comparability = "COMPARABLE_PRE_AI";
  let comparabilityReason = "production AI did not change the final direction (or AI was skipped/unavailable)";
  if (aiAlteredDirection) {
    comparability = "AI_AFFECTED";
    comparabilityReason = "production AI changed the final direction (" + productionPreAi.finalDirection + " -> " + productionPostAi.finalDirection + "); not clean structure-only evidence";
  }
  let tfHardBlockObserved = false;
  let multiplierOrVoteDivergenceObserved = false;
  let hardBlockFlippedAny = false;
  let shadowTradeTfs = 0;
  let prodTradeTfs = 0;
  for (const tf of Object.keys(timeframeAudits)) {
    const tfa = timeframeAudits[tf];
    if (tfa.hardBlocked) tfHardBlockObserved = true;
    if (tfa.multiplierOrVoteChangedDirection) multiplierOrVoteDivergenceObserved = true;
    if (tfa.hardBlockChangedDirection) hardBlockFlippedAny = true;
    if (tfa.shadowCoreDirection === "BUY" || tfa.shadowCoreDirection === "SELL") shadowTradeTfs++;
    if (tfa.productionFinalDirection === "BUY" || tfa.productionFinalDirection === "SELL") prodTradeTfs++;
  }
  const isolatedObservationEligible = productionPostAi.finalDirection === "NO_TRADE" && productionPreAi.finalDirection === "NO_TRADE" && (shadowDet.finalDirection === "BUY" || shadowDet.finalDirection === "SELL") && attribution === "STRUCTURE_SUPPRESSED";
  const audit = {
    decisionScope: "STANDARD_ENGINE_DETERMINISTIC_PRE_AI",
    attribution,
    comparability,
    comparabilityReason,
    productionPreAiDirection: productionPreAi.finalDirection,
    productionPreAiConfidence: productionPreAi.confidence,
    productionFinalDirection: productionPostAi.finalDirection,
    productionFinalConfidence: productionPostAi.confidence,
    shadowFinalDirection: shadowDet.finalDirection,
    shadowConfidence: shadowDet.confidence,
    shadowRawDirection: shadowDet.rawDirection,
    shadowFiltersApplied: shadowDet.filtersApplied,
    diagnostic: {
      tfHardBlockObserved,
      multiplierOrVoteDivergenceObserved,
      hardBlockFlippedAny,
      prodTradeTfs,
      shadowTradeTfs
    },
    timeframes: timeframeAudits,
    isolatedObservationEligible,
    // Deterministically-derivable shadow trade context (only meaningful when
    // the shadow actually produces a BUY/SELL). Entry/expiry are candle/timeframe
    // properties (non-structure), so the producing TF's values are valid for the
    // shadow trade too. Best TF = the TF whose shadowCoreDirection matches the
    // shadow engine direction with the highest no-structure score.
    shadowTradeContext: null,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (audit.shadowFinalDirection === "BUY" || audit.shadowFinalDirection === "SELL") {
    let shadowBestTF = null;
    let shadowBestScore = -Infinity;
    for (const tf of Object.keys(timeframeAudits)) {
      const tfa = timeframeAudits[tf];
      if (tfa.shadowCoreDirection !== audit.shadowFinalDirection) continue;
      const sc = audit.shadowFinalDirection === "BUY" ? tfa.shadowCoreScore.up : tfa.shadowCoreScore.down;
      if (sc > shadowBestScore) {
        shadowBestScore = sc;
        shadowBestTF = tf;
      }
    }
    let entryPrice = null;
    let expiryTime = null;
    if (shadowBestTF && tfResults[shadowBestTF]) {
      const tfr = tfResults[shadowBestTF];
      if (tfr.entry) entryPrice = tfr.entry.price;
      if (tfr.expiry) expiryTime = tfr.expiry.expiryTime;
    }
    audit.shadowTradeContext = {
      direction: audit.shadowFinalDirection,
      confidence: audit.shadowConfidence,
      alignment: shadowDet.alignment,
      bestTF: shadowBestTF,
      entryPrice,
      expiryTime
    };
  }
  return audit;
}
function sanitizeAuditForHistory(audit) {
  if (!audit || typeof audit !== "object") return null;
  const tfs = {};
  for (const tf of Object.keys(audit.timeframes || {})) {
    const t = audit.timeframes[tf];
    tfs[tf] = {
      productionPreHardBlockDirection: t.productionPreHardBlockDirection,
      productionFinalDirection: t.productionFinalDirection,
      shadowCoreDirection: t.shadowCoreDirection,
      productionScore: t.productionScore,
      productionConfluence: t.productionConfluence,
      shadowCoreScore: t.shadowCoreScore,
      shadowCoreConfluence: t.shadowCoreConfluence,
      shadowEngineScore: t.shadowEngineScore,
      shadowCandleConfirmed: t.shadowCandleConfirmed,
      shadowConfirmationPenaltyApplied: t.shadowConfirmationPenaltyApplied,
      multiplier: t.multiplier,
      structureBias: t.structureBias,
      bos: t.bos,
      choch: t.choch,
      sweep: t.sweep,
      structureSummary: t.structureSummary,
      categoryVoteApplied: t.categoryVoteApplied,
      voteDirection: t.voteDirection,
      hardBlocked: t.hardBlocked,
      hardBlockReason: t.hardBlockReason,
      multiplierOrVoteChangedDirection: t.multiplierOrVoteChangedDirection,
      hardBlockChangedDirection: t.hardBlockChangedDirection,
      freshness: t.freshness
    };
  }
  return {
    decisionScope: audit.decisionScope,
    attribution: audit.attribution,
    comparability: audit.comparability,
    comparabilityReason: audit.comparabilityReason,
    productionPreAiDirection: audit.productionPreAiDirection,
    productionFinalDirection: audit.productionFinalDirection,
    shadowFinalDirection: audit.shadowFinalDirection,
    shadowConfidence: audit.shadowConfidence,
    diagnostic: audit.diagnostic,
    timeframes: tfs
  };
}

// src/history/stats.js
function pairKey(pair) {
  return pair.replace(/\//g, "_").replace(/-/g, "_");
}
var TIE_REL_EPS = 1e-9;
function classifyOutcome(direction, entryPrice, exitPrice) {
  if (entryPrice === null || entryPrice === void 0 || exitPrice === null || exitPrice === void 0) return "UNKNOWN";
  const diff = exitPrice - entryPrice;
  const scale = Math.max(Math.abs(entryPrice), Math.abs(exitPrice), 1);
  if (Math.abs(diff) <= TIE_REL_EPS * scale) return "TIE";
  if (direction === "BUY") return diff > 0 ? "WIN" : "LOSS";
  if (direction === "SELL") return diff < 0 ? "WIN" : "LOSS";
  return "UNKNOWN";
}
var DEDUP_WINDOW_MS = 30 * 60 * 1e3;
var DEDUP_ENTRY_REL_TOLERANCE = 5e-4;
var DEDUP_ENTRY_ABS_TOLERANCE = 1e-4;
function entriesClose(a, b) {
  if (a === null || a === void 0 || b === null || b === void 0) return false;
  if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOLERANCE || diff / scale <= DEDUP_ENTRY_REL_TOLERANCE;
}
function isDuplicateRecord(newRec, prevRec) {
  if (!prevRec) return false;
  if (prevRec.direction !== newRec.direction) return false;
  if (!entriesClose(newRec.entryPrice, prevRec.entryPrice)) return false;
  try {
    const tNew = new Date(newRec.timestamp).getTime();
    const tOld = new Date(prevRec.timestamp).getTime();
    if (tNew - tOld < 0 || tNew - tOld > DEDUP_WINDOW_MS) return false;
  } catch (e) {
    return false;
  }
  return true;
}
function derivedAiStatus(signal) {
  if (!signal) return null;
  if (signal.isOTC) {
    const st = signal.aiValidation ? signal.aiValidation.status : null;
    if (st === "SKIPPED") return "SKIPPED";
    if (st === "OK") return signal.aiValidation.agrees ? "OTC_AGREE" : "OTC_DISAGREE";
    return st || null;
  }
  if (!signal.aiValidation) return null;
  if (signal.aiValidation.status === "SKIPPED") return "SKIPPED";
  const c = signal.aiValidation.combined;
  if (!c) return null;
  if (c.status === "OK" && c.agreement) return c.agreement;
  return c.status || null;
}
async function saveSignalToHistory(signal, pair, isOTC, env, signalId, entrySource) {
  if (!env || !env.SIGNAL_CACHE) return;
  if (!signalId) {
    console.warn("saveSignalToHistory skipped: missing signalId for " + pair);
    return;
  }
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const bestTF = signal.bestTimeframe || null;
    const entryPrice = signal.recommendations && bestTF ? signal.recommendations[bestTF.timeframe] && signal.recommendations[bestTF.timeframe].entry ? signal.recommendations[bestTF.timeframe].entry.price : null : null;
    const expiryTime = bestTF && bestTF.expiry ? bestTF.expiry.expiryTime : null;
    const record = {
      id: signalId,
      pair,
      isOTC,
      direction: signal.finalSignal,
      confidence: signal.confidence,
      grade: signal.grade ? signal.grade.grade : "N/A",
      entryPrice,
      expiryTime,
      bestTF: bestTF ? bestTF.timeframe : "N/A",
      alignment: signal.alignment,
      marketRegime: signal.marketRegime,
      session: signal.session ? signal.session.sessions : [],
      sessionQuality: signal.session ? signal.session.quality : "N/A",
      aiAgreed: signal.aiValidation ? signal.aiValidation.combinedAgreed : null,
      // ── B5: additive diagnostic fields (never read by existing consumers) ──
      structureVerdict: signal.structureVerdict ? signal.structureVerdict.overall || null : null,
      aiStatus: derivedAiStatus(signal),
      coreConfidence: signal.coreConfidence === void 0 || signal.coreConfidence === null ? null : signal.coreConfidence,
      entrySource: entrySource || null,
      fillStatus: signal.fillStatus || null,
      currentPrice: signal.currentPrice || null,
      entryDistancePct: signal.entryDistancePct == null ? null : signal.entryDistancePct,
      timestamp: now,
      result: null,
      exitPrice: null,
      checkedAt: null
    };
    if (signal.cbShadow === true) record.cbShadow = true;
    try {
      const _bestTF = signal.bestTimeframe && signal.bestTimeframe.timeframe;
      const _tfa = _bestTF && signal.timeframeAnalysis ? signal.timeframeAnalysis[_bestTF] : null;
      const _ind = _tfa && _tfa.indicators;
      const _last = (a) => Array.isArray(a) ? a[a.length - 1] : a;
      const _toNum = (v) => {
        if (typeof v === "number" && isFinite(v)) return Math.round(v * 1e3) / 1e3;
        if (typeof v === "string") {
          const n = parseFloat(v);
          if (isFinite(n)) return Math.round(n * 1e3) / 1e3;
        }
        return null;
      };
      const _extract = (val) => {
        if (val === null || val === void 0) return null;
        const last = _last(val);
        return _toNum(last);
      };
      const _extractRaw = (val) => {
        if (val === null || val === void 0) return null;
        const last = _last(val);
        if (typeof last === "number" && isFinite(last)) return last;
        if (typeof last === "string") {
          const n = parseFloat(last);
          return isFinite(n) ? n : null;
        }
        return null;
      };
      if (_ind && _bestTF) {
        const rsi = _extract(_ind.rsi);
        const atrRaw = _extractRaw(_ind.atr);
        const closeRaw = _tfa.entry && _tfa.entry.price != null ? typeof _tfa.entry.price === "string" ? parseFloat(_tfa.entry.price) : _tfa.entry.price : null;
        const atrPct = atrRaw !== null && closeRaw !== null && isFinite(closeRaw) && closeRaw !== 0 ? Math.round(atrRaw / closeRaw * 100 * 1e3) / 1e3 : null;
        let adx = null;
        if (_ind.adx !== null && _ind.adx !== void 0) {
          if (typeof _ind.adx === "object" && !Array.isArray(_ind.adx) && _ind.adx.adx !== void 0) {
            adx = _extract(_ind.adx.adx);
          } else {
            adx = _extract(_ind.adx);
          }
        }
        let bbBandwidth = null;
        if (_ind.bollinger && _ind.bollinger.bandwidth !== void 0) {
          bbBandwidth = _extract(_ind.bollinger.bandwidth);
        } else if (_ind.bbBandwidth !== void 0) {
          bbBandwidth = _extract(_ind.bbBandwidth);
        } else if (_ind.bollinger && typeof _ind.bollinger.bandwidth === "number") {
          bbBandwidth = _toNum(_ind.bollinger.bandwidth);
        }
        record.signalIndicators = {
          bestTF: _bestTF,
          rsi,
          atrPct,
          adx,
          bbBandwidth,
          // ── Edge features (Phase F round 2, 2026-08-10) — ADDITIVE ──
          // signal-time values of the input-side multipliers/gates, copied
          // from the engine's public edgeFeatures audit so the avoidance /
          // validation pipeline (scripts/feature_validation.py) can reproduce
          // ON/OFF tables from history rows. Fail-open: absent when the block
          // was disabled or the signal was blocked pre-edge.
          atrPercentile: signal.edgeFeatures && signal.edgeFeatures.atrPercentile != null ? _toNum(signal.edgeFeatures.atrPercentile) : null,
          bbState: signal.edgeFeatures && signal.edgeFeatures.bbState || null,
          sessionRange: signal.edgeFeatures && signal.edgeFeatures.sessionRange != null ? _toNum(signal.edgeFeatures.sessionRange) : null,
          hourUtc: signal.edgeFeatures && signal.edgeFeatures.hourUtc != null ? signal.edgeFeatures.hourUtc : null,
          hourMult: signal.edgeFeatures && signal.edgeFeatures.hourMult != null ? _toNum(signal.edgeFeatures.hourMult) : null,
          totalMult: signal.edgeFeatures && signal.edgeFeatures.totalMult != null ? _toNum(signal.edgeFeatures.totalMult) : null
        };
      }
    } catch (e) {
    }
    try {
      const r71Audit = getEngineAudit(signal);
      if (r71Audit) record.structureAudit = sanitizeAuditForHistory(r71Audit);
    } catch (e) {
    }
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(pair);
    let existing = null;
    try {
      existing = await env.SIGNAL_CACHE.get(histKey, "json");
    } catch (e) {
      existing = null;
    }
    let history = Array.isArray(existing) ? existing : [];
    const DEDUP_CHECK_DEPTH = 5;
    let duplicateOf = null;
    for (let i = 0; i < Math.min(DEDUP_CHECK_DEPTH, history.length); i++) {
      const prev = history[i];
      if (!prev || !prev.timestamp) continue;
      if (isDuplicateRecord(record, prev)) {
        duplicateOf = prev;
        break;
      }
    }
    if (duplicateOf) {
      console.log(
        "Signal deduped (re-poll):",
        signalId,
        pair,
        signal.finalSignal,
        "-> existing id",
        duplicateOf.id,
        "(entry",
        entryPrice,
        "expiry",
        expiryTime,
        ")"
      );
      return { deduped: true, duplicateOf: duplicateOf.id };
    }
    history.unshift(record);
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR)
      history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 });
    if (expiryTime) {
      await env.SIGNAL_CACHE.put(
        HISTORY_CONFIG.KV_PENDING_PREFIX + signalId,
        JSON.stringify(record),
        { expirationTtl: Math.floor(HISTORY_CONFIG.PENDING_TTL_MS / 1e3) }
      );
    }
    console.log("Signal saved:", signalId, pair, signal.finalSignal);
    return { deduped: false };
  } catch (e) {
    console.warn("saveSignalToHistory error:", e.message);
  }
}
async function scheduledTracker(env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return;
    const now = Date.now();
    let checked = 0;
    for (const kvEntry of pendingList.keys) {
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, "json");
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name);
          continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.RESULT_CHECK_DELAY * 1e3;
        if (now < checkAfterMs) continue;
        const fetchResult = await fetchExpiryPrice(record.pair, record.expiryTime, env, {
          startTimeISO: record.timestamp
        });
        if (fetchResult && fetchResult.error) {
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = (/* @__PURE__ */ new Date()).toISOString();
          if (record.checks >= HISTORY_CONFIG.PENDING_MAX_CHECKS) {
            await updateSignalResult(record, "UNKNOWN", null, env);
            await env.SIGNAL_CACHE.delete(kvEntry.name);
            console.warn("scheduledTracker gave up id=" + record.id + " pair=" + record.pair + " checks=" + record.checks + " lastErr=" + fetchResult.error);
          } else {
            const remainingMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.PENDING_TTL_MS - now;
            if (remainingMs > 6e4) {
              await env.SIGNAL_CACHE.put(
                kvEntry.name,
                JSON.stringify(record),
                { expirationTtl: Math.floor(remainingMs / 1e3) }
              );
            } else {
              await updateSignalResult(record, "UNKNOWN", null, env);
              await env.SIGNAL_CACHE.delete(kvEntry.name);
              console.warn("scheduledTracker ttl-expired id=" + record.id + " pair=" + record.pair + " checks=" + record.checks + " lastErr=" + fetchResult.error);
            }
          }
          checked++;
          if (checked >= 10) break;
          continue;
        }
        const exitPrice = fetchResult ? fetchResult.price : null;
        let winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);
        if (record.entryPrice != null && fetchResult && fetchResult.postSignal && fetchResult.postSignal.length) {
          const entry = record.entryPrice;
          const eps = 1e-9 * Math.max(Math.abs(entry), 1);
          const cs = fetchResult.postSignal;
          const dir = record.direction;
          let legacy = null;
          if (fetchResult.windowLow != null && fetchResult.windowHigh != null) {
            legacy = dir === "BUY" ? fetchResult.windowLow <= entry + 1e-12 : dir === "SELL" ? fetchResult.windowHigh >= entry - 1e-12 : null;
          }
          let corrected = false;
          if (record.fillStatus === "PENDING_ENTRY") {
            if (dir === "BUY") corrected = cs.some((c) => c.low <= entry + eps);
            if (dir === "SELL") corrected = cs.some((c) => c.high >= entry - eps);
          } else if (dir === "BUY" || dir === "SELL") {
            let left = false;
            for (const c of cs) {
              if (dir === "BUY" && !left && c.high > entry + eps) left = true;
              if (dir === "SELL" && !left && c.low < entry - eps) left = true;
              if (left && dir === "BUY" && c.low <= entry + eps) {
                corrected = true;
                break;
              }
              if (left && dir === "SELL" && c.high >= entry - eps) {
                corrected = true;
                break;
              }
            }
          }
          record.entryHit = corrected;
          record.entryHitLegacy = legacy;
          record.entryHitWindowLow = cs.reduce((m, c) => Math.min(m, c.low), Infinity);
          record.entryHitWindowHigh = cs.reduce((m, c) => Math.max(m, c.high), -Infinity);
          record.entryHitWindowStart = record.timestamp;
          record.entryHitWindowEnd = record.expiryTime;
        } else {
          record.entryHit = null;
          record.entryHitLegacy = null;
        }
        if (!record.cbShadow && record.fillStatus === "PENDING_ENTRY" && record.entryHit === false) {
          winLoss = "TIE";
        }
        await updateSignalResult(record, winLoss, exitPrice, env);
        await env.SIGNAL_CACHE.delete(kvEntry.name);
        if (!record.cbShadow) await updatePairStats(record.pair, winLoss, record, env);
        await pushResultToSubscribers(record, winLoss, exitPrice, env);
        checked++;
        if (checked >= 10) break;
      } catch (e) {
        console.warn("Cron check error for " + kvEntry.name + ":", e.message);
      }
    }
    if (checked > 0) console.log("Cron: checked " + checked + " expired signals");
  } catch (e) {
    console.warn("scheduledTracker error:", e.message);
  }
}
async function fetchExpiryPrice(pair, expiryTimeISO, env, opts = {}) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: "NO_API_KEYS" };
  const basePair = String(pair).replace(/-OTC$/i, "");
  const symbol = basePair.includes("/") ? basePair : basePair.slice(0, 3) + "/" + basePair.slice(3);
  const expiryMs = new Date(expiryTimeISO).getTime();
  if (!Number.isFinite(expiryMs)) return { error: "BAD_EXPIRY_TIME" };
  const startTimeISO = opts && opts.startTimeISO;
  const parsedSignalMs = startTimeISO == null ? NaN : new Date(startTimeISO).getTime();
  const hasSignalStart = Number.isFinite(parsedSignalMs);
  const signalMs = hasSignalStart ? parsedSignalMs : null;
  const requestedStartMs = hasSignalStart ? signalMs - 60 * 1e3 : expiryMs - 5 * 60 * 1e3;
  const requestedEndMs = hasSignalStart ? expiryMs + 60 * 1e3 : expiryMs + 5 * 60 * 1e3;
  const startDate = new Date(requestedStartMs).toISOString().slice(0, 19).replace("T", " ");
  const endDate = new Date(requestedEndMs).toISOString().slice(0, 19).replace("T", " ");
  const startIdx = await getNextRotationIndex(env, apiKeys.length);
  const maxAttempts = apiKeys.length;
  let lastErr = { error: "UNKNOWN" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyIdx = (startIdx + attempt) % apiKeys.length;
    const apiKey = apiKeys[keyIdx];
    try {
      const u = new URL("/time_series", CONFIG.API_BASE_URL);
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("interval", "1min");
      u.searchParams.set("start_date", startDate);
      u.searchParams.set("end_date", endDate);
      u.searchParams.set("apikey", apiKey);
      u.searchParams.set("format", "JSON");
      u.searchParams.set("timezone", "UTC");
      await incrementQuota(env);
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      let res;
      try {
        res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: "application/json" } });
      } finally {
        clearTimeout(tid);
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        console.warn("fetchExpiryPrice non-ok pair=" + pair + " keyIdx=" + keyIdx + " status=" + res.status + " body=" + bodyText.slice(0, 200));
        lastErr = res.status === 429 ? { error: "RATE_LIMITED", status: 429, body: bodyText.slice(0, 200) } : { error: "HTTP_" + res.status, status: res.status, body: bodyText.slice(0, 200) };
        continue;
      }
      const data = await res.json();
      if (data.status === "error") {
        console.warn("fetchExpiryPrice td-error pair=" + pair + " keyIdx=" + keyIdx + " code=" + data.code + " msg=" + String(data.message || "").slice(0, 200));
        lastErr = { error: "TD_ERROR", status: data.code, body: String(data.message || "").slice(0, 200) };
        continue;
      }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
        console.warn("fetchExpiryPrice empty pair=" + pair + " keyIdx=" + keyIdx + " body=" + JSON.stringify(data).slice(0, 200));
        lastErr = { error: "EMPTY_VALUES" };
        continue;
      }
      const candles = [];
      let closest = null;
      let minDiff = Infinity;
      for (const c of data.values) {
        if (!c || !c.datetime) continue;
        const datetime = String(c.datetime);
        const isoDatetime = datetime.includes("T") ? datetime : datetime.replace(" ", "T");
        const zonedDatetime = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoDatetime) ? isoDatetime : isoDatetime + "Z";
        const stamp = new Date(zonedDatetime).getTime();
        if (!Number.isFinite(stamp)) continue;
        const diff = Math.abs(stamp - expiryMs);
        if (diff < minDiff) {
          minDiff = diff;
          closest = c;
        }
        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const close = parseFloat(c.close);
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
        candles.push({ datetime, stamp, open, high, low, close });
      }
      candles.sort((a, b) => a.stamp - b.stamp);
      if (closest && minDiff <= 12e4) {
        const px = parseFloat(closest.close);
        if (Number.isFinite(px)) {
          const legacyStartMs = expiryMs - 5 * 60 * 1e3;
          const legacyEndMs = expiryMs + 5 * 60 * 1e3;
          let lo = Infinity, hi = -Infinity;
          for (const candle of candles) {
            if (candle.stamp < legacyStartMs || candle.stamp > legacyEndMs) continue;
            if (candle.low < lo) lo = candle.low;
            if (candle.high > hi) hi = candle.high;
          }
          return {
            price: px,
            candles,
            windowLow: Number.isFinite(lo) ? lo : null,
            windowHigh: Number.isFinite(hi) ? hi : null,
            windowStart: startDate,
            windowEnd: endDate,
            postSignal: hasSignalStart ? candles.filter((candle) => candle.stamp > signalMs) : null
          };
        }
        lastErr = { error: "BAD_CLOSE_VALUE", body: String(closest.close).slice(0, 200) };
        continue;
      }
      console.warn("fetchExpiryPrice no-match pair=" + pair + " keyIdx=" + keyIdx + " minDiff=" + minDiff);
      lastErr = { error: "NO_MATCH_WITHIN_120S", body: "minDiff=" + minDiff };
    } catch (e) {
      console.warn("fetchExpiryPrice exception pair=" + pair + " keyIdx=" + keyIdx + " attempt=" + attempt + " msg=" + e.message);
      lastErr = { error: "EXCEPTION", body: e.message };
    }
  }
  return lastErr;
}
async function updateSignalResult(record, winLoss, exitPrice, env) {
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(record.pair);
    const existing = await env.SIGNAL_CACHE.get(histKey, "json");
    if (!Array.isArray(existing)) return;
    for (const sig of existing) {
      if (sig.id === record.id) {
        sig.result = winLoss;
        sig.exitPrice = exitPrice;
        sig.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
        if (record.entryHit !== void 0) sig.entryHit = record.entryHit;
        if (record.entryHitLegacy !== void 0) sig.entryHitLegacy = record.entryHitLegacy;
        if (record.entryHitWindowLow !== void 0) sig.entryHitWindowLow = record.entryHitWindowLow;
        if (record.entryHitWindowHigh !== void 0) sig.entryHitWindowHigh = record.entryHitWindowHigh;
        if (record.entryHitWindowStart !== void 0) sig.entryHitWindowStart = record.entryHitWindowStart;
        if (record.entryHitWindowEnd !== void 0) sig.entryHitWindowEnd = record.entryHitWindowEnd;
        break;
      }
    }
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(existing), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (e) {
    console.warn("updateSignalResult error:", e.message);
  }
}
async function getDynamicConfidenceAdjustment(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return 0;
  try {
    const stats = await env.SIGNAL_CACHE.get(HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair), "json");
    if (!stats || typeof stats.winRate !== "number" || stats.sampleSize < 5) return 0;
    const wr = stats.winRate;
    if (wr >= 0.7) return HISTORY_CONFIG.CONFIDENCE_BONUS;
    if (wr >= HISTORY_CONFIG.CONFIDENCE_BONUS_THRESHOLD) return 3;
    if (wr <= 0.35) return HISTORY_CONFIG.CONFIDENCE_PENALTY;
    if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5;
    return 0;
  } catch (e) {
    return 0;
  }
}
async function updatePairStats(pair, winLoss, record, env) {
  if (!env || !env.SIGNAL_CACHE || winLoss !== "WIN" && winLoss !== "LOSS") return;
  try {
    const statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair);
    let stats = await env.SIGNAL_CACHE.get(statsKey, "json");
    if (!stats) stats = {
      pair,
      totalSignals: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      sampleSize: 0,
      bySession: {},
      byTF: {},
      byRegime: {},
      lastUpdated: null,
      recentResults: []
    };
    stats.totalSignals++;
    if (winLoss === "WIN") stats.wins++;
    if (winLoss === "LOSS") stats.losses++;
    if (!Array.isArray(stats.recentResults)) stats.recentResults = [];
    stats.recentResults.push(winLoss);
    if (stats.recentResults.length > HISTORY_CONFIG.WIN_RATE_LOOKBACK)
      stats.recentResults = stats.recentResults.slice(-HISTORY_CONFIG.WIN_RATE_LOOKBACK);
    const windowedWins = stats.recentResults.filter((r) => r === "WIN").length;
    stats.winRate = stats.recentResults.length > 0 ? Math.round(windowedWins / stats.recentResults.length * 1e3) / 1e3 : 0;
    stats.sampleSize = stats.recentResults.length;
    stats.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
    for (const sess of record.session || []) {
      if (!stats.bySession[sess]) stats.bySession[sess] = { wins: 0, losses: 0, winRate: 0 };
      if (winLoss === "WIN") stats.bySession[sess].wins++;
      if (winLoss === "LOSS") stats.bySession[sess].losses++;
      const sd = stats.bySession[sess].wins + stats.bySession[sess].losses;
      stats.bySession[sess].winRate = sd > 0 ? Math.round(stats.bySession[sess].wins / sd * 1e3) / 1e3 : 0;
    }
    const tf = record.bestTF || "N/A";
    if (!stats.byTF[tf]) stats.byTF[tf] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === "WIN") stats.byTF[tf].wins++;
    if (winLoss === "LOSS") stats.byTF[tf].losses++;
    const td = stats.byTF[tf].wins + stats.byTF[tf].losses;
    stats.byTF[tf].winRate = td > 0 ? Math.round(stats.byTF[tf].wins / td * 1e3) / 1e3 : 0;
    const regime = record.marketRegime || "UNKNOWN";
    if (!stats.byRegime[regime]) stats.byRegime[regime] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === "WIN") stats.byRegime[regime].wins++;
    if (winLoss === "LOSS") stats.byRegime[regime].losses++;
    const rd = stats.byRegime[regime].wins + stats.byRegime[regime].losses;
    stats.byRegime[regime].winRate = rd > 0 ? Math.round(stats.byRegime[regime].wins / rd * 1e3) / 1e3 : 0;
    await env.SIGNAL_CACHE.put(statsKey, JSON.stringify(stats), { expirationTtl: 60 * 60 * 24 * 90 });
    await applyResult(pair, winLoss, env);
  } catch (e) {
    console.warn("updatePairStats error:", e.message);
  }
}

// src/history/latestCache.js
function latestKey(pair) {
  return SCAN_CONFIG.KV_LATEST_PREFIX + String(pair).replace(/\//g, "_").replace(/-/g, "_").toUpperCase();
}
function pairFromLatestKey(keyName) {
  const raw = String(keyName).slice(SCAN_CONFIG.KV_LATEST_PREFIX.length);
  if (raw.endsWith("_OTC")) return raw.slice(0, -4) + "-OTC";
  const i = raw.indexOf("_");
  return i === -1 ? raw : raw.slice(0, i) + "/" + raw.slice(i + 1);
}
function enrichAge(cached, now = Date.now()) {
  if (!cached || typeof cached !== "object") return cached;
  const genTime = new Date(cached.generatedAt).getTime();
  if (!Number.isFinite(genTime)) {
    return { ...cached, generationAge: null, nextRefreshIn: null, stale: true };
  }
  const ageSeconds = Math.max(0, Math.floor((now - genTime) / 1e3));
  const interval = SCAN_CONFIG.SCAN_INTERVAL_SECONDS;
  return {
    ...cached,
    generationAge: ageSeconds,
    nextRefreshIn: Math.max(0, interval - ageSeconds % interval),
    stale: ageSeconds >= SCAN_CONFIG.LATEST_TTL_SECONDS
  };
}
function isStale(cached, now = Date.now()) {
  if (!cached) return true;
  const genTime = new Date(cached.generatedAt).getTime();
  if (!Number.isFinite(genTime)) return true;
  return (now - genTime) / 1e3 >= SCAN_CONFIG.LATEST_TTL_SECONDS;
}
async function readLatest(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const cached = await env.SIGNAL_CACHE.get(latestKey(pair), "json");
    return cached && typeof cached === "object" ? cached : null;
  } catch (e) {
    console.warn("readLatest error " + pair + ": " + e.message);
    return null;
  }
}
async function writeLatest(pair, payload, meta, env) {
  if (!env || !env.SIGNAL_CACHE || !payload) return false;
  try {
    const record = {
      ...payload,
      cached: true,
      generatedAt: meta && meta.generatedAt || (/* @__PURE__ */ new Date()).toISOString(),
      generationId: meta && meta.generationId || null,
      opportunistic: !!(meta && meta.opportunistic)
    };
    await env.SIGNAL_CACHE.put(latestKey(pair), JSON.stringify(record), {
      expirationTtl: SCAN_CONFIG.LATEST_TTL_SECONDS
    });
    return true;
  } catch (e) {
    console.warn("writeLatest error " + pair + ": " + e.message);
    return false;
  }
}

// src/handlers/latest.js
async function handleLatest(url, env) {
  if (!env || !env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: "SIGNAL_CACHE KV not bound" }, 503);
  }
  const rawPair = url.searchParams.get("pair");
  if (rawPair) {
    const pair = sanitizePair(rawPair);
    if (!pair) {
      return jsonResponse({
        error: true,
        message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.'
      }, 400);
    }
    const cached = await readLatest(pair, env);
    if (!cached) {
      return jsonResponse({
        error: true,
        stale: true,
        pair,
        message: "No cached signal for " + pair + ". Use /api/signal?pair=" + encodeURIComponent(pair) + " for fresh generation, or wait for the next scan cycle.",
        scanned: SCAN_PAIRS.includes(pair),
        scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }, 404);
    }
    const enriched = enrichAge(cached);
    if (enriched.stale) {
      return jsonResponse({
        error: true,
        stale: true,
        pair,
        message: "Cached signal expired, next scan due.",
        generatedAt: cached.generatedAt,
        generationAge: enriched.generationAge,
        scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      }, 404);
    }
    return jsonResponse(enriched);
  }
  let list;
  try {
    list = await env.SIGNAL_CACHE.list({ prefix: SCAN_CONFIG.KV_LATEST_PREFIX });
  } catch (e) {
    return jsonResponse({ error: true, message: "Cache list failed: " + e.message }, 500);
  }
  const keys = list && list.keys || [];
  const signals = {};
  let staleCount = 0;
  for (const key of keys) {
    try {
      const cached = await env.SIGNAL_CACHE.get(key.name, "json");
      if (!cached) continue;
      const enriched = enrichAge(cached);
      if (enriched.stale) {
        staleCount++;
        continue;
      }
      signals[pairFromLatestKey(key.name)] = enriched;
    } catch (e) {
    }
  }
  const ages = Object.values(signals).map((s) => s.generationAge).filter((a) => typeof a === "number");
  return jsonResponse({
    cached: true,
    signals,
    pairCount: Object.keys(signals).length,
    scannedPairs: SCAN_PAIRS,
    scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
    oldestCachedAge: ages.length ? Math.max(...ages) : null,
    newestCachedAge: ages.length ? Math.min(...ages) : null,
    staleSkipped: staleCount,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function getScanCacheStats(env) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const list = await env.SIGNAL_CACHE.list({ prefix: SCAN_CONFIG.KV_LATEST_PREFIX });
    const keys = list && list.keys || [];
    let lastGenerationId = null;
    let newestAt = -Infinity;
    let opportunisticCount = 0;
    const ages = [];
    for (const key of keys) {
      try {
        const cached = await env.SIGNAL_CACHE.get(key.name, "json");
        if (!cached || !cached.generatedAt) continue;
        const t = new Date(cached.generatedAt).getTime();
        if (!Number.isFinite(t)) continue;
        ages.push(Math.max(0, Math.floor((Date.now() - t) / 1e3)));
        if (cached.opportunistic) opportunisticCount++;
        if (t > newestAt && cached.generationId) {
          newestAt = t;
          lastGenerationId = cached.generationId;
        }
      } catch (e) {
      }
    }
    return {
      lastGenerationId,
      cachedPairCount: keys.length,
      oldestCachedAge: ages.length ? Math.max(...ages) : null,
      newestCachedAge: ages.length ? Math.min(...ages) : null,
      opportunisticCount,
      scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
      ttlSeconds: SCAN_CONFIG.LATEST_TTL_SECONDS,
      scannedPairs: SCAN_PAIRS.length
    };
  } catch (e) {
    return { error: "scanCache unavailable: " + e.message };
  }
}

// src/history/selfCalib.js
function confBucketOf(rawConf) {
  let c = rawConf;
  if (typeof c === "string") {
    const m = c.match(/([\d.]+)/);
    if (m) c = parseFloat(m[1]);
  }
  if (typeof c !== "number" || isNaN(c)) c = 72;
  if (c < 75) return "72-75";
  if (c < 80) return "76-79";
  if (c < 84) return "80-83";
  if (c < 88) return "84-87";
  return "88+";
}
function addWinLoss(table, key, winLoss) {
  if (!table[key]) table[key] = { wins: 0, losses: 0, n: 0, wr: 0 };
  const t = table[key];
  if (winLoss === "WIN") t.wins++;
  else if (winLoss === "LOSS") t.losses++;
  t.n = t.wins + t.losses;
  t.wr = t.n > 0 ? t.wins / t.n : 0;
}
async function recomputeCalibration(env) {
  try {
    if (!env || !env.SIGNAL_CACHE) return null;
    const windowMs = (CONFIG.SELF_CALIB.WINDOW_DAYS || 14) * 24 * 3600 * 1e3;
    const cutoff = Date.now() - windowMs;
    const list = await env.SIGNAL_CACHE.list({ prefix: "sig:" });
    if (!list || !list.keys || list.keys.length === 0) return null;
    const rows = [];
    for (const kv of list.keys) {
      let history = null;
      try {
        history = await env.SIGNAL_CACHE.get(kv.name, "json");
      } catch (e) {
        continue;
      }
      if (!Array.isArray(history)) continue;
      for (const rec of history) {
        if (!rec || rec.result !== "WIN" && rec.result !== "LOSS") continue;
        const t = rec.timestamp ? new Date(rec.timestamp).getTime() : NaN;
        if (!isFinite(t) || t < cutoff) continue;
        rows.push(rec);
      }
    }
    if (rows.length < (CONFIG.SELF_CALIB.MIN_OBS || 100)) {
      console.log("selfCalib: only " + rows.length + " decided rows in window \u2014 keeping previous tables (min " + (CONFIG.SELF_CALIB.MIN_OBS || 100) + ")");
      return null;
    }
    const structWR = {};
    const confBucketWR = {};
    const hourWR = {};
    const pairWR = {};
    const sessionWR = {};
    let wins = 0;
    for (const rec of rows) {
      if (rec.result === "WIN") wins++;
      const struct = rec.structureVerdict || "N/A";
      addWinLoss(structWR, struct, rec.result);
      const bucket = confBucketOf(rec.coreConfidence);
      addWinLoss(confBucketWR, bucket, rec.result);
      try {
        const dt = new Date(rec.timestamp);
        const hour = dt.getUTCHours();
        if (!isNaN(hour)) addWinLoss(hourWR, hour, rec.result);
      } catch (e) {
      }
      addWinLoss(pairWR, rec.pair || "UNKNOWN", rec.result);
      const sess = rec.sessionQuality && rec.sessionQuality !== "N/A" ? rec.sessionQuality : null;
      if (sess) addWinLoss(sessionWR, sess, rec.result);
    }
    const base = wins / rows.length;
    const { CALIB: CALIB2 } = await Promise.resolve().then(() => (init_calibration(), calibration_exports));
    const minCell = CONFIG.SELF_CALIB.MIN_CELL_OBS || 30;
    const mergedStruct = { ...CALIB2.structWR };
    const mergedConf = { ...CALIB2.confBucketWR };
    for (const k of Object.keys(structWR)) {
      if (structWR[k].n >= minCell) mergedStruct[k] = structWR[k].wr;
    }
    for (const k of Object.keys(confBucketWR)) {
      if (confBucketWR[k].n >= minCell) mergedConf[k] = confBucketWR[k].wr;
    }
    const payload = {
      version: "selfcalib-" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
      computedAt: (/* @__PURE__ */ new Date()).toISOString(),
      windowDays: CONFIG.SELF_CALIB.WINDOW_DAYS || 14,
      n: rows.length,
      base,
      structWR: mergedStruct,
      confBucketWR: mergedConf,
      hourWR,
      pairWR,
      sessionWR
    };
    await env.SIGNAL_CACHE.put(
      CONFIG.SELF_CALIB.KV_KEY || "calib:latest",
      JSON.stringify(payload),
      { expirationTtl: ((CONFIG.SELF_CALIB.WINDOW_DAYS || 14) + 2) * 24 * 3600 }
    );
    console.log("selfCalib: recomputed from " + rows.length + " rows (base WR " + (base * 100).toFixed(1) + "%)");
    return payload;
  } catch (e) {
    console.warn("selfCalib recompute failed (fail-open): " + e.message);
    return null;
  }
}
async function loadCalibration(env) {
  try {
    if (!env || !env.SIGNAL_CACHE) return null;
    const raw = await env.SIGNAL_CACHE.get(CONFIG.SELF_CALIB.KV_KEY || "calib:latest", "json");
    if (!raw || typeof raw !== "object") return null;
    const computedAt = raw.computedAt ? new Date(raw.computedAt).getTime() : NaN;
    const maxAge = (CONFIG.SELF_CALIB.MAX_AGE_DAYS || 8) * 24 * 3600 * 1e3;
    if (!isFinite(computedAt) || Date.now() - computedAt > maxAge) return null;
    if (typeof raw.base !== "number" || typeof raw.structWR !== "object" || typeof raw.confBucketWR !== "object") return null;
    return raw;
  } catch (e) {
    return null;
  }
}

// src/handlers/health.js
init_calibration();
async function handleHealth(env) {
  const keyCount = getApiKeys(env).length;
  const keySource = env.TWELVEDATA_API_KEYS ? "TWELVEDATA_API_KEYS (JSON array)" : "TWELVEDATA_API_KEY_N (individual vars)";
  const session = detectTradingSession();
  const newsBlock = checkNewsBlackout(ASSET_TYPE.FOREX);
  const forexOpen = isForexMarketOpen();
  const holiday = getForexHoliday();
  const quotaUsedToday = await readQuota(env);
  const rotationIdx = await readRotationIndex(env);
  const scanCache = await getScanCacheStats(env);
  const phase10 = await getPushStats(env, { validateToken: true });
  return jsonResponse({
    status: "healthy",
    version: "6.10.4",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    apiKeys: { configured: keyCount, source: keySource, status: keyCount > 0 ? "ready" : "NO KEYS" },
    apiKeysLoaded: keyCount,
    quotaUsedToday,
    rotationIdx,
    bindings: {
      kvCache: env.SIGNAL_CACHE ? "ready" : "NOT CONFIGURED",
      rateLimiter: env.RATE_LIMITER ? "ready" : "KV fallback",
      cerebrasAI: env.CEREBRAS_API_KEY ? "ready" : "NOT CONFIGURED (add CEREBRAS_API_KEY secret)"
    },
    currentSession: session,
    newsBlackout: newsBlock || { blocked: false, label: "NONE" },
    markets: {
      forex: { status: forexOpen ? "OPEN" : "CLOSED", holiday: holiday || "NONE", currencies: VALID_FOREX_CURRENCIES.length, hours: "Mon-Fri 24h (Sun 22:00 UTC to Fri 22:00 UTC)" },
      crypto: { status: "ALWAYS OPEN (24/7)", bases: CRYPTO_BASES, quotes: CRYPTO_QUOTES, topPairs: POPULAR_CRYPTO_PAIRS.slice(0, 10) }
    },
    filters: { minConfidenceFloor: CONFIG.MIN_CONFIDENCE_FLOOR + "%", volumeSpikeMultiplier: CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER + "x", newsBlackoutMargin: CONFIG.NEWS_BLACKOUT_MINUTES + " min", batchMaxPairs: CONFIG.BATCH_MAX_PAIRS },
    // Phase 7 — cron scanner cache. oldestCachedAge well above scanIntervalSec
    // means the */5 scan is failing or being skipped.
    scanCache,
    // Phase 10 — cross-surface Telegram push.
    // pushEnabled false  → BOT_TOKEN missing/blank on THIS worker (fttotcv6).
    // noTokenReason      → 'missing' | 'empty' | 'invalid' | 'error' | null.
    // lastAttempt        → last pushSignalToSubscribers outcome (even no-match
    //                      / telegram-fail). Survives result-push deleting
    //                      pushLog:* so pushesLast24h=0 is no longer silent.
    phase10,
    push: {
      enabled: !!(phase10 && phase10.pushEnabled),
      noTokenReason: phase10 ? phase10.noTokenReason : "missing",
      tokenValid: phase10 ? phase10.tokenValid : null,
      tokenUsername: phase10 ? phase10.tokenUsername : null,
      lastAttempt: phase10 ? phase10.lastAttempt : null,
      subscribers: phase10 ? phase10.subscribers : [],
      // Durable 24h delivery counter (KV push:delivered24h). Result-push
      // deletes pushLog:<id>, so this — not pushLogsOpen — is the number that
      // must increment when a Telegram DM actually lands.
      delivered24h: phase10 ? phase10.pushesLast24h : null
    },
    history: {
      enabled: !!env.SIGNAL_CACHE,
      maxPerPair: HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR,
      winRateLookback: HISTORY_CONFIG.WIN_RATE_LOOKBACK,
      resultCheckDelay: HISTORY_CONFIG.RESULT_CHECK_DELAY + "s after expiry",
      endpoints: { history: "/api/history?pair=EUR/USD&limit=20", stats: "/api/stats?pair=EUR/USD", report: "/api/report?id=SIGNAL_ID&result=WIN" }
    }
  });
}
function handlePairs() {
  const majorBases = ["EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY"];
  const majorPairs = [];
  for (const b of majorBases) for (const q of majorBases) if (b !== q) majorPairs.push(b + "/" + q);
  const exoticQ = ["SEK", "NOK", "DKK", "PLN", "HUF", "CZK", "TRY", "ZAR", "MXN", "SGD", "HKD", "CNH", "THB", "INR", "BRL"];
  const crossPairs = [];
  for (const b of ["EUR", "USD", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]) for (const q of exoticQ) crossPairs.push(b + "/" + q);
  const allCrypto = [];
  for (const b of CRYPTO_BASES) {
    for (const q of CRYPTO_QUOTES) if (b !== q) allCrypto.push(b + "/" + q);
    for (const q of ["AUD", "CAD", "CHF", "NZD", "HKD", "SGD"]) allCrypto.push(b + "/" + q);
  }
  return jsonResponse({
    forex: { currencies: VALID_FOREX_CURRENCIES, currencyCount: VALID_FOREX_CURRENCIES.length, majorPairs: majorPairs.slice(0, 30), crossExoticExamples: crossPairs.slice(0, 30), marketHours: "Sunday 22:00 UTC to Friday 22:00 UTC" },
    crypto: { bases: CRYPTO_BASES, quotes: CRYPTO_QUOTES, popularPairs: POPULAR_CRYPTO_PAIRS, allPairs: allCrypto, marketHours: "24/7" },
    usage: { forexExample: "/api/signal?pair=EUR/USD", cryptoExample: "/api/signal?pair=BTC/USD", batchExample: "/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD" }
  });
}
async function handleHistory(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: "SIGNAL_CACHE KV not configured." }, 503);
  const rawPair = url.searchParams.get("pair") || "EUR/USD";
  const pair = sanitizePair(rawPair);
  if (!pair) return jsonResponse({ error: true, message: "Invalid pair: " + rawPair }, 400);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 500);
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, "_").replace(/-/g, "_");
    let history = await env.SIGNAL_CACHE.get(histKey, "json");
    if (!Array.isArray(history)) history = [];
    const limited = history.slice(0, limit);
    for (const s of limited) {
      if (s && Object.prototype.hasOwnProperty.call(s, "structureAudit")) delete s.structureAudit;
    }
    const nonShadow = limited.filter((s) => !(s && s.cbShadow === true));
    const decided = nonShadow.filter((s) => s.result === "WIN" || s.result === "LOSS");
    const wins = decided.filter((s) => s.result === "WIN").length;
    return jsonResponse({ pair, total: history.length, showing: limited.length, decided: decided.length, pending: nonShadow.filter((s) => s.result === null).length, winRate: decided.length > 0 ? Math.round(wins / decided.length * 1e3) / 1e3 : null, signals: limited, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (e) {
    return jsonResponse({ error: true, message: "History fetch error: " + e.message }, 500);
  }
}
async function handleStats(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: "SIGNAL_CACHE KV not configured." }, 503);
  const rawPair = url.searchParams.get("pair");
  try {
    if (rawPair) {
      const pair = sanitizePair(rawPair);
      if (!pair) return jsonResponse({ error: true, message: "Invalid pair: " + rawPair }, 400);
      const statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, "_").replace(/-/g, "_");
      const stats = await env.SIGNAL_CACHE.get(statsKey, "json");
      if (!stats) return jsonResponse({ pair, message: "No stats yet.", stats: null, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      stats.dynamicConfidenceAdjustment = await getDynamicConfidenceAdjustment(pair, env);
      return jsonResponse({ pair, stats, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    } else {
      const allStats = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_STATS_PREFIX });
      if (!allStats || !allStats.keys || allStats.keys.length === 0)
        return jsonResponse({ message: "No stats yet.", pairs: [], timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      const summary = [];
      for (const key of allStats.keys) {
        try {
          const st = await env.SIGNAL_CACHE.get(key.name, "json");
          if (st) summary.push({ pair: st.pair, winRate: st.winRate, totalSignals: st.totalSignals, wins: st.wins, losses: st.losses, lastUpdated: st.lastUpdated });
        } catch (e) {
        }
      }
      summary.sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
      return jsonResponse({ totalPairs: summary.length, pairs: summary, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    }
  } catch (e) {
    return jsonResponse({ error: true, message: "Stats error: " + e.message }, 500);
  }
}
async function handleCalib(env) {
  const dynamic = await loadCalibration(env);
  return jsonResponse({
    calibration: {
      static: {
        version: CALIB.version,
        base: CALIB.base,
        structWR: CALIB.structWR,
        confBucketWR: CALIB.confBucketWR,
        gradeThresholds: CALIB.gradeThresholds,
        confThresholds: CALIB.confThresholds
      },
      dynamic: dynamic ? {
        version: dynamic.version,
        computedAt: dynamic.computedAt,
        windowDays: dynamic.windowDays,
        n: dynamic.n,
        base: dynamic.base,
        structWR: dynamic.structWR,
        confBucketWR: dynamic.confBucketWR,
        hourWR: dynamic.hourWR,
        pairWR: dynamic.pairWR,
        sessionWR: dynamic.sessionWR
      } : null,
      refresh: {
        cron: CONFIG.SELF_CALIB.CRON,
        windowDays: CONFIG.SELF_CALIB.WINDOW_DAYS,
        minObs: CONFIG.SELF_CALIB.MIN_OBS,
        maxAgeDays: CONFIG.SELF_CALIB.MAX_AGE_DAYS
      },
      edgeFeatures: {
        enabled: CONFIG.EDGE_FEATURES.enabled,
        hourMultipliers: CONFIG.EDGE_FEATURES.HOUR_MULTIPLIERS,
        rsiDirectionGate: CONFIG.EDGE_FEATURES.RSI_DIRECTION_GATE,
        volState: CONFIG.EDGE_FEATURES.VOL_STATE,
        atrPercentile: CONFIG.EDGE_FEATURES.ATR_PERCENTILE,
        sessionRange: CONFIG.EDGE_FEATURES.SESSION_RANGE,
        recentForm: CONFIG.EDGE_FEATURES.RECENT_FORM
      }
    }
  });
}
async function handleReport(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: "SIGNAL_CACHE KV not configured." }, 503);
  const signalId = url.searchParams.get("id");
  const result = (url.searchParams.get("result") || "").toUpperCase();
  if (!signalId) return jsonResponse({ error: true, message: "Signal ID required: ?id=SIGNAL_ID" }, 400);
  if (!["WIN", "LOSS"].includes(result)) return jsonResponse({ error: true, message: "result must be WIN or LOSS" }, 400);
  try {
    const allKeys = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX });
    if (!allKeys || !allKeys.keys || allKeys.keys.length === 0)
      return jsonResponse({ error: true, message: "Signal ID not found: " + signalId }, 404);
    let found = false;
    let foundRecord = null;
    let shouldUpdateStats = false;
    for (const kvEntry of allKeys.keys) {
      const histKey = kvEntry.name;
      const history = await env.SIGNAL_CACHE.get(histKey, "json");
      if (!Array.isArray(history)) continue;
      for (const sig of history) {
        if (sig.id === signalId) {
          foundRecord = sig;
          const alreadyDecided = sig.result === "WIN" || sig.result === "LOSS";
          if (!alreadyDecided) {
            sig.result = result;
            sig.checkedAt = (/* @__PURE__ */ new Date()).toISOString();
            sig.reportedManually = true;
            await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 });
            shouldUpdateStats = true;
          }
          await env.SIGNAL_CACHE.delete(HISTORY_CONFIG.KV_PENDING_PREFIX + signalId).catch(() => {
          });
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return jsonResponse({ error: true, message: "Signal ID not found: " + signalId }, 404);
    if (shouldUpdateStats && foundRecord) await updatePairStats(foundRecord.pair, result, foundRecord, env);
    return jsonResponse({
      success: true,
      signalId,
      pair: foundRecord?.pair || "N/A",
      result,
      alreadyRecorded: !shouldUpdateStats,
      message: shouldUpdateStats ? "Result recorded. Stats updated." : "Result already recorded \u2014 stats not double-counted.",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (e) {
    return jsonResponse({ error: true, message: "Report error: " + e.message }, 500);
  }
}

// src/fetch/candles.js
async function fetchCandlesWithCache(pair, tf, limit, env, ctx, assetType) {
  const cacheKey = "c:" + pair + ":" + tf + ":" + limit;
  const ttl = CONFIG.CACHE_TTL[tf] || 60;
  if (env.SIGNAL_CACHE) {
    try {
      const cached = await env.SIGNAL_CACHE.get(cacheKey, "json");
      if (cached && Array.isArray(cached) && cached.length > 0)
        return { candles: cached, _fromCache: true };
    } catch (e) {
      console.warn("Cache read err:", e.message);
    }
  }
  const result = await fetchCandles(pair, tf, limit, env, assetType);
  if (result.error) return result;
  if (env.SIGNAL_CACHE && ctx && Array.isArray(result) && result.length > 0) {
    ctx.waitUntil(
      env.SIGNAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: Math.max(60, ttl) }).catch((e) => console.warn("Cache write err:", e.message))
    );
  }
  return { candles: result, _fromCache: false };
}
async function fetchCandles(pair, tf, limit, env, assetType) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: "No API keys configured." };
  const symbol = pair.includes("/") ? pair : pair.slice(0, 3) + "/" + pair.slice(3);
  const interval = TIMEFRAME_MAP[tf] || tf;
  const startIdx = await getNextRotationIndex(env, apiKeys.length);
  const maxAttempts = apiKeys.length;
  let lastError = "Unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyIdx = (startIdx + attempt) % apiKeys.length;
    const apiKey = apiKeys[keyIdx];
    try {
      const u = new URL("/time_series", CONFIG.API_BASE_URL);
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("interval", interval);
      u.searchParams.set("outputsize", String(limit));
      u.searchParams.set("apikey", apiKey);
      u.searchParams.set("format", "JSON");
      u.searchParams.set("timezone", "UTC");
      await incrementQuota(env);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      let res;
      try {
        res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: "application/json" } });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        console.warn("fetchCandles non-ok pair=" + pair + " tf=" + tf + " keyIdx=" + keyIdx + " attempt=" + attempt + " status=" + res.status + " body=" + bodyText.slice(0, 200));
        if (res.status === 429) {
          lastError = "TwelveData rate limited (key#" + keyIdx + ")";
          continue;
        }
        lastError = "HTTP " + res.status + " (key#" + keyIdx + ")";
        continue;
      }
      const data = await res.json();
      if (data.status === "error") {
        console.warn("fetchCandles td-error pair=" + pair + " tf=" + tf + " keyIdx=" + keyIdx + " code=" + data.code + " msg=" + String(data.message || "").slice(0, 200));
        lastError = (data.message || "API error") + " (key#" + keyIdx + ")";
        continue;
      }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
        console.warn("fetchCandles empty pair=" + pair + " tf=" + tf + " keyIdx=" + keyIdx);
        lastError = "No data (key#" + keyIdx + ")";
        continue;
      }
      const candles = data.values.map((c) => ({
        datetime: c.datetime,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: assetType === ASSET_TYPE.CRYPTO ? parseFloat(c.volume || 0) : 0
      })).reverse();
      const valid = candles.every((c) => isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
      if (!valid) {
        lastError = "Invalid data (key#" + keyIdx + ")";
        continue;
      }
      return candles;
    } catch (e) {
      console.warn("fetchCandles exception pair=" + pair + " tf=" + tf + " keyIdx=" + keyIdx + " attempt=" + attempt + " msg=" + e.message);
      lastError = (e.name === "AbortError" ? "Timeout" : e.message) + " (key#" + keyIdx + ")";
      continue;
    }
  }
  return { error: "All " + maxAttempts + " attempts failed (startIdx=" + startIdx + "): " + lastError };
}

// src/indicators/math.js
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
function calculateRSI(data, period = 14) {
  if (!data || data.length < period + 1) return new Array(data ? data.length : 0).fill(null);
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
  const ml = e12.map((v, i) => v === null || e26[i] === null ? null : v - e26[i]);
  const vals = [];
  const idxs = [];
  ml.forEach((v, i) => {
    if (v !== null) {
      vals.push(v);
      idxs.push(i);
    }
  });
  const se = calculateEMA(vals, 9);
  const sl = new Array(ml.length).fill(null);
  idxs.forEach((idx, j) => {
    sl[idx] = se[j];
  });
  const hist = ml.map((v, i) => v === null || sl[i] === null ? null : v - sl[i]);
  return { macdLine: ml, signalLine: sl, histogram: hist };
}
function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return new Array(candles ? candles.length : 0).fill(null);
  const tr = [null];
  for (let i = 1; i < candles.length; i++) {
    const { high: h, low: l } = candles[i];
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
function calculateBollingerBands(data, period = 20, mult = 2) {
  if (!data || data.length === 0) return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
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
    bw[i] = sma > 0 ? (u[i] - l[i]) / sma * 100 : 0;
    const rng = u[i] - l[i];
    pb[i] = rng > 0 ? (data[i] - l[i]) / rng : 0.5;
  }
  return { upper: u, middle: m, lower: l, bandwidth: bw, percentB: pb };
}
function calculateStochastic(candles, kP = 14, sK = 3, sD = 3) {
  if (!candles || candles.length < kP) return { k: new Array(candles ? candles.length : 0).fill(null), d: [] };
  const rawK = new Array(kP - 1).fill(null);
  for (let i = kP - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    rawK.push(rng > 0 ? (candles[i].close - lo) / rng * 100 : 50);
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
    if (smoothedK[i] !== null) k[validIdxK[i]] = smoothedK[i];
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
    if (smoothedD[i] !== null) d[validIdxD[i]] = smoothedD[i];
  }
  return { k, d };
}
function calculateADX(candles, period = 14) {
  const n = candles ? candles.length : 0;
  const empty = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n < period * 2 + 1) return empty;
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
    for (let i = p + 1; i < arr.length; i++) r[i] = r[i - 1] - r[i - 1] / p + arr[i];
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
      plusDI[i] = sPDM[i] / sTR[i] * 100;
      minusDI[i] = sMDM[i] / sTR[i] * 100;
      const ds = plusDI[i] + minusDI[i];
      dx[i] = ds > 0 ? Math.abs(plusDI[i] - minusDI[i]) / ds * 100 : 0;
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
      if (dx[i] !== null && adx[i - 1] !== null) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx, plusDI, minusDI };
}
function calculateWilliamsR(candles, period = 14) {
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    r.push(rng > 0 ? (hi - candles[i].close) / rng * -100 : -50);
  }
  return r;
}
function calculateCCI(candles, period = 20) {
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
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
function calculateMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const mf = candles.map((c, i) => tp[i] * c.volume);
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
  if (!candles || candles.length < 2) return { pivot: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
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
    s3: sl - 2 * (sh - p)
  };
}
function calculateCamarillaPivots(candles) {
  if (!candles || candles.length < 2) return null;
  const lb = Math.min(20, candles.length - 1);
  const sc = candles.slice(-lb - 1, -1);
  let sh = -Infinity;
  let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i].high > sh) sh = sc[i].high;
    if (sc[i].low < sl) sl = sc[i].low;
  }
  const rng = sh - sl;
  return {
    h4: scl + rng * 1.1 / 2,
    h3: scl + rng * 1.1 / 4,
    h2: scl + rng * 1.1 / 6,
    h1: scl + rng * 1.1 / 12,
    l1: scl - rng * 1.1 / 12,
    l2: scl - rng * 1.1 / 6,
    l3: scl - rng * 1.1 / 4,
    l4: scl - rng * 1.1 / 2,
    close: scl
  };
}
function scoreCamarillaLevels(camPivots, lastClose, atr) {
  if (!camPivots || !lastClose || !atr || atr <= 0) return { up: 0, down: 0, level: "NONE" };
  const thresh = atr * 0.4;
  let up = 0;
  let down = 0;
  let level = "NONE";
  if (Math.abs(lastClose - camPivots.l4) < thresh) {
    up += 1.8;
    level = "L4_SUPPORT";
  } else if (Math.abs(lastClose - camPivots.l3) < thresh) {
    up += 1.3;
    level = "L3_SUPPORT";
  } else if (Math.abs(lastClose - camPivots.l2) < thresh) {
    up += 0.7;
    level = "L2_SUPPORT";
  } else if (Math.abs(lastClose - camPivots.l1) < thresh) {
    up += 0.4;
    level = "L1_SUPPORT";
  }
  if (Math.abs(lastClose - camPivots.h4) < thresh) {
    down += 1.8;
    level = "H4_RESISTANCE";
  } else if (Math.abs(lastClose - camPivots.h3) < thresh) {
    down += 1.3;
    level = "H3_RESISTANCE";
  } else if (Math.abs(lastClose - camPivots.h2) < thresh) {
    down += 0.7;
    level = "H2_RESISTANCE";
  } else if (Math.abs(lastClose - camPivots.h1) < thresh) {
    down += 0.4;
    level = "H1_RESISTANCE";
  }
  return { up, down, level };
}

// src/indicators/patterns.js
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
  const r0 = c0.high - c0.low || 1e-5;
  const r1 = c1.high - c1.low || 1e-5;
  const bp0 = ab0 / r0;
  const bp1 = ab1 / r1;
  const uw0 = c0.high - Math.max(c0.open, c0.close);
  const lw0 = Math.min(c0.open, c0.close) - c0.low;
  if (b1 < 0 && b0 > 0 && c0.open <= c1.close && c0.close >= c1.open && ab0 > ab1)
    patterns.push({ name: "BULLISH_ENGULFING", direction: "BUY", strength: 2 });
  if (b1 > 0 && b0 < 0 && c0.open >= c1.close && c0.close <= c1.open && ab0 > ab1)
    patterns.push({ name: "BEARISH_ENGULFING", direction: "SELL", strength: 2 });
  if (bp0 < 0.35 && lw0 > ab0 * 2 && uw0 < ab0 * 0.5)
    patterns.push({ name: "HAMMER", direction: "BUY", strength: 1.5 });
  if (bp0 < 0.35 && uw0 > ab0 * 2 && lw0 < ab0 * 0.5)
    patterns.push({ name: "SHOOTING_STAR", direction: "SELL", strength: 1.5 });
  if (bp0 < 0.1)
    patterns.push({ name: "DOJI", direction: "NEUTRAL", strength: 0.5 });
  if (lw0 > r0 * 0.6 && uw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: "PIN_BAR_BULLISH", direction: "BUY", strength: 1.8 });
  if (uw0 > r0 * 0.6 && lw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: "PIN_BAR_BEARISH", direction: "SELL", strength: 1.8 });
  const r2v = c2.high - c2.low || 1e-5;
  if (b2 < 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 > 0 && bp0 > 0.5 && c0.close > (c2.open + c2.close) / 2)
    patterns.push({ name: "MORNING_STAR", direction: "BUY", strength: 2.5 });
  if (b2 > 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 < 0 && bp0 > 0.5 && c0.close < (c2.open + c2.close) / 2)
    patterns.push({ name: "EVENING_STAR", direction: "SELL", strength: 2.5 });
  if (b2 > 0 && b1 > 0 && b0 > 0 && c1.close > c2.close && c0.close > c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: "THREE_WHITE_SOLDIERS", direction: "BUY", strength: 2 });
  if (b2 < 0 && b1 < 0 && b0 < 0 && c1.close < c2.close && c0.close < c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: "THREE_BLACK_CROWS", direction: "SELL", strength: 2 });
  return patterns;
}

// src/indicators/sr.js
function detectSRLevels(candles, atr) {
  if (!candles || candles.length < 10) return { supports: [], resistances: [] };
  const n = candles.length;
  const lookback = 3;
  const clusterDist = atr !== null ? atr * 0.6 : candles[n - 1].close * 2e-3;
  const lastClose = candles[n - 1].close;
  const rawHighs = [];
  const rawLows = [];
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) rawHighs.push(candles[i].high);
    if (isLow) rawLows.push(candles[i].low);
  }
  function cluster(levels) {
    if (!levels.length) return [];
    levels.sort((a, b) => a - b);
    const groups = [[levels[0]]];
    for (let i = 1; i < levels.length; i++) {
      const last = groups[groups.length - 1];
      const avg = last.reduce((s, v) => s + v, 0) / last.length;
      if (Math.abs(levels[i] - avg) <= clusterDist) last.push(levels[i]);
      else groups.push([levels[i]]);
    }
    return groups.map((g) => ({ price: g.reduce((s, v) => s + v, 0) / g.length, strength: g.length })).sort((a, b) => b.strength - a.strength).slice(0, 5);
  }
  const resistances = cluster(rawHighs).filter((r) => r.price > lastClose);
  const supports = cluster(rawLows).filter((s) => s.price < lastClose);
  return { supports, resistances, clusterDist };
}
function detectFVG(candles) {
  if (!candles || candles.length < 3) return { bullish: [], bearish: [], active: null };
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  const scanBack = Math.min(30, n - 1);
  const bullishFVGs = [];
  const bearishFVGs = [];
  for (let i = n - 1; i >= 2 && i >= n - 1 - scanBack; i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    const age = n - 1 - i;
    if (c2.low > c0.high) {
      const top = c2.low;
      const bottom = c0.high;
      const midpoint = (top + bottom) / 2;
      if (!(lastClose < bottom)) bullishFVGs.push({ top, bottom, midpoint, age });
    }
    if (c2.high < c0.low) {
      const top = c0.low;
      const bottom = c2.high;
      const midpoint = (top + bottom) / 2;
      if (!(lastClose > top)) bearishFVGs.push({ top, bottom, midpoint, age });
    }
  }
  bullishFVGs.sort((a, b) => a.age - b.age);
  bearishFVGs.sort((a, b) => a.age - b.age);
  let active = null;
  for (const bf of bullishFVGs) {
    if (lastClose >= bf.bottom && lastClose <= bf.top) {
      active = { type: "BULLISH", fvg: bf };
      break;
    }
  }
  if (!active) {
    for (const sf of bearishFVGs) {
      if (lastClose >= sf.bottom && lastClose <= sf.top) {
        active = { type: "BEARISH", fvg: sf };
        break;
      }
    }
  }
  return {
    bullish: bullishFVGs,
    bearish: bearishFVGs,
    active,
    nearestBullish: bullishFVGs.length ? bullishFVGs[0] : null,
    nearestBearish: bearishFVGs.length ? bearishFVGs[0] : null
  };
}

// src/indicators/structure.js
function findSwingPoints(candles, lookback) {
  const swingHighs = [];
  const swingLows = [];
  const n = candles.length;
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: candles[i].high, time: candles[i].datetime });
    if (isLow) swingLows.push({ idx: i, price: candles[i].low, time: candles[i].datetime });
  }
  return {
    swingHighs: swingHighs.slice(-8),
    // শেষ ৮টা রাখো
    swingLows: swingLows.slice(-8)
  };
}
function determineStructureBias(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return "NEUTRAL";
  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);
  const higherHighs = recentHighs.length >= 2 && recentHighs[recentHighs.length - 1].price > recentHighs[recentHighs.length - 2].price;
  const higherLows = recentLows.length >= 2 && recentLows[recentLows.length - 1].price > recentLows[recentLows.length - 2].price;
  const lowerHighs = recentHighs.length >= 2 && recentHighs[recentHighs.length - 1].price < recentHighs[recentHighs.length - 2].price;
  const lowerLows = recentLows.length >= 2 && recentLows[recentLows.length - 1].price < recentLows[recentLows.length - 2].price;
  if (higherHighs && higherLows) return "BULLISH";
  if (lowerHighs && lowerLows) return "BEARISH";
  if (higherHighs && !higherLows) return "WEAK_BULLISH";
  if (lowerLows && !lowerHighs) return "WEAK_BEARISH";
  return "NEUTRAL";
}
function detectBOS(candles, swingHighs, swingLows, structureBias) {
  if (!candles || candles.length < 5) return null;
  if (swingHighs.length === 0 || swingLows.length === 0) return null;
  const lastClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const n = candles.length;
  const lastSH = swingHighs[swingHighs.length - 1];
  if (lastSH && n - 1 - lastSH.idx <= 15 && lastClose > lastSH.price && prevClose <= lastSH.price) {
    return {
      type: "BULLISH_BOS",
      direction: "BUY",
      level: lastSH.price,
      breakAmount: lastClose - lastSH.price,
      barsAgo: n - 1 - lastSH.idx,
      confirmed: true,
      // Close confirmation (not just wick)
      strength: lastClose - lastSH.price > 0 ? "CONFIRMED" : "WEAK"
    };
  }
  const lastSL = swingLows[swingLows.length - 1];
  if (lastSL && n - 1 - lastSL.idx <= 15 && lastClose < lastSL.price && prevClose >= lastSL.price) {
    return {
      type: "BEARISH_BOS",
      direction: "SELL",
      level: lastSL.price,
      breakAmount: lastSL.price - lastClose,
      barsAgo: n - 1 - lastSL.idx,
      confirmed: true,
      strength: "CONFIRMED"
    };
  }
  return null;
}
function detectCHoCH(candles, swingHighs, swingLows, structureBias) {
  if (!candles || candles.length < 10) return null;
  const lastClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const n = candles.length;
  if (structureBias === "BEARISH" || structureBias === "WEAK_BEARISH") {
    if (swingHighs.length >= 2) {
      const lastLH = swingHighs[swingHighs.length - 1];
      if (lastLH && n - 1 - lastLH.idx <= 20 && lastClose > lastLH.price && prevClose <= lastLH.price) {
        return {
          type: "BULLISH_CHOCH",
          direction: "BUY",
          level: lastLH.price,
          prevBias: structureBias,
          confirmed: true,
          // CHoCH is stronger than BOS — এটা reversal এর প্রথম confirmation
          strength: "REVERSAL",
          note: "Structure shifting BEARISH \u2192 BULLISH"
        };
      }
    }
  }
  if (structureBias === "BULLISH" || structureBias === "WEAK_BULLISH") {
    if (swingLows.length >= 2) {
      const lastHL = swingLows[swingLows.length - 1];
      if (lastHL && n - 1 - lastHL.idx <= 20 && lastClose < lastHL.price && prevClose >= lastHL.price) {
        return {
          type: "BEARISH_CHOCH",
          direction: "SELL",
          level: lastHL.price,
          prevBias: structureBias,
          confirmed: true,
          strength: "REVERSAL",
          note: "Structure shifting BULLISH \u2192 BEARISH"
        };
      }
    }
  }
  return null;
}
function detectLiquiditySweep(candles, swingHighs, swingLows, atr) {
  if (!candles || candles.length < 5 || !atr || atr <= 0) return null;
  const last = candles[candles.length - 1];
  const prev1 = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  const totalRange = last.high - last.low || 1e-5;
  const eqThreshold = atr * 0.3;
  const recentSH = swingHighs.slice(-6);
  for (let i = 0; i < recentSH.length - 1; i++) {
    for (let j = i + 1; j < recentSH.length; j++) {
      if (Math.abs(recentSH[i].price - recentSH[j].price) < eqThreshold) {
        const liquidityLevel = Math.max(recentSH[i].price, recentSH[j].price);
        if (last.high > liquidityLevel && last.close < liquidityLevel) {
          const wickAbove = last.high - Math.max(last.open, last.close);
          const wickRatio = wickAbove / totalRange;
          if (wickRatio >= 0.35) {
            return {
              type: "SELL_SWEEP",
              // Buy-side liquidity swept → SELL
              direction: "SELL",
              liquidityLevel,
              wickSize: wickAbove,
              wickRatio: Math.round(wickRatio * 100) / 100,
              confirmed: last.close < liquidityLevel,
              strength: wickRatio >= 0.55 ? "STRONG" : "MODERATE",
              equalHighCount: 2,
              note: "Stop hunt above equal highs \u2192 reversal SELL"
            };
          }
        }
      }
    }
  }
  const recentSL = swingLows.slice(-6);
  for (let i = 0; i < recentSL.length - 1; i++) {
    for (let j = i + 1; j < recentSL.length; j++) {
      if (Math.abs(recentSL[i].price - recentSL[j].price) < eqThreshold) {
        const liquidityLevel = Math.min(recentSL[i].price, recentSL[j].price);
        if (last.low < liquidityLevel && last.close > liquidityLevel) {
          const wickBelow = Math.min(last.open, last.close) - last.low;
          const wickRatio = wickBelow / totalRange;
          if (wickRatio >= 0.35) {
            return {
              type: "BUY_SWEEP",
              // Sell-side liquidity swept → BUY
              direction: "BUY",
              liquidityLevel,
              wickSize: wickBelow,
              wickRatio: Math.round(wickRatio * 100) / 100,
              confirmed: last.close > liquidityLevel,
              strength: wickRatio >= 0.55 ? "STRONG" : "MODERATE",
              equalLowCount: 2,
              note: "Stop hunt below equal lows \u2192 reversal BUY"
            };
          }
        }
      }
    }
  }
  return null;
}
function checkRecentStructureEvent(candles, swingHighs, swingLows, structureBias, barsAgoMax) {
  const n = candles.length;
  const events = [];
  for (const sh of swingHighs.slice(-3)) {
    if (n - 1 - sh.idx <= barsAgoMax) {
      for (let i = sh.idx + 1; i < n; i++) {
        if (candles[i].close > sh.price) {
          events.push({ type: "RECENT_BULLISH_BOS", barsAgo: n - 1 - i, level: sh.price });
          break;
        }
      }
    }
  }
  for (const sl of swingLows.slice(-3)) {
    if (n - 1 - sl.idx <= barsAgoMax) {
      for (let i = sl.idx + 1; i < n; i++) {
        if (candles[i].close < sl.price) {
          events.push({ type: "RECENT_BEARISH_BOS", barsAgo: n - 1 - i, level: sl.price });
          break;
        }
      }
    }
  }
  return events;
}
function analyzeStructure(candles, atr, timeframe) {
  if (!candles || candles.length < 20) {
    return {
      bias: "NEUTRAL",
      bos: null,
      choch: null,
      sweep: null,
      swingHighs: [],
      swingLows: [],
      recentEvents: [],
      structureScore: { up: 0, down: 0 },
      multiplier: { direction: null, value: 1 },
      summary: "INSUFFICIENT_DATA"
    };
  }
  const lookback = timeframe === "15min" ? 4 : timeframe === "5min" ? 3 : 2;
  const barsAgoMax = timeframe === "15min" ? 10 : timeframe === "5min" ? 8 : 5;
  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);
  const structureBias = determineStructureBias(swingHighs, swingLows);
  const bos = detectBOS(candles, swingHighs, swingLows, structureBias);
  const choch = detectCHoCH(candles, swingHighs, swingLows, structureBias);
  const sweep = detectLiquiditySweep(candles, swingHighs, swingLows, atr);
  const recentEvents = checkRecentStructureEvent(candles, swingHighs, swingLows, structureBias, barsAgoMax);
  let sUp = 0;
  let sDown = 0;
  if (structureBias === "BULLISH") {
    sUp += 1.5;
  } else if (structureBias === "BEARISH") {
    sDown += 1.5;
  } else if (structureBias === "WEAK_BULLISH") {
    sUp += 0.8;
  } else if (structureBias === "WEAK_BEARISH") {
    sDown += 0.8;
  }
  if (bos) {
    if (bos.direction === "BUY") sUp += 2;
    else sDown += 2;
  }
  if (choch) {
    if (choch.direction === "BUY") sUp += 2.5;
    else sDown += 2.5;
  }
  if (sweep) {
    const sweepBonus = sweep.strength === "STRONG" ? 1.8 : 1.2;
    if (sweep.direction === "BUY") sUp += sweepBonus;
    else sDown += sweepBonus;
  }
  if (!bos) {
    for (const ev of recentEvents) {
      if (ev.type === "RECENT_BULLISH_BOS") sUp += 0.5;
      if (ev.type === "RECENT_BEARISH_BOS") sDown += 0.5;
    }
  }
  let multiplierDir = null;
  let multiplierValue = 1;
  let summary = "NEUTRAL";
  if (choch) {
    multiplierDir = choch.direction;
    multiplierValue = 1.4;
    summary = "CHOCH_" + (choch.direction === "BUY" ? "BULLISH" : "BEARISH");
  } else if (bos) {
    multiplierDir = bos.direction;
    multiplierValue = 1.25;
    summary = "BOS_" + (bos.direction === "BUY" ? "BULLISH" : "BEARISH");
  } else if (structureBias === "BULLISH") {
    multiplierDir = "BUY";
    multiplierValue = 1.12;
    summary = "BIAS_BULLISH";
  } else if (structureBias === "BEARISH") {
    multiplierDir = "SELL";
    multiplierValue = 1.12;
    summary = "BIAS_BEARISH";
  } else if (structureBias === "WEAK_BULLISH") {
    multiplierDir = "BUY";
    multiplierValue = 1.06;
    summary = "WEAK_BULLISH";
  } else if (structureBias === "WEAK_BEARISH") {
    multiplierDir = "SELL";
    multiplierValue = 1.06;
    summary = "WEAK_BEARISH";
  }
  if (sweep && multiplierDir === sweep.direction) {
    multiplierValue += sweep.strength === "STRONG" ? 0.15 : 0.08;
    summary += "+SWEEP";
  } else if (sweep && multiplierDir !== sweep.direction && multiplierDir !== null) {
    multiplierValue -= 0.05;
  }
  if (multiplierDir && !bos) {
    const alignedRecentBOS = recentEvents.some(
      (ev) => ev.type === "RECENT_BULLISH_BOS" && multiplierDir === "BUY" || ev.type === "RECENT_BEARISH_BOS" && multiplierDir === "SELL"
    );
    if (alignedRecentBOS) {
      multiplierValue += 0.06;
      summary += "+RECENT_BOS";
    }
  }
  multiplierValue = Math.min(multiplierValue, 1.65);
  return {
    bias: structureBias,
    bos,
    choch,
    sweep,
    swingHighs: swingHighs.slice(-5),
    swingLows: swingLows.slice(-5),
    recentEvents,
    structureScore: { up: Math.round(sUp * 100) / 100, down: Math.round(sDown * 100) / 100 },
    multiplier: { direction: multiplierDir, value: Math.round(multiplierValue * 1e3) / 1e3 },
    summary
  };
}

// src/indicators/index.js
function calculateAllIndicators(candles, timeframe) {
  const closes = candles.map((c) => c.close);
  const atrArr = calculateATR(candles, CONFIG.ATR_PERIOD);
  const atrLast = atrArr[atrArr.length - 1] || null;
  const tf = timeframe || "5min";
  return {
    // EMA 5/13/55 — Fibonacci set
    ema5: calculateEMA(closes, 5),
    ema13: calculateEMA(closes, 13),
    ema55: calculateEMA(closes, 55),
    rsi: calculateRSI(closes, CONFIG.RSI_PERIOD),
    macd: calculateMACD(closes),
    atr: atrArr,
    bollinger: calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV),
    stochastic: calculateStochastic(candles, CONFIG.STOCH_PERIOD, CONFIG.STOCH_SMOOTH_K, CONFIG.STOCH_SMOOTH_D),
    adx: calculateADX(candles, CONFIG.ADX_PERIOD),
    williamsR: calculateWilliamsR(candles, CONFIG.WILLIAMS_PERIOD),
    cci: calculateCCI(candles, CONFIG.CCI_PERIOD),
    mfi: calculateMFI(candles, CONFIG.MFI_PERIOD),
    pivots: calculatePivotPoints(candles),
    camarilla: calculateCamarillaPivots(candles),
    patterns: detectCandlestickPatterns(candles),
    sr: detectSRLevels(candles, atrLast),
    fvg: detectFVG(candles),
    // NEW: Market Structure (BOS/CHoCH + Liquidity Sweeps)
    structure: analyzeStructure(candles, atrLast, tf)
  };
}

// src/indicators/divergence.js
function detectRSIDivergence(candles, rsiVals, lookback = 30) {
  if (!candles || !rsiVals || candles.length < lookback) return null;
  const n = candles.length;
  const st = n - lookback;
  const pL = [];
  const pH = [];
  for (let i = st + 2; i < n - 2; i++) {
    if (rsiVals[i] === null) continue;
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i - 2].low && candles[i].low <= candles[i + 1].low && candles[i].low <= candles[i + 2].low)
      pL.push({ idx: i, price: candles[i].low, rsi: rsiVals[i] });
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i - 2].high && candles[i].high >= candles[i + 1].high && candles[i].high >= candles[i + 2].high)
      pH.push({ idx: i, price: candles[i].high, rsi: rsiVals[i] });
  }
  if (pL.length >= 2) {
    const r = pL[pL.length - 1];
    const p = pL[pL.length - 2];
    if (r.price < p.price && r.rsi > p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close > lc.open;
      return { type: "BULLISH_RSI_DIVERGENCE", direction: "BUY", strength: confirmed ? 2 : 1, confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1];
    const p = pH[pH.length - 2];
    if (r.price > p.price && r.rsi < p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close < lc.open;
      return { type: "BEARISH_RSI_DIVERGENCE", direction: "SELL", strength: confirmed ? 2 : 1, confirmed };
    }
  }
  return null;
}
function detectMACDDivergence(candles, hist, lookback = 30) {
  if (!candles || !hist || candles.length < lookback) return null;
  const n = candles.length;
  const st = n - lookback;
  const pL = [];
  const pH = [];
  for (let i = st + 2; i < n - 2; i++) {
    if (hist[i] === null) continue;
    if (candles[i].low <= candles[i - 1].low && candles[i].low <= candles[i + 1].low)
      pL.push({ idx: i, price: candles[i].low, macd: hist[i] });
    if (candles[i].high >= candles[i - 1].high && candles[i].high >= candles[i + 1].high)
      pH.push({ idx: i, price: candles[i].high, macd: hist[i] });
  }
  if (pL.length >= 2) {
    const r = pL[pL.length - 1];
    const p = pL[pL.length - 2];
    if (r.price < p.price && r.macd > p.macd) {
      const confirmed = candles[n - 1].close > candles[n - 1].open;
      return { type: "BULLISH_MACD_DIV", direction: "BUY", strength: confirmed ? 1.5 : 0.75, confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1];
    const p = pH[pH.length - 2];
    if (r.price > p.price && r.macd < p.macd) {
      const confirmed = candles[n - 1].close < candles[n - 1].open;
      return { type: "BEARISH_MACD_DIV", direction: "SELL", strength: confirmed ? 1.5 : 0.75, confirmed };
    }
  }
  return null;
}

// src/signal/timeframe.js
function analyzeTimeframe(indicators, candles, timeframe, assetType, higherTFTrend, marketRegime) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const minScoreThreshold = SCORE_THRESHOLDS[assetType] || 3;
  const weights = getRegimeWeights(marketRegime || "RANGING");
  const ema5 = safeLastValue(indicators.ema5);
  const ema13 = safeLastValue(indicators.ema13);
  const ema55 = safeLastValue(indicators.ema55);
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
  const prevStochK = safeLastTwo(indicators.stochastic.k).prev;
  const adxVal = safeLastValue(indicators.adx.adx);
  const plusDI = safeLastValue(indicators.adx.plusDI);
  const minusDI = safeLastValue(indicators.adx.minusDI);
  const williamsR = safeLastValue(indicators.williamsR);
  const cci = safeLastValue(indicators.cci);
  const mfi = safeLastValue(indicators.mfi);
  const pivots = indicators.pivots;
  const patterns = indicators.patterns;
  const sr = indicators.sr || { supports: [], resistances: [] };
  const fvg = indicators.fvg || { active: null };
  if (ema5 === null || ema55 === null) {
    return {
      direction: "NO_TRADE",
      score: { up: 0, down: 0, diff: 0 },
      confluence: 0,
      reason: "Insufficient data",
      timeframe,
      assetType,
      categoryScores: {},
      confluenceDetail: { bullish: 0, bearish: 0, total: 12 },
      volatilityMultiplier: 0
    };
  }
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle.close;
  const trending = isTrendingMarket(adxVal);
  if (atr !== null && lastClose > 0) {
    const atrPct = atr / lastClose * 100;
    if (atrPct < vt.minTradableATR) {
      return {
        direction: "NO_TRADE",
        score: { up: 0, down: 0, diff: 0 },
        confluence: 0,
        reason: "Dead market \u2014 ATR too low",
        timeframe,
        assetType,
        deadMarket: true,
        categoryScores: {},
        confluenceDetail: { bullish: 0, bearish: 0, total: 12 },
        volatilityMultiplier: 0
      };
    }
  }
  let upScore = 0;
  let downScore = 0;
  let upCat = 0;
  let downCat = 0;
  const catScores = {};
  let tU = 0;
  let tD = 0;
  if (ema13 !== null && ema55 !== null) {
    if (ema5 > ema13 && ema13 > ema55) tU += 2;
    else if (ema5 < ema13 && ema13 < ema55) tD += 2;
    else if (ema5 > ema13) tU += 0.8;
    else if (ema5 < ema13) tD += 0.8;
    if (lastClose > ema55) tU += 0.75;
    else if (lastClose < ema55) tD += 0.75;
  } else {
    if (ema5 > ema55) tU += 1;
    else if (ema5 < ema55) tD += 1;
  }
  const ema5Prev = safeLastN(indicators.ema5, 3);
  const ema13Prev = safeLastN(indicators.ema13, 3);
  if (ema5Prev.length >= 3 && ema13Prev.length >= 3) {
    const wasBelowMid = ema5Prev[0] < ema13Prev[0];
    const nowAboveMid = ema5Prev[2] > ema13Prev[2];
    if (wasBelowMid && nowAboveMid) tU += 1.2;
    const wasAboveMid = ema5Prev[0] > ema13Prev[0];
    const nowBelowMid = ema5Prev[2] < ema13Prev[2];
    if (wasAboveMid && nowBelowMid) tD += 1.2;
  }
  if (ema5Prev.length >= 3) {
    const slope = ema5Prev[2] - ema5Prev[0];
    if (slope > 0) tU += 0.25;
    else if (slope < 0) tD += 0.25;
  }
  if (ema13 !== null && atr !== null && atr > 0) {
    const dist13 = Math.abs(lastClose - ema13);
    if (dist13 < atr * 0.5) {
      if (lastClose > ema55 && ema5 > ema13) tU += 0.6;
      if (lastClose < ema55 && ema5 < ema13) tD += 0.6;
    }
  }
  tU *= weights.trend;
  tD *= weights.trend;
  upScore += tU;
  downScore += tD;
  if (tU > tD && Math.abs(tU - tD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (tD > tU && Math.abs(tD - tU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  let emaAlignment = "MIXED";
  if (ema13 !== null && ema55 !== null) {
    if (ema5 > ema13 && ema13 > ema55) emaAlignment = "FULL_BULL_STACK";
    else if (ema5 < ema13 && ema13 < ema55) emaAlignment = "FULL_BEAR_STACK";
    else if (ema5 > ema13 && lastClose > ema55) emaAlignment = "BULLISH";
    else if (ema5 < ema13 && lastClose < ema55) emaAlignment = "BEARISH";
  }
  catScores.trend = { up: r2(tU), down: r2(tD), emaAlignment };
  let mU = 0;
  let mD = 0;
  if (rsi !== null) {
    if (trending === true) {
      if (rsi >= 60 && rsi < 80) mU += 1;
      else if (rsi >= 50 && rsi < 60) mU += 0.5;
      else if (rsi > 40 && rsi < 50) mD += 0.5;
      else if (rsi > 20 && rsi <= 40) mD += 1;
      else if (rsi >= 80) mU += 0.3;
      else if (rsi <= 20) mD += 0.3;
    } else if (trending === false) {
      if (rsi >= 75) mD += 1.5;
      else if (rsi >= 65) mD += 0.75;
      else if (rsi <= 25) mU += 1.5;
      else if (rsi <= 35) mU += 0.75;
    } else {
      if (rsi >= 75) mD += 1;
      else if (rsi >= 60) mU += 0.5;
      else if (rsi <= 25) mU += 1;
      else if (rsi <= 40) mD += 0.5;
    }
  }
  if (williamsR !== null) {
    if (trending === true) {
      if (williamsR > -30) mU += 0.3;
      else if (williamsR < -70) mD += 0.3;
    } else {
      if (williamsR > -20) mD += 0.5;
      else if (williamsR < -80) mU += 0.5;
      else if (williamsR > -50) mU += 0.25;
      else mD += 0.25;
    }
  }
  if (mfi !== null) {
    const hasVolume = assetType === ASSET_TYPE.CRYPTO || lastCandle.volume > 0;
    if (hasVolume) {
      if (mfi >= 80) mD += 0.5;
      else if (mfi <= 20) mU += 0.5;
      else if (mfi >= 55) mU += 0.25;
      else if (mfi <= 45) mD += 0.25;
    }
  }
  mU *= weights.momentum;
  mD *= weights.momentum;
  upScore += mU;
  downScore += mD;
  if (mU > mD && Math.abs(mU - mD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mD > mU && Math.abs(mD - mU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.momentum = { up: r2(mU), down: r2(mD), context: trending === true ? "TRENDING" : trending === false ? "RANGING" : "UNKNOWN" };
  let mcU = 0;
  let mcD = 0;
  if (macdHist !== null) {
    if (macdHist > 0) mcU += 0.75;
    else if (macdHist < 0) mcD += 0.75;
    if (prevMacdHist !== null) {
      if (macdHist > 0 && macdHist > prevMacdHist) mcU += 0.4;
      else if (macdHist < 0 && macdHist < prevMacdHist) mcD += 0.4;
      else if (macdHist > 0 && macdHist < prevMacdHist) mcU += 0.1;
      else if (macdHist < 0 && macdHist > prevMacdHist) mcD += 0.1;
    }
  }
  if (macdLine !== null && macdSignal !== null) {
    if (macdLine > macdSignal) mcU += 0.5;
    else if (macdLine < macdSignal) mcD += 0.5;
    const prevMacdLine = macdLineData.prev;
    if (prevMacdLine !== null) {
      if (prevMacdLine <= 0 && macdLine > 0) mcU += 0.5;
      else if (prevMacdLine >= 0 && macdLine < 0) mcD += 0.5;
    }
  }
  mcU *= weights.macd;
  mcD *= weights.macd;
  upScore += mcU;
  downScore += mcD;
  if (mcU > mcD && Math.abs(mcU - mcD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mcD > mcU && Math.abs(mcD - mcU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.macd = { up: r2(mcU), down: r2(mcD) };
  let sU = 0;
  let sD = 0;
  if (stochK !== null && stochD !== null) {
    if (trending === true) {
      if (stochK > stochD && stochK > 40 && stochK < 70) sU += 0.75;
      else if (stochK < stochD && stochK > 30 && stochK < 60) sD += 0.75;
      if (prevStochK !== null && prevStochK < 30 && stochK > 30 && stochK > stochD) sU += 0.75;
      if (prevStochK !== null && prevStochK > 70 && stochK < 70 && stochK < stochD) sD += 0.75;
    } else {
      if (stochK > 80 && stochD > 80) sD += 0.75;
      else if (stochK < 20 && stochD < 20) sU += 0.75;
      if (stochK > stochD) sU += 0.5;
      else if (stochK < stochD) sD += 0.5;
      if (prevStochK !== null) {
        if (stochK > prevStochK) sU += 0.25;
        else if (stochK < prevStochK) sD += 0.25;
      }
      if (stochK < 20 && stochK > stochD) sU += 0.5;
      if (stochK > 80 && stochK < stochD) sD += 0.5;
    }
  }
  sU *= weights.stochastic;
  sD *= weights.stochastic;
  upScore += sU;
  downScore += sD;
  if (sU > sD && Math.abs(sU - sD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (sD > sU && Math.abs(sD - sU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.stochastic = { up: r2(sU), down: r2(sD), context: trending === true ? "TRENDING" : "RANGING" };
  let bU = 0;
  let bD = 0;
  if (bbUpper !== null && bbLower !== null && bbMiddle !== null) {
    if (trending === true) {
      if (lastClose >= bbUpper) {
        if (ema5 > ema55) bU += 0.75;
        else bD += 0.5;
      } else if (lastClose <= bbLower) {
        if (ema5 < ema55) bD += 0.75;
        else bU += 0.5;
      } else if (lastClose > bbMiddle) bU += 0.25;
      else if (lastClose < bbMiddle) bD += 0.25;
    } else {
      if (lastClose >= bbUpper) bD += 1;
      else if (lastClose <= bbLower) bU += 1;
      else if (lastClose > bbMiddle) bU += 0.25;
      else if (lastClose < bbMiddle) bD += 0.25;
    }
    if (bbPercentB !== null) {
      if (trending !== true) {
        if (bbPercentB > 1) bD += 0.5;
        else if (bbPercentB < 0) bU += 0.5;
      } else {
        if (bbPercentB > 1 && ema5 > ema55) bU += 0.25;
        else if (bbPercentB < 0 && ema5 < ema55) bD += 0.25;
      }
    }
  }
  if (cci !== null) {
    if (trending === true) {
      if (cci > 150) bU += 0.5;
      else if (cci > 100) bU += 0.35;
      else if (cci < -150) bD += 0.5;
      else if (cci < -100) bD += 0.35;
    } else {
      if (cci > 150) bD += 0.5;
      else if (cci > 100) bD += 0.35;
      else if (cci < -150) bU += 0.5;
      else if (cci < -100) bU += 0.35;
      else if (cci > 50) bU += 0.15;
      else if (cci < -50) bD += 0.15;
    }
  }
  bU *= weights.bands;
  bD *= weights.bands;
  upScore += bU;
  downScore += bD;
  if (bU > bD && Math.abs(bU - bD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (bD > bU && Math.abs(bD - bU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.bands = { up: r2(bU), down: r2(bD), context: trending === true ? "TRENDING" : "RANGING" };
  let aU = 0;
  let aD = 0;
  let diCross = null;
  if (adxVal !== null && plusDI !== null && minusDI !== null) {
    if (plusDI > minusDI) aU += 0.75;
    else if (minusDI > plusDI) aD += 0.75;
    if (adxVal >= 25) {
      if (plusDI > minusDI) aU += 0.75;
      else aD += 0.75;
    }
    const adxLT = safeLastTwo(indicators.adx.adx);
    if (adxLT.last !== null && adxLT.prev !== null) {
      if (adxLT.last > adxLT.prev && adxLT.last >= 20) {
        if (plusDI > minusDI) aU += 0.5;
        else aD += 0.5;
      } else if (adxLT.last < adxLT.prev && adxLT.last < 25) {
        aU *= 0.7;
        aD *= 0.7;
      }
    }
    diCross = detectDICrossover(indicators.adx);
    if (diCross) {
      if (diCross.direction === "BUY") aU += diCross.strength;
      else aD += diCross.strength;
    }
  }
  aU *= weights.adx;
  aD *= weights.adx;
  upScore += aU;
  downScore += aD;
  if (aU > aD && Math.abs(aU - aD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (aD > aU && Math.abs(aD - aU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.adx = { up: r2(aU), down: r2(aD), diCross: diCross ? diCross.type : "NONE" };
  let pU = 0;
  let pD = 0;
  if (patterns && patterns.length > 0) {
    for (const pat of patterns) {
      let adj = pat.strength;
      if (trending === true) {
        const isCont = pat.direction === "BUY" && ema5 > ema55 || pat.direction === "SELL" && ema5 < ema55;
        adj *= isCont ? 1.3 : 0.6;
      }
      if (pat.direction === "BUY") pU += adj;
      else if (pat.direction === "SELL") pD += adj;
    }
  }
  const bodySize = Math.abs(lastCandle.close - lastCandle.open);
  const totalRange = lastCandle.high - lastCandle.low || 1e-5;
  if (bodySize / totalRange > 0.6) {
    if (lastCandle.close > lastCandle.open) pU += 0.5;
    else pD += 0.5;
  }
  pU = Math.min(pU, 3);
  pD = Math.min(pD, 3);
  pU *= weights.patterns;
  pD *= weights.patterns;
  upScore += pU;
  downScore += pD;
  if (pU > pD && Math.abs(pU - pD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pD > pU && Math.abs(pD - pU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.patterns = { up: r2(pU), down: r2(pD), detected: patterns ? patterns.map((p) => p.name) : [] };
  let dvU = 0;
  let dvD = 0;
  const rDiv = detectRSIDivergence(candles, indicators.rsi);
  const mDiv = detectMACDDivergence(candles, indicators.macd.histogram);
  if (rDiv) {
    const rs = rDiv.confirmed ? rDiv.strength : rDiv.strength * 0.5;
    if (rDiv.direction === "BUY") dvU += rs;
    else dvD += rs;
  }
  if (mDiv) {
    const ms = mDiv.confirmed ? mDiv.strength : mDiv.strength * 0.5;
    if (mDiv.direction === "BUY") dvU += ms;
    else dvD += ms;
  }
  dvU = Math.min(dvU, 2.5);
  dvD = Math.min(dvD, 2.5);
  dvU *= weights.divergence;
  dvD *= weights.divergence;
  upScore += dvU;
  downScore += dvD;
  if (dvU > dvD && Math.abs(dvU - dvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (dvD > dvU && Math.abs(dvD - dvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.divergence = {
    up: r2(dvU),
    down: r2(dvD),
    rsi: rDiv ? rDiv.type : "NONE",
    rsiConfirmed: rDiv ? rDiv.confirmed : false,
    macd: mDiv ? mDiv.type : "NONE",
    macdConfirmed: mDiv ? mDiv.confirmed : false
  };
  let pvU = 0;
  let pvD = 0;
  if (pivots && pivots.pivot !== null) {
    if (lastClose > pivots.pivot) pvU += 0.5;
    else if (lastClose < pivots.pivot) pvD += 0.5;
    const proxThr = atr !== null ? atr * 0.5 : lastClose * 2e-3;
    if (pivots.s1 && Math.abs(lastClose - pivots.s1) < proxThr) pvU += 0.75;
    if (pivots.s2 && Math.abs(lastClose - pivots.s2) < proxThr) pvU += 1;
    if (pivots.r1 && Math.abs(lastClose - pivots.r1) < proxThr) pvD += 0.75;
    if (pivots.r2 && Math.abs(lastClose - pivots.r2) < proxThr) pvD += 1;
    if (pivots.r1 && lastClose > pivots.pivot && lastClose < pivots.r1) pvU += 0.25;
    if (pivots.s1 && lastClose < pivots.pivot && lastClose > pivots.s1) pvD += 0.25;
  }
  pvU = Math.min(pvU, 2);
  pvD = Math.min(pvD, 2);
  pvU *= weights.pivots;
  pvD *= weights.pivots;
  upScore += pvU;
  downScore += pvD;
  if (pvU > pvD && Math.abs(pvU - pvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pvD > pvU && Math.abs(pvD - pvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.pivots = { up: r2(pvU), down: r2(pvD) };
  let vU = 0;
  let vD = 0;
  const hasReliableVolume = assetType === ASSET_TYPE.CRYPTO || candles.length >= 20 && candles.slice(-20).some((c) => c.volume > 0);
  if (hasReliableVolume && candles.length >= 20) {
    const rv = candles.slice(-20).map((c) => c.volume);
    const av = rv.reduce((a, b) => a + b, 0) / rv.length;
    if (av > 0 && lastCandle.volume > av * 1.5) {
      if (lastCandle.close > lastCandle.open) vU += 0.75;
      else if (lastCandle.close < lastCandle.open) vD += 0.75;
    }
    if (candles.length >= 5) {
      const lv5 = candles.slice(-5).map((c) => c.volume);
      const avgRecent = (lv5[3] + lv5[4]) / 2;
      const avgOlder = (lv5[0] + lv5[1]) / 2;
      if (avgOlder > 0 && avgRecent > avgOlder * 1.2) {
        if (lastCandle.close > candles[candles.length - 5].close) vU += 0.25;
        else vD += 0.25;
      }
    }
  }
  vU *= weights.volume;
  vD *= weights.volume;
  upScore += vU;
  downScore += vD;
  if (vU > vD && Math.abs(vU - vD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (vD > vU && Math.abs(vD - vU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.volume = { up: r2(vU), down: r2(vD), reliable: hasReliableVolume, skipped: !hasReliableVolume ? "No reliable volume (forex)" : null };
  let srU = 0;
  let srD = 0;
  let srContext = "NO_LEVEL";
  if (atr !== null && atr > 0) {
    const nearThresh = atr * 0.5;
    let nearSupport = null;
    let nearResistance = null;
    for (const sup of sr.supports) {
      if (lastClose > sup.price && Math.abs(lastClose - sup.price) <= nearThresh) {
        nearSupport = sup;
        break;
      }
    }
    for (const res of sr.resistances) {
      if (lastClose < res.price && Math.abs(lastClose - res.price) <= nearThresh) {
        nearResistance = res;
        break;
      }
    }
    if (nearSupport && !nearResistance) {
      const prox = 1 - Math.abs(lastClose - nearSupport.price) / nearThresh;
      srU += 2 * prox * Math.min(nearSupport.strength / 3, 1);
      srContext = "NEAR_SUPPORT";
    } else if (nearResistance && !nearSupport) {
      const prox = 1 - Math.abs(lastClose - nearResistance.price) / nearThresh;
      srD += 2 * prox * Math.min(nearResistance.strength / 3, 1);
      srContext = "NEAR_RESISTANCE";
    } else if (nearSupport && nearResistance) {
      srContext = "BETWEEN";
    }
  }
  srU = Math.min(srU, 2);
  srD = Math.min(srD, 2);
  const srW = weights.sr || 1.4;
  srU *= srW;
  srD *= srW;
  upScore += srU;
  downScore += srD;
  if (srU > srD && Math.abs(srU - srD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (srD > srU && Math.abs(srD - srU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.sr = { up: r2(srU), down: r2(srD), context: srContext };
  catScores.fvg = { active: fvg.active ? fvg.active.type : "NONE", bullishCount: fvg.bullish ? fvg.bullish.length : 0, bearishCount: fvg.bearish ? fvg.bearish.length : 0 };
  const srPenalty = srContext === "BETWEEN" ? 0.85 : srContext === "NO_LEVEL" ? 0.9 : 1;
  let volMult = 1;
  if (bbBandwidth !== null) {
    if (bbBandwidth < vt.bbFilterDead) volMult = 0.4;
    else if (bbBandwidth < vt.bbFilterLow) volMult = 0.6;
    else if (bbBandwidth < vt.bbFilterMed) volMult = 0.8;
  }
  upScore *= volMult * srPenalty;
  downScore *= volMult * srPenalty;
  let camScore = { up: 0, down: 0, level: "NONE" };
  if (indicators.camarilla && atr !== null) {
    camScore = scoreCamarillaLevels(indicators.camarilla, lastClose, atr);
    const camW = srW * volMult * srPenalty;
    upScore += camScore.up * camW * 0.6;
    downScore += camScore.down * camW * 0.6;
  }
  catScores.camarilla = { up: r2(camScore.up), down: r2(camScore.down), level: camScore.level };
  let htfPenalty = 1;
  if (higherTFTrend !== null) {
    const thisTFDir = upScore > downScore ? "BUY" : downScore > upScore ? "SELL" : null;
    if (thisTFDir !== null && thisTFDir !== higherTFTrend) {
      htfPenalty = 0.7;
      if (thisTFDir === "BUY") upScore *= 0.7;
      else downScore *= 0.7;
    }
  }
  const structure = indicators.structure || null;
  let structureApplied = "NONE";
  let structureMultUp = 1;
  let structureMultDn = 1;
  if (structure && structure.multiplier && structure.multiplier.direction) {
    const sDir = structure.multiplier.direction;
    const sVal = structure.multiplier.value;
    const sOpp = 2 - sVal;
    if (sDir === "BUY") {
      structureMultUp = sVal;
      structureMultDn = Math.max(0.45, sOpp);
    } else if (sDir === "SELL") {
      structureMultDn = sVal;
      structureMultUp = Math.max(0.45, sOpp);
    }
    structureApplied = structure.summary;
  } else if (structure && structure.bias !== "NEUTRAL") {
    if (structure.bias === "BULLISH") {
      structureMultUp = 1.08;
      structureMultDn = 0.92;
    } else if (structure.bias === "BEARISH") {
      structureMultDn = 1.08;
      structureMultUp = 0.92;
    }
    structureApplied = "BIAS_" + structure.bias;
  }
  const __r71PreStructUp = upScore;
  const __r71PreStructDown = downScore;
  const __r71PreStructUpCat = upCat;
  const __r71PreStructDownCat = downCat;
  upScore *= structureMultUp;
  downScore *= structureMultDn;
  let __r71CategoryVoteApplied = false;
  let __r71VoteDirection = null;
  if (structure && structure.structureScore) {
    catScores.structure = {
      up: structure.structureScore.up,
      down: structure.structureScore.down,
      bias: structure.bias,
      bos: structure.bos ? structure.bos.type : "NONE",
      choch: structure.choch ? structure.choch.type : "NONE",
      sweep: structure.sweep ? structure.sweep.type : "NONE",
      summary: structure.summary
    };
    if (structure.structureScore.up > structure.structureScore.down && structure.structureScore.up >= 1.5) {
      upCat++;
      __r71CategoryVoteApplied = true;
      __r71VoteDirection = "BUY";
    } else if (structure.structureScore.down > structure.structureScore.up && structure.structureScore.down >= 1.5) {
      downCat++;
      __r71CategoryVoteApplied = true;
      __r71VoteDirection = "SELL";
    }
  }
  const scoreDiff = Math.abs(upScore - downScore);
  const confluence = Math.max(upCat, downCat);
  let direction = decideTfDirection(upScore, downScore, upCat, downCat, minScoreThreshold);
  const __r71PreHardBlockDirection = direction;
  let __r71HardBlocked = false;
  let __r71HardBlockReason = null;
  if (direction !== "NO_TRADE" && structure) {
    const sDir = structure.multiplier ? structure.multiplier.direction : null;
    const hasStrongStructure = structure.choch || structure.bos && structure.multiplier?.value >= 1.2;
    if (hasStrongStructure && sDir !== null && sDir !== direction) {
      direction = "NO_TRADE";
      __r71HardBlocked = true;
      __r71HardBlockReason = "COUNTER_" + structure.summary;
      catScores.structure = { ...catScores.structure || {}, hardBlocked: true, reason: "COUNTER_" + structure.summary };
    }
    if (structure.sweep && structure.sweep.direction !== direction && direction !== "NO_TRADE") {
      catScores.structure = { ...catScores.structure || {}, sweepWarning: "COUNTER_SWEEP_" + structure.sweep.type };
    }
  }
  let candleConfirmed = true;
  if (direction !== "NO_TRADE") {
    const lastBullish = lastCandle.close >= lastCandle.open;
    const bodyRatio = Math.abs(lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1e-5);
    if (direction === "BUY" && !lastBullish && bodyRatio > 0.5) {
      candleConfirmed = false;
      upScore *= 0.85;
    }
    if (direction === "SELL" && lastBullish && bodyRatio > 0.5) {
      candleConfirmed = false;
      downScore *= 0.85;
    }
  }
  const __r71ShadowCoreDir = decideTfDirection(
    __r71PreStructUp,
    __r71PreStructDown,
    __r71PreStructUpCat,
    __r71PreStructDownCat,
    minScoreThreshold
  );
  let __r71ShadowCandleConfirmed = true;
  let __r71ShadowConfPenalty = false;
  if (__r71ShadowCoreDir !== "NO_TRADE") {
    const sLastBullish = lastCandle.close >= lastCandle.open;
    const sBodyRatio = Math.abs(lastCandle.close - lastCandle.open) / (lastCandle.high - lastCandle.low || 1e-5);
    if (__r71ShadowCoreDir === "BUY" && !sLastBullish && sBodyRatio > 0.5) __r71ShadowCandleConfirmed = false;
    if (__r71ShadowCoreDir === "SELL" && sLastBullish && sBodyRatio > 0.5) __r71ShadowCandleConfirmed = false;
    __r71ShadowConfPenalty = !__r71ShadowCandleConfirmed;
  }
  const __r71ShadowEngUp = __r71ShadowCoreDir === "BUY" && __r71ShadowConfPenalty ? r2(__r71PreStructUp * 0.85) : r2(__r71PreStructUp);
  const __r71ShadowEngDown = __r71ShadowCoreDir === "SELL" && __r71ShadowConfPenalty ? r2(__r71PreStructDown * 0.85) : r2(__r71PreStructDown);
  let __r71ChochEventAgeBars = null;
  let __r71BrokenSwingAgeBars = null;
  let __r71BosReferenceSwingBarsAgo = null;
  let __r71RecentBosBreakBarsAgo = null;
  if (structure) {
    __r71ChochEventAgeBars = structure.choch ? 0 : null;
    __r71BosReferenceSwingBarsAgo = structure.bos ? structure.bos.barsAgo : null;
    if (structure.choch) {
      const swings = structure.choch.direction === "BUY" ? structure.swingHighs : structure.swingLows;
      const lastSwing = swings && swings.length ? swings[swings.length - 1] : null;
      if (lastSwing && typeof lastSwing.idx === "number")
        __r71BrokenSwingAgeBars = candles.length - 1 - lastSwing.idx;
    } else if (structure.bos) {
      __r71BrokenSwingAgeBars = structure.bos.barsAgo;
    }
    if (Array.isArray(structure.recentEvents) && structure.recentEvents.length) {
      let minAgo = Infinity;
      for (const ev of structure.recentEvents)
        if (typeof ev.barsAgo === "number" && ev.barsAgo < minAgo) minAgo = ev.barsAgo;
      __r71RecentBosBreakBarsAgo = minAgo === Infinity ? null : minAgo;
    }
  }
  const __r71Result = {
    direction,
    timeframe,
    assetType,
    score: { up: r2(upScore), down: r2(downScore), diff: r2(scoreDiff) },
    confluence,
    confluenceDetail: { bullish: upCat, bearish: downCat, total: 12 },
    // 12 categories now
    categoryScores: catScores,
    structure: structure || null,
    // Full structure data in output
    structureApplied,
    volatilityMultiplier: volMult,
    htfPenalty: htfPenalty < 1 ? "COUNTER_TREND_PENALTY" : "NONE",
    marketContext: trending === true ? "TRENDING" : trending === false ? "RANGING" : "UNKNOWN",
    candleConfirmed,
    indicators: {
      ema5: fmt(ema5),
      ema13: fmt(ema13),
      ema55: fmt(ema55),
      emaAlignment,
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
      mfi: assetType === ASSET_TYPE.CRYPTO ? fmt(mfi, 2) : "N/A (Forex)",
      atr: fmt(atr, 6),
      bbUpper: fmt(bbUpper),
      bbMiddle: fmt(bbMiddle),
      bbLower: fmt(bbLower),
      bbBandwidth: bbBandwidth !== null ? bbBandwidth.toFixed(4) : "N/A",
      bbPercentB: fmt(bbPercentB, 4),
      pivot: pivots.pivot !== null ? pivots.pivot.toFixed(5) : "N/A",
      r1: pivots.r1 !== null ? pivots.r1.toFixed(5) : "N/A",
      r2val: pivots.r2 !== null ? pivots.r2.toFixed(5) : "N/A",
      s1: pivots.s1 !== null ? pivots.s1.toFixed(5) : "N/A",
      s2: pivots.s2 !== null ? pivots.s2.toFixed(5) : "N/A",
      patterns: patterns ? patterns.map((p) => p.name) : []
    }
  };
  attachShadowTf(__r71Result, {
    preStructUp: r2(__r71PreStructUp),
    preStructDown: r2(__r71PreStructDown),
    preStructUpCat: __r71PreStructUpCat,
    preStructDownCat: __r71PreStructDownCat,
    shadowCoreDirection: __r71ShadowCoreDir,
    shadowCandleConfirmed: __r71ShadowCandleConfirmed,
    shadowConfirmationPenaltyApplied: __r71ShadowConfPenalty,
    shadowEngineScoreUp: __r71ShadowEngUp,
    shadowEngineScoreDown: __r71ShadowEngDown,
    structureMultUp,
    structureMultDn,
    preHardBlockDirection: __r71PreHardBlockDirection,
    hardBlocked: __r71HardBlocked,
    hardBlockReason: __r71HardBlockReason,
    categoryVoteApplied: __r71CategoryVoteApplied,
    voteDirection: __r71VoteDirection,
    freshness: {
      chochEventAgeBars: __r71ChochEventAgeBars,
      brokenSwingAgeBars: __r71BrokenSwingAgeBars,
      bosReferenceSwingBarsAgo: __r71BosReferenceSwingBarsAgo,
      recentBosBreakBarsAgo: __r71RecentBosBreakBarsAgo
    }
  });
  return __r71Result;
}

// src/analysis/duration.js
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
  if (rsi !== null) {
    if (rsi > 82 || rsi < 18) dur -= 2;
    else if (rsi > 72 || rsi < 28) dur -= 1;
  }
  if (stochK !== null && (stochK > 92 || stochK < 8)) dur -= 1;
  if (atr !== null && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > 0) {
      const atrPct = atr / lastClose * 100;
      if (atrPct > vt.atrVeryHigh) dur -= 2;
      else if (atrPct > vt.atrHigh) dur -= 1;
      else if (atrPct < vt.atrDead) dur += 2;
      else if (atrPct < vt.atrLow) dur += 1;
    }
  }
  if (adxVal !== null) {
    if (adxVal >= 40) dur += 1;
    else if (adxVal < 15) dur -= 1;
  }
  if (bbBW !== null && bbBW < vt.bbSqueeze) dur += 1;
  if (indicators.patterns) {
    const strongNames = ["MORNING_STAR", "EVENING_STAR", "THREE_WHITE_SOLDIERS", "THREE_BLACK_CROWS", "BULLISH_ENGULFING", "BEARISH_ENGULFING"];
    if (indicators.patterns.some((p) => strongNames.includes(p.name))) dur += 1;
  }
  if (rsi !== null && direction === "BUY" && rsi >= 55 && rsi <= 68) dur += 1;
  if (rsi !== null && direction === "SELL" && rsi <= 45 && rsi >= 32) dur += 1;
  if (timeframe === "15min" && adxVal !== null && adxVal < 20) dur -= 1;
  if (timeframe === "1min" && adxVal !== null && adxVal >= 30) dur += 1;
  return Math.max(cfg.min, Math.min(cfg.max, Math.round(dur)));
}
function calculateOTCCandleDuration(indicators, direction, candles, timeframe) {
  const cfg = OTC_DURATION_CONFIG[timeframe] || { base: 2, min: 1, max: 3 };
  let dur = cfg.base;
  const rsi = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr = safeLastValue(indicators.atr);
  if (rsi !== null && (rsi > 80 || rsi < 20)) dur -= 1;
  if (stochK !== null && (stochK > 90 || stochK < 10)) dur -= 1;
  if (atr !== null && candles.length > 0) {
    const lc = candles[candles.length - 1].close;
    if (lc > 0 && atr / lc * 100 > 0.15) dur -= 1;
  }
  return Math.max(cfg.min, Math.min(cfg.max, dur));
}

// src/signal/engine.js
init_calibration();

// src/analysis/edgeFeatures.js
function toNum(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  return null;
}
function lastNum(v) {
  if (v === null || v === void 0) return null;
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = toNum(v[i]);
      if (n !== null) return n;
    }
    return null;
  }
  return toNum(v);
}
var clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
var round2 = (x) => Math.round(x * 100) / 100;
var round4 = (x) => Math.round(x * 1e4) / 1e4;
function pairKey2(pair) {
  try {
    return String(pair).replace(/\//g, "_").replace(/-/g, "_");
  } catch (e) {
    return String(pair || "");
  }
}
function pickBestTF(tfResults, direction) {
  if (!tfResults) return null;
  let best = null;
  let bestEc = -1;
  let bestScore = -1;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (!r) continue;
    if (direction === "NO_TRADE" || r.direction === direction) {
      const score = r.direction === "BUY" ? r.score && r.score.up || 0 : r.direction === "SELL" ? r.score && r.score.down || 0 : 0;
      const ec = (r.confluence || 0) + (r.alignedWithHTF ? 1 : 0);
      if (ec > bestEc || ec === bestEc && score > bestScore) {
        best = tf;
        bestEc = ec;
        bestScore = score;
      }
    }
  }
  if (!best) {
    for (const tf of ["15min", "5min", "1min"]) {
      if (tfResults[tf]) {
        best = tf;
        break;
      }
    }
  }
  return best;
}
function rawIndicators(indicators, tf) {
  return indicators && indicators[tf] || null;
}
function computeSessionRange(candleData, now, cfg) {
  if (!candleData || !now) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = start + 24 * 3600 * 1e3;
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let count = 0;
  let lastClose = null;
  for (const candles of Object.values(candleData)) {
    if (!Array.isArray(candles)) continue;
    for (const c of candles) {
      if (!c || !c.datetime) continue;
      let t;
      try {
        const iso = String(c.datetime).includes("T") ? String(c.datetime) : String(c.datetime).replace(" ", "T");
        t = new Date(iso.endsWith("Z") || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z").getTime();
      } catch (e) {
        continue;
      }
      if (!isFinite(t) || t < start || t >= end) continue;
      const h = toNum(c.high);
      const l = toNum(c.low);
      const cl = toNum(c.close);
      if (h === null || l === null || cl === null) continue;
      if (h > dayHigh) dayHigh = h;
      if (l < dayLow) dayLow = l;
      lastClose = cl;
      count++;
    }
  }
  if (count < (cfg.minCandles || 20) || !isFinite(dayHigh) || !isFinite(dayLow)) return null;
  const range = dayHigh - dayLow;
  const ref = Math.abs(dayHigh) > 0 ? Math.abs(dayHigh) : 1;
  if (range <= 0 || range / ref < (cfg.minRangePct || 5e-4)) return null;
  const pos = clamp((lastClose - dayLow) / range, 0, 1);
  return { position: round2(pos), count };
}
function computeAtrPercentile(atrArr, window, minSamples) {
  if (!Array.isArray(atrArr) || atrArr.length < 2) return null;
  const win = Math.max(2, window || 50);
  const min = Math.max(2, minSamples || 20);
  const hist = atrArr.slice(-(win + 1), -1);
  const cur = lastNum(atrArr[atrArr.length - 1]);
  if (cur === null || isNaN(cur)) return null;
  const vals = hist.filter((v) => {
    const n = toNum(v);
    return n !== null && isFinite(n) && n > 0;
  });
  if (vals.length < min) return null;
  let below = 0;
  for (const v of vals) if (v < cur) below++;
  return Math.round(below / vals.length * 1e3) / 10;
}
async function getRecentFormMultiplier(pair, env, cfg) {
  try {
    if (!env || !env.SIGNAL_CACHE) return { mult: 1, wr: null, sample: 0 };
    const stats = await env.SIGNAL_CACHE.get("stats:" + pairKey2(pair), "json");
    if (!stats || typeof stats.winRate !== "number" || !Array.isArray(stats.recentResults)) {
      return { mult: 1, wr: null, sample: 0 };
    }
    const sample = stats.recentResults.length;
    if (sample < (cfg.minSample || 10)) return { mult: 1, wr: stats.winRate, sample };
    if (stats.winRate < (cfg.badWr || 0.35)) {
      return { mult: cfg.badMult || 0.85, wr: stats.winRate, sample };
    }
    return { mult: 1, wr: stats.winRate, sample };
  } catch (e) {
    return { mult: 1, wr: null, sample: 0 };
  }
}
async function applyEdgeFeatures(ctx) {
  const cfg = CONFIG.EDGE_FEATURES;
  const {
    finalDirection,
    confidence,
    pair,
    assetType,
    now,
    candleData,
    tfResults,
    indicators,
    env,
    calib
  } = ctx || {};
  const audit = {
    hourUtc: null,
    hourMult: 1,
    sessionRange: null,
    sessionRangeMult: 1,
    rsi: null,
    rsiGate: null,
    bbBandwidth: null,
    bbState: null,
    volMult: 1,
    atrPercentile: null,
    atrMult: 1,
    recentFormWr: null,
    recentFormMult: 1,
    totalMult: 1,
    blockedBy: null
  };
  const applied = [];
  if (!cfg || cfg.enabled === false) return { finalDirection, confidence, filtersApplied: [], audit: null };
  if (finalDirection === "NO_TRADE" || finalDirection === void 0 || finalDirection === null) {
    return { finalDirection, confidence, filtersApplied: [], audit: null };
  }
  let dir = finalDirection;
  let conf = confidence;
  let totalMult = 1;
  const volCfg = cfg.VOL_STATE || {};
  const volKey = assetType === ASSET_TYPE.CRYPTO ? "CRYPTO" : "FOREX";
  const deadBlock = (volCfg.deadSqueezeBlock && volCfg.deadSqueezeBlock[volKey]) != null ? volCfg.deadSqueezeBlock[volKey] : null;
  const squeezeMax = (volCfg.squeezeMax && volCfg.squeezeMax[volKey]) != null ? volCfg.squeezeMax[volKey] : null;
  const bestTF = pickBestTF(tfResults, dir);
  const raw = bestTF ? rawIndicators(indicators, bestTF) : null;
  const rsi = raw ? lastNum(raw.rsi) : null;
  let bb = null;
  if (raw) {
    bb = lastNum(raw.bollinger && raw.bollinger.bandwidth);
    if (bb === null && raw.bbBandwidth !== void 0) bb = lastNum(raw.bbBandwidth);
  }
  const atrArr = raw ? raw.atr : null;
  if (rsi !== null) audit.rsi = round2(rsi);
  if (bb !== null) audit.bbBandwidth = round2(bb);
  const rsiCfg = cfg.RSI_DIRECTION_GATE || {};
  if (rsiCfg.enabled !== false && rsi !== null) {
    const chasing = dir === "BUY" && rsi > (rsiCfg.buyMaxRsi || 55) || dir === "SELL" && rsi < (rsiCfg.sellMinRsi || 45);
    if (chasing) {
      const mode = rsiCfg.mode === "block" ? "block" : "penalty";
      const gateDir = dir;
      const threshold = gateDir === "BUY" ? rsiCfg.buyMaxRsi || 55 : rsiCfg.sellMinRsi || 45;
      audit.rsiGate = {
        direction: gateDir,
        rsi: round2(rsi),
        threshold,
        mode,
        mult: mode === "penalty" ? rsiCfg.penaltyMult || 0.85 : null
      };
      if (mode === "block") {
        dir = "NO_TRADE";
        conf = 0;
        applied.push("RSI_DIRECTION_GATE_BLOCK (" + gateDir + " rsi=" + round2(rsi) + " > " + threshold + ")");
        audit.blockedBy = "RSI_DIRECTION_GATE";
        return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
      }
      totalMult *= rsiCfg.penaltyMult || 0.85;
      applied.push("RSI_DIRECTION_GATE_PENALTY x" + (rsiCfg.penaltyMult || 0.85).toFixed(2) + " (" + gateDir + " rsi=" + round2(rsi) + " " + (gateDir === "BUY" ? ">" : "<") + " " + threshold + ")");
    }
  }
  const volCfg2 = cfg.VOL_STATE || {};
  if (volCfg2.enabled !== false && bb !== null) {
    if (deadBlock !== null && bb <= deadBlock) {
      dir = "NO_TRADE";
      conf = 0;
      applied.push("VOL_STATE_DEAD_SQUEEZE_BLOCK (bb=" + round2(bb) + " <= " + deadBlock + ")");
      audit.bbState = "DEAD_SQUEEZE";
      audit.blockedBy = "VOL_STATE_DEAD_SQUEEZE";
      return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
    }
    if (squeezeMax !== null && bb <= squeezeMax) {
      totalMult *= volCfg2.squeezeMult || 0.9;
      audit.bbState = "MID_SQUEEZE";
      applied.push("VOL_STATE_MID_SQUEEZE x" + (volCfg2.squeezeMult || 0.9).toFixed(2) + " (bb=" + round2(bb) + " <= " + squeezeMax + ")");
    } else {
      audit.bbState = "HIGH_VOL";
    }
  }
  const atrCfg = cfg.ATR_PERCENTILE || {};
  if (atrCfg.enabled !== false && Array.isArray(atrArr)) {
    const pct = computeAtrPercentile(atrArr, atrCfg.window, atrCfg.minSamples);
    if (pct !== null) {
      audit.atrPercentile = pct;
      if (pct < (atrCfg.squeezePct || 30)) {
        totalMult *= atrCfg.squeezeMult || 0.95;
        applied.push("ATR_PERCENTILE_SQUEEZE x" + (atrCfg.squeezeMult || 0.95).toFixed(2) + " (pct=" + pct + ")");
      } else if (pct > (atrCfg.expansionPct || 80)) {
        totalMult *= atrCfg.expansionMult || 1.05;
        applied.push("ATR_PERCENTILE_EXPANSION x" + (atrCfg.expansionMult || 1.05).toFixed(2) + " (pct=" + pct + ")");
      }
    }
  }
  const hour = now instanceof Date ? now.getUTCHours() : (/* @__PURE__ */ new Date()).getUTCHours();
  audit.hourUtc = hour;
  let hourMult = 1;
  if (calib && calib.hourWR && calib.hourWR[hour] && calib.hourWR[hour].n >= (CONFIG.SELF_CALIB.MIN_HOUR_OBS || 20) && typeof calib.hourWR[hour].wr === "number" && typeof calib.base === "number") {
    const wr = calib.hourWR[hour].wr;
    hourMult = clamp(wr / calib.base, CONFIG.SELF_CALIB.HOUR_MULT_MIN || 0.85, CONFIG.SELF_CALIB.HOUR_MULT_MAX || 1.1);
  } else {
    hourMult = cfg.HOUR_MULTIPLIERS && cfg.HOUR_MULTIPLIERS[hour] || 1;
  }
  if (hourMult !== 1) {
    totalMult *= hourMult;
    applied.push("HOUR_FACTOR x" + hourMult.toFixed(2) + " (UTC " + String(hour).padStart(2, "0") + ")");
  }
  audit.hourMult = round4(hourMult);
  const srCfg = cfg.SESSION_RANGE || {};
  if (srCfg.enabled !== false) {
    const sr = computeSessionRange(candleData, now, srCfg);
    if (sr) {
      audit.sessionRange = sr.position;
      if (sr.position <= (srCfg.extremeLow || 0.15) || sr.position >= (srCfg.extremeHigh || 0.85)) {
        totalMult *= srCfg.extremeMult || 1.05;
        audit.sessionRangeMult = srCfg.extremeMult || 1.05;
        applied.push("SESSION_RANGE_EXTREME x" + (srCfg.extremeMult || 1.05).toFixed(2) + " (pos=" + sr.position + ")");
      }
    }
  }
  const rfCfg = cfg.RECENT_FORM || {};
  if (rfCfg.enabled !== false) {
    const rf = await getRecentFormMultiplier(pair, env, rfCfg);
    if (rf.mult !== 1) {
      totalMult *= rf.mult;
      audit.recentFormWr = round2(rf.wr);
      audit.recentFormMult = rf.mult;
      applied.push("RECENT_FORM_PENALTY x" + rf.mult.toFixed(2) + " (wr=" + round2(rf.wr) + ", n=" + rf.sample + ")");
    } else if (rf.wr !== null) {
      audit.recentFormWr = round2(rf.wr);
    }
  }
  totalMult = clamp(totalMult, cfg.MIN_TOTAL_MULT || 0.55, cfg.MAX_TOTAL_MULT || 1.12);
  audit.totalMult = round4(totalMult);
  if (totalMult !== 1 && dir !== "NO_TRADE") {
    conf = Math.min(92, Math.round(conf * totalMult));
  }
  return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
}

// src/ai/cerebras.js
async function callCerebrasValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.CEREBRAS_API_KEY) return { status: "NO_KEY" };
  const snap = indicatorSnapshot;
  const prompt = [
    "You are an expert binary options trading analyst. Analyze the following technical indicator snapshot for " + pair + " (" + assetType + ").",
    "",
    "=== ENGINE SIGNAL ===",
    "Direction: " + engineSignal.direction,
    "Confidence: " + engineSignal.confidence,
    "Alignment: " + engineSignal.alignment,
    "HTF Trend (15min): " + engineSignal.higherTFTrend,
    "Market condition: " + (engineSignal.marketCondition || []).join(", "),
    "",
    "=== INDICATOR SNAPSHOT (best timeframe: " + engineSignal.bestTF + ") ===",
    "EMA alignment: " + snap.emaAlignment,
    "EMA5/13/55: " + snap.ema5 + " / " + snap.ema13 + " / " + snap.ema55,
    "RSI(14): " + snap.rsi,
    "MACD histogram: " + snap.macdHist,
    "ADX: " + snap.adx + "  (+DI " + snap.plusDI + "  -DI " + snap.minusDI + ")",
    "Stochastic K/D: " + snap.stochK + " / " + snap.stochD,
    "Williams %R: " + snap.williamsR,
    "CCI: " + snap.cci,
    "BB %B: " + snap.bbPercentB + "  Bandwidth: " + snap.bbBandwidth,
    "ATR: " + snap.atr,
    "S/R context: " + snap.srContext,
    "FVG active: " + snap.fvgActive,
    "Candlestick patterns: " + (snap.patterns.length ? snap.patterns.join(", ") : "NONE"),
    "RSI divergence: " + snap.rsiDiv,
    "MACD divergence: " + snap.macdDiv,
    "Pivot: " + snap.pivot + "  R1: " + snap.r1 + "  S1: " + snap.s1,
    "",
    "=== PRICE STRUCTURE (last 20 candles) ===",
    "1min  structure: " + snap.structure1min,
    "5min  structure: " + snap.structure5min,
    "15min structure: " + snap.structure15min,
    "",
    "=== RAW CANDLES (U=bullish B=bearish, newest last) ===",
    "1min  (20): " + snap.candles1min,
    "5min  (20): " + snap.candles5min,
    "15min (20): " + snap.candles15min,
    "",
    "=== YOUR TASK ===",
    "Respond in STRICT JSON only \u2014 no markdown:",
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}'
  ].join("\n");
  return _callCerebrasAPI(prompt, env);
}
async function callCerebrasValidationOTC(pair, engineSignal, snapshot, otcPatterns, env) {
  if (!env || !env.CEREBRAS_API_KEY) return { status: "NO_KEY" };
  const snap = snapshot;
  const otcSummary = [
    "=== OTC CONTEXT ===",
    "Consecutive candles: " + (otcPatterns.consecutiveCandles ? otcPatterns.consecutiveCandles.count + " \xD7 " + otcPatterns.consecutiveCandles.direction : "N/A"),
    "Wick rejection: " + (otcPatterns.wickRejection ? otcPatterns.wickRejection.type + " (ratio=" + otcPatterns.wickRejection.wickRatio + ")" : "NONE"),
    "Round number: " + (otcPatterns.roundNumber ? otcPatterns.roundNumber.stepType + " (proximity=" + otcPatterns.roundNumber.proximity + ")" : "NONE"),
    "Size anomaly: " + (otcPatterns.sizeAnomaly ? "YES expect " + otcPatterns.sizeAnomaly.likelyDirection + " (" + otcPatterns.sizeAnomaly.strength + ")" : "NONE"),
    "Time quality: " + (otcPatterns.timeContext ? otcPatterns.timeContext.quality + " \u2014 " + otcPatterns.timeContext.reason : "N/A"),
    "OTC signals: " + (otcPatterns.otcSignals.length ? otcPatterns.otcSignals.join(", ") : "NONE")
  ].join("\n");
  const prompt = [
    "=== OTC BINARY TRADING ANALYSIS ===",
    "Pair: " + pair + " (OTC \u2014 Olymp Trade synthetic)",
    "Engine signal: " + engineSignal.direction + " @ " + engineSignal.confidence,
    "",
    "=== IMPORTANT OTC RULES ===",
    "1. SYNTHETIC price \u2014 broker controls it. Trend-following is UNRELIABLE.",
    "2. Mean reversion is primary.",
    "3. Focus on: patterns, RSI/Stoch extremes, BB touches, S/R bounces.",
    "4. 3+ consecutive same-direction candles = high reversal probability.",
    "5. Long wicks = reversal signal.",
    "",
    "=== INDICATORS ===",
    "EMA alignment: " + snap.emaAlignment,
    "RSI(14): " + snap.rsi,
    "Stoch K/D: " + snap.stochK + " / " + snap.stochD,
    "Williams %R: " + snap.williamsR,
    "CCI: " + snap.cci,
    "BB %B: " + snap.bbPercentB + "  BW: " + snap.bbBandwidth,
    "MACD hist: " + snap.macdHist,
    "Patterns: " + (snap.patterns.length ? snap.patterns.join(", ") : "NONE"),
    "RSI div: " + snap.rsiDiv + "  S/R: " + snap.srContext,
    "",
    "=== PRICE STRUCTURE ===",
    "1min: " + snap.structure1min,
    "5min: " + snap.structure5min,
    "",
    otcSummary,
    "",
    "=== RAW CANDLES ===",
    "1min (20): " + snap.candles1min,
    "5min (20): " + snap.candles5min,
    "",
    "Respond in STRICT JSON only:",
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}'
  ].join("\n");
  const result = await _callCerebrasAPI(prompt, env);
  if (result.status === "OK") result.mode = "OTC";
  return result;
}
async function _callCerebrasAPI(prompt, env) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8e3);
    let res;
    try {
      res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.CEREBRAS_API_KEY },
        body: JSON.stringify({ model: "gpt-oss-120b", max_completion_tokens: 500, temperature: 0.05, reasoning_effort: "low", messages: [{ role: "user", content: prompt }] })
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) return { status: "API_ERROR", httpStatus: res.status };
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let text = msg ? msg.content || msg.reasoning_content || "" : "";
    text = (text || "").trim();
    if (!text) return { status: "EMPTY_RESPONSE", raw: JSON.stringify(data).slice(0, 200) };
    text = text.replace(/```json|```/g, "").trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: "PARSE_ERROR", raw: text.slice(0, 100) };
    const parsed = JSON.parse(jsonMatch[0]);
    const valid = ["BUY", "SELL", "NO_TRADE"];
    const aiSig = typeof parsed.signal === "string" ? parsed.signal.toUpperCase() : "NO_TRADE";
    const aiConf = typeof parsed.confidence === "number" ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return {
      status: "OK",
      signal: valid.includes(aiSig) ? aiSig : "NO_TRADE",
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: "cerebras/gpt-oss-120b"
    };
  } catch (e) {
    if (e.name === "AbortError") return { status: "TIMEOUT" };
    return { status: "ERROR", message: e.message };
  }
}

// src/ai/groq.js
async function callGroqValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.GROQ_API_KEY) return { status: "NO_KEY" };
  const snap = indicatorSnapshot;
  const prompt = [
    "Expert binary options analyst. Analyze " + pair + " (" + assetType + ").",
    "Engine says: " + engineSignal.direction + " @ " + engineSignal.confidence + " confidence.",
    "Alignment: " + engineSignal.alignment + " | HTF: " + (engineSignal.higherTFTrend || "N/A"),
    "",
    "Indicators:",
    "EMA: " + snap.emaAlignment + " | RSI: " + snap.rsi,
    "MACD hist: " + snap.macdHist + " | ADX: " + snap.adx,
    "Stoch K/D: " + snap.stochK + "/" + snap.stochD,
    "BB %B: " + snap.bbPercentB + " BW: " + snap.bbBandwidth,
    "Williams: " + snap.williamsR + " | CCI: " + snap.cci,
    "Patterns: " + (snap.patterns.length ? snap.patterns.join(",") : "NONE"),
    "RSI div: " + snap.rsiDiv + " | S/R: " + snap.srContext,
    "Structure 1min: " + snap.structure1min,
    "Structure 5min: " + snap.structure5min,
    "",
    "Candles 1min: " + snap.candles1min,
    "Candles 5min: " + snap.candles5min,
    "",
    'Respond ONLY in JSON: {"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 15 words","concerns":"max 10 words or null"}'
  ].join("\n");
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6e3);
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.GROQ_API_KEY },
        body: JSON.stringify({ model: "llama-3.1-8b-instant", max_tokens: 100, temperature: 0.05, messages: [{ role: "user", content: prompt }] })
      });
    } finally {
      clearTimeout(tid);
    }
    if (!res.ok) return { status: "API_ERROR", httpStatus: res.status };
    const data = await res.json();
    let text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: "EMPTY_RESPONSE" };
    text = text.replace(/```json|```/g, "").trim();
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return { status: "PARSE_ERROR" };
    const parsed = JSON.parse(jm[0]);
    const valid = ["BUY", "SELL", "NO_TRADE"];
    const aiSig = typeof parsed.signal === "string" ? parsed.signal.toUpperCase() : "NO_TRADE";
    const aiConf = typeof parsed.confidence === "number" ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return {
      status: "OK",
      signal: valid.includes(aiSig) ? aiSig : "NO_TRADE",
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: "groq/llama-3.1-8b-instant"
    };
  } catch (e) {
    if (e.name === "AbortError") return { status: "TIMEOUT" };
    return { status: "ERROR", message: e.message };
  }
}

// src/ai/combine.js
function combineDualAIResults(cerebras, groq, engineDirection) {
  const result = { cerebras, groq, combined: null, combinedAgreed: null };
  const cOk = cerebras && cerebras.status === "OK";
  const gOk = groq && groq.status === "OK";
  if (!cOk && !gOk) {
    result.combined = { status: "BOTH_UNAVAILABLE", signal: "NO_TRADE", confidence: 0 };
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
  if (cerebras.signal === groq.signal) {
    result.combined = {
      status: "OK",
      signal: cerebras.signal,
      confidence: Math.round((cerebras.confidence + groq.confidence) / 2),
      reason: cerebras.reason || groq.reason,
      concerns: cerebras.concerns || groq.concerns,
      agreement: "BOTH_AGREE",
      model: "dual (Cerebras + Groq)"
    };
  } else {
    result.combined = {
      status: "OK",
      signal: "NO_TRADE",
      confidence: Math.min(cerebras.confidence, groq.confidence),
      reason: "Cerebras=" + cerebras.signal + " vs Groq=" + groq.signal + " \u2014 AIs disagree",
      concerns: "Conflicting AI signals \u2014 skip trade",
      agreement: "AIs_DISAGREE",
      model: "dual (Cerebras + Groq)"
    };
  }
  result.combinedAgreed = result.combined.signal === engineDirection;
  return result;
}
function buildIndicatorSnapshot(tfResults, candleData, finalDirection, bestTF) {
  const best = tfResults[bestTF] || tfResults["5min"] || tfResults["1min"] || tfResults["15min"];
  if (!best) return null;
  const ind = best.indicators || {};
  const catScores = best.categoryScores || {};
  function compactCandles(candles, count) {
    if (!candles || candles.length === 0) return "N/A";
    return candles.slice(-count).map((c) => {
      const dir = c.close >= c.open ? "U" : "B";
      return dir + ":" + c.open.toFixed(5) + "/" + c.high.toFixed(5) + "/" + c.low.toFixed(5) + "/" + c.close.toFixed(5);
    }).join(" ");
  }
  function priceStructure(candles) {
    if (!candles || candles.length < 6) return "UNKNOWN";
    const recent = candles.slice(-20);
    const n = recent.length;
    const highs = recent.map((c) => c.high);
    const lows = recent.map((c) => c.low);
    const midH1 = Math.max(...highs.slice(0, Math.floor(n / 2)));
    const midH2 = Math.max(...highs.slice(Math.floor(n / 2)));
    const midL1 = Math.min(...lows.slice(0, Math.floor(n / 2)));
    const midL2 = Math.min(...lows.slice(Math.floor(n / 2)));
    if (midH2 > midH1 && midL2 > midL1) return "HH-HL (Bullish)";
    if (midH2 < midH1 && midL2 < midL1) return "LH-LL (Bearish)";
    if (midH2 > midH1 && midL2 < midL1) return "Expanding (Volatile)";
    if (midH2 < midH1 && midL2 > midL1) return "Contracting (Consolidation)";
    return "Mixed structure";
  }
  const c1 = candleData["1min"] || [];
  const c5 = candleData["5min"] || [];
  const c15 = candleData["15min"] || [];
  return {
    // EMA 5/13/55 (Fibonacci set)
    emaAlignment: ind.emaAlignment || "UNKNOWN",
    ema5: ind.ema5 || "N/A",
    ema13: ind.ema13 || "N/A",
    ema55: ind.ema55 || "N/A",
    rsi: ind.rsi || "N/A",
    macdHist: ind.macdHist || "N/A",
    adx: ind.adx || "N/A",
    plusDI: ind.plusDI || "N/A",
    minusDI: ind.minusDI || "N/A",
    stochK: ind.stochK || "N/A",
    stochD: ind.stochD || "N/A",
    williamsR: ind.williamsR || "N/A",
    cci: ind.cci || "N/A",
    bbPercentB: ind.bbPercentB || "N/A",
    bbBandwidth: ind.bbBandwidth || "N/A",
    atr: ind.atr || "N/A",
    pivot: ind.pivot || "N/A",
    r1: ind.r1 || "N/A",
    s1: ind.s1 || "N/A",
    srContext: catScores.sr && catScores.sr.context || "NO_LEVEL",
    fvgActive: catScores.fvg && catScores.fvg.active || "NONE",
    patterns: catScores.patterns && catScores.patterns.detected || [],
    rsiDiv: catScores.divergence && catScores.divergence.rsi || "NONE",
    macdDiv: catScores.divergence && catScores.divergence.macd || "NONE",
    candles1min: compactCandles(c1, 20),
    candles5min: compactCandles(c5, 20),
    candles15min: compactCandles(c15, 20),
    structure1min: priceStructure(c1),
    structure5min: priceStructure(c5),
    structure15min: priceStructure(c15)
  };
}

// src/history/d2store.js
var OBS_PREFIX = "d2obs:";
var PENDING_PREFIX = "d2pending:";
var IDX_PREFIX = "d2idx:";
var MAX_PER_PAIR_30D = 30;
var RETENTION_TTL_S = 30 * 24 * 3600;
var PENDING_TTL_S = Math.floor(2 * 60 * 60);
var PENDING_MAX_CHECKS = 15;
var RESOLVER_CAP = 10;
var RESULT_CHECK_DELAY_S = 90;
var DEDUP_WINDOW_MS2 = 2 * 60 * 60 * 1e3;
var DEDUP_ENTRY_REL_TOL = 5e-4;
var DEDUP_ENTRY_ABS_TOL = 1e-4;
function pairKey3(pair) {
  return String(pair).replace(/\//g, "_").replace(/-/g, "_").toUpperCase();
}
function obsKey(id) {
  return OBS_PREFIX + id;
}
function pendingKey(id) {
  return PENDING_PREFIX + id;
}
function idxKey(pair) {
  return IDX_PREFIX + pairKey3(pair);
}
function entriesClose2(a, b) {
  if (a === null || a === void 0 || b === null || b === void 0) return false;
  if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOL || diff / scale <= DEDUP_ENTRY_REL_TOL;
}
var __accounting = {
  admitted: 0,
  dedupRejected: 0,
  capRejected: 0,
  admissionReads: 0,
  admissionWrites: 0,
  resolutionLists: 0,
  resolutionReads: 0,
  resolutionWrites: 0,
  resolutionDeletes: 0,
  retryWrites: 0,
  terminalUnknownWrites: 0
};
async function admitD2ShadowObservation(input, env) {
  if (!env || !env.SIGNAL_CACHE) return { admitted: false, reason: "NO_KV" };
  if (!input || !input.id || !input.pair || !input.direction || !input.expiryTime) {
    return { admitted: false, reason: "INVALID_INPUT" };
  }
  try {
    const idxK = idxKey(input.pair);
    let idx = [];
    try {
      idx = await env.SIGNAL_CACHE.get(idxK, "json");
    } catch (e) {
      idx = [];
    }
    if (!Array.isArray(idx)) idx = [];
    __accounting.admissionReads++;
    const now = Date.now();
    const window30d = now - RETENTION_TTL_S * 1e3;
    idx = idx.filter((e) => e && typeof e.admittedAt === "number" && e.admittedAt >= window30d);
    const dedupCutoff = now - DEDUP_WINDOW_MS2;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose2(e.entryPrice, input.entryPrice)) {
        __accounting.dedupRejected++;
        return { admitted: false, reason: "DEDUP", reads: 1, writes: 0 };
      }
    }
    if (idx.length >= MAX_PER_PAIR_30D) {
      __accounting.capRejected++;
      return { admitted: false, reason: "CAP", reads: 1, writes: 0 };
    }
    const record = {
      id: input.id,
      pair: input.pair,
      assetType: input.assetType || null,
      direction: input.direction,
      entryPrice: input.entryPrice ?? null,
      expiryTime: input.expiryTime,
      bestTF: input.bestTF || null,
      shadowConfidence: input.shadowConfidence ?? null,
      attribution: input.attribution || "D2_BLOCKED",
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null,
      exitPrice: null,
      resolvedAt: null,
      checks: 0
    };
    await env.SIGNAL_CACHE.put(
      obsKey(input.id),
      JSON.stringify(record),
      { expirationTtl: RETENTION_TTL_S }
    );
    await env.SIGNAL_CACHE.put(
      pendingKey(input.id),
      JSON.stringify(record),
      { expirationTtl: PENDING_TTL_S }
    );
    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxK, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S });
    __accounting.admitted++;
    __accounting.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn("D2 admitD2ShadowObservation error (fail-open): " + e.message);
    return { admitted: false, reason: "ERROR", error: e.message };
  }
}
async function resolveD2ShadowObservations(env, fetchPrice = fetchExpiryPrice) {
  if (!env || !env.SIGNAL_CACHE) return { resolved: 0 };
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: PENDING_PREFIX });
    __accounting.resolutionLists++;
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return { resolved: 0 };
    const now = Date.now();
    let resolved = 0;
    let checked = 0;
    for (const kvEntry of pendingList.keys) {
      if (checked >= RESOLVER_CAP) break;
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, "json");
        __accounting.resolutionReads++;
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
          });
          __accounting.resolutionDeletes++;
          checked++;
          continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + RESULT_CHECK_DELAY_S * 1e3;
        if (now < checkAfterMs) {
          checked++;
          continue;
        }
        const fetchResult = await fetchPrice(record.pair, record.expiryTime, env);
        if (fetchResult && fetchResult.error) {
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = (/* @__PURE__ */ new Date()).toISOString();
          if (record.checks >= PENDING_MAX_CHECKS) {
            record.result = "UNKNOWN";
            record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
            await env.SIGNAL_CACHE.put(
              obsKey(record.id),
              JSON.stringify(record),
              { expirationTtl: RETENTION_TTL_S }
            );
            __accounting.terminalUnknownWrites++;
            await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
            });
            __accounting.resolutionDeletes++;
          } else {
            const remainingMs = new Date(record.expiryTime).getTime() + PENDING_TTL_S * 1e3 - now;
            if (remainingMs > 6e4) {
              await env.SIGNAL_CACHE.put(
                kvEntry.name,
                JSON.stringify(record),
                { expirationTtl: Math.floor(remainingMs / 1e3) }
              );
              __accounting.retryWrites++;
            } else {
              record.result = "UNKNOWN";
              record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
              await env.SIGNAL_CACHE.put(
                obsKey(record.id),
                JSON.stringify(record),
                { expirationTtl: RETENTION_TTL_S }
              );
              __accounting.terminalUnknownWrites++;
              await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
              });
              __accounting.resolutionDeletes++;
            }
          }
          checked++;
          continue;
        }
        const exitPrice = fetchResult ? fetchResult.price : null;
        const winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);
        if (record.entryPrice != null && fetchResult) {
          const wl = fetchResult.windowLow, wh = fetchResult.windowHigh;
          if (wl != null && wh != null) {
            if (record.direction === "BUY") record.entryHit = wl <= record.entryPrice + 1e-12;
            else if (record.direction === "SELL") record.entryHit = wh >= record.entryPrice - 1e-12;
            record.entryHitWindowLow = wl;
            record.entryHitWindowHigh = wh;
          }
        }
        record.result = winLoss;
        record.exitPrice = exitPrice;
        record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
        await env.SIGNAL_CACHE.put(
          obsKey(record.id),
          JSON.stringify(record),
          { expirationTtl: RETENTION_TTL_S }
        );
        __accounting.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
        });
        __accounting.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        console.warn("D2 shadow resolve error for " + kvEntry.name + ": " + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log("D2 shadow resolver: resolved " + resolved + " observations");
    return { resolved };
  } catch (e) {
    console.warn("D2 resolveD2ShadowObservations error: " + e.message);
    return { resolved: 0, error: e.message };
  }
}

// src/signal/d2shadow.js
var D2_AUDIT = /* @__PURE__ */ Symbol("d2.audit");
function attachD2Audit(signal, audit) {
  if (!signal || typeof signal !== "object") return;
  Object.defineProperty(signal, D2_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}
function getD2Audit(signal) {
  if (!signal || typeof signal !== "object") return null;
  const v = signal[D2_AUDIT];
  return v && typeof v === "object" ? v : null;
}
async function maybeAdmitD2ShadowObservation(signal, pair, assetType, env) {
  try {
    const audit = getD2Audit(signal);
    if (!audit) return null;
    const finalDir = signal ? signal.finalSignal : null;
    if (finalDir !== "NO_TRADE") return null;
    if (audit.wouldBeDirection !== "BUY" && audit.wouldBeDirection !== "SELL") return null;
    if (!audit.expiryTime || !audit.entryPrice) return null;
    const obsId = "d2_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    return await admitD2ShadowObservation({
      id: obsId,
      pair,
      assetType,
      direction: audit.wouldBeDirection,
      entryPrice: audit.entryPrice,
      expiryTime: audit.expiryTime,
      bestTF: audit.bestTF,
      shadowConfidence: audit.wouldBeConfidence,
      attribution: audit.attribution,
      auditSummary: {
        marketRegime: audit.marketRegime,
        sessionQuality: audit.sessionQuality,
        wouldBeConfidence: audit.wouldBeConfidence,
        filtersApplied: audit.filtersApplied
      }
    }, env);
  } catch (e) {
    console.warn("D2 shadow admission error (fail-open): " + e.message);
    return null;
  }
}

// src/history/probeStore.js
var OBS_PREFIX2 = "probe:obs:";
var PENDING_PREFIX2 = "probe:pending:";
var IDX_PREFIX2 = "probe:idx:";
var MAX_PER_PAIR_30D2 = 50;
var RETENTION_TTL_S2 = 30 * 24 * 3600;
var PENDING_TTL_S2 = Math.floor(2 * 60 * 60);
var PENDING_MAX_CHECKS2 = 15;
var RESOLVER_CAP2 = 10;
var RESULT_CHECK_DELAY_S2 = 90;
var DEDUP_WINDOW_MS3 = 2 * 60 * 60 * 1e3;
var DEDUP_ENTRY_REL_TOL2 = 5e-4;
var DEDUP_ENTRY_ABS_TOL2 = 1e-4;
function pairKey4(pair) {
  return String(pair).replace(/\//g, "_").replace(/-/g, "_").toUpperCase();
}
function obsKey2(id) {
  return OBS_PREFIX2 + id;
}
function pendingKey2(id) {
  return PENDING_PREFIX2 + id;
}
function idxKey2(pair) {
  return IDX_PREFIX2 + pairKey4(pair);
}
function entriesClose3(a, b) {
  if (a === null || a === void 0 || b === null || b === void 0) return false;
  if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOL2 || diff / scale <= DEDUP_ENTRY_REL_TOL2;
}
var __accounting2 = {
  admitted: 0,
  dedupRejected: 0,
  capRejected: 0,
  admissionReads: 0,
  admissionWrites: 0,
  resolutionLists: 0,
  resolutionReads: 0,
  resolutionWrites: 0,
  resolutionDeletes: 0,
  retryWrites: 0,
  terminalUnknownWrites: 0
};
async function admitProbeObservation(input, env) {
  if (!env || !env.SIGNAL_CACHE) return { admitted: false, reason: "NO_KV" };
  if (!input || !input.id || !input.pair || !input.direction || !input.expiryTime) {
    return { admitted: false, reason: "INVALID_INPUT" };
  }
  try {
    const idxK = idxKey2(input.pair);
    let idx = [];
    try {
      idx = await env.SIGNAL_CACHE.get(idxK, "json");
    } catch (e) {
      idx = [];
    }
    if (!Array.isArray(idx)) idx = [];
    __accounting2.admissionReads++;
    const now = Date.now();
    const window30d = now - RETENTION_TTL_S2 * 1e3;
    idx = idx.filter((e) => e && typeof e.admittedAt === "number" && e.admittedAt >= window30d);
    const dedupCutoff = now - DEDUP_WINDOW_MS3;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose3(e.entryPrice, input.entryPrice)) {
        __accounting2.dedupRejected++;
        return { admitted: false, reason: "DEDUP", reads: 1, writes: 0 };
      }
    }
    if (idx.length >= MAX_PER_PAIR_30D2) {
      __accounting2.capRejected++;
      return { admitted: false, reason: "CAP", reads: 1, writes: 0 };
    }
    const record = {
      id: input.id,
      pair: input.pair,
      assetType: input.assetType || null,
      direction: input.direction,
      entryPrice: input.entryPrice ?? null,
      expiryTime: input.expiryTime,
      bestTF: input.bestTF || null,
      shadowConfidence: input.shadowConfidence ?? null,
      attribution: "FOREX_SELL_PROBE",
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null,
      flippedResult: null,
      exitPrice: null,
      resolvedAt: null,
      checks: 0
    };
    await env.SIGNAL_CACHE.put(obsKey2(input.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S2 });
    await env.SIGNAL_CACHE.put(pendingKey2(input.id), JSON.stringify(record), { expirationTtl: PENDING_TTL_S2 });
    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxK, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S2 });
    __accounting2.admitted++;
    __accounting2.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn("probe admit error (fail-open): " + e.message);
    return { admitted: false, reason: "ERROR", error: e.message };
  }
}
async function resolveProbeObservations(env, fetchPrice = fetchExpiryPrice) {
  if (!env || !env.SIGNAL_CACHE) return { resolved: 0 };
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: PENDING_PREFIX2 });
    __accounting2.resolutionLists++;
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return { resolved: 0 };
    const now = Date.now();
    let resolved = 0;
    let checked = 0;
    for (const kvEntry of pendingList.keys) {
      if (checked >= RESOLVER_CAP2) break;
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, "json");
        __accounting2.resolutionReads++;
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
          });
          __accounting2.resolutionDeletes++;
          checked++;
          continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + RESULT_CHECK_DELAY_S2 * 1e3;
        if (now < checkAfterMs) {
          checked++;
          continue;
        }
        const fetchResult = await fetchPrice(record.pair, record.expiryTime, env);
        if (fetchResult && fetchResult.error) {
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = (/* @__PURE__ */ new Date()).toISOString();
          if (record.checks >= PENDING_MAX_CHECKS2) {
            record.result = "UNKNOWN";
            record.flippedResult = "UNKNOWN";
            record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
            await env.SIGNAL_CACHE.put(obsKey2(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S2 });
            __accounting2.terminalUnknownWrites++;
            await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
            });
            __accounting2.resolutionDeletes++;
          } else {
            const remainingMs = new Date(record.expiryTime).getTime() + PENDING_TTL_S2 * 1e3 - now;
            if (remainingMs > 6e4) {
              await env.SIGNAL_CACHE.put(kvEntry.name, JSON.stringify(record), { expirationTtl: Math.floor(remainingMs / 1e3) });
              __accounting2.retryWrites++;
            } else {
              record.result = "UNKNOWN";
              record.flippedResult = "UNKNOWN";
              record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
              await env.SIGNAL_CACHE.put(obsKey2(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S2 });
              __accounting2.terminalUnknownWrites++;
              await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
              });
              __accounting2.resolutionDeletes++;
            }
          }
          checked++;
          continue;
        }
        const exitPrice = fetchResult ? fetchResult.price : null;
        const winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);
        if (record.entryPrice != null && fetchResult) {
          const wl = fetchResult.windowLow, wh = fetchResult.windowHigh;
          if (wl != null && wh != null) {
            if (record.direction === "BUY") record.entryHit = wl <= record.entryPrice + 1e-12;
            else if (record.direction === "SELL") record.entryHit = wh >= record.entryPrice - 1e-12;
            record.entryHitWindowLow = wl;
            record.entryHitWindowHigh = wh;
          }
        }
        let flipped = "UNKNOWN";
        if (winLoss === "WIN") flipped = "LOSS";
        else if (winLoss === "LOSS") flipped = "WIN";
        record.result = winLoss;
        record.flippedResult = flipped;
        record.exitPrice = exitPrice;
        record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
        await env.SIGNAL_CACHE.put(obsKey2(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S2 });
        __accounting2.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
        });
        __accounting2.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        console.warn("probe resolve error for " + kvEntry.name + ": " + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log("probe resolver: resolved " + resolved + " observations");
    return { resolved };
  } catch (e) {
    console.warn("probe resolve error: " + e.message);
    return { resolved: 0, error: e.message };
  }
}

// src/signal/probeShadow.js
var PROBE_AUDIT = /* @__PURE__ */ Symbol("probe.audit");
function attachProbeAudit(signal, audit) {
  if (!signal || typeof signal !== "object") return;
  Object.defineProperty(signal, PROBE_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}
function getProbeAudit(signal) {
  if (!signal || typeof signal !== "object") return null;
  const v = signal[PROBE_AUDIT];
  return v && typeof v === "object" ? v : null;
}
async function maybeAdmitForexSellProbe(signal, pair, assetType, env) {
  try {
    if (assetType !== "FOREX") return null;
    const audit = getProbeAudit(signal);
    if (!audit) return null;
    if (!signal || signal.finalSignal !== "SELL") return null;
    if (!audit.expiryTime || !audit.entryPrice) return null;
    const obsId = "probe_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    return await admitProbeObservation({
      id: obsId,
      pair,
      assetType,
      direction: "SELL",
      entryPrice: audit.entryPrice,
      expiryTime: audit.expiryTime,
      bestTF: audit.bestTF,
      shadowConfidence: audit.confidence,
      auditSummary: {
        regime: audit.regime,
        sessionQuality: audit.sessionQuality,
        higherTFTrend: audit.higherTFTrend,
        alignment: audit.alignment,
        rsi: audit.rsi
      }
    }, env);
  } catch (e) {
    console.warn("probe admission error (fail-open): " + e.message);
    return null;
  }
}

// src/signal/engine.js
async function buildMultiTimeframeSignal(pair, candleData, assetType, env, opts = {}) {
  const fxMode = !!opts.fxMode;
  const now = opts && opts.now ? new Date(opts.now) : /* @__PURE__ */ new Date();
  const session = opts && opts.session || detectTradingSession();
  const exotic = isExoticPair(pair);
  const newsBlock = opts && Object.prototype.hasOwnProperty.call(opts, "newsBlock") ? opts.newsBlock : checkNewsBlackout(assetType);
  const newsBlocked = !!(newsBlock && newsBlock.blocked);
  const indicatorCache = {};
  for (const tf of Object.keys(candleData)) {
    if (candleData[tf] && candleData[tf].length > 0) {
      indicatorCache[tf] = calculateAllIndicators(candleData[tf], tf);
    }
  }
  let higherTFTrend = null;
  if (indicatorCache["15min"]) {
    const htfInd = indicatorCache["15min"];
    const htfEma5 = safeLastValue(htfInd.ema5);
    const htfEma13 = safeLastValue(htfInd.ema13);
    const htfEma55 = safeLastValue(htfInd.ema55);
    const htfAdx = htfInd.adx ? safeLastValue(htfInd.adx.adx) : null;
    const htfPDI = htfInd.adx ? safeLastValue(htfInd.adx.plusDI) : null;
    const htfMDI = htfInd.adx ? safeLastValue(htfInd.adx.minusDI) : null;
    if (htfEma5 !== null && htfEma55 !== null && htfAdx !== null && htfAdx >= 25) {
      if (htfEma5 > htfEma55 && htfPDI !== null && htfMDI !== null && htfPDI > htfMDI) higherTFTrend = "BUY";
      else if (htfEma5 < htfEma55 && htfPDI !== null && htfMDI !== null && htfMDI > htfPDI) higherTFTrend = "SELL";
    }
    if (higherTFTrend === null && htfEma5 !== null && htfEma13 !== null && htfEma55 !== null) {
      if (htfEma5 > htfEma13 && htfEma13 > htfEma55) higherTFTrend = "BUY";
      else if (htfEma5 < htfEma13 && htfEma13 < htfEma55) higherTFTrend = "SELL";
    }
  }
  let marketRegime = "RANGING";
  const regimeTF = indicatorCache["15min"] || indicatorCache["5min"] || indicatorCache["1min"];
  const regimeCandles = candleData["15min"] || candleData["5min"] || candleData["1min"];
  if (regimeTF && regimeCandles) {
    const rAdx = safeLastValue(regimeTF.adx.adx);
    const rBbArr = regimeTF.bollinger.bandwidth;
    const bwVals = [];
    if (rBbArr) {
      for (let bi = rBbArr.length - 1; bi >= 0 && bwVals.length < 2; bi--) {
        if (rBbArr[bi] !== null && !isNaN(rBbArr[bi])) bwVals.push(rBbArr[bi]);
      }
    }
    const rBbBW = bwVals[0] || null;
    const rBbBWPrev = bwVals[1] || null;
    const rAtr = safeLastValue(regimeTF.atr);
    const rLC = regimeCandles[regimeCandles.length - 1].close;
    marketRegime = detectMarketRegime(rAdx, rBbBW, rAtr, rLC, assetType, rBbBWPrev);
  }
  const tfResults = {};
  const votes = [];
  for (const tf of Object.keys(candleData)) {
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = indicatorCache[tf];
    if (!indicators) continue;
    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend, marketRegime);
    const durCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType);
    const candleMin = CANDLE_MINUTES[tf] || 1;
    const durMinutes = durCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durMinutes * 6e4);
    const nextClose = getNextCandleClose(now, candleMin);
    const countdown = getCandleCountdown(candleMin);
    analysis.expiry = {
      candles: durCandles,
      candleSize: candleMin + "min",
      totalMinutes: durMinutes,
      expiryTime: expiryTime.toISOString(),
      humanReadable: formatDuration(durMinutes),
      nextCandleClose: nextClose.toISOString(),
      countdown
    };
    analysis.entry = {
      price: candles[candles.length - 1].close,
      candleTime: candles[candles.length - 1].datetime,
      candleDirection: candles[candles.length - 1].close >= candles[candles.length - 1].open ? "BULLISH" : "BEARISH"
    };
    analysis.higherTFTrend = higherTFTrend;
    analysis.alignedWithHTF = higherTFTrend === null || analysis.direction === "NO_TRADE" || analysis.direction === higherTFTrend;
    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf, alignedWithHTF: analysis.alignedWithHTF });
  }
  const sessionMult = getSessionWeightMultiplier(pair, session, assetType);
  let qualityCandles = [];
  if (candleData["1min"] && tfResults["1min"] && !tfResults["1min"].deadMarket) qualityCandles = candleData["1min"];
  else if (candleData["5min"] && tfResults["5min"] && !tfResults["5min"].deadMarket) qualityCandles = candleData["5min"];
  else if (candleData["15min"] && tfResults["15min"] && !tfResults["15min"].deadMarket) qualityCandles = candleData["15min"];
  else qualityCandles = candleData["1min"] || candleData["5min"] || candleData["15min"] || [];
  const candleQualityMult = getCandleQualityMultiplier(qualityCandles);
  const det = await runDeterministicVoteAndFilters({
    votes,
    candleData,
    tfResults,
    higherTFTrend,
    marketRegime,
    session,
    sessionMult,
    candleQualityMult,
    exotic,
    assetType,
    newsBlock,
    newsBlocked,
    pair,
    env
  });
  let finalDirection = det.finalDirection;
  let confidence = det.confidence;
  const rawDirection = det.rawDirection;
  const rawConfidence = det.rawConfidence;
  let belowFloor = det.belowFloor;
  const filtersApplied = det.filtersApplied;
  const alignment = det.alignment;
  const marketCondition = det.marketCondition;
  const marketContext = det.marketContext;
  const isDeadMarket = det.isDeadMarket;
  const weightedBuy = det.weightedBuy;
  const weightedSell = det.weightedSell;
  const weightedNoTrade = det.weightedNoTrade;
  let d2Audit = null;
  if (finalDirection !== "NO_TRADE") {
    const d2PreDir = finalDirection;
    const d2PreConf = confidence;
    if (marketRegime === "TRENDING") {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("D2_TRENDING_BLOCK (29.5% WR n=356)");
      d2Audit = { attribution: "D2_TRENDING_BLOCKED" };
    } else if (CONFIG.D2_RANGING_ALIGNED_BLOCK_ENABLED && marketRegime === "RANGING" && buildStructureVerdict(tfResults, finalDirection).overall === "ALIGNED") {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("D2_RANGING_ALIGNED_BLOCK (41.2% WR n=1639)");
      d2Audit = { attribution: "D2_RANGING_ALIGNED_BLOCKED" };
    } else if (CONFIG.D2_BAD_PAIR_BLOCK_ENABLED && ["USD/JPY", "AUD/USD", "DOT/USD"].includes(pair)) {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("D2_BAD_PAIR_BLOCK (" + pair + " <20% WR)");
      d2Audit = { attribution: "D2_BAD_PAIR_BLOCKED" };
    } else if (assetType === ASSET_TYPE.FOREX && session.quality === "HIGHEST") {
      finalDirection = "NO_TRADE";
      confidence = 0;
      filtersApplied.push("D2_HIGHEST_SESSION_BLOCK (6.1% WR n=66)");
      d2Audit = { attribution: "D2_HIGHEST_SESSION_BLOCKED" };
    }
    if (d2Audit) {
      try {
        const best2 = findBestTimeframe(tfResults, d2PreDir);
        const bestTFAnalysis2 = best2 && best2.timeframe && best2.timeframe !== "N/A" ? tfResults[best2.timeframe] : null;
        d2Audit = {
          ...d2Audit,
          wouldBeDirection: d2PreDir,
          wouldBeConfidence: d2PreConf,
          bestTF: bestTFAnalysis2 ? best2.timeframe : null,
          entryPrice: bestTFAnalysis2 && bestTFAnalysis2.entry ? bestTFAnalysis2.entry.price : null,
          expiryTime: best2 && best2.expiry ? best2.expiry.expiryTime : null,
          marketRegime,
          sessionQuality: session ? session.quality : null,
          filtersApplied: filtersApplied.slice(),
          pair
        };
      } catch (e) {
        console.warn("D2 shadow capture failed (fail-open): " + e.message);
        d2Audit = null;
      }
    }
  }
  const aiTargetDir = d2Audit ? null : finalDirection !== "NO_TRADE" ? finalDirection : rawDirection !== "NO_TRADE" && rawConfidence >= 60 ? rawDirection : null;
  let aiValidation = { status: "SKIPPED" };
  let aiAgreed = null;
  if (d2Audit && aiTargetDir === null) {
    filtersApplied.push("AI_SKIPPED (D2 hard block)");
  }
  if (aiTargetDir) {
    const aiUseConf = finalDirection !== "NO_TRADE" ? confidence : rawConfidence;
    const bestSnap = findBestTimeframe(tfResults, aiTargetDir);
    const snapshot = buildIndicatorSnapshot(tfResults, candleData, aiTargetDir, bestSnap.timeframe);
    const engineSig = {
      direction: aiTargetDir,
      confidence: aiUseConf + "%",
      alignment,
      higherTFTrend: higherTFTrend || "NEUTRAL",
      marketCondition,
      bestTF: bestSnap.timeframe
    };
    const [cerebrasResult, groqResult] = await Promise.all([
      callCerebrasValidation(pair, assetType, engineSig, snapshot, env),
      callGroqValidation(pair, assetType, engineSig, snapshot, env)
    ]);
    const dualResult = combineDualAIResults(cerebrasResult, groqResult, aiTargetDir);
    aiValidation = dualResult;
    const combinedAI = dualResult.combined;
    if (combinedAI && combinedAI.status === "OK") {
      aiAgreed = combinedAI.signal === aiTargetDir;
      aiValidation.agrees = aiAgreed;
      if (finalDirection === "NO_TRADE" && aiTargetDir !== "NO_TRADE") {
        if (aiAgreed && (combinedAI.confidence || 0) >= 70 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(92, Math.round((rawConfidence + (combinedAI.confidence || 0)) / 2));
          belowFloor = false;
          filtersApplied.push("AI_RESCUE: " + aiTargetDir + " raw=" + rawConfidence + "% AI=" + (combinedAI.confidence || 0) + "% \u2192 " + confidence + "%");
        } else if (aiAgreed && (combinedAI.confidence || 0) >= 60 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(85, rawConfidence + 5);
          belowFloor = false;
          filtersApplied.push("AI_SOFT_RESCUE: " + aiTargetDir + " @ " + confidence + "%");
        } else {
          filtersApplied.push("AI_RESCUE_FAILED: conf=" + (combinedAI.confidence || 0) + "% concerns=" + (combinedAI.concerns || "none"));
        }
      } else if (finalDirection !== "NO_TRADE") {
        if (aiAgreed) {
          if (!combinedAI.concerns) {
            const boost = combinedAI.agreement === "BOTH_AGREE" ? 8 : 5;
            confidence = Math.min(92, confidence + boost);
            filtersApplied.push("DUAL_AI_BOOST: " + (combinedAI.agreement || "AGREE") + " +" + boost);
          } else {
            confidence = Math.max(0, confidence - 5);
            filtersApplied.push("DUAL_AI_AGREE_WITH_CONCERNS: " + combinedAI.concerns);
          }
        } else {
          finalDirection = "NO_TRADE";
          confidence = 0;
          filtersApplied.push("DUAL_AI_DISAGREE_BLOCK (AI=" + combinedAI.signal + ")");
        }
      }
    }
  }
  let edgeAudit = null;
  let activeCalib = null;
  if (CONFIG.EDGE_FEATURES.enabled && opts.edgeFeatures !== false) {
    try {
      activeCalib = await loadCalibration(env);
      const edgeRes = await applyEdgeFeatures({
        finalDirection,
        confidence,
        pair,
        assetType,
        now,
        candleData,
        tfResults,
        indicators: indicatorCache,
        env,
        calib: activeCalib
      });
      finalDirection = edgeRes.finalDirection;
      confidence = edgeRes.confidence;
      for (const f of edgeRes.filtersApplied) filtersApplied.push(f);
      edgeAudit = edgeRes.audit;
      if (edgeAudit && edgeAudit.blockedBy) {
        filtersApplied.push("EDGE_BLOCK (" + edgeAudit.blockedBy + ")");
      }
    } catch (e) {
      console.warn("edge features failed (production unaffected): " + e.message);
      edgeAudit = null;
    }
  }
  if (finalDirection !== "NO_TRADE" && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    finalDirection = "NO_TRADE";
    confidence = 0;
    filtersApplied.push(edgeAudit ? "BELOW_FLOOR_AFTER_EDGE_FEATURES (" + CONFIG.MIN_CONFIDENCE_FLOOR + "%)" : "BELOW_FLOOR_AFTER_AI (" + CONFIG.MIN_CONFIDENCE_FLOOR + "%)");
  }
  const best = findBestTimeframe(tfResults, finalDirection);
  const avgConf = votes.reduce((s, v) => s + (v.confluence || 0), 0) / Math.max(votes.length, 1);
  const recommendations = {};
  for (const [rtf, rec] of Object.entries(tfResults)) {
    recommendations[rtf] = {
      direction: rec.direction,
      score: rec.score,
      confluence: rec.confluence + "/12 categories",
      alignedWithHTF: rec.alignedWithHTF,
      expiry: rec.expiry,
      entry: rec.entry,
      candleConfirmed: rec.candleConfirmed,
      patterns: rec.categoryScores?.patterns?.detected || [],
      divergence: { rsi: rec.categoryScores?.divergence?.rsi || "NONE", macd: rec.categoryScores?.divergence?.macd || "NONE" },
      diCrossover: rec.categoryScores?.adx?.diCross || "NONE"
    };
  }
  const bestTFAnalysis = tfResults[best.timeframe] || null;
  const entryReason = generateEntryReason(finalDirection, bestTFAnalysis?.categoryScores || {}, bestTFAnalysis?.indicators || {}, alignment, higherTFTrend, marketContext);
  if (sessionMult !== 1) filtersApplied.push("SESSION_WEIGHT x" + sessionMult.toFixed(2));
  if (candleQualityMult !== 1) filtersApplied.push("CANDLE_QUALITY x" + candleQualityMult.toFixed(2));
  if (isDeadMarket && finalDirection !== "NO_TRADE") filtersApplied.push("DEAD_MARKET_WARN (AI rescued)");
  const structureVerdict = buildStructureVerdict(tfResults, finalDirection);
  let calibratedConfForReport = confidence;
  let calibratedScoreForTrace = null;
  if (finalDirection !== "NO_TRADE") {
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall, marketRegime, activeCalib);
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }
  let finalGrade;
  if (finalDirection === "NO_TRADE") {
    finalGrade = { grade: "N/A", label: "NO_TRADE", description: "Engine blocked \u2014 no trade." };
  } else {
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall, marketRegime, activeCalib);
    finalGrade = cal.grade;
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }
  const reportConfidence = finalDirection === "NO_TRADE" ? 0 : calibratedConfForReport;
  const __signal = {
    finalSignal: finalDirection,
    confidence: reportConfidence + "%",
    grade: finalGrade,
    // B5: pre-filter engine confidence (captured at line ~164, before HTF block,
    // alignment bonus, session/exotic penalties, AI rescue etc). Lets us later
    // separate "engine was weak" from "filters ate it".
    coreConfidence: rawConfidence,
    // Calibration trace (Phase F fix)
    calibration: finalDirection === "NO_TRADE" ? null : {
      rawConfidence: confidence,
      calibratedConfidence: calibratedConfForReport,
      calibratedScore: calibratedScoreForTrace,
      version: "calib-v1-2026-08-09"
    },
    assetType,
    marketRegime,
    regimeAdvice: getRegimeAdvice(marketRegime, finalDirection),
    marketCondition,
    alignment,
    higherTFTrend: higherTFTrend || "NEUTRAL",
    entryReason,
    filtersApplied,
    newsBlackout: newsBlock || null,
    aiValidation,
    // Edge-feature audit (Phase F round 2): hour/session-range/RSI/BB/ATR/
    // recent-form values + multipliers applied to the ENGINE confidence before
    // calibration. Null when the block is disabled or no signal was emitted.
    edgeFeatures: edgeAudit,
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ["24/7"], quality: "N/A" },
    recommendations,
    bestTimeframe: best,
    votes: {
      BUY: votes.filter((v) => v.direction === "BUY").length,
      SELL: votes.filter((v) => v.direction === "SELL").length,
      NO_TRADE: votes.filter((v) => v.direction === "NO_TRADE").length,
      total: votes.length,
      weightedBuy: r2(weightedBuy),
      weightedSell: r2(weightedSell),
      weightedNoTrade: r2(weightedNoTrade)
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    // Structure summary across all TFs
    structureSummary: Object.fromEntries(
      Object.entries(tfResults).filter(([, r]) => r.structure).map(([tf, r]) => [tf, {
        bias: r.structure.bias,
        bos: r.structure.bos ? r.structure.bos.type : "NONE",
        choch: r.structure.choch ? r.structure.choch.type : "NONE",
        sweep: r.structure.sweep ? r.structure.sweep.type : "NONE",
        applied: r.structureApplied || "NONE",
        multiplier: r.structure.multiplier ? r.structure.multiplier.value : 1
      }])
    ),
    // Quick verdict: does market structure support the final signal? Use this
    // to decide whether to take the trade when structure disagrees.
    structureVerdict,
    sessionWeight: sessionMult,
    candleQuality: candleQualityMult,
    method: "WEIGHTED_MULTI_TF_v6.9.2_EMA5-13-55+STRUCTURE",
    generatedAt: now.toISOString()
  };
  try {
    const r71Audit = await computeEngineAudit({
      tfResults,
      candleData,
      assetType,
      pair,
      higherTFTrend,
      marketRegime,
      session,
      sessionMult,
      candleQualityMult,
      exotic,
      newsBlock,
      newsBlocked,
      env,
      productionPreAi: { finalDirection: det.finalDirection, confidence: det.confidence },
      productionPostAi: { finalDirection, confidence }
    });
    attachEngineAudit(__signal, r71Audit);
  } catch (e) {
    console.warn("R7.1 shadow audit failed (production unaffected): " + e.message);
  }
  if (d2Audit) {
    try {
      attachD2Audit(__signal, d2Audit);
    } catch (e) {
      console.warn("D2 shadow attach failed (production unaffected): " + e.message);
    }
  }
  if (fxMode && (finalDirection === "BUY" || finalDirection === "SELL")) {
    try {
      const atrTF = tfResults["15min"] || tfResults["5min"] || tfResults["1min"];
      const atrArr = atrTF && atrTF.indicators ? atrTF.indicators.atr : null;
      let atr = null;
      if (typeof atrArr === "number") atr = atrArr;
      else if (typeof atrArr === "string") atr = parseFloat(atrArr);
      else if (Array.isArray(atrArr)) {
        const v = atrArr[atrArr.length - 1];
        atr = typeof v === "number" ? v : parseFloat(v);
      }
      if (atr !== null && isNaN(atr)) atr = null;
      const best2 = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = best2 && best2.timeframe && best2.timeframe !== "N/A" ? tfResults[best2.timeframe] : null;
      const entry = bestTFA && bestTFA.entry ? bestTFA.entry.price : null;
      const levels = computeFxLevels({ entry, atr, direction: finalDirection });
      __signal.mode = "fx";
      __signal.fxLevels = levels;
    } catch (e) {
      console.warn("FX mode attach failed (production unaffected): " + e.message);
      __signal.mode = "fx";
      __signal.fxLevels = null;
    }
  }
  if (finalDirection === "BUY" || finalDirection === "SELL") {
    try {
      const best2 = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = best2 && best2.timeframe && best2.timeframe !== "N/A" ? tfResults[best2.timeframe] : null;
      const entryPx = bestTFA && bestTFA.entry ? bestTFA.entry.price : null;
      const currentCandles = candleData["1min"] || candleData["5min"] || candleData["15min"];
      const lastClose = currentCandles && currentCandles.length ? currentCandles[currentCandles.length - 1].close : null;
      if (entryPx != null && lastClose != null) {
        const dist = Math.abs(lastClose - entryPx);
        const rel = entryPx !== 0 ? dist / entryPx : 0;
        const actionable = rel <= 5e-4;
        __signal.fillStatus = actionable ? "INSTANT" : "PENDING_ENTRY";
        __signal.entryPrice = entryPx;
        __signal.currentPrice = lastClose;
        __signal.entryDistancePct = Number((rel * 100).toFixed(4));
      }
    } catch (e) {
      console.warn("fill status failed (production unaffected): " + e.message);
    }
  }
  if (CONFIG.FOREX_SELL_PROBE_ENABLED && assetType === ASSET_TYPE.FOREX && finalDirection === "SELL") {
    try {
      const best2 = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = best2 && best2.timeframe && best2.timeframe !== "N/A" ? tfResults[best2.timeframe] : null;
      const rsiArr = bestTFA && bestTFA.indicators ? bestTFA.indicators.rsi : null;
      let rsi = null;
      if (typeof rsiArr === "number") rsi = rsiArr;
      else if (typeof rsiArr === "string") rsi = parseFloat(rsiArr);
      else if (Array.isArray(rsiArr)) {
        const v = rsiArr[rsiArr.length - 1];
        rsi = typeof v === "number" ? v : parseFloat(v);
      }
      if (rsi === null || isNaN(rsi)) rsi = null;
      attachProbeAudit(__signal, {
        attribution: "FOREX_SELL_PROBE",
        direction: "SELL",
        confidence,
        bestTF: bestTFA ? best2.timeframe : null,
        entryPrice: bestTFA && bestTFA.entry ? bestTFA.entry.price : null,
        expiryTime: best2 && best2.expiry ? best2.expiry.expiryTime : null,
        regime: marketRegime,
        sessionQuality: session ? session.quality : null,
        higherTFTrend,
        alignment: det.alignment,
        rsi: rsi !== null && isFinite(rsi) ? Math.round(rsi * 100) / 100 : null
      });
    } catch (e) {
      console.warn("probe attach failed (production unaffected): " + e.message);
    }
  }
  return __signal;
}
function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null;
  let bestScore = -1;
  let bestConf = -1;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (r.direction === finalDirection || finalDirection === "NO_TRADE") {
      const score = r.direction === "BUY" ? r.score.up : r.direction === "SELL" ? r.score.down : 0;
      const ec = r.confluence + (r.alignedWithHTF ? 1 : 0);
      if (ec > bestConf || ec === bestConf && score > bestScore) {
        bestTF = tf;
        bestScore = score;
        bestConf = ec;
      }
    }
  }
  if (!bestTF) {
    for (const [tf, r] of Object.entries(tfResults)) {
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) {
        bestTF = tf;
        bestScore = score;
        bestConf = r.confluence;
      }
    }
  }
  if (!bestTF) return { timeframe: "N/A", reason: "No analyzable timeframe" };
  const best = tfResults[bestTF];
  return {
    timeframe: bestTF,
    direction: best.direction,
    score: bestScore,
    confluence: best.confluence,
    alignedWithHTF: best.alignedWithHTF,
    expiry: best.expiry,
    reason: "Strongest " + best.direction + " signal with " + best.confluence + "/12 confluence"
  };
}
function buildStructureVerdict(tfResults, finalDirection) {
  const perTF = {};
  let agree = 0, disagree = 0, neutral = 0;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (!r.structure) continue;
    const dir = r.structure.multiplier ? r.structure.multiplier.direction : null;
    let verdict;
    if (finalDirection === "NO_TRADE" || !dir) {
      verdict = "NEUTRAL";
    } else if (dir === finalDirection) {
      verdict = "AGREE";
    } else {
      verdict = "DISAGREE";
    }
    if (verdict === "AGREE") agree++;
    else if (verdict === "DISAGREE") disagree++;
    else neutral++;
    perTF[tf] = {
      verdict,
      bias: r.structure.bias,
      structureDirection: dir || "NONE",
      multiplier: r.structure.multiplier ? r.structure.multiplier.value : 1,
      detail: r.structure.summary
    };
  }
  let overall;
  if (finalDirection === "NO_TRADE") {
    overall = "N/A";
  } else if (disagree > agree) {
    overall = "AGAINST";
  } else if (agree > 0 && disagree === 0) {
    overall = "ALIGNED";
  } else if (agree > 0 && disagree > 0) {
    overall = "MIXED";
  } else {
    overall = "NEUTRAL";
  }
  let buyVotes = 0, sellVotes = 0, structNeutral = 0;
  let buyMultSum = 0, sellMultSum = 0;
  for (const tf of Object.values(perTF)) {
    if (tf.structureDirection === "BUY") {
      buyVotes++;
      buyMultSum += tf.multiplier;
    } else if (tf.structureDirection === "SELL") {
      sellVotes++;
      sellMultSum += tf.multiplier;
    } else structNeutral++;
  }
  let direction, strength;
  if (buyVotes > sellVotes) {
    direction = "BUY";
    strength = buyMultSum / buyVotes >= 1.15 ? "STRONG" : "WEAK";
  } else if (sellVotes > buyVotes) {
    direction = "SELL";
    strength = sellMultSum / sellVotes >= 1.15 ? "STRONG" : "WEAK";
  } else if (buyVotes > 0 && buyVotes === sellVotes) {
    direction = "MIXED";
    strength = "NEUTRAL";
  } else {
    direction = "NEUTRAL";
    strength = "NEUTRAL";
  }
  return { direction, strength, overall, perTimeframe: perTF };
}

// src/analysis/otc.js
function countConsecutiveCandles(candles) {
  if (!candles || candles.length < 2) return { count: 0, direction: null };
  const last = candles[candles.length - 1];
  const lastBull = last.close >= last.open;
  let count = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    if (candles[i].close >= candles[i].open === lastBull) count++;
    else break;
  }
  return { count, direction: lastBull ? "BUY" : "SELL" };
}
function detectWickRejection(candles) {
  if (!candles || candles.length < 1) return null;
  const c = candles[candles.length - 1];
  const body = Math.abs(c.close - c.open);
  const totalRange = c.high - c.low;
  if (totalRange <= 0 || totalRange < 5e-5) return null;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperRatio = upperWick / totalRange;
  const lowerRatio = lowerWick / totalRange;
  if (upperRatio >= 0.55 && upperWick > body * 2)
    return { type: "UPPER_WICK_REJECTION", direction: "SELL", strength: upperRatio >= 0.7 ? 2 : 1.2, wickRatio: Math.round(upperRatio * 100) / 100 };
  if (lowerRatio >= 0.55 && lowerWick > body * 2)
    return { type: "LOWER_WICK_REJECTION", direction: "BUY", strength: lowerRatio >= 0.7 ? 2 : 1.2, wickRatio: Math.round(lowerRatio * 100) / 100 };
  return null;
}
function detectRoundNumberProximity(lastClose, atr) {
  if (!lastClose || !atr || atr <= 0) return null;
  const levels = [];
  for (const step of [1e-3, 5e-3, 0.01]) {
    const rounded = Math.round(lastClose / step) * step;
    const dist = Math.abs(lastClose - rounded);
    const threshold = atr * 0.3;
    if (dist < threshold) {
      levels.push({
        level: Math.round(rounded * 1e5) / 1e5,
        distance: Math.round(dist * 1e5) / 1e5,
        stepType: step === 0.01 ? "BIG_FIGURE" : step === 5e-3 ? "HALF_FIGURE" : "MINOR",
        proximity: Math.round((1 - dist / threshold) * 100) / 100
      });
    }
  }
  if (levels.length === 0) return null;
  levels.sort((a, b) => b.proximity - a.proximity);
  return levels[0];
}
function detectCandleSizeAnomaly(candles) {
  if (!candles || candles.length < 10) return null;
  const last = candles[candles.length - 1];
  const sample = candles.slice(-11, -1);
  const avgBody = sample.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / sample.length;
  if (avgBody <= 0) return null;
  const lastBody = Math.abs(last.close - last.open);
  const ratio = lastBody / avgBody;
  if (ratio >= 2.5)
    return { anomaly: true, bodyRatio: Math.round(ratio * 100) / 100, likelyDirection: last.close > last.open ? "SELL" : "BUY", strength: ratio >= 4 ? "STRONG" : "MODERATE" };
  return null;
}
function getOTCTimeContext(now = /* @__PURE__ */ new Date()) {
  const minute = now.getUTCMinutes();
  if (minute <= 2 || minute >= 57) return { quality: "AVOID", reason: "Hour boundary \u2014 spike risk", penaltyPct: 12 };
  if (minute >= 28 && minute <= 32) return { quality: "MODERATE", reason: "Half-hour mark", penaltyPct: 0 };
  if (minute >= 10 && minute <= 25 || minute >= 35 && minute <= 55)
    return { quality: "GOOD", reason: "Stable OTC window", penaltyPct: -3 };
  return { quality: "NORMAL", reason: "Standard window", penaltyPct: 0 };
}
function analyzeOTCPatterns(candles, atr, lastClose, now = /* @__PURE__ */ new Date()) {
  const result = {
    consecutiveCandles: null,
    wickRejection: null,
    roundNumber: null,
    sizeAnomaly: null,
    timeContext: null,
    otcBonusUp: 0,
    otcBonusDown: 0,
    otcSignals: [],
    confluenceBonus: 0
  };
  const consec = countConsecutiveCandles(candles);
  result.consecutiveCandles = consec;
  if (consec.count >= 3) {
    const bonus = consec.count >= 5 ? 1.5 : consec.count >= 4 ? 1 : 0.6;
    if (consec.direction === "SELL") result.otcBonusUp += bonus;
    else result.otcBonusDown += bonus;
    result.otcSignals.push("CONSEC_" + consec.count + "_" + consec.direction + "_REVERSAL");
  }
  const wick = detectWickRejection(candles);
  result.wickRejection = wick;
  if (wick) {
    if (wick.direction === "BUY") result.otcBonusUp += wick.strength;
    else result.otcBonusDown += wick.strength;
    result.otcSignals.push(wick.type);
  }
  const round = detectRoundNumberProximity(lastClose, atr);
  result.roundNumber = round;
  if (round) {
    if (lastClose < round.level) {
      result.otcBonusDown += round.proximity * 0.4;
      result.otcSignals.push("ROUND_LEVEL_" + round.stepType + "_RESISTANCE");
    } else if (lastClose > round.level) {
      result.otcBonusUp += round.proximity * 0.4;
      result.otcSignals.push("ROUND_LEVEL_" + round.stepType + "_SUPPORT");
    } else {
      result.otcSignals.push("ROUND_LEVEL_" + round.stepType + "_ON_LEVEL");
    }
  }
  const anomaly = detectCandleSizeAnomaly(candles);
  result.sizeAnomaly = anomaly;
  if (anomaly) {
    const bonus = anomaly.strength === "STRONG" ? 1.2 : 0.7;
    if (anomaly.likelyDirection === "BUY") result.otcBonusUp += bonus;
    else result.otcBonusDown += bonus;
    result.otcSignals.push("SIZE_ANOMALY_" + anomaly.strength);
  }
  result.timeContext = getOTCTimeContext(now);
  const upC = [wick && wick.direction === "BUY" ? 1 : 0, consec.count >= 3 && consec.direction === "SELL" ? 1 : 0, anomaly && anomaly.likelyDirection === "BUY" ? 1 : 0].reduce((a, b) => a + b, 0);
  const dnC = [wick && wick.direction === "SELL" ? 1 : 0, consec.count >= 3 && consec.direction === "BUY" ? 1 : 0, anomaly && anomaly.likelyDirection === "SELL" ? 1 : 0].reduce((a, b) => a + b, 0);
  if (upC >= 2) {
    result.confluenceBonus = 8;
    result.otcSignals.push("OTC_CONFLUENCE_BUY");
  }
  if (dnC >= 2) {
    result.confluenceBonus = -8;
    result.otcSignals.push("OTC_CONFLUENCE_SELL");
  }
  return result;
}

// src/signal/otcEngine.js
init_calibration();
function analyzeTimeframeOTC(indicators, candles, timeframe) {
  const result = analyzeTimeframe(indicators, candles, timeframe, ASSET_TYPE.FOREX, null, "RANGING");
  const rangingW = { trend: 0.8, momentum: 1.8, macd: 0.8, stochastic: 1.8, bands: 1.4, adx: 0.8, patterns: 1.3, divergence: 1.8, pivots: 1.2, volume: 0.5, sr: 2.2, camarilla: 0.84 };
  const otcW = OTC_CATEGORY_WEIGHTS;
  let newUp = 0;
  let newDown = 0;
  const cats = ["trend", "momentum", "macd", "stochastic", "bands", "adx", "patterns", "divergence", "pivots", "volume", "sr", "camarilla"];
  for (const cat of cats) {
    const cd = result.categoryScores[cat];
    if (!cd) continue;
    const rW = rangingW[cat] || 1;
    const otW = otcW[cat] !== void 0 ? otcW[cat] : 0;
    if (rW > 0) {
      const rawUp = cat === "camarilla" ? cd.up || 0 : (cd.up || 0) / rW;
      const rawDown = cat === "camarilla" ? cd.down || 0 : (cd.down || 0) / rW;
      newUp += rawUp * otW;
      newDown += rawDown * otW;
      result.categoryScores[cat] = { ...cd, up: r2(rawUp * otW), down: r2(rawDown * otW), otcWeight: otW };
    }
  }
  const scoreDiff = Math.abs(newUp - newDown);
  let upCat = 0;
  let downCat = 0;
  for (const cat of cats) {
    const cd = result.categoryScores[cat];
    if (!cd) continue;
    if ((cd.up || 0) > (cd.down || 0) && Math.abs((cd.up || 0) - (cd.down || 0)) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
    else if ((cd.down || 0) > (cd.up || 0) && Math.abs((cd.down || 0) - (cd.up || 0)) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  }
  const confluence = Math.max(upCat, downCat);
  let direction;
  if (newUp >= OTC_SCORE_THRESHOLD && newUp > newDown && upCat >= OTC_MIN_CONFLUENCE) direction = "BUY";
  else if (newDown >= OTC_SCORE_THRESHOLD && newDown > newUp && downCat >= OTC_MIN_CONFLUENCE) direction = "SELL";
  else if (scoreDiff >= 3 && confluence >= 3) direction = newUp > newDown ? "BUY" : "SELL";
  else direction = "NO_TRADE";
  result.direction = direction;
  result.score = { up: r2(newUp), down: r2(newDown), diff: r2(scoreDiff) };
  result.confluence = confluence;
  result.confluenceDetail = { bullish: upCat, bearish: downCat, total: 12 };
  result.otcWeighted = true;
  return result;
}
async function buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env, opts = {}) {
  const now = opts && opts.now ? new Date(opts.now) : /* @__PURE__ */ new Date();
  const tfResults = {};
  const votes = [];
  const indicatorCache = {};
  let htfContext = null;
  if (candleData["15min"] && candleData["15min"].length > 0) {
    const htfInd = calculateAllIndicators(candleData["15min"]);
    const htfEma5 = safeLastValue(htfInd.ema5);
    const htfEma55 = safeLastValue(htfInd.ema55);
    if (htfEma5 !== null && htfEma55 !== null) htfContext = htfEma5 > htfEma55 ? "BUY_BIAS" : "SELL_BIAS";
  }
  for (const tf of Object.keys(candleData)) {
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = calculateAllIndicators(candles);
    indicatorCache[tf] = indicators;
    const analysis = analyzeTimeframeOTC(indicators, candles, tf);
    const dur = calculateOTCCandleDuration(indicators, analysis.direction, candles, tf);
    const cMin = CANDLE_MINUTES[tf] || 1;
    const dMin = dur * cMin;
    analysis.expiry = {
      candles: dur,
      candleSize: cMin + "min",
      totalMinutes: dMin,
      expiryTime: new Date(now.getTime() + dMin * 6e4).toISOString(),
      humanReadable: formatDuration(dMin),
      nextCandleClose: getNextCandleClose(now, cMin).toISOString(),
      countdown: getCandleCountdown(cMin)
    };
    const lc = candles[candles.length - 1];
    analysis.entry = { price: lc.close, candleTime: lc.datetime, candleDirection: lc.close >= lc.open ? "BULLISH" : "BEARISH" };
    analysis.higherTFTrend = htfContext;
    analysis.alignedWithHTF = true;
    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf, alignedWithHTF: true });
  }
  const primaryCandles = candleData["1min"] || candleData["5min"] || candleData["15min"] || [];
  const otcCandleQuality = getCandleQualityMultiplier(primaryCandles);
  let weightedBuy = 0;
  let weightedSell = 0;
  let weightedNoTrade = 0;
  const activeDirs = [];
  for (const vote of votes) {
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1) * otcCandleQuality;
    if (vote.direction === "BUY") {
      weightedBuy += w * (vote.score.up || 1);
      activeDirs.push("BUY");
    } else if (vote.direction === "SELL") {
      weightedSell += w * (vote.score.down || 1);
      activeDirs.push("SELL");
    } else {
      weightedNoTrade += w;
    }
  }
  const allBuy = activeDirs.length > 0 && activeDirs.every((d) => d === "BUY");
  const allSell = activeDirs.length > 0 && activeDirs.every((d) => d === "SELL");
  let alignment = "MIXED";
  let alignmentBonus = 0;
  if (allBuy) {
    alignment = "ALL_BULLISH";
    alignmentBonus = 4;
  } else if (allSell) {
    alignment = "ALL_BEARISH";
    alignmentBonus = 4;
  } else if (activeDirs.length >= 2) {
    const bc = activeDirs.filter((d) => d === "BUY").length;
    const sc = activeDirs.filter((d) => d === "SELL").length;
    if (bc > sc) {
      alignment = "MOSTLY_BULLISH";
      alignmentBonus = 2;
    }
    if (sc > bc) {
      alignment = "MOSTLY_BEARISH";
      alignmentBonus = 2;
    }
  }
  let finalDirection;
  let confidence;
  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = "BUY";
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round(weightedBuy / d * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = "SELL";
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round(weightedSell / d * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction;
    confidence = tie.confidence;
  }
  const rawConfidence = confidence;
  confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus);
  if (alignment === "MIXED") {
    finalDirection = "NO_TRADE";
    confidence = 0;
  }
  const lastClose = primaryCandles.length > 0 ? primaryCandles[primaryCandles.length - 1].close : 0;
  const atrVal = primaryCandles.length > 0 ? safeLastValue(calculateATR(primaryCandles, CONFIG.ATR_PERIOD)) : null;
  const otcPatterns = analyzeOTCPatterns(primaryCandles, atrVal, lastClose, now);
  if (finalDirection !== "NO_TRADE") {
    const pb = finalDirection === "BUY" ? otcPatterns.otcBonusUp - otcPatterns.otcBonusDown : otcPatterns.otcBonusDown - otcPatterns.otcBonusUp;
    if (pb > 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.round(pb * 3));
    else if (pb < 0) confidence = Math.max(0, confidence + Math.round(pb * 3));
    if (otcPatterns.confluenceBonus !== 0) {
      const bonusDir = otcPatterns.confluenceBonus > 0 ? "BUY" : "SELL";
      if (finalDirection === bonusDir) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(otcPatterns.confluenceBonus));
      else {
        confidence = Math.max(0, confidence - Math.abs(otcPatterns.confluenceBonus));
        if (confidence < OTC_CONFIDENCE_FLOOR) {
          finalDirection = "NO_TRADE";
          confidence = 0;
        }
      }
    }
  }
  if (finalDirection !== "NO_TRADE" && otcPatterns.timeContext) {
    const tp = otcPatterns.timeContext.penaltyPct;
    if (tp > 0) {
      confidence = Math.max(0, confidence - tp);
      if (confidence < OTC_CONFIDENCE_FLOOR) {
        finalDirection = "NO_TRADE";
        confidence = 0;
      }
    } else if (tp < 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(tp));
  }
  let consistencyMult = 1;
  if (primaryCandles.length > 0 && finalDirection !== "NO_TRADE") {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 3);
    if (consistencyMult < 1) confidence = Math.round(confidence * consistencyMult);
  }
  let entryCandlePenalty = false;
  if (finalDirection !== "NO_TRADE" && primaryCandles.length >= 2) {
    const lC = primaryCandles[primaryCandles.length - 1];
    const pC = primaryCandles[primaryCandles.length - 2];
    const lBody = Math.abs(lC.close - lC.open);
    const bRatio = lBody / (lC.high - lC.low || 1e-5);
    const lBull = lC.close > lC.open;
    const pBull = pC.close > pC.open;
    const bothAgainst = finalDirection === "BUY" && !lBull && !pBull || finalDirection === "SELL" && lBull && pBull;
    if (bothAgainst && bRatio > 0.55) {
      entryCandlePenalty = true;
      confidence = Math.max(0, confidence - 10);
      if (confidence < OTC_CONFIDENCE_FLOOR) {
        finalDirection = "NO_TRADE";
        confidence = 0;
      }
    }
  }
  if (exotic) confidence = Math.max(20, confidence - OTC_EXOTIC_PENALTY);
  if (finalDirection !== "NO_TRADE" && otcCandleQuality < 0.8) {
    confidence = Math.max(0, confidence - 15);
    if (confidence < OTC_CONFIDENCE_FLOOR) {
      finalDirection = "NO_TRADE";
      confidence = 0;
    }
  }
  let belowFloor = false;
  if (finalDirection !== "NO_TRADE" && confidence < OTC_CONFIDENCE_FLOOR) {
    belowFloor = true;
    finalDirection = "NO_TRADE";
  }
  const filtersApplied = [];
  if (belowFloor) filtersApplied.push("OTC_BELOW_FLOOR (" + OTC_CONFIDENCE_FLOOR + "%)");
  if (alignment === "MIXED") filtersApplied.push("MIXED_ALIGNMENT");
  if (entryCandlePenalty) filtersApplied.push("ENTRY_CANDLE_PENALTY (-10)");
  if (consistencyMult < 1) filtersApplied.push("CANDLE_INCONSISTENCY (x" + consistencyMult + ")");
  if (exotic) filtersApplied.push("EXOTIC_OTC_PENALTY (-" + OTC_EXOTIC_PENALTY + ")");
  if (otcCandleQuality !== 1) filtersApplied.push("OTC_CANDLE_QUALITY (x" + otcCandleQuality.toFixed(2) + ")");
  if (otcPatterns.otcSignals.length > 0) filtersApplied.push("OTC_PATTERNS: " + otcPatterns.otcSignals.join(", "));
  const best = findBestTimeframe(tfResults, finalDirection);
  const recommendations = {};
  for (const [rtf, rec] of Object.entries(tfResults)) {
    recommendations[rtf] = { direction: rec.direction, score: rec.score, confluence: rec.confluence + "/12", expiry: rec.expiry, entry: rec.entry, patterns: rec.categoryScores?.patterns?.detected || [] };
  }
  const avgConf = votes.reduce((s, v) => s + (v.confluence || 0), 0) / Math.max(votes.length, 1);
  const bestTFA = tfResults[best.timeframe] || null;
  let entryReason = generateEntryReason(finalDirection, bestTFA?.categoryScores || {}, bestTFA?.indicators || {}, alignment, null, "RANGING");
  if (otcPatterns.otcSignals.length > 0) entryReason += " \xB7 OTC: " + otcPatterns.otcSignals.slice(0, 3).join(", ");
  let aiValidation = { status: "SKIPPED" };
  if (finalDirection !== "NO_TRADE") {
    const snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    const engSig = { direction: finalDirection, confidence: confidence + "%", alignment, bestTF: best.timeframe };
    aiValidation = await callCerebrasValidationOTC(pair, engSig, snapshot, otcPatterns, env);
    if (aiValidation.status === "OK") {
      const aiAgreed = aiValidation.signal === finalDirection;
      aiValidation.agrees = aiAgreed;
      if (aiAgreed) {
        if (!aiValidation.concerns) {
          confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + 8);
          filtersApplied.push("OTC_AI_BOOST: +8");
        } else {
          confidence = Math.max(0, confidence - 5);
          filtersApplied.push("OTC_AI_AGREE_WITH_CONCERNS: " + aiValidation.concerns);
        }
      } else if (aiValidation.signal !== "NO_TRADE") {
        confidence = Math.max(0, confidence - 20);
        filtersApplied.push("OTC_AI_PENALTY: disagrees (AI=" + aiValidation.signal + ")");
        if (confidence < OTC_CONFIDENCE_FLOOR) {
          finalDirection = "NO_TRADE";
          confidence = 0;
          filtersApplied.push("OTC_BELOW_FLOOR_AFTER_AI");
        }
      } else {
        confidence = Math.max(0, confidence - 10);
        filtersApplied.push("OTC_AI_SOFT_PENALTY: uncertain");
      }
    }
  }
  let edgeAudit = null;
  let activeCalib = null;
  if (CONFIG.EDGE_FEATURES.enabled && opts.edgeFeatures !== false) {
    try {
      activeCalib = await loadCalibration(env);
      const edgeRes = await applyEdgeFeatures({
        finalDirection,
        confidence,
        pair,
        assetType: ASSET_TYPE_OTC,
        now,
        candleData,
        tfResults,
        indicators: indicatorCache,
        env,
        calib: activeCalib
      });
      finalDirection = edgeRes.finalDirection;
      confidence = edgeRes.confidence;
      for (const f of edgeRes.filtersApplied) filtersApplied.push(f);
      edgeAudit = edgeRes.audit;
      if (edgeAudit && edgeAudit.blockedBy) filtersApplied.push("EDGE_BLOCK (" + edgeAudit.blockedBy + ")");
      if (finalDirection !== "NO_TRADE" && confidence < OTC_CONFIDENCE_FLOOR) {
        finalDirection = "NO_TRADE";
        confidence = 0;
        filtersApplied.push("OTC_BELOW_FLOOR_AFTER_EDGE_FEATURES (" + OTC_CONFIDENCE_FLOOR + "%)");
      }
    } catch (e) {
      console.warn("OTC edge features failed (production unaffected): " + e.message);
      edgeAudit = null;
    }
  }
  const structureVerdict = buildStructureVerdict(tfResults, finalDirection);
  let calibratedConfForReport = confidence;
  let calibratedScoreForTrace = null;
  if (finalDirection !== "NO_TRADE") {
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall, activeCalib);
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }
  let finalGrade;
  if (finalDirection === "NO_TRADE") {
    finalGrade = { grade: "N/A", label: "NO_TRADE", description: "Engine blocked \u2014 no trade." };
  } else {
    finalGrade = getSignalGrade(confidence, avgConf, alignment, structureVerdict.overall);
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall, activeCalib);
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }
  const reportConfidence = finalDirection === "NO_TRADE" ? 0 : calibratedConfForReport;
  const __otcSignal = {
    finalSignal: finalDirection,
    confidence: reportConfidence + "%",
    grade: finalGrade,
    coreConfidence: rawConfidence,
    // B5 — see anchor above
    calibration: finalDirection === "NO_TRADE" ? null : {
      rawConfidence: confidence,
      calibratedConfidence: calibratedConfForReport,
      calibratedScore: calibratedScoreForTrace,
      version: "calib-v1-2026-08-09"
    },
    assetType: ASSET_TYPE_OTC,
    isOTC: true,
    otcNote: "Synthetic pair \u2014 mean reversion + price action. Olymp Trade.",
    marketRegime: "OTC_SYNTHETIC",
    regimeAdvice: finalDirection === "NO_TRADE" ? "OTC \u2014 wait for clearer pattern" : "OTC \u2014 short expiry (2-3 candles), price action based",
    marketCondition: ["OTC_SYNTHETIC"],
    alignment,
    higherTFTrend: htfContext || "N/A",
    entryReason,
    filtersApplied,
    newsBlackout: null,
    aiValidation,
    edgeFeatures: edgeAudit,
    session: { sessions: ["OTC_24/7"], quality: "N/A" },
    otcPatterns: { consecutiveCandles: otcPatterns.consecutiveCandles, wickRejection: otcPatterns.wickRejection, roundNumber: otcPatterns.roundNumber, sizeAnomaly: otcPatterns.sizeAnomaly, timeContext: otcPatterns.timeContext, signals: otcPatterns.otcSignals, confluenceBonus: otcPatterns.confluenceBonus },
    recommendations,
    bestTimeframe: best,
    votes: { BUY: votes.filter((v) => v.direction === "BUY").length, SELL: votes.filter((v) => v.direction === "SELL").length, NO_TRADE: votes.filter((v) => v.direction === "NO_TRADE").length, total: votes.length, weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade) },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    structureVerdict,
    method: "OTC_HYBRID_v6.9.1",
    generatedAt: now.toISOString()
  };
  if (finalDirection === "BUY" || finalDirection === "SELL") {
    try {
      const bestTFA2 = best && best.timeframe && best.timeframe !== "N/A" ? tfResults[best.timeframe] : null;
      const entryPx = bestTFA2 && bestTFA2.entry ? bestTFA2.entry.price : null;
      const currentCandles = candleData["1min"] || candleData["5min"] || candleData["15min"];
      const lastClose2 = currentCandles && currentCandles.length ? currentCandles[currentCandles.length - 1].close : null;
      if (entryPx != null && lastClose2 != null) {
        const dist = Math.abs(lastClose2 - entryPx);
        const rel = entryPx !== 0 ? dist / entryPx : 0;
        const actionable = rel <= 5e-4;
        __otcSignal.fillStatus = actionable ? "INSTANT" : "PENDING_ENTRY";
        __otcSignal.entryPrice = entryPx;
        __otcSignal.currentPrice = lastClose2;
        __otcSignal.entryDistancePct = Number((rel * 100).toFixed(4));
      }
    } catch (e) {
      console.warn("OTC fill status failed (production unaffected): " + e.message);
    }
  }
  return __otcSignal;
}

// src/history/r71store.js
var OBS_PREFIX3 = "shadow:obs:";
var PENDING_PREFIX3 = "shadow:pending:";
var IDX_PREFIX3 = "shadow:idx:";
var MAX_PER_PAIR_30D3 = 30;
var RETENTION_TTL_S3 = 30 * 24 * 3600;
var PENDING_TTL_S3 = Math.floor(2 * 60 * 60);
var PENDING_MAX_CHECKS3 = 15;
var RESOLVER_CAP3 = 10;
var RESULT_CHECK_DELAY_S3 = 90;
var DEDUP_WINDOW_MS4 = 2 * 60 * 60 * 1e3;
var DEDUP_ENTRY_REL_TOL3 = 5e-4;
var DEDUP_ENTRY_ABS_TOL3 = 1e-4;
function pairKey5(pair) {
  return String(pair).replace(/\//g, "_").replace(/-/g, "_").toUpperCase();
}
function shadowObsKey(id) {
  return OBS_PREFIX3 + id;
}
function shadowPendingKey(id) {
  return PENDING_PREFIX3 + id;
}
function shadowIdxKey(pair) {
  return IDX_PREFIX3 + pairKey5(pair);
}
function entriesClose4(a, b) {
  if (a === null || a === void 0 || b === null || b === void 0) return false;
  if (typeof a !== "number" || typeof b !== "number" || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOL3 || diff / scale <= DEDUP_ENTRY_REL_TOL3;
}
var __accounting3 = {
  admitted: 0,
  dedupRejected: 0,
  capRejected: 0,
  admissionReads: 0,
  admissionWrites: 0,
  resolutionLists: 0,
  resolutionReads: 0,
  resolutionWrites: 0,
  resolutionDeletes: 0,
  retryWrites: 0,
  terminalUnknownWrites: 0
};
async function admitShadowObservation(input, env) {
  if (!env || !env.SIGNAL_CACHE) return { admitted: false, reason: "NO_KV" };
  if (!input || !input.id || !input.pair || !input.direction || !input.expiryTime) {
    return { admitted: false, reason: "INVALID_INPUT" };
  }
  try {
    const idxKey3 = shadowIdxKey(input.pair);
    let idx = [];
    try {
      idx = await env.SIGNAL_CACHE.get(idxKey3, "json");
    } catch (e) {
      idx = [];
    }
    if (!Array.isArray(idx)) idx = [];
    __accounting3.admissionReads++;
    const now = Date.now();
    const window30d = now - RETENTION_TTL_S3 * 1e3;
    idx = idx.filter((e) => e && typeof e.admittedAt === "number" && e.admittedAt >= window30d);
    const dedupCutoff = now - DEDUP_WINDOW_MS4;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose4(e.entryPrice, input.entryPrice)) {
        __accounting3.dedupRejected++;
        return { admitted: false, reason: "DEDUP", reads: 1, writes: 0 };
      }
    }
    if (idx.length >= MAX_PER_PAIR_30D3) {
      __accounting3.capRejected++;
      return { admitted: false, reason: "CAP", reads: 1, writes: 0 };
    }
    const record = {
      id: input.id,
      pair: input.pair,
      assetType: input.assetType || null,
      direction: input.direction,
      entryPrice: input.entryPrice ?? null,
      expiryTime: input.expiryTime,
      bestTF: input.bestTF || null,
      shadowConfidence: input.shadowConfidence ?? null,
      attribution: input.attribution || "STRUCTURE_SUPPRESSED",
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null,
      exitPrice: null,
      resolvedAt: null,
      checks: 0
    };
    await env.SIGNAL_CACHE.put(
      shadowObsKey(input.id),
      JSON.stringify(record),
      { expirationTtl: RETENTION_TTL_S3 }
    );
    await env.SIGNAL_CACHE.put(
      shadowPendingKey(input.id),
      JSON.stringify(record),
      { expirationTtl: PENDING_TTL_S3 }
    );
    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxKey3, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S3 });
    __accounting3.admitted++;
    __accounting3.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn("R7.1 admitShadowObservation error (fail-open): " + e.message);
    return { admitted: false, reason: "ERROR", error: e.message };
  }
}
async function resolveShadowObservations(env) {
  if (!env || !env.SIGNAL_CACHE) return { resolved: 0 };
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: PENDING_PREFIX3 });
    __accounting3.resolutionLists++;
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return { resolved: 0 };
    const now = Date.now();
    let resolved = 0;
    let checked = 0;
    for (const kvEntry of pendingList.keys) {
      if (checked >= RESOLVER_CAP3) break;
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, "json");
        __accounting3.resolutionReads++;
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
          });
          __accounting3.resolutionDeletes++;
          checked++;
          continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + RESULT_CHECK_DELAY_S3 * 1e3;
        if (now < checkAfterMs) {
          checked++;
          continue;
        }
        const fetchResult = await fetchExpiryPrice(record.pair, record.expiryTime, env);
        if (fetchResult && fetchResult.error) {
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = (/* @__PURE__ */ new Date()).toISOString();
          if (record.checks >= PENDING_MAX_CHECKS3) {
            record.result = "UNKNOWN";
            record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
            await env.SIGNAL_CACHE.put(
              shadowObsKey(record.id),
              JSON.stringify(record),
              { expirationTtl: RETENTION_TTL_S3 }
            );
            __accounting3.terminalUnknownWrites++;
            await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
            });
            __accounting3.resolutionDeletes++;
          } else {
            const remainingMs = new Date(record.expiryTime).getTime() + PENDING_TTL_S3 * 1e3 - now;
            if (remainingMs > 6e4) {
              await env.SIGNAL_CACHE.put(
                kvEntry.name,
                JSON.stringify(record),
                { expirationTtl: Math.floor(remainingMs / 1e3) }
              );
              __accounting3.retryWrites++;
            } else {
              record.result = "UNKNOWN";
              record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
              await env.SIGNAL_CACHE.put(
                shadowObsKey(record.id),
                JSON.stringify(record),
                { expirationTtl: RETENTION_TTL_S3 }
              );
              __accounting3.terminalUnknownWrites++;
              await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
              });
              __accounting3.resolutionDeletes++;
            }
          }
          checked++;
          continue;
        }
        const exitPrice = fetchResult ? fetchResult.price : null;
        const winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);
        record.result = winLoss;
        record.exitPrice = exitPrice;
        record.resolvedAt = (/* @__PURE__ */ new Date()).toISOString();
        await env.SIGNAL_CACHE.put(
          shadowObsKey(record.id),
          JSON.stringify(record),
          { expirationTtl: RETENTION_TTL_S3 }
        );
        __accounting3.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {
        });
        __accounting3.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        console.warn("R7.1 shadow resolve error for " + kvEntry.name + ": " + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log("R7.1 shadow resolver: resolved " + resolved + " observations");
    return { resolved };
  } catch (e) {
    console.warn("R7.1 resolveShadowObservations error: " + e.message);
    return { resolved: 0, error: e.message };
  }
}

// src/handlers/signal.js
function generateSignalId() {
  return "sig_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}
async function maybeAdmitShadowObservation(signal, pair, assetType, env) {
  try {
    const audit = getEngineAudit(signal);
    if (!audit || !audit.isolatedObservationEligible || !audit.shadowTradeContext) return null;
    const stc = audit.shadowTradeContext;
    if (!stc.expiryTime) return null;
    const obsId = "r71_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
    return await admitShadowObservation({
      id: obsId,
      pair,
      assetType,
      direction: stc.direction,
      entryPrice: stc.entryPrice,
      expiryTime: stc.expiryTime,
      bestTF: stc.bestTF,
      shadowConfidence: stc.confidence,
      attribution: audit.attribution,
      auditSummary: {
        decisionScope: audit.decisionScope,
        comparability: audit.comparability,
        diagnostic: audit.diagnostic,
        productionPreAiDirection: audit.productionPreAiDirection,
        shadowConfidence: audit.shadowConfidence
      }
    }, env);
  } catch (e) {
    console.warn("R7.1 shadow admission error (fail-open): " + e.message);
    return null;
  }
}
function classifyEntrySource(cacheHits) {
  if (cacheHits === 0) return "FRESH_API";
  if (cacheHits === 1 || cacheHits === 2) return "CACHE_PARTIAL";
  if (cacheHits === 3) return "CACHE_ALL";
  return null;
}
async function saveAndPush(signal, pair, isOTC, env, signalId, entrySource, response, noPush) {
  let saveResult = null;
  try {
    saveResult = await saveSignalToHistory(signal, pair, isOTC, env, signalId, entrySource);
  } catch (e) {
    console.warn("saveAndPush: save failed for " + pair + ": " + e.message);
    return;
  }
  if (saveResult && saveResult.deduped) return;
  try {
    if (!noPush) await pushSignalToSubscribers({ ...response, id: signalId, pair, signal }, env);
  } catch (e) {
    console.warn("saveAndPush: push failed for " + pair + ": " + e.message);
  }
}
async function handleSignal(pair, env, ctx, opts = {}) {
  const preferCache = !!(opts && opts.preferCache);
  if (preferCache && !opts?.fxMode) {
    const cached = await readLatest(pair, env);
    if (cached && !isStale(cached)) {
      return jsonResponse({ ...enrichAge(cached), cached: true, forceRefresh: false });
    }
  }
  const result = await handleSignalRaw(pair, env, ctx, {
    fxMode: !!opts?.fxMode,
    noPush: !!opts?.noPush
  });
  if (preferCache && result && !result.error && result.signal && result.source !== "DUMMY_FALLBACK") {
    const write = writeLatest(pair, result, { opportunistic: true }, env);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
    else await write;
  }
  return jsonResponse({ ...result, cached: false, forceRefresh: !preferCache });
}
async function handleSignalRaw(pair, env, ctx, opts = {}) {
  const assetType = getAssetType(pair);
  const reqFxMode = !!opts.fxMode;
  const noPush = !!opts.noPush;
  if (assetType === ASSET_TYPE_OTC) return await handleSignalRawOTC(pair, env, ctx, opts);
  const session = detectTradingSession();
  const exotic = assetType === ASSET_TYPE.FOREX ? isExoticPair(pair) : false;
  let holidayWarning = null;
  if (assetType === ASSET_TYPE.FOREX) {
    const holiday = getForexHoliday();
    const marketOpen = isForexMarketOpen();
    if (!marketOpen) {
      const nextOpen = getNextForexOpen();
      return {
        pair,
        assetType: "FOREX",
        marketStatus: "CLOSED",
        message: "Forex market is currently CLOSED (Weekend)",
        details: "Forex operates Sunday 22:00 UTC to Friday 22:00 UTC.",
        nextOpen: nextOpen.toISOString(),
        opensIn: formatTimeUntil(nextOpen),
        nextOpenReadable: "Sunday " + nextOpen.toUTCString(),
        advice: "Wait for market open or trade Crypto (24/7).",
        cryptoAlternative: "Try /api/signal?pair=BTC/USD",
        signal: null,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    if (holiday) holidayWarning = "Today is " + holiday + ". Forex liquidity may be very low.";
  }
  const newsBlock = checkNewsBlackout(assetType);
  const timeframes = ["1min", "5min", "15min"];
  const candleData = {};
  const errors = {};
  let totalFailures = 0;
  let cacheHits = 0;
  const tfFetches = await Promise.all(timeframes.map((tf) => fetchCandlesWithCache(pair, tf, 100, env, ctx, assetType)));
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
    return { pair, assetType, signal: generateDummySignal(pair), source: "DUMMY_FALLBACK", errors, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
  }
  const signal = await buildMultiTimeframeSignal(pair, candleData, assetType, env, {
    fxMode: reqFxMode,
    edgeFeatures: opts.edgeFeatures,
    now: opts.now
  });
  if (holidayWarning) signal.holidayWarning = holidayWarning;
  if (assetType === ASSET_TYPE.FOREX && session.quality === "LOW")
    signal.sessionWarning = "Low liquidity session. Best: London (07-16 UTC), NY (12-21 UTC).";
  if (exotic) signal.exoticWarning = "Exotic pair. Higher spreads. Confidence reduced.";
  if (ctx && env && env.SIGNAL_CACHE) {
    ctx.waitUntil(maybeAdmitShadowObservation(signal, pair, assetType, env));
    ctx.waitUntil(maybeAdmitD2ShadowObservation(signal, pair, assetType, env));
    ctx.waitUntil(maybeAdmitForexSellProbe(signal, pair, assetType, env));
  }
  const dataStatus = {};
  for (const tf of timeframes)
    dataStatus[tf] = candleData[tf] ? candleData[tf].length + " candles" : "FAILED: " + (errors[tf] || "unknown");
  const entrySource = classifyEntrySource(cacheHits);
  const cb = signal.finalSignal !== "NO_TRADE" ? await isTripped(pair, env) : { tripped: false };
  if (cb.tripped) {
    const wouldBeSignal = signal.finalSignal;
    signal.finalSignal = "NO_TRADE";
    signal.circuitBreaker = {
      tripped: true,
      cooldownUntil: cb.cooldownUntil,
      lossStreak: cb.lossStreak,
      wouldBeSignal,
      cbShadow: true
    };
    const shadowId = env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
    if (shadowId) {
      ctx.waitUntil(saveSignalToHistory(
        { ...signal, finalSignal: wouldBeSignal, cbShadow: true },
        pair,
        false,
        env,
        shadowId,
        entrySource
      ));
    }
    return {
      ...shadowId ? { id: shadowId } : {},
      pair,
      assetType,
      marketStatus: "OPEN",
      session,
      isExoticPair: exotic,
      signal,
      circuitBreaker: signal.circuitBreaker,
      source: totalFailures > 0 ? "PARTIAL_DATA" : "FULL_DATA",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
      cacheHits,
      entrySource,
      dataStatus
    };
  }
  const signalId = signal.finalSignal !== "NO_TRADE" && env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
  const result = {
    ...signalId ? { id: signalId } : {},
    pair,
    assetType,
    marketStatus: "OPEN",
    session,
    isExoticPair: exotic,
    signal,
    source: totalFailures > 0 ? "PARTIAL_DATA" : "FULL_DATA",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits,
    entrySource,
    dataStatus
  };
  if (signalId) {
    const persist = saveAndPush(signal, pair, false, env, signalId, entrySource, result, noPush);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(persist);
    if (opts.awaitPersist) await persist;
  }
  return result;
}
async function handleSignalRawOTC(pair, env, ctx, opts = {}) {
  const basePair = getOTCBasePair(pair);
  const exotic = isExoticPair(basePair);
  const noPush = !!opts.noPush;
  const session = detectTradingSession();
  const timeframes = ["1min", "5min", "15min"];
  const candleData = {};
  const errors = {};
  let totalFailures = 0;
  let cacheHits = 0;
  const tfFetches = await Promise.all(timeframes.map((tf) => fetchCandlesWithCache(basePair, tf, 100, env, ctx, ASSET_TYPE.FOREX)));
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
  if (totalFailures === timeframes.length)
    return { pair, assetType: ASSET_TYPE_OTC, isOTC: true, signal: generateDummySignal(pair), source: "DUMMY_FALLBACK", errors, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
  const signal = await buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env, {
    edgeFeatures: opts.edgeFeatures,
    now: opts.now
  });
  if (exotic) signal.exoticWarning = "Exotic OTC pair. Very high spreads. Confidence heavily reduced.";
  const dataStatus = {};
  for (const tf of timeframes)
    dataStatus[tf] = candleData[tf] ? candleData[tf].length + " candles (from " + basePair + ")" : "FAILED: " + (errors[tf] || "unknown");
  const entrySource = classifyEntrySource(cacheHits);
  const cb = signal.finalSignal !== "NO_TRADE" ? await isTripped(pair, env) : { tripped: false };
  if (cb.tripped) {
    const wouldBeSignal = signal.finalSignal;
    signal.finalSignal = "NO_TRADE";
    signal.circuitBreaker = {
      tripped: true,
      cooldownUntil: cb.cooldownUntil,
      lossStreak: cb.lossStreak,
      wouldBeSignal,
      cbShadow: true
    };
    const shadowId = env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
    if (shadowId) {
      ctx.waitUntil(saveSignalToHistory(
        { ...signal, finalSignal: wouldBeSignal, cbShadow: true },
        pair,
        true,
        env,
        shadowId,
        entrySource
      ));
    }
    return {
      ...shadowId ? { id: shadowId } : {},
      pair,
      basePair,
      assetType: ASSET_TYPE_OTC,
      isOTC: true,
      otcBroker: "Olymp Trade (synthetic price)",
      marketStatus: "OPEN (OTC 24/7)",
      session,
      isExoticPair: exotic,
      signal,
      circuitBreaker: signal.circuitBreaker,
      source: totalFailures > 0 ? "PARTIAL_DATA" : "FULL_DATA",
      dataNote: "Candle data from " + basePair + " (real market). OTC price may differ.",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
      cacheHits,
      entrySource,
      dataStatus
    };
  }
  const signalId = signal.finalSignal !== "NO_TRADE" && env?.SIGNAL_CACHE && ctx ? generateSignalId() : null;
  const otcResult = {
    ...signalId ? { id: signalId } : {},
    pair,
    basePair,
    assetType: ASSET_TYPE_OTC,
    isOTC: true,
    otcBroker: "Olymp Trade (synthetic price)",
    marketStatus: "OPEN (OTC 24/7)",
    session,
    isExoticPair: exotic,
    signal,
    source: totalFailures > 0 ? "PARTIAL_DATA" : "FULL_DATA",
    dataNote: "Candle data from " + basePair + " (real market). OTC price may differ.",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits,
    entrySource,
    dataStatus
  };
  if (signalId) {
    const persist = saveAndPush(signal, pair, true, env, signalId, entrySource, otcResult, noPush);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(persist);
    if (opts.awaitPersist) await persist;
  }
  return otcResult;
}
async function handleBatch(url, env, ctx) {
  const rawPairs = url.searchParams.get("pairs") || "";
  const pairList = rawPairs.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (pairList.length === 0)
    return jsonResponse({ error: true, message: "No pairs provided. Use ?pairs=EUR/USD,GBP/JPY,BTC/USD", example: "/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD" }, 400);
  const validPairs = [];
  const invalidPairs = [];
  for (const p of pairList) {
    const c = sanitizePair(p);
    if (c) validPairs.push(c);
    else invalidPairs.push(p);
  }
  const capped = validPairs.slice(0, CONFIG.BATCH_MAX_PAIRS);
  const results = await Promise.all(capped.map(
    (pair) => handleSignalRaw(pair, env, ctx).then((s) => ({ pair, signal: s })).catch((e) => ({ pair, error: e.message }))
  ));
  const summary = {};
  const pairDirs = {};
  for (const r of results) {
    summary[r.pair] = r.signal || { error: r.error };
    if (r.signal && r.signal.signal) pairDirs[r.pair] = r.signal.signal.finalSignal || "NO_TRADE";
  }
  return jsonResponse({
    batch: true,
    requestedPairs: pairList.length,
    processedPairs: capped.length,
    cappedAt: CONFIG.BATCH_MAX_PAIRS,
    invalidPairs,
    skippedPairs: validPairs.slice(CONFIG.BATCH_MAX_PAIRS),
    correlationAnalysis: detectCorrelationConflicts(pairDirs),
    results: summary,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
}

// src/handlers/scheduledScan.js
function selectActivePairs(pairs = SCAN_PAIRS, forexOpen = isForexMarketOpen()) {
  const active = [];
  for (const raw of pairs) {
    const pair = sanitizePair(raw);
    if (!pair) {
      console.warn("scheduledScan: unsupported pair skipped: " + raw);
      continue;
    }
    const assetType = getAssetType(pair);
    if (assetType === ASSET_TYPE.FOREX && !forexOpen) continue;
    active.push(pair);
  }
  return active;
}
async function scheduledScan(env, ctx, opts = {}) {
  const startTime = Date.now();
  if (!env || !env.SIGNAL_CACHE) {
    console.warn("scheduledScan: SIGNAL_CACHE not bound, aborting");
    return { ok: 0, failed: 0, skipped: 0, aborted: true };
  }
  const generationId = "gen_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const activePairs = selectActivePairs();
  const skipped = SCAN_PAIRS.length - activePairs.length;
  console.log("scheduledScan start " + generationId + " active=" + activePairs.length + "/" + SCAN_PAIRS.length + (skipped ? " (skipped " + skipped + ", market closed/unsupported)" : ""));
  let ok = 0;
  let failed = 0;
  let processed = 0;
  for (let i = 0; i < activePairs.length; i += SCAN_CONFIG.BATCH_SIZE) {
    if (Date.now() - startTime > SCAN_CONFIG.MAX_SCAN_DURATION_MS) {
      console.warn("scheduledScan " + generationId + " hit MAX_SCAN_DURATION at " + processed + "/" + activePairs.length + " pairs");
      break;
    }
    const batch = activePairs.slice(i, i + SCAN_CONFIG.BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((pair) => scanOnePair(pair, generationId, env, ctx, opts))
    );
    for (const r of results) {
      processed++;
      if (r.status === "fulfilled" && r.value) ok++;
      else {
        failed++;
        if (r.status === "rejected") {
          console.warn("scheduledScan batch rejection: " + (r.reason && r.reason.message));
        }
      }
    }
    if (i + SCAN_CONFIG.BATCH_SIZE < activePairs.length) {
      await sleep(SCAN_CONFIG.BATCH_DELAY_MS);
    }
  }
  const ms = Date.now() - startTime;
  console.log("scheduledScan done " + generationId + ": " + ok + " ok, " + failed + " failed, " + skipped + " skipped, " + ms + "ms");
  return { ok, failed, skipped, generationId, ms };
}
async function scanOnePair(pair, generationId, env, ctx, opts = {}) {
  try {
    const result = await handleSignalRaw(pair, env, ctx, { ...opts, awaitPersist: true });
    if (!result || result.error) {
      console.warn("scanOnePair " + pair + " error: " + (result && result.message ? String(result.message).slice(0, 120) : "unknown"));
      return null;
    }
    if (result.source === "DUMMY_FALLBACK") {
      console.warn("scanOnePair " + pair + " skipped: DUMMY_FALLBACK (all candle fetches failed)");
      return null;
    }
    if (!result.signal) {
      console.warn("scanOnePair " + pair + " skipped: no signal in response (marketStatus=" + result.marketStatus + ")");
      return null;
    }
    const written = await writeLatest(pair, result, {
      generationId,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      opportunistic: false
    }, env);
    return written ? { pair } : null;
  } catch (e) {
    console.warn("scanOnePair exception " + pair + ": " + e.message);
    return null;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/index.js
var SELF_CALIB = CONFIG.SELF_CALIB;
var index_default = {
  /**
   * Two crons share this handler (wrangler.toml `crons`):
   *   * / 2 * * * *  -> result checker (Phase B)
   *   * / 5 * * * *  -> signal scanner (Phase 7)
   *
   * `event.cron` carries the pattern that fired. If a runtime ever omits it we
   * fall back to the result checker, which is the cheaper and more critical of
   * the two — a missed scan self-heals on the next tick, a missed result check
   * delays win/loss resolution.
   */
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === "*/5 * * * *") {
      await scheduledScan(env, ctx);
      return;
    }
    if (cron === SELF_CALIB.CRON) {
      ctx.waitUntil(recomputeCalibration(env));
      return;
    }
    if (cron && cron !== "*/2 * * * *") {
      console.warn('scheduled: unrecognised cron pattern "' + cron + '", running result checker');
    }
    ctx.waitUntil(scheduledTracker(env));
    ctx.waitUntil(resolveShadowObservations(env));
    ctx.waitUntil(resolveD2ShadowObservations(env));
    ctx.waitUntil(resolveProbeObservations(env));
  },
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/signal" || path === "/signal" || path === "/api/batch") {
        const rl = await checkRateLimit(request, env);
        if (rl) return applyCors(rl);
      }
      let response;
      if (path === "/" || path === "/health") {
        response = await handleHealth(env);
      } else if (path === "/api/signal" || path === "/signal") {
        const rawPair = url.searchParams.get("pair") || "EUR/USD";
        const pair = sanitizePair(rawPair);
        if (!pair) {
          response = jsonResponse({
            error: true,
            message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.',
            validForexCurrencies: VALID_FOREX_CURRENCIES,
            validCryptoBases: CRYPTO_BASES,
            validCryptoQuotes: CRYPTO_QUOTES,
            examples: ["EUR/USD", "GBP/JPY", "BTC/USD", "ETH/EUR", "SOL/USDT", "EURUSD-OTC"]
          }, 400);
        } else {
          const preferCache = url.searchParams.get("preferCache") === "true";
          response = await handleSignal(pair, env, ctx, { preferCache, fxMode: url.searchParams.get("mode") === "fx", noPush: url.searchParams.get("nopush") === "1" });
        }
      } else if (path === "/api/signals/latest") {
        response = await handleLatest(url, env);
      } else if (path === "/api/batch") {
        response = await handleBatch(url, env, ctx);
      } else if (path === "/api/pairs") {
        response = handlePairs();
      } else if (path === "/api/history") {
        response = await handleHistory(url, env);
      } else if (path === "/api/stats") {
        response = await handleStats(url, env);
      } else if (path === "/api/calib") {
        response = await handleCalib(env);
      } else if (path === "/api/report") {
        response = await handleReport(url, env);
      } else {
        response = jsonResponse({
          status: "ok",
          message: "FTT Signal Worker v6.10.4 \u2014 Forex + Crypto + OTC + History Tracking",
          endpoints: {
            health: "/",
            signal: "/api/signal?pair=EUR/USD",
            signalCached: "/api/signal?pair=EUR/USD&preferCache=true",
            latestAll: "/api/signals/latest",
            latestOne: "/api/signals/latest?pair=BTC/USD",
            signalOTC: "/api/signal?pair=EURUSD-OTC",
            crypto: "/api/signal?pair=BTC/USD",
            batch: "/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD",
            pairs: "/api/pairs",
            history: "/api/history?pair=EUR/USD&limit=20",
            stats: "/api/stats?pair=EUR/USD",
            report: "/api/report?id=SIGNAL_ID&result=WIN"
          },
          supportedAssets: ["FOREX (40+ currencies)", "CRYPTO (Top 10)", "OTC (Olymp Trade)"],
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      return applyCors(response);
    } catch (error) {
      console.error("Fatal:", error);
      return applyCors(jsonResponse({ error: true, message: "Internal server error" }, 500));
    }
  }
};
export {
  index_default as default
};

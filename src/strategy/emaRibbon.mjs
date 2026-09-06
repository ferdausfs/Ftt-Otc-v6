/**
 * EMA RIBBON — THE ENTIRE STRATEGY, in one readable file. STANDALONE.
 *
 * A new, unrelated hypothesis: the well-known retail EMA ribbon setup
 * (bias on a higher timeframe, fast-ribbon flip trigger on 1m). It is NOT a
 * patch on, extension of, or filter over FTT3 (engine.mjs) or FTT3-R
 * (meanReversion.mjs/regime.mjs) — this module imports nothing from them and
 * carries over no threshold or finding from either. Pre-registered parameters
 * (textbook ribbon periods, frozen before any run on the target window):
 *
 *   C1  Bias (15m)      EMA(5), EMA(13), EMA(55) on the last CLOSED 15m
 *                       candle. Full bullish order  EMA5 > EMA13 > EMA55 ->
 *                       bias UP. Full bearish order  EMA5 < EMA13 < EMA55 ->
 *                       bias DOWN. Any other order (ribbons tangled,
 *                       including any equality) -> NO_TRADE.
 *   C2  Trigger (1m)    EMA(5), EMA(7), EMA(13) on 1m candles. A trigger
 *                       fires on the first CLOSED 1m candle where the fast
 *                       ribbon flips into full alignment matching C1's bias:
 *                       the candle is in the full order AND the immediately
 *                       prior 1m candle was NOT (the flip candle — not every
 *                       candle already in alignment). CALL = bullish bias +
 *                       bullish flip; PUT = bearish bias + bearish flip.
 *                       No flip, or flip direction disagreeing with C1 ->
 *                       NO_TRADE.
 *
 * Expiry (NOT a condition — no volatility gate here): the FTT3 ATR-percentile
 * dynamic expiry ladder is reused verbatim per pre-registration — ATR(14) on
 * 1m, percentile against the trailing 100 closed 1m candles, tiers
 * >=75th -> 5m, 25th..75th -> 7m, <25th -> 10m. The ladder decides how long
 * the trade runs, never whether it runs. If the ATR window is not fully
 * populated the expiry is unknowable and the boundary blocks
 * (EXPIRY_INSUFFICIENT) rather than guessing.
 *
 * ── No-lookahead contract (same design as engine.mjs) ───────────────────────
 * A decision for 1m index i may only use: 15m candles fully closed before i's
 * close time, 1m candles at index <= i, and the 1m candle immediately before
 * index i (timestamp-verified: c1[i-1].t === c1[i].t - MS_1M — a source gap
 * means the "immediately prior candle" does not exist and C2 blocks
 * rather than reading an older candle as if it were adjacent). Two value
 * paths exist and MUST agree:
 *   reference path : indicators recomputed on the closed slices (default)
 *   fast path      : caller passes `pre` — causal indicator series computed
 *                    once over the FULL arrays. Causality of EMA/ATR makes
 *                    the paths identical; scripts/ema_ribbon_tests.mjs proves
 *                    the equivalence and the no-lookahead property by
 *                    mutating future candles.
 *
 * Audit convention (same as every prior engine here): conditions are
 * evaluated strictly in order C1 -> C2 -> expiry; the first blocker stops the
 * chain and the audit carries the raw values of every condition evaluated so
 * far, plus the blocking reason. A C1 block carries the 15m ribbon values; a
 * C2 block carries C1 + C2 values.
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 */

import { ema, atr as atrCalc, median, percentileRank } from './indicators.mjs';

export const MS_1M = 60_000;
export const MS_15M = 900_000;

// ── Frozen constants, committed before the first run on the target window ───
export const BIAS_FAST = 5;
export const BIAS_MID = 13;
export const BIAS_SLOW = 55;     // 15m bias ribbon
export const TRIG_FAST = 5;
export const TRIG_MID = 7;
export const TRIG_SLOW = 13;     // 1m trigger ribbon
export const ATR_PERIOD = 14;
export const ATR_WINDOW = 100;   // trailing closed 1m candles for percentile

// Expiry ladder — REUSED from FTT3 (src/strategy/engine.mjs EXPIRY_TIERS),
// byte-identical by construction; the test suite asserts deep equality with
// the FTT3 table so the two copies cannot silently drift.
export const EXPIRY_TIERS = [
  { minPct: 75, minutes: 5 },
  { minPct: 25, minutes: 7 },
  { minPct: 0, minutes: 10 },
];

/** Expiry minutes for an ATR percentile rank (0..100). */
export function expiryForPercentile(pct) {
  for (const tier of EXPIRY_TIERS) if (pct >= tier.minPct) return tier.minutes;
  return 10;
}

/** Ribbon order of three EMA values: 'BULL' | 'BEAR' | 'TANGLED'. */
export function ribbonOrder(fast, mid, slow) {
  if (fast > mid && mid > slow) return 'BULL';
  if (fast < mid && mid < slow) return 'BEAR';
  return 'TANGLED';   // any other order, including any equality
}

/**
 * Evaluate the EMA-ribbon chain for 1m entry index `i` (the last closed 1m
 * candle; entry happens at that candle's close, i.e. `c1[i].t + MS_1M`).
 *
 * @param {Array} c15 full 15m candles ascending (may include future candles)
 * @param {Array} c1  full 1m candles ascending
 * @param {number} i  index into c1 of the entry (last closed 1m) candle
 * @param {object} [pre] optional fast-path series over the FULL arrays:
 *   { ema5_15, ema13_15, ema55_15, ema5_1, ema7_1, ema13_1, atr1 } — all
 *   causal, index-aligned with their arrays.
 * @returns {{ decision:'CALL'|'PUT'|'NO_TRADE', stage:string, reason:string,
 *             audit:object }}
 */
export function evaluateEmaRibbon(c15, c1, i, pre) {
  const audit = { c1: null, c2: null, expiry: null, atr: null };
  const noTrade = (stage, reason) => ({ decision: 'NO_TRADE', stage, reason, audit });

  if (!Number.isInteger(i) || i < 0 || i >= c1.length)
    return noTrade('INPUT', 'C1_INVALID_ENTRY_INDEX');

  const entryCloseT = c1[i].t + MS_1M;

  // Last CLOSED 15m candle (strictly closed before the entry close time).
  // The caller may hint the index via pre.i15 (the harness advances a
  // pointer); the hint is VERIFIED against the closed-candle timestamps and
  // silently dropped if it does not hold — correctness never depends on it.
  let i15 = -1;
  if (pre && Number.isInteger(pre.i15) && pre.i15 >= 0 && pre.i15 < c15.length &&
      c15[pre.i15].t + MS_15M <= entryCloseT &&
      (pre.i15 === c15.length - 1 || c15[pre.i15 + 1].t + MS_15M > entryCloseT)) {
    i15 = pre.i15;
  } else {
    for (let k = c15.length - 1; k >= 0; k--) {
      if (c15[k].t + MS_15M <= entryCloseT) { i15 = k; break; }
    }
  }

  // ── C1: 15m EMA(5/13/55) ribbon bias ──────────────────────────────────────
  let b5, b13, b55;
  if (pre && pre.ema5_15 && pre.ema13_15 && pre.ema55_15) {
    if (i15 < 0) return noTrade('C1', 'C1_INSUFFICIENT_15M');
    b5 = pre.ema5_15[i15]; b13 = pre.ema13_15[i15]; b55 = pre.ema55_15[i15];
  } else {
    const slice = c15.slice(0, i15 + 1);
    const e5 = ema(slice.map(k => k.c), BIAS_FAST);
    const e13 = ema(slice.map(k => k.c), BIAS_MID);
    const e55 = ema(slice.map(k => k.c), BIAS_SLOW);
    b5 = e5[e5.length - 1]; b13 = e13[e13.length - 1]; b55 = e55[e55.length - 1];
  }
  if (b5 === undefined || b13 === undefined || b55 === undefined)
    return noTrade('C1', 'C1_INSUFFICIENT_15M');

  const bias = ribbonOrder(b5, b13, b55);
  audit.c1 = { ema5: b5, ema13: b13, ema55: b55, bias };
  if (bias === 'TANGLED') return noTrade('C1', 'C1_RIBBON_TANGLED');
  const dir = bias === 'BULL' ? 'CALL' : 'PUT';

  // ── C2: 1m EMA(5/7/13) flip trigger ───────────────────────────────────────
  // The "immediately prior candle" must exist in the source: a timestamp gap
  // means it does not, and we block instead of reading an older candle as if
  // it were adjacent (no fabricated adjacency, ever).
  if (i === 0 || c1[i - 1].t !== c1[i].t - MS_1M)
    return noTrade('C2', 'C2_PRIOR_CANDLE_GAP');

  let t5, t7, t13, p5, p7, p13;
  if (pre && pre.ema5_1 && pre.ema7_1 && pre.ema13_1) {
    t5 = pre.ema5_1[i]; t7 = pre.ema7_1[i]; t13 = pre.ema13_1[i];
    p5 = pre.ema5_1[i - 1]; p7 = pre.ema7_1[i - 1]; p13 = pre.ema13_1[i - 1];
  } else {
    const closes = c1.slice(0, i + 1).map(k => k.c);
    const e5 = ema(closes, TRIG_FAST);
    const e7 = ema(closes, TRIG_MID);
    const e13 = ema(closes, TRIG_SLOW);
    const n = closes.length - 1;
    t5 = e5[n]; t7 = e7[n]; t13 = e13[n];
    p5 = n > 0 ? e5[n - 1] : undefined;
    p7 = n > 0 ? e7[n - 1] : undefined;
    p13 = n > 0 ? e13[n - 1] : undefined;
  }
  if (t5 === undefined || t7 === undefined || t13 === undefined ||
      p5 === undefined || p7 === undefined || p13 === undefined)
    return noTrade('C2', 'C2_INSUFFICIENT_1M');

  const cur = ribbonOrder(t5, t7, t13);
  const prev = ribbonOrder(p5, p7, p13);
  const flip = cur === 'BULL' && prev !== 'BULL' ? 'BULLISH'
    : cur === 'BEAR' && prev !== 'BEAR' ? 'BEARISH'
    : 'NONE';
  audit.c2 = { ema5: t5, ema7: t7, ema13: t13, ema5Prev: p5, ema7Prev: p7, ema13Prev: p13, flip };
  if (flip === 'NONE') return noTrade('C2', 'C2_NO_FLIP');
  if ((dir === 'CALL' && flip !== 'BULLISH') || (dir === 'PUT' && flip !== 'BEARISH'))
    return noTrade('C2', 'C2_WRONG_DIRECTION');

  // ── Expiry: reused FTT3 ATR ladder (picks duration, never gates) ──────────
  let atrVal, window;
  if (pre && pre.atr1) {
    atrVal = pre.atr1[i];
    window = [];
    for (let k = Math.max(0, i - ATR_WINDOW + 1); k <= i; k++) {
      const v = pre.atr1[k];
      if (v === undefined) return noTrade('EXPIRY', 'EXPIRY_INSUFFICIENT');
      window.push(v);
    }
  } else {
    const series = atrCalc(c1.slice(0, i + 1), ATR_PERIOD);
    atrVal = series[series.length - 1];
    if (atrVal === undefined) return noTrade('EXPIRY', 'EXPIRY_INSUFFICIENT');
    window = series.slice(Math.max(0, series.length - ATR_WINDOW));
  }
  if (window.length < ATR_WINDOW) return noTrade('EXPIRY', 'EXPIRY_INSUFFICIENT');
  const atrMedian = median(window);
  const pct = percentileRank(window, atrVal);
  audit.atr = { atr: atrVal, atrMedian, atrPercentile: pct, windowLen: window.length };
  const minutes = expiryForPercentile(pct);
  audit.expiry = { minutes, atrPercentile: pct };

  return { decision: dir, stage: 'PASS', reason: 'C1_C2_ALL_PASS', audit };
}

/**
 * Fast-path series for the harness/live use, computed once over the FULL
 * arrays. `windows` = { c15, c1 } ascending.
 */
export function precomputeEmaRibbon(windows) {
  const closes15 = windows.c15.map(k => k.c);
  const closes1 = windows.c1.map(k => k.c);
  return {
    ema5_15: ema(closes15, BIAS_FAST),
    ema13_15: ema(closes15, BIAS_MID),
    ema55_15: ema(closes15, BIAS_SLOW),
    ema5_1: ema(closes1, TRIG_FAST),
    ema7_1: ema(closes1, TRIG_MID),
    ema13_1: ema(closes1, TRIG_SLOW),
    atr1: atrCalc(windows.c1, ATR_PERIOD),
  };
}

/**
 * FTT3 — THE ENTIRE STRATEGY, in one readable file.
 *
 * Three conditions, three timeframes, standard-default indicators, evaluated
 * strictly in order C1 -> C2 -> C3. The first failing condition stops the
 * chain and is reported as the blocking reason together with the raw
 * indicator values behind it. There are no other filters: no grading, no
 * scoring, no session filter, no hidden veto. If a condition passes it can
 * never block later, and nothing else can block at all.
 *
 *   C1  Bias (15m)      EMA(20) vs EMA(50) on the last CLOSED 15m candle.
 *                       EMA20 > EMA50 -> only CALL. EMA20 < EMA50 -> only
 *                       PUT. Equal / undefined -> NO_TRADE.
 *   C2  Confirmation(5m) MACD(12,26,9) line crosses its signal line on the
 *                       last CLOSED 5m candle, in the direction C1 allows.
 *                       Bullish cross required for CALL, bearish for PUT.
 *                       No cross, or wrong direction -> NO_TRADE.
 *   C3  Entry gate (1m) ATR(14) on 1m candles at/above its own trailing
 *                       median over the last 100 closed 1m candles.
 *                       Below the median -> NO_TRADE (market too quiet).
 *
 * Dynamic expiry, computed at entry time from the same 1m ATR series
 * (percentile rank against the trailing 100 closed 1m candles; tiers fixed
 * BEFORE any backtest run and never adjusted afterwards):
 *
 *   ATR percentile >= 75          -> 5 minutes
 *   ATR percentile 25 .. 74.x     -> 7 minutes
 *   ATR percentile < 25           -> 10 minutes
 *
 * ── No-lookahead contract ───────────────────────────────────────────────────
 * A signal for 1m index i may only use: 15m candles fully closed before i's
 * close time, 5m candles fully closed before i's close time, and 1m data at
 * index <= i. This module enforces the contract ITSELF — it slices its own
 * inputs to closed candles only. Two value paths exist and MUST agree:
 *   reference path : indicators recomputed on the closed slices (default)
 *   fast path      : caller passes `pre` — causal indicator series computed
 *                    once over the FULL arrays; the engine only reads them at
 *                    the last-closed index. Causality of EMA/MACD/ATR makes
 *                    the two paths mathematically identical, and
 *                    scripts/strategy_tests.mjs proves the equivalence and
 *                    the no-lookahead property by mutating future candles.
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 *
 * ── Regime-adaptive dispatch (FTT3-R, branch-only addition) ─────────────────
 * evaluateRegimeSignal() computes the market regime FIRST (ADX(14) on the
 * last closed 15m candle — see regime.mjs), then dispatches:
 *   TRENDING   -> evaluateSignal above, byte-for-byte unchanged (Strategy A)
 *   RANGING    -> evaluateMeanReversion (meanReversion.mjs, Strategy B)
 *   TRANSITION -> NO_TRADE (deliberate; neither strategy fires)
 * Every result's audit carries `regime` (adx value + classification) and
 * `strategy` ('TREND' | 'MEANREV' | null) in addition to the existing audit
 * fields. evaluateSignal itself is NOT modified — Strategy A is reused
 * exactly as audited in the FTT3 OOS run.
 */

import {
  ema, macd as macdCalc, atr as atrCalc, median, percentileRank,
  adx as adxCalc, bollinger as bollingerCalc, rsi as rsiCalc,
} from './indicators.mjs';
import { computeRegime, ADX_PERIOD } from './regime.mjs';
import {
  evaluateMeanReversion, BB_PERIOD, BB_MULT, RSI_PERIOD,
} from './meanReversion.mjs';

export const MS_1M = 60_000;
export const MS_5M = 300_000;
export const MS_15M = 900_000;

// ── Fixed constants, committed before the first backtest run ────────────────
export const EMA_FAST = 20;
export const EMA_SLOW = 50;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const ATR_PERIOD = 14;
export const ATR_WINDOW = 100; // trailing closed 1m candles for median + percentile

// Expiry tiers by ATR percentile rank (top-down, first match wins).
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

/**
 * Evaluate the 3-condition chain for 1m entry index `i`.
 *
 * @param {Array} c15 full 15m candles ascending (may include future candles)
 * @param {Array} c5  full 5m candles ascending
 * @param {Array} c1  full 1m candles ascending
 * @param {number} i  index into c1 of the entry (last closed 1m) candle
 * @param {object} [pre] optional fast-path series computed over the FULL
 *   arrays: { ema20_15, ema50_15, macdLine5, macdSig5, atr1 } — each aligned
 *   with its input array, all causal.
 * @returns {{ decision:'CALL'|'PUT'|'NO_TRADE', stage:string, reason:string,
 *             audit:object }}
 *   audit accumulates the raw values of every condition that produced a
 *   verdict, plus the chosen expiry for signals.
 */
export function evaluateSignal(c15, c5, c1, i, pre) {
  const audit = { c1: null, c2: null, c3: null, expiry: null };
  const noTrade = (stage, reason) => ({ decision: 'NO_TRADE', stage, reason, audit });

  if (!Number.isInteger(i) || i < 0 || i >= c1.length)
    return noTrade('INPUT', 'C1_INVALID_ENTRY_INDEX');

  const entryCloseT = c1[i].t + MS_1M;

  // Last CLOSED higher-timeframe candles (strictly closed before entry close).
  let i15 = -1;
  for (let k = c15.length - 1; k >= 0; k--) {
    if (c15[k].t + MS_15M <= entryCloseT) { i15 = k; break; }
  }
  let i5 = -1;
  for (let k = c5.length - 1; k >= 0; k--) {
    if (c5[k].t + MS_5M <= entryCloseT) { i5 = k; break; }
  }

  // A signal can only exist at a 5m boundary: the last closed 5m candle must
  // close exactly at the entry candle's close time. C2's "cross on THE last
  // closed 5m candle" is otherwise meaningless.
  if (i5 === -1 || c5[i5].t + MS_5M !== entryCloseT)
    return noTrade('C0', 'NOT_5M_BOUNDARY');

  // ── C1: 15m EMA(20) vs EMA(50) bias ──────────────────────────────────────
  let v20, v50;
  if (pre && pre.ema20_15 && pre.ema50_15) {
    v20 = pre.ema20_15[i15 >= 0 ? i15 : 0];
    v50 = pre.ema50_15[i15 >= 0 ? i15 : 0];
    if (i15 < 0) { v20 = undefined; v50 = undefined; }
  } else {
    const closes15 = c15.slice(0, i15 + 1).map(k => k.c);
    const e20 = ema(closes15, EMA_FAST);
    const e50 = ema(closes15, EMA_SLOW);
    v20 = e20[e20.length - 1];
    v50 = e50[e50.length - 1];
  }
  if (v20 === undefined || v50 === undefined) return noTrade('C1', 'C1_INSUFFICIENT_15M');
  audit.c1 = { ema20: v20, ema50: v50, bias: v20 > v50 ? 'UP' : v20 < v50 ? 'DOWN' : 'FLAT' };
  let dir;
  if (v20 > v50) dir = 'CALL';
  else if (v20 < v50) dir = 'PUT';
  else return noTrade('C1', 'C1_TREND_UNDEFINED');

  // ── C2: 5m MACD(12,26,9) cross on the last closed 5m candle ─────────────
  let mNow, sNow, mPrev, sPrev;
  if (pre && pre.macdLine5 && pre.macdSig5) {
    mNow = pre.macdLine5[i5]; sNow = pre.macdSig5[i5];
    mPrev = i5 > 0 ? pre.macdLine5[i5 - 1] : undefined;
    sPrev = i5 > 0 ? pre.macdSig5[i5 - 1] : undefined;
  } else {
    const closes5 = c5.slice(0, i5 + 1).map(k => k.c);
    const m = macdCalc(closes5, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
    const n = m.line.length - 1;
    mNow = m.line[n]; sNow = m.signal[n];
    mPrev = n > 0 ? m.line[n - 1] : undefined;
    sPrev = n > 0 ? m.signal[n - 1] : undefined;
  }
  if (mNow === undefined || sNow === undefined || mPrev === undefined || sPrev === undefined)
    return noTrade('C2', 'C2_INSUFFICIENT_5M');
  const bullish = mPrev <= sPrev && mNow > sNow;
  const bearish = mPrev >= sPrev && mNow < sNow;
  audit.c2 = {
    macd: mNow, signal: sNow, macdPrev: mPrev, signalPrev: sPrev,
    cross: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NONE',
  };
  if (!bullish && !bearish) return noTrade('C2', 'C2_NO_CROSS');
  if ((dir === 'CALL' && !bullish) || (dir === 'PUT' && !bearish))
    return noTrade('C2', 'C2_WRONG_DIRECTION');

  // ── C3: 1m ATR(14) at/above its trailing median (last 100 closed) ───────
  let atrVal;
  let window;
  if (pre && pre.atr1) {
    atrVal = pre.atr1[i];
    window = [];
    for (let k = Math.max(0, i - ATR_WINDOW + 1); k <= i; k++) {
      const v = pre.atr1[k];
      if (v === undefined) return noTrade('C3', 'C3_INSUFFICIENT_1M_WINDOW');
      window.push(v);
    }
  } else {
    const c1c = c1.slice(0, i + 1);
    const series = atrCalc(c1c, ATR_PERIOD);
    atrVal = series[series.length - 1];
    if (atrVal === undefined) return noTrade('C3', 'C3_INSUFFICIENT_1M');
    const from = Math.max(0, series.length - ATR_WINDOW);
    window = series.slice(from);
  }
  if (window.length < ATR_WINDOW) return noTrade('C3', 'C3_INSUFFICIENT_1M_WINDOW');
  const med = median(window);
  const pct = percentileRank(window, atrVal);
  audit.c3 = {
    atr: atrVal, atrMedian: med, atrPercentile: pct, windowLen: window.length,
  };
  if (!(atrVal >= med)) return noTrade('C3', 'C3_LOW_VOLATILITY');

  const minutes = expiryForPercentile(pct);
  audit.expiry = { minutes, atrPercentile: pct };
  return { decision: dir, stage: 'PASS', reason: 'C1_C2_C3_ALL_PASS', audit };
}

/**
 * Convenience wrapper for the live worker: pick the last closed 1m index and
 * build the fast-path series from the raw fetched windows in one call.
 * `windows` = { c15, c5, c1 } full fetched arrays (ascending).
 */
export function precompute(windows) {
  const closes15 = windows.c15.map(k => k.c);
  const closes5 = windows.c5.map(k => k.c);
  const m5 = macdCalc(closes5, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
  const bb5 = bollingerCalc(closes5, BB_PERIOD, BB_MULT);
  return {
    ema20_15: ema(closes15, EMA_FAST),
    ema50_15: ema(closes15, EMA_SLOW),
    macdLine5: m5.line,
    macdSig5: m5.signal,
    atr1: atrCalc(windows.c1, ATR_PERIOD),
    // ── regime-adaptive additions (causal series; evaluateSignal ignores
    // them, so the FTT3 fast path is unchanged) ──
    adx15: adxCalc(windows.c15, ADX_PERIOD).adx,
    bbBasis5: bb5.basis,
    bbUpper5: bb5.upper,
    bbLower5: bb5.lower,
    rsi5: rsiCalc(closes5, RSI_PERIOD),
  };
}

/** Index of the last closed 1m candle given "now" (ms). -1 when none. */
export function lastClosedIndex(c1, nowMs) {
  for (let k = c1.length - 1; k >= 0; k--) {
    if (c1[k].t + MS_1M <= nowMs) return k;
  }
  return -1;
}

// ════════════════════════════════════════════════════════════════════════════
// Regime-adaptive dispatch (FTT3-R). PRE-REGISTERED: the regime thresholds,
// both strategies' parameters and the fresh-window split date are frozen in
// the pre-registration commit BEFORE this engine ever runs on fresh data.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Regime-first dispatcher: compute the market regime from the last closed
 * 15m candle (ADX(14), thresholds 25/20 — identical for every pair), then
 * run Strategy A (TRENDING: evaluateSignal, unchanged) or Strategy B
 * (RANGING: mean-reversion D1->D3). TRANSITION is a deliberate NO_TRADE so
 * the engine never flip-flops strategies on small ADX wobbles.
 *
 * The result's audit always carries:
 *   regime   — { adx, regime, i15 } (raw ADX + classification; i15 = index of
 *              the last closed 15m candle used)
 *   strategy — 'TREND' | 'MEANREV' | null (null when the regime itself
 *              blocks: TRANSITION or insufficient 15m history)
 * plus the existing audit fields of whichever strategy path ran.
 *
 * @param {Array} c15 full 15m candles ascending (may include future candles)
 * @param {Array} c5  full 5m candles ascending
 * @param {Array} c1  full 1m candles ascending
 * @param {number} i  index into c1 of the entry (last closed 1m) candle
 * @param {object} [pre] optional fast-path series (see precompute)
 */
export function evaluateRegimeSignal(c15, c5, c1, i, pre) {
  const audit = {
    regime: null, strategy: null,
    c1: null, c2: null, c3: null,
    d1: null, d2: null, d3: null,
    expiry: null,
  };
  const noTrade = (stage, reason) => ({ decision: 'NO_TRADE', stage, reason, audit });

  if (!Number.isInteger(i) || i < 0 || i >= c1.length)
    return noTrade('INPUT', 'REGIME_INVALID_ENTRY_INDEX');

  const entryCloseT = c1[i].t + MS_1M;

  // Last CLOSED 15m candle — same lookup as C1 uses (strictly closed before
  // the entry candle's close time; future candles are never read).
  let i15 = -1;
  for (let k = c15.length - 1; k >= 0; k--) {
    if (c15[k].t + MS_15M <= entryCloseT) { i15 = k; break; }
  }
  if (i15 < 0) {
    audit.regime = { adx: null, regime: null, i15 };
    return noTrade('REGIME', 'REGIME_INSUFFICIENT_15M');
  }

  // ── Regime first, identical for every pair ────────────────────────────────
  const { adx: adxVal, regime } = computeRegime(c15, i15, pre);
  audit.regime = { adx: adxVal, regime: regime ?? null, i15 };
  if (regime === undefined) return noTrade('REGIME', 'REGIME_INSUFFICIENT_15M');
  if (regime === 'TRANSITION') return noTrade('REGIME', 'REGIME_TRANSITION');

  if (regime === 'TRENDING') {
    // Strategy A — evaluateSignal reused byte-for-byte; only the audit is
    // enriched with regime/strategy tags.
    audit.strategy = 'TREND';
    const r = evaluateSignal(c15, c5, c1, i, pre);
    return { decision: r.decision, stage: r.stage, reason: r.reason, audit: { ...audit, ...r.audit } };
  }

  // ── RANGING: Strategy B — mean-reversion D1 -> D2 -> D3 ───────────────────
  audit.strategy = 'MEANREV';
  // Same 5m-boundary gate as Strategy A: the D2 entry trigger IS a 5m close,
  // so a signal can only exist when the last closed 5m candle closes exactly
  // at the entry candle's close time.
  let i5 = -1;
  for (let k = c5.length - 1; k >= 0; k--) {
    if (c5[k].t + MS_5M <= entryCloseT) { i5 = k; break; }
  }
  if (i5 === -1 || c5[i5].t + MS_5M !== entryCloseT)
    return noTrade('C0', 'NOT_5M_BOUNDARY');

  return evaluateMeanReversion(c5, c1, i, i5, pre, audit);
}

/**
 * FTT3-R — Strategy B: mean-reversion (deliverable 2). Fires ONLY when the
 * regime detector says RANGING. Mirrors the shape/logging conventions of
 * engine.mjs (evaluateSignal): strict condition order D1 -> D2 -> D3, first
 * failure stops the chain and is reported with the raw indicator values
 * behind it; every blocking reason is auditable; no other filters exist.
 *
 *   D1  Extension (5m)   Bollinger Bands(20, 2σ) on 5m closes. The "outside"
 *                        candle X — the closed 5m candle BEFORE the trigger —
 *                        must close strictly beyond a band:
 *                        above upper -> overextended up (fade-down candidate)
 *                        below lower -> overextended down (fade-up candidate)
 *                        Band edges are "inside"; strictly beyond is "outside".
 *   D2  Reversal trigger RSI(14) on 5m at X confirms exhaustion (>70 for a
 *                        fade-down, <30 for a fade-up) on that same closed
 *                        candle, AND the next closed 5m candle (the trigger)
 *                        closes back INSIDE the bands — that close is the
 *                        entry trigger. Pre-registered definitional choices:
 *                        "back inside" is judged against the bands computed
 *                        AT the trigger candle (each candle is judged against
 *                        its own bands), edges count as inside, and X and the
 *                        trigger must be adjacent 5m candles (exact 5-minute
 *                        spacing) so "the NEXT closed candle" means literally
 *                        the next one.
 *                        CALL = fade-up  (X below lower band, RSI < 30, snaps
 *                        back inside). PUT = fade-down (mirror).
 *   D3  Entry gate (1m)  IDENTICAL to FTT3's C3 — ATR(14) on 1m at/above its
 *                        own trailing median over the last 100 closed 1m
 *                        candles. Same math, same constants, same semantics
 *                        in both strategies, so "enough movement to trade"
 *                        means the same thing everywhere.
 *
 * Expiry: the shared ATR-percentile ladder (engine.mjs expiryForPercentile) —
 * expiry is about volatility, not which strategy fired.
 *
 * No-lookahead contract: identical to engine.mjs. A signal for 1m index i may
 * only use 5m candles fully closed before i's close time and 1m data at
 * index <= i. The 15m array is never read here at all (Strategy B is
 * 15m-blind — asserted by tests). Reference path recomputes on closed slices;
 * fast path reads causal precomputed series (pre.bbBasis5/bbUpper5/bbLower5/
 * rsi5, pre.atr1) at the last-closed indices. scripts/regime_tests.mjs proves
 * both paths agree and that future candles cannot change the output.
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 */

import {
  bollinger, rsi as rsiCalc, atr as atrCalc, median, percentileRank,
} from './indicators.mjs';
import {
  ATR_PERIOD, ATR_WINDOW, expiryForPercentile, MS_5M,
} from './engine.mjs';

// ── Fixed constants, frozen in the pre-registration commit ──────────────────
export const BB_PERIOD = 20;        // Bollinger lookback on 5m closes
export const BB_MULT = 2;           // 2 population standard deviations
export const RSI_PERIOD = 14;       // Wilder RSI on 5m closes
export const RSI_OVERBOUGHT = 70;   // fade-down exhaustion (mirror: >70)
export const RSI_OVERSOLD = 30;     // fade-up exhaustion (mirror: <30)

/**
 * Evaluate the D-chain for 1m entry index `i`. The caller (the regime
 * dispatcher in engine.mjs) has already verified the 5m boundary gate and
 * passes `i5` = index of the last closed 5m candle (its close time equals
 * c1[i].t + 60_000 exactly).
 *
 * @param {Array}  c5  full 5m candles ascending (may include future candles)
 * @param {Array}  c1  full 1m candles ascending
 * @param {number} i   index into c1 of the entry (last closed 1m) candle
 * @param {number} i5  index into c5 of the trigger (last closed 5m) candle
 * @param {object} [pre] optional fast-path series over the FULL arrays:
 *   { bbBasis5, bbUpper5, bbLower5, rsi5, atr1 } — all causal
 * @param {object} audit the dispatcher's shared audit object — D-conditions
 *   are written into audit.d1 / audit.d2 / audit.d3 / audit.expiry
 * @returns {{ decision:'CALL'|'PUT'|'NO_TRADE', stage:string, reason:string, audit:object }}
 */
export function evaluateMeanReversion(c5, c1, i, i5, pre, audit) {
  const noTrade = (stage, reason) => ({ decision: 'NO_TRADE', stage, reason, audit });

  // ── D1: 5m Bollinger(20, 2σ) extension on candle X = i5 - 1 ──────────────
  const x = i5 - 1;
  if (x < 0) return noTrade('D1', 'D1_INSUFFICIENT_5M');

  let uX, bX, lX, uT, bT, lT, rX;
  if (pre && pre.bbUpper5 && pre.bbLower5 && pre.bbBasis5 && pre.rsi5) {
    uX = pre.bbUpper5[x]; bX = pre.bbBasis5[x]; lX = pre.bbLower5[x];
    uT = pre.bbUpper5[i5]; bT = pre.bbBasis5[i5]; lT = pre.bbLower5[i5];
    rX = pre.rsi5[x];
  } else {
    const closesX = c5.slice(0, x + 1).map(k => k.c);
    const bbX = bollinger(closesX, BB_PERIOD, BB_MULT);
    const nX = bbX.basis.length - 1;
    uX = bbX.upper[nX]; bX = bbX.basis[nX]; lX = bbX.lower[nX];
    const closesT = c5.slice(0, i5 + 1).map(k => k.c);
    const bbT = bollinger(closesT, BB_PERIOD, BB_MULT);
    const nT = bbT.basis.length - 1;
    uT = bbT.upper[nT]; bT = bbT.basis[nT]; lT = bbT.lower[nT];
    const r = rsiCalc(closesX, RSI_PERIOD);
    rX = r[r.length - 1];
  }
  if (uX === undefined || lX === undefined || rX === undefined)
    return noTrade('D1', 'D1_INSUFFICIENT_5M');

  const cX = c5[x].c;
  const overUp = cX > uX;     // strictly beyond the upper band
  const overDown = cX < lX;   // strictly beyond the lower band
  audit.d1 = {
    candleTime: new Date(c5[x].t).toISOString(),
    close: cX, bbUpper: uX, bbBasis: bX, bbLower: lX,
    extension: overUp ? 'ABOVE_UPPER' : overDown ? 'BELOW_LOWER' : 'NONE',
  };
  if (!overUp && !overDown) return noTrade('D1', 'D1_NO_EXTENSION');
  const dir = overDown ? 'CALL' : 'PUT';   // fade-up -> CALL, fade-down -> PUT

  // ── D2: RSI(14) exhaustion at X + snap-back inside on the trigger ────────
  const rsiHot = overDown ? rX < RSI_OVERSOLD : rX > RSI_OVERBOUGHT;
  audit.d2 = {
    rsi: rX,
    rsiThreshold: overDown ? RSI_OVERSOLD : RSI_OVERBOUGHT,
    exhausted: rsiHot,
  };
  if (!rsiHot) return noTrade('D2', 'D2_NO_EXHAUSTION');

  if (c5[i5].t - c5[x].t !== MS_5M) return noTrade('D2', 'D2_NOT_ADJACENT');
  if (uT === undefined || lT === undefined) return noTrade('D2', 'D2_INSUFFICIENT_5M');
  const cT = c5[i5].c;
  const backInside = cT >= lT && cT <= uT;
  audit.d2.triggerClose = cT;
  audit.d2.triggerBbUpper = uT;
  audit.d2.triggerBbBasis = bT;
  audit.d2.triggerBbLower = lT;
  audit.d2.snapBack = backInside ? 'INSIDE' : (cT > uT ? 'ABOVE_UPPER' : 'BELOW_LOWER');
  if (!backInside) return noTrade('D2', 'D2_NO_SNAPBACK');

  // ── D3: 1m ATR(14) gate — exact same math as FTT3's C3 ───────────────────
  let atrVal;
  let window;
  if (pre && pre.atr1) {
    atrVal = pre.atr1[i];
    window = [];
    for (let k = Math.max(0, i - ATR_WINDOW + 1); k <= i; k++) {
      const v = pre.atr1[k];
      if (v === undefined) return noTrade('D3', 'D3_INSUFFICIENT_1M_WINDOW');
      window.push(v);
    }
  } else {
    const c1c = c1.slice(0, i + 1);
    const series = atrCalc(c1c, ATR_PERIOD);
    atrVal = series[series.length - 1];
    if (atrVal === undefined) return noTrade('D3', 'D3_INSUFFICIENT_1M');
    const from = Math.max(0, series.length - ATR_WINDOW);
    window = series.slice(from);
  }
  if (window.length < ATR_WINDOW) return noTrade('D3', 'D3_INSUFFICIENT_1M_WINDOW');
  const med = median(window);
  const pct = percentileRank(window, atrVal);
  audit.d3 = {
    atr: atrVal, atrMedian: med, atrPercentile: pct, windowLen: window.length,
  };
  if (!(atrVal >= med)) return noTrade('D3', 'D3_LOW_VOLATILITY');

  const minutes = expiryForPercentile(pct);
  audit.expiry = { minutes, atrPercentile: pct };
  return { decision: dir, stage: 'PASS', reason: 'D1_D2_D3_ALL_PASS', audit };
}

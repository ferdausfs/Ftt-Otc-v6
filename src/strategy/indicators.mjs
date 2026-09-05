/**
 * FTT3 — standard indicator math. Fresh implementation for the fresh engine.
 * No imports from, and no lineage to, any prior engine's indicator code.
 * Every function is pure and covered by scripts/strategy_tests.mjs against
 * hand-computed fixtures.
 *
 * Conventions:
 *  - EMA seed = SMA of the first `period` values (the textbook convention).
 *  - MACD = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of the line.
 *  - ATR = Wilder's smoothed (RMA) true range, the standard ATR(14).
 *  - All series are ascending, index-aligned with the input array, and
 *    CAUSAL: value at index k depends only on inputs at index <= k. This is
 *    what makes the precomputed fast path in engine.mjs equivalent to the
 *    self-slicing reference path, and what the no-lookahead test proves.
 */

/** Classic EMA. Returns array; elements before the SMA seed are undefined. */
export function ema(values, period) {
  const out = new Array(values.length).fill(undefined);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD. Returns { line, signal } — both index-aligned with `values`;
 * entries before their warmup completes are undefined.
 */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) =>
    ef[i] === undefined || es[i] === undefined ? undefined : ef[i] - es[i],
  );
  const firstValid = line.findIndex(v => v !== undefined);
  const signal = new Array(values.length).fill(undefined);
  if (firstValid !== -1) {
    const sig = ema(line.slice(firstValid), signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i];
  }
  return { line, signal };
}

/** True-range series; the first bar's TR is simply high - low. */
export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const p = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p));
  });
}

/** Wilder ATR (RMA of true range). Undefined before the first full period. */
export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(undefined);
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Median of a numeric array (undefined for empty input). */
export function median(values) {
  if (!values || values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Percent (0..100) of window values <= v. Undefined for empty window. */
export function percentileRank(window, v) {
  if (!window || window.length === 0) return undefined;
  let le = 0;
  for (const x of window) if (x <= v) le++;
  return (le / window.length) * 100;
}

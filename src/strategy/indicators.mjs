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

// ════════════════════════════════════════════════════════════════════════════
// Regime-adaptive additions (FTT3-R). New pure functions only — the FTT3
// functions above are untouched. Same conventions as before: ascending input,
// index-aligned causal output, undefined before warmup completes.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wilder ADX. Returns { adx, plusDI, minusDI, dx } — arrays index-aligned
 * with `candles`, undefined before warmup. Conventions (pre-registered in
 * PRE_REGISTRATION.md, textbook Wilder):
 *   - TR / +DM / -DM defined from index 1 (bar 0 has no prior candle).
 *   - Wilder smoothing: seed = SUM of the first `period` values, landing at
 *     index `period`; step s = s - s/period + v.
 *   - +DI / -DI = 100 * smoothed(DM) / smoothed(TR); 0 when smoothed(TR)=0.
 *   - DX = 100 * |+DI - -DI| / (+DI + -DI); 0 when the denominator is 0.
 *   - ADX seed = mean of DX[period .. 2*period-1] -> first ADX at index
 *     2*period - 1 (27 for the production period 14); Wilder RMA afterwards.
 */
export function adx(candles, period = 14) {
  const n = candles.length;
  const adxA = new Array(n).fill(undefined);
  const pdi = new Array(n).fill(undefined);
  const mdi = new Array(n).fill(undefined);
  const dx = new Array(n).fill(undefined);
  if (period <= 0 || n < 2 * period) return { adx: adxA, plusDI: pdi, minusDI: mdi, dx };

  const tr = trueRange(candles);
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i <= period; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    sTR += tr[i];
    if (up > dn && up > 0) sP += up;
    if (dn > up && dn > 0) sM += dn;
  }
  // First smoothed row (index `period`): emit DI/DX before the step loop so
  // the ADX seed (which reads DX[period..]) sees it.
  if (sTR === 0) { pdi[period] = 0; mdi[period] = 0; dx[period] = 0; }
  else {
    pdi[period] = 100 * sP / sTR;
    mdi[period] = 100 * sM / sTR;
    const sum = pdi[period] + mdi[period];
    dx[period] = sum === 0 ? 0 : 100 * Math.abs(pdi[period] - mdi[period]) / sum;
  }
  for (let i = period + 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const dn = candles[i - 1].l - candles[i].l;
    sTR = sTR - sTR / period + tr[i];
    if (up > dn && up > 0) sP = sP - sP / period + up; else sP = sP - sP / period;
    if (dn > up && dn > 0) sM = sM - sM / period + dn; else sM = sM - sM / period;

    if (sTR === 0) { pdi[i] = 0; mdi[i] = 0; dx[i] = 0; }
    else {
      pdi[i] = 100 * sP / sTR;
      mdi[i] = 100 * sM / sTR;
      const sum = pdi[i] + mdi[i];
      dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi[i] - mdi[i]) / sum;
    }
    if (i < 2 * period - 1) continue;
    if (i === 2 * period - 1) {
      let acc = 0;
      for (let k = i - period + 1; k <= i; k++) acc += dx[k];
      adxA[i] = acc / period;
    } else {
      adxA[i] = (adxA[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx: adxA, plusDI: pdi, minusDI: mdi, dx };
}

/**
 * Wilder RSI. Changes from index 1; average-gain/loss seed = mean of the
 * first `period` changes (first RSI at index `period`), then the Wilder RMA
 * step. avgLoss = 0 -> RSI 100 (50 when avgGain is 0 too — flat, neutral).
 */
export function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(undefined);
  if (period <= 0 || n < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) g += ch; else l -= ch;
  }
  let ag = g / period, al = l / period;
  out[period] = valueRsi(ag, al);
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (ch > 0 ? ch : 0)) / period;
    al = (al * (period - 1) + (ch < 0 ? -ch : 0)) / period;
    out[i] = valueRsi(ag, al);
  }
  return out;
}
function valueRsi(ag, al) {
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

/**
 * Bollinger Bands. Rolling mean +/- mult * POPULATION standard deviation
 * (dividing by `period`, the convention every major platform uses for BB)
 * over the trailing `period` closes. First valid value at index period-1.
 */
export function bollinger(closes, period = 20, mult = 2) {
  const n = closes.length;
  const basis = new Array(n).fill(undefined);
  const upper = new Array(n).fill(undefined);
  const lower = new Array(n).fill(undefined);
  if (period <= 1 || n < period) return { basis, upper, lower };
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i < period - 1) continue;
    const mean = sum / period;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = closes[k] - mean;
      sq += d * d;
    }
    const sd = Math.sqrt(sq / period);
    basis[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { basis, upper, lower };
}

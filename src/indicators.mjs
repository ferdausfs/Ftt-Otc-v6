/**
 * FTT Engine v2 — indicator math.
 *
 * Ported VERBATIM from Ftt-Otc-v6/src/indicators/math.js (calculateEMA,
 * calculateRSI, calculateSMA). Reused because the math is standard and
 * verified (EMA seeded with SMA, k = 2/(period+1); RSI = Wilder smoothing).
 * Only the two indicators the 4-condition strategy actually needs are here —
 * the v6 library's 12+ indicators (MACD, ADX, pivots, CCI, MFI, ...) are
 * deliberately NOT carried over.
 *
 * All functions are causal: value at index i depends only on data ≤ i.
 * A no-lookahead property test in tests/ proves this for the strategy level.
 */

export function calculateSMA(data, period) {
  if (!data || data.length < period) return new Array(data ? data.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  r.push(s / period);
  for (let i = period; i < data.length; i++) { s += data[i] - data[i - period]; r.push(s / period); }
  return r;
}

export function calculateEMA(data, period) {
  if (!data || data.length === 0) return [];
  if (data.length < period) return new Array(data.length).fill(null);
  const k = 2 / (period + 1);
  const r = new Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  let ema = s / period;
  r.push(ema);
  for (let i = period; i < data.length; i++) { ema = data[i] * k + ema * (1 - k); r.push(ema); }
  return r;
}

export function calculateRSI(data, period = 14) {
  if (!data || data.length < period + 1) return new Array(data ? data.length : 0).fill(null);
  const ch = [];
  for (let i = 1; i < data.length; i++) ch.push(data[i] - data[i - 1]);
  let ag = 0; let al = 0;
  for (let i = 0; i < period; i++) { if (ch[i] > 0) ag += ch[i]; else al += Math.abs(ch[i]); }
  ag /= period; al /= period;
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

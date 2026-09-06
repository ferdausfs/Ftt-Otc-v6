/**
 * TASK 24 — ML FEASIBILITY: feature math library (pure, causal, testable).
 *
 * Reuses src/strategy/indicators.mjs (ema, macd, trueRange, atr) — the same
 * conventions the repo's engines use (EMA seeded by SMA of the first
 * `period` values; Wilder ATR). RSI (Wilder) and Bollinger Bands are
 * implemented here in the same causal, index-aligned style: value at index i
 * depends ONLY on inputs at index <= i. This is the property the leakage
 * tests prove (mutation + truncated-recompute), not assume.
 *
 * Row assembly (features_lib.featureRow) is a pure function of:
 *   1m arrays + index i (candle open t = m1t[i]; decision instant t+60s),
 *   the last CLOSED 15m candle index (close time T+15m <= t+60s),
 *   funding events up to the decision instant.
 * Nothing global — no centering/scaling across the dataset — so a row
 * computed from truncated data equals the row from full data.
 */
import { ema, macd, atr } from '../../src/strategy/indicators.mjs';

export const FEATURE_NAMES = [
  // 1m block (22)
  'f_ret_1m', 'f_ret_5m', 'f_ret_15m', 'f_ret_60m', 'f_ret_240m', 'f_ret_1440m',
  'f_rvol_15', 'f_rvol_60', 'f_rvol_240',
  'f_atr14_1m_n', 'f_rsi14_1m',
  'f_macd_line_n', 'f_macd_sig_n', 'f_macd_hist_n',
  'f_bb_w_1m', 'f_bb_pos_1m',
  'f_ed5', 'f_ed13', 'f_ed55', 'f_s5_13', 'f_s13_55',
  'f_volz_1440',
  // 15m block (13) — all normalized by the CURRENT 1m close
  'f15_rsi14', 'f15_macd_hist_n', 'f15_atr14_n', 'f15_bb_w', 'f15_bb_pos',
  'f15_ed5', 'f15_ed13', 'f15_ed55', 'f15_s5_13', 'f15_s13_55',
  'f15_ret_1b', 'f15_ret_4b', 'f15_volz_96',
  // funding (3) / calendar (2) / pair (1)
  'f_fund_last', 'f_fund_roc', 'f_fund_hours_since',
  'f_utc_hour', 'f_dow', 'f_pair_id',
];
export const N_FEATURES = FEATURE_NAMES.length; // 41

// ── fresh causal indicators (indicators.mjs style) ───────────────────────────

/** Wilder RSI. undefined before index `period` (SMA-seeded first averages). */
export function rsiWilder(closes, period = 14) {
  const out = new Array(closes.length).fill(undefined);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + gain) / period;
    al = (al * (period - 1) + loss) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** Bollinger Bands (population std). Returns {up, lo}; undefined before period-1. */
export function bollinger(closes, period = 20, mult = 2) {
  const up = new Array(closes.length).fill(undefined);
  const lo = new Array(closes.length).fill(undefined);
  const cs = prefixSum(closes), cs2 = prefixSum2(closes);
  for (let i = period - 1; i < closes.length; i++) {
    const { mean, std } = meanStdPrefix(cs, cs2, i - period + 1, i);
    up[i] = mean + mult * std;
    lo[i] = mean - mult * std;
  }
  return { up, lo };
}

// ── prefix-sum helpers (O(1) rolling mean/std, population ddof=0) ───────────
export function prefixSum(a) {
  const s = new Float64Array(a.length);
  let acc = 0;
  for (let i = 0; i < a.length; i++) { acc += a[i]; s[i] = acc; }
  return s;
}
export function prefixSum2(a) {
  const s = new Float64Array(a.length);
  let acc = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i]; acc += v * v; s[i] = acc; }
  return s;
}
export function meanStdPrefix(s, s2, from, to) {
  const n = to - from + 1;
  const sum = s[to] - (from > 0 ? s[from - 1] : 0);
  const sum2 = s2[to] - (from > 0 ? s2[from - 1] : 0);
  const mean = sum / n;
  const varr = Math.max(0, sum2 / n - mean * mean); // clamp fp noise
  return { mean, std: Math.sqrt(varr) };
}

// ── the pure row assembler ───────────────────────────────────────────────────
/**
 * @param s pooled series object:
 *   { m1t, m1c, m1v, ema5, ema13, ema55, macdLine, macdSig, atr14, rsi14, bbUp, bbLo,
 *     cs, cs2 (prefix of closes), rs, rs2 (prefix of 1m returns), vs, vs2 (prefix of volumes),
 *     m15t, m15c, m15ema5, m15ema13, m15ema55, m15macdLine, m15macdSig, m15atr14, m15rsi14,
 *     m15bbUp, m15bbLo, m15cs, m15cs2, m15rs, m15rs2, m15vs, m15vs2,
 *     fundT, fundRate }
 * @param i index into the 1m series (candle open t = m1t[i])
 * @param j15 index into the 15m series of the last CLOSED 15m candle
 *        (caller guarantees close time m15t[j15]+900000 <= m1t[i]+60000)
 * @param fundIdx index of the latest funding event with t <= decision instant
 * @param pairId 0..3
 * @returns Float64Array(N_FEATURES) or null if any input undefined (row invalid)
 */
export function featureRow(s, i, j15, fundIdx, pairId) {
  const t = s.m1t[i];
  const c = s.m1c[i];
  if (!Number.isFinite(c) || c <= 0) return null;

  const ret = (k) => (i - k < 0 ? undefined : c / s.m1c[i - k] - 1);
  const rvol = (k) => (i < k ? undefined : meanStdPrefix(s.rs, s.rs2, i - k + 1, i).std);

  // rolling volume z over 1440 (needs full window incl. i)
  const vz = i < 1439 ? undefined
    : (() => { const { mean, std } = meanStdPrefix(s.vs, s.vs2, i - 1439, i); return std === 0 ? 0 : (s.m1v[i] - mean) / std; })();

  const macdL = s.macdLine[i], macdS = s.macdSig[i];
  const bbU = s.bbUp[i], bbL = s.bbLo[i];

  // 15m block (j15 guaranteed valid by caller)
  const c15 = s.m15c[j15];
  const m15L = s.m15macdLine[j15], m15S = s.m15macdSig[j15];
  const bb15U = s.m15bbUp[j15], bb15L = s.m15bbLo[j15];
  const r1 = j15 >= 1 ? c15 / s.m15c[j15 - 1] - 1 : undefined;
  const r4 = j15 >= 4 ? c15 / s.m15c[j15 - 4] - 1 : undefined;
  const vz15 = j15 < 95 ? undefined
    : (() => { const { mean, std } = meanStdPrefix(s.m15vs, s.m15vs2, j15 - 95, j15); return std === 0 ? 0 : (s.m15v[j15] - mean) / std; })();

  // funding as-of decision instant (fundIdx = latest event index, may be -1)
  const fLast = fundIdx >= 0 ? s.fundRate[fundIdx] : undefined;
  const fRoc = fundIdx >= 1 ? s.fundRate[fundIdx] - s.fundRate[fundIdx - 1] : undefined;
  const fHours = fundIdx >= 0 ? (t + 60000 - s.fundT[fundIdx]) / 3600000 : undefined;

  const d = new Date(t + 60000);

  const out = new Float64Array(N_FEATURES);
  const put = (k, v) => {
    if (!Number.isFinite(v)) throw new Error(`feature ${FEATURE_NAMES[k]} non-finite at i=${i} (fail loudly, no NaN rows)`);
    out[k] = v;
  };
  put(0, ret(1)); put(1, ret(5)); put(2, ret(15)); put(3, ret(60)); put(4, ret(240)); put(5, ret(1440));
  put(6, rvol(15)); put(7, rvol(60)); put(8, rvol(240));
  put(9, s.atr14[i] / c); put(10, s.rsi14[i]);
  put(11, macdL / c); put(12, macdS / c); put(13, (macdL - macdS) / c);
  put(14, (bbU - bbL) / ((bbU + bbL) / 2)); put(15, bbU === bbL ? 0.5 : (c - bbL) / (bbU - bbL));
  put(16, (s.ema5[i] - c) / c); put(17, (s.ema13[i] - c) / c); put(18, (s.ema55[i] - c) / c);
  put(19, (s.ema5[i] - s.ema13[i]) / c); put(20, (s.ema13[i] - s.ema55[i]) / c);
  put(21, vz);
  put(22, s.m15rsi14[j15]); put(23, (m15L - m15S) / c); put(24, s.m15atr14[j15] / c);
  put(25, (bb15U - bb15L) / ((bb15U + bb15L) / 2)); put(26, bb15U === bb15L ? 0.5 : (c15 - bb15L) / (bb15U - bb15L));
  put(27, (s.m15ema5[j15] - c) / c); put(28, (s.m15ema13[j15] - c) / c); put(29, (s.m15ema55[j15] - c) / c);
  put(30, (s.m15ema5[j15] - s.m15ema13[j15]) / c); put(31, (s.m15ema13[j15] - s.m15ema55[j15]) / c);
  put(32, r1); put(33, r4); put(34, vz15);
  put(35, fLast); put(36, fRoc); put(37, fHours);
  put(38, d.getUTCHours()); put(39, d.getUTCDay()); put(40, pairId);
  return out;
}

/**
 * Last CLOSED 15m candle index at decision instant t+60s: largest j with
 * m15t[j] + 900000 <= t + 60000, i.e. m15t[j] <= t - 840000. Returns -1 if none.
 * `from` = lower search bound (monotonic pointer from the caller is fine).
 */
export function findClosed15(m15t, t, from = 0) {
  const limit = t - 840000;
  let lo = from, hi = m15t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m15t[mid] <= limit) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Fixed-time label for horizon H (minutes) at 1m index i: compares close of
 * the candle opening at t+H*60000 with close[t] (entry at candle close — the
 * project-wide convention). Returns 1 (up), 0 (down), 2 (exact tie), or -1
 * (target candle missing — never fabricated).
 */
export function labelAt(m1t, m1c, i, hMin) {
  const target = m1t[i] + hMin * 60000;
  let lo = i + 1, hi = m1t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m1t[mid] === target) { ans = mid; break; }
    if (m1t[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  if (ans === -1) return -1;
  const d = m1c[ans] - m1c[i];
  return d > 0 ? 1 : d < 0 ? 0 : 2;
}

/** Latest funding event index with fundT[idx] <= t (decision-instant as-of). -1 if none. */
export function fundAsOf(fundT, t) {
  let lo = 0, hi = fundT.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fundT[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Precompute all causal series for a pair. Returns the pooled series object. */
export function buildSeries(m1, m15, fundT, fundRate) {
  const m1t = m1.t, m1c = m1.c, m1v = m1.v;
  const m1r = new Float64Array(m1c.length);
  for (let i = 1; i < m1c.length; i++) m1r[i] = m1c[i] / m1c[i - 1] - 1;

  const e5 = ema(Array.from(m1c), 5), e13 = ema(Array.from(m1c), 13), e55 = ema(Array.from(m1c), 55);
  const mac1 = macd(Array.from(m1c), 12, 26, 9);
  const candles1 = m1t.map((t, i) => ({ t, h: m1.h[i], l: m1.l[i], c: m1c[i] }));
  const a14 = atr(candles1, 14);
  const rsi14 = rsiWilder(Array.from(m1c), 14);
  const bb1 = bollinger(Array.from(m1c), 20, 2);

  const m15c15 = Array.from(m15.c);
  const e5b = ema(m15c15, 5), e13b = ema(m15c15, 13), e55b = ema(m15c15, 55);
  const mac15 = macd(m15c15, 12, 26, 9);
  const candles15 = m15.t.map((t, i) => ({ t, h: m15.h[i], l: m15.l[i], c: m15.c[i] }));
  const a15 = atr(candles15, 14);
  const rsi15 = rsiWilder(m15c15, 14);
  const bb15 = bollinger(m15c15, 20, 2);
  const m15r = new Float64Array(m15.c.length);
  for (let i = 1; i < m15.c.length; i++) m15r[i] = m15.c[i] / m15.c[i - 1] - 1;

  return {
    m1t, m1c, m1v, m1h: m1.h, m1l: m1.l,
    ema5: e5, ema13: e13, ema55: e55, macdLine: mac1.line, macdSig: mac1.signal,
    atr14: a14, rsi14, bbUp: bb1.up, bbLo: bb1.lo,
    cs: prefixSum(m1c), cs2: prefixSum2(m1c), rs: prefixSum(m1r), rs2: prefixSum2(m1r),
    vs: prefixSum(m1v), vs2: prefixSum2(m1v),
    m15t: m15.t, m15c: m15.c, m15v: m15.v,
    m15ema5: e5b, m15ema13: e13b, m15ema55: e55b, m15macdLine: mac15.line, m15macdSig: mac15.signal,
    m15atr14: a15, m15rsi14: rsi15, m15bbUp: bb15.up, m15bbLo: bb15.lo,
    m15cs: prefixSum(m15.c), m15cs2: prefixSum2(m15.c), m15rs: prefixSum(m15r), m15rs2: prefixSum2(m15r),
    m15vs: prefixSum(m15.v), m15vs2: prefixSum2(m15.v),
    fundT, fundRate,
  };
}

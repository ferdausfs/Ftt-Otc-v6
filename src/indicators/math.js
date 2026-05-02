import { CONFIG } from '../config.js';

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

export function calculateMACD(data) {
  if (!data || data.length === 0) return { macdLine: [], signalLine: [], histogram: [] };
  const e12 = calculateEMA(data, 12);
  const e26 = calculateEMA(data, 26);
  const ml  = e12.map((v, i) => (v === null || e26[i] === null) ? null : v - e26[i]);
  const vals = []; const idxs = [];
  ml.forEach((v, i) => { if (v !== null) { vals.push(v); idxs.push(i); } });
  const se = calculateEMA(vals, 9);
  const sl = new Array(ml.length).fill(null);
  idxs.forEach((idx, j) => { sl[idx] = se[j]; });
  const hist = ml.map((v, i) => (v === null || sl[i] === null) ? null : v - sl[i]);
  return { macdLine: ml, signalLine: sl, histogram: hist };
}

export function calculateATR(candles, period = 14) {
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
  for (let i = period + 1; i < candles.length; i++) { atr = (atr * (period - 1) + tr[i]) / period; r.push(atr); }
  return r;
}

export function calculateBollingerBands(data, period = 20, mult = 2) {
  if (!data || data.length === 0) return { upper:[], middle:[], lower:[], bandwidth:[], percentB:[] };
  const n = data.length;
  const u = new Array(n).fill(null); const m = new Array(n).fill(null);
  const l = new Array(n).fill(null); const bw = new Array(n).fill(null);
  const pb = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += data[j];
    const sma = s / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += Math.pow(data[j] - sma, 2);
    const sd = Math.sqrt(sq / period);
    m[i] = sma; u[i] = sma + mult * sd; l[i] = sma - mult * sd;
    bw[i] = sma > 0 ? ((u[i] - l[i]) / sma) * 100 : 0;
    const rng = u[i] - l[i];
    pb[i] = rng > 0 ? (data[i] - l[i]) / rng : 0.5;
  }
  return { upper: u, middle: m, lower: l, bandwidth: bw, percentB: pb };
}

export function calculateStochastic(candles, kP = 14, sK = 3, sD = 3) {
  if (!candles || candles.length < kP) return { k: new Array(candles ? candles.length : 0).fill(null), d: [] };
  const rawK = new Array(kP - 1).fill(null);
  for (let i = kP - 1; i < candles.length; i++) {
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low  < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    rawK.push(rng > 0 ? ((candles[i].close - lo) / rng) * 100 : 50);
  }
  const validRawK = []; const validIdxK = [];
  for (let i = 0; i < rawK.length; i++) { if (rawK[i] !== null) { validRawK.push(rawK[i]); validIdxK.push(i); } }
  const smoothedK = calculateSMA(validRawK, sK);
  const k = new Array(rawK.length).fill(null);
  for (let i = 0; i < smoothedK.length; i++) { if (smoothedK[i] !== null) k[validIdxK[i]] = smoothedK[i]; }
  const validK = []; const validIdxD = [];
  for (let i = 0; i < k.length; i++) { if (k[i] !== null) { validK.push(k[i]); validIdxD.push(i); } }
  const smoothedD = calculateSMA(validK, sD);
  const d = new Array(k.length).fill(null);
  for (let i = 0; i < smoothedD.length; i++) { if (smoothedD[i] !== null) d[validIdxD[i]] = smoothedD[i]; }
  return { k, d };
}

export function calculateADX(candles, period = 14) {
  const n = candles ? candles.length : 0;
  const empty = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n < period * 2 + 1) return empty;
  const pDM = [0]; const mDM = [0]; const tr = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    const h = candles[i].high; const l = candles[i].low; const pc = candles[i - 1].close;
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
  const sTR = ws(tr, period); const sPDM = ws(pDM, period); const sMDM = ws(mDM, period);
  const plusDI = new Array(n).fill(null); const minusDI = new Array(n).fill(null); const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (sTR[i] && sTR[i] > 0) {
      plusDI[i]  = (sPDM[i] / sTR[i]) * 100;
      minusDI[i] = (sMDM[i] / sTR[i]) * 100;
      const ds = plusDI[i] + minusDI[i];
      dx[i] = ds > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / ds) * 100 : 0;
    }
  }
  const adx = new Array(n).fill(null);
  let adxS = 0; let adxC = 0; let adxI = -1;
  for (let i = period; i < n; i++) {
    if (dx[i] !== null) {
      adxS += dx[i]; adxC++;
      if (adxC === period) { adx[i] = adxS / period; adxI = i; break; }
    }
  }
  if (adxI > 0) {
    for (let i = adxI + 1; i < n; i++) {
      if (dx[i] !== null && adx[i - 1] !== null) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx, plusDI, minusDI };
}

export function calculateWilliamsR(candles, period = 14) {
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low  < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    r.push(rng > 0 ? ((hi - candles[i].close) / rng) * -100 : -50);
  }
  return r;
}

export function calculateCCI(candles, period = 20) {
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
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

export function calculateMFI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const mf = candles.map((c, i) => tp[i] * c.volume);
  const r = new Array(period).fill(null);
  for (let i = period; i < candles.length; i++) {
    let pos = 0; let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) pos += mf[j];
      else if (tp[j] < tp[j - 1]) neg += mf[j];
    }
    r.push(neg > 0 ? 100 - 100 / (1 + pos / neg) : 100);
  }
  return r;
}

export function calculatePivotPoints(candles) {
  if (!candles || candles.length < 2) return { pivot:null, r1:null, r2:null, r3:null, s1:null, s2:null, s3:null };
  const lb = Math.min(20, candles.length - 1);
  const sc = candles.slice(-lb - 1, -1);
  let sh = -Infinity; let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (const c of sc) { if (c.high > sh) sh = c.high; if (c.low < sl) sl = c.low; }
  const p = (sh + sl + scl) / 3;
  const rng = sh - sl;
  return {
    pivot: p, r1: 2*p - sl, r2: p + rng, r3: sh + 2*(p - sl),
    s1: 2*p - sh, s2: p - rng, s3: sl - 2*(sh - p),
  };
}

export function calculateCamarillaPivots(candles) {
  if (!candles || candles.length < 2) return null;
  const lb  = Math.min(20, candles.length - 1);
  const sc  = candles.slice(-lb - 1, -1);
  let sh = -Infinity; let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (let i = 0; i < sc.length; i++) {
    if (sc[i].high > sh) sh = sc[i].high;
    if (sc[i].low  < sl) sl = sc[i].low;
  }
  const rng = sh - sl;
  return {
    h4: scl + rng * 1.1 / 2, h3: scl + rng * 1.1 / 4,
    h2: scl + rng * 1.1 / 6, h1: scl + rng * 1.1 / 12,
    l1: scl - rng * 1.1 / 12, l2: scl - rng * 1.1 / 6,
    l3: scl - rng * 1.1 / 4,  l4: scl - rng * 1.1 / 2,
    close: scl,
  };
}

export function scoreCamarillaLevels(camPivots, lastClose, atr) {
  if (!camPivots || !lastClose || !atr || atr <= 0) return { up: 0, down: 0, level: 'NONE' };
  const thresh = atr * 0.4;
  let up = 0; let down = 0; let level = 'NONE';
  if (Math.abs(lastClose - camPivots.l4) < thresh)      { up += 1.8; level = 'L4_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l3) < thresh) { up += 1.3; level = 'L3_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l2) < thresh) { up += 0.7; level = 'L2_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l1) < thresh) { up += 0.4; level = 'L1_SUPPORT'; }
  if (Math.abs(lastClose - camPivots.h4) < thresh)      { down += 1.8; level = 'H4_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h3) < thresh) { down += 1.3; level = 'H3_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h2) < thresh) { down += 0.7; level = 'H2_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h1) < thresh) { down += 0.4; level = 'H1_RESISTANCE'; }
  return { up, down, level };
}

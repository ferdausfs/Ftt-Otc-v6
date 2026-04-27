// ============================================================
// TECHNICAL INDICATORS LIBRARY
// SMA, EMA, RSI, MACD, ATR, Bollinger Bands, Stochastic,
// ADX (+DI), Williams %R, CCI, MFI, Pivot Points
// ============================================================
import { CONFIG, ASSET_TYPE } from '../config/trading.js';

// ============================================
// TECHNICAL INDICATORS LIBRARY
// ============================================

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

function calculateRSI(data, period) {
  if (!period) period = 14;
  if (!data || data.length < period + 1) {
    return new Array(data ? data.length : 0).fill(null);
  }
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
  const ml = e12.map(function (v, i) {
    return (v === null || e26[i] === null) ? null : v - e26[i];
  });
  const vals = [];
  const idxs = [];
  ml.forEach(function (v, i) {
    if (v !== null) { vals.push(v); idxs.push(i); }
  });
  const se = calculateEMA(vals, 9);
  const sl = new Array(ml.length).fill(null);
  idxs.forEach(function (idx, j) { sl[idx] = se[j]; });
  const hist = ml.map(function (v, i) {
    return (v === null || sl[i] === null) ? null : v - sl[i];
  });
  return { macdLine: ml, signalLine: sl, histogram: hist };
}

function calculateATR(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period + 1) {
    return new Array(candles ? candles.length : 0).fill(null);
  }
  const tr = [null];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
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

function calculateBollingerBands(data, period, mult) {
  if (!period) period = 20;
  if (!mult) mult = 2;
  if (!data || data.length === 0) {
    return { upper: [], middle: [], lower: [], bandwidth: [], percentB: [] };
  }
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
    bw[i] = sma > 0 ? ((u[i] - l[i]) / sma) * 100 : 0;
    const rng = u[i] - l[i];
    pb[i] = rng > 0 ? (data[i] - l[i]) / rng : 0.5;
  }
  return { upper: u, middle: m, lower: l, bandwidth: bw, percentB: pb };
}

function calculateStochastic(candles, kP, sK, sD) {
  if (!kP) kP = 14;
  if (!sK) sK = 3;
  if (!sD) sD = 3;
  if (!candles || candles.length < kP) {
    return { k: new Array(candles ? candles.length : 0).fill(null), d: [] };
  }
  const rawK = new Array(kP - 1).fill(null);
  for (let i = kP - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    rawK.push(rng > 0 ? ((candles[i].close - lo) / rng) * 100 : 50);
  }

  const validRawK = [];
  const validIdxK = [];
  for (let i = 0; i < rawK.length; i++) {
    if (rawK[i] !== null) { validRawK.push(rawK[i]); validIdxK.push(i); }
  }
  const smoothedK = calculateSMA(validRawK, sK);
  const k = new Array(rawK.length).fill(null);
  for (let i = 0; i < smoothedK.length; i++) {
    if (smoothedK[i] !== null) k[validIdxK[i]] = smoothedK[i];
  }

  const validK = [];
  const validIdxD = [];
  for (let i = 0; i < k.length; i++) {
    if (k[i] !== null) { validK.push(k[i]); validIdxD.push(i); }
  }
  const smoothedD = calculateSMA(validK, sD);
  const d = new Array(k.length).fill(null);
  for (let i = 0; i < smoothedD.length; i++) {
    if (smoothedD[i] !== null) d[validIdxD[i]] = smoothedD[i];
  }

  return { k: k, d: d };
}

function calculateADX(candles, period) {
  if (!period) period = 14;
  const n = candles ? candles.length : 0;
  if (n < period * 2 + 1) {
    return {
      adx: new Array(n).fill(null),
      plusDI: new Array(n).fill(null),
      minusDI: new Array(n).fill(null),
    };
  }

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

  return { adx: adx, plusDI: plusDI, minusDI: minusDI };
}

function calculateWilliamsR(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const r = new Array(period - 1).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity; let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    const rng = hi - lo;
    r.push(rng > 0 ? ((hi - candles[i].close) / rng) * -100 : -50);
  }
  return r;
}

function calculateCCI(candles, period) {
  if (!period) period = 20;
  if (!candles || candles.length < period) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map(function (c) { return (c.high + c.low + c.close) / 3; });
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

function calculateMFI(candles, period) {
  if (!period) period = 14;
  if (!candles || candles.length < period + 1) return new Array(candles ? candles.length : 0).fill(null);
  const tp = candles.map(function (c) { return (c.high + c.low + c.close) / 3; });
  const mf = candles.map(function (c, i) { return tp[i] * c.volume; });
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

function calculatePivotPoints(candles) {
  if (!candles || candles.length < 2) {
    return { pivot: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
  }
  const lb = Math.min(20, candles.length - 1);
  const sc = candles.slice(-lb - 1, -1);
  let sh = -Infinity; let sl = Infinity;
  const scl = sc[sc.length - 1].close;
  for (const c of sc) {
    if (c.high > sh) sh = c.high;
    if (c.low < sl) sl = c.low;
  }
  const p = (sh + sl + scl) / 3;
  const rng = sh - sl;
  return {
    pivot: p, r1: 2 * p - sl, r2: p + rng, r3: sh + 2 * (p - sl),
    s1: 2 * p - sh, s2: p - rng, s3: sl - 2 * (sh - p),
  };
}

// ============================================
// CALCULATE ALL INDICATORS
// ============================================

function calculateAllIndicators(candles) {
  const closes = candles.map(function (c) { return c.close; });
  const atrArr  = calculateATR(candles, CONFIG.ATR_PERIOD);
  const atrLast = atrArr[atrArr.length - 1] || null;
  return {
    ema5:       calculateEMA(closes, 5),
    ema10:      calculateEMA(closes, 10),
    ema20:      calculateEMA(closes, 20),
    sma50:      calculateSMA(closes, 50),
    rsi:        calculateRSI(closes, CONFIG.RSI_PERIOD),
    macd:       calculateMACD(closes),
    atr:        atrArr,
    bollinger:  calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV),
    stochastic: calculateStochastic(candles, CONFIG.STOCH_PERIOD, CONFIG.STOCH_SMOOTH_K, CONFIG.STOCH_SMOOTH_D),
    adx:        calculateADX(candles, CONFIG.ADX_PERIOD),
    williamsR:  calculateWilliamsR(candles, CONFIG.WILLIAMS_PERIOD),
    cci:        calculateCCI(candles, CONFIG.CCI_PERIOD),
    mfi:        calculateMFI(candles, CONFIG.MFI_PERIOD),
    pivots:     calculatePivotPoints(candles),
    camarilla:  calculateCamarillaPivots(candles),   // [v6.8.0] P5
    patterns:   detectCandlestickPatterns(candles),
    sr:         detectSRLevels(candles, atrLast),
    fvg:        detectFVG(candles),
  };
}

export {
  calculateSMA, calculateEMA, calculateRSI, calculateMACD,
  calculateATR, calculateBollingerBands, calculateStochastic,
  calculateADX, calculateWilliamsR, calculateCCI, calculateMFI,
  calculatePivotPoints, calculateAllIndicators,
};

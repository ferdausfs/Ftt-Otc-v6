// ============================================================
// DIVERGENCE DETECTION — RSI & MACD
// Bullish/Bearish divergence with confirmation logic
// ============================================================
import { CONFIG } from '../config/trading.js';

// ============================================
// DIVERGENCE DETECTION
// ============================================

function detectRSIDivergence(candles, rsiVals, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !rsiVals || candles.length < lookback) return null;
  const n = candles.length; const st = n - lookback;
  const pL = []; const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (rsiVals[i] === null) continue;
    if (candles[i].low <= candles[i-1].low && candles[i].low <= candles[i-2].low &&
        candles[i].low <= candles[i+1].low && candles[i].low <= candles[i+2].low)
      pL.push({ idx: i, price: candles[i].low, rsi: rsiVals[i] });
    if (candles[i].high >= candles[i-1].high && candles[i].high >= candles[i-2].high &&
        candles[i].high >= candles[i+1].high && candles[i].high >= candles[i+2].high)
      pH.push({ idx: i, price: candles[i].high, rsi: rsiVals[i] });
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1]; const p = pL[pL.length - 2];
    if (r.price < p.price && r.rsi > p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close > lc.open;
      return { type: 'BULLISH_RSI_DIVERGENCE', direction: 'BUY', strength: confirmed ? 2.0 : 1.0, confirmed: confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1]; const p = pH[pH.length - 2];
    if (r.price > p.price && r.rsi < p.rsi && r.idx - p.idx >= CONFIG.DIVERGENCE_MIN_BARS) {
      const lc = candles[n - 1];
      const confirmed = lc.close < lc.open;
      return { type: 'BEARISH_RSI_DIVERGENCE', direction: 'SELL', strength: confirmed ? 2.0 : 1.0, confirmed: confirmed };
    }
  }
  return null;
}

function detectMACDDivergence(candles, hist, lookback) {
  if (!lookback) lookback = 30;
  if (!candles || !hist || candles.length < lookback) return null;
  const n = candles.length; const st = n - lookback;
  const pL = []; const pH = [];

  for (let i = st + 2; i < n - 2; i++) {
    if (hist[i] === null) continue;
    if (candles[i].low <= candles[i-1].low && candles[i].low <= candles[i+1].low)
      pL.push({ idx: i, price: candles[i].low, macd: hist[i] });
    if (candles[i].high >= candles[i-1].high && candles[i].high >= candles[i+1].high)
      pH.push({ idx: i, price: candles[i].high, macd: hist[i] });
  }

  if (pL.length >= 2) {
    const r = pL[pL.length - 1]; const p = pL[pL.length - 2];
    if (r.price < p.price && r.macd > p.macd) {
      const confirmed = candles[n - 1].close > candles[n - 1].open;
      return { type: 'BULLISH_MACD_DIV', direction: 'BUY', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  if (pH.length >= 2) {
    const r = pH[pH.length - 1]; const p = pH[pH.length - 2];
    if (r.price > p.price && r.macd < p.macd) {
      const confirmed = candles[n - 1].close < candles[n - 1].open;
      return { type: 'BEARISH_MACD_DIV', direction: 'SELL', strength: confirmed ? 1.5 : 0.75, confirmed: confirmed };
    }
  }
  return null;
}

export { detectRSIDivergence, detectMACDDivergence };

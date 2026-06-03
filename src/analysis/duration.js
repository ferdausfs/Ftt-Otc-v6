import { DURATION_CONFIG, OTC_DURATION_CONFIG, VOLATILITY_THRESHOLDS, CONFIG } from '../config.js';
import { safeLastValue } from '../utils/helpers.js';

export function calculateDuration(atr, assetType, regime) {
  const base = assetType === 'CRYPTO' ? 10 : 5;
  const factor = regime === 'TRENDING' ? 2 : regime === 'RANGING' ? 1 : 1.5;
  return Math.round(base * factor);
}

export function calculateCandleDuration(indicators, direction, candles, timeframe, assetType) {
  const durCfg = DURATION_CONFIG[assetType] || DURATION_CONFIG.FOREX;
  const cfg = durCfg[timeframe] || { base: 3, min: 1, max: 10 };
  const vt  = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  let dur = cfg.base;

  const rsi    = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr    = safeLastValue(indicators.atr);
  const adxVal = safeLastValue(indicators.adx.adx);
  const bbBW   = safeLastValue(indicators.bollinger.bandwidth);

  if (rsi !== null) {
    if (rsi > 82 || rsi < 18) dur -= 2;
    else if (rsi > 72 || rsi < 28) dur -= 1;
  }
  if (stochK !== null && (stochK > 92 || stochK < 8)) dur -= 1;
  if (atr !== null && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > 0) {
      const atrPct = (atr / lastClose) * 100;
      if (atrPct > vt.atrVeryHigh) dur -= 2;
      else if (atrPct > vt.atrHigh) dur -= 1;
      else if (atrPct < vt.atrDead) dur += 2;
      else if (atrPct < vt.atrLow)  dur += 1;
    }
  }
  if (adxVal !== null) {
    if (adxVal >= 40) dur += 1;
    else if (adxVal < 15) dur -= 1;
  }
  if (bbBW !== null && bbBW < vt.bbSqueeze) dur += 1;

  if (indicators.patterns) {
    const strongNames = ['MORNING_STAR','EVENING_STAR','THREE_WHITE_SOLDIERS','THREE_BLACK_CROWS','BULLISH_ENGULFING','BEARISH_ENGULFING'];
    if (indicators.patterns.some(p => strongNames.includes(p.name))) dur += 1;
  }
  if (rsi !== null && direction === 'BUY'  && rsi >= 55 && rsi <= 68) dur += 1;
  if (rsi !== null && direction === 'SELL' && rsi <= 45 && rsi >= 32) dur += 1;
  if (timeframe === '15min' && adxVal !== null && adxVal < 20) dur -= 1;
  if (timeframe === '1min'  && adxVal !== null && adxVal >= 30) dur += 1;

  return Math.max(cfg.min, Math.min(cfg.max, Math.round(dur)));
}

export function calculateOTCCandleDuration(indicators, direction, candles, timeframe) {
  const cfg    = OTC_DURATION_CONFIG[timeframe] || { base: 2, min: 1, max: 3 };
  let dur      = cfg.base;
  const rsi    = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr    = safeLastValue(indicators.atr);
  if (rsi    !== null && (rsi > 80    || rsi < 20))    dur -= 1;
  if (stochK !== null && (stochK > 90 || stochK < 10)) dur -= 1;
  if (atr !== null && candles.length > 0) {
    const lc = candles[candles.length - 1].close;
    if (lc > 0 && (atr / lc) * 100 > 0.15) dur -= 1;
  }
  return Math.max(cfg.min, Math.min(cfg.max, dur));
}

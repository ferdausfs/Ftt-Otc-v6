import { VOLATILITY_THRESHOLDS } from '../config.js';
import { safeLastTwo } from '../utils/helpers.js';

export function analyzeRegime(candles) {
  // Simple regime detection based on candles
  if (!candles || candles.length < 20) return { regime: 'RANGING', strength: 50 };

  // Logic to determine regime
  return { regime: 'RANGING', strength: 50 };
}

export function detectMarketRegime(adxVal, bbBandwidth, atr, lastClose, assetType, prevBbBandwidth) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct > vt.atrVeryHigh) return 'VOLATILE';
  }
  if (bbBandwidth !== null && prevBbBandwidth !== null) {
    const expanding   = bbBandwidth > prevBbBandwidth * 1.25;
    const wasSqueezed = prevBbBandwidth < vt.bbSqueeze * 1.5;
    if (wasSqueezed && expanding) return 'BREAKOUT';
  }
  if (adxVal !== null && adxVal >= 25) return 'TRENDING';
  return 'RANGING';
}

export function getRegimeWeights(regime) {
  const map = {
    TRENDING: { trend:2.4, momentum:1.4, macd:1.6, stochastic:0.7, bands:0.8, adx:1.8, patterns:1.2, divergence:1.5, pivots:0.6, volume:0.7, sr:0.8 },
    RANGING:  { trend:0.8, momentum:1.8, macd:0.8, stochastic:1.8, bands:1.4, adx:0.8, patterns:1.3, divergence:1.8, pivots:1.2, volume:0.5, sr:2.2 },
    BREAKOUT: { trend:2.0, momentum:1.2, macd:1.4, stochastic:0.6, bands:2.0, adx:1.6, patterns:1.0, divergence:0.8, pivots:0.7, volume:1.2, sr:0.7 },
    VOLATILE: { trend:1.2, momentum:1.0, macd:0.8, stochastic:0.8, bands:0.9, adx:1.0, patterns:0.8, divergence:1.0, pivots:0.6, volume:0.4, sr:1.0 },
  };
  return map[regime] || { trend:1.8, momentum:1.4, macd:1.2, stochastic:1.0, bands:1.0, adx:1.3, patterns:1.1, divergence:1.5, pivots:0.8, volume:0.5, sr:1.4 };
}

export function getRegimeAdvice(regime, direction) {
  if (regime === 'TRENDING')
    return direction === 'NO_TRADE' ? 'Trending — wait for pullback entry' : 'Trending — trade with trend, momentum expiry';
  if (regime === 'RANGING')
    return direction === 'NO_TRADE' ? 'Ranging — wait for S/R boundary' : 'Ranging — trade at S/R only, short expiry';
  if (regime === 'BREAKOUT')
    return direction === 'NO_TRADE' ? 'Breakout forming — wait for candle close' : 'Breakout — ride momentum, avoid counter-trades';
  if (regime === 'VOLATILE')
    return 'High volatility — reduce size or skip';
  return '';
}

export function detectMarketCondition(adxVal, bbBW, atr, lastClose, assetType) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const cond = [];
  if (adxVal !== null) {
    if (adxVal >= 40) cond.push('STRONG_TREND');
    else if (adxVal >= 25) cond.push('TRENDING');
    else if (adxVal >= 15) cond.push('WEAK_TREND');
    else cond.push('RANGING');
  }
  if (bbBW !== null) {
    if (bbBW < vt.bbSqueeze) cond.push('SQUEEZE');
    else if (bbBW > vt.bbHighVol) cond.push('HIGH_VOLATILITY');
  }
  if (atr !== null && lastClose > 0) {
    const ap = (atr / lastClose) * 100;
    if (ap > vt.atrVolatile) cond.push('VOLATILE');
    else if (ap < vt.atrDeadMarket) cond.push('DEAD_MARKET');
  }
  return cond.length === 0 ? ['NORMAL'] : cond;
}

export function isTrendingMarket(adxVal) {
  if (adxVal === null) return null;
  return adxVal >= 25;
}

export function detectDICrossover(adxIndicator) {
  if (!adxIndicator || !adxIndicator.plusDI || !adxIndicator.minusDI) return null;
  const lastPlusDI  = safeLastTwo(adxIndicator.plusDI);
  const lastMinusDI = safeLastTwo(adxIndicator.minusDI);
  if (lastPlusDI.last === null || lastPlusDI.prev === null ||
      lastMinusDI.last === null || lastMinusDI.prev === null) return null;
  if (lastPlusDI.prev <= lastMinusDI.prev && lastPlusDI.last > lastMinusDI.last)
    return { type:'BULLISH_DI_CROSS', direction:'BUY', strength:1.5 };
  if (lastMinusDI.prev <= lastPlusDI.prev && lastMinusDI.last > lastPlusDI.last)
    return { type:'BEARISH_DI_CROSS', direction:'SELL', strength:1.5 };
  return null;
}

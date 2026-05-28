/**
 * Indicator Aggregator — Updated for Real Market
 * Includes: Math indicators, Structure, Liquidity, Volume Profile
 */

import { calculateEMA, calculateRSI, calculateMACD, calculateATR, calculateBB, calculateStochastic, calculateADX, calculateCCI, calculateMFI, calculatePivotPoints, calculateCamarilla } from './math.js';
import { detectPatterns } from './patterns.js';
import { detectDivergence } from './divergence.js';
import { findSupportResistance } from './sr.js';
import { analyzeRegime } from './regime.js';
import { analyzeStructure } from './structure.js';
import { analyzeLiquidity } from './liquidity.js';
import { analyzeVolumeProfile } from './volumeProfile.js';

/**
 * Calculate all indicators for a candle set
 */
export function calculateAllIndicators(candles, assetType = 'FOREX') {
  if (!candles || candles.length < 50) {
    return { valid: false, reason: 'Insufficient data' };
  }
  
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const opens = candles.map(c => c.open);
  const volumes = candles.map(c => c.volume || 0);
  
  // Core math indicators
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const atr = calculateATR(highs, lows, closes);
  const bb = calculateBB(closes, 20, 2);
  const stoch = calculateStochastic(highs, lows, closes);
  const adx = calculateADX(highs, lows, closes);
  const cci = calculateCCI(highs, lows, closes);
  const mfi = calculateMFI(highs, lows, closes, volumes);
  const pivots = calculatePivotPoints(highs, lows, closes);
  const camarilla = calculateCamarilla(highs, lows, closes);
  
  // Pattern detection
  const patterns = detectPatterns(opens, highs, lows, closes);
  
  // Divergence
  const divergence = detectDivergence(closes, rsi, macd);
  
  // Support/Resistance
  const sr = findSupportResistance(highs, lows, closes);
  
  // Volume analysis
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1];
  const volumeSpike = avgVolume > 0 && lastVolume > avgVolume * 1.5;
  
  return {
    valid: true,
    close: closes,
    ema50: safeLastValue(ema50),
    ema200: safeLastValue(ema200),
    rsi: safeLastValue(rsi),
    rsiHistory: rsi.slice(-10),
    macd: {
      line: safeLastValue(macd.macdLine),
      signal: safeLastValue(macd.signalLine),
      histogram: safeLastValue(macd.histogram)
    },
    atr: safeLastValue(atr),
    bb: {
      upper: safeLastValue(bb.upper),
      middle: safeLastValue(bb.middle),
      lower: safeLastValue(bb.lower),
      position: bb.upper.length > 0 ? (safeLastValue(closes) - safeLastValue(bb.lower)) / (safeLastValue(bb.upper) - safeLastValue(bb.lower)) : 0.5
    },
    stoch: {
      k: safeLastValue(stoch.k),
      d: safeLastValue(stoch.d)
    },
    adx: safeLastValue(adx),
    cci: safeLastValue(cci),
    mfi: safeLastValue(mfi),
    pivots,
    camarilla,
    patterns,
    divergence,
    sr,
    volumeSpike,
    avgVolume,
    lastVolume
  };
}

function safeLastValue(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const last = arr[arr.length - 1];
  return typeof last === 'number' && !isNaN(last) ? last : 0;
}

// Re-export for direct use
export { analyzeStructure, analyzeLiquidity, analyzeVolumeProfile, analyzeRegime };

/**
 * Signal Filters with Correlation & Portfolio Management
 */

import { safeLastValue, r2 } from '../utils/helpers.js';
import { getAssetType } from '../utils/pairs.js';

/**
 * Apply all filters to signal
 */
export function applyFilters(analyses, direction, pair, assetType, session = 'UNKNOWN') {
  const filters = [
    checkMinimumTimeframes(analyses),
    checkTimeframeAlignment(analyses, direction),
    checkRegimeSuitability(analyses),
    checkCorrelationExposure(pair, analyses),
    checkVolatilityFilter(analyses, pair, assetType),
    checkSessionFilter(analyses, pair, session),
    checkStructureAlignment(analyses, direction)
  ];
  
  const failed = filters.filter(f => !f.passed);
  
  if (failed.length > 0) {
    return {
      passed: false,
      reason: failed.map(f => f.reason).join('; '),
      failedFilters: failed.map(f => f.name)
    };
  }
  
  return { passed: true, reason: 'All filters passed' };
}

/**
 * Minimum 3 timeframes must be valid
 */
function checkMinimumTimeframes(analyses) {
  const validCount = Object.values(analyses).filter(a => a.valid).length;
  return {
    name: 'MIN_TIMEFRAMES',
    passed: validCount >= 3,
    reason: validCount < 3 ? `Only ${validCount} valid timeframes (min 3)` : null
  };
}

/**
 * Higher timeframes must not conflict strongly
 */
function checkTimeframeAlignment(analyses, direction) {
  const htf = ['1W', '1D', '4H'].map(tf => analyses[tf]).filter(Boolean);
  if (htf.length === 0) return { name: 'HTF_ALIGNMENT', passed: true, reason: null };
  
  const conflicts = htf.filter(a => {
    if (direction === 'BUY') return a.signal.score < 40;
    if (direction === 'SELL') return a.signal.score > 60;
    return false;
  });
  
  const conflictWeight = conflicts.reduce((sum, c) => sum + c.weight, 0);
  const totalWeight = htf.reduce((sum, c) => sum + c.weight, 0);
  
  return {
    name: 'HTF_ALIGNMENT',
    passed: conflictWeight < totalWeight * 0.4, // Allow 40% conflict
    reason: conflictWeight >= totalWeight * 0.4 
      ? `HTF conflict: ${r2(conflictWeight/totalWeight*100)}% against ${direction}` 
      : null
  };
}

/**
 * Don't trade ranging on trend-only strategies, etc.
 */
function checkRegimeSuitability(analyses) {
  const entryTF = analyses['15M'] || analyses['5M'] || analyses['1H'];
  if (!entryTF) return { name: 'REGIME_SUITABILITY', passed: true, reason: null };
  
  // If entry TF is volatile and HTF is not trending → avoid
  if (entryTF.regime.regime === 'VOLATILE') {
    const htfTrending = ['1D', '4H'].some(tf => analyses[tf]?.regime?.regime === 'TRENDING');
    return {
      name: 'REGIME_SUITABILITY',
      passed: htfTrending,
      reason: htfTrending ? null : 'Volatile entry without HTF trend context'
    };
  }
  
  return { name: 'REGIME_SUITABILITY', passed: true, reason: null };
}

/**
 * Correlation check: Don't stack same-direction bets
 */
function checkCorrelationExposure(pair, analyses) {
  // This would check against currently tracked pairs in KV
  // For now, implement the logic structure
  
  return {
    name: 'CORRELATION',
    passed: true,
    reason: null,
    // In production: fetch from KV: recent correlation matrix
    note: 'Correlation check requires KV storage of active signals'
  };
}

/**
 * ATR-based volatility filter
 */
function checkVolatilityFilter(analyses, pair, assetType) {
  const htf = analyses['1D'] || analyses['4H'] || analyses['1H'];
  if (!htf?.indicators?.atr) return { name: 'VOLATILITY', passed: true, reason: null };
  
  const atr = safeLastValue(htf.indicators.atr);
  if (atr === null) return { name: 'VOLATILITY', passed: true, reason: null };
  const price = safeLastValue(htf.indicators.close || []);
  if (!price) return { name: 'VOLATILITY', passed: true, reason: null };
  const atrPercent = (atr / price) * 100;
  
  // If ATR > 2% on forex or > 5% on crypto → too volatile
  const isCrypto = assetType === 'CRYPTO';
  const threshold = isCrypto ? 5.0 : 2.0;
  
  return {
    name: 'VOLATILITY',
    passed: atrPercent < threshold,
    reason: atrPercent >= threshold ? `ATR ${r2(atrPercent)}% exceeds ${threshold}% threshold` : null
  };
}

/**
 * Session filter: Some pairs don't move in Asian session
 */
function checkSessionFilter(analyses, pair, session) {
  // Asian session low volatility for EUR/USD, GBP/USD
  const avoidAsian = ['EURUSD', 'GBPUSD', 'EURGBP'].some(p => (pair || '').replace(/[/_-]/g, '').includes(p));
  
  return {
    name: 'SESSION',
    passed: !(avoidAsian && session === 'ASIAN'),
    reason: (avoidAsian && session === 'ASIAN') ? 'Major forex pairs illiquid in Asian session' : null
  };
}

/**
 * Structure alignment: Don't buy into resistance, don't sell into support
 */
function checkStructureAlignment(analyses, direction) {
  const entryTF = analyses['15M'] || analyses['5M'] || analyses['1H'];
  if (!entryTF?.structure) return { name: 'STRUCTURE', passed: true, reason: null };
  
  const struct = entryTF.structure;
  
  if (direction === 'BUY' && struct.isAtResistance) {
    return {
      name: 'STRUCTURE',
      passed: false,
      reason: 'BUY signal at structural resistance - likely rejection'
    };
  }
  
  if (direction === 'SELL' && struct.isAtSupport) {
    return {
      name: 'STRUCTURE',
      passed: false,
      reason: 'SELL signal at structural support - likely rejection'
    };
  }
  
  return { name: 'STRUCTURE', passed: true, reason: null };
}

/**
 * Volume confirmation filter
 */
export function checkVolumeConfirmation(candles, direction, minVolumeSpike = 1.3) {
  if (!candles || candles.length < 5) return { passed: false, reason: 'No volume data' };
  
  const avgVolume = candles.slice(-20, -1).reduce((sum, c) => sum + (c.volume || 0), 0) / 19;
  const currentVolume = candles[candles.length - 1].volume || 0;
  const volumeSpike = avgVolume > 0 ? currentVolume / avgVolume : 0;
  
  // For breakout signals, require volume confirmation
  return {
    passed: volumeSpike >= minVolumeSpike || avgVolume === 0,
    volumeSpike: r2(volumeSpike),
    reason: volumeSpike < minVolumeSpike ? `Volume spike ${r2(volumeSpike)}x below ${minVolumeSpike}x` : null
  };
}

export function generateEntryReason(direction, categoryScores, indicators, alignment, trend, regime) {
  if (direction === 'NO_TRADE') return 'No clear signal conviction.';
  const res = [];
  if (alignment.includes('ALL')) res.push('Strong multi-tf alignment');
  if (regime === 'TRENDING') res.push('Trend continuation');
  if (regime === 'RANGING') res.push('Mean reversion setup');
  return res.length > 0 ? res.join(' · ') : 'Technical confluence detected.';
}

export function recentCandleConsistency(candles, direction, count = 3) {
  if (!candles || candles.length < count) return 1.0;
  const recent = candles.slice(-count);
  const bull = recent.filter(c => c.close > c.open).length;
  const bear = recent.filter(c => c.close < c.open).length;
  if (direction === 'BUY') return bull / count;
  if (direction === 'SELL') return bear / count;
  return 1.0;
}

export function getCandleQualityMultiplier(candles) {
  if (!candles || candles.length < 5) return 1.0;
  // Placeholder
  return 1.0;
}

export function detectCorrelationConflicts(pairDirs) {
  return { status: 'OK', conflicts: [] };
}

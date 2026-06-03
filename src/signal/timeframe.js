import { ASSET_TYPE } from '../config.js';
/**
 * Multi-Timeframe Analysis with Weighted Scoring
 * Higher timeframes get more weight — prevents trading against the tide
 */

import { calculateAllIndicators } from '../indicators/index.js';
import { analyzeStructure } from '../indicators/structure.js';
import { analyzeLiquidity } from '../indicators/liquidity.js';
import { analyzeVolumeProfile } from '../indicators/volumeProfile.js';
import { analyzeRegime } from '../indicators/regime.js';
import { safeLastValue, r2 } from '../utils/helpers.js';

// FIX: '1Mo' for Monthly, '1Mi' for 1 Minute (avoid duplicate '1M')
const TF_WEIGHTS = {
  '1Mo': 0.35, 'Monthly': 0.35,
  '1W': 0.30, 'Weekly': 0.30,
  '1D': 0.25, 'Daily': 0.25,
  '4H': 0.20, 'H4': 0.20,
  '1H': 0.15, 'H1': 0.15,
  '30M': 0.10, 'M30': 0.10,
  '15min': 0.08, '15M': 0.08, 'M15': 0.08,
  '5min': 0.05, '5M': 0.05, 'M5': 0.05,
  '1min': 0.03, '1Mi': 0.03, 'M1': 0.03
};

const TF_HIERARCHY = ['1Mo', '1W', '1D', '4H', '1H', '30M', '15M', '5M', '1Mi'];

/**
 * Analyze single timeframe with full context
 */
export async function analyzeTimeframe(pair, tf, candles, assetType = ASSET_TYPE.FOREX) {
  if (!candles || candles.length < 50) {
    return { score: 50, regime: 'UNKNOWN', valid: false, reason: 'Insufficient data' };
  }
  
  const indicators = calculateAllIndicators(candles, assetType = ASSET_TYPE.FOREX);
  const structure = analyzeStructure(candles);
  const liquidity = analyzeLiquidity(candles);
  const volumeProfile = analyzeVolumeProfile(candles);
  const regime = analyzeRegime(candles);
  
  // Calculate base signal score based on regime
  let score = 50;
  const { rsi, macd, ema50, ema200, adx, bb } = indicators;
  
  switch (regime.regime) {
    case 'TRENDING':
      if (ema50 > ema200 && macd.histogram > 0 && adx > 20) score = 65;
      else if (ema50 < ema200 && macd.histogram < 0 && adx > 20) score = 35;
      else score = 50;
      break;
      
    case 'RANGING':
      if (rsi < 30 && bb.position < 0.1) score = 70;
      else if (rsi > 70 && bb.position > 0.9) score = 30;
      else if (bb.position > 0.4 && bb.position < 0.6) score = 50;
      break;
      
    case 'BREAKOUT':
      if (structure.bos && volumeProfile.volumeSpike) {
        score = structure.bos.type === 'BULLISH_BOS' ? 75 : 25;
      } else if (structure.choch) {
        score = 50; // False breakout warning
      }
      break;
      
    case 'VOLATILE':
      score = 50; // Neutral in volatile - wait for clarity
      break;
  }
  
  // Structure adjustments
  if (structure.trend === 'BULLISH') score += 5;
  if (structure.trend === 'BEARISH') score -= 5;
  if (structure.bos?.type === 'BULLISH_BOS') score += 8;
  if (structure.bos?.type === 'BEARISH_BOS') score -= 8;
  if (structure.choch?.type === 'BULLISH_CHOCH') score += 12;
  if (structure.choch?.type === 'BEARISH_CHOCH') score -= 12;
  
  // Liquidity sweep filter
  if (liquidity.sweepDetected) {
    if (liquidity.sweepType === 'BEARISH_SWEEP') score += 10; // Swept lows = bullish
    if (liquidity.sweepType === 'BULLISH_SWEEP') score -= 10; // Swept highs = bearish
  }
  
  // Volume profile
  if (volumeProfile.nearPOC) score = score * 0.9 + 50 * 0.1; // Pull to POC (mean reversion)
  if (volumeProfile.inValueArea) score += (score > 50 ? 3 : -3);
  
  // Clamp
  score = Math.max(10, Math.min(90, score));
  
  return {
    valid: true,
    score: r2(score),
    regime: regime.regime,
    regimeStrength: regime.strength,
    adx: r2(adx),
    rsi: r2(rsi),
    structure: {
      trend: structure.trend,
      bos: !!structure.bos,
      choch: !!structure.choch,
      isAtSupport: structure.isAtSupport,
      isAtResistance: structure.isAtResistance
    },
    liquidity: {
      sweepDetected: liquidity.sweepDetected,
      sweepType: liquidity.sweepType
    },
    volumeProfile: {
      poc: volumeProfile.poc,
      nearPOC: volumeProfile.nearPOC,
      inValueArea: volumeProfile.inValueArea
    },
    weight: TF_WEIGHTS[tf] || 0.05
  };
}

/**
 * Aggregate all timeframes with weighted scoring
 */
export function aggregateTimeframes(tfAnalyses) {
  let weightedSum = 0;
  let totalWeight = 0;
  let bullishAlignment = 0;
  let bearishAlignment = 0;
  let neutralCount = 0;
  
  const alignedTFs = [];
  const conflictingTFs = [];
  
  for (const [tf, analysis] of Object.entries(tfAnalyses)) {
    if (!analysis.valid) continue;
    
    const weight = analysis.weight;
    weightedSum += analysis.score * weight;
    totalWeight += weight;
    
    if (analysis.score > 60) {
      bullishAlignment += weight;
      alignedTFs.push({ tf, score: analysis.score, bias: 'BULLISH' });
    } else if (analysis.score < 40) {
      bearishAlignment += weight;
      alignedTFs.push({ tf, score: analysis.score, bias: 'BEARISH' });
    } else {
      neutralCount += weight;
      conflictingTFs.push({ tf, score: analysis.score, bias: 'NEUTRAL' });
    }
  }
  
  const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 50;
  
  // Determine consensus
  let consensus = 'MIXED';
  const totalDirectional = bullishAlignment + bearishAlignment;
  
  if (bullishAlignment > bearishAlignment * 2 && bullishAlignment > 0.3) {
    consensus = 'STRONG_BULLISH';
  } else if (bearishAlignment > bullishAlignment * 2 && bearishAlignment > 0.3) {
    consensus = 'STRONG_BEARISH';
  } else if (bullishAlignment > bearishAlignment && bullishAlignment > 0.2) {
    consensus = 'MODERATE_BULLISH';
  } else if (bearishAlignment > bullishAlignment && bearishAlignment > 0.2) {
    consensus = 'MODERATE_BEARISH';
  }
  
  // Conflict detection
  const hasConflict = (finalScore > 55 && bearishAlignment > 0.15) || 
                      (finalScore < 45 && bullishAlignment > 0.15);
  
  return {
    score: r2(finalScore),
    consensus,
    bullishAlignment: r2(bullishAlignment),
    bearishAlignment: r2(bearishAlignment),
    neutralWeight: r2(neutralCount),
    totalWeight: r2(totalWeight),
    hasConflict,
    alignedTFs,
    conflictingTFs,
    recommendation: generateRecommendation(finalScore, consensus, hasConflict)
  };
}

function generateRecommendation(score, consensus, hasConflict) {
  if (hasConflict) return 'AVOID - Timeframe conflict detected';
  if (score >= 75 && consensus.includes('BULLISH')) return 'STRONG_BUY';
  if (score >= 60 && consensus.includes('BULLISH')) return 'BUY';
  if (score <= 25 && consensus.includes('BEARISH')) return 'STRONG_SELL';
  if (score <= 40 && consensus.includes('BEARISH')) return 'SELL';
  if (score >= 45 && score <= 55) return 'NEUTRAL - Wait for clarity';
  return 'WEAK_SIGNAL - Insufficient conviction';
}

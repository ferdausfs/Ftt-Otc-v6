/**
 * Real Market Signal Engine (Forex/Crypto)
 * Integrates: Structure, Liquidity, Regime-specific strategies, Risk management
 */

import { calculateAllIndicators } from '../indicators/index.js';
import { analyzeStructure } from '../indicators/structure.js';
import { analyzeLiquidity } from '../indicators/liquidity.js';
import { analyzeVolumeProfile } from '../indicators/volumeProfile.js';
import { analyzeRegime } from '../indicators/regime.js';
import { applyFilters } from '../analysis/filters.js';
import { gradeSignal } from '../analysis/grade.js';
import { calculateDuration } from '../analysis/duration.js';
import { calculateRiskParameters } from '../analysis/risk.js';
import { safeLastValue, fmt, r2 } from '../utils/helpers.js';
import { getAssetType } from '../utils/pairs.js';
import { ASSET_TYPE } from '../config.js';
import { detectTradingSession, getSessionParams } from '../utils/session.js';
import { checkNewsImpact } from '../utils/news.js';

/**
 * Build multi-timeframe signal for REAL market (Forex/Crypto)
 */
export async function buildMultiTimeframeSignal(pair, candleData, assetTypePassed, env) {
  const assetType = assetTypePassed || getAssetType(pair);
  const session = detectTradingSession();
  const sessionParams = getSessionParams(session);
  const newsImpact = await checkNewsImpact(pair, env);
  
  // Analyze each timeframe
  const analyses = {};
  let weightedScore = 0;
  let totalWeight = 0;
  
  // FIX: '1Mo' = 1 Month, '1min' = 1 Minute
  const weights = {
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
  
  for (const [tf, candles] of Object.entries(candleData)) {
    if (!candles || candles.length < 50) continue;
    
    const indicators = calculateAllIndicators(candles, assetType);
    const structure = analyzeStructure(candles);
    const liquidity = analyzeLiquidity(candles);
    const volumeProfile = analyzeVolumeProfile(candles);
    const regime = analyzeRegime(candles);
    
    // Regime-specific strategy selection
    const tfSignal = generateRegimeSpecificSignal(
      indicators, structure, liquidity, volumeProfile, regime, 
      sessionParams, assetType, tf
    );
    
    analyses[tf] = {
      indicators,
      structure,
      liquidity,
      volumeProfile,
      regime,
      signal: tfSignal,
      weight: weights[tf] || 0.05
    };
    
    weightedScore += tfSignal.score * (weights[tf] || 0.05);
    totalWeight += (weights[tf] || 0.05);
  }
  
  // Normalize weighted score
  let finalScore = totalWeight > 0 ? weightedScore / totalWeight : 50;  // FIX: let instead of const
  
  // Determine direction
  let direction = 'NEUTRAL';
  if (finalScore >= 65) direction = 'BUY';
  else if (finalScore <= 35) direction = 'SELL';
  
  // Apply structure filter: No trade against market structure
  const higherTF = analyses['1D'] || analyses['4H'] || analyses['1H'];
  if (higherTF) {
    const htStructure = higherTF.structure;
    
    // If HTF bearish and signal says BUY → Weak signal / No trade
    if (direction === 'BUY' && htStructure.trend === 'BEARISH' && htStructure.score < 40) {
      direction = 'NEUTRAL';
      finalScore = 50;  // Now works with let
    }
    // If HTF bullish and signal says SELL → Weak signal / No trade
    if (direction === 'SELL' && htStructure.trend === 'BULLISH' && htStructure.score > 60) {
      direction = 'NEUTRAL';
      finalScore = 50;  // Now works with let
    }
  }
  
  // Liquidity sweep confirmation
  const entryTF = analyses['15M'] || analyses['5M'] || analyses['1H'];
  let liquidityConfirmation = null;
  if (entryTF) {
    liquidityConfirmation = entryTF.liquidity;
    // If liquidity sweep detected in opposite direction → invalidate signal
    if (direction === 'BUY' && entryTF.liquidity.sweepType === 'BEARISH_SWEEP') {
      direction = 'NEUTRAL';
    }
    if (direction === 'SELL' && entryTF.liquidity.sweepType === 'BULLISH_SWEEP') {
      direction = 'NEUTRAL';
    }
  }
  
  // News filter
  if (newsImpact.impact === 'HIGH' && newsImpact.minutesUntil <= 60) {
    return {
      pair,
      direction: 'NO_TRADE',
      reason: `High impact news in ${newsImpact.minutesUntil} mins: ${newsImpact.event}`,
      grade: 'F',
      confidence: 0,
      score: 50,
      regime: higherTF?.regime?.regime || 'UNKNOWN',
      news: newsImpact,
      timestamp: new Date().toISOString()
    };
  }
  
  if (newsImpact.impact === 'MEDIUM') {
    // Reduce confidence for medium impact news
    finalScore *= 0.85;  // Now works with let
  }
  
  // Grade and confidence
  const grade = gradeSignal(finalScore, direction, higherTF?.regime?.regime);
  const confidence = calculateConfidence(analyses, direction, grade);
  
  // Risk parameters
  const entryPrice = safeLastValue(candleData['1H']?.map(c => c.close) || candleData['5M']?.map(c => c.close) || candleData['1min']?.map(c => c.close));
  const atr = higherTF?.indicators?.atr || entryTF?.indicators?.atr || 0.001;
  const riskParams = calculateRiskParameters(entryPrice, atr, direction, higherTF?.structure, entryTF?.liquidity);
  
  // Apply filters
  const filterResult = applyFilters(analyses, direction, pair, assetType, session);
  
  if (!filterResult.passed) {
    return {
      pair,
      direction: 'NO_TRADE',
      reason: filterResult.reason,
      grade: 'F',
      confidence: 0,
      score: finalScore,
      regime: higherTF?.regime?.regime || 'UNKNOWN',
      timestamp: new Date().toISOString()
    };
  }
  
  // Duration
  const duration = calculateDuration(atr, assetType, higherTF?.regime?.regime);
  
  return {
    pair,
    direction,
    grade,
    confidence: r2(confidence),
    score: r2(finalScore),
    entry: r2(entryPrice),
    stopLoss: r2(riskParams.stopLoss),
    takeProfit: r2(riskParams.takeProfit),
    riskReward: r2(riskParams.riskReward),
    positionSize: riskParams.positionSize,
    duration,
    regime: higherTF?.regime?.regime || 'UNKNOWN',
    structure: {
      trend: higherTF?.structure?.trend,
      bos: !!higherTF?.structure?.bos,
      choch: !!higherTF?.structure?.choch
    },
    liquidity: liquidityConfirmation ? {
      sweepDetected: liquidityConfirmation.sweepDetected,
      sweepType: liquidityConfirmation.sweepType,
      liquidityLevel: liquidityConfirmation.liquidityLevel
    } : null,
    volumeProfile: entryTF?.volumeProfile ? {
      poc: entryTF.volumeProfile.poc,
      nearPOC: entryTF.volumeProfile.nearPOC,
      inValueArea: entryTF.volumeProfile.inValueArea
    } : null,
    session,
    news: newsImpact,
    timeframeAnalyses: Object.keys(analyses).reduce((acc, tf) => {
      acc[tf] = {
        score: analyses[tf].signal.score,
        regime: analyses[tf].regime.regime
      };
      return acc;
    }, {}),
    timestamp: new Date().toISOString(),
    reasons: generateReasons(analyses, direction, higherTF?.structure, entryTF?.liquidity)
  };
}

/**
 * Regime-specific signal generation
 */
function generateRegimeSpecificSignal(indicators, structure, liquidity, volumeProfile, regime, sessionParams, assetType, timeframe) {
  const lastRSI = safeLastValue(indicators.rsi);
  const lastMACDHist = safeLastValue(indicators.macd?.histogram);
  const lastEMA50 = safeLastValue(indicators.ema50);
  const lastEMA200 = safeLastValue(indicators.ema200);
  const lastADX = safeLastValue(indicators.adx?.adx);
  const bbPos = safeLastValue(indicators.bollinger?.percentB);
  const lastATR = safeLastValue(indicators.atr);

  const { trend, bos, choch, isAtSupport, isAtResistance } = structure;
  const { sweepDetected, sweepType } = liquidity;
  
  let score = 50;
  let reasons = [];
  
  // Skip if ADX too low (no trend) on higher timeframes
  if (['1D', '4H', '1H'].includes(timeframe) && lastADX < 15) {
    return { score: 50, reasons: ['No trend strength'], direction: 'NEUTRAL' };
  }
  
  // === TRENDING REGIME ===
  if (regime.regime === 'TRENDING') {
    // Only trade in direction of HTF trend/structure
    if (trend === 'BULLISH') {
      // Pullback to EMA50/EMA200 or Support/OB
      if (lastRSI > 30 && lastRSI < 55 && lastMACDHist > -0.5 && (isAtSupport || sweepDetected && sweepType === 'BEARISH_SWEEP')) {
        score = 75;
        reasons.push('Trending: Bullish pullback to support');
      }
      // Breakout continuation
      else if (bos?.type === 'BULLISH_BOS' && lastMACDHist > 0) {
        score = 80;
        reasons.push('Trending: Bullish BOS continuation');
      }
    }
    else if (trend === 'BEARISH') {
      if (lastRSI < 70 && lastRSI > 45 && lastMACDHist < 0.5 && (isAtResistance || sweepDetected && sweepType === 'BULLISH_SWEEP')) {
        score = 25;
        reasons.push('Trending: Bearish pullback to resistance');
      }
      else if (bos?.type === 'BEARISH_BOS' && lastMACDHist < 0) {
        score = 20;
        reasons.push('Trending: Bearish BOS continuation');
      }
    }
  }
  
  // === RANGING REGIME ===
  else if (regime.regime === 'RANGING') {
    if (lastRSI < 30 && isAtSupport && bbPos < 0.1) {
      score = 70;
      reasons.push('Ranging: Oversold at support');
    }
    else if (lastRSI > 70 && isAtResistance && bbPos > 0.9) {
      score = 30;
      reasons.push('Ranging: Overbought at resistance');
    }
    // Mean reversion: Price near POC in value area
    else if (volumeProfile?.nearPOC && bbPos > 0.4 && bbPos < 0.6) {
      score = 50;
      reasons.push('Ranging: Price at volume POC');
    }
  }
  
  // === BREAKOUT REGIME ===
  else if (regime.regime === 'BREAKOUT') {
    // Only trade confirmed breakouts with volume/structure
    if (bos?.type === 'BULLISH_BOS' && volumeProfile?.volumeSpike && lastADX > 25) {
      score = 78;
      reasons.push('Breakout: Confirmed bullish breakout');
    }
    else if (bos?.type === 'BEARISH_BOS' && volumeProfile?.volumeSpike && lastADX > 25) {
      score = 22;
      reasons.push('Breakout: Confirmed bearish breakout');
    }
    // False breakout filter: CHoCH right after BOS
    else if (choch && !bos) {
      score = 50;
      reasons.push('Breakout: False breakout detected (CHoCH)');
    }
  }
  
  // === VOLATILE REGIME ===
  else if (regime.regime === 'VOLATILE') {
    // NO TRADE unless exceptional setup
    if (lastATR > (regime.atr || 0) * 2) {
      score = 50;
      reasons.push('Volatile: ATR spike - no trade');
    }
  }
  
  // Session parameter adjustments
  if (sessionParams.volatilityFactor < 0.8 && regime.regime !== 'RANGING') {
    score = 50 + (score - 50) * 0.7; // Reduce conviction in low vol session
    reasons.push(`Session: ${sessionParams.name} - reduced conviction`);
  }
  
  return { score, reasons };
}

function calculateConfidence(analyses, direction, grade) {
  let base = 50;
  
  // Higher timeframe alignment
  const htfDirections = [];
  ['1W', '1D', '4H', '1D'].forEach(tf => {
    if (analyses[tf]) {
      htfDirections.push(analyses[tf].signal.score > 55 ? 'BUY' : analyses[tf].signal.score < 45 ? 'SELL' : 'NEUTRAL');
    }
  });
  
  const allBuy = htfDirections.every(d => d === 'BUY' || d === 'NEUTRAL');
  const allSell = htfDirections.every(d => d === 'SELL' || d === 'NEUTRAL');
  
  if (direction === 'BUY' && allBuy) base += 20;
  if (direction === 'SELL' && allSell) base += 20;
  if (direction === 'BUY' && htfDirections.some(d => d === 'SELL')) base -= 15;
  if (direction === 'SELL' && htfDirections.some(d => d === 'BUY')) base -= 15;
  
  // Grade bonus
  const gradeBonus = { 'A+': 15, 'A': 10, 'B': 5, 'C': 0, 'D': -10, 'F': -20 };
  base += (gradeBonus[grade] || 0);
  
  return Math.max(0, Math.min(100, base));
}

function generateReasons(analyses, direction, structure, liquidity) {
  const reasons = [];
  
  if (structure?.trend) reasons.push(`Structure: ${structure.trend}`);
  if (structure?.bos) reasons.push(`BOS: ${structure.bos.type}`);
  if (structure?.choch) reasons.push(`CHoCH: ${structure.choch.type}`);
  if (liquidity?.sweepDetected) reasons.push(`Liquidity sweep: ${liquidity.sweepType}`);
  if (structure?.isAtSupport) reasons.push('Price at structural support');
  if (structure?.isAtResistance) reasons.push('Price at structural resistance');
  
  return reasons;
}

/**
 * Find best timeframe for the signal
 */
export function findBestTimeframe(tfResults, direction) {
  let bestTF = '1min';
  let bestScore = 0;

  for (const [tf, result] of Object.entries(tfResults)) {
    const score = direction === 'BUY' ? (result.score.up || 0) : (result.score.down || 0);
    if (score > bestScore) {
      bestScore = score;
      bestTF = tf;
    }
  }

  return { timeframe: bestTF, score: bestScore };
}

import { fetchCandlesWithCache } from '../fetch/candles.js';

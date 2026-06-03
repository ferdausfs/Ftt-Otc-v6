/**
 * Dual-AI Result Combiner + ML Ensemble
 * Combines Cerebras, Groq, and ML model into unified signal
 */

import { predictWinProbability, ensembleScore, extractFeatures } from './ml.js';
import { r2 } from '../utils/helpers.js';

/**
 * Build indicator snapshot for AI prompts
 */
export function buildIndicatorSnapshot(tfResults, candleData, direction, bestTF) {
  const best = tfResults[bestTF] || Object.values(tfResults)[0];
  if (!best) return {};

  return {
    emaAlignment: best.ema5 > best.ema20 ? 'BULLISH' : 'BEARISH',
    ema5: r2(safeLastValue(best.ema5)),
    ema10: r2(safeLastValue(best.ema10)),
    ema20: r2(safeLastValue(best.ema20)),
    rsi: r2(safeLastValue(best.rsi)),
    macdHist: r2(safeLastValue(best.macd?.histogram)),
    adx: r2(safeLastValue(best.adx?.adx)),
    plusDI: r2(safeLastValue(best.adx?.plusDI)),
    minusDI: r2(safeLastValue(best.adx?.minusDI)),
    stochK: r2(safeLastValue(best.stochastic?.k)),
    stochD: r2(safeLastValue(best.stochastic?.d)),
    williamsR: r2(safeLastValue(best.williamsR)),
    cci: r2(safeLastValue(best.cci)),
    bbPercentB: r2(safeLastValue(best.bollinger?.percentB)),
    bbBandwidth: r2(safeLastValue(best.bollinger?.bandwidth)),
    atr: r2(safeLastValue(best.atr)),
    srContext: best.structure?.trend || 'NEUTRAL',
    fvgActive: best.fvg?.length > 0,
    patterns: best.patterns?.map(p => p.name) || [],
    rsiDiv: !!best.divergence?.rsi,
    macdDiv: !!best.divergence?.macd,
    pivot: r2(best.pivots?.pivot),
    r1: r2(best.pivots?.r1),
    s1: r2(best.pivots?.s1),
    structure1min: tfResults['1min']?.structure?.trend || 'N/A',
    structure5min: tfResults['5min']?.structure?.trend || 'N/A',
    structure15min: tfResults['15min']?.structure?.trend || 'N/A',
    candles1min: (candleData['1min'] || []).slice(-10).map(c => c.close > c.open ? 'U' : 'B').join(''),
    candles5min: (candleData['5min'] || []).slice(-10).map(c => c.close > c.open ? 'U' : 'B').join(''),
    candles15min: (candleData['15min'] || []).slice(-10).map(c => c.close > c.open ? 'U' : 'B').join(''),
  };
}

import { safeLastValue } from '../utils/helpers.js';

/**
 * Combine Cerebras + Groq + ML into final signal
 */
export function combineAIResults(cerebrasResult, groqResult, technicalScore, mlFeatures, historicalStats) {
  // Parse AI responses (they return text like "BULLISH 75%" or "BEARISH 60%")
  const cerebras = parseAIResponse(cerebrasResult);
  const groq = parseAIResponse(groqResult);
  
  // ML prediction
  const mlProb = predictWinProbability(mlFeatures, historicalStats);
  
  // Direction consensus
  const directions = [cerebras.direction, groq.direction].filter(Boolean);
  const bullishCount = directions.filter(d => d === 'BUY' || d === 'BULLISH').length;
  const bearishCount = directions.filter(d => d === 'SELL' || d === 'BEARISH').length;
  
  let aiDirection = 'NEUTRAL';
  if (bullishCount > bearishCount) aiDirection = 'BUY';
  if (bearishCount > bullishCount) aiDirection = 'SELL';
  
  // Average AI confidence
  const aiConfidences = [cerebras.confidence, groq.confidence].filter(v => v > 0);
  const avgAIConfidence = aiConfidences.length > 0 
    ? aiConfidences.reduce((a, b) => a + b, 0) / aiConfidences.length 
    : 50;
  
  // Ensemble final score
  const finalScore = ensembleScore(technicalScore, mlProb, avgAIConfidence);
  
  // Determine final direction
  let finalDirection = 'NEUTRAL';
  if (finalScore >= 65) finalDirection = 'BUY';
  else if (finalScore <= 35) finalDirection = 'SELL';
  
  // Override if AIs strongly disagree with technical
  const aiTechnicalDisagreement = (
    (aiDirection === 'SELL' && technicalScore > 60) ||
    (aiDirection === 'BUY' && technicalScore < 40)
  );
  
  let warning = null;
  let adjustedScore = finalScore;
  
  if (aiTechnicalDisagreement && Math.abs(avgAIConfidence - 50) > 20) {
    // AI strongly disagrees with technical → reduce confidence
    adjustedScore = finalScore * 0.8;
    warning = `AI (${aiDirection}) disagrees with technical (${technicalScore > 60 ? 'BUY' : 'SELL'})`;
  }
  
  // If ML probability < 45% despite good technical → caution
  if (mlProb < 0.45 && finalScore > 55) {
    adjustedScore = Math.min(finalScore, 55);
    warning = warning ? `${warning}; ML probability low (${r2(mlProb * 100)}%)` : `ML probability low (${r2(mlProb * 100)}%)`;
  }
  
  return {
    direction: finalDirection,
    score: r2(adjustedScore),
    rawScore: r2(finalScore),
    mlProbability: r2(mlProb * 100),
    aiDirection,
    aiConfidence: r2(avgAIConfidence),
    aiAgreement: bullishCount === bearishCount ? 'DISAGREE' : 'AGREE',
    technicalScore,
    warning,
    reasoning: generateReasoning(cerebras, groq, mlFeatures, technicalScore)
  };
}

function parseAIResponse(response) {
  if (!response) return { direction: null, confidence: 0 };
  
  const text = typeof response === 'string' ? response.toUpperCase() : '';
  
  let direction = null;
  if (text.includes('BULLISH') || text.includes('BUY')) direction = 'BUY';
  else if (text.includes('BEARISH') || text.includes('SELL')) direction = 'SELL';
  
  // Extract confidence number
  const match = text.match(/(\d{1,3})%/);
  const confidence = match ? parseInt(match[1]) : 50;
  
  return { direction, confidence };
}

function generateReasoning(cerebras, groq, mlFeatures, technicalScore) {
  const reasons = [];
  
  if (cerebras.direction) reasons.push(`Cerebras: ${cerebras.direction} (${cerebras.confidence}%)`);
  if (groq.direction) reasons.push(`Groq: ${groq.direction} (${groq.confidence}%)`);
  
  if (mlFeatures.structureTrend > 0) reasons.push('Structure: Bullish');
  if (mlFeatures.structureTrend < 0) reasons.push('Structure: Bearish');
  if (mlFeatures.sweepDetected > 0) reasons.push('Liquidity sweep detected');
  if (mlFeatures.adx > 25) reasons.push(`Strong trend (ADX: ${r2(mlFeatures.adx)})`);
  
  reasons.push(`Technical base score: ${technicalScore}`);
  
  return reasons;
}

/**
 * Validate AI result against structure (prevent AI hallucinations)
 */
export function validateAIAgainstStructure(aiResult, structure) {
  const issues = [];
  
  if (aiResult.direction === 'BUY' && structure.trend === 'BEARISH' && structure.score < 35) {
    issues.push('AI suggests BUY in strong bearish structure');
  }
  if (aiResult.direction === 'SELL' && structure.trend === 'BULLISH' && structure.score > 65) {
    issues.push('AI suggests SELL in strong bullish structure');
  }
  if (aiResult.direction === 'BUY' && structure.isAtResistance) {
    issues.push('AI suggests BUY at resistance');
  }
  if (aiResult.direction === 'SELL' && structure.isAtSupport) {
    issues.push('AI suggests SELL at support');
  }
  
  return {
    valid: issues.length === 0,
    issues,
    adjustedConfidence: issues.length > 0 ? Math.max(30, aiResult.confidence - issues.length * 15) : aiResult.confidence
  };
}

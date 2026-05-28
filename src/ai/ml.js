/**
 * Lightweight ML Signal Scoring
 * Uses historical feature vectors to predict probability of success
 * Runs in Cloudflare Workers using simple statistical models (no heavy deps)
 */

import { r2 } from '../utils/helpers.js';

/**
 * Feature vector extraction from signal data
 */
export function extractFeatures(signal, indicators, structure, liquidity, regime) {
  return {
    // Trend features
    emaDistance: indicators.ema50 && indicators.ema200 
      ? (indicators.ema50 - indicators.ema200) / indicators.ema200 
      : 0,
    adx: indicators.adx || 0,
    rsi: indicators.rsi || 50,
    rsiSlope: calculateRSISlope(indicators.rsiHistory || []),
    macdHist: indicators.macd?.histogram || 0,
    
    // Structure features
    structureTrend: structure.trend === 'BULLISH' ? 1 : structure.trend === 'BEARISH' ? -1 : 0,
    hasBOS: structure.bos ? 1 : 0,
    hasCHoCH: structure.choch ? 1 : 0,
    atSupport: structure.isAtSupport ? 1 : 0,
    atResistance: structure.isAtResistance ? 1 : 0,
    
    // Liquidity features
    sweepDetected: liquidity.sweepDetected ? 1 : 0,
    sweepConfidence: liquidity.confidence || 0,
    nearLiquidity: liquidity.sweepRisk !== 'LOW' ? 1 : 0,
    
    // Volume/Regime
    volumeSpike: indicators.volumeSpike ? 1 : 0,
    regime: regime.regime === 'TRENDING' ? 1 : regime.regime === 'RANGING' ? 0 : -1,
    regimeStrength: regime.strength || 0,
    
    // Context
    session: signal.session === 'OVERLAP' ? 1 : signal.session === 'ASIAN' ? -1 : 0,
    gradeScore: gradeToScore(signal.grade),
    riskReward: signal.riskReward || 1.5,
    
    // Derived
    atrPercent: indicators.atr && signal.entry ? (indicators.atr / signal.entry) * 100 : 0,
    bbPosition: indicators.bb?.position || 0.5
  };
}

function calculateRSISlope(rsiHistory) {
  if (!rsiHistory || rsiHistory.length < 5) return 0;
  const recent = rsiHistory.slice(-5);
  const first = recent[0];
  const last = recent[recent.length - 1];
  return last - first;
}

function gradeToScore(grade) {
  const scores = { 'A+': 1.0, 'A': 0.9, 'B': 0.7, 'C': 0.5, 'D': 0.3, 'F': 0 };
  return scores[grade] || 0.5;
}

/**
 * Simple weighted scoring model (no external ML library needed)
 * Weights derived from historical correlation analysis
 */
const FEATURE_WEIGHTS = {
  emaDistance: 0.08,
  adx: 0.10,
  rsi: 0.06,
  rsiSlope: 0.08,
  macdHist: 0.07,
  structureTrend: 0.12,
  hasBOS: 0.10,
  hasCHoCH: 0.09,
  atSupport: 0.08,
  atResistance: -0.08,
  sweepDetected: 0.11,
  sweepConfidence: 0.07,
  nearLiquidity: -0.05,
  volumeSpike: 0.06,
  regime: 0.05,
  regimeStrength: 0.04,
  session: 0.03,
  gradeScore: 0.10,
  riskReward: 0.08,
  atrPercent: -0.04,
  bbPosition: 0.03
};

/**
 * Predict win probability using weighted features
 */
export function predictWinProbability(features, historicalStats = null) {
  let score = 0.5; // Base probability
  
  for (const [feature, weight] of Object.entries(FEATURE_WEIGHTS)) {
    if (features[feature] !== undefined) {
      const normalized = normalizeFeature(feature, features[feature]);
      score += normalized * weight;
    }
  }
  
  // Adjust based on historical pair performance
  if (historicalStats) {
    const pairWinRate = historicalStats.winRate / 100;
    const pairFactor = (pairWinRate - 0.5) * 0.2; // ±10% adjustment
    score += pairFactor;
  }
  
  // Clamp to valid probability
  return Math.max(0.1, Math.min(0.9, score));
}

function normalizeFeature(name, value) {
  // Normalize different features to -1 to 1 range
  const ranges = {
    emaDistance: { min: -0.05, max: 0.05 },
    adx: { min: 0, max: 50 },
    rsi: { min: 0, max: 100 },
    rsiSlope: { min: -20, max: 20 },
    macdHist: { min: -2, max: 2 },
    structureTrend: { min: -1, max: 1 },
    hasBOS: { min: 0, max: 1 },
    hasCHoCH: { min: 0, max: 1 },
    atSupport: { min: 0, max: 1 },
    atResistance: { min: -1, max: 0 },
    sweepDetected: { min: 0, max: 1 },
    sweepConfidence: { min: 0, max: 100 },
    nearLiquidity: { min: -1, max: 0 },
    volumeSpike: { min: 0, max: 1 },
    regime: { min: -1, max: 1 },
    regimeStrength: { min: 0, max: 100 },
    session: { min: -1, max: 1 },
    gradeScore: { min: 0, max: 1 },
    riskReward: { min: 0.5, max: 5 },
    atrPercent: { min: 0, max: 5 },
    bbPosition: { min: 0, max: 1 }
  };
  
  const range = ranges[name];
  if (!range) return value;
  
  const normalized = (value - range.min) / (range.max - range.min);
  return (normalized * 2) - 1; // Scale to -1 to 1
}

/**
 * Ensemble: Combine ML prediction with technical score
 */
export function ensembleScore(technicalScore, mlProbability, aiConfidence = 50) {
  // Weight: Technical 40%, ML 35%, AI 25%
  const techNorm = technicalScore / 100;
  const mlNorm = mlProbability;
  const aiNorm = aiConfidence / 100;
  
  const ensemble = (techNorm * 0.40) + (mlNorm * 0.35) + (aiNorm * 0.25);
  return r2(ensemble * 100);
}

/**
 * Store feature vector for future model improvement
 */
export async function storeFeatureVector(env, signalId, features, outcome) {
  if (!env?.ML_DATA) return;
  
  const record = {
    signalId,
    features,
    outcome,
    timestamp: new Date().toISOString()
  };
  
  await env.ML_DATA.put(`ml:${signalId}`, JSON.stringify(record));
}

/**
 * Calculate feature importance from historical outcomes
 * (Run monthly to update FEATURE_WEIGHTS)
 */
export async function calculateFeatureImportance(env) {
  if (!env?.ML_DATA) return null;
  
  const records = [];
  let cursor = null;
  
  do {
    const list = await env.ML_DATA.list({ prefix: 'ml:', cursor, limit: 1000 });
    for (const { name } of list.keys || []) {
      const r = await env.ML_DATA.get(name);
      if (r) records.push(JSON.parse(r));
    }
    cursor = list.cursor;
  } while (cursor);
  
  if (records.length < 50) return { error: 'Insufficient data' };
  
  // Simple correlation analysis
  const wins = records.filter(r => r.outcome === 'WIN');
  const losses = records.filter(r => r.outcome === 'LOSS');
  
  const importance = {};
  const featureNames = Object.keys(FEATURE_WEIGHTS);
  
  for (const feat of featureNames) {
    const winAvg = average(wins.map(r => r.features[feat]).filter(v => v !== undefined));
    const lossAvg = average(losses.map(r => r.features[feat]).filter(v => v !== undefined));
    
    if (winAvg !== null && lossAvg !== null) {
      importance[feat] = r2(winAvg - lossAvg);
    }
  }
  
  return {
    totalRecords: records.length,
    winCount: wins.length,
    lossCount: losses.length,
    featureImportance: importance,
    recommendation: 'Use positive features as confirmation, negative as warning'
  };
}

function average(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

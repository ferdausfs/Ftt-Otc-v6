/**
 * R7.1 — shared deterministic engine pipeline.
 *
 * This is the "shared pure deterministic helper" the R7.1 design calls for.
 * It contains the EXACT weighted-vote + deterministic-filter block that used
 * to live inline inside buildMultiTimeframeSignal() (commit 71e87eb), lifted
 * verbatim into a function so that:
 *
 *   1. production (buildMultiTimeframeSignal) calls it once with the production
 *      per-timeframe votes, and
 *   2. the structure-excluded shadow path calls it once with the no-structure
 *      per-timeframe votes,
 *
 * …both going through ONE implementation. That removes the drift risk of two
 * separate filter copies. Baseline-vs-instrumented equivalence is asserted in
 * scripts/r71_tests.mjs (test #1).
 *
 * Nothing here is structure-specific. The ONLY place structure influences the
 * engine result is the per-timeframe vote direction/score/confluence, which the
 * caller supplies. Every filter below (HTF block, session, exotic, candle
 * consistency, volume spike, FVG, market condition, dead-market, confidence
 * floor, candle quality, dynamic history, news blackout) is structure-agnostic
 * and therefore applies identically to the production and shadow passes.
 *
 * This function is the deterministic PRE-AI boundary. It never calls an AI.
 */

import { CONFIG, ASSET_TYPE } from '../config.js';
import { resolveTieWithTolerance } from '../analysis/grade.js';
import {
  recentCandleConsistency, isVolumeSpikeAnomaly,
} from '../analysis/filters.js';
import { detectMarketCondition } from '../indicators/regime.js';
import { getDynamicConfidenceAdjustment } from '../history/stats.js';

/**
 * Pure per-timeframe direction decision (timeframe.js). Extracted verbatim so
 * the production per-TF decision and the shadow per-TF decision share one
 * implementation and cannot drift.
 *
 *   upScore / downScore : the category score totals for the TF
 *   upCat / downCat     : the confluence category counts
 *   minScoreThreshold   : SCORE_THRESHOLDS[assetType]
 */
export function decideTfDirection(upScore, downScore, upCat, downCat, minScoreThreshold) {
  const scoreDiff  = Math.abs(upScore - downScore);
  const confluence = Math.max(upCat, downCat);
  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) return 'BUY';
  if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) return 'SELL';
  if (scoreDiff >= 4.0 && confluence >= 4) return upScore > downScore ? 'BUY' : 'SELL';
  return 'NO_TRADE';
}

/**
 * Deterministic pre-AI pipeline. Mirrors engine.js 71e87eb lines
 * "WEIGHTED VOTING" .. "NEWS BLACKOUT final check" byte-for-byte.
 *
 * ctx fields:
 *   votes, candleData, tfResults, higherTFTrend, marketRegime,
 *   session, sessionMult, candleQualityMult, exotic, assetType,
 *   newsBlock, newsBlocked, pair, env
 */
export async function runDeterministicVoteAndFilters(ctx) {
  const {
    votes, candleData, tfResults, higherTFTrend, marketRegime,
    session, sessionMult, candleQualityMult, exotic, assetType,
    newsBlock, newsBlocked, pair, env,
  } = ctx;

  const filtersApplied = [];

  // ── WEIGHTED VOTING ──
  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0;
  const activeDirs = [];
  for (const vote of votes) {
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * sessionMult * candleQualityMult;
    if (vote.direction === 'BUY')       { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell     += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else                                { weightedNoTrade  += w; }
  }

  // ── ALIGNMENT ──
  const allBuy  = activeDirs.length > 0 && activeDirs.every(d => d === 'BUY');
  const allSell = activeDirs.length > 0 && activeDirs.every(d => d === 'SELL');
  let alignment = 'MIXED'; let alignmentBonus = 0;
  const fullBonus    = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 8 : 3;
  const partialBonus = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 4 : 2;
  if (allBuy)       { alignment = 'ALL_BULLISH'; alignmentBonus = fullBonus; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = fullBonus; }
  else if (!allBuy && !allSell && activeDirs.length >= 2) {
    const bc = activeDirs.filter(d => d === 'BUY').length;
    const sc = activeDirs.filter(d => d === 'SELL').length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = partialBonus; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = partialBonus; }
  }

  // ── FINAL DIRECTION + CONFIDENCE ──
  let finalDirection; let confidence;
  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round((weightedBuy / d) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    const d = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = d > 0 ? Math.round((weightedSell / d) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction; confidence = tie.confidence;
  }

  // Save raw direction BEFORE all filters (AI rescue uses this)
  const rawDirection  = finalDirection;
  const rawConfidence = confidence;

  // ── HTF HARD BLOCK ──
  if (higherTFTrend !== null && finalDirection !== 'NO_TRADE' && finalDirection !== higherTFTrend) {
    const htf15  = tfResults['15min'];
    const htfADX = htf15 && htf15.indicators ? parseFloat(htf15.indicators.adx) : null;
    if (htfADX !== null && !isNaN(htfADX) && htfADX >= 25) {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('HTF_HARD_BLOCK (ADX=' + htfADX.toFixed(0) + ')');
    } else {
      confidence = Math.max(0, confidence - 18);
      filtersApplied.push('HTF_SOFT_PENALTY -18');
    }
  } else if (higherTFTrend !== null && finalDirection === higherTFTrend) {
    confidence = Math.min(92, confidence + 5);
  }

  confidence = Math.min(92, confidence + alignmentBonus);
  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; filtersApplied.push('MIXED_ALIGNMENT'); }

  // ── SESSION BLOCK (Forex only) ──
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === 'LOW') {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('SESSION_LOW_QUALITY_BLOCK');
    } else if (session.quality === 'HIGHEST') {
      confidence = Math.min(92, confidence + 3);
    }
  }

  if (exotic) { confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY); filtersApplied.push('EXOTIC_PENALTY -' + CONFIG.EXOTIC_CONFIDENCE_PENALTY); }

  // ── CANDLE CONSISTENCY ──
  const primaryCandles = candleData['5min'] || candleData['1min'] || candleData['15min'];
  let consistencyMult = 1.0;
  if (primaryCandles && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 4);
    if (consistencyMult < 1.0) {
      confidence = Math.round(confidence * consistencyMult);
      filtersApplied.push('CANDLE_INCONSISTENCY (x' + consistencyMult + ')');
    }
  }

  // ── VOLUME SPIKE FILTER ──
  let volumeSpikeBlocked = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles) {
    volumeSpikeBlocked = isVolumeSpikeAnomaly(primaryCandles, assetType);
    if (volumeSpikeBlocked) { finalDirection = 'NO_TRADE'; confidence = 0; filtersApplied.push('VOLUME_SPIKE_ANOMALY'); }
  }

  // ── FVG FILTER ──
  let fvgBlocked = false;
  const fvgCheckTF = tfResults['1min'] || tfResults['5min'] || tfResults['15min'];
  if (finalDirection !== 'NO_TRADE' && fvgCheckTF && fvgCheckTF.categoryScores && fvgCheckTF.categoryScores.fvg) {
    const activeFVGType = fvgCheckTF.categoryScores.fvg.active;
    if (activeFVGType && activeFVGType !== 'NONE') {
      if (finalDirection === 'BUY' && activeFVGType === 'BEARISH') {
        fvgBlocked = true; confidence = Math.max(0, confidence - 20);
        filtersApplied.push('FVG_PENALTY -20 (inside bearish FVG)');
      }
      if (finalDirection === 'SELL' && activeFVGType === 'BULLISH') {
        fvgBlocked = true; confidence = Math.max(0, confidence - 20);
        filtersApplied.push('FVG_PENALTY -20 (inside bullish FVG)');
      }
    }
  }

  // ── MARKET CONDITION ──
  const htfTFResult = tfResults['15min'] || tfResults['5min'] || tfResults['1min'];
  let marketCondition = ['UNKNOWN']; let marketContext = 'UNKNOWN';
  if (htfTFResult) {
    const htfCandles = candleData['15min'] || candleData['5min'] || candleData['1min'];
    const adxH  = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.adx)        : null;
    const bbBWH = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.bbBandwidth) : null;
    const atrH  = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.atr)         : null;
    const lcH   = htfCandles ? htfCandles[htfCandles.length - 1].close : null;
    if (lcH !== null) marketCondition = detectMarketCondition(isNaN(adxH)?null:adxH, isNaN(bbBWH)?null:bbBWH, isNaN(atrH)?null:atrH, lcH, assetType);
    marketContext = (!isNaN(adxH) && adxH !== null) ? (adxH >= 25 ? 'TRENDING' : 'RANGING') : 'UNKNOWN';
  }

  // ── DEAD_MARKET soft block — AI gets rescue chance for borderline ──
  const isDeadMarket = marketCondition.includes('DEAD_MARKET');
  if (finalDirection !== 'NO_TRADE' && isDeadMarket && confidence < 65) {
    finalDirection = 'NO_TRADE'; confidence = Math.min(confidence, 30);
    filtersApplied.push('DEAD_MARKET_HARD_BLOCK (conf<65)');
  }

  // ── CONFIDENCE FLOOR ──
  let belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    belowFloor = true; finalDirection = 'NO_TRADE';
    filtersApplied.push('CONFIDENCE_BELOW_FLOOR (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
  }

  // ── CANDLE QUALITY PENALTY ──
  if (finalDirection !== 'NO_TRADE' && candleQualityMult < 0.8) {
    confidence = Math.max(0, confidence - 15);
    filtersApplied.push('LOW_CANDLE_QUALITY_PENALTY -15');
    if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('BELOW_FLOOR_AFTER_QUALITY_PENALTY');
    }
  }

  // ── DYNAMIC HISTORY ADJUSTMENT ──
  if (finalDirection !== 'NO_TRADE' && env && env.SIGNAL_CACHE) {
    const dynAdj = await getDynamicConfidenceAdjustment(pair, env);
    if (dynAdj !== 0) {
      confidence = Math.max(0, Math.min(92, confidence + dynAdj));
      filtersApplied.push('DYNAMIC_CONF_ADJ: ' + (dynAdj > 0 ? '+' : '') + dynAdj);
      if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR && finalDirection !== 'NO_TRADE') {
        finalDirection = 'NO_TRADE'; confidence = 0;
        filtersApplied.push('BELOW_FLOOR_AFTER_DYN_ADJ');
      }
    }
  }

  // ── NEWS BLACKOUT final check ──
  if (newsBlocked && finalDirection !== 'NO_TRADE') {
    finalDirection = 'NO_TRADE'; confidence = 0;
    filtersApplied.push('NEWS_BLACKOUT: ' + (newsBlock?.label || ''));
  }

  return {
    finalDirection, confidence,
    rawDirection, rawConfidence,
    filtersApplied, belowFloor,
    volumeSpikeBlocked, fvgBlocked,
    weightedBuy, weightedSell, weightedNoTrade,
    alignment, alignmentBonus,
    marketCondition, marketContext,
    isDeadMarket, activeDirs,
  };
}

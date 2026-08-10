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

import { CONFIG, ASSET_TYPE, EDGE_FEATURE_CONFIG } from '../config.js';
import { resolveTieWithTolerance } from '../analysis/grade.js';
import {
  recentCandleConsistency, isVolumeSpikeAnomaly,
} from '../analysis/filters.js';
import { detectMarketCondition } from '../indicators/regime.js';
import { getDynamicConfidenceAdjustment, getRecentPairForm } from '../history/stats.js';
import { getHourMultiplier, selectDirectionIndicatorContext } from '../analysis/edgeFeatures.js';

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
  // F3-19 (BUG-020): the fallback branch must not silently bypass the
  // MIN_CONFLUENCE gate — the WINNING side needs the full 5-category
  // confluence, not a max() of both sides at 4 (previously a 4-cat winner
  // could trade on the other side's categories).
  if (scoreDiff >= 4.0 && (upScore > downScore ? upCat : downCat) >= CONFIG.MIN_CONFLUENCE)
    return upScore > downScore ? 'BUY' : 'SELL';
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
    now = new Date(), sessionRange = null, adaptiveProfile = null,
    edgeFeaturesEnabled = true,
  } = ctx;

  const filtersApplied = [];
  const hourContext = getHourMultiplier(now, adaptiveProfile);
  const edgeContext = {
    version: EDGE_FEATURE_CONFIG.VERSION,
    time: hourContext,
    sessionRange: sessionRange || { state: 'UNKNOWN', position: null },
    indicators: null,
    recentForm: null,
    adaptive: adaptiveProfile ? {
      version: adaptiveProfile.version || null,
      generatedAt: adaptiveProfile.generatedAt || null,
    } : null,
    hardBlock: null,
  };
  let edgeHardBlock = false;

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

  // ── ALIGNMENT BONUS ──
  // F3-06 (BUG-014): applied BEFORE the hard-block zeroing. Previously the
  // HTF_HARD_BLOCK set confidence = 0 and the bonus then resurrected it
  // (0 + 8 = 8% on a fully blocked signal). Now a hard block leaves 0.
  confidence = Math.min(92, confidence + alignmentBonus);
  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; filtersApplied.push('MIXED_ALIGNMENT'); }

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

  // ── SESSION BLOCK (Forex only) ──
  // F3-12 (BUG-021): the HIGHEST-session +3 bonus is removed — it was dead
  // code: engine.js hard-blocks every forex signal in the HIGHEST session
  // (D2_HIGHEST_SESSION_BLOCK, 6.1% WR n=66), so the bonus could never be
  // observed on a trade. If the D2 block is ever lifted, the bonus should be
  // reintroduced as a deliberate, evidence-backed design decision.
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === 'LOW') {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('SESSION_LOW_QUALITY_BLOCK');
    }
  }

  if (exotic) { confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY); filtersApplied.push('EXOTIC_PENALTY -' + CONFIG.EXOTIC_CONFIDENCE_PENALTY); }

  // ── EDGE INPUT CONTEXT ──────────────────────────────────────
  // These factors/gates run on raw engine confidence.  The CALIB output mapper
  // remains later in engine.js and is called exactly once.
  if (edgeFeaturesEnabled && finalDirection !== 'NO_TRADE') {
    const indicatorContext = selectDirectionIndicatorContext(tfResults, finalDirection);
    edgeContext.indicators = indicatorContext;

    // RSI × direction: do not chase BUY above 55 or SELL below 45.  Extreme
    // mean-reversion in the opposite direction (BUY oversold / SELL overbought)
    // remains valid.
    const rsiCfg = EDGE_FEATURE_CONFIG.RSI_DIRECTION;
    if (rsiCfg.enabled && rsiCfg.applyGate && indicatorContext && indicatorContext.rsi !== null) {
      const chasingBuy = finalDirection === 'BUY' && indicatorContext.rsi > rsiCfg.buyBlockAbove;
      const chasingSell = finalDirection === 'SELL' && indicatorContext.rsi < rsiCfg.sellBlockBelow;
      if (chasingBuy || chasingSell) {
        edgeHardBlock = true;
        edgeContext.hardBlock = chasingBuy ? 'RSI_CHASING_BUY' : 'RSI_CHASING_SELL';
        finalDirection = 'NO_TRADE'; confidence = 0;
        filtersApplied.push('RSI_DIRECTION_BLOCK (' + indicatorContext.timeframe
          + ' RSI=' + indicatorContext.rsi.toFixed(1) + ')');
      }
    }

    // BB bandwidth relative to its own trailing median. Wide is normal (no
    // boost), mid squeeze is penalised, and a dead squeeze is a hard block.
    const volCfg = EDGE_FEATURE_CONFIG.VOLATILITY_STATE;
    if (finalDirection !== 'NO_TRADE' && volCfg.enabled && volCfg.applyFactor && indicatorContext) {
      if (indicatorContext.volatilityState === 'DEAD_SQUEEZE' && volCfg.deadAction === 'BLOCK') {
        edgeHardBlock = true;
        edgeContext.hardBlock = 'BB_DEAD_SQUEEZE';
        finalDirection = 'NO_TRADE'; confidence = 0;
        filtersApplied.push('VOLATILITY_DEAD_SQUEEZE_BLOCK');
      } else if (indicatorContext.volatilityState === 'MID_SQUEEZE') {
        confidence = Math.round(confidence * volCfg.midSqueezeFactor);
        filtersApplied.push('VOLATILITY_MID_SQUEEZE (x' + volCfg.midSqueezeFactor + ')');
      }
    }

    // ATR percentile is classified and instrumented now. Its action remains
    // config-disabled until train→holdout rows exist for the fixed windows.
    const atrCfg = EDGE_FEATURE_CONFIG.ATR_PERCENTILE;
    if (finalDirection !== 'NO_TRADE' && atrCfg.enabled && atrCfg.applyFactor && indicatorContext) {
      if (indicatorContext.atrState === 'DEAD' && atrCfg.deadAction === 'BLOCK') {
        edgeHardBlock = true;
        edgeContext.hardBlock = 'ATR_DEAD';
        finalDirection = 'NO_TRADE'; confidence = 0;
        filtersApplied.push('ATR_PERCENTILE_DEAD_BLOCK');
      } else if (indicatorContext.atrState === 'SQUEEZE') {
        confidence = Math.round(confidence * atrCfg.lowVolFactor);
        filtersApplied.push('ATR_PERCENTILE_SQUEEZE (x' + atrCfg.lowVolFactor + ')');
      }
    }

    // Hour and any holdout-approved adaptive dimensions. Common vote weights
    // would cancel in the vote-share ratio, so these deliberately scale the raw
    // confidence before the floor instead.
    const hourCfg = EDGE_FEATURE_CONFIG.HOUR_OF_DAY;
    const adaptiveCfg = EDGE_FEATURE_CONFIG.ADAPTIVE_CALIBRATION;
    if (finalDirection !== 'NO_TRADE' && hourCfg.enabled) {
      const factor = adaptiveCfg.applyHourWeights ? hourContext.multiplier
        : (hourCfg.multipliers[hourContext.hourUtc] || 1);
      confidence = Math.max(0, Math.min(92, Math.round(confidence * factor)));
      if (factor !== 1) filtersApplied.push('HOUR_OF_DAY_UTC_' + hourContext.hourUtc + ' (x' + factor.toFixed(2) + ')');
    }

    if (finalDirection !== 'NO_TRADE' && adaptiveProfile && adaptiveProfile.weights) {
      let factor = 1;
      if (adaptiveCfg.applyPairWeights && adaptiveProfile.weights.pair)
        factor *= adaptiveProfile.weights.pair[pair] || 1;
      const activeSession = session && session.overlap && session.overlap !== 'NONE'
        ? session.overlap : (session && session.sessions && session.sessions[0]) || 'UNKNOWN';
      if (adaptiveCfg.applySessionWeights && adaptiveProfile.weights.session)
        factor *= adaptiveProfile.weights.session[activeSession] || 1;
      if (factor !== 1) {
        confidence = Math.max(0, Math.min(92, Math.round(confidence * factor)));
        filtersApplied.push('ADAPTIVE_PAIR_SESSION (x' + factor.toFixed(2) + ')');
      }
    }

    // Session-range mean-reversion bonus: near today's low supports BUY and
    // near today's high supports SELL. Position is always emitted; factor use
    // stays behind its evidence flag.
    const rangeCfg = EDGE_FEATURE_CONFIG.SESSION_RANGE;
    if (finalDirection !== 'NO_TRADE' && rangeCfg.enabled && rangeCfg.applyFactor && sessionRange) {
      const supportsMeanReversion =
        (finalDirection === 'BUY' && sessionRange.state === 'LOW_EXTREME')
        || (finalDirection === 'SELL' && sessionRange.state === 'HIGH_EXTREME');
      if (supportsMeanReversion) {
        confidence = Math.max(0, Math.min(92, Math.round(confidence * rangeCfg.meanReversionFactor)));
        filtersApplied.push('SESSION_RANGE_MEAN_REVERSION (x' + rangeCfg.meanReversionFactor + ')');
      }
    }
  }

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
  // F3-09 (BUG-031): check the HIGHER timeframe first (mirrors the
  // marketCondition ordering below) — 1min FVGs are noisy order-flow noise
  // and were penalizing otherwise-valid 5min/15min signals with -20.
  const fvgCheckTF = tfResults['15min'] || tfResults['5min'] || tfResults['1min'];
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

  // ── RECENT FORM + DYNAMIC HISTORY ADJUSTMENT ──
  // `/api/stats` already maintains the exact last-20 ring.  A sub-35% pair is
  // scaled once (not also given the legacy -10 penalty), preventing accidental
  // double punishment while retaining the older bonus/moderate-penalty path.
  if (finalDirection !== 'NO_TRADE' && env && env.SIGNAL_CACHE) {
    const formCfg = EDGE_FEATURE_CONFIG.RECENT_FORM;
    const recentForm = await getRecentPairForm(pair, env);
    edgeContext.recentForm = recentForm;
    let recentFormApplied = false;
    if (edgeFeaturesEnabled && formCfg.enabled && recentForm
        && recentForm.sampleSize >= formCfg.minSamples
        && recentForm.winRate < formCfg.blockBelowWinRate) {
      recentFormApplied = true;
      confidence = Math.round(confidence * formCfg.confidenceFactor);
      filtersApplied.push('RECENT_FORM_GATE (' + Math.round(recentForm.winRate * 100)
        + '% n=' + recentForm.sampleSize + ' x' + formCfg.confidenceFactor + ')');
      if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
        finalDirection = 'NO_TRADE'; confidence = 0;
        filtersApplied.push('BELOW_FLOOR_AFTER_RECENT_FORM');
      }
    }

    if (!recentFormApplied && finalDirection !== 'NO_TRADE') {
      const dynAdj = await getDynamicConfidenceAdjustment(pair, env);
      if (dynAdj !== 0) {
        confidence = Math.max(0, Math.min(92, confidence + dynAdj));
        filtersApplied.push('DYNAMIC_CONF_ADJ: ' + (dynAdj > 0 ? '+' : '') + dynAdj);
        if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
          finalDirection = 'NO_TRADE'; confidence = 0;
          filtersApplied.push('BELOW_FLOOR_AFTER_DYN_ADJ');
        }
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
    edgeContext, edgeHardBlock,
  };
}

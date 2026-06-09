import {
  CONFIG, ASSET_TYPE, CANDLE_MINUTES,
} from '../config.js';
import { safeLastValue, r2, formatDuration, getCandleCountdown, getNextCandleClose } from '../utils/helpers.js';
import { detectTradingSession, checkNewsBlackout } from '../utils/session.js';
import { isExoticPair } from '../utils/pairs.js';
import { calculateAllIndicators } from '../indicators/index.js';
import { detectMarketRegime, detectMarketCondition, getRegimeAdvice } from '../indicators/regime.js';
import { analyzeTimeframe } from './timeframe.js';
import { calculateCandleDuration } from '../analysis/duration.js';
import { generateEntryReason, isVolumeSpikeAnomaly, recentCandleConsistency, getSessionWeightMultiplier, getCandleQualityMultiplier } from '../analysis/filters.js';
import { getSignalGrade, resolveTieWithTolerance } from '../analysis/grade.js';
import { callCerebrasValidation } from '../ai/cerebras.js';
import { callGroqValidation } from '../ai/groq.js';
import { combineDualAIResults, buildIndicatorSnapshot } from '../ai/combine.js';
import { getDynamicConfidenceAdjustment } from '../history/stats.js';

export async function buildMultiTimeframeSignal(pair, candleData, assetType, env) {
  const now     = new Date();
  const session = detectTradingSession();
  const exotic  = isExoticPair(pair);

  const newsBlock   = checkNewsBlackout(assetType);
  const newsBlocked = !!(newsBlock && newsBlock.blocked);
  const filtersApplied = [];

  // ── FIX: Calculate indicators ONCE per TF, cache results ──
  // Previously: 15min was calculated 3x (HTF trend + regime + per-TF loop)
  const indicatorCache = {};
  for (const tf of Object.keys(candleData)) {
    if (candleData[tf] && candleData[tf].length > 0) {
      indicatorCache[tf] = calculateAllIndicators(candleData[tf]);
    }
  }

  // ── HTF TREND (use cached 15min indicators) ──
  let higherTFTrend = null;
  if (indicatorCache['15min']) {
    const htfInd   = indicatorCache['15min'];
    const htfEma5  = safeLastValue(htfInd.ema5);
    const htfEma13 = safeLastValue(htfInd.ema13);
    const htfEma55 = safeLastValue(htfInd.ema55);
    const htfAdx   = htfInd.adx ? safeLastValue(htfInd.adx.adx)    : null;
    const htfPDI   = htfInd.adx ? safeLastValue(htfInd.adx.plusDI)  : null;
    const htfMDI   = htfInd.adx ? safeLastValue(htfInd.adx.minusDI) : null;
    // Fix: ADX threshold raised to 25 (was 20 — too loose)
    if (htfEma5 !== null && htfEma55 !== null && htfAdx !== null && htfAdx >= 25) {
      if (htfEma5 > htfEma55 && htfPDI !== null && htfMDI !== null && htfPDI > htfMDI) higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma55 && htfPDI !== null && htfMDI !== null && htfMDI > htfPDI) higherTFTrend = 'SELL';
    }
    // Also check EMA 5/13/55 full stack for HTF (stronger signal)
    if (higherTFTrend === null && htfEma5 !== null && htfEma13 !== null && htfEma55 !== null) {
      if (htfEma5 > htfEma13 && htfEma13 > htfEma55) higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma13 && htfEma13 < htfEma55) higherTFTrend = 'SELL';
    }
  }

  // ── MARKET REGIME (use cached 15min indicators) ──
  let marketRegime = 'RANGING';
  const regimeTF = indicatorCache['15min'] || indicatorCache['5min'] || indicatorCache['1min'];
  const regimeCandles = candleData['15min'] || candleData['5min'] || candleData['1min'];
  if (regimeTF && regimeCandles) {
    const rAdx  = safeLastValue(regimeTF.adx.adx);
    const rBbArr = regimeTF.bollinger.bandwidth;
    const bwVals = [];
    if (rBbArr) {
      for (let bi = rBbArr.length - 1; bi >= 0 && bwVals.length < 2; bi--) {
        if (rBbArr[bi] !== null && !isNaN(rBbArr[bi])) bwVals.push(rBbArr[bi]);
      }
    }
    const rBbBW     = bwVals[0] || null;
    const rBbBWPrev = bwVals[1] || null;
    const rAtr = safeLastValue(regimeTF.atr);
    const rLC  = regimeCandles[regimeCandles.length - 1].close;
    marketRegime = detectMarketRegime(rAdx, rBbBW, rAtr, rLC, assetType, rBbBWPrev);
  }

  // ── PER-TIMEFRAME ANALYSIS (use cached indicators) ──
  const tfResults = {};
  const votes     = [];
  for (const tf of Object.keys(candleData)) {
    const candles    = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = indicatorCache[tf];
    if (!indicators) continue;

    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend, marketRegime);

    const durCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType);
    const candleMin  = CANDLE_MINUTES[tf] || 1;
    const durMinutes = durCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durMinutes * 60000);
    const nextClose  = getNextCandleClose(now, candleMin);
    const countdown  = getCandleCountdown(candleMin);

    analysis.expiry = {
      candles: durCandles, candleSize: candleMin + 'min', totalMinutes: durMinutes,
      expiryTime: expiryTime.toISOString(), humanReadable: formatDuration(durMinutes),
      nextCandleClose: nextClose.toISOString(), countdown,
    };
    analysis.entry = {
      price: candles[candles.length - 1].close,
      candleTime: candles[candles.length - 1].datetime,
      candleDirection: candles[candles.length - 1].close >= candles[candles.length - 1].open ? 'BULLISH' : 'BEARISH',
    };
    analysis.higherTFTrend  = higherTFTrend;
    analysis.alignedWithHTF = (higherTFTrend === null || analysis.direction === 'NO_TRADE' || analysis.direction === higherTFTrend);

    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf, alignedWithHTF: analysis.alignedWithHTF });
  }

  // ── SESSION + CANDLE QUALITY MULTIPLIERS ──
  const sessionMult = getSessionWeightMultiplier(pair, session);
  let qualityCandles = [];
  if (candleData['1min']  && tfResults['1min']  && !tfResults['1min'].deadMarket)  qualityCandles = candleData['1min'];
  else if (candleData['5min']  && tfResults['5min']  && !tfResults['5min'].deadMarket)  qualityCandles = candleData['5min'];
  else if (candleData['15min'] && tfResults['15min'] && !tfResults['15min'].deadMarket) qualityCandles = candleData['15min'];
  else qualityCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];
  const candleQualityMult = getCandleQualityMultiplier(qualityCandles);

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

  // ── AI VALIDATION ──
  // Runs on valid signal OR raw direction (when borderline filters blocked it)
  const aiTargetDir = finalDirection !== 'NO_TRADE'
    ? finalDirection
    : (rawDirection !== 'NO_TRADE' && rawConfidence >= 60 ? rawDirection : null);

  let aiValidation = { status: 'SKIPPED' }; let aiAgreed = null;

  if (aiTargetDir) {
    const aiUseConf  = finalDirection !== 'NO_TRADE' ? confidence : rawConfidence;
    const bestSnap   = findBestTimeframe(tfResults, aiTargetDir);
    const snapshot   = buildIndicatorSnapshot(tfResults, candleData, aiTargetDir, bestSnap.timeframe);
    const engineSig  = {
      direction: aiTargetDir, confidence: aiUseConf + '%', alignment,
      higherTFTrend: higherTFTrend || 'NEUTRAL', marketCondition, bestTF: bestSnap.timeframe,
    };

    const [cerebrasResult, groqResult] = await Promise.all([
      callCerebrasValidation(pair, assetType, engineSig, snapshot, env),
      callGroqValidation(pair, assetType, engineSig, snapshot, env),
    ]);
    const dualResult = combineDualAIResults(cerebrasResult, groqResult, aiTargetDir);
    aiValidation = dualResult;
    const combinedAI = dualResult.combined;

    if (combinedAI && combinedAI.status === 'OK') {
      aiAgreed = combinedAI.signal === aiTargetDir;
      aiValidation.agrees = aiAgreed;

      // ── FIX: Separate rescue path vs normal path (no double-boost) ──
      if (finalDirection === 'NO_TRADE' && aiTargetDir !== 'NO_TRADE') {
        // RESCUE PATH — signal was blocked by soft filter
        if (aiAgreed && (combinedAI.confidence || 0) >= 70 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(92, Math.round((rawConfidence + (combinedAI.confidence || 0)) / 2));
          belowFloor = false;
          filtersApplied.push('AI_RESCUE: ' + aiTargetDir + ' raw=' + rawConfidence + '% AI=' + (combinedAI.confidence || 0) + '% → ' + confidence + '%');
        } else if (aiAgreed && (combinedAI.confidence || 0) >= 60 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(85, rawConfidence + 5);
          belowFloor = false;
          filtersApplied.push('AI_SOFT_RESCUE: ' + aiTargetDir + ' @ ' + confidence + '%');
        } else {
          filtersApplied.push('AI_RESCUE_FAILED: conf=' + (combinedAI.confidence || 0) + '% concerns=' + (combinedAI.concerns || 'none'));
        }
      } else if (finalDirection !== 'NO_TRADE') {
        // NORMAL PATH — signal was already valid, AI confirms or blocks
        if (aiAgreed) {
          if (!combinedAI.concerns) {
            const boost = combinedAI.agreement === 'BOTH_AGREE' ? 8 : 5;
            confidence = Math.min(92, confidence + boost);
            filtersApplied.push('DUAL_AI_BOOST: ' + (combinedAI.agreement || 'AGREE') + ' +' + boost);
          } else {
            confidence = Math.max(0, confidence - 5);
            filtersApplied.push('DUAL_AI_AGREE_WITH_CONCERNS: ' + combinedAI.concerns);
          }
        } else {
          finalDirection = 'NO_TRADE'; confidence = 0;
          filtersApplied.push('DUAL_AI_DISAGREE_BLOCK (AI=' + combinedAI.signal + ')');
        }
      }
    }
  }

  // ── BUILD OUTPUTS ──
  const best    = findBestTimeframe(tfResults, finalDirection);
  const avgConf = votes.reduce((s, v) => s + (v.confluence || 0), 0) / Math.max(votes.length, 1);

  const recommendations = {};
  for (const [rtf, rec] of Object.entries(tfResults)) {
    recommendations[rtf] = {
      direction: rec.direction, score: rec.score,
      confluence: rec.confluence + '/11 categories', alignedWithHTF: rec.alignedWithHTF,
      expiry: rec.expiry, entry: rec.entry,
      candleConfirmed: rec.candleConfirmed,
      patterns:   (rec.categoryScores?.patterns?.detected)    || [],
      divergence: { rsi: rec.categoryScores?.divergence?.rsi || 'NONE', macd: rec.categoryScores?.divergence?.macd || 'NONE' },
      diCrossover: rec.categoryScores?.adx?.diCross || 'NONE',
    };
  }

  const bestTFAnalysis = tfResults[best.timeframe] || null;
  const entryReason    = generateEntryReason(finalDirection, bestTFAnalysis?.categoryScores || {}, bestTFAnalysis?.indicators || {}, alignment, higherTFTrend, marketContext);

  if (sessionMult !== 1.0)      filtersApplied.push('SESSION_WEIGHT x' + sessionMult.toFixed(2));
  if (candleQualityMult !== 1.0) filtersApplied.push('CANDLE_QUALITY x' + candleQualityMult.toFixed(2));
  if (isDeadMarket && finalDirection !== 'NO_TRADE') filtersApplied.push('DEAD_MARKET_WARN (AI rescued)');

  const finalGrade = getSignalGrade(confidence, avgConf, alignment);

  return {
    finalSignal: finalDirection, confidence: confidence + '%', grade: finalGrade,
    assetType, marketRegime, regimeAdvice: getRegimeAdvice(marketRegime, finalDirection),
    marketCondition, alignment, higherTFTrend: higherTFTrend || 'NEUTRAL',
    entryReason, filtersApplied, newsBlackout: newsBlock || null, aiValidation,
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ['24/7'], quality: 'N/A' },
    recommendations, bestTimeframe: best,
    votes: {
      BUY: votes.filter(v => v.direction === 'BUY').length,
      SELL: votes.filter(v => v.direction === 'SELL').length,
      NO_TRADE: votes.filter(v => v.direction === 'NO_TRADE').length,
      total: votes.length,
      weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade),
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    sessionWeight: sessionMult, candleQuality: candleQualityMult,
    method: 'WEIGHTED_MULTI_TF_v6.9.2_EMA5-13-55', generatedAt: now.toISOString(),
  };
}

export function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null; let bestScore = -1; let bestConf = -1;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (r.direction === finalDirection || finalDirection === 'NO_TRADE') {
      const score = r.direction === 'BUY' ? r.score.up : r.direction === 'SELL' ? r.score.down : 0;
      const ec    = r.confluence + (r.alignedWithHTF ? 1 : 0);
      if (ec > bestConf || (ec === bestConf && score > bestScore)) { bestTF = tf; bestScore = score; bestConf = ec; }
    }
  }
  if (!bestTF) {
    for (const [tf, r] of Object.entries(tfResults)) {
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) { bestTF = tf; bestScore = score; bestConf = r.confluence; }
    }
  }
  if (!bestTF) return { timeframe: 'N/A', reason: 'No analyzable timeframe' };
  const best = tfResults[bestTF];
  return {
    timeframe: bestTF, direction: best.direction, score: bestScore,
    confluence: best.confluence, alignedWithHTF: best.alignedWithHTF, expiry: best.expiry,
    reason: 'Strongest ' + best.direction + ' signal with ' + best.confluence + '/11 confluence',
  };
}

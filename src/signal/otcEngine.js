import {
  CONFIG, ASSET_TYPE, ASSET_TYPE_OTC, CANDLE_MINUTES,
  OTC_CATEGORY_WEIGHTS, OTC_SCORE_THRESHOLD, OTC_MIN_CONFLUENCE,
  OTC_CONFIDENCE_FLOOR, OTC_CONFIDENCE_CAP, OTC_EXOTIC_PENALTY,
} from '../config.js';
import { safeLastValue, r2, formatDuration, getCandleCountdown, getNextCandleClose } from '../utils/helpers.js';
import { calculateAllIndicators } from '../indicators/index.js';
import { calculateATR } from '../indicators/math.js';
import { analyzeTimeframe } from './timeframe.js';
import { findBestTimeframe, buildStructureVerdict } from './engine.js';
import { calculateOTCCandleDuration } from '../analysis/duration.js';
import { analyzeOTCPatterns } from '../analysis/otc.js';
import { generateEntryReason, recentCandleConsistency, getCandleQualityMultiplier } from '../analysis/filters.js';
import { getSignalGrade, resolveTieWithTolerance } from '../analysis/grade.js';
import { callCerebrasValidationOTC } from '../ai/cerebras.js';
import { buildIndicatorSnapshot } from '../ai/combine.js';

function analyzeTimeframeOTC(indicators, candles, timeframe) {
  const result = analyzeTimeframe(indicators, candles, timeframe, ASSET_TYPE.FOREX, null, 'RANGING');
  const rangingW = { trend:0.8, momentum:1.8, macd:0.8, stochastic:1.8, bands:1.4, adx:0.8, patterns:1.3, divergence:1.8, pivots:1.2, volume:0.5, sr:2.2, camarilla:0.84 };
  const otcW = OTC_CATEGORY_WEIGHTS;
  let newUp = 0; let newDown = 0;
  const cats = ['trend','momentum','macd','stochastic','bands','adx','patterns','divergence','pivots','volume','sr','camarilla'];

  for (const cat of cats) {
    const cd = result.categoryScores[cat];
    if (!cd) continue;
    const rW  = rangingW[cat] || 1.0;
    const otW = otcW[cat] !== undefined ? otcW[cat] : 0;
    if (rW > 0) {
      const rawUp   = (cd.up   || 0) / rW;
      const rawDown = (cd.down || 0) / rW;
      newUp   += rawUp   * otW;
      newDown += rawDown * otW;
      result.categoryScores[cat] = { ...cd, up: r2(rawUp * otW), down: r2(rawDown * otW), otcWeight: otW };
    }
  }

  const scoreDiff = Math.abs(newUp - newDown);
  let upCat = 0; let downCat = 0;
  for (const cat of cats) {
    const cd = result.categoryScores[cat];
    if (!cd) continue;
    if ((cd.up||0) > (cd.down||0) && Math.abs((cd.up||0)-(cd.down||0)) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
    else if ((cd.down||0) > (cd.up||0) && Math.abs((cd.down||0)-(cd.up||0)) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  }
  const confluence = Math.max(upCat, downCat);
  let direction;
  if (newUp >= OTC_SCORE_THRESHOLD && newUp > newDown && upCat >= OTC_MIN_CONFLUENCE) direction = 'BUY';
  else if (newDown >= OTC_SCORE_THRESHOLD && newDown > newUp && downCat >= OTC_MIN_CONFLUENCE) direction = 'SELL';
  else if (scoreDiff >= 3.0 && confluence >= 3) direction = newUp > newDown ? 'BUY' : 'SELL';
  else direction = 'NO_TRADE';

  result.direction = direction;
  result.score     = { up: r2(newUp), down: r2(newDown), diff: r2(scoreDiff) };
  result.confluence = confluence;
  result.confluenceDetail = { bullish: upCat, bearish: downCat, total: 11 };
  result.otcWeighted = true;
  return result;
}

export async function buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env) {
  const now = new Date(); const tfResults = {}; const votes = [];

  let htfContext = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfInd  = calculateAllIndicators(candleData['15min']);
    const htfEma5 = safeLastValue(htfInd.ema5); const htfEma55 = safeLastValue(htfInd.ema55);
    if (htfEma5 !== null && htfEma55 !== null) htfContext = htfEma5 > htfEma55 ? 'BUY_BIAS' : 'SELL_BIAS';
  }

  for (const tf of Object.keys(candleData)) {
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = calculateAllIndicators(candles);
    const analysis   = analyzeTimeframeOTC(indicators, candles, tf);
    const dur  = calculateOTCCandleDuration(indicators, analysis.direction, candles, tf);
    const cMin = CANDLE_MINUTES[tf] || 1;
    const dMin = dur * cMin;
    analysis.expiry = {
      candles: dur, candleSize: cMin + 'min', totalMinutes: dMin,
      expiryTime: new Date(now.getTime() + dMin * 60000).toISOString(),
      humanReadable: formatDuration(dMin),
      nextCandleClose: getNextCandleClose(now, cMin).toISOString(),
      countdown: getCandleCountdown(cMin),
    };
    const lc = candles[candles.length - 1];
    analysis.entry = { price: lc.close, candleTime: lc.datetime, candleDirection: lc.close >= lc.open ? 'BULLISH' : 'BEARISH' };
    analysis.higherTFTrend = htfContext; analysis.alignedWithHTF = true;
    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf, alignedWithHTF: true });
  }

  const primaryCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];
  const otcCandleQuality = getCandleQualityMultiplier(primaryCandles);

  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0;
  const activeDirs = [];
  for (const vote of votes) {
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * otcCandleQuality;
    if (vote.direction === 'BUY')       { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell     += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else                                { weightedNoTrade  += w; }
  }

  const allBuy = activeDirs.length > 0 && activeDirs.every(d => d === 'BUY');
  const allSell= activeDirs.length > 0 && activeDirs.every(d => d === 'SELL');
  let alignment = 'MIXED'; let alignmentBonus = 0;
  if (allBuy)       { alignment = 'ALL_BULLISH'; alignmentBonus = 4; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = 4; }
  else if (activeDirs.length >= 2) {
    const bc = activeDirs.filter(d => d === 'BUY').length;
    const sc = activeDirs.filter(d => d === 'SELL').length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = 2; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = 2; }
  }

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

  // B5: OTC anchor — value straight out of the weighted vote, before ANY
  // adjustment (MIXED zeroing, alignment bonus, pattern/time/consistency
  // penalties, exotic penalty, AI boost). Mirrors engine.js rawConfidence.
  const rawConfidence = confidence;

  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }
  confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus);

  const lastClose = primaryCandles.length > 0 ? primaryCandles[primaryCandles.length - 1].close : 0;
  const atrVal    = primaryCandles.length > 0 ? safeLastValue(calculateATR(primaryCandles, CONFIG.ATR_PERIOD)) : null;
  const otcPatterns = analyzeOTCPatterns(primaryCandles, atrVal, lastClose);

  if (finalDirection !== 'NO_TRADE') {
    const pb = finalDirection === 'BUY' ? otcPatterns.otcBonusUp - otcPatterns.otcBonusDown : otcPatterns.otcBonusDown - otcPatterns.otcBonusUp;
    if (pb > 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.round(pb * 3));
    else if (pb < 0) confidence = Math.max(0, confidence + Math.round(pb * 3));
    if (otcPatterns.confluenceBonus !== 0) {
      const bonusDir = otcPatterns.confluenceBonus > 0 ? 'BUY' : 'SELL';
      if (finalDirection === bonusDir) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(otcPatterns.confluenceBonus));
      else { confidence = Math.max(0, confidence - Math.abs(otcPatterns.confluenceBonus)); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
    }
  }

  if (finalDirection !== 'NO_TRADE' && otcPatterns.timeContext) {
    const tp = otcPatterns.timeContext.penaltyPct;
    if (tp > 0) { confidence = Math.max(0, confidence - tp); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
    else if (tp < 0) confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + Math.abs(tp));
  }

  let consistencyMult = 1.0;
  if (primaryCandles.length > 0 && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 3);
    if (consistencyMult < 1.0) confidence = Math.round(confidence * consistencyMult);
  }

  let entryCandlePenalty = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles.length >= 2) {
    const lC = primaryCandles[primaryCandles.length - 1]; const pC = primaryCandles[primaryCandles.length - 2];
    const lBody = Math.abs(lC.close - lC.open); const bRatio = lBody / ((lC.high - lC.low) || 0.00001);
    const lBull = lC.close > lC.open; const pBull = pC.close > pC.open;
    const bothAgainst = (finalDirection === 'BUY' && !lBull && !pBull) || (finalDirection === 'SELL' && lBull && pBull);
    if (bothAgainst && bRatio > 0.55) { entryCandlePenalty = true; confidence = Math.max(0, confidence - 10); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
  }

  if (exotic) confidence = Math.max(20, confidence - OTC_EXOTIC_PENALTY);

  if (finalDirection !== 'NO_TRADE' && otcCandleQuality < 0.8) {
    confidence = Math.max(0, confidence - 15);
    if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; }
  }

  let belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < OTC_CONFIDENCE_FLOOR) { belowFloor = true; finalDirection = 'NO_TRADE'; }

  const filtersApplied = [];
  if (belowFloor)              filtersApplied.push('OTC_BELOW_FLOOR (' + OTC_CONFIDENCE_FLOOR + '%)');
  if (alignment === 'MIXED')   filtersApplied.push('MIXED_ALIGNMENT');
  if (entryCandlePenalty)      filtersApplied.push('ENTRY_CANDLE_PENALTY (-10)');
  if (consistencyMult < 1)     filtersApplied.push('CANDLE_INCONSISTENCY (x' + consistencyMult + ')');
  if (exotic)                  filtersApplied.push('EXOTIC_OTC_PENALTY (-' + OTC_EXOTIC_PENALTY + ')');
  if (otcCandleQuality !== 1.0) filtersApplied.push('OTC_CANDLE_QUALITY (x' + otcCandleQuality.toFixed(2) + ')');
  if (otcPatterns.otcSignals.length > 0) filtersApplied.push('OTC_PATTERNS: ' + otcPatterns.otcSignals.join(', '));

  const best = findBestTimeframe(tfResults, finalDirection);
  const recommendations = {};
  for (const [rtf, rec] of Object.entries(tfResults)) {
    recommendations[rtf] = { direction: rec.direction, score: rec.score, confluence: rec.confluence + '/11', expiry: rec.expiry, entry: rec.entry, patterns: rec.categoryScores?.patterns?.detected || [] };
  }

  const avgConf = votes.reduce((s, v) => s + (v.confluence || 0), 0) / Math.max(votes.length, 1);
  const bestTFA = tfResults[best.timeframe] || null;
  let entryReason = generateEntryReason(finalDirection, bestTFA?.categoryScores || {}, bestTFA?.indicators || {}, alignment, null, 'RANGING');
  if (otcPatterns.otcSignals.length > 0) entryReason += ' · OTC: ' + otcPatterns.otcSignals.slice(0, 3).join(', ');

  let aiValidation = { status: 'SKIPPED' };
  if (finalDirection !== 'NO_TRADE') {
    const snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    const engSig   = { direction: finalDirection, confidence: confidence + '%', alignment, bestTF: best.timeframe };
    aiValidation = await callCerebrasValidationOTC(pair, engSig, snapshot, otcPatterns, env);
    if (aiValidation.status === 'OK') {
      const aiAgreed = aiValidation.signal === finalDirection;
      aiValidation.agrees = aiAgreed;
      if (aiAgreed) {
        if (!aiValidation.concerns) { confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + 8); filtersApplied.push('OTC_AI_BOOST: +8'); }
        else { confidence = Math.max(0, confidence - 5); filtersApplied.push('OTC_AI_AGREE_WITH_CONCERNS: ' + aiValidation.concerns); }
      } else if (aiValidation.signal !== 'NO_TRADE') {
        confidence = Math.max(0, confidence - 20);
        filtersApplied.push('OTC_AI_PENALTY: disagrees (AI=' + aiValidation.signal + ')');
        if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; filtersApplied.push('OTC_BELOW_FLOOR_AFTER_AI'); }
      } else { confidence = Math.max(0, confidence - 10); filtersApplied.push('OTC_AI_SOFT_PENALTY: uncertain'); }
    }
  }

  const finalGrade = getSignalGrade(confidence, avgConf, alignment);
  return {
    finalSignal: finalDirection, confidence: confidence + '%', grade: finalGrade,
    coreConfidence: rawConfidence,   // B5 — see anchor above
    assetType: ASSET_TYPE_OTC, isOTC: true,
    otcNote: 'Synthetic pair — mean reversion + price action. Olymp Trade.',
    marketRegime: 'OTC_SYNTHETIC',
    regimeAdvice: finalDirection === 'NO_TRADE' ? 'OTC — wait for clearer pattern' : 'OTC — short expiry (2-3 candles), price action based',
    marketCondition: ['OTC_SYNTHETIC'], alignment, higherTFTrend: htfContext || 'N/A',
    entryReason, filtersApplied, newsBlackout: null, aiValidation,
    session: { sessions: ['OTC_24/7'], quality: 'N/A' },
    otcPatterns: { consecutiveCandles: otcPatterns.consecutiveCandles, wickRejection: otcPatterns.wickRejection, roundNumber: otcPatterns.roundNumber, sizeAnomaly: otcPatterns.sizeAnomaly, timeContext: otcPatterns.timeContext, signals: otcPatterns.otcSignals, confluenceBonus: otcPatterns.confluenceBonus },
    recommendations, bestTimeframe: best,
    votes: { BUY: votes.filter(v => v.direction === 'BUY').length, SELL: votes.filter(v => v.direction === 'SELL').length, NO_TRADE: votes.filter(v => v.direction === 'NO_TRADE').length, total: votes.length, weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade) },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults, structureVerdict: buildStructureVerdict(tfResults, finalDirection), method: 'OTC_HYBRID_v6.9.1', generatedAt: now.toISOString(),
  };
}

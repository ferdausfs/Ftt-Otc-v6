// ============================================================
// OTC SIGNAL HANDLER (v6.7.0)
// Entry point for all -OTC pair requests
// ============================================================
import { OTC_CONFIDENCE_FLOOR, OTC_CONFIDENCE_CAP, OTC_EXOTIC_PENALTY, HISTORY_CONFIG } from '../config/trading.js';
import { analyzeTimeframeOTC } from './analyzer.js';
import { callCerebrasValidationOTC } from './cerebrasOTC.js';

async function buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env) {
  const now       = new Date();
  const tfResults = {};
  const votes     = [];

  let htfContext = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfInd  = calculateAllIndicators(candleData['15min']);
    const htfEma5 = safeLastValue(htfInd.ema5);
    const htfEma20= safeLastValue(htfInd.ema20);
    if (htfEma5 !== null && htfEma20 !== null) htfContext = htfEma5 > htfEma20 ? 'BUY_BIAS' : 'SELL_BIAS';
  }

  const tfKeys = Object.keys(candleData);
  for (let t = 0; t < tfKeys.length; t++) {
    const tf = tfKeys[t]; const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = calculateAllIndicators(candles);
    const analysis   = analyzeTimeframeOTC(indicators, candles, tf);
    const durCandles = calculateOTCCandleDuration(indicators, analysis.direction, candles, tf);
    const candleMin  = CANDLE_MINUTES[tf] || 1;
    const durMins    = durCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durMins * 60000);
    analysis.expiry  = { candles: durCandles, candleSize: candleMin + 'min', totalMinutes: durMins, expiryTime: expiryTime.toISOString(), humanReadable: formatDuration(durMins), nextCandleClose: getNextCandleClose(now, candleMin).toISOString(), countdown: getCandleCountdown(candleMin) };
    const lastCandle  = candles[candles.length - 1];
    analysis.entry    = { price: lastCandle.close, candleTime: lastCandle.datetime, candleDirection: lastCandle.close >= lastCandle.open ? 'BULLISH' : 'BEARISH' };
    analysis.higherTFTrend  = htfContext;
    analysis.alignedWithHTF = true;
    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf: tf, alignedWithHTF: true });
  }

  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0;
  const activeDirs = [];
  for (let v = 0; v < votes.length; v++) {
    const vote = votes[v];
    const w    = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * otcCandleQuality; // candle quality applied
    if (vote.direction === 'BUY')       { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell     += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else                                { weightedNoTrade  += w; }
  }

  const allBuy  = activeDirs.length > 0 && activeDirs.every(function(d){return d==='BUY';});
  const allSell = activeDirs.length > 0 && activeDirs.every(function(d){return d==='SELL';});
  let alignment = 'MIXED'; let alignmentBonus = 0;
  if (allBuy)  { alignment = 'ALL_BULLISH'; alignmentBonus = 8; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = 8; }
  else if (activeDirs.length >= 2) {
    const bc = activeDirs.filter(function(d){return d==='BUY';}).length;
    const sc = activeDirs.filter(function(d){return d==='SELL';}).length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = 4; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = 4; }
  }

  let finalDirection; let confidence;
  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    var bd = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = bd > 0 ? Math.round((weightedBuy / bd) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    var sd = weightedBuy + weightedSell + weightedNoTrade * 0.6;
    confidence = sd > 0 ? Math.round((weightedSell / sd) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction; confidence = tie.confidence;
  }

  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }
  confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus);

  // Primary candles for OTC pattern analysis — prefer 1min for freshness
  const primaryCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];
  const lastClose      = primaryCandles.length > 0 ? primaryCandles[primaryCandles.length - 1].close : 0;
  const atrVal         = primaryCandles.length > 0 ? safeLastValue(calculateATR(primaryCandles, CONFIG.ATR_PERIOD)) : null;
  const otcPatterns    = analyzeOTCPatterns(primaryCandles, atrVal, lastClose);

  // [v6.8.0] Candle quality also applied in OTC voting
  var otcCandleQuality = getCandleQualityMultiplier(primaryCandles);

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

  var consistencyMult = 1.0;
  if (primaryCandles.length > 0 && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 3);
    if (consistencyMult < 1.0) confidence = Math.round(confidence * consistencyMult);
  }

  var entryCandlePenalty = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles.length >= 2) {
    var lC = primaryCandles[primaryCandles.length - 1]; var pC = primaryCandles[primaryCandles.length - 2];
    var lBody = Math.abs(lC.close - lC.open); var lRange = (lC.high - lC.low) || 0.00001;
    var bRatio = lBody / lRange; var lBull = lC.close > lC.open; var pBull = pC.close > pC.open;
    var bothAgainst = (finalDirection === 'BUY' && !lBull && !pBull) || (finalDirection === 'SELL' && lBull && pBull);
    if (bothAgainst && bRatio > 0.55) { entryCandlePenalty = true; confidence = Math.max(0, confidence - 10); if (confidence < OTC_CONFIDENCE_FLOOR) { finalDirection = 'NO_TRADE'; confidence = 0; } }
  }

  if (exotic) confidence = Math.max(20, confidence - OTC_EXOTIC_PENALTY);

  var belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < OTC_CONFIDENCE_FLOOR) { belowFloor = true; finalDirection = 'NO_TRADE'; }

  var filtersApplied = [];
  if (belowFloor)              filtersApplied.push('OTC_BELOW_FLOOR (' + OTC_CONFIDENCE_FLOOR + '%)');
  if (alignment === 'MIXED')   filtersApplied.push('MIXED_ALIGNMENT');
  if (entryCandlePenalty)      filtersApplied.push('ENTRY_CANDLE_PENALTY (-10)');
  if (consistencyMult < 1)     filtersApplied.push('CANDLE_INCONSISTENCY (x' + consistencyMult + ')');
  if (exotic)                  filtersApplied.push('EXOTIC_OTC_PENALTY (-' + OTC_EXOTIC_PENALTY + ')');
  if (otcCandleQuality !== 1.0) filtersApplied.push('OTC_CANDLE_QUALITY (x' + otcCandleQuality.toFixed(2) + ')');
  if (otcPatterns.otcSignals.length > 0) filtersApplied.push('OTC_PATTERNS: ' + otcPatterns.otcSignals.join(', '));

  const best = findBestTimeframe(tfResults, finalDirection);
  const recommendations = {};
  const recKeys = Object.keys(tfResults);
  for (let r = 0; r < recKeys.length; r++) {
    const rtf = recKeys[r]; const rec = tfResults[rtf];
    recommendations[rtf] = { direction: rec.direction, score: rec.score, confluence: rec.confluence + '/11', expiry: rec.expiry, entry: rec.entry, patterns: (rec.categoryScores && rec.categoryScores.patterns && rec.categoryScores.patterns.detected) ? rec.categoryScores.patterns.detected : [] };
  }

  const avgConf  = votes.reduce(function(s,v){return s+(v.confluence||0);},0) / Math.max(votes.length,1);
  var bestTFAn   = tfResults[best.timeframe] || null;
  var entryReason = generateEntryReason(finalDirection, bestTFAn ? bestTFAn.categoryScores : {}, bestTFAn ? bestTFAn.indicators : {}, alignment, null, 'RANGING');
  if (otcPatterns.otcSignals.length > 0) entryReason += ' · OTC: ' + otcPatterns.otcSignals.slice(0, 3).join(', ');

  var aiValidation = { status: 'SKIPPED' };
  if (finalDirection !== 'NO_TRADE') {
    var snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    var engSig   = { direction: finalDirection, confidence: confidence + '%', alignment: alignment, bestTF: best.timeframe };
    aiValidation = await callCerebrasValidationOTC(pair, engSig, snapshot, otcPatterns, env);
    if (aiValidation.status === 'OK') {
      const aiAgreed = aiValidation.signal === finalDirection;
      aiValidation.agrees = aiAgreed;
      if (aiAgreed) {
        if (!aiValidation.concerns) { confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + 8); filtersApplied.push('OTC_AI_BOOST: agrees (' + aiValidation.signal + ' ' + aiValidation.confidence + '%)'); }
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
    assetType: ASSET_TYPE_OTC, isOTC: true,
    otcNote: 'Synthetic pair — mean reversion + price action. Olymp Trade.',
    marketRegime: 'OTC_SYNTHETIC',
    regimeAdvice: finalDirection === 'NO_TRADE' ? 'OTC — wait for clearer pattern' : 'OTC — short expiry (2-3 candles), price action based',
    marketCondition: ['OTC_SYNTHETIC'], alignment: alignment,
    higherTFTrend: htfContext || 'N/A (OTC — not used)',
    entryReason: entryReason, filtersApplied: filtersApplied, newsBlackout: null,
    aiValidation: aiValidation,
    session: { sessions: ['OTC_24/7'], quality: 'N/A' },
    otcPatterns: { consecutiveCandles: otcPatterns.consecutiveCandles, wickRejection: otcPatterns.wickRejection, roundNumber: otcPatterns.roundNumber, sizeAnomaly: otcPatterns.sizeAnomaly, timeContext: otcPatterns.timeContext, signals: otcPatterns.otcSignals, confluenceBonus: otcPatterns.confluenceBonus },
    recommendations: recommendations, bestTimeframe: best,
    votes: { BUY: votes.filter(function(v){return v.direction==='BUY';}).length, SELL: votes.filter(function(v){return v.direction==='SELL';}).length, NO_TRADE: votes.filter(function(v){return v.direction==='NO_TRADE';}).length, total: votes.length, weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade) },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults, method: 'OTC_HYBRID_v6.8.0', generatedAt: now.toISOString(),
  };
}

async function handleSignalRawOTC(pair, env, ctx) {
  const basePair = getOTCBasePair(pair);
  const exotic   = isExoticPair(basePair);
  const session  = detectTradingSession();
  const timeframes = ['1min', '5min', '15min'];
  const candleData = {}; const errors = {};
  let totalFailures = 0; let cacheHits = 0;

  const tfFetches = await Promise.all(timeframes.map(function(tf) {
    return fetchCandlesWithCache(basePair, tf, 100, env, ctx, ASSET_TYPE.FOREX);
  }));

  for (let i = 0; i < timeframes.length; i++) {
    const tf = timeframes[i]; const data = tfFetches[i];
    if (data.error) { errors[tf] = data.error; totalFailures++; }
    else { if (data._fromCache) cacheHits++; candleData[tf] = data.candles || data; }
  }

  if (totalFailures === timeframes.length) {
    return { pair: pair, assetType: ASSET_TYPE_OTC, isOTC: true, signal: generateDummySignal(pair), source: 'DUMMY_FALLBACK', errors: errors, timestamp: new Date().toISOString() };
  }

  const signal = await buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env);
  if (exotic) signal.exoticWarning = 'Exotic OTC pair. Very high spreads. Confidence heavily reduced.';

  const dataStatus = {};
  for (let j = 0; j < timeframes.length; j++) {
    const tfk = timeframes[j];
    dataStatus[tfk] = candleData[tfk] ? candleData[tfk].length + ' candles (from ' + basePair + ')' : 'FAILED: ' + (errors[tfk] || 'unknown');
  }

  const otcResult = {
    pair: pair, basePair: basePair, assetType: ASSET_TYPE_OTC, isOTC: true,
    otcBroker: 'Olymp Trade (synthetic price)',
    marketStatus: 'OPEN (OTC 24/7)',
    session: session, isExoticPair: exotic, signal: signal,
    source: totalFailures > 0 ? 'PARTIAL_DATA' : 'FULL_DATA',
    dataNote: 'Candle data from ' + basePair + ' (real market). OTC price may differ.',
    timestamp: new Date().toISOString(),
    nextRefresh: new Date(Date.now() + CONFIG.REFRESH_INTERVAL).toISOString(),
    cacheHits: cacheHits, dataStatus: dataStatus,
  };

  // [v6.9.0] Save OTC signal to history (manual result reporting via /api/report)
  if (signal.finalSignal !== 'NO_TRADE' && env.SIGNAL_CACHE && ctx) {
    ctx.waitUntil(saveSignalToHistory(otcResult, env));
  }

  return otcResult;
}

// ============================================================
// [v6.9.0] PHASE 2 — SIGNAL HISTORY & WIN/LOSS TRACKING

export { buildMultiTimeframeSignalOTC, handleSignalRawOTC };

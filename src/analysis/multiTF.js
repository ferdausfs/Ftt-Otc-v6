// ============================================================
// MULTI-TIMEFRAME SIGNAL BUILDER
// Combines 1min / 5min / 15min analysis into final signal
// Applies confidence scoring, AI validation, history adjustment
// ============================================================
import { CONFIG } from '../config/trading.js';
import { detectCorrelationConflicts, getCandleQualityMultiplier, getSessionWeightMultiplier } from './quality.js';
import { callCerebrasValidation } from '../ai/cerebras.js';
import { callGroqValidation, combineDualAIResults } from '../ai/groq.js';
import { buildIndicatorSnapshot } from './snapshot.js';
import { getDynamicConfidenceAdjustment } from '../history/stats.js';

function generateDummySignal(pair) {
  const seed = (new Date().getMinutes() + pair.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 0)) % 10;
  const dir = seed < 4 ? 'BUY' : seed < 8 ? 'SELL' : 'NO_TRADE';
  return {
    finalSignal: dir, confidence: '0%',
    grade: { grade: 'F', label: 'DUMMY', description: 'Fallback — no real data.' },
    marketCondition: ['UNKNOWN'], alignment: 'NONE', recommendations: {},
    bestTimeframe: { timeframe: 'N/A' },
    votes: { BUY: 0, SELL: 0, NO_TRADE: 0, total: 0 },
    timeframeAnalysis: {}, method: 'DUMMY_FALLBACK',
    warning: 'All API calls failed. Zero reliability.',
  };
}

// ============================================
// JSON RESPONSE
// ============================================

// ============================================
// [v6.2] CANDLE DURATION — volatility regime + momentum aware
// ============================================

function calculateCandleDuration(indicators, direction, candles, timeframe, assetType) {
  const durCfg = DURATION_CONFIG[assetType] || DURATION_CONFIG.FOREX;
  const cfg = durCfg[timeframe] || { base: 3, min: 1, max: 10 };
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  let dur = cfg.base;

  const rsi = safeLastValue(indicators.rsi);
  const stochK = safeLastValue(indicators.stochastic.k);
  const atr = safeLastValue(indicators.atr);
  const adxVal = safeLastValue(indicators.adx.adx);
  const bbBW = safeLastValue(indicators.bollinger.bandwidth);

  // RSI extremes → shorter hold (reversal risk)
  if (rsi !== null) {
    if (rsi > 82 || rsi < 18) dur -= 2;
    else if (rsi > 72 || rsi < 28) dur -= 1;
  }

  // Stochastic extremes → shorter hold
  if (stochK !== null) {
    if (stochK > 92 || stochK < 8) dur -= 1;
  }

  // ATR-based volatility regime
  if (atr !== null && candles.length > 0) {
    const lastClose = candles[candles.length - 1].close;
    if (lastClose > 0) {
      const atrPct = (atr / lastClose) * 100;
      if (atrPct > vt.atrVeryHigh) dur -= 2;      // Very volatile → exit fast
      else if (atrPct > vt.atrHigh) dur -= 1;
      else if (atrPct < vt.atrDead) dur += 2;     // Dead → needs more time
      else if (atrPct < vt.atrLow) dur += 1;
    }
  }

  // ADX trend strength → strong trend allows holding longer
  if (adxVal !== null) {
    if (adxVal >= 40) dur += 1;
    else if (adxVal < 15) dur -= 1;
  }

  // [v6.2] Squeeze → candle about to expand, hold slightly longer
  if (bbBW !== null && bbBW < vt.bbSqueeze) dur += 1;

  // [v6.2] Strong pattern → 1 extra candle buffer
  if (indicators.patterns) {
    const strongNames = ['MORNING_STAR', 'EVENING_STAR', 'THREE_WHITE_SOLDIERS',
      'THREE_BLACK_CROWS', 'BULLISH_ENGULFING', 'BEARISH_ENGULFING'];
    const hasStrong = indicators.patterns.some(function (p) { return strongNames.indexOf(p.name) !== -1; });
    if (hasStrong) dur += 1;
  }

  // [v6.2] Momentum alignment: MACD + RSI both strongly aligned → hold 1 more
  if (rsi !== null && direction === 'BUY' && rsi >= 55 && rsi <= 68) dur += 1;
  if (rsi !== null && direction === 'SELL' && rsi <= 45 && rsi >= 32) dur += 1;

  // TF-specific caps
  if (timeframe === '15min' && adxVal !== null && adxVal < 20) dur -= 1;
  if (timeframe === '1min' && adxVal !== null && adxVal >= 30) dur += 1;

  return Math.max(cfg.min, Math.min(cfg.max, Math.round(dur)));
}

// ============================================

// ============================================
// SIGNAL GRADE
// ============================================

function getSignalGrade(confidence, avgConf, alignment) {
  let sc = 0;
  sc += Math.min(40, confidence * 0.4);
  sc += Math.min(35, avgConf * 5);
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') sc += 25;
  else if (alignment.indexOf('MOSTLY') === 0) sc += 12;

  if (sc >= 85) return { grade: 'A+', label: 'EXCELLENT', description: 'Very high probability setup.' };
  if (sc >= 75) return { grade: 'A',  label: 'STRONG',    description: 'High probability with multiple confirmations.' };
  if (sc >= 60) return { grade: 'B',  label: 'GOOD',      description: 'Solid setup. Suitable for trading.' };
  if (sc >= 45) return { grade: 'C',  label: 'MODERATE',  description: 'Some conflicts. Trade with caution.' };
  if (sc >= 30) return { grade: 'D',  label: 'WEAK',      description: 'Low confidence. Consider skipping.' };
  return { grade: 'F', label: 'AVOID', description: 'Very weak. Do NOT trade.' };
}

// ============================================
// TIE RESOLUTION
// ============================================

function resolveTieWithTolerance(details) {
  let tU = 0; let tD = 0; let cU = 0; let cD = 0;
  const tfKeys = Object.keys(details);
  for (let i = 0; i < tfKeys.length; i++) {
    const tf = tfKeys[i]; const s = details[tf]; const w = CONFIG.TF_WEIGHTS[tf] || 1.0;
    tU += s.score.up * w;  tD += s.score.down * w;
    cU += ((s.confluenceDetail && s.confluenceDetail.bullish) || 0) * w;
    cD += ((s.confluenceDetail && s.confluenceDetail.bearish) || 0) * w;
  }
  const total = tU + tD;
  if (tU > tD && cU >= cD) return { direction: 'BUY',  confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU && cD >= cU) return { direction: 'SELL', confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  if (tU > tD) return { direction: 'BUY',  confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU) return { direction: 'SELL', confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  return { direction: 'NO_TRADE', confidence: 50 };
}

// ============================================
// DUMMY FALLBACK
// ============================================

function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null; let bestScore = -1; let bestConf = -1;
  const keys = Object.keys(tfResults);

  for (let i = 0; i < keys.length; i++) {
    const tf = keys[i]; const r = tfResults[tf];
    if (r.direction === finalDirection || finalDirection === 'NO_TRADE') {
      const score = r.direction === 'BUY' ? r.score.up : r.direction === 'SELL' ? r.score.down : 0;
      const effectiveConf = r.confluence + (r.alignedWithHTF ? 1 : 0);
      if (effectiveConf > bestConf || (effectiveConf === bestConf && score > bestScore)) {
        bestTF = tf; bestScore = score; bestConf = effectiveConf;
      }
    }
  }

  if (!bestTF) {
    for (let i = 0; i < keys.length; i++) {
      const tf = keys[i]; const r = tfResults[tf];
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) { bestTF = tf; bestScore = score; bestConf = r.confluence; }
    }
  }

  if (!bestTF) return { timeframe: 'N/A', reason: 'No analyzable timeframe' };

  const best = tfResults[bestTF];
  return {
    timeframe: bestTF,
    direction: best.direction,
    score: bestScore,
    confluence: best.confluence,
    alignedWithHTF: best.alignedWithHTF,
    expiry: best.expiry,
    reason: 'Strongest ' + best.direction + ' signal with ' + best.confluence + '/11 confluence' +
      (best.alignedWithHTF ? ' (aligned with higher TF)' : ''),
  };
}

// ============================================
// TIMEFRAME ANALYSIS v6.2
// ============================================


async function buildMultiTimeframeSignal(candleData, pair, assetType, session, exotic, newsBlock, env) {
  const now = new Date();
  const tfResults = {};
  const votes = [];

  // Step 0: Higher-TF Trend from 15min
  let higherTFTrend = null;
  if (candleData['15min'] && candleData['15min'].length > 0) {
    const htfIndicators = calculateAllIndicators(candleData['15min']);
    const htfEma5   = safeLastValue(htfIndicators.ema5);
    const htfEma20  = safeLastValue(htfIndicators.ema20);
    const htfAdx    = htfIndicators.adx ? safeLastValue(htfIndicators.adx.adx)     : null;
    const htfPlusDI = htfIndicators.adx ? safeLastValue(htfIndicators.adx.plusDI)  : null;
    const htfMinusDI= htfIndicators.adx ? safeLastValue(htfIndicators.adx.minusDI) : null;

    if (htfEma5 !== null && htfEma20 !== null && htfAdx !== null && htfAdx >= 20) {
      if (htfEma5 > htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfPlusDI > htfMinusDI)
        higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma20 && htfPlusDI !== null && htfMinusDI !== null && htfMinusDI > htfPlusDI)
        higherTFTrend = 'SELL';
    }
  }

  // [v6.6.0] Step 0b: Detect Market Regime from 15min candles
  // Regime determines dynamic weights for all TF analyses
  var marketRegime = 'RANGING'; // default
  if (candleData['15min'] && candleData['15min'].length >= 3) {
    var regimeCandles = candleData['15min'];
    var rInd = calculateAllIndicators(regimeCandles);
    var rAdx = safeLastValue(rInd.adx.adx);
    var rBbBW = safeLastValue(rInd.bollinger.bandwidth);
    var rBbBWPrev = null;
    var rBbBWArr = rInd.bollinger.bandwidth;
    // Get second-to-last valid bandwidth for breakout detection
    if (rBbBWArr) {
      var bwVals = [];
      for (var bi = rBbBWArr.length - 1; bi >= 0 && bwVals.length < 2; bi--) {
        if (rBbBWArr[bi] !== null && !isNaN(rBbBWArr[bi])) bwVals.push(rBbBWArr[bi]);
      }
      if (bwVals.length >= 2) rBbBWPrev = bwVals[1];
    }
    var rAtr = safeLastValue(rInd.atr);
    var rLastClose = regimeCandles[regimeCandles.length - 1].close;
    marketRegime = detectMarketRegime(rAdx, rBbBW, rAtr, rLastClose, assetType, rBbBWPrev);
  }

  // Step 1: Analyze each timeframe
  const tfKeys = Object.keys(candleData);
  for (let t = 0; t < tfKeys.length; t++) {
    const tf = tfKeys[t];
    const candles = candleData[tf];
    if (!candles || candles.length === 0) continue;

    const indicators = calculateAllIndicators(candles);
    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend, marketRegime);

    const durationCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType);
    const candleMin = CANDLE_MINUTES[tf] || 1;
    const durationMinutes = durationCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durationMinutes * 60000);
    const nextCandleClose = getNextCandleClose(now, candleMin);

    // [v6.2] Candle countdown
    const countdown = getCandleCountdown(candleMin);

    analysis.expiry = {
      candles: durationCandles,
      candleSize: candleMin + 'min',
      totalMinutes: durationMinutes,
      expiryTime: expiryTime.toISOString(),
      humanReadable: formatDuration(durationMinutes),
      nextCandleClose: nextCandleClose.toISOString(),
      countdown: countdown,
    };

    const lastCandle = candles[candles.length - 1];
    analysis.entry = {
      price: lastCandle.close,
      candleTime: lastCandle.datetime,
      candleDirection: lastCandle.close >= lastCandle.open ? 'BULLISH' : 'BEARISH',
    };

    analysis.higherTFTrend = higherTFTrend;
    analysis.alignedWithHTF = (higherTFTrend === null || analysis.direction === 'NO_TRADE' || analysis.direction === higherTFTrend);

    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf: tf, alignedWithHTF: analysis.alignedWithHTF });
  }

  // [v6.8.0] P1+P2: Candle Quality + Session Weight multipliers
  var sessionMult = getSessionWeightMultiplier(pair, session);

  // P1: Skip dead market TFs for candle quality check — dead candles are misleadingly Doji-like
  var qualityCandles = [];
  if (candleData['1min']  && tfResults['1min']  && !tfResults['1min'].deadMarket)  qualityCandles = candleData['1min'];
  else if (candleData['5min']  && tfResults['5min']  && !tfResults['5min'].deadMarket)  qualityCandles = candleData['5min'];
  else if (candleData['15min'] && tfResults['15min'] && !tfResults['15min'].deadMarket) qualityCandles = candleData['15min'];
  else qualityCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];

  var candleQualityMult = getCandleQualityMultiplier(qualityCandles);

  // Step 2: Weighted Multi-TF Voting
  let weightedBuy = 0; let weightedSell = 0; let weightedNoTrade = 0; let totalWeight = 0;
  const activeDirs = [];

  for (let v = 0; v < votes.length; v++) {
    const vote = votes[v];
    // [v6.8.0] Apply session + candle quality multipliers to TF weight
    const w = (CONFIG.TF_WEIGHTS[vote.tf] || 1.0) * sessionMult * candleQualityMult;
    totalWeight += w;
    if (vote.direction === 'BUY')  { weightedBuy      += w * (vote.score.up   || 1); activeDirs.push('BUY');  }
    else if (vote.direction === 'SELL') { weightedSell += w * (vote.score.down || 1); activeDirs.push('SELL'); }
    else { weightedNoTrade += w; }
  }

  // Alignment — [v6.6.0] bonus reduced for RANGING/VOLATILE (misleading in those regimes)
  const allBuy  = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'BUY'; });
  const allSell = activeDirs.length > 0 && activeDirs.every(function (d) { return d === 'SELL'; });
  let alignment = 'MIXED'; let alignmentBonus = 0;

  // Base bonus by alignment type
  var fullBonus    = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 15 : 5;
  var partialBonus = (marketRegime === 'TRENDING' || marketRegime === 'BREAKOUT') ? 7  : 3;

  if (allBuy)  { alignment = 'ALL_BULLISH'; alignmentBonus = fullBonus; }
  else if (allSell) { alignment = 'ALL_BEARISH'; alignmentBonus = fullBonus; }
  else if (!allBuy && !allSell && activeDirs.length >= 2) {
    const bc = activeDirs.filter(function (d) { return d === 'BUY'; }).length;
    const sc = activeDirs.filter(function (d) { return d === 'SELL'; }).length;
    if (bc > sc) { alignment = 'MOSTLY_BULLISH'; alignmentBonus = partialBonus; }
    if (sc > bc) { alignment = 'MOSTLY_BEARISH'; alignmentBonus = partialBonus; }
  }

  // Step 3: Decision
  let finalDirection;
  let confidence;
  const totalWeightedScore = weightedBuy + weightedSell;

  if (weightedBuy > weightedSell && weightedBuy > 0) {
    finalDirection = 'BUY';
    // [v6.4] NO_TRADE weight counts as partial resistance in denominator
    // Prevents 1-TF BUY + 2-TF NO_TRADE giving 100% confidence
    var buyDenom = weightedBuy + weightedSell + (weightedNoTrade * 0.6);
    confidence = buyDenom > 0 ? Math.round((weightedBuy / buyDenom) * 100) : 50;
  } else if (weightedSell > weightedBuy && weightedSell > 0) {
    finalDirection = 'SELL';
    var sellDenom = weightedBuy + weightedSell + (weightedNoTrade * 0.6);
    confidence = sellDenom > 0 ? Math.round((weightedSell / sellDenom) * 100) : 50;
  } else {
    const tie = resolveTieWithTolerance(tfResults);
    finalDirection = tie.direction; confidence = tie.confidence;
  }

  // [v6.4] HTF conflict — hard block ONLY if 15min trend is strong (ADX>=25)
  // Weak HTF trend = apply confidence penalty only, not full NO_TRADE
  if (higherTFTrend !== null && finalDirection !== 'NO_TRADE' && finalDirection !== higherTFTrend) {
    var htfResult15 = tfResults['15min'];
    var htfADXVal = htfResult15 && htfResult15.indicators ? parseFloat(htfResult15.indicators.adx) : null;
    if (htfADXVal !== null && !isNaN(htfADXVal) && htfADXVal >= 25) {
      // Strong HTF trend — hard block counter-signals
      finalDirection = 'NO_TRADE'; confidence = 0;
    } else {
      // Weak/uncertain HTF trend — just penalize confidence
      confidence = Math.max(0, confidence - 18);
    }
  } else if (higherTFTrend !== null && finalDirection === higherTFTrend) {
    confidence = Math.min(92, confidence + 5);
  }

  confidence = Math.min(92, confidence + alignmentBonus); // [v6.6.0] hard cap 92%

  // [v6.1] MIXED → NO_TRADE
  if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }

  // Session quality
  if (assetType === ASSET_TYPE.FOREX) {
    if (session.quality === 'LOW') confidence = Math.max(25, confidence - 8);
    else if (session.quality === 'HIGHEST') confidence = Math.min(92, confidence + 3);
  }

  // Exotic penalty
  if (exotic) confidence = Math.max(20, confidence - CONFIG.EXOTIC_CONFIDENCE_PENALTY);

  // [v6.2] Candle consistency check
  const primaryCandles = candleData['5min'] || candleData['1min'] || candleData['15min'];
  var consistencyMult = 1.0;
  if (primaryCandles && finalDirection !== 'NO_TRADE') {
    consistencyMult = recentCandleConsistency(primaryCandles, finalDirection, 4);
    if (consistencyMult < 1.0) {
      confidence = Math.round(confidence * consistencyMult);
    }
  }

  // [v6.2] Volume spike anomaly filter
  var volumeSpikeBlocked = false;
  if (finalDirection !== 'NO_TRADE' && primaryCandles) {
    volumeSpikeBlocked = isVolumeSpikeAnomaly(primaryCandles, assetType);
    if (volumeSpikeBlocked) {
      finalDirection = 'NO_TRADE';
      confidence = 0;
    }
  }

  // [v6.5.2] FVG penalty — find first TF that actually has fvg data (skip dead market TFs)
  // Bug fix: dead market 1min has categoryScores:{} — was truthy so 5min/15min fvg never checked
  var fvgBlocked = false;
  var fvgBlockDetail = '';
  var fvgCheckTF = null;
  var fvgTFOrder = ['1min', '5min', '15min'];
  for (var fi = 0; fi < fvgTFOrder.length; fi++) {
    var candidate = tfResults[fvgTFOrder[fi]];
    if (candidate && candidate.categoryScores && candidate.categoryScores.fvg) {
      fvgCheckTF = candidate;
      break;
    }
  }
  if (finalDirection !== 'NO_TRADE' && fvgCheckTF && fvgCheckTF.categoryScores && fvgCheckTF.categoryScores.fvg) {
    var activeFVGType = fvgCheckTF.categoryScores.fvg.active; // 'BULLISH' | 'BEARISH' | 'NONE'
    if (activeFVGType && activeFVGType !== 'NONE') {
      if (finalDirection === 'BUY' && activeFVGType === 'BEARISH') {
        fvgBlocked = true;
        fvgBlockDetail = 'BUY confidence reduced: inside bearish FVG (supply imbalance) on ' + fvgCheckTF.timeframe;
        confidence = Math.max(0, confidence - 20); // penalty, not hard block
      }
      if (finalDirection === 'SELL' && activeFVGType === 'BULLISH') {
        fvgBlocked = true;
        fvgBlockDetail = 'SELL confidence reduced: inside bullish FVG (demand imbalance) on ' + fvgCheckTF.timeframe;
        confidence = Math.max(0, confidence - 20);
      }
      // After penalty: if confidence falls below floor, then block
      if (fvgBlocked && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
        finalDirection = 'NO_TRADE';
        confidence = 0;
      }
    }
  }

  // [v6.2] News blackout → force NO_TRADE for FOREX
  var newsBlocked = false;
  if (newsBlock && newsBlock.blocked && finalDirection !== 'NO_TRADE') {
    newsBlocked = true;
    finalDirection = 'NO_TRADE';
    confidence = 0;
  }

  // [v6.4] Entry candle confirmation — if last 1min candle strongly opposes signal, penalize
  // A strong body candle against the signal direction is a warning sign
  var entryCandlePenalty = false;
  if (finalDirection !== 'NO_TRADE') {
    var entryCheckCandles = candleData['1min'] || candleData['5min'] || candleData['15min'];
    if (entryCheckCandles && entryCheckCandles.length >= 2) {
      var lastC    = entryCheckCandles[entryCheckCandles.length - 1];
      var prevC    = entryCheckCandles[entryCheckCandles.length - 2];
      var lastBody = Math.abs(lastC.close - lastC.open);
      var lastRange = (lastC.high - lastC.low) || 0.00001;
      var bodyRatio = lastBody / lastRange;
      var lastBullish = lastC.close > lastC.open;
      // Only penalize if strong body (bodyRatio > 0.55) AND prev candle also against signal
      var prevBullish = prevC.close > prevC.open;
      var bothAgainst = (finalDirection === 'BUY'  && !lastBullish && !prevBullish) ||
                        (finalDirection === 'SELL' &&  lastBullish &&  prevBullish);
      if (bothAgainst && bodyRatio > 0.55) {
        entryCandlePenalty = true;
        confidence = Math.max(0, confidence - 10);
        // Re-check floor after penalty
        if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
          finalDirection = 'NO_TRADE';
          confidence = 0;
        }
      }
    }
  }

  // Grade
  const avgConf = votes.reduce(function (s, v) { return s + (v.confluence || 0); }, 0) / Math.max(votes.length, 1);
  const grade = getSignalGrade(confidence, avgConf, alignment);

  // Market condition — reuse from tfResults (no redundant calculateAllIndicators call)
  const htfTFResult = tfResults['15min'] || tfResults['5min'] || tfResults['1min'];
  let marketCondition = ['UNKNOWN'];
  let marketContext = 'UNKNOWN';
  if (htfTFResult) {
    const htfCandles = candleData['15min'] || candleData['5min'] || candleData['1min'];
    const adxHtf = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.adx) : null;
    const bbBWHtf = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.bbBandwidth) : null;
    const atrHtf  = htfTFResult.indicators ? parseFloat(htfTFResult.indicators.atr) : null;
    const lastCloseHtf = htfCandles ? htfCandles[htfCandles.length - 1].close : null;
    if (lastCloseHtf !== null) {
      marketCondition = detectMarketCondition(
        isNaN(adxHtf) ? null : adxHtf,
        isNaN(bbBWHtf) ? null : bbBWHtf,
        isNaN(atrHtf) ? null : atrHtf,
        lastCloseHtf, assetType
      );
    }
    marketContext = (!isNaN(adxHtf) && adxHtf !== null) ? (adxHtf >= 25 ? 'TRENDING' : 'RANGING') : 'UNKNOWN';
  }

  // Dead market filter — runs before confidence floor so ordering is clean
  if (finalDirection !== 'NO_TRADE' && marketCondition.indexOf('DEAD_MARKET') !== -1 && confidence < 75) {
    finalDirection = 'NO_TRADE';
    confidence = Math.min(confidence, 30);
  }

  // [v6.2] Minimum confidence floor
  var belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    belowFloor = true;
    finalDirection = 'NO_TRADE';
    // Keep confidence value visible so user sees why it was blocked
  }

  // [v6.9.0] H3 — Dynamic confidence adjustment from historical win rate
  if (finalDirection !== 'NO_TRADE' && env && env.SIGNAL_CACHE) {
    var dynAdj = await getDynamicConfidenceAdjustment(pair, env);
    if (dynAdj !== 0) {
      confidence = Math.max(0, Math.min(92, confidence + dynAdj));
      filtersApplied.push('DYNAMIC_CONF_ADJ: ' + (dynAdj > 0 ? '+' : '') + dynAdj + ' (historical win rate)');
      // Re-check floor after dynamic adjustment
      if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR && finalDirection !== 'NO_TRADE') {
        finalDirection = 'NO_TRADE';
        confidence     = 0;
        filtersApplied.push('BELOW_FLOOR_AFTER_DYN_ADJ');
      }
    }
  }

  // Best timeframe
  const best = findBestTimeframe(tfResults, finalDirection);

  // Per-TF recommendations
  const recommendations = {};
  const recKeys = Object.keys(tfResults);
  for (let r = 0; r < recKeys.length; r++) {
    const rtf = recKeys[r];
    const rec = tfResults[rtf];
    recommendations[rtf] = {
      direction:      rec.direction,
      score:          rec.score,
      confluence:     rec.confluence + '/11 categories',
      alignedWithHTF: rec.alignedWithHTF,
      expiry:         rec.expiry,
      entry:          rec.entry,
      patterns: (rec.categoryScores && rec.categoryScores.patterns && rec.categoryScores.patterns.detected)
        ? rec.categoryScores.patterns.detected : [],
      divergence: {
        rsi:  (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.rsi)  ? rec.categoryScores.divergence.rsi  : 'NONE',
        macd: (rec.categoryScores && rec.categoryScores.divergence && rec.categoryScores.divergence.macd) ? rec.categoryScores.divergence.macd : 'NONE',
      },
      diCrossover: (rec.categoryScores && rec.categoryScores.adx && rec.categoryScores.adx.diCross)
        ? rec.categoryScores.adx.diCross : 'NONE',
    };
  }

  // [v6.2] Entry reason — build from best available TF analysis
  var bestTFAnalysis = tfResults[best.timeframe] || null;
  var entryReason = generateEntryReason(
    finalDirection,
    bestTFAnalysis ? bestTFAnalysis.categoryScores : {},
    bestTFAnalysis ? bestTFAnalysis.indicators : {},
    alignment,
    higherTFTrend,
    marketContext
  );

  // [v6.2] Build filter audit trail
  var filtersApplied = [];
  if (newsBlocked)         filtersApplied.push('NEWS_BLACKOUT: ' + (newsBlock ? newsBlock.label : ''));
  if (volumeSpikeBlocked)  filtersApplied.push('VOLUME_SPIKE_ANOMALY');
  if (fvgBlocked)          filtersApplied.push('FVG_PENALTY: ' + fvgBlockDetail);
  if (belowFloor)          filtersApplied.push('CONFIDENCE_BELOW_FLOOR (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
  if (consistencyMult < 1.0) filtersApplied.push('CANDLE_INCONSISTENCY (mult=' + consistencyMult + ')');
  if (alignment === 'MIXED') filtersApplied.push('MIXED_ALIGNMENT');
  if (entryCandlePenalty)  filtersApplied.push('ENTRY_CANDLE_PENALTY (-10 confidence)');
  if (sessionMult !== 1.0) filtersApplied.push('SESSION_WEIGHT (x' + sessionMult.toFixed(2) + ' — ' + (session.overlap !== 'NONE' ? session.overlap : session.sessions[0]) + ')');
  if (candleQualityMult !== 1.0) filtersApplied.push('CANDLE_QUALITY (x' + candleQualityMult.toFixed(2) + ')');

  // [v6.8.0] P4 — DUAL AI VALIDATION (Cerebras + Groq in parallel)
  var aiValidation = { status: 'SKIPPED' };
  var aiAgreed = null;

  if (finalDirection !== 'NO_TRADE') {
    var snapshot = buildIndicatorSnapshot(tfResults, candleData, finalDirection, best.timeframe);
    var engineSignalSummary = {
      direction:       finalDirection,
      confidence:      confidence + '%',
      alignment:       alignment,
      higherTFTrend:   higherTFTrend || 'NEUTRAL',
      marketCondition: marketCondition,
      bestTF:          best.timeframe,
    };

    // Run both AIs in parallel — whichever finishes first used, no serial wait
    var aiResults = await Promise.all([
      callCerebrasValidation(pair, assetType, engineSignalSummary, snapshot, env),
      callGroqValidation(pair, assetType, engineSignalSummary, snapshot, env),
    ]);

    var cerebrasResult = aiResults[0];
    var groqResult     = aiResults[1];
    var dualResult     = combineDualAIResults(cerebrasResult, groqResult, finalDirection);

    aiValidation = dualResult; // full dual result in response

    var combinedAI = dualResult.combined;
    if (combinedAI && combinedAI.status === 'OK') {
      aiAgreed = dualResult.combinedAgreed;

      if (aiAgreed) {
        if (!combinedAI.concerns) {
          // Both agree, no concerns — stronger boost if both agreed
          var boost = (combinedAI.agreement === 'BOTH_AGREE') ? 8 : 5;
          confidence = Math.min(92, confidence + boost);
          filtersApplied.push('DUAL_AI_BOOST: ' + combinedAI.agreement + ' → +' + boost + ' (' + combinedAI.signal + ' ' + combinedAI.confidence + '%)');
        } else {
          confidence = Math.max(0, confidence - 5);
          filtersApplied.push('DUAL_AI_AGREE_WITH_CONCERNS: ' + combinedAI.concerns);
        }
      } else if (combinedAI.signal !== 'NO_TRADE') {
        confidence = Math.max(0, confidence - 15);
        filtersApplied.push('DUAL_AI_PENALTY: disagrees (AI=' + combinedAI.signal + ' ' + combinedAI.confidence + '%)');
        if (confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
          finalDirection = 'NO_TRADE';
          confidence = 0;
          filtersApplied.push('BELOW_FLOOR_AFTER_DUAL_AI (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
        }
      } else {
        // AIs disagree or NO_TRADE
        confidence = Math.max(0, confidence - 10);
        filtersApplied.push('DUAL_AI_SOFT_PENALTY: AIs uncertain/conflicting');
      }
      if (aiValidation.combinedAgreed !== undefined) aiValidation.agrees = aiValidation.combinedAgreed;
    }
  }

  // Re-run grade after AI adjustments (confidence may have changed)
  const finalGrade = getSignalGrade(confidence, avgConf, alignment);

  return {
    finalSignal:    finalDirection,
    confidence:     confidence + '%',
    grade:          finalGrade,
    assetType:      assetType,
    marketRegime:   marketRegime,                              // [v6.6.0]
    regimeAdvice:   getRegimeAdvice(marketRegime, finalDirection), // [v6.6.0]
    marketCondition: marketCondition,
    alignment:      alignment,
    higherTFTrend:  higherTFTrend || 'NEUTRAL',
    entryReason:    entryReason,
    filtersApplied: filtersApplied,
    newsBlackout:   newsBlock || null,
    aiValidation:   aiValidation,          // [v6.5.0]
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ['24/7'], quality: 'N/A' },
    recommendations: recommendations,
    bestTimeframe: best,
    votes: {
      BUY:      votes.filter(function (v) { return v.direction === 'BUY'; }).length,
      SELL:     votes.filter(function (v) { return v.direction === 'SELL'; }).length,
      NO_TRADE: votes.filter(function (v) { return v.direction === 'NO_TRADE'; }).length,
      total:    votes.length,
      weightedBuy:      r2(weightedBuy),
      weightedSell:     r2(weightedSell),
      weightedNoTrade:  r2(weightedNoTrade),
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    sessionWeight:    sessionMult,
    candleQuality:    candleQualityMult,
    method:      'WEIGHTED_MULTI_TF_v6.9.0',
    generatedAt: now.toISOString(),
  };
}

// ============================================
// FIND BEST TIMEFRAME
// ============================================

export { buildMultiTimeframeSignal, findBestTimeframe };

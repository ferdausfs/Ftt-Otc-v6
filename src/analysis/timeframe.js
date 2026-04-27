// ============================================================
// PER-TIMEFRAME ANALYSIS ENGINE
// Scores each category (trend/momentum/macd/sr/etc.)
// Applies regime weights, candle quality multiplier
// ============================================================
import { CONFIG } from '../config/trading.js';
import { calculateCamarillaPivots, scoreCamarillaLevels } from './camarilla.js';

function analyzeTimeframe(indicators, candles, timeframe, assetType, higherTFTrend, marketRegime) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const minScoreThreshold = SCORE_THRESHOLDS[assetType] || 3.0;
  // [v6.6.0] Use regime-specific weights instead of static CONFIG weights
  const weights = getRegimeWeights(marketRegime || 'RANGING');

  const ema5   = safeLastValue(indicators.ema5);
  const ema10  = safeLastValue(indicators.ema10);
  const ema20  = safeLastValue(indicators.ema20);
  const sma50  = safeLastValue(indicators.sma50);
  const rsi    = safeLastValue(indicators.rsi);
  const macdHistData   = safeLastTwo(indicators.macd.histogram);
  const macdHist       = macdHistData.last;
  const prevMacdHist   = macdHistData.prev;
  const macdLineData   = safeLastTwo(indicators.macd.macdLine);
  const macdLine       = macdLineData.last;
  const macdSignalData = safeLastTwo(indicators.macd.signalLine);
  const macdSignal     = macdSignalData.last;
  const atr            = safeLastValue(indicators.atr);
  const bbUpper        = safeLastValue(indicators.bollinger.upper);
  const bbLower        = safeLastValue(indicators.bollinger.lower);
  const bbMiddle       = safeLastValue(indicators.bollinger.middle);
  const bbBandwidth    = safeLastValue(indicators.bollinger.bandwidth);
  const bbPercentB     = safeLastValue(indicators.bollinger.percentB);
  const stochK         = safeLastValue(indicators.stochastic.k);
  const stochD         = safeLastValue(indicators.stochastic.d);
  const prevStochKData = safeLastTwo(indicators.stochastic.k);
  const prevStochK     = prevStochKData.prev;
  const adxVal         = safeLastValue(indicators.adx.adx);
  const plusDI         = safeLastValue(indicators.adx.plusDI);
  const minusDI        = safeLastValue(indicators.adx.minusDI);
  const williamsR      = safeLastValue(indicators.williamsR);
  const cci            = safeLastValue(indicators.cci);
  const mfi            = safeLastValue(indicators.mfi);
  const pivots         = indicators.pivots;
  const patterns       = indicators.patterns;
  const sr             = indicators.sr   || { supports: [], resistances: [] }; // [v6.3]
  const fvg            = indicators.fvg  || { active: null };                  // [v6.3]

  if (ema5 === null || ema20 === null) {
    return {
      direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
      confluence: 0, reason: 'Insufficient data', timeframe: timeframe, assetType: assetType,
      categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 11 }, volatilityMultiplier: 0,
    };
  }

  const lastCandle = candles[candles.length - 1];
  const lastClose  = lastCandle.close;
  const trending   = isTrendingMarket(adxVal);

  let upScore = 0; let downScore = 0; let upCat = 0; let downCat = 0;
  const catScores = {};

  // Dead market check
  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct < vt.minTradableATR) {
      return {
        direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
        confluence: 0, reason: 'Dead market — ATR too low',
        timeframe: timeframe, assetType: assetType, deadMarket: true,
        categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 11 }, volatilityMultiplier: 0,
      };
    }
  }

  // === CAT 1: TREND ===
  var tU = 0; var tD = 0;
  if (ema5 > ema20) tU += 1; else if (ema5 < ema20) tD += 1;
  if (ema10 !== null) { if (ema10 > ema20) tU += 0.5; else if (ema10 < ema20) tD += 0.5; }
  if (sma50 !== null) { if (lastClose > sma50) tU += 0.75; else if (lastClose < sma50) tD += 0.75; }
  if (ema10 !== null) {
    if (ema5 > ema10 && ema10 > ema20) tU += 0.75;
    else if (ema5 < ema10 && ema10 < ema20) tD += 0.75;
  }
  var ema5Vals = safeLastN(indicators.ema5, 3);
  if (ema5Vals.length >= 3) {
    var slope = ema5Vals[2] - ema5Vals[0];
    if (slope > 0) tU += 0.25; else if (slope < 0) tD += 0.25;
  }
  tU *= weights.trend; tD *= weights.trend;
  upScore += tU; downScore += tD;
  if (tU > tD && Math.abs(tU - tD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (tD > tU && Math.abs(tD - tU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.trend = { up: r2(tU), down: r2(tD) };

  // === CAT 2: MOMENTUM ===
  var mU = 0; var mD = 0;
  if (rsi !== null) {
    if (trending === true) {
      if (rsi >= 60 && rsi < 80) mU += 1.0; else if (rsi >= 50 && rsi < 60) mU += 0.5;
      else if (rsi > 40 && rsi < 50) mD += 0.5; else if (rsi > 20 && rsi <= 40) mD += 1.0;
      else if (rsi >= 80) mU += 0.3; else if (rsi <= 20) mD += 0.3;
    } else if (trending === false) {
      if (rsi >= 75) mD += 1.5; else if (rsi >= 65) mD += 0.75;
      else if (rsi <= 25) mU += 1.5; else if (rsi <= 35) mU += 0.75;
      else if (rsi >= 55) mU += 0.25; else if (rsi <= 45) mD += 0.25;
    } else {
      if (rsi >= 75) mD += 1.0; else if (rsi >= 60) mU += 0.5;
      else if (rsi <= 25) mU += 1.0; else if (rsi <= 40) mD += 0.5;
    }
  }
  if (williamsR !== null) {
    if (trending === true) {
      if (williamsR > -30) mU += 0.3; else if (williamsR < -70) mD += 0.3;
    } else {
      if (williamsR > -20) mD += 0.5; else if (williamsR < -80) mU += 0.5;
      else if (williamsR > -50) mU += 0.25; else mD += 0.25;
    }
  }
  if (mfi !== null) {
    var hasVolume = assetType === ASSET_TYPE.CRYPTO || lastCandle.volume > 0;
    if (hasVolume) {
      if (mfi >= 80) mD += 0.5; else if (mfi <= 20) mU += 0.5;
      else if (mfi >= 55) mU += 0.25; else if (mfi <= 45) mD += 0.25;
    }
  }
  mU *= weights.momentum; mD *= weights.momentum;
  upScore += mU; downScore += mD;
  if (mU > mD && Math.abs(mU - mD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mD > mU && Math.abs(mD - mU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.momentum = { up: r2(mU), down: r2(mD), context: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN' };

  // === CAT 3: MACD ===
  var mcU = 0; var mcD = 0;
  if (macdHist !== null) {
    if (macdHist > 0) mcU += 0.75; else if (macdHist < 0) mcD += 0.75;
    if (prevMacdHist !== null) {
      if (macdHist > 0 && macdHist > prevMacdHist) mcU += 0.4;
      else if (macdHist < 0 && macdHist < prevMacdHist) mcD += 0.4;
      else if (macdHist > 0 && macdHist < prevMacdHist) mcU += 0.1;
      else if (macdHist < 0 && macdHist > prevMacdHist) mcD += 0.1;
    }
  }
  if (macdLine !== null && macdSignal !== null) {
    if (macdLine > macdSignal) mcU += 0.5; else if (macdLine < macdSignal) mcD += 0.5;
    var prevMacdLine = macdLineData.prev;
    if (prevMacdLine !== null) {
      if (prevMacdLine <= 0 && macdLine > 0) mcU += 0.5;
      else if (prevMacdLine >= 0 && macdLine < 0) mcD += 0.5;
    }
  }
  mcU *= weights.macd; mcD *= weights.macd;
  upScore += mcU; downScore += mcD;
  if (mcU > mcD && Math.abs(mcU - mcD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (mcD > mcU && Math.abs(mcD - mcU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.macd = { up: r2(mcU), down: r2(mcD) };

  // === CAT 4: STOCHASTIC ===
  var sU = 0; var sD = 0;
  if (stochK !== null && stochD !== null) {
    if (trending === true) {
      if (stochK > stochD && stochK > 40 && stochK < 70) sU += 0.75;
      else if (stochK < stochD && stochK > 30 && stochK < 60) sD += 0.75;
      if (prevStochK !== null && prevStochK < 30 && stochK > 30 && stochK > stochD) sU += 0.75;
      if (prevStochK !== null && prevStochK > 70 && stochK < 70 && stochK < stochD) sD += 0.75;
    } else {
      if (stochK > 80 && stochD > 80) sD += 0.75; else if (stochK < 20 && stochD < 20) sU += 0.75;
      if (stochK > stochD) sU += 0.5; else if (stochK < stochD) sD += 0.5;
      if (prevStochK !== null) { if (stochK > prevStochK) sU += 0.25; else if (stochK < prevStochK) sD += 0.25; }
      if (stochK < 20 && stochK > stochD) sU += 0.5;
      if (stochK > 80 && stochK < stochD) sD += 0.5;
    }
  }
  sU *= weights.stochastic; sD *= weights.stochastic;
  upScore += sU; downScore += sD;
  if (sU > sD && Math.abs(sU - sD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (sD > sU && Math.abs(sD - sU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.stochastic = { up: r2(sU), down: r2(sD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 5: BOLLINGER + CCI ===
  var bU = 0; var bD = 0;
  if (bbUpper !== null && bbLower !== null && bbMiddle !== null) {
    if (trending === true) {
      if (lastClose >= bbUpper) { if (ema5 > ema20) bU += 0.75; else bD += 0.5; }
      else if (lastClose <= bbLower) { if (ema5 < ema20) bD += 0.75; else bU += 0.5; }
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    } else {
      if (lastClose >= bbUpper) bD += 1.0; else if (lastClose <= bbLower) bU += 1.0;
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    }
    if (bbPercentB !== null) {
      if (trending !== true) {
        if (bbPercentB > 1.0) bD += 0.5; else if (bbPercentB < 0.0) bU += 0.5;
      } else {
        if (bbPercentB > 1.0 && ema5 > ema20) bU += 0.25;
        else if (bbPercentB < 0.0 && ema5 < ema20) bD += 0.25;
      }
    }
  }
  if (cci !== null) {
    if (trending === true) {
      if (cci > 150) bU += 0.5; else if (cci > 100) bU += 0.35;
      else if (cci < -150) bD += 0.5; else if (cci < -100) bD += 0.35;
    } else {
      if (cci > 150) bD += 0.5; else if (cci > 100) bD += 0.35;
      else if (cci < -150) bU += 0.5; else if (cci < -100) bU += 0.35;
      else if (cci > 50) bU += 0.15; else if (cci < -50) bD += 0.15;
    }
  }
  bU *= weights.bands; bD *= weights.bands;
  upScore += bU; downScore += bD;
  if (bU > bD && Math.abs(bU - bD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (bD > bU && Math.abs(bD - bU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.bands = { up: r2(bU), down: r2(bD), context: trending === true ? 'TRENDING' : 'RANGING' };

  // === CAT 6: ADX + DI ===
  var aU = 0; var aD = 0; var diCross = null;
  if (adxVal !== null && plusDI !== null && minusDI !== null) {
    if (plusDI > minusDI) aU += 0.75; else if (minusDI > plusDI) aD += 0.75;
    if (adxVal >= 25) { if (plusDI > minusDI) aU += 0.75; else aD += 0.75; }
    var adxLastTwo = safeLastTwo(indicators.adx.adx);
    if (adxLastTwo.last !== null && adxLastTwo.prev !== null) {
      if (adxLastTwo.last > adxLastTwo.prev && adxLastTwo.last >= 20) {
        if (plusDI > minusDI) aU += 0.5; else aD += 0.5;
      } else if (adxLastTwo.last < adxLastTwo.prev && adxLastTwo.last < 25) {
        aU *= 0.7; aD *= 0.7;
      }
    }
    diCross = detectDICrossover(indicators.adx);
    if (diCross) {
      if (diCross.direction === 'BUY') aU += diCross.strength;
      else if (diCross.direction === 'SELL') aD += diCross.strength;
    }
  }
  aU *= weights.adx; aD *= weights.adx;
  upScore += aU; downScore += aD;
  if (aU > aD && Math.abs(aU - aD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (aD > aU && Math.abs(aD - aU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.adx = { up: r2(aU), down: r2(aD), diCross: diCross ? diCross.type : 'NONE' };

  // === CAT 7: CANDLESTICK PATTERNS ===
  var pU = 0; var pD = 0;
  if (patterns && patterns.length > 0) {
    for (var pi = 0; pi < patterns.length; pi++) {
      var pat = patterns[pi];
      var adjustedStrength = pat.strength;
      if (trending === true) {
        var isCont = (pat.direction === 'BUY' && ema5 > ema20) || (pat.direction === 'SELL' && ema5 < ema20);
        adjustedStrength *= isCont ? 1.3 : 0.6;
      }
      if (pat.direction === 'BUY') pU += adjustedStrength;
      else if (pat.direction === 'SELL') pD += adjustedStrength;
    }
  }
  var bodySize   = Math.abs(lastCandle.close - lastCandle.open);
  var totalRange = (lastCandle.high - lastCandle.low) || 0.00001;
  if (bodySize / totalRange > 0.6) {
    if (lastCandle.close > lastCandle.open) pU += 0.5; else pD += 0.5;
  }
  pU = Math.min(pU, 3.0); pD = Math.min(pD, 3.0);
  pU *= weights.patterns; pD *= weights.patterns;
  upScore += pU; downScore += pD;
  if (pU > pD && Math.abs(pU - pD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pD > pU && Math.abs(pD - pU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.patterns = { up: r2(pU), down: r2(pD), detected: patterns ? patterns.map(function (p) { return p.name; }) : [] };

  // === CAT 8: DIVERGENCE ===
  var dvU = 0; var dvD = 0;
  var rDiv = detectRSIDivergence(candles, indicators.rsi);
  var mDiv = detectMACDDivergence(candles, indicators.macd.histogram);
  if (rDiv) { var rStr = rDiv.confirmed ? rDiv.strength : rDiv.strength * 0.5; if (rDiv.direction === 'BUY') dvU += rStr; else dvD += rStr; }
  if (mDiv) { var mStr = mDiv.confirmed ? mDiv.strength : mDiv.strength * 0.5; if (mDiv.direction === 'BUY') dvU += mStr; else dvD += mStr; }
  dvU = Math.min(dvU, 2.5); dvD = Math.min(dvD, 2.5);
  dvU *= weights.divergence; dvD *= weights.divergence;
  upScore += dvU; downScore += dvD;
  if (dvU > dvD && Math.abs(dvU - dvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (dvD > dvU && Math.abs(dvD - dvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.divergence = {
    up: r2(dvU), down: r2(dvD),
    rsi: rDiv ? rDiv.type : 'NONE', rsiConfirmed: rDiv ? rDiv.confirmed : false,
    macd: mDiv ? mDiv.type : 'NONE', macdConfirmed: mDiv ? mDiv.confirmed : false,
  };

  // === CAT 9: PIVOT POINTS ===
  var pvU = 0; var pvD = 0;
  if (pivots && pivots.pivot !== null) {
    if (lastClose > pivots.pivot) pvU += 0.5; else if (lastClose < pivots.pivot) pvD += 0.5;
    var proximityThreshold = atr !== null ? atr * 0.5 : lastClose * 0.002;
    if (pivots.s1 && Math.abs(lastClose - pivots.s1) < proximityThreshold) pvU += 0.75;
    if (pivots.s2 && Math.abs(lastClose - pivots.s2) < proximityThreshold) pvU += 1.0;
    if (pivots.r1 && Math.abs(lastClose - pivots.r1) < proximityThreshold) pvD += 0.75;
    if (pivots.r2 && Math.abs(lastClose - pivots.r2) < proximityThreshold) pvD += 1.0;
    if (pivots.r1 && pivots.pivot && lastClose > pivots.pivot && lastClose < pivots.r1) pvU += 0.25;
    if (pivots.s1 && pivots.pivot && lastClose < pivots.pivot && lastClose > pivots.s1) pvD += 0.25;
  }
  pvU = Math.min(pvU, 2.0); pvD = Math.min(pvD, 2.0);
  pvU *= weights.pivots; pvD *= weights.pivots;
  upScore += pvU; downScore += pvD;
  if (pvU > pvD && Math.abs(pvU - pvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pvD > pvU && Math.abs(pvD - pvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.pivots = { up: r2(pvU), down: r2(pvD) };

  // === CAT 10: VOLUME ===
  var vU = 0; var vD = 0;
  var hasReliableVolume = assetType === ASSET_TYPE.CRYPTO ||
    (candles.length >= 20 && candles.slice(-20).some(function (c) { return c.volume > 0; }));

  if (hasReliableVolume && candles.length >= 20) {
    var rv = candles.slice(-20).map(function (c) { return c.volume; });
    var av = rv.reduce(function (a, b) { return a + b; }, 0) / rv.length;
    if (av > 0 && lastCandle.volume > av * 1.5) {
      if (lastCandle.close > lastCandle.open) vU += 0.75;
      else if (lastCandle.close < lastCandle.open) vD += 0.75;
    }
    if (candles.length >= 5) {
      var lv = candles.slice(-5).map(function (c) { return c.volume; });
      var avgRecent = (lv[3] + lv[4]) / 2;
      var avgOlder  = (lv[0] + lv[1]) / 2;
      if (avgOlder > 0 && avgRecent > avgOlder * 1.2) {
        if (lastCandle.close > candles[candles.length - 5].close) vU += 0.25; else vD += 0.25;
      }
    }
    if (patterns && patterns.length > 0 && av > 0 && lastCandle.volume > av * 1.3) {
      for (var vpi = 0; vpi < patterns.length; vpi++) {
        if (patterns[vpi].direction === 'BUY') vU += 0.15;
        else if (patterns[vpi].direction === 'SELL') vD += 0.15;
      }
    }
  }
  vU *= weights.volume; vD *= weights.volume;
  upScore += vU; downScore += vD;
  if (vU > vD && Math.abs(vU - vD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (vD > vU && Math.abs(vD - vU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.volume = {
    up: r2(vU), down: r2(vD), reliable: hasReliableVolume,
    skipped: !hasReliableVolume ? 'No reliable volume data (forex)' : null,
  };

  // === [v6.3] CAT 11: SUPPORT & RESISTANCE ===
  var srU = 0; var srD = 0;
  var srContext = 'NO_LEVEL'; // NEAR_SUPPORT | NEAR_RESISTANCE | BETWEEN | NO_LEVEL
  if (atr !== null && atr > 0) {
    var nearThresh = atr * 0.5; // [v6.4] tightened from 1.0 → 0.5 (prevents over-wide S/R detection)
    var nearSupport = null; var nearResistance = null;

    // Find nearest support BELOW price
    for (var si2 = 0; si2 < sr.supports.length; si2++) {
      var sup = sr.supports[si2];
      if (lastClose > sup.price && Math.abs(lastClose - sup.price) <= nearThresh) {
        nearSupport = sup; break;
      }
    }
    // Find nearest resistance ABOVE price
    for (var ri2 = 0; ri2 < sr.resistances.length; ri2++) {
      var res = sr.resistances[ri2];
      if (lastClose < res.price && Math.abs(lastClose - res.price) <= nearThresh) {
        nearResistance = res; break;
      }
    }

    if (nearSupport && !nearResistance) {
      var proximity  = 1 - (Math.abs(lastClose - nearSupport.price) / nearThresh);
      // FIX 4: normalize strength 0.0–1.0 (strength=1→0.33, 2→0.67, 3+→1.0)
      // Prevents CAT 11 dominating all other categories
      var normStrS   = Math.min(nearSupport.strength / 3, 1.0);
      srU += 2.0 * proximity * normStrS;
      srContext = 'NEAR_SUPPORT';
    } else if (nearResistance && !nearSupport) {
      var proximity2 = 1 - (Math.abs(lastClose - nearResistance.price) / nearThresh);
      // FIX 4: normalize strength
      var normStrR   = Math.min(nearResistance.strength / 3, 1.0);
      srD += 2.0 * proximity2 * normStrR;
      srContext = 'NEAR_RESISTANCE';
    } else if (nearSupport && nearResistance) {
      srContext = 'BETWEEN';
    } else {
      srContext = 'NO_LEVEL';
    }
  }
  srU = Math.min(srU, 2.0); srD = Math.min(srD, 2.0); // cap at 2.0 (was 3.0)
  srU *= weights.sr || 1.4; srD *= weights.sr || 1.4;   // max after weight = 2.8
  upScore += srU; downScore += srD;
  if (srU > srD && Math.abs(srU - srD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (srD > srU && Math.abs(srD - srU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.sr = { up: r2(srU), down: r2(srD), context: srContext };

  // [v6.3.1] S/R context penalty
  var srPenalty = 1.0;
  if (srContext === 'BETWEEN') srPenalty = 0.85;
  else if (srContext === 'NO_LEVEL') srPenalty = 0.90;

  // === [v6.3] FVG CONTEXT in analyzeTimeframe ===
  // [v6.3.1] Score penalty removed — hard block in buildMultiTimeframeSignal is sufficient.
  // Double-penalizing (score cut + hard block) was over-filtering strong signals.
  catScores.fvg = {
    active: fvg.active ? fvg.active.type : 'NONE',
    bullishCount: fvg.bullish ? fvg.bullish.length : 0,
    bearishCount: fvg.bearish ? fvg.bearish.length : 0,
  };

  // === VOLATILITY FILTER ===
  var volMult = 1.0;
  if (bbBandwidth !== null) {
    if (bbBandwidth < vt.bbFilterDead) volMult = 0.4;
    else if (bbBandwidth < vt.bbFilterLow) volMult = 0.6;
    else if (bbBandwidth < vt.bbFilterMed) volMult = 0.8;
  }
  // [v6.3.1] Apply srPenalty + volMult here — isolated from category score accumulation
  upScore *= volMult * srPenalty; downScore *= volMult * srPenalty;

  // === [v6.8.0] P5: CAMARILLA PIVOT SCORING ===
  // Applied AFTER volMult+srPenalty so dead/choppy market naturally reduces Camarilla influence
  var camScore = { up: 0, down: 0, level: 'NONE' };
  if (indicators.camarilla && atr !== null) {
    camScore = scoreCamarillaLevels(indicators.camarilla, lastClose, atr);
    var camW = (weights.sr || 1.4) * volMult * srPenalty; // scale with market quality
    upScore   += camScore.up   * camW * 0.6;
    downScore += camScore.down * camW * 0.6;
  }
  catScores.camarilla = { up: r2(camScore.up), down: r2(camScore.down), level: camScore.level };

  // === HIGHER-TF PENALTY ===
  var htfPenalty = 1.0;
  if (higherTFTrend !== null) {
    var thisTFDir = upScore > downScore ? 'BUY' : downScore > upScore ? 'SELL' : null;
    if (thisTFDir !== null && thisTFDir !== higherTFTrend) {
      htfPenalty = 0.7;
      if (thisTFDir === 'BUY') upScore *= 0.7; else downScore *= 0.7;
    }
  }

  // === DECISION ===
  var scoreDiff  = Math.abs(upScore - downScore);
  var confluence = Math.max(upCat, downCat);
  var direction;

  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) direction = 'BUY';
  else if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) direction = 'SELL';
  else if (scoreDiff >= 4.0 && confluence >= 4) direction = upScore > downScore ? 'BUY' : 'SELL';
  else direction = 'NO_TRADE';

  // === EMA ALIGNMENT SUMMARY ===
  var emaAlignment = 'MIXED';
  if (ema10 !== null) {
    if (ema5 > ema10 && ema10 > ema20) emaAlignment = 'BULLISH';
    else if (ema5 < ema10 && ema10 < ema20) emaAlignment = 'BEARISH';
  }

  return {
    direction: direction,
    score: { up: r2(upScore), down: r2(downScore), diff: r2(scoreDiff) },
    confluence: confluence,
    confluenceDetail: { bullish: upCat, bearish: downCat, total: 11 },
    categoryScores: catScores,
    volatilityMultiplier: volMult,
    htfPenalty: htfPenalty < 1.0 ? 'COUNTER_TREND_PENALTY' : 'NONE',
    marketContext: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN',
    assetType: assetType,
    indicators: {
      ema5: fmt(ema5), ema10: fmt(ema10), ema20: fmt(ema20), sma50: fmt(sma50),
      emaAlignment: emaAlignment,
      rsi: fmt(rsi, 2), stochK: fmt(stochK, 2), stochD: fmt(stochD, 2),
      macdHist: fmt(macdHist, 6), macdLine: fmt(macdLine, 6), macdSignal: fmt(macdSignal, 6),
      adx: fmt(adxVal, 2), plusDI: fmt(plusDI, 2), minusDI: fmt(minusDI, 2),
      williamsR: fmt(williamsR, 2), cci: fmt(cci, 2), mfi: assetType === ASSET_TYPE.CRYPTO ? fmt(mfi, 2) : 'N/A (Forex)', atr: fmt(atr, 6),
      bbUpper: fmt(bbUpper), bbMiddle: fmt(bbMiddle), bbLower: fmt(bbLower),
      bbBandwidth: bbBandwidth !== null ? bbBandwidth.toFixed(4) : 'N/A',
      bbPercentB: fmt(bbPercentB, 4),
      pivot: pivots.pivot !== null ? pivots.pivot.toFixed(5) : 'N/A',
      r1: pivots.r1 !== null ? pivots.r1.toFixed(5) : 'N/A',
      r2val: pivots.r2 !== null ? pivots.r2.toFixed(5) : 'N/A',
      s1: pivots.s1 !== null ? pivots.s1.toFixed(5) : 'N/A',
      s2: pivots.s2 !== null ? pivots.s2.toFixed(5) : 'N/A',
      patterns: patterns ? patterns.map(function (p) { return p.name; }) : [],
    },
    timeframe: timeframe,
  };
}


// ============================================

export { analyzeTimeframe };

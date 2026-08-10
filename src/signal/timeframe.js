import {
  CONFIG, ASSET_TYPE, SCORE_THRESHOLDS, VOLATILITY_THRESHOLDS,
} from '../config.js';
import { safeLastValue, safeLastTwo, safeLastN, r2, fmt } from '../utils/helpers.js';
import { detectRSIDivergence, detectMACDDivergence } from '../indicators/divergence.js';
import { getRegimeWeights, isTrendingMarket, detectDICrossover } from '../indicators/regime.js';
import { scoreCamarillaLevels } from '../indicators/math.js';
// R7.1: shared per-TF decision + private shadow capture transport.
import { decideTfDirection } from './voteFilters.js';
import { attachShadowTf } from './r71shadow.js';
import { calculateAtrPercentileState, calculateBbVolatilityState } from '../analysis/edgeFeatures.js';

export function analyzeTimeframe(indicators, candles, timeframe, assetType, higherTFTrend, marketRegime) {
  const vt = VOLATILITY_THRESHOLDS[assetType] || VOLATILITY_THRESHOLDS.FOREX;
  const minScoreThreshold = SCORE_THRESHOLDS[assetType] || 3.0;
  const weights = getRegimeWeights(marketRegime || 'RANGING');

  // ── EMA 5 / 13 / 55 (Fibonacci set) ──
  const ema5  = safeLastValue(indicators.ema5);
  const ema13 = safeLastValue(indicators.ema13);
  const ema55 = safeLastValue(indicators.ema55);

  const rsi   = safeLastValue(indicators.rsi);
  const macdHistData   = safeLastTwo(indicators.macd.histogram);
  const macdHist       = macdHistData.last;
  const prevMacdHist   = macdHistData.prev;
  const macdLineData   = safeLastTwo(indicators.macd.macdLine);
  const macdLine       = macdLineData.last;
  const macdSignalData = safeLastTwo(indicators.macd.signalLine);
  const macdSignal     = macdSignalData.last;
  const atr         = safeLastValue(indicators.atr);
  const bbUpper     = safeLastValue(indicators.bollinger.upper);
  const bbLower     = safeLastValue(indicators.bollinger.lower);
  const bbMiddle    = safeLastValue(indicators.bollinger.middle);
  const bbBandwidth = safeLastValue(indicators.bollinger.bandwidth);
  const bbPercentB  = safeLastValue(indicators.bollinger.percentB);
  // Additive signal-time state used by edge gates and history instrumentation.
  // Both calculations compare the current value with its OWN preceding values;
  // no cross-asset absolute threshold is smuggled in.
  const atrPercentileState = calculateAtrPercentileState(indicators.atr);
  const bbVolatilityState  = calculateBbVolatilityState(indicators.bollinger.bandwidth);
  const stochK       = safeLastValue(indicators.stochastic.k);
  const stochD       = safeLastValue(indicators.stochastic.d);
  const prevStochK   = safeLastTwo(indicators.stochastic.k).prev;
  const adxVal   = safeLastValue(indicators.adx.adx);
  const plusDI   = safeLastValue(indicators.adx.plusDI);
  const minusDI  = safeLastValue(indicators.adx.minusDI);
  const williamsR = safeLastValue(indicators.williamsR);
  const cci       = safeLastValue(indicators.cci);
  const mfi       = safeLastValue(indicators.mfi);
  const pivots    = indicators.pivots;
  const patterns  = indicators.patterns;
  const sr        = indicators.sr  || { supports: [], resistances: [] };
  const fvg       = indicators.fvg || { active: null };

  if (ema5 === null || ema55 === null) {
    return {
      direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
      confluence: 0, reason: 'Insufficient data', timeframe, assetType,
      categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 12 }, volatilityMultiplier: 0,
    };
  }

  const lastCandle = candles[candles.length - 1];
  const lastClose  = lastCandle.close;
  const trending   = isTrendingMarket(adxVal);

  if (atr !== null && lastClose > 0) {
    const atrPct = (atr / lastClose) * 100;
    if (atrPct < vt.minTradableATR) {
      return {
        direction: 'NO_TRADE', score: { up: 0, down: 0, diff: 0 },
        confluence: 0, reason: 'Dead market — ATR too low',
        timeframe, assetType, deadMarket: true,
        categoryScores: {}, confluenceDetail: { bullish: 0, bearish: 0, total: 12 }, volatilityMultiplier: 0,
      };
    }
  }

  let upScore = 0; let downScore = 0; let upCat = 0; let downCat = 0;
  const catScores = {};

  // ── TREND (EMA 5/13/55 Fibonacci stack) ──
  let tU = 0; let tD = 0;

  // Full stack alignment: 5 > 13 > 55 = strong bull
  if (ema13 !== null && ema55 !== null) {
    if (ema5 > ema13 && ema13 > ema55)      tU += 2.0;  // Full bull stack
    else if (ema5 < ema13 && ema13 < ema55) tD += 2.0;  // Full bear stack
    else if (ema5 > ema13)                   tU += 0.8;  // Fast above mid
    else if (ema5 < ema13)                   tD += 0.8;  // Fast below mid
    if (lastClose > ema55)  tU += 0.75;                  // Price above slow filter
    else if (lastClose < ema55) tD += 0.75;
  } else {
    if (ema5 > ema55) tU += 1.0; else if (ema5 < ema55) tD += 1.0;
  }

  // EMA5/13 crossover detection (early signal)
  const ema5Prev  = safeLastN(indicators.ema5, 3);
  const ema13Prev = safeLastN(indicators.ema13, 3);
  if (ema5Prev.length >= 3 && ema13Prev.length >= 3) {
    const wasBelowMid = ema5Prev[0] < ema13Prev[0];
    const nowAboveMid = ema5Prev[2] > ema13Prev[2];
    if (wasBelowMid && nowAboveMid) tU += 1.2;  // Fresh golden cross
    const wasAboveMid = ema5Prev[0] > ema13Prev[0];
    const nowBelowMid = ema5Prev[2] < ema13Prev[2];
    if (wasAboveMid && nowBelowMid) tD += 1.2;  // Fresh death cross
  }

  // EMA5 slope
  if (ema5Prev.length >= 3) {
    const slope = ema5Prev[2] - ema5Prev[0];
    if (slope > 0) tU += 0.25; else if (slope < 0) tD += 0.25;
  }

  // EMA13 as pullback zone (price near EMA13 in trend = entry signal)
  if (ema13 !== null && atr !== null && atr > 0) {
    const dist13 = Math.abs(lastClose - ema13);
    if (dist13 < atr * 0.5) {
      if (lastClose > ema55 && ema5 > ema13) tU += 0.6;  // Pullback to EMA13 in uptrend
      if (lastClose < ema55 && ema5 < ema13) tD += 0.6;  // Pullback to EMA13 in downtrend
    }
  }

  tU *= weights.trend; tD *= weights.trend;
  upScore += tU; downScore += tD;
  if (tU > tD && Math.abs(tU - tD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (tD > tU && Math.abs(tD - tU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;

  // EMA alignment label for display
  let emaAlignment = 'MIXED';
  if (ema13 !== null && ema55 !== null) {
    if (ema5 > ema13 && ema13 > ema55)      emaAlignment = 'FULL_BULL_STACK';
    else if (ema5 < ema13 && ema13 < ema55) emaAlignment = 'FULL_BEAR_STACK';
    else if (ema5 > ema13 && lastClose > ema55) emaAlignment = 'BULLISH';
    else if (ema5 < ema13 && lastClose < ema55) emaAlignment = 'BEARISH';
  }
  catScores.trend = { up: r2(tU), down: r2(tD), emaAlignment };

  // ── MOMENTUM (RSI / Williams %R / MFI) ──
  let mU = 0; let mD = 0;
  if (rsi !== null) {
    if (trending === true) {
      if (rsi >= 60 && rsi < 80) mU += 1.0; else if (rsi >= 50 && rsi < 60) mU += 0.5;
      else if (rsi > 40 && rsi < 50) mD += 0.5; else if (rsi > 20 && rsi <= 40) mD += 1.0;
      else if (rsi >= 80) mU += 0.3; else if (rsi <= 20) mD += 0.3;
    } else if (trending === false) {
      // F3-11 (BUG-030): the middle-zone trend-following scores are removed.
      // In a RANGING regime RSI 55-64 added BUY (+0.25) while RSI 65+ added
      // SELL (+0.75) — an abrupt BUY→SELL flip at 65 with rising RSI, i.e. a
      // trend-following bias inside a mean-reversion regime. Ranging markets
      // now only reward the mean-reversion extremes (<=35 / >=65).
      if (rsi >= 75) mD += 1.5; else if (rsi >= 65) mD += 0.75;
      else if (rsi <= 25) mU += 1.5; else if (rsi <= 35) mU += 0.75;
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
    const hasVolume = assetType === ASSET_TYPE.CRYPTO || lastCandle.volume > 0;
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

  // ── MACD ──
  let mcU = 0; let mcD = 0;
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
    const prevMacdLine = macdLineData.prev;
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

  // ── STOCHASTIC ──
  let sU = 0; let sD = 0;
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

  // ── BOLLINGER BANDS + CCI ──
  let bU = 0; let bD = 0;
  if (bbUpper !== null && bbLower !== null && bbMiddle !== null) {
    if (trending === true) {
      if (lastClose >= bbUpper) { if (ema5 > ema55) bU += 0.75; else bD += 0.5; }
      else if (lastClose <= bbLower) { if (ema5 < ema55) bD += 0.75; else bU += 0.5; }
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    } else {
      if (lastClose >= bbUpper) bD += 1.0; else if (lastClose <= bbLower) bU += 1.0;
      else if (lastClose > bbMiddle) bU += 0.25; else if (lastClose < bbMiddle) bD += 0.25;
    }
    if (bbPercentB !== null) {
      if (trending !== true) {
        if (bbPercentB > 1.0) bD += 0.5; else if (bbPercentB < 0.0) bU += 0.5;
      } else {
        if (bbPercentB > 1.0 && ema5 > ema55) bU += 0.25;
        else if (bbPercentB < 0.0 && ema5 < ema55) bD += 0.25;
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

  // ── ADX ──
  let aU = 0; let aD = 0; let diCross = null;
  if (adxVal !== null && plusDI !== null && minusDI !== null) {
    if (plusDI > minusDI) aU += 0.75; else if (minusDI > plusDI) aD += 0.75;
    if (adxVal >= 25) { if (plusDI > minusDI) aU += 0.75; else aD += 0.75; }
    const adxLT = safeLastTwo(indicators.adx.adx);
    if (adxLT.last !== null && adxLT.prev !== null) {
      if (adxLT.last > adxLT.prev && adxLT.last >= 20) {
        if (plusDI > minusDI) aU += 0.5; else aD += 0.5;
      } else if (adxLT.last < adxLT.prev && adxLT.last < 25) { aU *= 0.7; aD *= 0.7; }
    }
    diCross = detectDICrossover(indicators.adx);
    if (diCross) { if (diCross.direction === 'BUY') aU += diCross.strength; else aD += diCross.strength; }
  }
  aU *= weights.adx; aD *= weights.adx;
  upScore += aU; downScore += aD;
  if (aU > aD && Math.abs(aU - aD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (aD > aU && Math.abs(aD - aU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.adx = { up: r2(aU), down: r2(aD), diCross: diCross ? diCross.type : 'NONE' };

  // ── PATTERNS ──
  let pU = 0; let pD = 0;
  if (patterns && patterns.length > 0) {
    for (const pat of patterns) {
      let adj = pat.strength;
      if (trending === true) {
        const isCont = (pat.direction === 'BUY' && ema5 > ema55) || (pat.direction === 'SELL' && ema5 < ema55);
        adj *= isCont ? 1.3 : 0.6;
      }
      if (pat.direction === 'BUY') pU += adj; else if (pat.direction === 'SELL') pD += adj;
    }
  }
  const bodySize   = Math.abs(lastCandle.close - lastCandle.open);
  const totalRange = (lastCandle.high - lastCandle.low) || 0.00001;
  if (bodySize / totalRange > 0.6) { if (lastCandle.close > lastCandle.open) pU += 0.5; else pD += 0.5; }
  pU = Math.min(pU, 3.0); pD = Math.min(pD, 3.0);
  pU *= weights.patterns; pD *= weights.patterns;
  upScore += pU; downScore += pD;
  if (pU > pD && Math.abs(pU - pD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pD > pU && Math.abs(pD - pU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.patterns = { up: r2(pU), down: r2(pD), detected: patterns ? patterns.map(p => p.name) : [] };

  // ── DIVERGENCE ──
  let dvU = 0; let dvD = 0;
  const rDiv = detectRSIDivergence(candles, indicators.rsi);
  const mDiv = detectMACDDivergence(candles, indicators.macd.histogram);
  if (rDiv) { const rs = rDiv.confirmed ? rDiv.strength : rDiv.strength * 0.5; if (rDiv.direction === 'BUY') dvU += rs; else dvD += rs; }
  if (mDiv) { const ms = mDiv.confirmed ? mDiv.strength : mDiv.strength * 0.5; if (mDiv.direction === 'BUY') dvU += ms; else dvD += ms; }
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

  // ── PIVOTS ──
  let pvU = 0; let pvD = 0;
  if (pivots && pivots.pivot !== null) {
    if (lastClose > pivots.pivot) pvU += 0.5; else if (lastClose < pivots.pivot) pvD += 0.5;
    const proxThr = atr !== null ? atr * 0.5 : lastClose * 0.002;
    if (pivots.s1 && Math.abs(lastClose - pivots.s1) < proxThr) pvU += 0.75;
    if (pivots.s2 && Math.abs(lastClose - pivots.s2) < proxThr) pvU += 1.0;
    if (pivots.r1 && Math.abs(lastClose - pivots.r1) < proxThr) pvD += 0.75;
    if (pivots.r2 && Math.abs(lastClose - pivots.r2) < proxThr) pvD += 1.0;
    if (pivots.r1 && lastClose > pivots.pivot && lastClose < pivots.r1) pvU += 0.25;
    if (pivots.s1 && lastClose < pivots.pivot && lastClose > pivots.s1) pvD += 0.25;
  }
  pvU = Math.min(pvU, 2.0); pvD = Math.min(pvD, 2.0);
  pvU *= weights.pivots; pvD *= weights.pivots;
  upScore += pvU; downScore += pvD;
  if (pvU > pvD && Math.abs(pvU - pvD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (pvD > pvU && Math.abs(pvD - pvU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.pivots = { up: r2(pvU), down: r2(pvD) };

  // ── VOLUME ──
  let vU = 0; let vD = 0;
  const hasReliableVolume = assetType === ASSET_TYPE.CRYPTO ||
    (candles.length >= 20 && candles.slice(-20).some(c => c.volume > 0));
  if (hasReliableVolume && candles.length >= 20) {
    const rv  = candles.slice(-20).map(c => c.volume);
    const av  = rv.reduce((a, b) => a + b, 0) / rv.length;
    if (av > 0 && lastCandle.volume > av * 1.5) {
      if (lastCandle.close > lastCandle.open) vU += 0.75; else if (lastCandle.close < lastCandle.open) vD += 0.75;
    }
    if (candles.length >= 5) {
      const lv5 = candles.slice(-5).map(c => c.volume);
      const avgRecent = (lv5[3] + lv5[4]) / 2;
      const avgOlder  = (lv5[0] + lv5[1]) / 2;
      if (avgOlder > 0 && avgRecent > avgOlder * 1.2) {
        if (lastCandle.close > candles[candles.length - 5].close) vU += 0.25; else vD += 0.25;
      }
    }
  }
  vU *= weights.volume; vD *= weights.volume;
  upScore += vU; downScore += vD;
  if (vU > vD && Math.abs(vU - vD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (vD > vU && Math.abs(vD - vU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.volume = { up: r2(vU), down: r2(vD), reliable: hasReliableVolume, skipped: !hasReliableVolume ? 'No reliable volume (forex)' : null };

  // ── S/R ──
  let srU = 0; let srD = 0; let srContext = 'NO_LEVEL';
  if (atr !== null && atr > 0) {
    const nearThresh = atr * 0.5;
    let nearSupport = null; let nearResistance = null;
    for (const sup of sr.supports) {
      if (lastClose > sup.price && Math.abs(lastClose - sup.price) <= nearThresh) { nearSupport = sup; break; }
    }
    for (const res of sr.resistances) {
      if (lastClose < res.price && Math.abs(lastClose - res.price) <= nearThresh) { nearResistance = res; break; }
    }
    if (nearSupport && !nearResistance) {
      const prox = 1 - (Math.abs(lastClose - nearSupport.price) / nearThresh);
      srU += 2.0 * prox * Math.min(nearSupport.strength / 3, 1.0);
      srContext = 'NEAR_SUPPORT';
    } else if (nearResistance && !nearSupport) {
      const prox = 1 - (Math.abs(lastClose - nearResistance.price) / nearThresh);
      srD += 2.0 * prox * Math.min(nearResistance.strength / 3, 1.0);
      srContext = 'NEAR_RESISTANCE';
    } else if (nearSupport && nearResistance) {
      srContext = 'BETWEEN';
    }
  }
  srU = Math.min(srU, 2.0); srD = Math.min(srD, 2.0);
  const srW = weights.sr || 1.4;
  srU *= srW; srD *= srW;
  upScore += srU; downScore += srD;
  if (srU > srD && Math.abs(srU - srD) >= CONFIG.MIN_CATEGORY_SCORE) upCat++;
  else if (srD > srU && Math.abs(srD - srU) >= CONFIG.MIN_CATEGORY_SCORE) downCat++;
  catScores.sr  = { up: r2(srU), down: r2(srD), context: srContext };
  catScores.fvg = { active: fvg.active ? fvg.active.type : 'NONE', bullishCount: fvg.bullish ? fvg.bullish.length : 0, bearishCount: fvg.bearish ? fvg.bearish.length : 0 };

  // ── VOL/SR MULTIPLIERS ──
  const srPenalty = srContext === 'BETWEEN' ? 0.85 : srContext === 'NO_LEVEL' ? 0.90 : 1.0;
  let volMult = 1.0;
  if (bbBandwidth !== null) {
    if (bbBandwidth < vt.bbFilterDead) volMult = 0.4;
    else if (bbBandwidth < vt.bbFilterLow) volMult = 0.6;
    else if (bbBandwidth < vt.bbFilterMed) volMult = 0.8;
  }
  upScore *= volMult * srPenalty; downScore *= volMult * srPenalty;

  // ── CAMARILLA ──
  let camScore = { up: 0, down: 0, level: 'NONE' };
  if (indicators.camarilla && atr !== null) {
    camScore = scoreCamarillaLevels(indicators.camarilla, lastClose, atr);
    const camW = srW * volMult * srPenalty;
    upScore   += camScore.up   * camW * 0.6;
    downScore += camScore.down * camW * 0.6;
  }
  catScores.camarilla = { up: r2(camScore.up), down: r2(camScore.down), level: camScore.level };

  // ── HTF PENALTY ──
  let htfPenalty = 1.0;
  if (higherTFTrend !== null) {
    const thisTFDir = upScore > downScore ? 'BUY' : downScore > upScore ? 'SELL' : null;
    if (thisTFDir !== null && thisTFDir !== higherTFTrend) {
      htfPenalty = 0.7;
      if (thisTFDir === 'BUY') upScore *= 0.7; else downScore *= 0.7;
    }
  }

  // ── STRUCTURE QUALIFIER (BOS / CHoCH / Liquidity Sweep) ──
  // এটা vote না — এটা multiplier। Aligned → boost, counter → heavy penalty
  const structure     = indicators.structure || null;
  let structureApplied = 'NONE';
  let structureMultUp  = 1.0;
  let structureMultDn  = 1.0;

  if (structure && structure.multiplier && structure.multiplier.direction) {
    const sDir = structure.multiplier.direction;
    const sVal = structure.multiplier.value;      // e.g. 1.35 for CHoCH
    const sOpp = 2.0 - sVal;                       // e.g. 0.65 opposite penalty

    if (sDir === 'BUY') {
      structureMultUp = sVal;
      structureMultDn = Math.max(0.45, sOpp);      // Counter SELL gets heavy penalty
    } else if (sDir === 'SELL') {
      structureMultDn = sVal;
      structureMultUp = Math.max(0.45, sOpp);
    }
    structureApplied = structure.summary;
  } else if (structure && structure.bias !== 'NEUTRAL') {
    // Weak bias even without BOS/CHoCH — mild effect
    if (structure.bias === 'BULLISH')      { structureMultUp = 1.08; structureMultDn = 0.92; }
    else if (structure.bias === 'BEARISH') { structureMultDn = 1.08; structureMultUp = 0.92; }
    structureApplied = 'BIAS_' + structure.bias;
  }

  // R7.1: capture the no-structure (pre-multiplier) scores & pre-vote confluence.
  // These are the inputs the structure-excluded shadow decision reuses via the
  // shared decideTfDirection helper. Captured BEFORE any structure influence so
  // they are the faithful "structure removed" counterfactual at TF level.
  const __r71PreStructUp    = upScore;
  const __r71PreStructDown  = downScore;
  const __r71PreStructUpCat = upCat;
  const __r71PreStructDownCat = downCat;

  upScore   *= structureMultUp;
  downScore *= structureMultDn;

  // Structure category score add (for display/confluence)
  let __r71CategoryVoteApplied = false;
  let __r71VoteDirection = null;
  if (structure && structure.structureScore) {
    catScores.structure = {
      up:      structure.structureScore.up,
      down:    structure.structureScore.down,
      bias:    structure.bias,
      bos:     structure.bos     ? structure.bos.type     : 'NONE',
      choch:   structure.choch   ? structure.choch.type   : 'NONE',
      sweep:   structure.sweep   ? structure.sweep.type   : 'NONE',
      summary: structure.summary,
    };
    // Structure category confluence vote
    if (structure.structureScore.up > structure.structureScore.down &&
        structure.structureScore.up >= 1.5) { upCat++; __r71CategoryVoteApplied = true; __r71VoteDirection = 'BUY'; }
    else if (structure.structureScore.down > structure.structureScore.up &&
             structure.structureScore.down >= 1.5) { downCat++; __r71CategoryVoteApplied = true; __r71VoteDirection = 'SELL'; }
  }

  // ── DECISION ──
  const scoreDiff  = Math.abs(upScore - downScore);
  const confluence = Math.max(upCat, downCat);
  // R7.1: shared decision helper (identical logic; production + shadow share it).
  let direction = decideTfDirection(upScore, downScore, upCat, downCat, minScoreThreshold);
  // R7.1: production direction BEFORE the structure hard-block (audit field).
  const __r71PreHardBlockDirection = direction;

  // ── STRUCTURE HARD FILTER ──
  // CHoCH বা strong BOS এর বিরুদ্ধে signal → block করো
  // এটাই false signal সবচেয়ে বেশি কমাবে
  let __r71HardBlocked = false;
  let __r71HardBlockReason = null;
  if (direction !== 'NO_TRADE' && structure) {
    const sDir = structure.multiplier ? structure.multiplier.direction : null;
    // HARDEN-1 (bugfix round 2): defensive optional chaining — analyzeStructure
    // always sets multiplier, but every other accessor guards; this one should
    // too so a malformed structure object can never crash the signal path.
    const hasStrongStructure = structure.choch || (structure.bos && structure.multiplier?.value >= 1.20);

    if (hasStrongStructure && sDir !== null && sDir !== direction) {
      // Signal is COUNTER to confirmed BOS/CHoCH → hard block
      direction = 'NO_TRADE';
      __r71HardBlocked = true;
      __r71HardBlockReason = 'COUNTER_' + structure.summary;
      catScores.structure = { ...(catScores.structure || {}), hardBlocked: true, reason: 'COUNTER_' + structure.summary };
    }

    // Liquidity sweep opposite direction → soft penalty (already applied via multiplier)
    if (structure.sweep && structure.sweep.direction !== direction && direction !== 'NO_TRADE') {
      catScores.structure = { ...(catScores.structure || {}), sweepWarning: 'COUNTER_SWEEP_' + structure.sweep.type };
    }
  }

  // ── CONFIRMATION CANDLE CHECK ──
  let candleConfirmed = true;
  if (direction !== 'NO_TRADE') {
    const lastBullish = lastCandle.close >= lastCandle.open;
    const bodyRatio   = Math.abs(lastCandle.close - lastCandle.open) / ((lastCandle.high - lastCandle.low) || 0.00001);
    if (direction === 'BUY'  && !lastBullish && bodyRatio > 0.5) { candleConfirmed = false; upScore   *= 0.85; }
    if (direction === 'SELL' && lastBullish  && bodyRatio > 0.5) { candleConfirmed = false; downScore *= 0.85; }
  }

  // R7.1 (Report-7 correction): faithful shadow confirmation-candle penalty.
  // Production applies the x0.85 penalty AFTER per-TF direction selection. The
  // shadow must apply the SAME non-structure penalty, relative to
  // shadowCoreDirection, to the shadow ENGINE score only. shadowCoreDirection is
  // decided on the pre-structure/pre-confirmation score and is NOT re-decided —
  // exactly mirroring production (direction decided first, penalty after).
  const __r71ShadowCoreDir = decideTfDirection(
    __r71PreStructUp, __r71PreStructDown, __r71PreStructUpCat, __r71PreStructDownCat, minScoreThreshold
  );
  let __r71ShadowCandleConfirmed = true;
  let __r71ShadowConfPenalty = false;
  if (__r71ShadowCoreDir !== 'NO_TRADE') {
    const sLastBullish = lastCandle.close >= lastCandle.open;
    const sBodyRatio   = Math.abs(lastCandle.close - lastCandle.open) / ((lastCandle.high - lastCandle.low) || 0.00001);
    if (__r71ShadowCoreDir === 'BUY'  && !sLastBullish && sBodyRatio > 0.5) __r71ShadowCandleConfirmed = false;
    if (__r71ShadowCoreDir === 'SELL' && sLastBullish  && sBodyRatio > 0.5) __r71ShadowCandleConfirmed = false;
    __r71ShadowConfPenalty = !__r71ShadowCandleConfirmed;
  }
  const __r71ShadowEngUp   = (__r71ShadowCoreDir === 'BUY'  && __r71ShadowConfPenalty) ? r2(__r71PreStructUp   * 0.85) : r2(__r71PreStructUp);
  const __r71ShadowEngDown = (__r71ShadowCoreDir === 'SELL' && __r71ShadowConfPenalty) ? r2(__r71PreStructDown * 0.85) : r2(__r71PreStructDown);

  // R7.1: freshness semantics (honest names — see R7_1_IMPLEMENTATION_REPORT §4).
  // CHoCH/BOS detectors test a break on the LATEST candle, so a present event
  // is age 0; swing-index ages are NOT event ages.
  let __r71ChochEventAgeBars = null;
  let __r71BrokenSwingAgeBars = null;
  let __r71BosReferenceSwingBarsAgo = null;
  let __r71RecentBosBreakBarsAgo = null;
  if (structure) {
    __r71ChochEventAgeBars = structure.choch ? 0 : null;   // present CHoCH = break on latest candle
    __r71BosReferenceSwingBarsAgo = structure.bos ? structure.bos.barsAgo : null; // n-1-swingIdx, NOT break-event age
    if (structure.choch) {
      const swings = structure.choch.direction === 'BUY' ? structure.swingHighs : structure.swingLows;
      const lastSwing = swings && swings.length ? swings[swings.length - 1] : null;
      if (lastSwing && typeof lastSwing.idx === 'number')
        __r71BrokenSwingAgeBars = (candles.length - 1) - lastSwing.idx;   // broken swing pivot age
    } else if (structure.bos) {
      __r71BrokenSwingAgeBars = structure.bos.barsAgo;     // same reference swing as BOS
    }
    if (Array.isArray(structure.recentEvents) && structure.recentEvents.length) {
      let minAgo = Infinity;
      for (const ev of structure.recentEvents)
        if (typeof ev.barsAgo === 'number' && ev.barsAgo < minAgo) minAgo = ev.barsAgo;
      __r71RecentBosBreakBarsAgo = minAgo === Infinity ? null : minAgo;   // break-candle age
    }
  }

  const __r71Result = {
    direction, timeframe, assetType,
    score: { up: r2(upScore), down: r2(downScore), diff: r2(scoreDiff) },
    confluence, confluenceDetail: { bullish: upCat, bearish: downCat, total: 12 }, // 12 categories now
    categoryScores: catScores,
    structure: structure || null,                   // Full structure data in output
    structureApplied,
    volatilityMultiplier: volMult,
    htfPenalty: htfPenalty < 1.0 ? 'COUNTER_TREND_PENALTY' : 'NONE',
    marketContext: trending === true ? 'TRENDING' : trending === false ? 'RANGING' : 'UNKNOWN',
    candleConfirmed,
    indicators: {
      ema5: fmt(ema5), ema13: fmt(ema13), ema55: fmt(ema55),
      emaAlignment, rsi: fmt(rsi, 2),
      stochK: fmt(stochK, 2), stochD: fmt(stochD, 2),
      macdHist: fmt(macdHist, 6), macdLine: fmt(macdLine, 6), macdSignal: fmt(macdSignal, 6),
      adx: fmt(adxVal, 2), plusDI: fmt(plusDI, 2), minusDI: fmt(minusDI, 2),
      williamsR: fmt(williamsR, 2), cci: fmt(cci, 2),
      mfi: assetType === ASSET_TYPE.CRYPTO ? fmt(mfi, 2) : 'N/A (Forex)',
      atr: fmt(atr, 6),
      atrPercentile: atrPercentileState.percentile,
      atrState: atrPercentileState.state,
      bbUpper: fmt(bbUpper), bbMiddle: fmt(bbMiddle), bbLower: fmt(bbLower),
      bbBandwidth: bbBandwidth !== null ? bbBandwidth.toFixed(4) : 'N/A',
      bbWidthRatio: bbVolatilityState.ratio,
      volatilityState: bbVolatilityState.state,
      bbPercentB: fmt(bbPercentB, 4),
      pivot: pivots.pivot !== null ? pivots.pivot.toFixed(5) : 'N/A',
      r1: pivots.r1 !== null ? pivots.r1.toFixed(5) : 'N/A',
      r2val: pivots.r2 !== null ? pivots.r2.toFixed(5) : 'N/A',
      s1: pivots.s1 !== null ? pivots.s1.toFixed(5) : 'N/A',
      s2: pivots.s2 !== null ? pivots.s2.toFixed(5) : 'N/A',
      patterns: patterns ? patterns.map(p => p.name) : [],
    },
  };

  // R7.1: attach the private, non-enumerable shadow capture. Symbols are
  // invisible to JSON.stringify / public responses; read back only via
  // getShadowTfRaw(). Production fields above are byte-identical to 71e87eb.
  attachShadowTf(__r71Result, {
    preStructUp:        r2(__r71PreStructUp),
    preStructDown:      r2(__r71PreStructDown),
    preStructUpCat:     __r71PreStructUpCat,
    preStructDownCat:   __r71PreStructDownCat,
    shadowCoreDirection:        __r71ShadowCoreDir,
    shadowCandleConfirmed:      __r71ShadowCandleConfirmed,
    shadowConfirmationPenaltyApplied: __r71ShadowConfPenalty,
    shadowEngineScoreUp:        __r71ShadowEngUp,
    shadowEngineScoreDown:      __r71ShadowEngDown,
    structureMultUp,
    structureMultDn,
    preHardBlockDirection: __r71PreHardBlockDirection,
    hardBlocked:        __r71HardBlocked,
    hardBlockReason:    __r71HardBlockReason,
    categoryVoteApplied: __r71CategoryVoteApplied,
    voteDirection:      __r71VoteDirection,
    freshness: {
      chochEventAgeBars:       __r71ChochEventAgeBars,
      brokenSwingAgeBars:      __r71BrokenSwingAgeBars,
      bosReferenceSwingBarsAgo: __r71BosReferenceSwingBarsAgo,
      recentBosBreakBarsAgo:   __r71RecentBosBreakBarsAgo,
    },
  });

  return __r71Result;
}

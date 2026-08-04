import {
  CONFIG, ASSET_TYPE, CORRELATION_GROUPS, NEGATIVE_CORRELATIONS,
  SESSION_PAIR_WEIGHTS,
} from '../config.js';

export function isVolumeSpikeAnomaly(candles, assetType) {
  if (assetType !== ASSET_TYPE.CRYPTO) return false;
  if (!candles || candles.length < 21) return false;
  const lastCandle = candles[candles.length - 1];
  const sample = candles.slice(-21, -1);
  const avgVol = sample.reduce((a, c) => a + c.volume, 0) / sample.length;
  if (avgVol <= 0) return false;
  const ratio = lastCandle.volume / avgVol;
  if (ratio > CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER) {
    const body  = Math.abs(lastCandle.close - lastCandle.open);
    const range = (lastCandle.high - lastCandle.low) || 0.00001;
    if (body / range < 0.45) return true;
  }
  return false;
}

export function recentCandleConsistency(candles, direction, lookback = 4) {
  if (!candles || candles.length < lookback + 1 || direction === 'NO_TRADE') return 1.0;
  const recent = candles.slice(-lookback);
  let aligned = 0;
  for (const c of recent) {
    const bullish = c.close > c.open;
    if (direction === 'BUY'  && bullish)  aligned++;
    if (direction === 'SELL' && !bullish) aligned++;
  }
  const ratio = aligned / lookback;
  if (ratio >= 0.75) return 1.0;
  if (ratio >= 0.5)  return 0.9;
  if (ratio >= 0.25) return 0.8;
  return 0.7;
}

export function generateEntryReason(direction, catScores, indicatorSummary, alignment, higherTFTrend, marketContext) {
  if (direction === 'NO_TRADE') return 'No clear setup — entry conditions not met.';
  const reasons = [];

  if (catScores.trend) {
    const tS = direction === 'BUY' ? catScores.trend.up : catScores.trend.down;
    if (tS >= 3.0)      reasons.push('Strong EMA stack aligned ' + direction);
    else if (tS >= 1.5) reasons.push('EMA trend favors ' + direction);
  }

  const rsiVal = parseFloat(indicatorSummary.rsi);
  if (!isNaN(rsiVal)) {
    if (direction === 'BUY'  && rsiVal <= 30) reasons.push('RSI oversold (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'BUY'  && rsiVal >= 55 && rsiVal < 70) reasons.push('RSI bullish momentum (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal >= 70) reasons.push('RSI overbought (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal <= 45 && rsiVal > 30) reasons.push('RSI bearish momentum (' + rsiVal.toFixed(0) + ')');
  }

  if (catScores.macd) {
    const mS = direction === 'BUY' ? catScores.macd.up : catScores.macd.down;
    if (mS >= 1.5) reasons.push(direction === 'BUY' ? 'MACD bullish crossover/expansion' : 'MACD bearish crossover/expansion');
  }

  if (catScores.adx) {
    const aS = direction === 'BUY' ? catScores.adx.up : catScores.adx.down;
    if (aS >= 1.5) {
      const adxNum = parseFloat(indicatorSummary.adx);
      if (!isNaN(adxNum) && adxNum >= 25) reasons.push('ADX trending (' + adxNum.toFixed(0) + ') with DI support');
      if (catScores.adx.diCross && catScores.adx.diCross !== 'NONE') reasons.push('DI crossover: ' + catScores.adx.diCross);
    }
  }

  if (catScores.stochastic) {
    const stS = direction === 'BUY' ? catScores.stochastic.up : catScores.stochastic.down;
    if (stS >= 0.8) reasons.push('Stochastic confirms ' + direction);
  }

  if (catScores.patterns && catScores.patterns.detected && catScores.patterns.detected.length > 0) {
    const pats = catScores.patterns.detected.filter(p => p !== 'DOJI');
    if (pats.length > 0) reasons.push('Pattern: ' + pats.join(', '));
  }

  if (catScores.divergence) {
    if (catScores.divergence.rsi  !== 'NONE') reasons.push('RSI divergence'  + (catScores.divergence.rsiConfirmed  ? ' (confirmed)' : ' (unconfirmed)'));
    if (catScores.divergence.macd !== 'NONE') reasons.push('MACD divergence' + (catScores.divergence.macdConfirmed ? ' (confirmed)' : ' (unconfirmed)'));
  }

  if (higherTFTrend && higherTFTrend === direction) reasons.push('15min HTF trend aligned');
  if (alignment === 'ALL_BULLISH'    || alignment === 'ALL_BEARISH')    reasons.push('All timeframes agree');
  else if (alignment === 'MOSTLY_BULLISH' || alignment === 'MOSTLY_BEARISH') reasons.push('Majority timeframes agree');
  if (marketContext === 'TRENDING') reasons.push('Trending market');
  else if (marketContext === 'RANGING') reasons.push('Range-bound market');

  return reasons.length === 0 ? direction + ' signal from weighted indicator confluence.' : reasons.join(' · ');
}

export function getCandleQualityMultiplier(candles) {
  if (!candles || candles.length < 3) return 1.0;
  const last  = candles[candles.length - 1];
  const prev1 = candles[candles.length - 2];

  function bodyRatio(c) {
    const body = Math.abs(c.close - c.open);
    return body / ((c.high - c.low) || 0.00001);
  }
  function wickRatio(c) {
    const range = (c.high - c.low) || 0.00001;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    return (upperWick + lowerWick) / range;
  }

  const br0 = bodyRatio(last); const br1 = bodyRatio(prev1); const wr0 = wickRatio(last);
  if (br0 >= 0.65 && br1 >= 0.55) return 1.15;
  if (br0 >= 0.55 && wr0 <= 0.35) return 1.08;
  if (br0 >= 0.40)  return 1.0;
  if (br0 < 0.15)   return 0.75;
  if (wr0 >= 0.70)  return 0.82;
  return 0.92;
}

export function getSessionWeightMultiplier(pair, session) {
  if (!pair || !session) return 1.0;
  const parts = pair.replace('-OTC', '').split('/');
  const base  = parts[0] || ''; const quote = parts[1] || '';
  const activeSession = session.overlap !== 'NONE' ? session.overlap : (session.sessions[0] || 'UNKNOWN');
  const baseWeights   = SESSION_PAIR_WEIGHTS[base]  || {};
  const quoteWeights  = SESSION_PAIR_WEIGHTS[quote] || {};
  const mult = Math.max(baseWeights[activeSession] || 1.0, quoteWeights[activeSession] || 1.0);
  return Math.max(0.7, Math.min(1.4, mult));
}

export function detectCorrelationConflicts(pairSignals) {
  const conflicts = []; const warnings = [];
  for (const group of CORRELATION_GROUPS) {
    const groupSigs = group.map(p => ({ pair: p, signal: pairSignals[p] })).filter(x => x.signal && x.signal !== 'NO_TRADE');
    if (groupSigs.length >= 2) {
      const buys  = groupSigs.filter(x => x.signal === 'BUY').map(x => x.pair);
      const sells = groupSigs.filter(x => x.signal === 'SELL').map(x => x.pair);
      if (buys.length > 0 && sells.length > 0)
        conflicts.push({ group, conflict: 'BUY vs SELL', buyPairs: buys, sellPairs: sells, warning: 'Correlated pairs conflict — reduce position' });
    }
  }
  for (const [p1, p2] of NEGATIVE_CORRELATIONS) {
    const s1 = pairSignals[p1]; const s2 = pairSignals[p2];
    if (s1 && s2 && s1 !== 'NO_TRADE' && s2 !== 'NO_TRADE' && s1 === s2)
      warnings.push({ pairs: [p1, p2], signal: s1, note: 'Negatively correlated — same direction is unusual' });
  }
  return { conflicts, warnings, hasConflict: conflicts.length > 0 };
}

/**
 * FX Mode — ATR-based SL/TP levels (Phase F FX-mode addition, 2026-08-04).
 *
 * The FTT (fixed-time) engine outputs direction + expiry. FX mode needs
 * stop-loss / take-profit instead. Levels are derived from ATR so they scale
 * with volatility:
 *   SL = entry ∓ (ATR × SL_ATR_MULT)        (opposite direction)
 *   TP = entry ± (ATR × SL_ATR_MULT × RR)   (same direction)
 * R:R configurable (default 1:2.5). Direction convention: BUY → SL below,
 * TP above; SELL → SL above, TP below.
 *
 * Honesty note: levels are volatility-scaled defaults, NOT a prediction of
 * profit. They only make sense combined with a real backtest/demo forward run.
 */
export const FX_RR_DEFAULT = 2.5;
export const FX_SL_ATR_MULT_DEFAULT = 1.0;

/**
 * Compute FX-mode SL/TP from an entry price + ATR.
 * Returns null if inputs invalid (caller then omits levels).
 */
export function computeFxLevels({ entry, atr, direction, rr = FX_RR_DEFAULT, slAtrMult = FX_SL_ATR_MULT_DEFAULT }) {
  if (entry === null || entry === undefined || !isFinite(entry)) return null;
  if (atr === null || atr === undefined || !isFinite(atr) || atr <= 0) return null;
  if (direction !== 'BUY' && direction !== 'SELL') return null;
  const stopDist = atr * slAtrMult;
  const tpDist   = stopDist * rr;
  let sl, tp;
  if (direction === 'BUY') {
    sl = entry - stopDist;
    tp = entry + tpDist;
  } else {
    sl = entry + stopDist;
    tp = entry - tpDist;
  }
  // round to sensible precision for forex (5th decimal) / crypto (4-6)
  const dec = Math.abs(entry) < 10 ? 5 : (Math.abs(entry) < 1000 ? 4 : 2);
  const round = (v) => Number(v.toFixed(dec));
  return {
    entry: round(entry),
    sl: round(sl),
    tp: round(tp),
    rr,
    slAtrMult,
    atr: Number(atr.toFixed(dec)),
  };
}

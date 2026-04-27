// ============================================================
// GENERAL HELPERS
// Signal grade, tie resolution, countdown, entry reason
// ============================================================
// ============================================
// SAFE VALUE HELPERS
// ============================================

function safeLastValue(arr) {
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return arr[i];
  }
  return null;
}

function safeLastTwo(arr) {
  if (!arr || arr.length === 0) return { last: null, prev: null };
  let last = null; let prev = null; let foundFirst = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
      if (!foundFirst) { last = arr[i]; foundFirst = true; }
      else { prev = arr[i]; break; }
    }
  }
  return { last: last, prev: prev };
}

function safeLastN(arr, n) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) result.unshift(arr[i]);
  }
  return result;
}

// ============================================
// HELPERS
// ============================================

function r2(v) { return Math.round(v * 100) / 100; }
function fmt(v, d) { if (!d) d = 5; return v !== null ? v.toFixed(d) : 'N/A'; }

function getNextCandleClose(now, candleMinutes) {
  const ms = candleMinutes * 60000;
  const currentSlot = Math.floor(now.getTime() / ms);
  return new Date((currentSlot + 1) * ms);
}

function formatDuration(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
}

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

// ============================================
// [v6.2] ENTRY REASON SUMMARY — plain text
// ============================================

function generateEntryReason(direction, catScores, indicatorSummary, alignment, higherTFTrend, marketContext) {
  if (direction === 'NO_TRADE') return 'No clear setup — entry conditions not met.';

  var reasons = [];

  // Trend
  if (catScores.trend) {
    var tS = direction === 'BUY' ? catScores.trend.up : catScores.trend.down;
    if (tS >= 3.0) reasons.push('Strong EMA stack aligned ' + direction);
    else if (tS >= 1.5) reasons.push('EMA trend favors ' + direction);
  }

  // RSI
  var rsiVal = parseFloat(indicatorSummary.rsi);
  if (!isNaN(rsiVal)) {
    if (direction === 'BUY' && rsiVal <= 30) reasons.push('RSI oversold (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'BUY' && rsiVal >= 55 && rsiVal < 70) reasons.push('RSI bullish momentum (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal >= 70) reasons.push('RSI overbought (' + rsiVal.toFixed(0) + ')');
    else if (direction === 'SELL' && rsiVal <= 45 && rsiVal > 30) reasons.push('RSI bearish momentum (' + rsiVal.toFixed(0) + ')');
  }

  // MACD
  if (catScores.macd) {
    var mS = direction === 'BUY' ? catScores.macd.up : catScores.macd.down;
    if (mS >= 1.5) reasons.push(direction === 'BUY' ? 'MACD bullish crossover/expansion' : 'MACD bearish crossover/expansion');
  }

  // ADX
  if (catScores.adx) {
    var aS = direction === 'BUY' ? catScores.adx.up : catScores.adx.down;
    if (aS >= 1.5) {
      var adxNum = parseFloat(indicatorSummary.adx);
      if (!isNaN(adxNum) && adxNum >= 25) reasons.push('ADX trending (' + adxNum.toFixed(0) + ') with DI support');
      if (catScores.adx.diCross && catScores.adx.diCross !== 'NONE') reasons.push('DI crossover: ' + catScores.adx.diCross);
    }
  }

  // Stochastic
  if (catScores.stochastic) {
    var stS = direction === 'BUY' ? catScores.stochastic.up : catScores.stochastic.down;
    if (stS >= 0.8) reasons.push('Stochastic confirms ' + direction);
  }

  // Patterns
  if (catScores.patterns && catScores.patterns.detected && catScores.patterns.detected.length > 0) {
    var pats = catScores.patterns.detected.filter(function (p) { return p !== 'DOJI'; });
    if (pats.length > 0) reasons.push('Pattern: ' + pats.join(', '));
  }

  // Divergence
  if (catScores.divergence) {
    if (catScores.divergence.rsi !== 'NONE') {
      reasons.push('RSI divergence' + (catScores.divergence.rsiConfirmed ? ' (confirmed)' : ' (unconfirmed)'));
    }
    if (catScores.divergence.macd !== 'NONE') {
      reasons.push('MACD divergence' + (catScores.divergence.macdConfirmed ? ' (confirmed)' : ' (unconfirmed)'));
    }
  }

  // Higher TF alignment
  if (higherTFTrend && higherTFTrend === direction) reasons.push('15min HTF trend aligned');

  // Overall alignment
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') {
    reasons.push('All timeframes agree');
  } else if (alignment === 'MOSTLY_BULLISH' || alignment === 'MOSTLY_BEARISH') {
    reasons.push('Majority timeframes agree');
  }

  // Market context
  if (marketContext === 'TRENDING') reasons.push('Trending market');
  else if (marketContext === 'RANGING') reasons.push('Range-bound market');

  if (reasons.length === 0) return direction + ' signal from weighted indicator confluence.';
  return reasons.join(' · ');
}

// ============================================
// [v6.2] CANDLE COUNTDOWN
// Returns seconds until the current candle closes + next candle close ISO string
// ============================================

function getCandleCountdown(candleMinutes) {
  var now = Date.now();
  var ms = candleMinutes * 60000;
  var nextCloseMs = Math.ceil(now / ms) * ms;
  var secondsLeft = Math.max(0, Math.round((nextCloseMs - now) / 1000));
  return {
    secondsLeft: secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    label: secondsLeft >= 60
      ? Math.floor(secondsLeft / 60) + 'm ' + (secondsLeft % 60) + 's'
      : secondsLeft + 's',
    nextCandleClose: new Date(nextCloseMs).toISOString(),
  };
}

export {
  safeLastValue, safeLastTwo, safeLastN,
  r2, fmt, getNextCandleClose, formatDuration, formatTimeUntil,
  getCandleCountdown, generateEntryReason, getSignalGrade, resolveTieWithTolerance,
  generateDummySignal,
};

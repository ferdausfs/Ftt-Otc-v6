import { EDGE_FEATURE_CONFIG } from '../config.js';

const DAY_NAMES = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function lastFinite(values) {
  if (!Array.isArray(values)) return finiteNumber(values);
  for (let i = values.length - 1; i >= 0; i--) {
    const value = finiteNumber(values[i]);
    if (value !== null) return value;
  }
  return null;
}

function validTail(values, limit, excludeLast = false) {
  if (!Array.isArray(values)) return [];
  const end = excludeLast ? values.length - 1 : values.length;
  const out = [];
  for (let i = end - 1; i >= 0 && out.length < limit; i--) {
    const value = finiteNumber(values[i]);
    if (value !== null) out.push(value);
  }
  return out.reverse();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Current ATR's percentile rank against its own preceding history. The current
 * value is deliberately excluded from the reference window.
 */
export function calculateAtrPercentileState(atrValues, config = EDGE_FEATURE_CONFIG.ATR_PERCENTILE) {
  const current = lastFinite(atrValues);
  const history = validTail(atrValues, config.lookback, true);
  if (current === null || history.length < config.minHistory) {
    return { percentile: null, state: 'UNKNOWN', current, historySize: history.length };
  }
  const lessOrEqual = history.filter(value => value <= current).length;
  const percentile = round((lessOrEqual / history.length) * 100, 1);
  let state = 'NORMAL';
  if (percentile <= config.squeezeMaxPercentile) state = 'SQUEEZE';
  else if (percentile >= config.expansionMinPercentile) state = 'EXPANSION';
  return { percentile, state, current: round(current, 8), historySize: history.length };
}

/**
 * BB bandwidth state relative to the median of its own preceding history.
 */
export function calculateBbVolatilityState(bandwidthValues, config = EDGE_FEATURE_CONFIG.BB_VOLATILITY) {
  const current = lastFinite(bandwidthValues);
  const history = validTail(bandwidthValues, config.normLookback, true);
  const norm = history.length >= config.minHistory ? median(history) : null;
  if (current === null || norm === null || norm <= 0) {
    return { ratio: null, state: 'UNKNOWN', current, norm, historySize: history.length };
  }
  const ratio = current / norm;
  let state = 'WIDE_NORMAL';
  if (ratio < config.deadRatioBelow) state = 'DEAD_SQUEEZE';
  else if (ratio < config.midSqueezeRatioBelow) state = 'MID_SQUEEZE';
  return {
    ratio: round(ratio, 3), state,
    current: round(current, 6), norm: round(norm, 6), historySize: history.length,
  };
}

export function findDirectionalBestTimeframe(tfResults, direction) {
  let best = null;
  let bestConfluence = -Infinity;
  let bestScore = -Infinity;
  for (const [tf, result] of Object.entries(tfResults || {})) {
    if (!result || result.direction !== direction) continue;
    // Match engine.findBestTimeframe(): HTF alignment adds one effective
    // confluence point before score breaks a tie.
    const confluence = (finiteNumber(result.confluence) || 0)
      + (result.alignedWithHTF ? 1 : 0);
    const score = direction === 'BUY'
      ? finiteNumber(result.score && result.score.up)
      : finiteNumber(result.score && result.score.down);
    if (confluence > bestConfluence || (confluence === bestConfluence && (score || 0) > bestScore)) {
      best = tf; bestConfluence = confluence; bestScore = score || 0;
    }
  }
  if (best) return best;

  // A tie-resolved engine direction may have no identically-directed TF. In
  // that case use the strongest score in that direction, matching the engine's
  // best-timeframe fallback semantics.
  for (const [tf, result] of Object.entries(tfResults || {})) {
    if (!result) continue;
    const score = direction === 'BUY'
      ? finiteNumber(result.score && result.score.up)
      : finiteNumber(result.score && result.score.down);
    if (score !== null && score > bestScore) { best = tf; bestScore = score; }
  }
  return best;
}

function parseCandleTimestamp(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : text + 'Z';
  const stamp = new Date(zoned);
  return Number.isFinite(stamp.getTime()) ? stamp : null;
}

/** Price position in the current UTC day's high/low from 15-minute candles. */
export function calculateSessionRangePosition(candleData, direction, now, config = EDGE_FEATURE_CONFIG.SESSION_RANGE) {
  const clock = now ? new Date(now) : null;
  if (!clock || !Number.isFinite(clock.getTime())) {
    return { state: 'UNKNOWN', position: null, high: null, low: null, candles: 0, meanReversionAligned: false };
  }
  const sourceTf = config.sourceTimeframe;
  const candles = (candleData && candleData[sourceTf]) || [];
  const utcDay = clock.toISOString().slice(0, 10);
  const today = candles.filter(candle => {
    const stamp = parseCandleTimestamp(candle && candle.datetime);
    return stamp && stamp.toISOString().slice(0, 10) === utcDay;
  });
  if (today.length < config.minCandles) {
    return { state: 'INSUFFICIENT_DATA', position: null, high: null, low: null, candles: today.length, meanReversionAligned: false };
  }
  const high = Math.max(...today.map(candle => finiteNumber(candle.high)).filter(value => value !== null));
  const low = Math.min(...today.map(candle => finiteNumber(candle.low)).filter(value => value !== null));
  const fresh = (candleData && (candleData['1min'] || candleData['5min'] || candleData['15min'])) || [];
  const price = fresh.length ? finiteNumber(fresh[fresh.length - 1].close) : null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || price === null || high <= low) {
    return { state: 'UNKNOWN', position: null, high: null, low: null, candles: today.length, meanReversionAligned: false };
  }
  const position = clamp((price - low) / (high - low), 0, 1);
  const state = position <= config.nearLowMaxPosition
    ? 'NEAR_LOW'
    : position >= config.nearHighMinPosition ? 'NEAR_HIGH' : 'MID_RANGE';
  const meanReversionAligned =
    (state === 'NEAR_LOW' && direction === 'BUY') ||
    (state === 'NEAR_HIGH' && direction === 'SELL');
  return {
    state, position: round(position, 3), high: round(high, 8), low: round(low, 8),
    price: round(price, 8), candles: today.length, meanReversionAligned,
  };
}

function activeSessionName(session) {
  if (!session) return 'UNKNOWN';
  if (session.overlap && session.overlap !== 'NONE') return session.overlap;
  return Array.isArray(session.sessions) && session.sessions.length ? session.sessions[0] : 'UNKNOWN';
}

function adaptiveMultiplier(map, key) {
  if (!map || !key) return 1;
  const value = finiteNumber(map[key]);
  return value === null ? 1 : clamp(
    value,
    EDGE_FEATURE_CONFIG.ADAPTIVE.minMultiplier,
    EDGE_FEATURE_CONFIG.ADAPTIVE.maxMultiplier,
  );
}

/**
 * Evaluate and apply all input-side edge factors. It is pure: history/adaptive
 * KV reads happen in the caller and are supplied as snapshots.
 */
export function evaluateEdgeFeatures({
  direction, confidence, pair, assetType, tfResults = {}, indicatorCache = {},
  candleData = {}, now = null, session = null, recentForm = null,
  adaptiveSnapshot = null,
}) {
  const cfg = EDGE_FEATURE_CONFIG;
  let finalDirection = direction;
  let adjustedConfidence = finiteNumber(confidence) || 0;
  let hardBlocked = false;
  let hardBlockReason = null;
  const filtersApplied = [];

  const clock = now ? new Date(now) : null;
  const validClock = clock && Number.isFinite(clock.getTime());
  const hour = validClock ? clock.getUTCHours() : null;
  const dayOfWeek = validClock ? clock.getUTCDay() : null;
  const dynamicHours = adaptiveSnapshot && adaptiveSnapshot.status === 'ACTIVE'
    ? adaptiveSnapshot.hourMultipliers : null;
  const configuredHourMultiplier = hour === null ? 1
    : finiteNumber((dynamicHours || cfg.HOUR.multipliers)[hour]);
  const hourMultiplier = clamp(
    configuredHourMultiplier === null ? 1 : configuredHourMultiplier,
    cfg.HOUR.minMultiplier,
    cfg.HOUR.maxMultiplier,
  );

  const bestTF = findDirectionalBestTimeframe(tfResults, direction);
  const bestResult = bestTF ? tfResults[bestTF] : null;
  const bestIndicators = bestResult && bestResult.indicators;
  const rsi = finiteNumber(bestIndicators && bestIndicators.rsi);
  const rawIndicators = bestTF ? indicatorCache[bestTF] : null;
  const bb = calculateBbVolatilityState(rawIndicators && rawIndicators.bollinger
    ? rawIndicators.bollinger.bandwidth : null);
  const atr = calculateAtrPercentileState(rawIndicators ? rawIndicators.atr : null);
  const sessionRange = calculateSessionRangePosition(candleData, direction, clock, cfg.SESSION_RANGE);
  const sessionName = activeSessionName(session);

  const pairMultiplier = cfg.ADAPTIVE.applyPairSessionWeights
    ? adaptiveMultiplier(adaptiveSnapshot && adaptiveSnapshot.pairMultipliers, pair) : 1;
  const adaptiveSessionMultiplier = cfg.ADAPTIVE.applyPairSessionWeights
    ? adaptiveMultiplier(adaptiveSnapshot && adaptiveSnapshot.sessionMultipliers, sessionName) : 1;
  // Cap the COMBINED adaptive adjustment too; two individually safe x0.85
  // factors must not accidentally become an unreviewed x0.72 penalty.
  const adaptiveWeightMultiplier = clamp(
    pairMultiplier * adaptiveSessionMultiplier,
    cfg.ADAPTIVE.minMultiplier,
    cfg.ADAPTIVE.maxMultiplier,
  );

  const context = {
    version: cfg.VERSION,
    time: {
      timezone: cfg.HOUR.timezone,
      utcHour: hour,
      dayOfWeek,
      dayName: dayOfWeek === null ? null : DAY_NAMES[dayOfWeek],
      hourMultiplier: round(hourMultiplier, 3),
    },
    bestTimeframe: bestTF,
    rsiDirection: {
      rsi: rsi === null ? null : round(rsi, 2),
      direction,
      state: rsi === null ? 'UNKNOWN'
        : direction === 'BUY' && rsi > cfg.RSI_DIRECTION.buyBlockAbove ? 'OVERBOUGHT_BUY'
        : direction === 'SELL' && rsi < cfg.RSI_DIRECTION.sellBlockBelow ? 'OVERSOLD_SELL'
        : 'ALLOWED',
    },
    volatility: bb,
    atrPercentile: atr,
    sessionRange,
    recentForm: recentForm ? {
      winRate: finiteNumber(recentForm.winRate),
      sampleSize: finiteNumber(recentForm.sampleSize),
      lookback: cfg.RECENT_FORM.lookback,
    } : null,
    adaptive: {
      version: adaptiveSnapshot && adaptiveSnapshot.status === 'ACTIVE' ? adaptiveSnapshot.version : null,
      pairMultiplier: round(pairMultiplier, 3),
      session: sessionName,
      sessionMultiplier: round(adaptiveSessionMultiplier, 3),
      combinedMultiplier: round(adaptiveWeightMultiplier, 3),
    },
  };

  const isCandidate = finalDirection === 'BUY' || finalDirection === 'SELL';
  if (isCandidate && cfg.HOUR.enabled && hour !== null && hourMultiplier !== 1) {
    adjustedConfidence = Math.round(adjustedConfidence * hourMultiplier);
    filtersApplied.push('HOUR_UTC_' + String(hour).padStart(2, '0') + ' x' + hourMultiplier.toFixed(2));
  }

  if (isCandidate && adaptiveWeightMultiplier !== 1) {
    adjustedConfidence = Math.round(adjustedConfidence * adaptiveWeightMultiplier);
    filtersApplied.push('ADAPTIVE_PAIR_SESSION x' + adaptiveWeightMultiplier.toFixed(2)
      + ' (pair=' + pairMultiplier.toFixed(2) + ',session=' + adaptiveSessionMultiplier.toFixed(2) + ')');
  }

  if (isCandidate && cfg.SESSION_RANGE.enabled && sessionRange.meanReversionAligned) {
    adjustedConfidence = Math.round(adjustedConfidence * cfg.SESSION_RANGE.meanReversionMultiplier);
    filtersApplied.push('SESSION_RANGE_' + sessionRange.state + '_MEAN_REVERSION x'
      + cfg.SESSION_RANGE.meanReversionMultiplier.toFixed(2));
  }

  if (isCandidate && cfg.RSI_DIRECTION.enabled && rsi !== null && (
    (finalDirection === 'BUY' && rsi > cfg.RSI_DIRECTION.buyBlockAbove) ||
    (finalDirection === 'SELL' && rsi < cfg.RSI_DIRECTION.sellBlockBelow)
  )) {
    hardBlocked = true;
    hardBlockReason = finalDirection === 'BUY' ? 'RSI_OVERBOUGHT_BUY' : 'RSI_OVERSOLD_SELL';
    filtersApplied.push(hardBlockReason + ' (RSI=' + rsi.toFixed(2) + ')');
    finalDirection = 'NO_TRADE';
    adjustedConfidence = 0;
  }

  if (!hardBlocked && isCandidate && cfg.BB_VOLATILITY.enabled) {
    if (bb.state === 'DEAD_SQUEEZE' && cfg.BB_VOLATILITY.deadSqueezeBlock) {
      hardBlocked = true;
      hardBlockReason = 'BB_DEAD_SQUEEZE';
      filtersApplied.push('BB_DEAD_SQUEEZE_BLOCK (ratio=' + bb.ratio + ')');
      finalDirection = 'NO_TRADE';
      adjustedConfidence = 0;
    } else if (bb.state === 'MID_SQUEEZE') {
      adjustedConfidence = Math.round(adjustedConfidence * cfg.BB_VOLATILITY.midSqueezeMultiplier);
      filtersApplied.push('BB_MID_SQUEEZE x' + cfg.BB_VOLATILITY.midSqueezeMultiplier.toFixed(2)
        + ' (ratio=' + bb.ratio + ')');
    }
  }

  if (!hardBlocked && isCandidate && cfg.ATR_PERCENTILE.enabled && atr.state === 'SQUEEZE') {
    adjustedConfidence = Math.round(adjustedConfidence * cfg.ATR_PERCENTILE.squeezeMultiplier);
    filtersApplied.push('ATR_PERCENTILE_SQUEEZE x' + cfg.ATR_PERCENTILE.squeezeMultiplier.toFixed(2));
  }

  const formWr = recentForm && finiteNumber(recentForm.winRate);
  const formN = recentForm && finiteNumber(recentForm.sampleSize);
  if (!hardBlocked && isCandidate && cfg.RECENT_FORM.enabled && formWr !== null && formN !== null
      && formN >= cfg.RECENT_FORM.minSamples && formWr < cfg.RECENT_FORM.blockBelowWinRate) {
    adjustedConfidence = Math.round(adjustedConfidence * cfg.RECENT_FORM.confidenceMultiplier);
    filtersApplied.push('RECENT_FORM_' + Math.round(formWr * 100) + 'PCT x'
      + cfg.RECENT_FORM.confidenceMultiplier.toFixed(2) + ' (n=' + formN + ')');
  }

  adjustedConfidence = clamp(adjustedConfidence, 0, cfg.CONFIDENCE_CAP);
  context.appliedConfidence = adjustedConfidence;
  context.hardBlocked = hardBlocked;
  context.hardBlockReason = hardBlockReason;

  return {
    finalDirection,
    confidence: adjustedConfidence,
    hardBlocked,
    hardBlockReason,
    filtersApplied,
    context,
  };
}

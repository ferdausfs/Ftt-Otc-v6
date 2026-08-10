import { EDGE_FEATURE_CONFIG } from '../config.js';

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function validValues(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) result.push(number);
  }
  return result;
}

function median(values) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function round(value, places = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

/**
 * Current Bollinger bandwidth relative to its own trailing median.
 * The current observation is excluded from the reference window, avoiding a
 * look-ahead/self-normalisation leak.  No reference means UNKNOWN, never an
 * invented asset-specific fallback.
 */
export function calculateVolatilityState(
  bandwidthValues,
  config = EDGE_FEATURE_CONFIG.VOLATILITY_STATE,
) {
  const values = validValues(bandwidthValues);
  if (!values.length) {
    return { state: 'UNKNOWN', bandwidth: null, normalBandwidth: null, ratio: null, sampleSize: 0 };
  }

  const current = values[values.length - 1];
  const history = values.slice(0, -1).slice(-config.normalizationLookback);
  if (history.length < config.minHistory) {
    return {
      state: 'UNKNOWN', bandwidth: round(current), normalBandwidth: null,
      ratio: null, sampleSize: history.length,
    };
  }

  const normal = median(history);
  if (normal === null || normal <= 0) {
    return {
      state: 'UNKNOWN', bandwidth: round(current), normalBandwidth: round(normal),
      ratio: null, sampleSize: history.length,
    };
  }

  const ratio = current / normal;
  let state = 'WIDE';
  if (ratio < config.deadRatioMax) state = 'DEAD_SQUEEZE';
  else if (ratio < config.midRatioMax) state = 'MID_SQUEEZE';

  return {
    state,
    bandwidth: round(current),
    normalBandwidth: round(normal),
    ratio: round(ratio),
    sampleSize: history.length,
  };
}

/**
 * Percentile rank of current ATR versus its own prior 20–50 valid readings.
 * Equal values count as half a rank, which keeps a flat series at percentile
 * 0.5 rather than falsely classifying it as expansion.
 */
export function calculateAtrPercentile(
  atrValues,
  config = EDGE_FEATURE_CONFIG.ATR_PERCENTILE,
) {
  const values = validValues(atrValues);
  if (!values.length) {
    return { state: 'UNKNOWN', percentile: null, atr: null, sampleSize: 0 };
  }

  const current = values[values.length - 1];
  const history = values.slice(0, -1).slice(-config.historyLookback);
  if (history.length < config.minHistory) {
    return { state: 'UNKNOWN', percentile: null, atr: round(current, 6), sampleSize: history.length };
  }

  let below = 0;
  let equal = 0;
  for (const value of history) {
    if (value < current) below++;
    else if (value === current) equal++;
  }
  const percentile = (below + equal * 0.5) / history.length;
  let state = 'NORMAL';
  if (percentile <= config.deadMaxPercentile) state = 'DEAD';
  else if (percentile <= config.lowMaxPercentile) state = 'SQUEEZE';
  else if (percentile >= config.expansionMinPercentile) state = 'EXPANSION';

  return {
    state,
    percentile: round(percentile),
    atr: round(current, 6),
    sampleSize: history.length,
  };
}

function candleTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  let text = value.trim();
  // TwelveData returns `YYYY-MM-DD HH:mm:ss` in UTC (fetchers explicitly ask
  // for timezone=UTC).  Add Z only when the source supplied no zone.
  text = text.includes('T') ? text : text.replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z';
  return new Date(text).getTime();
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Price position in the current UTC session range.  The 15-minute array is
 * preferred because 100 candles cover approximately one day; shorter TFs are
 * used only when it is absent.  This is request-local and requires no KV write.
 */
export function calculateSessionRangePosition(
  candleData,
  now = new Date(),
  config = EDGE_FEATURE_CONFIG.SESSION_RANGE,
) {
  const target = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(target.getTime())) {
    return { state: 'UNKNOWN', position: null, high: null, low: null, price: null, sampleSize: 0 };
  }
  const preferred = config.preferredTimeframe;
  const candles = (candleData && candleData[preferred])
    || (candleData && candleData['5min'])
    || (candleData && candleData['1min'])
    || [];
  const day = utcDateKey(target);
  const today = candles.filter((candle) => {
    const stamp = candleTimestamp(candle && candle.datetime);
    return Number.isFinite(stamp) && utcDateKey(new Date(stamp)) === day;
  });
  if (!today.length) {
    return { state: 'UNKNOWN', position: null, high: null, low: null, price: null, sampleSize: 0 };
  }

  let high = -Infinity;
  let low = Infinity;
  for (const candle of today) {
    const candleHigh = finiteNumber(candle.high);
    const candleLow = finiteNumber(candle.low);
    if (candleHigh !== null && candleHigh > high) high = candleHigh;
    if (candleLow !== null && candleLow < low) low = candleLow;
  }
  const freshest = (candleData && candleData['1min'] && candleData['1min'].length
    ? candleData['1min'][candleData['1min'].length - 1]
    : today[today.length - 1]);
  const price = finiteNumber(freshest && freshest.close);
  if (!Number.isFinite(high) || !Number.isFinite(low) || price === null || high <= low) {
    return {
      state: 'UNKNOWN', position: null,
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      price, sampleSize: today.length,
    };
  }

  const position = Math.max(0, Math.min(1, (price - low) / (high - low)));
  let state = 'MID_RANGE';
  if (position <= config.lowExtremeMax) state = 'LOW_EXTREME';
  else if (position >= config.highExtremeMin) state = 'HIGH_EXTREME';
  return {
    state, position: round(position), high: round(high, 6), low: round(low, 6),
    price: round(price, 6), sampleSize: today.length,
  };
}

/** Select the same kind of strongest direction-matching TF used by the engine. */
export function selectDirectionIndicatorContext(tfResults, direction) {
  if (!tfResults || (direction !== 'BUY' && direction !== 'SELL')) return null;
  let selected = null;
  let bestConfluence = -Infinity;
  let bestScore = -Infinity;
  for (const [timeframe, result] of Object.entries(tfResults)) {
    if (!result || result.direction !== direction) continue;
    const confluence = (result.confluence || 0) + (result.alignedWithHTF ? 1 : 0);
    const score = result.score && finiteNumber(direction === 'BUY' ? result.score.up : result.score.down);
    const scoreValue = score === null ? 0 : score;
    if (confluence > bestConfluence || (confluence === bestConfluence && scoreValue > bestScore)) {
      selected = { timeframe, result };
      bestConfluence = confluence;
      bestScore = scoreValue;
    }
  }
  if (!selected) return null;
  const indicators = selected.result.indicators || {};
  return {
    timeframe: selected.timeframe,
    rsi: finiteNumber(indicators.rsi),
    bbBandwidth: finiteNumber(indicators.bbBandwidth),
    bbBandwidthRatio: finiteNumber(indicators.bbBandwidthRatio),
    volatilityState: indicators.volatilityState || 'UNKNOWN',
    atrPercentile: finiteNumber(indicators.atrPercentile),
    atrState: indicators.atrState || 'UNKNOWN',
  };
}

export function getHourMultiplier(now, adaptiveProfile = null) {
  const config = EDGE_FEATURE_CONFIG.HOUR_OF_DAY;
  const date = now instanceof Date ? now : new Date(now);
  const hour = Number.isFinite(date.getTime()) ? date.getUTCHours() : 0;
  const adaptiveValue = adaptiveProfile && adaptiveProfile.weights && adaptiveProfile.weights.hour
    ? adaptiveProfile.weights.hour[String(hour)] ?? adaptiveProfile.weights.hour[hour]
    : null;
  const adaptive = finiteNumber(adaptiveValue);
  const configured = finiteNumber(config.multipliers[hour]);
  const raw = adaptive !== null ? adaptive : (configured === null ? 1 : configured);
  const multiplier = Math.max(config.minMultiplier, Math.min(config.maxMultiplier, raw));
  return {
    hourUtc: hour,
    dayOfWeekUtc: Number.isFinite(date.getTime()) ? date.getUTCDay() : null,
    multiplier: round(multiplier, 3),
    source: adaptive !== null ? 'ADAPTIVE_14D' : 'CONFIG_TRAIN',
  };
}

export const __edgeFeatureTest = { finiteNumber, median, candleTimestamp };

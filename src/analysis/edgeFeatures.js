import { CONFIG, HISTORY_CONFIG } from '../config.js';
import { safeLastValue } from '../utils/helpers.js';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const median = values => {
  const a = values.filter(finite).slice().sort((a, b) => a - b);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/** Pure, fail-open input-side feature evaluation. Values are deliberately
 * returned in the response/audit so feature-validation can use signal-time
 * context without reconstructing indicators. */
export function evaluateEdgeFeatures({ direction, indicators, candles, now = new Date(), hourMultipliers = null }) {
  const c = CONFIG.EDGE_FEATURES;
  const result = {
    hourUTC: now.getUTCHours(), hourMultiplier: 1, rsi: null, rsiDirectionBlocked: false,
    bbBandwidth: null, bbBandwidthRatio: null, volatilityState: 'UNKNOWN', volatilityMultiplier: 1,
    atrPercentile: null, atrState: 'UNKNOWN', atrMultiplier: 1,
    sessionRangePosition: null, sessionRangeMultiplier: 1, sessionRangeSource: 'UNAVAILABLE',
  };
  if (!c.enabled || direction === 'NO_TRADE') return result;

  result.hourMultiplier = Math.max(c.hourMinMultiplier, Math.min(c.hourMaxMultiplier,
    (hourMultipliers && hourMultipliers[result.hourUTC]) ?? c.hourMultipliers[result.hourUTC] ?? 1));
  const rsi = safeLastValue(indicators && indicators.rsi);
  result.rsi = finite(rsi) ? rsi : null;
  result.rsiDirectionBlocked = (direction === 'BUY' && finite(rsi) && rsi > c.rsiBuyBlockAbove)
    || (direction === 'SELL' && finite(rsi) && rsi < c.rsiSellBlockBelow);

  const bandwidth = safeLastValue(indicators && indicators.bollinger && indicators.bollinger.bandwidth);
  const bwHistory = (indicators && indicators.bollinger && indicators.bollinger.bandwidth) || [];
  const bwNorm = median(bwHistory.slice(-c.atrHistoryPeriods));
  result.bbBandwidth = finite(bandwidth) ? bandwidth : null;
  result.bbBandwidthRatio = finite(bandwidth) && finite(bwNorm) && bwNorm > 0 ? bandwidth / bwNorm : null;
  if (finite(result.bbBandwidthRatio)) {
    if (result.bbBandwidthRatio < c.bbDeadRatioBelow) result.volatilityState = 'DEAD_SQUEEZE';
    else if (result.bbBandwidthRatio >= c.bbMidRatioMin && result.bbBandwidthRatio <= c.bbMidRatioMax) {
      result.volatilityState = 'MID_SQUEEZE'; result.volatilityMultiplier = c.bbMidMultiplier;
    } else result.volatilityState = 'NORMAL_OR_WIDE';
  }

  const atr = (indicators && indicators.atr) || [];
  const currentAtr = safeLastValue(atr);
  const hist = atr.slice(-c.atrHistoryPeriods).filter(finite);
  if (finite(currentAtr) && hist.length >= 5) {
    result.atrPercentile = hist.filter(x => x <= currentAtr).length / hist.length;
    if (result.atrPercentile <= c.atrLowPercentile) { result.atrState = 'LOW_SQUEEZE'; result.atrMultiplier = c.atrLowMultiplier; }
    else if (result.atrPercentile >= c.atrHighPercentile) result.atrState = 'HIGH_EXPANSION';
    else result.atrState = 'NORMAL';
  }

  // Only use candles stamped today UTC. A short fetch window is honestly marked
  // as AVAILABLE_CANDLES; no synthetic "daily" high/low is invented.
  const today = now.toISOString().slice(0, 10);
  const day = (candles || []).filter(x => x && String(x.datetime || '').slice(0, 10) === today && finite(x.high) && finite(x.low));
  const close = candles && candles.length ? candles[candles.length - 1].close : null;
  if (day.length >= 2 && finite(close)) {
    const high = Math.max(...day.map(x => x.high)); const low = Math.min(...day.map(x => x.low));
    if (high > low) {
      result.sessionRangePosition = (close - low) / (high - low);
      result.sessionRangeSource = 'AVAILABLE_CANDLES';
      if (result.sessionRangePosition <= c.sessionRangeExtremePct || result.sessionRangePosition >= 1 - c.sessionRangeExtremePct)
        result.sessionRangeMultiplier = c.sessionRangeExtremeMultiplier;
    }
  }
  return result;
}

export async function getRecentFormMultiplier(pair, env) {
  const c = CONFIG.EDGE_FEATURES;
  const neutral = { recentFormWR: null, recentFormSample: 0, recentFormMultiplier: 1 };
  if (!env || !env.SIGNAL_CACHE || !c.enabled) return neutral;
  try {
    const key = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    const stats = await env.SIGNAL_CACHE.get(key, 'json');
    const sample = Array.isArray(stats && stats.recentResults) ? stats.recentResults.length : (stats && stats.sampleSize) || 0;
    const wr = stats && typeof stats.winRate === 'number' ? stats.winRate : null;
    if (sample >= c.recentFormMinTrades && finite(wr) && wr < c.recentFormBadWR)
      return { recentFormWR: wr, recentFormSample: sample, recentFormMultiplier: c.recentFormMultiplier };
    return { recentFormWR: wr, recentFormSample: sample, recentFormMultiplier: 1 };
  } catch (_) { return neutral; }
}

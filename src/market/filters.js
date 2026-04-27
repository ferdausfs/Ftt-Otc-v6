// ============================================================
// MARKET QUALITY FILTERS
// News blackout, volume spike anomaly, candle consistency
// ============================================================
import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC, HIGH_IMPACT_NEWS_WINDOWS } from '../config/trading.js';

// ============================================
// [v6.2] NEWS BLACKOUT DETECTION
// Returns null if safe, or { label, minutesUntilClear } if blocked
// Only applies to FOREX — crypto trades 24/7 with no scheduled events
// ============================================

function checkNewsBlackout(assetType) {
  // OTC and Crypto trade 24/7 — no news blackout applies
  if (assetType === ASSET_TYPE.CRYPTO) return null;
  if (assetType === ASSET_TYPE_OTC)    return null;

  const now = new Date();
  const day = now.getUTCDay();       // 0=Sun, 1=Mon … 6=Sat
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const nowTotalMin = hour * 60 + minute;
  const margin = CONFIG.NEWS_BLACKOUT_MINUTES;

  for (const win of HIGH_IMPACT_NEWS_WINDOWS) {
    if (!win.days.includes(day)) continue;

    const winStart = Math.max(0, win.startHour * 60 + win.startMin - margin);
    const winEnd   = Math.min(1439, win.endHour * 60 + win.endMin + margin);

    if (nowTotalMin >= winStart && nowTotalMin <= winEnd) {
      const clearMin = winEnd - nowTotalMin;
      return {
        blocked: true,
        label: win.label,
        minutesUntilClear: clearMin,
        message: 'Signal blocked: ' + win.label + '. Clears in ~' + clearMin + ' min.',
      };
    }
  }
  return null;
}

// ============================================
// [v6.2] VOLUME SPIKE ANOMALY FILTER
// Detects abnormal volume spike without strong candle body (stop hunt / news spike)
// Only reliable for CRYPTO — skipped for FOREX
// ============================================

function isVolumeSpikeAnomaly(candles, assetType) {
  // Only meaningful for Crypto — Forex volume unreliable, OTC volume meaningless
  if (assetType !== ASSET_TYPE.CRYPTO) return false;
  if (!candles || candles.length < 21) return false;

  const lastCandle = candles[candles.length - 1];
  const sample = candles.slice(-21, -1);
  const avgVol = sample.reduce(function (a, c) { return a + c.volume; }, 0) / sample.length;

  if (avgVol <= 0) return false;

  const ratio = lastCandle.volume / avgVol;
  if (ratio > CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER) {
    const body  = Math.abs(lastCandle.close - lastCandle.open);
    const range = (lastCandle.high - lastCandle.low) || 0.00001;
    const bodyRatio = body / range;
    // Spike with weak body → anomalous (wick candle = stop hunt / liquidity grab)
    if (bodyRatio < 0.45) return true;
  }
  return false;
}

// ============================================
// [v6.2] RECENT CANDLE CONSISTENCY CHECK
// Checks if the last N candles are consistent with the proposed direction.
// Returns a multiplier: 1.0 (consistent) → 0.7 (inconsistent)
// ============================================

function recentCandleConsistency(candles, direction, lookback) {
  if (!lookback) lookback = 4;
  if (!candles || candles.length < lookback + 1 || direction === 'NO_TRADE') return 1.0;

  const recent = candles.slice(-lookback);
  let aligned = 0;
  for (var i = 0; i < recent.length; i++) {
    var c = recent[i];
    var bullish = c.close > c.open;
    if (direction === 'BUY' && bullish)  aligned++;
    if (direction === 'SELL' && !bullish) aligned++;
  }
  var ratio = aligned / lookback;
  if (ratio >= 0.75) return 1.0;
  if (ratio >= 0.5)  return 0.9;
  if (ratio >= 0.25) return 0.8;
  return 0.7;
}

export { checkNewsBlackout, isVolumeSpikeAnomaly, recentCandleConsistency };

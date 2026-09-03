/**
 * SELECTIVITY GATE (2026-08-21) — quality-over-quantity push filter.
 *
 * Evidence-backed (Phase F forward data, ~6.3k decided signals):
 *   fillStatus PENDING_ENTRY (entryDist >= 0.05%): 57.9% WR (n=178)  vs INSTANT 46.9%
 *   ATR percentile < 50 (calm market):              53.6% WR (n=289)
 *   FOREX (any):                                    34.0% WR (n=949)  vs CRYPTO 45.2%
 *   marketRegime TRENDING:                          38.8% WR (n=798)
 *
 * The gate ONLY controls the Telegram push. History (saveSignalToHistory)
 * still records every signal, so the Phase F forward window stays complete
 * and the gate's own effect can be measured. /api/signal and /api/latest
 * responses are unchanged — only subscribers get filtered.
 *
 * Fail-open: if a feature is missing (e.g. entryDistancePct absent because
 * the fill-status block failed), the gate does NOT block on that rule — it
 * only blocks on data it can actually see.
 */
import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../config.js';

/**
 * @param {object} signal  the full signal object from buildMultiTimeframeSignal
 * @param {string} pair    sanitized pair (e.g. "BTC/USD")
 * @param {string} assetType ASSET_TYPE.CRYPTO | ASSET_TYPE.FOREX | ASSET_TYPE_OTC
 * @returns {{blocked: boolean, reason: string, rules: string[]}}
 */
export function evaluateSelectivityGate(signal, pair, assetType) {
  const g = CONFIG.SELECTIVITY_GATE;
  if (!g || !g.enabled) return { blocked: false, reason: 'gate-disabled', rules: [] };
  if (assetType === ASSET_TYPE_OTC) return { blocked: false, reason: 'otc-exempt', rules: [] };

  const rules = [];

  // 1) Crypto only — forex is a systemic 34% drag.
  if (g.cryptoOnly && assetType === ASSET_TYPE.FOREX) {
    return { blocked: true, reason: 'forex-suppressed (cryptoOnly)', rules: ['cryptoOnly'] };
  }

  // 2) Skip TRENDING regime (35.4% WR n=325 over the 4-day shadow pool).
  //    Belt-and-braces: the D2 block already suppresses most of these pre-AI;
  //    this catches any that slip through.
  if (g.excludeTrending && signal && signal.marketRegime === 'TRENDING') {
    return { blocked: true, reason: 'trending-suppressed', rules: ['excludeTrending'] };
  }

  // 2b) EXCLUDE CHASE (v6.14.0, 2026-09-03) — BUY with rsi>55 / SELL with
  //     rsi<45. The 4-day forward pool: CHASE entries are 73% of push volume
  //     at 37.2% WR; non-CHASE measured 52.3% (n=44). Thresholds mirror
  //     RSI_DIRECTION_GATE (buyMaxRsi 55 / sellMinRsi 45) and the EC rsiCell
  //     so every layer classifies identically. Reads signal.edgeFeatures.rsi
  //     (the same number EC-V2 cells on); missing rsi → fail-open.
  if (g.excludeChase && signal) {
    const ef = signal.edgeFeatures || {};
    const rsi = (typeof ef.rsi === 'number') ? ef.rsi : parseFloat(ef.rsi);
    if (typeof rsi === 'number' && isFinite(rsi)) {
      const dir = signal.direction;
      if ((dir === 'BUY' && rsi > 55) || (dir === 'SELL' && rsi < 45)) {
        return { blocked: true, reason: 'rsi-chase-suppressed (rsi=' + rsi + ' ' + dir + ')', rules: ['excludeChase'] };
      }
    }
  }

  // 3) Require a wait-for-pullback entry (entryDist >= threshold). Instant
  //    chase entries win materially less.
  if (g.requirePendingEntry && signal) {
    const d = signal.entryDistancePct;
    const minDist = (typeof g.pendingEntryMinDistancePct === 'number')
      ? g.pendingEntryMinDistancePct : 0.05;
    if (typeof d === 'number' && d < minDist) {
      return { blocked: true, reason: 'instant-entry-suppressed (dist=' + d + '%)', rules: ['requirePendingEntry'] };
    }
    // d undefined → fail-open (feature missing; see header comment)
  }

  // 4) Calm-market only: skip when ATR percentile >= cap (high vol).
  if (typeof g.maxAtrPercentile === 'number' && signal) {
    const si = signal.signalIndicators || {};
    const ap = si.atrPercentile;
    if (typeof ap === 'number' && ap >= g.maxAtrPercentile) {
      return { blocked: true, reason: 'high-vol-suppressed (atrPctile=' + ap + ')', rules: ['maxAtrPercentile'] };
    }
    // ap undefined → fail-open
  }

  return { blocked: false, reason: 'pass', rules };
}

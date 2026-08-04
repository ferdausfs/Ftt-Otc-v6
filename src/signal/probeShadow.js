/**
 * Forex SELL Probe — private transport for the forward-evidence collector.
 *
 * Attaches a non-enumerable Symbol audit to the raw engine signal whenever the
 * standard engine outputs a FOREX SELL. The signal handler then admits ONE
 * private observation (probeStore.js). Pure instrumentation: production output
 * is byte-identical, admission runs off the live path, fail-open.
 *
 * The audit carries signal-time CONTEXT so the eventual analysis can split the
 * probe sample by regime / session / higherTF trend / RSI — i.e. identify WHICH
 * forex-SELL slices are systematically wrong, not just "SELL is bad".
 */

import { admitProbeObservation } from '../history/probeStore.js';

export const PROBE_AUDIT = Symbol('probe.audit');

export function attachProbeAudit(signal, audit) {
  if (!signal || typeof signal !== 'object') return;
  Object.defineProperty(signal, PROBE_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}

export function getProbeAudit(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const v = signal[PROBE_AUDIT];
  return v && typeof v === 'object' ? v : null;
}

/**
 * Admission gate (called by signal.js inside ctx.waitUntil). Fail-open.
 * Admits ONLY: assetType FOREX + post-AI final = SELL (actually traded).
 */
export async function maybeAdmitForexSellProbe(signal, pair, assetType, env) {
  try {
    if (assetType !== 'FOREX') return null;
    const audit = getProbeAudit(signal);
    if (!audit) return null;
    if (!signal || signal.finalSignal !== 'SELL') return null;
    if (!audit.expiryTime || !audit.entryPrice) return null;

    const obsId = 'probe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return await admitProbeObservation({
      id: obsId,
      pair,
      assetType,
      direction: 'SELL',
      entryPrice: audit.entryPrice,
      expiryTime: audit.expiryTime,
      bestTF: audit.bestTF,
      shadowConfidence: audit.confidence,
      auditSummary: {
        regime: audit.regime,
        sessionQuality: audit.sessionQuality,
        higherTFTrend: audit.higherTFTrend,
        alignment: audit.alignment,
        rsi: audit.rsi,
      },
    }, env);
  } catch (e) {
    console.warn('probe admission error (fail-open): ' + e.message);
    return null;
  }
}

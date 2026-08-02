/**
 * D2 Shadow — private counterfactual transport for the Phase-D2 negative filters.
 *
 * Standard (Forex/Crypto) engine only. Whenever a D2 branch (TRENDING / BAD_PAIR
 * / HIGHEST_SESSION) converts a would-be BUY/SELL into NO_TRADE, the engine
 * attaches a small audit here under a non-enumerable Symbol. The signal handler
 * then admits ONE private observation (d2store.js) IF and only if the final
 * post-AI signal is still NO_TRADE — i.e. the block actually held. If the AI
 * rescue path revived the signal, it is a REAL trade and normal history already
 * tracks its outcome, so no counterfactual is admitted (no double counting).
 *
 * Isolation guarantees:
 *   - Symbol transport: JSON.stringify() / for...in never expose the audit.
 *   - Admission runs in ctx.waitUntil (off the live response path), fail-open.
 *   - Observations live in the private `d2obs:` / `d2pending:` / `d2idx:` KV
 *     namespace, fully separate from sig:, pending:, stats:, cb:, pushLog: and
 *     from R7.1's `shadow:` namespace.
 *
 * The counterfactual is deterministic PRE-AI: it measures what the engine slice
 * that D2 blocked would have done. AI-layer effects (rescue/boost/disagree) are
 * NOT part of the counterfactual — that boundary is stated plainly in the D2
 * shadow report so the data is never over-read.
 */

import { admitD2ShadowObservation } from '../history/d2store.js';

export const D2_AUDIT = Symbol('d2.audit');

/** Attach the D2 would-be-signal audit to a signal (non-enumerable). */
export function attachD2Audit(signal, audit) {
  if (!signal || typeof signal !== 'object') return;
  Object.defineProperty(signal, D2_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}

/** Read the D2 audit back (explicit getter — the only way to see it). */
export function getD2Audit(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const v = signal[D2_AUDIT];
  return v && typeof v === 'object' ? v : null;
}

/**
 * Admission gate (called by signal.js inside ctx.waitUntil). Fail-open: any
 * error returns null and never delays or alters the live signal response.
 */
export async function maybeAdmitD2ShadowObservation(signal, pair, assetType, env) {
  try {
    const audit = getD2Audit(signal);
    if (!audit) return null;

    // Only admit when the D2 block HELD (post-AI final = NO_TRADE). An AI
    // rescue means the signal traded for real — normal history owns that row.
    // Handler passes the RAW engine signal (finalSignal at top level; the
    // response wrapper with signal.signal is built AFTER admission).
    const finalDir = signal ? signal.finalSignal : null;
    if (finalDir !== 'NO_TRADE') return null;

    if (audit.wouldBeDirection !== 'BUY' && audit.wouldBeDirection !== 'SELL') return null;
    if (!audit.expiryTime || !audit.entryPrice) return null;

    const obsId = 'd2_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    return await admitD2ShadowObservation({
      id: obsId,
      pair,
      assetType,
      direction: audit.wouldBeDirection,
      entryPrice: audit.entryPrice,
      expiryTime: audit.expiryTime,
      bestTF: audit.bestTF,
      shadowConfidence: audit.wouldBeConfidence,
      attribution: audit.attribution,
      auditSummary: {
        marketRegime: audit.marketRegime,
        sessionQuality: audit.sessionQuality,
        wouldBeConfidence: audit.wouldBeConfidence,
        filtersApplied: audit.filtersApplied,
      },
    }, env);
  } catch (e) {
    console.warn('D2 shadow admission error (fail-open): ' + e.message);
    return null;
  }
}

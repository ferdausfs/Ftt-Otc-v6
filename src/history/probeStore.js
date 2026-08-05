/**
 * Forex SELL Probe — isolated forward-evidence store.
 *
 * Phase F finding (2026-08-04, forward n=60): forex SELL is running ~20% WR
 * while the same pairs' BUY is 40-60%. Root cause hypothesis (code + data):
 * the RANGING-regime mean-reversion RSI logic scores "overbought -> SELL" but
 * short expiries keep trending up, so SELL systematically faces upward moves.
 *
 * This module stores ONLY forex SELL signals (post-AI final = SELL, actually
 * traded — normal history still owns the real outcome) with their signal-time
 * CONTEXT (regime, session quality, higherTF trend, RSI, alignment) so that
 * after 7-14 forward days we can decide, with evidence:
 *   - which forex-SELL slices are systematically wrong (regime/RSI/session),
 *   - whether the flipped (BUY) counterfactual clears breakeven with CI.
 *
 * Isolation guarantees (asserted in scripts/probe_tests.mjs):
 *   - Private KV namespace `probe:` — separate from sig:, pending:, stats:,
 *     cb:, shadow:, d2obs: etc. Never touches public API/history/push.
 *   - Fail-open: admission runs in ctx.waitUntil, can never delay a live signal.
 *
 * This is INSTRUMENTATION ONLY — zero behavior change to production.
 */

import { fetchExpiryPrice } from './stats.js';

const OBS_PREFIX     = 'probe:obs:';
const PENDING_PREFIX = 'probe:pending:';
const IDX_PREFIX     = 'probe:idx:';

const MAX_PER_PAIR_30D  = 50;
const RETENTION_TTL_S   = 30 * 24 * 3600;
const PENDING_TTL_S     = Math.floor(2 * 60 * 60);
const PENDING_MAX_CHECKS = 15;
const RESOLVER_CAP       = 10;
const RESULT_CHECK_DELAY_S = 90;
const DEDUP_WINDOW_MS    = 2 * 60 * 60 * 1000;
const DEDUP_ENTRY_REL_TOL = 0.0005;
const DEDUP_ENTRY_ABS_TOL = 0.0001;

function pairKey(pair) {
  return String(pair).replace(/\//g, '_').replace(/-/g, '_').toUpperCase();
}
function obsKey(id)      { return OBS_PREFIX + id; }
function pendingKey(id)  { return PENDING_PREFIX + id; }
function idxKey(pair)    { return IDX_PREFIX + pairKey(pair); }

function entriesClose(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOL || (diff / scale) <= DEDUP_ENTRY_REL_TOL;
}

const __accounting = {
  admitted: 0, dedupRejected: 0, capRejected: 0,
  admissionReads: 0, admissionWrites: 0,
  resolutionLists: 0, resolutionReads: 0, resolutionWrites: 0, resolutionDeletes: 0,
  retryWrites: 0, terminalUnknownWrites: 0,
};
export function getProbeAccounting() { return { ...__accounting }; }
export function resetProbeAccounting() { for (const k of Object.keys(__accounting)) __accounting[k] = 0; }

export const __probeStoreTest = {
  pairKey, obsKey, pendingKey, idxKey, entriesClose,
  MAX_PER_PAIR_30D, PENDING_TTL_S, RETENTION_TTL_S, DEDUP_WINDOW_MS, RESOLVER_CAP,
};

/**
 * Admit one forex SELL probe observation. Fail-open.
 * input: { id, pair, direction:'SELL', entryPrice, expiryTime, shadowConfidence,
 *          assetType, bestTF, auditSummary: { regime, sessionQuality,
 *          higherTFTrend, alignment, rsi } }
 */
export async function admitProbeObservation(input, env) {
  if (!env || !env.SIGNAL_CACHE) return { admitted: false, reason: 'NO_KV' };
  if (!input || !input.id || !input.pair || !input.direction || !input.expiryTime) {
    return { admitted: false, reason: 'INVALID_INPUT' };
  }
  try {
    const idxK = idxKey(input.pair);
    let idx = [];
    try { idx = await env.SIGNAL_CACHE.get(idxK, 'json'); } catch (e) { idx = []; }
    if (!Array.isArray(idx)) idx = [];
    __accounting.admissionReads++;

    const now = Date.now();
    const window30d = now - RETENTION_TTL_S * 1000;
    idx = idx.filter(e => e && typeof e.admittedAt === 'number' && e.admittedAt >= window30d);

    const dedupCutoff = now - DEDUP_WINDOW_MS;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose(e.entryPrice, input.entryPrice)) {
        __accounting.dedupRejected++;
        return { admitted: false, reason: 'DEDUP', reads: 1, writes: 0 };
      }
    }

    if (idx.length >= MAX_PER_PAIR_30D) {
      __accounting.capRejected++;
      return { admitted: false, reason: 'CAP', reads: 1, writes: 0 };
    }

    const record = {
      id: input.id, pair: input.pair, assetType: input.assetType || null,
      direction: input.direction,
      entryPrice: input.entryPrice ?? null,
      expiryTime: input.expiryTime,
      bestTF: input.bestTF || null,
      shadowConfidence: input.shadowConfidence ?? null,
      attribution: 'FOREX_SELL_PROBE',
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null, flippedResult: null, exitPrice: null, resolvedAt: null, checks: 0,
    };
    await env.SIGNAL_CACHE.put(obsKey(input.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S });
    await env.SIGNAL_CACHE.put(pendingKey(input.id), JSON.stringify(record), { expirationTtl: PENDING_TTL_S });

    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxK, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S });

    __accounting.admitted++;
    __accounting.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn('probe admit error (fail-open): ' + e.message);
    return { admitted: false, reason: 'ERROR', error: e.message };
  }
}

/**
 * Cron resolver (mirrors d2store/r71store). `fetchPrice` injectable for tests.
 * On resolve, stores BOTH the actual result and the flipped counterfactual
 * (SELL flips to BUY on the same entry/exit prices).
 */
export async function resolveProbeObservations(env, fetchPrice = fetchExpiryPrice) {
  if (!env || !env.SIGNAL_CACHE) return { resolved: 0 };
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: PENDING_PREFIX });
    __accounting.resolutionLists++;
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return { resolved: 0 };

    const now = Date.now();
    let resolved = 0; let checked = 0;
    for (const kvEntry of pendingList.keys) {
      if (checked >= RESOLVER_CAP) break;
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, 'json');
        __accounting.resolutionReads++;
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
          __accounting.resolutionDeletes++;
          checked++; continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + RESULT_CHECK_DELAY_S * 1000;
        if (now < checkAfterMs) { checked++; continue; }

        const fetchResult = await fetchPrice(record.pair, record.expiryTime, env);

        if (fetchResult && fetchResult.error) {
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = new Date().toISOString();
          if (record.checks >= PENDING_MAX_CHECKS) {
            record.result = 'UNKNOWN'; record.flippedResult = 'UNKNOWN'; record.resolvedAt = new Date().toISOString();
            await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S });
            __accounting.terminalUnknownWrites++;
            await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
            __accounting.resolutionDeletes++;
          } else {
            const remainingMs = (new Date(record.expiryTime).getTime() + PENDING_TTL_S * 1000) - now;
            if (remainingMs > 60000) {
              await env.SIGNAL_CACHE.put(kvEntry.name, JSON.stringify(record), { expirationTtl: Math.floor(remainingMs / 1000) });
              __accounting.retryWrites++;
            } else {
              record.result = 'UNKNOWN'; record.flippedResult = 'UNKNOWN'; record.resolvedAt = new Date().toISOString();
              await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S });
              __accounting.terminalUnknownWrites++;
              await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
              __accounting.resolutionDeletes++;
            }
          }
          checked++; continue;
        }

        const exitPrice = fetchResult ? fetchResult.price : null;
        let winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null && exitPrice !== undefined) {
          if (record.direction === 'BUY')  winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          if (record.direction === 'SELL') winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
        }
        // entry-hit shadow (truth-keeping): did price reach entry?
        if (record.entryPrice != null && fetchResult) {
          const wl = fetchResult.windowLow, wh = fetchResult.windowHigh;
          if (wl != null && wh != null) {
            if (record.direction === 'BUY') record.entryHit = wl <= record.entryPrice + 1e-12;
            else if (record.direction === 'SELL') record.entryHit = wh >= record.entryPrice - 1e-12;
            record.entryHitWindowLow = wl; record.entryHitWindowHigh = wh;
          }
        }
        // flipped counterfactual: the opposite direction on the same entry/exit
        let flipped = 'UNKNOWN';
        if (winLoss === 'WIN') flipped = 'LOSS';
        else if (winLoss === 'LOSS') flipped = 'WIN';

        record.result = winLoss;
        record.flippedResult = flipped;
        record.exitPrice = exitPrice;
        record.resolvedAt = new Date().toISOString();
        await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record), { expirationTtl: RETENTION_TTL_S });
        __accounting.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
        __accounting.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        console.warn('probe resolve error for ' + kvEntry.name + ': ' + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log('probe resolver: resolved ' + resolved + ' observations');
    return { resolved };
  } catch (e) {
    console.warn('probe resolve error: ' + e.message);
    return { resolved: 0, error: e.message };
  }
}

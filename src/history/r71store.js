/**
 * R7.1 — Isolated shadow observation store (§E).
 *
 * Stores ONLY the structure-suppressed counterfactual: cases where the standard
 * production engine said NO_TRADE (both pre-AI and post-AI) but the deterministic
 * structure-excluded shadow produced a BUY/SELL. We then track the shadow trade's
 * real expiry outcome so Candidate A (structure-excluded scoring) can later be
 * evaluated on real, controlled counterfactual data.
 *
 * Isolation guarantees (asserted in scripts/r71_tests.mjs #11):
 *   - Separate KV namespace prefix `shadow:` — distinct from sig:, pending:,
 *     stats:, cb:, quota:, rr:, c:, latest:, pushLog:, pushLock:.
 *   - Never reads/writes normal history, pair stats, circuit breaker, push logs,
 *     or any user-facing path.
 *   - Every public function is fail-open: a KV error can never alter or delay a
 *     live signal response (admission runs inside ctx.waitUntil).
 *
 * Admission is a ROLLING 30-day window, max 30 per pair (14 pairs => <=420).
 * Selection limitation: under high event volume only the earliest 30 candidates
 * per rolling window are admitted; later ones are dropped (admission-time bias
 * toward earlier events). This is stated plainly in the report.
 */

import { CONFIG } from '../config.js';
import { fetchExpiryPrice } from './stats.js';

// ── KV schema (all under the `shadow:` prefix) ─────────────────────────
const OBS_PREFIX     = 'shadow:obs:';       // shadow:obs:<id>      -> resolved/pending observation
const PENDING_PREFIX = 'shadow:pending:';   // shadow:pending:<id>  -> awaiting expiry resolution
const IDX_PREFIX     = 'shadow:idx:';       // shadow:idx:<PAIR>    -> [{id,admittedAt,direction,entryPrice}]

const MAX_PER_PAIR_30D  = 30;               // §E cap (14 pairs => max 420)
const RETENTION_TTL_S   = 30 * 24 * 3600;   // observation retention: 30 days
const PENDING_TTL_S     = Math.floor(2 * 60 * 60); // ~2h, aligns with normal result-resolution window
const PENDING_MAX_CHECKS = 15;              // bounded retry count (mirrors HISTORY_CONFIG.PENDING_MAX_CHECKS)
const RESOLVER_CAP       = 10;              // max resolutions per cron execution
const RESULT_CHECK_DELAY_S = 90;            // mirrors HISTORY_CONFIG.RESULT_CHECK_DELAY
const DEDUP_WINDOW_MS    = 2 * 60 * 60 * 1000;   // §E: pair+direction+nearby-entry, 2-hour window
const DEDUP_ENTRY_REL_TOL = 0.0005;
const DEDUP_ENTRY_ABS_TOL = 0.0001;

function pairKey(pair) {
  return String(pair).replace(/\//g, '_').replace(/-/g, '_').toUpperCase();
}
function shadowObsKey(id)   { return OBS_PREFIX + id; }
function shadowPendingKey(id) { return PENDING_PREFIX + id; }
function shadowIdxKey(pair) { return IDX_PREFIX + pairKey(pair); }

function entriesClose(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOL || (diff / scale) <= DEDUP_ENTRY_REL_TOL;
}

// ── cumulative KV accounting (diagnostics / report) ────────────────────
const __accounting = {
  admitted: 0,
  dedupRejected: 0,
  capRejected: 0,
  admissionReads: 0, admissionWrites: 0,
  resolutionLists: 0, resolutionReads: 0, resolutionWrites: 0,
  resolutionDeletes: 0,
  retryWrites: 0,
  terminalUnknownWrites: 0,
};
export function getR71Accounting() { return { ...__accounting }; }
export function resetR71Accounting() { for (const k of Object.keys(__accounting)) __accounting[k] = 0; }

export const __r71StoreTest = {
  pairKey, shadowObsKey, shadowPendingKey, shadowIdxKey,
  entriesClose, MAX_PER_PAIR_30D, PENDING_TTL_S, RETENTION_TTL_S,
  DEDUP_WINDOW_MS, RESOLVER_CAP,
};

/**
 * Admit one structure-suppressed shadow observation. Fail-open: never throws to
 * the caller (admission runs in ctx.waitUntil, off the live response path).
 *
 * input: { id, pair, direction, entryPrice, expiryTime, shadowConfidence,
 *          assetType, attribution, bestTF, auditSummary }
 */
export async function admitShadowObservation(input, env) {
  if (!env || !env.SIGNAL_CACHE) return { admitted: false, reason: 'NO_KV' };
  if (!input || !input.id || !input.pair || !input.direction || !input.expiryTime) {
    return { admitted: false, reason: 'INVALID_INPUT' };
  }
  try {
    // 1. read per-pair index (1 read)
    const idxKey = shadowIdxKey(input.pair);
    let idx = [];
    try { idx = await env.SIGNAL_CACHE.get(idxKey, 'json'); } catch (e) { idx = []; }
    if (!Array.isArray(idx)) idx = [];
    __accounting.admissionReads++;

    const now = Date.now();
    const window30d = now - RETENTION_TTL_S * 1000;
    // prune entries older than 30 days (enforce the rolling window)
    idx = idx.filter(e => e && typeof e.admittedAt === 'number' && e.admittedAt >= window30d);

    // 2. dedup guard: same pair+direction+nearby-entry within 2h
    const dedupCutoff = now - DEDUP_WINDOW_MS;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose(e.entryPrice, input.entryPrice)) {
        __accounting.dedupRejected++;
        return { admitted: false, reason: 'DEDUP', reads: 1, writes: 0 };
      }
    }

    // 3. cap guard: max 30 admitted per pair per rolling 30-day window
    if (idx.length >= MAX_PER_PAIR_30D) {
      __accounting.capRejected++;
      return { admitted: false, reason: 'CAP', reads: 1, writes: 0 };
    }

    // 4. admit: write observation + pending + index (3 writes)
    const record = {
      id: input.id, pair: input.pair, assetType: input.assetType || null,
      direction: input.direction,
      entryPrice: input.entryPrice ?? null,
      expiryTime: input.expiryTime,
      bestTF: input.bestTF || null,
      shadowConfidence: input.shadowConfidence ?? null,
      attribution: input.attribution || 'STRUCTURE_SUPPRESSED',
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null, exitPrice: null, resolvedAt: null, checks: 0,
    };
    await env.SIGNAL_CACHE.put(shadowObsKey(input.id), JSON.stringify(record),
      { expirationTtl: RETENTION_TTL_S });
    // pending carries the same payload; resolver appends result then deletes it.
    await env.SIGNAL_CACHE.put(shadowPendingKey(input.id), JSON.stringify(record),
      { expirationTtl: PENDING_TTL_S });

    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxKey, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S });

    __accounting.admitted++;
    __accounting.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn('R7.1 admitShadowObservation error (fail-open): ' + e.message);
    return { admitted: false, reason: 'ERROR', error: e.message };
  }
}

/**
 * Cron-driven resolver. Idempotent and capped per execution. Updates ONLY the
 * private shadow observation and deletes its own pending key. Mirrors the shape
 * of scheduledTracker but operates exclusively on `shadow:` keys.
 */
export async function resolveShadowObservations(env) {
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
        if (now < checkAfterMs) { checked++; continue; }   // not due yet

        const fetchResult = await fetchExpiryPrice(record.pair, record.expiryTime, env);

        if (fetchResult && fetchResult.error) {
          // transient failure: count attempts, give up after PENDING_MAX_CHECKS
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = new Date().toISOString();
          if (record.checks >= PENDING_MAX_CHECKS) {
            record.result = 'UNKNOWN'; record.resolvedAt = new Date().toISOString();
            await env.SIGNAL_CACHE.put(shadowObsKey(record.id), JSON.stringify(record),
              { expirationTtl: RETENTION_TTL_S });
            __accounting.terminalUnknownWrites++;
            await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
            __accounting.resolutionDeletes++;
          } else {
            const remainingMs = (new Date(record.expiryTime).getTime() + PENDING_TTL_S * 1000) - now;
            if (remainingMs > 60000) {
              await env.SIGNAL_CACHE.put(kvEntry.name, JSON.stringify(record),
                { expirationTtl: Math.floor(remainingMs / 1000) });
              __accounting.retryWrites++;
            } else {
              record.result = 'UNKNOWN'; record.resolvedAt = new Date().toISOString();
              await env.SIGNAL_CACHE.put(shadowObsKey(record.id), JSON.stringify(record),
                { expirationTtl: RETENTION_TTL_S });
              __accounting.terminalUnknownWrites++;
              await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
              __accounting.resolutionDeletes++;
            }
          }
          checked++; continue;   // transient retry — not a resolution
        }

        // success: compute win/loss, update the observation, delete pending
        const exitPrice = fetchResult ? fetchResult.price : null;
        let winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null && exitPrice !== undefined) {
          if (record.direction === 'BUY')  winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          if (record.direction === 'SELL') winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
        }
        record.result = winLoss;
        record.exitPrice = exitPrice;
        record.resolvedAt = new Date().toISOString();
        await env.SIGNAL_CACHE.put(shadowObsKey(record.id), JSON.stringify(record),
          { expirationTtl: RETENTION_TTL_S });
        __accounting.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
        __accounting.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        // do NOT delete on exception — let the retry counter run its course
        console.warn('R7.1 shadow resolve error for ' + kvEntry.name + ': ' + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log('R7.1 shadow resolver: resolved ' + resolved + ' observations');
    return { resolved };
  } catch (e) {
    console.warn('R7.1 resolveShadowObservations error: ' + e.message);
    return { resolved: 0, error: e.message };
  }
}

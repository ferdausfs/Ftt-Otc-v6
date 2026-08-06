/**
 * D2 Shadow — isolated counterfactual store for Phase-D2 negative filters.
 *
 * Mirrors R7.1's r71store.js design exactly (isolation, fail-open, rolling
 * window, dedup, capped resolver) but under its OWN KV namespace:
 *
 *   d2obs:      d2obs:<id>      -> resolved/pending D2-blocked observation
 *   d2pending:  d2pending:<id>  -> awaiting expiry resolution
 *   d2idx:      d2idx:<PAIR>    -> [{id,admittedAt,direction,entryPrice}]
 *
 * Isolation guarantees (asserted in scripts/d2_tests.mjs):
 *   - Never reads/writes sig:, pending:, stats:, cb:, quota:, rr:, c:,
 *     latest:, pushLog:, pushLock:, or R7.1's shadow: namespace.
 *   - Every public function is fail-open: a KV error can never alter or delay a
 *     live signal response (admission runs inside ctx.waitUntil).
 *
 * What a D2 observation means:
 *   production was NO_TRADE (post-AI) because a D2 negative filter fired, but
 *   the pre-D2 engine direction was BUY/SELL. We track that would-be trade's
 *   real expiry outcome so Phase F can judge each D2 block on forward evidence.
 *   The counterfactual is deterministic PRE-AI by design (see d2shadow.js).
 *
 * Admission is a ROLLING 30-day window, max 30 per pair (18 pairs => <=540).
 * Under high event volume only the earliest 30 candidates per window are
 * admitted; later ones are dropped (admission-time bias toward earlier events).
 */

import { fetchExpiryPrice, classifyOutcome } from './stats.js';

// ── KV schema (all under the `d2obs:`/`d2pending:`/`d2idx:` prefixes) ─────
const OBS_PREFIX     = 'd2obs:';
const PENDING_PREFIX = 'd2pending:';
const IDX_PREFIX     = 'd2idx:';

const MAX_PER_PAIR_30D  = 30;
const RETENTION_TTL_S   = 30 * 24 * 3600;   // 30 days
const PENDING_TTL_S     = Math.floor(2 * 60 * 60); // ~2h, matches normal resolution window
const PENDING_MAX_CHECKS = 15;
const RESOLVER_CAP       = 10;              // max resolutions per cron execution
const RESULT_CHECK_DELAY_S = 90;            // mirrors HISTORY_CONFIG.RESULT_CHECK_DELAY
const DEDUP_WINDOW_MS    = 2 * 60 * 60 * 1000;   // pair+direction+nearby-entry, 2h
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
export function getD2Accounting() { return { ...__accounting }; }
export function resetD2Accounting() { for (const k of Object.keys(__accounting)) __accounting[k] = 0; }

export const __d2StoreTest = {
  pairKey, obsKey, pendingKey, idxKey,
  entriesClose, MAX_PER_PAIR_30D, PENDING_TTL_S, RETENTION_TTL_S,
  DEDUP_WINDOW_MS, RESOLVER_CAP,
};

/**
 * Admit one D2-blocked counterfactual observation. Fail-open: never throws to
 * the caller (admission runs in ctx.waitUntil, off the live response path).
 *
 * input: { id, pair, direction, entryPrice, expiryTime, shadowConfidence,
 *          assetType, bestTF, attribution, auditSummary }
 */
export async function admitD2ShadowObservation(input, env) {
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

    // dedup: same pair + direction + nearby entry within 2h
    const dedupCutoff = now - DEDUP_WINDOW_MS;
    for (const e of idx) {
      if (e.admittedAt < dedupCutoff) continue;
      if (e.direction !== input.direction) continue;
      if (entriesClose(e.entryPrice, input.entryPrice)) {
        __accounting.dedupRejected++;
        return { admitted: false, reason: 'DEDUP', reads: 1, writes: 0 };
      }
    }

    // cap: max 30 per pair per rolling 30-day window
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
      attribution: input.attribution || 'D2_BLOCKED',
      auditSummary: input.auditSummary || null,
      admittedAt: new Date(now).toISOString(),
      result: null, exitPrice: null, resolvedAt: null, checks: 0,
    };
    await env.SIGNAL_CACHE.put(obsKey(input.id), JSON.stringify(record),
      { expirationTtl: RETENTION_TTL_S });
    await env.SIGNAL_CACHE.put(pendingKey(input.id), JSON.stringify(record),
      { expirationTtl: PENDING_TTL_S });

    idx.push({ id: input.id, admittedAt: now, direction: input.direction, entryPrice: input.entryPrice ?? null });
    await env.SIGNAL_CACHE.put(idxK, JSON.stringify(idx), { expirationTtl: RETENTION_TTL_S });

    __accounting.admitted++;
    __accounting.admissionWrites += 3;
    return { admitted: true, reads: 1, writes: 3 };
  } catch (e) {
    console.warn('D2 admitD2ShadowObservation error (fail-open): ' + e.message);
    return { admitted: false, reason: 'ERROR', error: e.message };
  }
}

/**
 * Cron-driven resolver. Idempotent and capped per execution. Updates ONLY the
 * private d2 observation and deletes its own pending key. Mirrors R7.1's
 * resolver; `fetchPrice` is injectable so the resolution maths can be tested
 * deterministically (production default = fetchExpiryPrice).
 */
export async function resolveD2ShadowObservations(env, fetchPrice = fetchExpiryPrice) {
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

        const fetchResult = await fetchPrice(record.pair, record.expiryTime, env);

        if (fetchResult && fetchResult.error) {
          // transient failure: count attempts, give up after PENDING_MAX_CHECKS
          record.checks = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt = new Date().toISOString();
          if (record.checks >= PENDING_MAX_CHECKS) {
            record.result = 'UNKNOWN'; record.resolvedAt = new Date().toISOString();
            await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record),
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
              await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record),
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
        // Bugfix round 1 (BUG-008): shared classifier — exit == entry is TIE.
        const winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);
        // entry-hit shadow (truth-keeping)
        if (record.entryPrice != null && fetchResult) {
          const wl = fetchResult.windowLow, wh = fetchResult.windowHigh;
          if (wl != null && wh != null) {
            if (record.direction === 'BUY') record.entryHit = wl <= record.entryPrice + 1e-12;
            else if (record.direction === 'SELL') record.entryHit = wh >= record.entryPrice - 1e-12;
            record.entryHitWindowLow = wl; record.entryHitWindowHigh = wh;
          }
        }
        record.result = winLoss;
        record.exitPrice = exitPrice;
        record.resolvedAt = new Date().toISOString();
        await env.SIGNAL_CACHE.put(obsKey(record.id), JSON.stringify(record),
          { expirationTtl: RETENTION_TTL_S });
        __accounting.resolutionWrites++;
        await env.SIGNAL_CACHE.delete(kvEntry.name).catch(() => {});
        __accounting.resolutionDeletes++;
        resolved++;
        checked++;
      } catch (e) {
        // do NOT delete on exception — let the retry counter run its course
        console.warn('D2 shadow resolve error for ' + kvEntry.name + ': ' + e.message);
        checked++;
      }
    }
    if (resolved > 0) console.log('D2 shadow resolver: resolved ' + resolved + ' observations');
    return { resolved };
  } catch (e) {
    console.warn('D2 resolveD2ShadowObservations error: ' + e.message);
    return { resolved: 0, error: e.message };
  }
}

/**
 * V7 SHADOW STORE — counterfactual outcome store for the v7 prototype
 * (2026-09-03). Mirrors probeStore.js / d2store.js conventions:
 *   - private KV keys under `v7obs:` in SIGNAL_CACHE
 *   - dedup 30 min per pair (cron re-polls must not inflate the sample)
 *   - cap 40 observations / pair / 30 days
 *   - pending observations resolve forward via fetchExpiryPrice (stats.js),
 *     the EXACT same price path the production tracker uses
 *   - everything fail-open: store errors never touch production signals
 *
 * The store answers ONE question with forward data: "if v7 had minted here,
 * what would the 5-minute binary outcome have been?" Until that number clears
 * the breakeven bar (55.6% at 80% payout) consistently, v7 stays in shadow and
 * NO subscriber sees a v7 signal (RULE 6, same gate the EC ladder just passed
 * through — the flip was cancelled, not rushed).
 */

import { fetchExpiryPrice, classifyOutcome } from './stats.js';

const PREFIX        = 'v7obs:';
const DEDUP_MS      = 30 * 60 * 1000;      // 30 min per pair
const MAX_PER_PAIR  = 40;                  // per rolling 30 days
const WINDOW_MS     = 30 * 24 * 3600 * 1000;
const PENDING_TTL_S = 2 * 3600;            // unresolved after 2h -> UNKNOWN
const RETENTION_S   = 35 * 24 * 3600;      // 35 days then KV GC

const okKV = (env) => env && env.SIGNAL_CACHE && typeof env.SIGNAL_CACHE.list === 'function';

async function listPair(env, pair) {
  const res = await env.SIGNAL_CACHE.list({ prefix: PREFIX + pair + '|' });
  const out = [];
  for (const k of (res.keys || [])) {
    try { out.push(JSON.parse(await env.SIGNAL_CACHE.get(k.name))); } catch { /* fail-open */ }
  }
  return out.filter(Boolean);
}

/**
 * Admit one would-mint observation. Returns {admitted, reason, id}.
 * Dedup: same pair within DEDUP_MS. Cap: MAX_PER_PAIR within WINDOW_MS.
 */
export async function admitV7Observation(env, obs) {
  if (!okKV(env)) return { admitted: false, reason: 'no-kv' };
  if (!obs || !obs.pair || !obs.want || !obs.entry) return { admitted: false, reason: 'bad-obs' };
  try {
    const existing = await listPair(env, obs.pair);
    const nowMs = Date.now();
    const lastObs = existing
      .map((r) => Date.parse(r.obsTime || '') || 0)
      .reduce((a, b) => Math.max(a, b), 0);
    if (nowMs - lastObs < DEDUP_MS) return { admitted: false, reason: 'dedup' };
    const recent = existing.filter((r) => nowMs - (Date.parse(r.obsTime || '') || 0) < WINDOW_MS);
    if (recent.length >= MAX_PER_PAIR) return { admitted: false, reason: 'cap' };

    const id = 'v7_' + nowMs.toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const record = {
      id,
      pair: obs.pair,
      want: obs.want,
      strategy: obs.strategy || 'V7_MR_RANGING',
      features: obs.features || {},
      trigger: obs.trigger || {},
      entryPrice: obs.entry.price,
      entryTime: obs.entry.entryTime,
      expiryTime: obs.entry.expiryTime,
      result: null, exitPrice: null, resolvedAt: null,
      obsTime: obs.obsTime,
      v: 'v7-0.1',
    };
    await env.SIGNAL_CACHE.put(PREFIX + obs.pair + '|' + id, JSON.stringify(record), { expirationTtl: RETENTION_S });
    return { admitted: true, id };
  } catch (e) {
    console.warn('v7store admit failed (fail-open): ' + e.message);
    return { admitted: false, reason: 'error' };
  }
}

/** Pending = result still null and older than PENDING_TTL. */
export async function listPendingV7(env) {
  if (!okKV(env)) return [];
  const res = await env.SIGNAL_CACHE.list({ prefix: PREFIX });
  const now = Date.now();
  const pending = [];
  for (const k of (res.keys || [])) {
    try {
      const rec = JSON.parse(await env.SIGNAL_CACHE.get(k.name));
      if (!rec || rec.result) continue;
      if (now - (Date.parse(rec.entryTime || '') || 0) >= PENDING_TTL_S * 1000) pending.push(rec);
    } catch { /* fail-open */ }
  }
  return pending;
}

/**
 * Cron resolver (mirrors probeStore/d2store). `fetchPrice` injectable for
 * tests. Calls fetchExpiryPrice — the production tracker's own price path.
 */
export async function resolveV7ShadowObservations(env, fetchPrice = fetchExpiryPrice) {
  if (!okKV(env)) return { resolved: 0 };
  const res = await env.SIGNAL_CACHE.list({ prefix: PREFIX });
  let resolved = 0;
  for (const k of (res.keys || [])) {
    try {
      const rec = JSON.parse(await env.SIGNAL_CACHE.get(k.name));
      if (!rec || rec.result) continue;
      const ageMs = Date.now() - (Date.parse(rec.entryTime || '') || 0);
      if (ageMs < 5 * 60 * 1000) continue;                       // too fresh, let it expire
      const px = await fetchPrice(rec.pair, rec.expiryTime, env);
      if (!px || typeof px.price !== 'number') {
        if (ageMs > PENDING_TTL_S * 1000) {
          rec.result = 'UNKNOWN'; rec.resolvedAt = new Date().toISOString();
          await env.SIGNAL_CACHE.put(k.name, JSON.stringify(rec), { expirationTtl: RETENTION_S });
          resolved += 1;
        }
        continue;
      }
      rec.exitPrice = px.price;
      rec.result = classifyOutcome(rec.want, rec.entryPrice, px.price);
      rec.resolvedAt = new Date().toISOString();
      await env.SIGNAL_CACHE.put(k.name, JSON.stringify(rec), { expirationTtl: RETENTION_S });
      resolved += 1;
    } catch { /* fail-open, next cron retries */ }
  }
  return { resolved };
}

/** Research summary: WR overall + per feature slice (r71/probe report style). */
export async function summarizeV7(env) {
  if (!okKV(env)) return null;
  const res = await env.SIGNAL_CACHE.list({ prefix: PREFIX });
  const rows = [];
  for (const k of (res.keys || [])) {
    try {
      const rec = JSON.parse(await env.SIGNAL_CACHE.get(k.name));
      if (rec && rec.result) rows.push(rec);
    } catch { /* ignore */ }
  }
  const slice = (fn) => {
    const sub = rows.filter(fn);
    const n = sub.length;
    const k = sub.filter((r) => r.result === 'WIN').length;
    return { n, k, wr: n ? Math.round((1000 * k) / n) / 10 : null };
  };
  return {
    total: rows.length,
    overall: slice(() => true),
    bySide: {
      BUY: slice((r) => r.want === 'BUY'),
      SELL: slice((r) => r.want === 'SELL'),
    },
    byTriggerClosePos: {
      strong: slice((r) => (r.trigger && r.trigger.closePos) >= 0.7 || (r.trigger && 1 - r.trigger.closePos) >= 0.7),
      weak: slice((r) => (r.trigger && r.trigger.closePos) < 0.7 && (1 - (r.trigger ? r.trigger.closePos : 0)) < 0.7),
    },
    byRsiZone: {
      deep: slice((r) => r.features && ((r.want === 'BUY' && r.features.rsi <= 30) || (r.want === 'SELL' && r.features.rsi >= 70))),
      normal: slice((r) => r.features && !((r.want === 'BUY' && r.features.rsi <= 30) || (r.want === 'SELL' && r.features.rsi >= 70))),
    },
  };
}

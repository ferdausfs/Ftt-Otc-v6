/**
 * Phase 7 — shared read/write layer for the cron-warmed signal cache.
 *
 * Three call sites depend on the key format and the staleness rule
 * (scheduledScan writes, /api/signals/latest reads, /api/signal?preferCache
 * reads then opportunistically writes). They live here so the three can never
 * drift apart — a mismatched key would silently produce a permanent cache miss
 * rather than an error.
 *
 * Key: `latest:<PAIR>` with `/` and `-` normalised to `_`, upper-cased.
 *   BTC/USD      -> latest:BTC_USD
 *   EURUSD-OTC   -> latest:EURUSD_OTC
 * This mirrors the existing pairKey() convention in history/stats.js, and the
 * `latest:` prefix is distinct from every prefix already in use
 * (sig:, stats:, pending:, cb:, quota:, rr:, c:) — verified by grep.
 */

import { SCAN_CONFIG } from '../config.js';

/** Normalise any accepted pair spelling to the KV key form. */
export function latestKey(pair) {
  return SCAN_CONFIG.KV_LATEST_PREFIX
    + String(pair).replace(/\//g, '_').replace(/-/g, '_').toUpperCase();
}

/** Inverse of latestKey() — used when listing the whole cache. */
export function pairFromLatestKey(keyName) {
  const raw = String(keyName).slice(SCAN_CONFIG.KV_LATEST_PREFIX.length);
  // OTC keys are stored as EURUSD_OTC and must come back as EURUSD-OTC,
  // not EURUSD/OTC — a plain underscore->slash swap would corrupt them.
  if (raw.endsWith('_OTC')) return raw.slice(0, -4) + '-OTC';
  const i = raw.indexOf('_');
  return i === -1 ? raw : raw.slice(0, i) + '/' + raw.slice(i + 1);
}

/**
 * Attach freshness metadata at read time.
 * `generationAge` is seconds since generation; `nextRefreshIn` counts down to
 * the next scheduled scan, not to TTL expiry — that is the number a client
 * actually wants when deciding whether to wait or force a refresh.
 */
export function enrichAge(cached, now = Date.now()) {
  if (!cached || typeof cached !== 'object') return cached;
  const genTime = new Date(cached.generatedAt).getTime();
  if (!Number.isFinite(genTime)) {
    return { ...cached, generationAge: null, nextRefreshIn: null, stale: true };
  }
  const ageSeconds = Math.max(0, Math.floor((now - genTime) / 1000));
  const interval = SCAN_CONFIG.SCAN_INTERVAL_SECONDS;
  return {
    ...cached,
    generationAge: ageSeconds,
    nextRefreshIn: Math.max(0, interval - (ageSeconds % interval)),
    stale: ageSeconds >= SCAN_CONFIG.LATEST_TTL_SECONDS,
  };
}

export function isStale(cached, now = Date.now()) {
  if (!cached) return true;
  const genTime = new Date(cached.generatedAt).getTime();
  if (!Number.isFinite(genTime)) return true;
  return (now - genTime) / 1000 >= SCAN_CONFIG.LATEST_TTL_SECONDS;
}

/** Read one cached signal. Returns null on miss, bad JSON, or KV error. */
export async function readLatest(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const cached = await env.SIGNAL_CACHE.get(latestKey(pair), 'json');
    return cached && typeof cached === 'object' ? cached : null;
  } catch (e) {
    console.warn('readLatest error ' + pair + ': ' + e.message);
    return null;
  }
}

/**
 * Write one signal into the cache.
 *
 * `meta.opportunistic` marks an entry warmed by a user request rather than by
 * the cron, so the two are distinguishable in the response and in /health.
 * Never throws: a cache write failing must not fail the request that triggered it.
 */
export async function writeLatest(pair, payload, meta, env) {
  if (!env || !env.SIGNAL_CACHE || !payload) return false;
  try {
    const record = {
      ...payload,
      cached: true,
      generatedAt: (meta && meta.generatedAt) || new Date().toISOString(),
      generationId: (meta && meta.generationId) || null,
      opportunistic: !!(meta && meta.opportunistic),
    };
    await env.SIGNAL_CACHE.put(latestKey(pair), JSON.stringify(record), {
      expirationTtl: SCAN_CONFIG.LATEST_TTL_SECONDS,
    });
    return true;
  } catch (e) {
    console.warn('writeLatest error ' + pair + ': ' + e.message);
    return false;
  }
}

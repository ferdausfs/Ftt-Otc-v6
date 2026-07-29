/**
 * Phase 7 — read-only view of the cron-warmed signal cache.
 *
 *   GET /api/signals/latest              -> every cached pair
 *   GET /api/signals/latest?pair=BTC/USD -> one pair (404 when never scanned)
 *
 * This endpoint never runs the engine. A miss is a miss: the caller is told to
 * use /api/signal (force refresh) or wait for the next scan. That is the whole
 * point of the split — a read here can never cost TwelveData or AI credits.
 */

import { SCAN_PAIRS, SCAN_CONFIG } from '../config.js';
import { jsonResponse } from '../utils/helpers.js';   // NOT utils/cors.js — see report §1.1
import { sanitizePair } from '../utils/pairs.js';
import { readLatest, enrichAge, isStale, pairFromLatestKey } from '../history/latestCache.js';

export async function handleLatest(url, env) {
  if (!env || !env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not bound' }, 503);
  }

  const rawPair = url.searchParams.get('pair');

  // ── single pair ──
  if (rawPair) {
    const pair = sanitizePair(rawPair);
    if (!pair) {
      return jsonResponse({
        error: true,
        message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.',
      }, 400);
    }

    const cached = await readLatest(pair, env);
    if (!cached) {
      return jsonResponse({
        error: true, stale: true, pair,
        message: 'No cached signal for ' + pair
          + '. Use /api/signal?pair=' + encodeURIComponent(pair)
          + ' for fresh generation, or wait for the next scan cycle.',
        scanned: SCAN_PAIRS.includes(pair),
        scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
        timestamp: new Date().toISOString(),
      }, 404);
    }

    const enriched = enrichAge(cached);
    // KV TTL should evict before this, but a clock skew or a long-lived edge
    // read can still surface an over-age entry — treat it as a miss.
    if (enriched.stale) {
      return jsonResponse({
        error: true, stale: true, pair,
        message: 'Cached signal expired, next scan due.',
        generatedAt: cached.generatedAt,
        generationAge: enriched.generationAge,
        scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
        timestamp: new Date().toISOString(),
      }, 404);
    }

    return jsonResponse(enriched);
  }

  // ── all cached pairs ──
  let list;
  try {
    list = await env.SIGNAL_CACHE.list({ prefix: SCAN_CONFIG.KV_LATEST_PREFIX });
  } catch (e) {
    return jsonResponse({ error: true, message: 'Cache list failed: ' + e.message }, 500);
  }

  const keys = (list && list.keys) || [];
  const signals = {};
  let staleCount = 0;

  for (const key of keys) {
    try {
      const cached = await env.SIGNAL_CACHE.get(key.name, 'json');
      if (!cached) continue;
      const enriched = enrichAge(cached);
      if (enriched.stale) { staleCount++; continue; }   // don't serve expired rows
      signals[pairFromLatestKey(key.name)] = enriched;
    } catch (e) { /* skip unreadable entry */ }
  }

  const ages = Object.values(signals)
    .map(s => s.generationAge)
    .filter(a => typeof a === 'number');

  return jsonResponse({
    cached: true,
    signals,
    pairCount: Object.keys(signals).length,
    scannedPairs: SCAN_PAIRS,
    scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
    oldestCachedAge: ages.length ? Math.max(...ages) : null,
    newestCachedAge: ages.length ? Math.min(...ages) : null,
    staleSkipped: staleCount,
    timestamp: new Date().toISOString(),
  });
}

/** Cache summary for /health (spec §4.7). */
export async function getScanCacheStats(env) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const list = await env.SIGNAL_CACHE.list({ prefix: SCAN_CONFIG.KV_LATEST_PREFIX });
    const keys = (list && list.keys) || [];
    let lastGenerationId = null;
    let newestAt = -Infinity;
    let opportunisticCount = 0;
    const ages = [];

    for (const key of keys) {
      try {
        const cached = await env.SIGNAL_CACHE.get(key.name, 'json');
        if (!cached || !cached.generatedAt) continue;
        const t = new Date(cached.generatedAt).getTime();
        if (!Number.isFinite(t)) continue;
        ages.push(Math.max(0, Math.floor((Date.now() - t) / 1000)));
        if (cached.opportunistic) opportunisticCount++;
        // report the newest CRON generation id; opportunistic writes have none
        if (t > newestAt && cached.generationId) {
          newestAt = t;
          lastGenerationId = cached.generationId;
        }
      } catch (e) { /* skip */ }
    }

    return {
      lastGenerationId,
      cachedPairCount: keys.length,
      oldestCachedAge: ages.length ? Math.max(...ages) : null,
      newestCachedAge: ages.length ? Math.min(...ages) : null,
      opportunisticCount,
      scanIntervalSec: SCAN_CONFIG.SCAN_INTERVAL_SECONDS,
      ttlSeconds: SCAN_CONFIG.LATEST_TTL_SECONDS,
      scannedPairs: SCAN_PAIRS.length,
    };
  } catch (e) {
    return { error: 'scanCache unavailable: ' + e.message };
  }
}

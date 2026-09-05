/**
 * FTT3 — /health, /api/pairs, /api/history, /api/report.
 * Slim on purpose: the engine is src/strategy/engine.mjs; this file only
 * reports worker status and serves stored history.
 */

import { CONFIG, SCAN_PAIRS, ASSET_TYPE, VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS, HISTORY_CONFIG } from '../config.js';
import { jsonResponse } from '../utils/helpers.js';
import { sanitizePair } from '../utils/pairs.js';
import { isForexMarketOpen, getForexHoliday } from '../utils/session.js';
import { getApiKeys, readRotationIndex } from '../fetch/keys.js';
import { readQuota } from '../history/quota.js';
import { getScanCacheStats } from './latest.js';
import { getPushStats } from './push.js';
import { readHistory, computeStats } from '../history/store.js';
import { EXPIRY_TIERS } from '../strategy/engine.mjs';

export async function handleHealth(env) {
  const keyCount = getApiKeys(env).length;
  const quotaUsedToday = await readQuota(env);
  const rotationIdx = await readRotationIndex(env);
  const scanCache = await getScanCacheStats(env);
  const push = await getPushStats(env, { validateToken: false });

  return jsonResponse({
    status: 'healthy',
    version: CONFIG.VERSION,
    engine: {
      name: CONFIG.ENGINE,
      conditions: [
        'C1 bias: EMA(20) vs EMA(50) on the last closed 15m candle',
        'C2 confirmation: MACD(12,26,9) line crosses signal on the last closed 5m candle, in C1 direction',
        'C3 entry gate: 1m ATR(14) >= its trailing median over the last 100 closed 1m candles',
      ],
      expiryTiers: EXPIRY_TIERS,
      verdict: 'OOS backtest FAIL (50.5% WR < 55.6% breakeven) — deployed as audited data collector, see results/FTT3_BACKTEST_REPORT.md',
    },
    timestamp: new Date().toISOString(),
    apiKeys: { configured: keyCount, status: keyCount > 0 ? 'ready' : 'NO KEYS' },
    quotaUsedToday,
    rotationIdx,
    bindings: {
      kvCache: env.SIGNAL_CACHE ? 'ready' : 'NOT CONFIGURED',
      botKv: env.BOT_KV ? 'ready' : 'NOT CONFIGURED',
      rateLimiter: env.RATE_LIMITER ? 'ready' : 'KV fallback',
    },
    markets: {
      forex: { status: isForexMarketOpen() ? 'OPEN' : 'CLOSED', holiday: getForexHoliday() || 'NONE' },
      crypto: { status: 'ALWAYS OPEN (24/7)' },
    },
    scan: { pairs: SCAN_PAIRS, intervalSec: 300, cache: scanCache },
    push: {
      enabled: push.pushEnabled,
      subscribers: push.subscribers ? push.subscribers.length : 0,
      delivered24h: push.pushesLast24h,
      lastAttempt: push.lastAttempt,
    },
    history: {
      enabled: !!env.SIGNAL_CACHE,
      maxPerPair: HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR,
      endpoints: {
        history: '/api/history?pair=EUR/USD&limit=20',
        stats: '/api/stats?pair=EUR/USD',
        report: '/api/report?id=SIGNAL_ID&result=WIN',
      },
    },
  });
}

export function handlePairs() {
  return jsonResponse({
    engine: CONFIG.ENGINE,
    scannedPairs: SCAN_PAIRS,
    note: 'FTT3 scans exactly the pairs its walk-forward backtest covered. OTC pairs are out of scope (no legitimate historical data source).',
    forex: { currencies: VALID_FOREX_CURRENCIES.length, marketHours: 'Sunday 22:00 UTC to Friday 22:00 UTC' },
    crypto: { bases: CRYPTO_BASES, quotes: CRYPTO_QUOTES, popularPairs: POPULAR_CRYPTO_PAIRS, marketHours: '24/7' },
    usage: {
      signal: '/api/signal?pair=EUR/USD',
      latest: '/api/signals/latest',
      batch: '/api/batch?pairs=EUR/USD,BTC/USD',
      stats: '/api/stats',
    },
  });
}

export async function handleHistory(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const rawPair = url.searchParams.get('pair') || 'EUR/USD';
  const pair = sanitizePair(rawPair);
  if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 500);
  const rows = await readHistory(pair, env, limit);
  return jsonResponse({
    pair,
    engine: CONFIG.ENGINE,
    count: rows.length,
    history: rows,
    note: 'Rows from the previous engine may carry direction BUY/SELL and legacy fields; FTT3 rows use CALL/PUT.',
  });
}

export async function handleStats(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const rawPair = url.searchParams.get('pair');
  if (rawPair) {
    const pair = sanitizePair(rawPair);
    if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);
    return jsonResponse(await computeStats(pair, env));
  }
  const all = {};
  for (const p of SCAN_PAIRS) all[p] = await computeStats(p, env);
  return jsonResponse({ engine: CONFIG.ENGINE, pairs: all, timestamp: new Date().toISOString() });
}

/** Manual result override (bot correction path). */
export async function handleReport(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const id = url.searchParams.get('id');
  const result = (url.searchParams.get('result') || '').toUpperCase();
  if (!id || !['WIN', 'LOSS', 'TIE', 'UNKNOWN'].includes(result))
    return jsonResponse({ error: true, message: 'Use /api/report?id=SIGNAL_ID&result=WIN|LOSS|TIE|UNKNOWN' }, 400);
  let updated = 0;
  for (const p of SCAN_PAIRS) {
    const rows = await readHistory(p, env, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
    const idx = rows.findIndex(r => r.id === id);
    if (idx >= 0) {
      rows[idx] = { ...rows[idx], result, checkedAt: new Date().toISOString(), manual: true };
      const key = 'sig:' + p.replace(/\//g, '_');
      await env.SIGNAL_CACHE.put(key, JSON.stringify(rows), { expirationTtl: 60 * 60 * 24 * 30 });
      updated++;
      break;
    }
  }
  return jsonResponse({ ok: updated > 0, id, result, updated });
}

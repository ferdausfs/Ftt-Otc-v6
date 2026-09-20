/**
 * UT-BOT — /health, /api/pairs, /api/history, /api/report.
 * Slim on purpose: the engine is src/strategy/utBotAlerts.mjs; this file only
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
      indicators: [
        {
          id: 'utbot',
          name: 'UT Bot Alerts',
          conditions: [
            'exact TradingView port (defaults a=1, c=10): trailing-stop flip on candle close',
            'buy = close crosses above trailing stop, sell = close crosses below (close-confirmed, no repaint)',
            'exact behavioral match to TradingView — scripts/utbot_tests.mjs + scripts/utbot_tv_diff.mjs',
          ],
          defaults: { a: CONFIG.UTBOT.DEFAULT_A, c: CONFIG.UTBOT.DEFAULT_C },
        },
        {
          id: 'mkr',
          name: 'Multi Kernel Regression [ChartPrime]',
          conditions: [
            'non-repaint port: kernel-weighted MA of the last `bandwidth` closes (defaults Laplace, bandwidth 14)',
            'labels Up/Down on the MA slope flip (ta.crossover/crossunder vs its own prior value), close-confirmed',
            'proven by scripts/mkr_tests.mjs (weights, values, cross semantics, no-lookahead)',
          ],
          defaults: { kernel: CONFIG.MKR.DEFAULT_KERNEL, bandwidth: CONFIG.MKR.DEFAULT_BANDWIDTH },
        },
      ],
      messaging: 'CFD style — each indicator speaks only its own output (BUY/SELL, UP/DOWN); simultaneous events share one combined message; no expiry, no win/loss anywhere',
      scanCadence: 'every 15 minutes; events emitted on the 15-minute candle close boundary',
      defaults: {
        timeframe: CONFIG.UTBOT.DEFAULT_TIMEFRAME,
      },
      verdict: 'exact behavioral match to TradingView for both indicators; win-rate framing does not apply',
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

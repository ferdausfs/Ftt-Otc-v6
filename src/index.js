/**
 * FTT Signal Worker FTT3-v1.0.0 — entry point.
 *
 * Engine: FTT3 (src/strategy/engine.mjs) — three conditions, three timeframes,
 * ATR-percentile expiry. No grading, no confidence scores, no AI layer, no
 * hidden filters. Backtest verdict (walk-forward, OOS touched once): FAIL —
 * the engine runs as an audited data collector (results/FTT3_BACKTEST_REPORT.md).
 *
 * Crons:
 *   * /5 -> signal scanner (aligned to 5m candle closes — the only moments C2 can fire)
 *   * /2 -> result checker (resolves expired signals against the 1m feed)
 */

import { CORS_HEADERS, applyCors } from './utils/cors.js';
import { jsonResponse } from './utils/helpers.js';
import { sanitizePair, getAssetType } from './utils/pairs.js';
import { ASSET_TYPE, VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, CONFIG, SCAN_PAIRS } from './config.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { handleHealth, handlePairs, handleHistory, handleStats, handleReport } from './handlers/health.js';
import { handleSignal, handleBatch, scheduledScan } from './handlers/scan.js';
import { handleLatest } from './handlers/latest.js';
import { scheduledTracker } from './history/store.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === '*/5 * * * *') {
      // Awaited on purpose: nested waitUntil can freeze the isolate before
      // Telegram sendMessage completes (lesson from the previous engine).
      await scheduledScan(env, ctx);
      return;
    }
    if (cron && cron !== '*/2 * * * *') {
      console.warn('scheduled: unrecognised cron "' + cron + '", running result checker');
    }
    const t = await scheduledTracker(env);
    // Result notifications ride the same tick, after resolution.
    if (t && Array.isArray(t.resolved) && t.resolved.length > 0) {
      const { pushResultToSubscribers } = await import('./handlers/push.js');
      for (const r of t.resolved) {
        if (r.record) await pushResultToSubscribers({ ...r.record, result: r.result }, env);
      }
    }
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/signal' || path === '/signal' || path === '/api/batch') {
        const rl = await checkRateLimit(request, env);
        if (rl) return applyCors(rl);
      }

      let response;

      if (path === '/' || path === '/health') {
        response = await handleHealth(env);

      } else if (path === '/api/signal' || path === '/signal') {
        const rawPair = url.searchParams.get('pair') || 'EUR/USD';
        const pair = sanitizePair(rawPair);
        if (!pair) {
          response = jsonResponse({
            error: true,
            message: 'Invalid pair: "' + rawPair + '".',
            validForexCurrencies: VALID_FOREX_CURRENCIES,
            validCryptoBases: CRYPTO_BASES, validCryptoQuotes: CRYPTO_QUOTES,
            scannedPairs: SCAN_PAIRS,
            examples: SCAN_PAIRS,
          }, 400);
        } else if (getAssetType(pair) === ASSET_TYPE.CRYPTO || SCAN_PAIRS.includes(pair)) {
          response = await handleSignal(pair, env, ctx, {
            preferCache: url.searchParams.get('preferCache') === 'true',
            noPush: url.searchParams.get('nopush') === '1',
          });
        } else {
          response = jsonResponse({
            error: true,
            message: 'FTT3 scans only the pairs its backtest covered (no OTC). Scanned pairs: ' + SCAN_PAIRS.join(', '),
          }, 400);
        }

      } else if (path === '/api/signals/latest') {
        response = await handleLatest(url, env);

      } else if (path === '/api/batch') {
        response = await handleBatch(url, env, ctx);

      } else if (path === '/api/pairs') {
        response = handlePairs();

      } else if (path === '/api/history') {
        response = await handleHistory(url, env);

      } else if (path === '/api/stats') {
        response = await handleStats(url, env);

      } else if (path === '/api/report') {
        response = await handleReport(url, env);

      } else {
        response = jsonResponse({
          status: 'ok',
          message: 'FTT Signal Worker ' + CONFIG.VERSION + ' — 3-condition engine (15m EMA bias / 5m MACD cross / 1m ATR gate), no OTC',
          endpoints: {
            health: '/',
            signal: '/api/signal?pair=EUR/USD',
            latestAll: '/api/signals/latest',
            latestOne: '/api/signals/latest?pair=BTC/USD',
            batch: '/api/batch?pairs=EUR/USD,BTC/USD',
            pairs: '/api/pairs',
            history: '/api/history?pair=EUR/USD&limit=20',
            stats: '/api/stats?pair=EUR/USD',
            report: '/api/report?id=SIGNAL_ID&result=WIN',
          },
          scannedPairs: SCAN_PAIRS,
          timestamp: new Date().toISOString(),
        });
      }

      return applyCors(response);
    } catch (error) {
      console.error('Fatal:', error);
      return applyCors(jsonResponse({ error: true, message: 'Internal server error' }, 500));
    }
  },
};

/**
 * FTT Signal Worker UT-BOT-v1.0.0 — entry point.
 *
 * Engine: UT Bot Alerts (src/strategy/utBotAlerts.mjs) — an exact port of the
 * TradingView indicator (defaults a=1, c=10, Heikin Ashi off), emitting
 * buy/sell events on candle closes. The retired FTT3 engine stays in the
 * repo for the audit record (src/strategy/engine.mjs) but is no longer part
 * of the live path. Backtest win-rate framing does NOT apply to this engine:
 * the bar is exact behavioral match to TradingView, proven by
 * scripts/utbot_tests.mjs + scripts/utbot_tv_diff.mjs.
 *
 * Crons:
 *   * /15 -> signal scanner (UT Bot events on 15-minute candle closes;
 *           1min/5min-timeframe pairs surface events on the next tick)
 *   * /2  -> result checker (resolves expired signals against the 1m feed)
 */

import { CORS_HEADERS, applyCors } from './utils/cors.js';
import { jsonResponse } from './utils/helpers.js';
import { sanitizePair, getAssetType } from './utils/pairs.js';
import { ASSET_TYPE, VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, CONFIG, SCAN_PAIRS } from './config.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { handleHealth, handlePairs, handleHistory, handleStats, handleReport } from './handlers/health.js';
import { handleSignal, handleBatch, scheduledScan } from './handlers/scan.js';
import { handleLatest } from './handlers/latest.js';
import {
  handleUtBotConfigGet, handleUtBotConfigPost,
} from './handlers/utbotConfig.js';
import { scheduledTracker } from './history/store.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === '*/15 * * * *') {
      // Awaited on purpose: nested waitUntil can freeze the isolate before
      // Telegram sendMessage completes (lesson from the previous engine).
      await scheduledScan(env, ctx);
      return;
    }
    if (cron && cron !== '*/2 * * * *') {
      console.warn('scheduled: unrecognised cron "' + cron + '", running result checker');
    }
    const t = await scheduledTracker(env);
    // CFD mode (2026-09-19): the tracker only drains legacy pending records
    // into the stats ledger — results are NEVER messaged. The indicator's
    // sole output is the BUY/SELL event; no WIN/LOSS notifications exist.
    if (t && Array.isArray(t.resolved) && t.resolved.length > 0) {
      console.log('scheduled: resolved ' + t.resolved.length + ' legacy pending record(s) silently (CFD mode: no result push)');
    }
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/signal' || path === '/signal' || path === '/api/batch' || path === '/api/utbot/config') {
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
            message: 'UT Bot Alerts scans a fixed pair universe (no OTC). Scanned pairs: ' + SCAN_PAIRS.join(', '),
          }, 400);
        }

      } else if (path === '/api/signals/latest') {
        response = await handleLatest(url, env);

      } else if (path === '/api/utbot/config') {
        response = request.method === 'POST'
          ? await handleUtBotConfigPost(request, env)
          : await handleUtBotConfigGet(env);

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
          message: 'FTT Signal Worker ' + CONFIG.VERSION + ' — UT Bot Alerts (exact TradingView port), no OTC',
          endpoints: {
            health: '/',
            signal: '/api/signal?pair=EUR/USD',
            latestAll: '/api/signals/latest',
            latestOne: '/api/signals/latest?pair=BTC/USD',
            batch: '/api/batch?pairs=EUR/USD,BTC/USD',
            utbotConfig: '/api/utbot/config (GET read, POST merge-write)',
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

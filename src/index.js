/**
 * FTT Signal Worker MULTI-IND-v1.2.0 — entry point.
 *
 * Indicators (src/strategy/registry.mjs — the plug-in seam):
 *   - UT Bot Alerts (src/strategy/utBotAlerts.mjs) — exact port of the
 *     TradingView indicator (defaults a=1, c=10), buy/sell on candle closes.
 *     Bar-by-bar match to TradingView proven by scripts/utbot_tests.mjs +
 *     scripts/utbot_tv_diff.mjs.
 *   - Multi Kernel Regression [ChartPrime] (src/strategy/
 *     multiKernelRegression.mjs) — non-repaint port, Up/Down labels on the
 *     kernel-MA slope flip. Proven by scripts/mkr_tests.mjs.
 *
 * CFD style (2026-09-19/20): each indicator speaks ONLY its own output in
 * its own words; signals carry NO expiry and produce NO WIN/LOSS messages.
 * Indicators firing on the same closed candle share one combined message.
 *
 * Cron:
 *   every 15 min -> signal scanner (events on 15-minute candle closes;
 *           1min/5min-timeframe pairs surface on the next tick). The old
 *           2-minute result checker is retired — results are never messaged.
 *
 * Telegram bot UI (src/handlers/telegramBot.js):
 *   POST /api/telegram/webhook — inline-keyboard control panel (pairs,
 *           indicators, params, timeframe). Self-registered by the worker
 *           on each scan tick via ensureTelegramWebhook() and verifiable
 *           through /api/telegram/status.
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
import {
  handleTelegramUpdate, handleTelegramSetup, handleTelegramStatus, ensureTelegramWebhook,
} from './handlers/telegramBot.js';
import { scheduledTracker } from './history/store.js';

export default {
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === '*/15 * * * *') {
      // Self-heal the Telegram webhook first (cheap: one getWebhookInfo
      // call when already registered). Never let it break the scan.
      try {
        const wh = await ensureTelegramWebhook(env);
        if (!wh.ok) console.warn('webhook ensure failed: ' + (wh.error || wh.reason));
      } catch (e) { console.warn('webhook ensure threw: ' + e.message); }
      // Awaited on purpose: nested waitUntil can freeze the isolate before
      // Telegram sendMessage completes (lesson from the previous engine).
      await scheduledScan(env, ctx);
      return;
    }
    // Any other cron (legacy */2 is retired from wrangler.toml): silently
    // drain any stale pre-CFD pending records — NEVER message results.
    if (cron) console.warn('scheduled: unrecognised cron "' + cron + '", legacy pending drain');
    const t = await scheduledTracker(env);
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

      } else if (path === '/api/telegram/webhook' && request.method === 'POST') {
        // No rate limit, no CORS — Telegram's servers call this, verified
        // by the secret-token header inside the handler.
        response = await handleTelegramUpdate(request, env, ctx);

      } else if (path === '/api/telegram/setup') {
        response = await handleTelegramSetup(request, env);

      } else if (path === '/api/telegram/status') {
        response = await handleTelegramStatus(env);

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
          message: 'FTT Signal Worker ' + CONFIG.VERSION + ' — UT Bot Alerts + Multi Kernel Regression (CFD style, no expiry/results)',
          endpoints: {
            health: '/',
            signal: '/api/signal?pair=EUR/USD',
            latestAll: '/api/signals/latest',
            latestOne: '/api/signals/latest?pair=BTC/USD',
            batch: '/api/batch?pairs=EUR/USD,BTC/USD',
            utbotConfig: '/api/utbot/config (GET read, POST merge-write; per-indicator toggles under pairs.<PAIR>.indicators)',
            telegramWebhook: '/api/telegram/webhook (POST, Telegram-only, secret-header verified)',
            telegramSetup: '/api/telegram/setup?key=<one-time key> (registers webhook + seeds panel owner)',
            telegramStatus: '/api/telegram/status (webhook/owner diagnostics, no secrets)',
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

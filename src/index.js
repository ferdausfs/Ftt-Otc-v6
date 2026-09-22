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
 * Cron resilience (v1.8.0, see AGENT_LOG.md — the platform trigger has gone
 *   silent before): the scan watchdog (src/handlers/scan.js) is invoked by
 *   THREE independent paths — any HTTP request, the external heartbeat
 *   (GitHub Actions heartbeat.yml -> GET /watchdog every 5 min) and a
 *   Durable Object alarm re-arming itself every 5 min
 *   (src/handlers/heartbeatDO.js). On staleness it auto-repairs the cron
 *   trigger via the CF API, Telegram-alerts the owner chat in real time,
 *   then runs the catch-up scan. /watchdog?drill=1&key=<WATCHDOG_DRILL_KEY>
 *   simulates a stale cursor to verify alerting + healing on demand.
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
import { handleSignal, handleBatch, scheduledScan, runScanWatchdog } from './handlers/scan.js';
import { bootstrapHeartbeat, HeartbeatDO } from './handlers/heartbeatDO.js';

// Durable Object classes MUST be exported from the entry module.
export { HeartbeatDO };
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
    // Keep the DO alarm heartbeat armed (cheap: one getAlarm RPC; arms only
    // when no alarm is pending). Independent of which cron fired.
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(bootstrapHeartbeat(env)); } catch (e) { /* never break the scan */ }
    }
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

    let watchdogDispatched = false;   // /watchdog route runs it explicitly
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

      } else if (path === '/watchdog') {
        // Dedicated heartbeat target (external pinger / DO alarm companion).
        // AWAITS runScanWatchdog so the pinger's log shows the real outcome
        // (reason 'fresh' normally; staleness -> alert + catch-up). A catch-up
        // scan can take up to ~60s — heartbeat clients use a >=120s timeout.
        // Drill (ops verification): ?drill=1&key=<WATCHDOG_DRILL_KEY> simulates
        // a stale cursor end-to-end (alert + catch-up); without the secret the
        // flag is ignored, so the endpoint is safe to expose.
        const key = url.searchParams.get('key') || '';
        const drill = url.searchParams.get('drill') === '1'
          && !!env.WATCHDOG_DRILL_KEY
          && key === String(env.WATCHDOG_DRILL_KEY).trim();
        watchdogDispatched = true;   // skip the finally-block double-fire
        const wd = await runScanWatchdog(env, ctx, Date.now(), { forceStale: drill });
        if (ctx && typeof ctx.waitUntil === 'function') {
          try { ctx.waitUntil(bootstrapHeartbeat(env)); } catch (e) { /* noop */ }
        }
        response = jsonResponse({ ok: true, watchdog: wd, drill, timestamp: new Date().toISOString() });

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
            watchdog: '/watchdog (heartbeat: runs the scan watchdog; ?drill=1&key=<secret> simulates staleness)',
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
    } finally {
      // Cron-resilience watchdog: if the platform cron goes silent again, any
      // HTTP request self-heals the scan (lock-guarded, no-op when fresh).
      // Skipped for /watchdog, which runs it explicitly and awaits the result.
      if (!watchdogDispatched && request.method !== 'OPTIONS' && ctx && typeof ctx.waitUntil === 'function') {
        try { ctx.waitUntil(runScanWatchdog(env, ctx)); } catch (e) { /* never break the response */ }
      }
    }
  },
};

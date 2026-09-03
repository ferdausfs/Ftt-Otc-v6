/**
 * FTT Signal Worker Sig-v1.0.0 (playbook engine)
 * Cloudflare Worker Entry Point
 */

import { CORS_HEADERS, applyCors } from './utils/cors.js';
import { jsonResponse } from './utils/helpers.js';
import { sanitizePair } from './utils/pairs.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { handleHealth, handlePairs, handleHistory, handleStats, handleReport, handleCalib } from './handlers/health.js';
import { handleSignal, handleBatch } from './handlers/signal.js';
import { handleLatest } from './handlers/latest.js';
import { scheduledTracker } from './history/stats.js';
import { scheduledScan } from './handlers/scheduledScan.js';
import { resolveShadowObservations } from './history/r71store.js';
import { resolveD2ShadowObservations } from './history/d2store.js';
import { resolveProbeObservations } from './history/probeStore.js';
import { resolveV7ShadowObservations } from './history/v7store.js';
// Self-calibration (C7): weekly recompute of the calibration tables.
import { recomputeCalibration } from './history/selfCalib.js';
import { CONFIG, VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES } from './config.js';
// PR #15 nested SELF_CALIB inside CONFIG (CONFIG.SELF_CALIB); derive the
// top-level alias here so the cron branch below stays readable.
const SELF_CALIB = CONFIG.SELF_CALIB;

export default {
  /**
   * Two crons share this handler (wrangler.toml `crons`):
   *   * / 2 * * * *  -> result checker (Phase B)
   *   * / 5 * * * *  -> signal scanner (Phase 7)
   *
   * `event.cron` carries the pattern that fired. If a runtime ever omits it we
   * fall back to the result checker, which is the cheaper and more critical of
   * the two — a missed scan self-heals on the next tick, a missed result check
   * delays win/loss resolution.
   */
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === '*/5 * * * *') {
      // Await the scan (do NOT wrap-and-return). Nested waitUntil(scan) →
      // waitUntil(saveAndPush) can drop the inner push when the scan
      // promise resolves. Awaiting keeps the scheduled handler live until
      // every pair's save+push attempt has finished.
      await scheduledScan(env, ctx);
      return;
    }
    // Self-calibration (C7): weekly refresh of the calibration tables
    // (SELF_CALIB.CRON = Monday 00:00 UTC, see wrangler.toml [triggers]).
    // Recompute runs off the tick; the engine picks up calib:latest on the
    // next signal request. Fail-open: fewer than MIN_OBS rows keeps the
    // previous tables (recomputeCalibration returns null without writing).
    if (cron === SELF_CALIB.CRON) {
      ctx.waitUntil(recomputeCalibration(env));
      return;
    }
    if (cron && cron !== '*/2 * * * *') {
      console.warn('scheduled: unrecognised cron pattern "' + cron + '", running result checker');
    }
    ctx.waitUntil(scheduledTracker(env));
    // R7.1: resolve private shadow observations on the same result-checker tick.
    // Pending TTL (~2h) aligns with the normal result-resolution window.
    ctx.waitUntil(resolveShadowObservations(env));
    // D2 Shadow: resolve private D2-blocked counterfactuals on the same tick.
    ctx.waitUntil(resolveD2ShadowObservations(env));
    // Forex SELL Probe: resolve private probe observations on the same tick.
    ctx.waitUntil(resolveProbeObservations(env));
    // V7 Shadow: resolve next-gen counterfactuals on the same tick.
    ctx.waitUntil(resolveV7ShadowObservations(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      const url  = new URL(request.url);
      const path = url.pathname;

      // Rate limit signal + batch endpoints
      if (path === '/api/signal' || path === '/signal' || path === '/api/batch') {
        const rl = await checkRateLimit(request, env);
        if (rl) return applyCors(rl);
      }

      let response;

      if (path === '/' || path === '/health') {
        response = await handleHealth(env);

      } else if (path === '/api/signal' || path === '/signal') {
        const rawPair = url.searchParams.get('pair') || 'EUR/USD';
        const pair    = sanitizePair(rawPair);
        if (!pair) {
          response = jsonResponse({
            error: true,
            message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.',
            validForexCurrencies: VALID_FOREX_CURRENCIES,
            validCryptoBases: CRYPTO_BASES, validCryptoQuotes: CRYPTO_QUOTES,
            examples: ['EUR/USD','GBP/JPY','BTC/USD','ETH/EUR','SOL/USDT','EURUSD-OTC'],
          }, 400);
        } else {
          const preferCache = url.searchParams.get('preferCache') === 'true';
          response = await handleSignal(pair, env, ctx, { preferCache, fxMode: url.searchParams.get('mode') === 'fx', noPush: url.searchParams.get('nopush') === '1' });
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

      } else if (path === '/api/calib') {
        response = await handleCalib(env);

      } else if (path === '/api/report') {
        response = await handleReport(url, env);

      } else {
        response = jsonResponse({
          status: 'ok',
          message: 'FTT Signal Worker Sig-v1.0.0 (playbook engine) — Forex + Crypto + OTC + History Tracking',
          endpoints: {
            health:    '/',
            signal:    '/api/signal?pair=EUR/USD',
            signalCached: '/api/signal?pair=EUR/USD&preferCache=true',
            latestAll: '/api/signals/latest',
            latestOne: '/api/signals/latest?pair=BTC/USD',
            signalOTC: '/api/signal?pair=EURUSD-OTC',
            crypto:    '/api/signal?pair=BTC/USD',
            batch:     '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD',
            pairs:     '/api/pairs',
            history:   '/api/history?pair=EUR/USD&limit=20',
            stats:     '/api/stats?pair=EUR/USD',
            report:    '/api/report?id=SIGNAL_ID&result=WIN',
          },
          supportedAssets: ['FOREX (40+ currencies)', 'CRYPTO (Top 10)', 'OTC (Olymp Trade)'],
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

/**
 * FTT Signal Worker v6.9.2
 * Cloudflare Worker Entry Point
 */

import { CORS_HEADERS, applyCors } from './utils/cors.js';
import { jsonResponse } from './utils/helpers.js';
import { sanitizePair } from './utils/pairs.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { handleHealth, handlePairs, handleHistory, handleStats, handleReport } from './handlers/health.js';
import { handleSignal, handleBatch } from './handlers/signal.js';
import { handleLatest } from './handlers/latest.js';
import { scheduledTracker } from './history/stats.js';
import { scheduledScan } from './handlers/scheduledScan.js';
import { resolveShadowObservations } from './history/r71store.js';
import { resolveD2ShadowObservations } from './history/d2store.js';
import { resolveProbeObservations } from './history/probeStore.js';
import { VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES } from './config.js';

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
      ctx.waitUntil(scheduledScan(env, ctx));
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
          response = await handleSignal(pair, env, ctx, { preferCache });
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
          message: 'FTT Signal Worker v6.9.2 — Forex + Crypto + OTC + History Tracking',
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

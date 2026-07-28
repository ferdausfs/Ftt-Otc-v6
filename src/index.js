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
import { scheduledTracker } from './history/stats.js';
import { VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES } from './config.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTracker(env));
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
          response = await handleSignal(pair, env, ctx);
        }

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

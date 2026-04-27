// ============================================================
// FTT SIGNAL WORKER v6.9.0
// Cloudflare Worker — Multi-Timeframe Binary Trading Signal
// Forex + Crypto + OTC (Olymp Trade) + Win/Loss History
//
// QUICK NAVIGATION — edit the file for each feature:
//
// ┌─ TUNE PARAMETERS ──────────────────────────────────────────
// │  src/config/trading.js        → confidence, weights, TTL
// ├─ ADD CURRENCIES ───────────────────────────────────────────
// │  src/constants/pairs.js       → FOREX/CRYPTO pairs
// ├─ INDICATORS ───────────────────────────────────────────────
// │  src/indicators/core.js       → SMA/EMA/RSI/MACD/ATR/BB
// │  src/indicators/patterns.js   → S/R, FVG, candlestick
// │  src/indicators/divergence.js → RSI/MACD divergence
// │  src/analysis/camarilla.js    → Camarilla pivot levels
// ├─ SIGNAL ENGINE ────────────────────────────────────────────
// │  src/analysis/timeframe.js    → per-TF scoring logic
// │  src/analysis/multiTF.js      → final signal + confidence
// │  src/analysis/regime.js       → market regime system
// ├─ OTC TRADING ──────────────────────────────────────────────
// │  src/otc/patterns.js          → OTC price action patterns
// │  src/otc/analyzer.js          → OTC TF analysis
// │  src/otc/handler.js           → OTC signal builder
// ├─ AI VALIDATION ────────────────────────────────────────────
// │  src/ai/cerebras.js           → Cerebras Llama validation
// │  src/ai/groq.js               → Groq dual-AI validation
// │  src/otc/cerebrasOTC.js       → OTC-specific AI prompt
// ├─ HISTORY & STATS ──────────────────────────────────────────
// │  src/history/storage.js       → KV save signal
// │  src/history/tracker.js       → cron win/loss checker
// │  src/history/stats.js         → dynamic confidence
// ├─ API ENDPOINTS ────────────────────────────────────────────
// │  src/handlers/health.js       → GET /
// │  src/handlers/signal.js       → GET /api/signal
// │  src/handlers/batch.js        → GET /api/batch
// │  src/handlers/history.js      → GET /api/history
// │  src/handlers/stats.js        → GET /api/stats
// │  src/handlers/report.js       → GET /api/report
// └────────────────────────────────────────────────────────────
// ============================================================

import { applyCors, jsonResponse } from './utils/response.js';
import { sanitizePair } from './utils/pair.js';
import { checkRateLimit } from './middleware/rateLimit.js';
import { handleHealth, handlePairs } from './handlers/health.js';
import { handleSignal } from './handlers/signal.js';
import { handleBatch } from './handlers/batch.js';
import { handleHistory } from './handlers/history.js';
import { handleStats } from './handlers/stats.js';
import { handleReport } from './handlers/report.js';
import { scheduledTracker } from './history/tracker.js';
import { VALID_FOREX_CURRENCIES } from './constants/pairs.js';
import { CRYPTO_BASES, CRYPTO_QUOTES } from './constants/pairs.js';

// Re-export for Cloudflare Worker runtime
export default {
  // [v6.9.0] Cron trigger — runs every minute to check expired signals
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledTracker(env));
  },

  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/signal' || path === '/signal' || path === '/api/batch') {
        const rl = await checkRateLimit(request, env);
        if (rl) return applyCors(rl, corsHeaders);
      }

      let response;

      if (path === '/' || path === '/health') {
        response = handleHealth(env);
      } else if (path === '/api/signal' || path === '/signal') {
        const rawPair = url.searchParams.get('pair') || 'EUR/USD';
        const pair = sanitizePair(rawPair);
        if (!pair) {
          response = jsonResponse({
            error: true,
            message: 'Invalid pair: "' + rawPair + '". Use EUR/USD, EURUSD, BTC/USD, BTCUSD etc.',
            validForexCurrencies: VALID_FOREX_CURRENCIES,
            validCryptoBases: CRYPTO_BASES,
            validCryptoQuotes: CRYPTO_QUOTES,
            examples: ['EUR/USD', 'GBP/JPY', 'BTC/USD', 'ETH/EUR', 'SOL/USDT'],
          }, 400);
        } else {
          response = await handleSignal(pair, env, ctx);
        }
      } else if (path === '/api/batch') {
        // [v6.2] Multi-pair batch endpoint
        response = await handleBatch(url, env, ctx);
      } else if (path === '/api/pairs') {
        response = handlePairs();
      } else if (path === '/api/history') {
        // [v6.9.0] Signal history endpoint
        response = await handleHistory(url, env);
      } else if (path === '/api/stats') {
        // [v6.9.0] Win rate stats endpoint
        response = await handleStats(url, env);
      } else if (path === '/api/report') {
        // [v6.9.0] Manual OTC win/loss report
        response = await handleReport(url, env);
      } else {
        response = jsonResponse({
          status: 'ok',
          message: 'FTT Signal Worker v6.9.0 — Forex + Crypto + OTC + History Tracking',
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

      return applyCors(response, corsHeaders);
    } catch (error) {
      console.error('Fatal:', error);
      return applyCors(
        jsonResponse({ error: true, message: 'Internal server error' }, 500),
        corsHeaders
      );
    }
  },
}
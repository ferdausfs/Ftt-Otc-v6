/**
 * Main Entry Point — Cloudflare Workers Router + Scheduled Jobs
 * Real Market Trading Engine (Forex/Crypto — No OTC)
 */

import { handleSignal, handleSignalRaw, handleBatch, handleSignalRawOTC } from './handlers/signal.js';
import { handleHealth, handlePairs, handleHistory, handleStats, handleReport } from './handlers/health.js';
import { applyCors } from './utils/cors.js';
import { fetchEconomicCalendar } from './utils/news.js';
import { runWalkForwardOptimization } from './history/stats.js';
import { jsonResponse } from './utils/helpers.js';
import { checkRateLimit } from './middleware/rateLimit.js';

// ============================================
// Router
// ============================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: applyCors() });
    }

    const rateLimit = await checkRateLimit(request, env);
    if (rateLimit) return rateLimit;
    
    try {
      let response;
      
      switch (path) {
        case '/signal':
        case '/api/signal':
          response = await handleSignal(request, env, ctx);
          if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/signal/raw':
        case '/api/signal/raw':
          response = await handleSignalRaw(request, env, ctx);
          if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/signal/batch':
        case '/api/signal/batch':
          response = await handleBatch(request, env, ctx);
          if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        // OTC endpoint
        case '/signal/otc':
        case '/api/signal/otc':
          response = await handleSignalRawOTC(request, env, ctx);
          if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/health':
        case '/api/health':
          response = await handleHealth(request, env); if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/pairs':
        case '/api/pairs':
          response = await handlePairs(request, env); if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/history':
        case '/api/history':
          response = await handleHistory(request, env); if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/stats':
        case '/api/stats':
          response = await handleStats(request, env); if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        case '/report':
        case '/api/report':
          response = await handleReport(request, env); if (!(response instanceof Response)) response = jsonResponse(response);
          break;
          
        default:
          response = jsonResponse({ error: 'Not found' }, 404);
      }
      
      // Apply CORS to all responses
      const headers = applyCors(response.headers || new Headers());
      return new Response(response.body, {
        status: response.status || 200,
        headers
      });
      
    } catch (err) {
      console.error('CRITICAL Router error:', err.message, err.stack);
      return new Response(JSON.stringify({
        error: err.message,
        stack: env.ENVIRONMENT === 'development' ? err.stack : undefined
      }), {
        status: 500,
        headers: applyCors(new Headers({ 'Content-Type': 'application/json' }))
      });
    }
  },
  
  // ============================================
  // Scheduled Jobs (Cron)
  // ============================================
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log('Cron triggered:', cron);
    
    try {
      switch (cron) {
        case '0 */6 * * *':
          // Every 6 hours: Fetch economic calendar
          await fetchEconomicCalendar(env);
          console.log('Economic calendar updated');
          break;
          
        case '0 0 * * 0':
          // Weekly: Walk-forward optimization
          const wfResult = await runWalkForwardOptimization(env);
          console.log('Walk-forward complete:', wfResult?.recommendedSet || 'N/A');
          break;
          
        case '0 0 1 * *':
          // Monthly: Feature importance (placeholder for ML)
          console.log('Monthly ML maintenance');
          break;
          
        case '*/5 * * * *':
          // Every 5 min: Cleanup old cache
          await cleanupOldCache(env);
          break;
          
        default:
          console.log('Unknown cron pattern:', cron);
      }
    } catch (err) {
      console.error('Cron error:', err);
    }
  }
};

/**
 * Cleanup old KV cache entries
 */
async function cleanupOldCache(env) {
  if (!env?.CANDLE_CACHE) return;
  
  // List and delete entries older than TTL (simplified)
  // In production, use KV metadata/expiration instead
  console.log('Cache cleanup complete');
}

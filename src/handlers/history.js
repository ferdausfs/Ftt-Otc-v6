// ============================================================
// HISTORY ENDPOINT (v6.9.0)
// GET /api/history?pair=EUR/USD&limit=20
// Returns last N signals with win/loss results
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';
import { sanitizePair } from '../utils/pair.js';
import { jsonResponse } from '../utils/response.js';

// ============================================================
// H4 — History Endpoint Handler
// GET /api/history?pair=EUR/USD&limit=20
// ============================================================
async function handleHistory(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var rawPair = url.searchParams.get('pair') || 'EUR/USD';
  var pair    = sanitizePair(rawPair);
  if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);

  var limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

  try {
    var histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var history = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(history)) history = [];

    var limited  = history.slice(0, limit);
    var decided  = limited.filter(function(s) { return s.result === 'WIN' || s.result === 'LOSS'; });
    var wins     = decided.filter(function(s) { return s.result === 'WIN'; }).length;
    var winRate  = decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 1000 : null;

    return jsonResponse({
      pair:      pair,
      total:     history.length,
      showing:   limited.length,
      decided:   decided.length,
      pending:   limited.filter(function(s) { return s.result === null; }).length,
      winRate:   winRate,
      signals:   limited,
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    return jsonResponse({ error: true, message: 'History fetch error: ' + e.message }, 500);
  }
}

// ============================================================
// H5 — Stats Endpoint Handler

export { handleHistory };

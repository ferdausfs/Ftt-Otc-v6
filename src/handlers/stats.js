// ============================================================
// STATS ENDPOINT (v6.9.0)
// GET /api/stats              →  all pairs summary
// GET /api/stats?pair=EUR/USD →  single pair stats
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';
import { sanitizePair } from '../utils/pair.js';
import { jsonResponse } from '../utils/response.js';
import { getDynamicConfidenceAdjustment } from '../history/stats.js';

// H5 — Stats Endpoint Handler
// GET /api/stats?pair=EUR/USD (pair optional — all pairs if omitted)
// ============================================================
async function handleStats(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var rawPair = url.searchParams.get('pair');

  try {
    if (rawPair) {
      // Single pair stats
      var pair = sanitizePair(rawPair);
      if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);

      var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
      var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');

      if (!stats) {
        return jsonResponse({
          pair:    pair,
          message: 'No stats yet. Signal history will build up over time.',
          stats:   null,
          timestamp: new Date().toISOString(),
        });
      }

      // Add dynamic confidence adjustment info
      var confAdj = await getDynamicConfidenceAdjustment(pair, env);
      stats.dynamicConfidenceAdjustment = confAdj > 0 ? '+' + confAdj : String(confAdj);

      return jsonResponse({ pair: pair, stats: stats, timestamp: new Date().toISOString() });
    } else {
      // All pairs — list all stats keys
      var allStats = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_STATS_PREFIX });
      if (!allStats || !allStats.keys || allStats.keys.length === 0) {
        return jsonResponse({ message: 'No stats yet.', pairs: [], timestamp: new Date().toISOString() });
      }

      var summary = [];
      for (var ki = 0; ki < allStats.keys.length; ki++) {
        try {
          var st = await env.SIGNAL_CACHE.get(allStats.keys[ki].name, 'json');
          if (st) summary.push({
            pair:         st.pair,
            winRate:      st.winRate,
            totalSignals: st.totalSignals,
            wins:         st.wins,
            losses:       st.losses,
            lastUpdated:  st.lastUpdated,
          });
        } catch(e) {}
      }

      summary.sort(function(a, b) { return (b.winRate || 0) - (a.winRate || 0); });

      return jsonResponse({
        totalPairs: summary.length,
        pairs:      summary,
        timestamp:  new Date().toISOString(),
      });
    }
  } catch(e) {
    return jsonResponse({ error: true, message: 'Stats error: ' + e.message }, 500);
  }
}

// ============================================================
// H6 — Manual OTC Report Endpoint
// GET /api/report?id=SIGNAL_ID&result=WIN

export { handleStats };

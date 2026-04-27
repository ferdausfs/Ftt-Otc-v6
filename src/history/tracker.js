// ============================================================
// SCHEDULED WIN/LOSS TRACKER (v6.9.0)
// Cron: every minute — checks expired signals, fetches result
// Requires wrangler.toml cron trigger + SIGNAL_CACHE KV
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';
import { updatePairStats } from './stats.js';
import { getApiKeys } from '../fetcher/keys.js';

// Runs every minute — checks expired pending signals
// ============================================================
async function scheduledTracker(env) {
  if (!env.SIGNAL_CACHE) return;

  try {
    // List all pending signal keys
    var pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return;

    var now = Date.now();
    var checked = 0;

    for (var ki = 0; ki < pendingList.keys.length; ki++) {
      var kvKey = pendingList.keys[ki].name;
      try {
        var record = await env.SIGNAL_CACHE.get(kvKey, 'json');
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvKey);
          continue;
        }

        var expiryMs  = new Date(record.expiryTime).getTime();
        var checkAfterMs = expiryMs + (HISTORY_CONFIG.RESULT_CHECK_DELAY * 1000);

        // Not expired yet — skip
        if (now < checkAfterMs) continue;

        // Expired — fetch result candle price
        var exitPrice = await fetchExpiryPrice(record.pair, record.expiryTime, env);
        if (exitPrice === null) {
          // Price fetch failed — mark UNKNOWN and remove pending
          await updateSignalResult(record, 'UNKNOWN', null, env);
          await env.SIGNAL_CACHE.delete(kvKey);
          continue;
        }

        // Determine WIN / LOSS
        var winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null) {
          if (record.direction === 'BUY') {
            winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          } else if (record.direction === 'SELL') {
            winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
          }
        }

        await updateSignalResult(record, winLoss, exitPrice, env);
        await env.SIGNAL_CACHE.delete(kvKey); // Remove from pending
        await updatePairStats(record.pair, winLoss, record, env); // Update stats

        checked++;
        if (checked >= 10) break; // Max 10 per cron run to avoid timeout
      } catch(e) {
        console.warn('Cron check error for ' + kvKey + ':', e.message);
        try { await env.SIGNAL_CACHE.delete(kvKey); } catch(e2) {}
      }
    }

    if (checked > 0) console.log('Cron: checked ' + checked + ' expired signals');
  } catch(e) {
    console.warn('scheduledTracker error:', e.message);
  }
}

// Fetch the close price of the candle at expiry time
async function fetchExpiryPrice(pair, expiryTimeISO, env) {
  try {
    var apiKeys = getApiKeys(env);
    if (apiKeys.length === 0) return null;

    // Use 1min candle — fetch 5 candles around expiry to find the right one
    var symbol   = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
    var apiKey   = apiKeys[0];
    var u = new URL('/time_series', CONFIG.API_BASE_URL);
    u.searchParams.set('symbol',     symbol);
    u.searchParams.set('interval',   '1min');
    u.searchParams.set('outputsize', '5');
    u.searchParams.set('apikey',     apiKey);
    u.searchParams.set('format',     'JSON');

    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 8000);
    var res;
    try {
      res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    } finally { clearTimeout(tid); }

    if (!res.ok) return null;
    var data = await res.json();
    if (!data.values || !Array.isArray(data.values) || data.values.length === 0) return null;

    // Find candle closest to expiry time
    var expiryMs = new Date(expiryTimeISO).getTime();
    var closest  = null;
    var minDiff  = Infinity;

    for (var i = 0; i < data.values.length; i++) {
      var c    = data.values[i];
      var cMs  = new Date(c.datetime).getTime();
      var diff = Math.abs(cMs - expiryMs);
      if (diff < minDiff) { minDiff = diff; closest = c; }
    }

    // Accept if within 2 minutes of expiry
    if (closest && minDiff <= 120000) {
      return parseFloat(closest.close);
    }
    return null;
  } catch(e) {
    console.warn('fetchExpiryPrice error:', e.message);
    return null;
  }
}

// Update signal result in pair history KV
async function updateSignalResult(record, winLoss, exitPrice, env) {
  try {
    var histKey  = HISTORY_CONFIG.KV_SIGNAL_PREFIX + record.pair.replace(/\//g, '_').replace(/-/g, '_');
    var existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(existing)) return;

    for (var i = 0; i < existing.length; i++) {
      if (existing[i].id === record.id) {
        existing[i].result    = winLoss;
        existing[i].exitPrice = exitPrice;
        existing[i].checkedAt = new Date().toISOString();
        break;
      }
    }

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(existing), {
      expirationTtl: 60 * 60 * 24 * 30,
    });
  } catch(e) {
    console.warn('updateSignalResult error:', e.message);
  }
}

// ============================================================
// H3 — Dynamic Confidence Adjustment per Pair
// Last N signal এর win rate দেখে confidence adjust করে
// ============================================================
async function getDynamicConfidenceAdjustment(pair, env) {

export { scheduledTracker, fetchExpiryPrice, updateSignalResult };

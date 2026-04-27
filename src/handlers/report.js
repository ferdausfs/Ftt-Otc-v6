// ============================================================
// MANUAL OTC REPORT ENDPOINT (v6.9.0)
// GET /api/report?id=SIGNAL_ID&result=WIN
// Use for OTC trades where auto-tracking can't verify
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';
import { jsonResponse } from '../utils/response.js';
import { updatePairStats } from '../history/stats.js';

// ============================================================
// H6 — Manual OTC Report Endpoint
// GET /api/report?id=SIGNAL_ID&result=WIN
// OTC এর জন্য — manual win/loss report
// ============================================================
async function handleReport(url, env) {
  if (!env.SIGNAL_CACHE) {
    return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  }

  var signalId = url.searchParams.get('id');
  var result   = (url.searchParams.get('result') || '').toUpperCase();

  if (!signalId) return jsonResponse({ error: true, message: 'Signal ID required: ?id=SIGNAL_ID' }, 400);
  if (!['WIN', 'LOSS'].includes(result)) {
    return jsonResponse({ error: true, message: 'result must be WIN or LOSS' }, 400);
  }

  try {
    // Search through all history keys to find this signal ID
    var allKeys = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX });
    if (!allKeys || !allKeys.keys || allKeys.keys.length === 0) {
      return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);
    }

    var found = false;
    var foundRecord = null;

    for (var ki = 0; ki < allKeys.keys.length; ki++) {
      try {
        var histKey = allKeys.keys[ki].name;
        var history = await env.SIGNAL_CACHE.get(histKey, 'json');
        if (!Array.isArray(history)) continue;

        for (var i = 0; i < history.length; i++) {
          if (history[i].id === signalId) {
            foundRecord          = history[i];
            history[i].result   = result;
            history[i].checkedAt = new Date().toISOString();
            history[i].reportedManually = true;
            await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), {
              expirationTtl: 60 * 60 * 24 * 30,
            });
            found = true;
            break;
          }
        }
        if (found) break;
      } catch(e) {}
    }

    if (!found) return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);

    // Update stats for this pair
    if (foundRecord) {
      await updatePairStats(foundRecord.pair, result, foundRecord, env);
    }

    return jsonResponse({
      success:  true,
      signalId: signalId,
      pair:     foundRecord ? foundRecord.pair : 'N/A',
      result:   result,
      message:  'Result recorded. Stats updated.',
      timestamp: new Date().toISOString(),
    });
  } catch(e) {
    return jsonResponse({ error: true, message: 'Report error: ' + e.message }, 500);
  }
}

export { handleReport };

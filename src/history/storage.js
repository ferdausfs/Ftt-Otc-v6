// ============================================================
// SIGNAL HISTORY STORAGE (v6.9.0)
// Saves signals to KV — max 50 per pair (configurable)
// Enables win/loss tracking and dynamic confidence
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';

// ============================================================
// [v6.9.0] PHASE 2 — SIGNAL HISTORY & WIN/LOSS TRACKING
// ============================================================

// Generate unique signal ID
function generateSignalId(pair, timestamp) {
  var ts   = new Date(timestamp).getTime();
  var hash = pair.replace(/[^A-Z]/g, '').slice(0, 6);
  var rand = Math.floor(Math.random() * 9000 + 1000);
  return hash + '_' + ts + '_' + rand;
}

// ============================================================
// H1 — Save signal to KV history
// ============================================================
async function saveSignalToHistory(result, env) {
  if (!env.SIGNAL_CACHE) return;

  try {
    var pair      = result.pair;
    var signal    = result.signal;
    var isOTC     = result.isOTC || false;
    var now       = result.timestamp || new Date().toISOString();
    var signalId  = generateSignalId(pair, now);

    // Best TF expiry time — used for result checking
    var expiryTime = null;
    var bestTF     = signal.bestTimeframe;
    if (bestTF && bestTF.expiry && bestTF.expiry.expiryTime) {
      expiryTime = bestTF.expiry.expiryTime;
    }

    // Entry price from best TF
    var entryPrice = null;
    if (bestTF && bestTF.expiry) {
      var btfKey = bestTF.timeframe;
      var btfRec = signal.recommendations && signal.recommendations[btfKey];
      if (btfRec && btfRec.entry) entryPrice = btfRec.entry.price;
    }

    var record = {
      id:           signalId,
      pair:         pair,
      isOTC:        isOTC,
      direction:    signal.finalSignal,
      confidence:   signal.confidence,
      grade:        signal.grade ? signal.grade.grade : 'N/A',
      entryPrice:   entryPrice,
      expiryTime:   expiryTime,
      bestTF:       bestTF ? bestTF.timeframe : 'N/A',
      alignment:    signal.alignment,
      marketRegime: signal.marketRegime,
      session:      result.session ? result.session.sessions : [],
      sessionQuality: result.session ? result.session.quality : 'N/A',
      aiAgreed:     signal.aiValidation ? signal.aiValidation.combinedAgreed : null,
      timestamp:    now,
      result:       null,   // WIN / LOSS / UNKNOWN — filled later
      exitPrice:    null,
      checkedAt:    null,
    };

    // Save to pair history list
    var histKey  = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var existing = null;
    try {
      existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    } catch(e) { existing = null; }

    var history = Array.isArray(existing) ? existing : [];
    history.unshift(record); // newest first
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR) {
      history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
    }

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    // Save to pending queue (for result checking) — only non-OTC
    if (!isOTC && expiryTime) {
      var pendingKey = HISTORY_CONFIG.KV_PENDING_PREFIX + signalId;
      await env.SIGNAL_CACHE.put(pendingKey, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 2, // 2 hours — auto cleanup
      });
    }

    console.log('Signal saved:', signalId, pair, signal.finalSignal);
  } catch(e) {
    console.warn('saveSignalToHistory error:', e.message);
  }
}

// ============================================================
// H2 — Scheduled Cron Tracker
// Runs every minute — checks expired pending signals

export { generateSignalId, saveSignalToHistory };

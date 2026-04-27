// ============================================================
// DYNAMIC CONFIDENCE & WIN RATE STATS (v6.9.0)
// Adjusts confidence based on last 20 signals per pair
// GET /api/stats to see pair-level win rates
// ============================================================
import { HISTORY_CONFIG } from '../config/trading.js';

async function getDynamicConfidenceAdjustment(pair, env) {
  if (!env.SIGNAL_CACHE) return 0;

  try {
    var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');
    if (!stats || typeof stats.winRate !== 'number' || stats.sampleSize < 5) return 0;

    var wr = stats.winRate;

    if (wr >= 0.70) return HISTORY_CONFIG.CONFIDENCE_BONUS;          // 70%+ → +6
    if (wr >= HISTORY_CONFIG.CONFIDENCE_BONUS_THRESHOLD) return 3;   // 65-70% → +3
    if (wr <= 0.35) return HISTORY_CONFIG.CONFIDENCE_PENALTY;        // 35%- → -10
    if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5; // 35-45% → -5
    return 0; // 45-65% → neutral
  } catch(e) {
    return 0;
  }
}

// Update pair stats after result
async function updatePairStats(pair, winLoss, record, env) {
  if (!env.SIGNAL_CACHE || winLoss === 'UNKNOWN') return;
  try {
    var statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
    var stats    = await env.SIGNAL_CACHE.get(statsKey, 'json');

    if (!stats) {
      stats = {
        pair:       pair,
        totalSignals: 0,
        wins:       0,
        losses:     0,
        winRate:    0,
        sampleSize: 0,
        bySession:  {},
        byTF:       {},
        byRegime:   {},
        lastUpdated: null,
      };
    }

    stats.totalSignals++;
    if (winLoss === 'WIN')  stats.wins++;
    if (winLoss === 'LOSS') stats.losses++;

    var decided = stats.wins + stats.losses;
    stats.winRate    = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
    stats.sampleSize = Math.min(decided, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
    stats.lastUpdated = new Date().toISOString();

    // Session breakdown
    var sessions = record.session || [];
    for (var si = 0; si < sessions.length; si++) {
      var sess = sessions[si];
      if (!stats.bySession[sess]) stats.bySession[sess] = { wins: 0, losses: 0, winRate: 0 };
      if (winLoss === 'WIN')  stats.bySession[sess].wins++;
      if (winLoss === 'LOSS') stats.bySession[sess].losses++;
      var sd = stats.bySession[sess].wins + stats.bySession[sess].losses;
      stats.bySession[sess].winRate = sd > 0 ? Math.round((stats.bySession[sess].wins / sd) * 1000) / 1000 : 0;
    }

    // TF breakdown
    var tf = record.bestTF || 'N/A';
    if (!stats.byTF[tf]) stats.byTF[tf] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === 'WIN')  stats.byTF[tf].wins++;
    if (winLoss === 'LOSS') stats.byTF[tf].losses++;
    var td = stats.byTF[tf].wins + stats.byTF[tf].losses;
    stats.byTF[tf].winRate = td > 0 ? Math.round((stats.byTF[tf].wins / td) * 1000) / 1000 : 0;

    // Regime breakdown
    var regime = record.marketRegime || 'UNKNOWN';
    if (!stats.byRegime[regime]) stats.byRegime[regime] = { wins: 0, losses: 0, winRate: 0 };
    if (winLoss === 'WIN')  stats.byRegime[regime].wins++;
    if (winLoss === 'LOSS') stats.byRegime[regime].losses++;
    var rd = stats.byRegime[regime].wins + stats.byRegime[regime].losses;
    stats.byRegime[regime].winRate = rd > 0 ? Math.round((stats.byRegime[regime].wins / rd) * 1000) / 1000 : 0;

    await env.SIGNAL_CACHE.put(statsKey, JSON.stringify(stats), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 days
    });
  } catch(e) {
    console.warn('updatePairStats error:', e.message);
  }
}

// ============================================================

export { getDynamicConfidenceAdjustment, updatePairStats };

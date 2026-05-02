import { HISTORY_CONFIG } from '../config.js';
import { CONFIG } from '../config.js';

function pairKey(pair) {
  return pair.replace(/\//g, '_').replace(/-/g, '_');
}

export async function saveSignalToHistory(signal, pair, isOTC, env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const now       = new Date().toISOString();
    const signalId  = 'sig_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const bestTF    = signal.bestTimeframe || null;
    const entryPrice = signal.recommendations && bestTF
      ? (signal.recommendations[bestTF.timeframe] && signal.recommendations[bestTF.timeframe].entry ? signal.recommendations[bestTF.timeframe].entry.price : null)
      : null;
    const expiryTime = bestTF && bestTF.expiry ? bestTF.expiry.expiryTime : null;

    const record = {
      id: signalId, pair, isOTC,
      direction:    signal.finalSignal,
      confidence:   signal.confidence,
      grade:        signal.grade ? signal.grade.grade : 'N/A',
      entryPrice, expiryTime,
      bestTF:       bestTF ? bestTF.timeframe : 'N/A',
      alignment:    signal.alignment,
      marketRegime: signal.marketRegime,
      session:      signal.session ? signal.session.sessions : [],
      sessionQuality: signal.session ? signal.session.quality : 'N/A',
      aiAgreed:     signal.aiValidation ? signal.aiValidation.combinedAgreed : null,
      timestamp: now, result: null, exitPrice: null, checkedAt: null,
    };

    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(pair);
    let existing = null;
    try { existing = await env.SIGNAL_CACHE.get(histKey, 'json'); } catch (e) { existing = null; }

    let history = Array.isArray(existing) ? existing : [];
    history.unshift(record);
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR) history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60*60*24*30 });

    if (!isOTC && expiryTime) {
      await env.SIGNAL_CACHE.put(HISTORY_CONFIG.KV_PENDING_PREFIX + signalId, JSON.stringify(record), { expirationTtl: 60*60*2 });
    }
    console.log('Signal saved:', signalId, pair, signal.finalSignal);
  } catch (e) { console.warn('saveSignalToHistory error:', e.message); }
}

export async function scheduledTracker(env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return;

    const now = Date.now(); let checked = 0;
    for (const kvEntry of pendingList.keys) {
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, 'json');
        if (!record || !record.expiryTime) { await env.SIGNAL_CACHE.delete(kvEntry.name); continue; }
        const checkAfterMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.RESULT_CHECK_DELAY * 1000;
        if (now < checkAfterMs) continue;

        const exitPrice = await fetchExpiryPrice(record.pair, record.expiryTime, env);
        let winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null) {
          if (record.direction === 'BUY')  winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          if (record.direction === 'SELL') winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
        }
        await updateSignalResult(record, winLoss, exitPrice, env);
        await env.SIGNAL_CACHE.delete(kvEntry.name);
        await updatePairStats(record.pair, winLoss, record, env);
        checked++;
        if (checked >= 10) break;
      } catch (e) {
        console.warn('Cron check error for ' + kvEntry.name + ':', e.message);
        try { await env.SIGNAL_CACHE.delete(kvEntry.name); } catch (e2) {}
      }
    }
    if (checked > 0) console.log('Cron: checked ' + checked + ' expired signals');
  } catch (e) { console.warn('scheduledTracker error:', e.message); }
}

async function fetchExpiryPrice(pair, expiryTimeISO, env) {
  const { getApiKeys } = await import('../fetch/keys.js');
  try {
    const apiKeys = getApiKeys(env);
    if (apiKeys.length === 0) return null;
    const symbol = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
    const u = new URL('/time_series', CONFIG.API_BASE_URL);
    u.searchParams.set('symbol', symbol); u.searchParams.set('interval', '1min');
    u.searchParams.set('outputsize', '5'); u.searchParams.set('apikey', apiKeys[0]);
    u.searchParams.set('format', 'JSON');
    const controller = new AbortController(); const tid = setTimeout(() => controller.abort(), 8000);
    let res;
    try { res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } }); }
    finally { clearTimeout(tid); }
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.values || !Array.isArray(data.values) || data.values.length === 0) return null;
    const expiryMs = new Date(expiryTimeISO).getTime();
    let closest = null; let minDiff = Infinity;
    for (const c of data.values) {
      const diff = Math.abs(new Date(c.datetime).getTime() - expiryMs);
      if (diff < minDiff) { minDiff = diff; closest = c; }
    }
    return (closest && minDiff <= 120000) ? parseFloat(closest.close) : null;
  } catch (e) { console.warn('fetchExpiryPrice error:', e.message); return null; }
}

async function updateSignalResult(record, winLoss, exitPrice, env) {
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(record.pair);
    const existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(existing)) return;
    for (const sig of existing) {
      if (sig.id === record.id) { sig.result = winLoss; sig.exitPrice = exitPrice; sig.checkedAt = new Date().toISOString(); break; }
    }
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(existing), { expirationTtl: 60*60*24*30 });
  } catch (e) { console.warn('updateSignalResult error:', e.message); }
}

export async function getDynamicConfidenceAdjustment(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return 0;
  try {
    const stats = await env.SIGNAL_CACHE.get(HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair), 'json');
    if (!stats || typeof stats.winRate !== 'number' || stats.sampleSize < 5) return 0;
    const wr = stats.winRate;
    if (wr >= 0.70) return HISTORY_CONFIG.CONFIDENCE_BONUS;
    if (wr >= HISTORY_CONFIG.CONFIDENCE_BONUS_THRESHOLD) return 3;
    if (wr <= 0.35) return HISTORY_CONFIG.CONFIDENCE_PENALTY;
    if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5;
    return 0;
  } catch (e) { return 0; }
}

export async function updatePairStats(pair, winLoss, record, env) {
  if (!env || !env.SIGNAL_CACHE || winLoss === 'UNKNOWN') return;
  try {
    const statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair);
    let stats = await env.SIGNAL_CACHE.get(statsKey, 'json');
    if (!stats) stats = { pair, totalSignals:0, wins:0, losses:0, winRate:0, sampleSize:0, bySession:{}, byTF:{}, byRegime:{}, lastUpdated:null };

    stats.totalSignals++;
    if (winLoss === 'WIN')  stats.wins++;
    if (winLoss === 'LOSS') stats.losses++;
    const decided  = stats.wins + stats.losses;
    stats.winRate    = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
    stats.sampleSize = Math.min(decided, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
    stats.lastUpdated = new Date().toISOString();

    for (const sess of (record.session || [])) {
      if (!stats.bySession[sess]) stats.bySession[sess] = { wins:0, losses:0, winRate:0 };
      if (winLoss === 'WIN')  stats.bySession[sess].wins++;
      if (winLoss === 'LOSS') stats.bySession[sess].losses++;
      const sd = stats.bySession[sess].wins + stats.bySession[sess].losses;
      stats.bySession[sess].winRate = sd > 0 ? Math.round((stats.bySession[sess].wins / sd) * 1000) / 1000 : 0;
    }

    const tf = record.bestTF || 'N/A';
    if (!stats.byTF[tf]) stats.byTF[tf] = { wins:0, losses:0, winRate:0 };
    if (winLoss === 'WIN')  stats.byTF[tf].wins++;
    if (winLoss === 'LOSS') stats.byTF[tf].losses++;
    const td = stats.byTF[tf].wins + stats.byTF[tf].losses;
    stats.byTF[tf].winRate = td > 0 ? Math.round((stats.byTF[tf].wins / td) * 1000) / 1000 : 0;

    const regime = record.marketRegime || 'UNKNOWN';
    if (!stats.byRegime[regime]) stats.byRegime[regime] = { wins:0, losses:0, winRate:0 };
    if (winLoss === 'WIN')  stats.byRegime[regime].wins++;
    if (winLoss === 'LOSS') stats.byRegime[regime].losses++;
    const rd = stats.byRegime[regime].wins + stats.byRegime[regime].losses;
    stats.byRegime[regime].winRate = rd > 0 ? Math.round((stats.byRegime[regime].wins / rd) * 1000) / 1000 : 0;

    await env.SIGNAL_CACHE.put(statsKey, JSON.stringify(stats), { expirationTtl: 60*60*24*90 });
  } catch (e) { console.warn('updatePairStats error:', e.message); }
}

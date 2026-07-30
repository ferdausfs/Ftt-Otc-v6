// Fix: static import (was dynamic inside fetchExpiryPrice — called every cron tick)
import { CONFIG } from '../config.js';
import { HISTORY_CONFIG } from '../config.js';
import { getApiKeys, getNextRotationIndex } from '../fetch/keys.js';
import { incrementQuota } from './quota.js';
import { applyResult as cbApplyResult } from './circuitBreaker.js';
import { pushResultToSubscribers } from '../handlers/pushToSubscribers.js';
// R7.1: read the private engine audit (Symbol transport) + sanitize for storage.
import { getEngineAudit, sanitizeAuditForHistory } from '../signal/r71shadow.js';

function pairKey(pair) {
  return pair.replace(/\//g, '_').replace(/-/g, '_');
}

// ── DEDUP GUARD CONFIG ────────────────────────────────────────
// Same pair+direction+nearby-entry within this window is treated
// as a re-poll of the same setup and not written as a new record.
const DEDUP_WINDOW_MS            = 30 * 60 * 1000;  // 30 minutes
const DEDUP_ENTRY_REL_TOLERANCE  = 0.0005;          // 0.05% relative tolerance
const DEDUP_ENTRY_ABS_TOLERANCE  = 0.0001;          // absolute floor (covers low-price pairs like XRP/DOGE/SOL)

function entriesClose(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOLERANCE || (diff / scale) <= DEDUP_ENTRY_REL_TOLERANCE;
}

function isDuplicateRecord(newRec, prevRec) {
  if (!prevRec) return false;
  if (prevRec.direction !== newRec.direction) return false;
  if (!entriesClose(newRec.entryPrice, prevRec.entryPrice)) return false;
  try {
    const tNew = new Date(newRec.timestamp).getTime();
    const tOld = new Date(prevRec.timestamp).getTime();
    if (tNew - tOld < 0 || tNew - tOld > DEDUP_WINDOW_MS) return false;
  } catch (e) { return false; }
  return true;
}

/**
 * B5 — normalise AI outcome into one short string.
 * Forex/crypto path uses the dual-AI combiner (ai/combine.js);
 * OTC path has a single Cerebras validation with its own shape.
 */
function derivedAiStatus(signal) {
  if (!signal) return null;
  if (signal.isOTC) {
    const st = signal.aiValidation ? signal.aiValidation.status : null;   // 'SKIPPED' | 'OK'
    if (st === 'SKIPPED') return 'SKIPPED';
    if (st === 'OK') return signal.aiValidation.agrees ? 'OTC_AGREE' : 'OTC_DISAGREE';
    return st || null;
  }
  if (!signal.aiValidation) return null;
  if (signal.aiValidation.status === 'SKIPPED') return 'SKIPPED';
  const c = signal.aiValidation.combined;
  if (!c) return null;
  // combine.js: 'BOTH_UNAVAILABLE' | 'OK' (+ agreement 'BOTH_AGREE'|'AIs_DISAGREE')
  if (c.status === 'OK' && c.agreement) return c.agreement;
  return c.status || null;
}

export async function saveSignalToHistory(signal, pair, isOTC, env, signalId, entrySource) {
  if (!env || !env.SIGNAL_CACHE) return;
  if (!signalId) {
    console.warn('saveSignalToHistory skipped: missing signalId for ' + pair);
    return;
  }
  try {
    const now      = new Date().toISOString();
    const bestTF   = signal.bestTimeframe || null;
    const entryPrice = signal.recommendations && bestTF
      ? (signal.recommendations[bestTF.timeframe] && signal.recommendations[bestTF.timeframe].entry
          ? signal.recommendations[bestTF.timeframe].entry.price : null)
      : null;
    const expiryTime = bestTF && bestTF.expiry ? bestTF.expiry.expiryTime : null;

    const record = {
      id: signalId, pair, isOTC,
      direction:      signal.finalSignal,
      confidence:     signal.confidence,
      grade:          signal.grade ? signal.grade.grade : 'N/A',
      entryPrice, expiryTime,
      bestTF:         bestTF ? bestTF.timeframe : 'N/A',
      alignment:      signal.alignment,
      marketRegime:   signal.marketRegime,
      session:        signal.session ? signal.session.sessions : [],
      sessionQuality: signal.session ? signal.session.quality  : 'N/A',
      aiAgreed:       signal.aiValidation ? signal.aiValidation.combinedAgreed : null,
      // ── B5: additive diagnostic fields (never read by existing consumers) ──
      structureVerdict: signal.structureVerdict ? (signal.structureVerdict.overall || null) : null,
      aiStatus:         derivedAiStatus(signal),
      coreConfidence:   signal.coreConfidence === undefined || signal.coreConfidence === null
                          ? null : signal.coreConfidence,
      entrySource:      entrySource || null,
      timestamp: now, result: null, exitPrice: null, checkedAt: null,
    };
    // B2/§3.3: only present on shadow rows — keeps normal records lean
    if (signal.cbShadow === true) record.cbShadow = true;

    // R7.1: attach the bounded structure-attribution audit (standard engine
    // only — OTC signals carry no audit, so getEngineAudit returns null and
    // OTC records stay lean). This enumerable field is the ONLY audit surface;
    // handleHistory() strips it from public /api/history responses.
    try {
      const r71Audit = getEngineAudit(signal);
      if (r71Audit) record.structureAudit = sanitizeAuditForHistory(r71Audit);
    } catch (e) { /* audit persistence must never break a normal save */ }

    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(pair);
    let existing = null;
    try { existing = await env.SIGNAL_CACHE.get(histKey, 'json'); } catch (e) { existing = null; }

    let history = Array.isArray(existing) ? existing : [];

    // ── DEDUP GUARD ────────────────────────────────────────────
    // Check the most recent N records (not just [0]) to be robust to
    // out-of-order writes. Skip past any records with stale/undecidable
    // metadata; we only need to catch re-polls (which always arrive at the
    // top of the history within seconds/minutes of the original).
    const DEDUP_CHECK_DEPTH = 5;
    let duplicateOf = null;
    for (let i = 0; i < Math.min(DEDUP_CHECK_DEPTH, history.length); i++) {
      const prev = history[i];
      if (!prev || !prev.timestamp) continue;
      if (isDuplicateRecord(record, prev)) { duplicateOf = prev; break; }
    }

    if (duplicateOf) {
      // Option (a): simply skip the duplicate. Do NOT write a new KV entry,
      // do NOT register a new pending-expiry record. This saves KV writes
      // (critical on the CF Workers Free plan — 1000 writes/day/account)
      // and prevents re-poll inflation of win/loss streaks.
      //
      // We do NOT mutate/refresh the existing record — the first recorded
      // entry remains the source of truth.
      console.log('Signal deduped (re-poll):', signalId, pair, signal.finalSignal,
                  '-> existing id', duplicateOf.id,
                  '(entry', entryPrice, 'expiry', expiryTime, ')');
      return { deduped: true, duplicateOf: duplicateOf.id };
    }

    history.unshift(record);
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR)
      history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);

    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60*60*24*30 });

    if (!isOTC && expiryTime) {
      await env.SIGNAL_CACHE.put(
        HISTORY_CONFIG.KV_PENDING_PREFIX + signalId,
        JSON.stringify(record),
        { expirationTtl: Math.floor(HISTORY_CONFIG.PENDING_TTL_MS / 1000) }
      );
    }
    console.log('Signal saved:', signalId, pair, signal.finalSignal);
    return { deduped: false };
  } catch (e) { console.warn('saveSignalToHistory error:', e.message); }
}

// Test-only export (not used at runtime) so a local node script can
// exercise isDuplicateRecord / entriesClose without reimplementing them.
export const __dedupTest = { entriesClose, isDuplicateRecord,
                              DEDUP_WINDOW_MS, DEDUP_ENTRY_REL_TOLERANCE, DEDUP_ENTRY_ABS_TOLERANCE };

export async function scheduledTracker(env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    if (!pendingList || !pendingList.keys || pendingList.keys.length === 0) return;

    const now = Date.now(); let checked = 0;
    for (const kvEntry of pendingList.keys) {
      try {
        const record = await env.SIGNAL_CACHE.get(kvEntry.name, 'json');
        if (!record || !record.expiryTime) {
          await env.SIGNAL_CACHE.delete(kvEntry.name); continue;
        }
        const checkAfterMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.RESULT_CHECK_DELAY * 1000;
        if (now < checkAfterMs) continue;

        const fetchResult = await fetchExpiryPrice(record.pair, record.expiryTime, env);

        // ── B0-3: transient fetch failure must NOT burn the record ──
        // Old behaviour deleted the pending key on the first miss, so one bad
        // API response permanently froze the signal as UNKNOWN. Now we count
        // attempts and only give up after PENDING_MAX_CHECKS.
        if (fetchResult && fetchResult.error) {
          record.checks        = (record.checks || 0) + 1;
          record.lastCheckError = fetchResult.error;
          record.lastCheckAt    = new Date().toISOString();

          if (record.checks >= HISTORY_CONFIG.PENDING_MAX_CHECKS) {
            await updateSignalResult(record, 'UNKNOWN', null, env);
            await env.SIGNAL_CACHE.delete(kvEntry.name);
            console.warn('scheduledTracker gave up id=' + record.id + ' pair=' + record.pair +
                         ' checks=' + record.checks + ' lastErr=' + fetchResult.error);
          } else {
            const remainingMs = (new Date(record.expiryTime).getTime() + HISTORY_CONFIG.PENDING_TTL_MS) - now;
            if (remainingMs > 60000) {
              await env.SIGNAL_CACHE.put(kvEntry.name, JSON.stringify(record),
                                         { expirationTtl: Math.floor(remainingMs / 1000) });
            } else {
              // TTL window exhausted before the retry budget — resolve as UNKNOWN
              await updateSignalResult(record, 'UNKNOWN', null, env);
              await env.SIGNAL_CACHE.delete(kvEntry.name);
              console.warn('scheduledTracker ttl-expired id=' + record.id + ' pair=' + record.pair +
                           ' checks=' + record.checks + ' lastErr=' + fetchResult.error);
            }
          }
          checked++;
          if (checked >= 10) break;
          continue;
        }

        const exitPrice = fetchResult ? fetchResult.price : null;
        let winLoss = 'UNKNOWN';
        if (record.entryPrice !== null && exitPrice !== null && exitPrice !== undefined) {
          if (record.direction === 'BUY')  winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
          if (record.direction === 'SELL') winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
        }
        await updateSignalResult(record, winLoss, exitPrice, env);
        await env.SIGNAL_CACHE.delete(kvEntry.name);
        // §3.3: shadow rows are outcome-tracked but never pollute WR / CB state
        if (!record.cbShadow) await updatePairStats(record.pair, winLoss, record, env);
        // PHASE 10: tell whoever received the original signal how it resolved.
        // Only fires for signals that were actually pushed (pushLog lookup).
        await pushResultToSubscribers(record, winLoss, exitPrice, env);
        checked++;
        if (checked >= 10) break;
      } catch (e) {
        // B0-3: do NOT delete on exception — let the retry counter run its course.
        console.warn('Cron check error for ' + kvEntry.name + ':', e.message);
      }
    }
    if (checked > 0) console.log('Cron: checked ' + checked + ' expired signals');
  } catch (e) { console.warn('scheduledTracker error:', e.message); }
}

/**
 * B0-1/B0-2/B0-5 — expiry price lookup.
 *
 * Old version: outputsize=5 from "now" (so a cron tick that ran late simply
 * could not see the expiry minute), key #1 only, and every failure collapsed to
 * a bare `null` with no reason recorded.
 *
 * New version: an explicit +/-5min bracket around the expiry timestamp, full key
 * rotation, and a result object — {price} on success, {error,status,body} on
 * failure — so the caller can distinguish "no data" from "not yet".
 */
// R7.1: exported so the shadow observation resolver can reuse the EXACT same
// expiry-price fetcher (no duplicate implementation). Adding `export` does not
// change any existing behaviour.
export async function fetchExpiryPrice(pair, expiryTimeISO, env) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: 'NO_API_KEYS' };

  const symbol   = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
  const expiryMs = new Date(expiryTimeISO).getTime();
  if (!Number.isFinite(expiryMs)) return { error: 'BAD_EXPIRY_TIME' };

  // TwelveData accepts "YYYY-MM-DD HH:MM:SS" (UTC)
  const startDate = new Date(expiryMs - 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const endDate   = new Date(expiryMs + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const startIdx    = await getNextRotationIndex(env, apiKeys.length);
  const maxAttempts = apiKeys.length;     // B0-6: no MAX_RETRIES cap
  let lastErr = { error: 'UNKNOWN' };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyIdx = (startIdx + attempt) % apiKeys.length;
    const apiKey = apiKeys[keyIdx];
    try {
      const u = new URL('/time_series', CONFIG.API_BASE_URL);
      u.searchParams.set('symbol', symbol);
      u.searchParams.set('interval', '1min');
      u.searchParams.set('start_date', startDate);
      u.searchParams.set('end_date', endDate);
      u.searchParams.set('apikey', apiKey);
      u.searchParams.set('format', 'JSON');

      await incrementQuota(env);   // B0-4: +1 per HTTP attempt

      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      let res;
      try { res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } }); }
      finally { clearTimeout(tid); }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.warn('fetchExpiryPrice non-ok pair=' + pair + ' keyIdx=' + keyIdx +
                     ' status=' + res.status + ' body=' + bodyText.slice(0, 200));
        lastErr = res.status === 429
          ? { error: 'RATE_LIMITED', status: 429, body: bodyText.slice(0, 200) }
          : { error: 'HTTP_' + res.status, status: res.status, body: bodyText.slice(0, 200) };
        continue;
      }

      const data = await res.json();
      if (data.status === 'error') {
        console.warn('fetchExpiryPrice td-error pair=' + pair + ' keyIdx=' + keyIdx +
                     ' code=' + data.code + ' msg=' + String(data.message || '').slice(0, 200));
        lastErr = { error: 'TD_ERROR', status: data.code, body: String(data.message || '').slice(0, 200) };
        continue;
      }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
        console.warn('fetchExpiryPrice empty pair=' + pair + ' keyIdx=' + keyIdx +
                     ' body=' + JSON.stringify(data).slice(0, 200));
        lastErr = { error: 'EMPTY_VALUES' };
        continue;
      }

      let closest = null; let minDiff = Infinity;
      for (const c of data.values) {
        if (!c || !c.datetime) continue;
        const stamp = new Date(String(c.datetime).replace(' ', 'T') + 'Z').getTime();
        if (!Number.isFinite(stamp)) continue;
        const diff = Math.abs(stamp - expiryMs);
        if (diff < minDiff) { minDiff = diff; closest = c; }
      }
      if (closest && minDiff <= 120000) {
        const px = parseFloat(closest.close);
        if (Number.isFinite(px)) return { price: px };
        lastErr = { error: 'BAD_CLOSE_VALUE', body: String(closest.close).slice(0, 200) };
        continue;
      }
      console.warn('fetchExpiryPrice no-match pair=' + pair + ' keyIdx=' + keyIdx + ' minDiff=' + minDiff);
      lastErr = { error: 'NO_MATCH_WITHIN_120S', body: 'minDiff=' + minDiff };
    } catch (e) {
      console.warn('fetchExpiryPrice exception pair=' + pair + ' keyIdx=' + keyIdx +
                   ' attempt=' + attempt + ' msg=' + e.message);
      lastErr = { error: 'EXCEPTION', body: e.message };
    }
  }
  return lastErr;
}

async function updateSignalResult(record, winLoss, exitPrice, env) {
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(record.pair);
    const existing = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(existing)) return;
    for (const sig of existing) {
      if (sig.id === record.id) {
        sig.result = winLoss; sig.exitPrice = exitPrice;
        sig.checkedAt = new Date().toISOString(); break;
      }
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
    if (!stats) stats = {
      pair, totalSignals:0, wins:0, losses:0, winRate:0,
      sampleSize:0, bySession:{}, byTF:{}, byRegime:{}, lastUpdated:null,
    };

    stats.totalSignals++;
    if (winLoss === 'WIN')  stats.wins++;
    if (winLoss === 'LOSS') stats.losses++;
    const decided   = stats.wins + stats.losses;
    stats.winRate   = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
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

    // B2: single funnel point — every decided result that counts toward WR also
    // feeds the circuit breaker. Shadow rows never reach here (skipped upstream).
    await cbApplyResult(pair, winLoss, env);
  } catch (e) { console.warn('updatePairStats error:', e.message); }
}

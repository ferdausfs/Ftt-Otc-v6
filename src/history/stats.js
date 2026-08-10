// Fix: static import (was dynamic inside fetchExpiryPrice — called every cron tick)
import { CONFIG } from '../config.js';
import { HISTORY_CONFIG, EDGE_FEATURE_CONFIG } from '../config.js';
import { getApiKeys, getNextRotationIndex } from '../fetch/keys.js';
import { incrementQuota } from './quota.js';
import { applyResult as cbApplyResult } from './circuitBreaker.js';
import { pushResultToSubscribers } from '../handlers/pushToSubscribers.js';
// R7.1: read the private engine audit (Symbol transport) + sanitize for storage.
import { getEngineAudit, sanitizeAuditForHistory } from '../signal/r71shadow.js';

function pairKey(pair) {
  return pair.replace(/\//g, '_').replace(/-/g, '_');
}

// ── OUTCOME CLASSIFIER (Bugfix round 1 / BUG-008) ─────────────────────────
// Single source of truth for WIN/LOSS/TIE. An expiry close exactly at the entry
// is a TIE, NOT a LOSS for both directions (the previous convention silently
// deflated WR on low-volatility pairs). TIE rows are stored in history but are
// excluded from win/loss stats and from result pushes. All resolvers
// (scheduledTracker + d2/probe/r71 stores) share this one implementation.
const TIE_REL_EPS = 1e-9;   // relative epsilon: a 1e-13 float wiggle is still a tie

export function classifyOutcome(direction, entryPrice, exitPrice) {
  if (entryPrice === null || entryPrice === undefined ||
      exitPrice === null || exitPrice === undefined) return 'UNKNOWN';
  const diff = exitPrice - entryPrice;
  const scale = Math.max(Math.abs(entryPrice), Math.abs(exitPrice), 1);
  if (Math.abs(diff) <= TIE_REL_EPS * scale) return 'TIE';
  if (direction === 'BUY')  return diff > 0 ? 'WIN' : 'LOSS';
  if (direction === 'SELL') return diff < 0 ? 'WIN' : 'LOSS';
  return 'UNKNOWN';
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
      fillStatus:       signal.fillStatus || null,
      currentPrice:     signal.currentPrice || null,
      entryDistancePct: signal.entryDistancePct == null ? null : signal.entryDistancePct,
      timestamp: now, result: null, exitPrice: null, checkedAt: null,
    };
    // B2/§3.3: only present on shadow rows — keeps normal records lean
    if (signal.cbShadow === true) record.cbShadow = true;

    // ── D4 v2.1 instrumentation: persist a tiny best-TF indicator snapshot ──
    // Purpose: future avoidance models (D4 v2.1) need raw signal-time indicators
    // (RSI / ATR% / ADX / BB-bandwidth). The engine already computes them per TF
    // (indicators/index.js) and they live on signal.timeframeAnalysis[bestTF].indicators,
    // but history previously discarded them. This persists 4-6 numbers (~40 bytes/row).
    // Read-only diagnostic — NO runtime consumer yet. Fail-open: diagnostics must
    // never break a save. See D4_V2_AVOIDANCE_REPORT.md §7.
    //
    // Field-shape verification (2026-08-09, against actual engine at 229acdb):
    //   - raw indicators (calculateAllIndicators) → { rsi: [...], atr: [...],
    //     adx: { adx: [...], plusDI, minusDI }, bollinger: { bandwidth: [...] } }
    //   - BUT analyzeTimeframe() flattens to formatted strings:
    //     { rsi: "55.55", atr: "0.999", adx: "9.90", bbBandwidth: "1.24", ... }
    //   → instrumentation must support BOTH shapes (raw array + formatted).
    //   See PR body table.
    try {
      const _bestTF = signal.bestTimeframe && signal.bestTimeframe.timeframe;
      const _tfa = _bestTF && signal.timeframeAnalysis ? signal.timeframeAnalysis[_bestTF] : null;
      const _ind = _tfa && _tfa.indicators;
      const _last = (a) => Array.isArray(a) ? a[a.length - 1] : a;
      const _toNum = (v) => {
        if (typeof v === 'number' && isFinite(v)) return Math.round(v * 1000) / 1000;
        if (typeof v === 'string') {
          const n = parseFloat(v);
          if (isFinite(n)) return Math.round(n * 1000) / 1000;
        }
        return null;
      };
      const _extract = (val) => {
        if (val === null || val === undefined) return null;
        const last = _last(val);
        return _toNum(last);
      };
      const _extractRaw = (val) => {
        if (val === null || val === undefined) return null;
        const last = _last(val);
        if (typeof last === 'number' && isFinite(last)) return last;
        if (typeof last === 'string') {
          const n = parseFloat(last);
          return isFinite(n) ? n : null;
        }
        return null;
      };
      if (_ind && _bestTF) {
        // RSI: raw array OR formatted string/number
        const rsi = _extract(_ind.rsi);

        // ATR + close → atrPct
        const atrRaw = _extractRaw(_ind.atr);
        const closeRaw = _tfa.entry && _tfa.entry.price != null
          ? (typeof _tfa.entry.price === 'string' ? parseFloat(_tfa.entry.price) : _tfa.entry.price)
          : null;
        const atrPct = (atrRaw !== null && closeRaw !== null && isFinite(closeRaw) && closeRaw !== 0)
          ? Math.round(((atrRaw / closeRaw) * 100) * 1000) / 1000
          : null;

        // ADX: raw shape { adx: [...] } OR formatted string/number at ind.adx
        let adx = null;
        if (_ind.adx !== null && _ind.adx !== undefined) {
          if (typeof _ind.adx === 'object' && !Array.isArray(_ind.adx) && _ind.adx.adx !== undefined) {
            adx = _extract(_ind.adx.adx);
          } else {
            adx = _extract(_ind.adx);
          }
        }

        // BB bandwidth: raw bollinger.bandwidth array OR formatted bbBandwidth
        let bbBandwidth = null;
        if (_ind.bollinger && _ind.bollinger.bandwidth !== undefined) {
          bbBandwidth = _extract(_ind.bollinger.bandwidth);
        } else if (_ind.bbBandwidth !== undefined) {
          bbBandwidth = _extract(_ind.bbBandwidth);
        } else if (_ind.bollinger && typeof _ind.bollinger.bandwidth === 'number') {
          bbBandwidth = _toNum(_ind.bollinger.bandwidth);
        }

        const _edge = signal.edgeContext || null;
        const atrPercentile = _extract(_ind.atrPercentile !== undefined
          ? _ind.atrPercentile : (_edge && _edge.atrPercentile && _edge.atrPercentile.percentile));
        const atrState = typeof _ind.atrState === 'string' ? _ind.atrState
          : (_edge && _edge.atrPercentile ? _edge.atrPercentile.state : 'UNKNOWN');
        const bbWidthRatio = _extract(_ind.bbWidthRatio !== undefined
          ? _ind.bbWidthRatio : (_edge && _edge.volatility && _edge.volatility.ratio));
        const volatilityState = typeof _ind.volatilityState === 'string' ? _ind.volatilityState
          : (_edge && _edge.volatility ? _edge.volatility.state : 'UNKNOWN');
        record.signalIndicators = {
          bestTF: _bestTF,
          rsi: rsi,
          atrPct: atrPct,
          adx: adx,
          bbBandwidth: bbBandwidth,
          atrPercentile,
          atrState,
          bbWidthRatio,
          volatilityState,
          sessionRangePosition: _edge && _edge.sessionRange
            ? _extract(_edge.sessionRange.position) : null,
          sessionRangeState: _edge && _edge.sessionRange
            ? _edge.sessionRange.state : 'UNKNOWN',
          utcHour: _edge && _edge.time ? _edge.time.utcHour : null,
          dayOfWeek: _edge && _edge.time ? _edge.time.dayOfWeek : null,
        };
      }
    } catch (e) { /* diagnostic only — never break a save */ }

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

    // F3-02 (BUG-012): OTC rows now register a pending result-check too.
    // The resolver's fetchExpiryPrice strips the -OTC suffix and resolves
    // against the base pair's REAL market price — the same data the OTC
    // signal itself was computed from (dataNote: "Candle data from <base>").
    if (expiryTime) {
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

        const fetchResult = await fetchExpiryPrice(record.pair, record.expiryTime, env, {
          startTimeISO: record.timestamp,
        });

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
        // Bugfix round 1 (BUG-008): exit == entry is a TIE, not a LOSS.
        const winLoss = classifyOutcome(record.direction, record.entryPrice, exitPrice);

        // ── Entry-hit shadow (FIX-EH): a meaningful re-test requires an
        // INSTANT entry to be left in the signal's favour before price returns.
        // PENDING_ENTRY keeps plain-touch semantics because its entry starts
        // away from the current price. WIN/LOSS/TIE resolution is untouched.
        if (record.entryPrice != null && fetchResult &&
            fetchResult.postSignal && fetchResult.postSignal.length) {
          const entry = record.entryPrice;
          const eps = 1e-9 * Math.max(Math.abs(entry), 1);
          const cs = fetchResult.postSignal;
          const dir = record.direction;

          // Legacy expiry +/-5min rule retained side-by-side for comparison.
          let legacy = null;
          if (fetchResult.windowLow != null && fetchResult.windowHigh != null) {
            legacy = dir === 'BUY' ? fetchResult.windowLow <= entry + 1e-12
                   : dir === 'SELL' ? fetchResult.windowHigh >= entry - 1e-12 : null;
          }

          let corrected = false;
          if (record.fillStatus === 'PENDING_ENTRY') {
            if (dir === 'BUY')  corrected = cs.some(c => c.low <= entry + eps);
            if (dir === 'SELL') corrected = cs.some(c => c.high >= entry - eps);
          } else if (dir === 'BUY' || dir === 'SELL') {
            let left = false;
            for (const c of cs) {
              if (dir === 'BUY'  && !left && c.high > entry + eps) left = true;
              if (dir === 'SELL' && !left && c.low  < entry - eps) left = true;
              if (left && dir === 'BUY'  && c.low  <= entry + eps) { corrected = true; break; }
              if (left && dir === 'SELL' && c.high >= entry - eps) { corrected = true; break; }
            }
          }

          record.entryHit = corrected;
          record.entryHitLegacy = legacy;
          record.entryHitWindowLow = cs.reduce((m, c) => Math.min(m, c.low), Infinity);
          record.entryHitWindowHigh = cs.reduce((m, c) => Math.max(m, c.high), -Infinity);
          record.entryHitWindowStart = record.timestamp;
          record.entryHitWindowEnd = record.expiryTime;
        } else {
          record.entryHit = null;
          record.entryHitLegacy = null;
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
export async function fetchExpiryPrice(pair, expiryTimeISO, env, opts = {}) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: 'NO_API_KEYS' };

  // F3-02: OTC pairs ("EUR/USD-OTC") must resolve against the base pair's
  // real market symbol — TwelveData has no "-OTC" instrument.
  const basePair  = String(pair).replace(/-OTC$/i, '');
  const symbol    = basePair.includes('/') ? basePair : basePair.slice(0, 3) + '/' + basePair.slice(3);
  const expiryMs = new Date(expiryTimeISO).getTime();
  if (!Number.isFinite(expiryMs)) return { error: 'BAD_EXPIRY_TIME' };

  // FIX-EH: the tracker needs candles from the signal through expiry. Invalid
  // start times deliberately fall back to the legacy expiry +/-5min request.
  const startTimeISO = opts && opts.startTimeISO;
  const parsedSignalMs = startTimeISO == null
    ? NaN : new Date(startTimeISO).getTime();
  const hasSignalStart = Number.isFinite(parsedSignalMs);
  const signalMs = hasSignalStart ? parsedSignalMs : null;
  const requestedStartMs = hasSignalStart ? signalMs - 60 * 1000
                                           : expiryMs - 5 * 60 * 1000;
  const requestedEndMs = hasSignalStart ? expiryMs + 60 * 1000
                                         : expiryMs + 5 * 60 * 1000;

  // TwelveData accepts "YYYY-MM-DD HH:MM:SS" (UTC)
  const startDate = new Date(requestedStartMs).toISOString().slice(0, 19).replace('T', ' ');
  const endDate   = new Date(requestedEndMs).toISOString().slice(0, 19).replace('T', ' ');

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
      // F3-07 (BUG-016): pin UTC — TwelveData's default forex timezone is
      // Australia/Sydney (UTC+10), which would shift the bracket by 10h.
      u.searchParams.set('timezone', 'UTC');

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

      // Parse once per successful attempt. TwelveData normally returns newest
      // first; callers receive a deterministic oldest-to-newest candle list.
      const candles = [];
      let closest = null; let minDiff = Infinity;
      for (const c of data.values) {
        if (!c || !c.datetime) continue;
        const datetime = String(c.datetime);
        const isoDatetime = datetime.includes('T') ? datetime : datetime.replace(' ', 'T');
        const zonedDatetime = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoDatetime)
          ? isoDatetime : isoDatetime + 'Z';
        const stamp = new Date(zonedDatetime).getTime();
        if (!Number.isFinite(stamp)) continue;

        // Keep expiry-close selection byte-compatible with the old path: it
        // depends only on datetime here and validates the selected close below.
        const diff = Math.abs(stamp - expiryMs);
        if (diff < minDiff) { minDiff = diff; closest = c; }

        const open = parseFloat(c.open); const high = parseFloat(c.high);
        const low = parseFloat(c.low); const close = parseFloat(c.close);
        if (!Number.isFinite(open) || !Number.isFinite(high) ||
            !Number.isFinite(low) || !Number.isFinite(close)) continue;
        candles.push({ datetime, stamp, open, high, low, close });
      }
      candles.sort((a, b) => a.stamp - b.stamp);

      if (closest && minDiff <= 120000) {
        const px = parseFloat(closest.close);
        if (Number.isFinite(px)) {
          // Preserve the legacy entry-hit bracket even when the requested candle
          // range starts at signal time for corrected re-test observation.
          const legacyStartMs = expiryMs - 5 * 60 * 1000;
          const legacyEndMs = expiryMs + 5 * 60 * 1000;
          let lo = Infinity, hi = -Infinity;
          for (const candle of candles) {
            if (candle.stamp < legacyStartMs || candle.stamp > legacyEndMs) continue;
            if (candle.low < lo) lo = candle.low;
            if (candle.high > hi) hi = candle.high;
          }

          return {
            price: px,
            candles,
            windowLow: Number.isFinite(lo) ? lo : null,
            windowHigh: Number.isFinite(hi) ? hi : null,
            windowStart: startDate,
            windowEnd: endDate,
            postSignal: hasSignalStart
              ? candles.filter(candle => candle.stamp > signalMs) : null,
          };
        }
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
        sig.checkedAt = new Date().toISOString();
        // entry-hit shadow (truth-keeping; not used in WR yet)
        if (record.entryHit !== undefined) sig.entryHit = record.entryHit;
        if (record.entryHitLegacy !== undefined) sig.entryHitLegacy = record.entryHitLegacy;
        if (record.entryHitWindowLow !== undefined) sig.entryHitWindowLow = record.entryHitWindowLow;
        if (record.entryHitWindowHigh !== undefined) sig.entryHitWindowHigh = record.entryHitWindowHigh;
        if (record.entryHitWindowStart !== undefined) sig.entryHitWindowStart = record.entryHitWindowStart;
        if (record.entryHitWindowEnd !== undefined) sig.entryHitWindowEnd = record.entryHitWindowEnd;
        break;
      }
    }
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(existing), { expirationTtl: 60*60*24*30 });
  } catch (e) { console.warn('updateSignalResult error:', e.message); }
}

export async function getRecentFormSnapshot(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return null;
  try {
    const stats = await env.SIGNAL_CACHE.get(HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair), 'json');
    if (!stats || typeof stats.winRate !== 'number' || typeof stats.sampleSize !== 'number') return null;
    return {
      winRate: stats.winRate,
      sampleSize: stats.sampleSize,
      lookback: HISTORY_CONFIG.WIN_RATE_LOOKBACK,
      lastUpdated: stats.lastUpdated || null,
    };
  } catch (e) { return null; }
}

export async function getDynamicConfidenceAdjustment(pair, env) {
  const recent = await getRecentFormSnapshot(pair, env);
  if (!recent || recent.sampleSize < 5) return 0;
  const wr = recent.winRate;
  if (wr >= 0.70) return HISTORY_CONFIG.CONFIDENCE_BONUS;
  if (wr >= HISTORY_CONFIG.CONFIDENCE_BONUS_THRESHOLD) return 3;
  // Kept for the public /api/stats diagnostic contract. The engine itself no
  // longer double-applies this negative adjustment: voteFilters uses the
  // config-driven x0.85 recent-form gate instead.
  if (wr < EDGE_FEATURE_CONFIG.RECENT_FORM.blockBelowWinRate)
    return HISTORY_CONFIG.CONFIDENCE_PENALTY;
  if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5;
  return 0;
}

export async function updatePairStats(pair, winLoss, record, env) {
  // Bugfix round 1 (BUG-008): TIE is stored in history but never counted as
  // a win or a loss (same exclusion as UNKNOWN).
  if (!env || !env.SIGNAL_CACHE || (winLoss !== 'WIN' && winLoss !== 'LOSS')) return;
  try {
    const statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pairKey(pair);
    let stats = await env.SIGNAL_CACHE.get(statsKey, 'json');
    if (!stats) stats = {
      pair, totalSignals:0, wins:0, losses:0, winRate:0,
      sampleSize:0, bySession:{}, byTF:{}, byRegime:{}, lastUpdated:null,
      recentResults: [],
    };

    stats.totalSignals++;
    if (winLoss === 'WIN')  stats.wins++;
    if (winLoss === 'LOSS') stats.losses++;
    // F3-18 (BUG-019): winRate is now the WIN_RATE_LOOKBACK-trade WINDOW
    // (rolling ring of the last 20 decided results), not the lifetime ratio —
    // so /api/stats winRate and the dynamic confidence adjustment track recent
    // form. Lifetime totals stay available in wins/losses/totalSignals.
    if (!Array.isArray(stats.recentResults)) stats.recentResults = [];
    stats.recentResults.push(winLoss);
    if (stats.recentResults.length > HISTORY_CONFIG.WIN_RATE_LOOKBACK)
      stats.recentResults = stats.recentResults.slice(-HISTORY_CONFIG.WIN_RATE_LOOKBACK);
    const windowedWins = stats.recentResults.filter(r => r === 'WIN').length;
    stats.winRate      = stats.recentResults.length > 0
      ? Math.round((windowedWins / stats.recentResults.length) * 1000) / 1000 : 0;
    stats.sampleSize   = stats.recentResults.length;
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

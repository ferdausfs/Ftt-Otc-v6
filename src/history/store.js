/**
 * FTT3 — signal history + result checking (plumbing, strategy-agnostic).
 *
 * KV layout (unchanged prefixes so existing tooling keeps working):
 *   sig:<PAIR>       -> array of records, newest first, capped, TTL 30d
 *   pending:<id>     -> record awaiting expiry resolution, TTL 2h
 *
 * Outcome convention (carried over): exit == entry is a TIE (excluded from
 * win/loss stats), never silently counted as a loss. A signal whose expiry
 * candle is missing from the 1m feed (market gap) resolves EXPIRY_GAP —
 * excluded from stats, visible in the audit.
 */

import { CONFIG, HISTORY_CONFIG } from '../config.js';
import { MS_1M } from '../strategy/engine.mjs';
import { fetchCandles } from '../fetch/candles.js';

function pairKey(pair) {
  return pair.replace(/\//g, '_').replace(/-/g, '_');
}

// ── outcome classifier (same convention as the previous worker) ─────────────
const TIE_REL_EPS = 1e-9;

export function classifyOutcome(direction, entryPrice, exitPrice) {
  if (entryPrice == null || exitPrice == null) return 'UNKNOWN';
  const diff = exitPrice - entryPrice;
  const scale = Math.max(Math.abs(entryPrice), Math.abs(exitPrice), 1);
  if (Math.abs(diff) <= TIE_REL_EPS * scale) return 'TIE';
  if (direction === 'CALL' || direction === 'BUY') return diff > 0 ? 'WIN' : 'LOSS';
  if (direction === 'PUT' || direction === 'SELL') return diff < 0 ? 'WIN' : 'LOSS';
  return 'UNKNOWN';
}

// ── dedup guard (carried over: 30-min re-poll window) ───────────────────────
const DEDUP_WINDOW_MS = 30 * 60 * 1000;
const DEDUP_ENTRY_REL_TOLERANCE = 0.0005;
const DEDUP_ENTRY_ABS_TOLERANCE = 0.0001;

function entriesClose(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return false;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return diff <= DEDUP_ENTRY_ABS_TOLERANCE || diff / scale <= DEDUP_ENTRY_REL_TOLERANCE;
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
 * Persist a decided signal (CALL/PUT). Returns { deduped } — a deduped record
 * must NOT push to subscribers (it is a re-poll of a live setup).
 */
export async function saveSignal(record, env) {
  if (!env || !env.SIGNAL_CACHE) return { deduped: false, error: 'no KV' };
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(record.pair);
    let history = null;
    try { history = await env.SIGNAL_CACHE.get(histKey, 'json'); } catch (e) { history = null; }
    if (!Array.isArray(history)) history = [];

    for (let i = 0; i < Math.min(5, history.length); i++) {
      if (isDuplicateRecord(record, history[i])) return { deduped: true, duplicateOf: history[i].id };
    }

    history.unshift(record);
    if (history.length > HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR)
      history = history.slice(0, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 });

    if (record.expiryTime) {
      await env.SIGNAL_CACHE.put(
        HISTORY_CONFIG.KV_PENDING_PREFIX + record.id,
        JSON.stringify(record),
        { expirationTtl: Math.floor(HISTORY_CONFIG.PENDING_TTL_MS / 1000) },
      );
    }
    return { deduped: false };
  } catch (e) {
    console.warn('saveSignal error:', e.message);
    return { deduped: false, error: e.message };
  }
}

/** Update a stored record's outcome in place (history array + pending key). */
async function updateSignalResult(record, result, exitPrice, env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    record.result = result;
    record.exitPrice = exitPrice;
    record.checkedAt = new Date().toISOString();
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(record.pair);
    let history = null;
    try { history = await env.SIGNAL_CACHE.get(histKey, 'json'); } catch (e) { history = null; }
    if (Array.isArray(history)) {
      const idx = history.findIndex(r => r.id === record.id);
      if (idx >= 0) {
        history[idx] = { ...history[idx], result, exitPrice, checkedAt: record.checkedAt };
        await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 });
      }
    }
  } catch (e) { console.warn('updateSignalResult error:', e.message); }
}

/**
 * Price of the 1m candle that CLOSES exactly at expiryTime. Retry semantics:
 * not-yet-closed or not-yet-published -> { retry }, permanent gap -> { missing }.
 */
export async function fetchExitPrice(pair, expiryTime, env) {
  const expiryMs = new Date(expiryTime).getTime();
  if (!Number.isFinite(expiryMs)) return { missing: true };
  const res = await fetchCandles(pair, '1min', CONFIG.FETCH_LIMITS['1min'], env, 'FOREX');
  if (res && res.error) return { error: res.error };
  // candles.js rows carry `datetime` (UTC "YYYY-MM-DD HH:mm:ss") — convert to
  // open-time ms before matching the expiry candle.
  const rows = (Array.isArray(res) ? res : []).map(c => ({
    t: new Date(String(c.datetime).replace(' ', 'T') + 'Z').getTime(),
    c: c.close,
  })).filter(k => Number.isFinite(k.t));
  const exitOpenT = expiryMs - MS_1M;
  const k = rows.find(c => c.t === exitOpenT);
  const now = Date.now();
  if (!k) {
    // Give the provider a couple of minutes to publish the candle before
    // declaring a structural gap (weekend/holiday/data hole).
    if (now < expiryMs + 2 * MS_1M) return { retry: true };
    return { missing: true };
  }
  if (now < expiryMs) return { retry: true };
  return { price: k.c };
}

/**
 * every-2-minutes cron — resolve every pending signal whose expiry has passed.
 * Transient fetch errors retry up to PENDING_MAX_CHECKS before UNKNOWN.
 */
export async function scheduledTracker(env) {
  if (!env || !env.SIGNAL_CACHE) return { checked: 0 };
  let checked = 0;
  const resolved = [];
  try {
    const pendingList = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_PENDING_PREFIX });
    const keys = (pendingList && pendingList.keys) || [];
    for (const kvEntry of keys) {
      if (checked >= 12) break;   // hard cap per tick; the next tick continues
      let record = null;
      try { record = await env.SIGNAL_CACHE.get(kvEntry.name, 'json'); } catch (e) { record = null; }
      if (!record || !record.expiryTime) {
        await env.SIGNAL_CACHE.delete(kvEntry.name);
        continue;
      }
      const dueMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.RESULT_CHECK_DELAY * 1000;
      if (Date.now() < dueMs) continue;

      const fr = await fetchExitPrice(record.pair, record.expiryTime, env);
      checked++;

      if (fr.error || fr.retry) {
        record.checks = (record.checks || 0) + 1;
        record.lastCheckError = fr.error || 'candle not ready';
        if (record.checks >= HISTORY_CONFIG.PENDING_MAX_CHECKS) {
          await updateSignalResult(record, 'UNKNOWN', null, env);
          await env.SIGNAL_CACHE.delete(kvEntry.name);
          resolved.push({ id: record.id, result: 'UNKNOWN' });
        } else {
          const remainingMs = new Date(record.expiryTime).getTime() + HISTORY_CONFIG.PENDING_TTL_MS - Date.now();
          if (remainingMs > 60000) {
            await env.SIGNAL_CACHE.put(kvEntry.name, JSON.stringify(record), { expirationTtl: Math.floor(remainingMs / 1000) });
          } else {
            await updateSignalResult(record, 'UNKNOWN', null, env);
            await env.SIGNAL_CACHE.delete(kvEntry.name);
            resolved.push({ id: record.id, result: 'UNKNOWN' });
          }
        }
        continue;
      }

      if (fr.missing) {
        await updateSignalResult(record, 'EXPIRY_GAP', null, env);
        await env.SIGNAL_CACHE.delete(kvEntry.name);
        resolved.push({ id: record.id, result: 'EXPIRY_GAP' });
        continue;
      }

      const outcome = classifyOutcome(record.direction, record.entryPrice, fr.price);
      await updateSignalResult(record, outcome, fr.price, env);
      await env.SIGNAL_CACHE.delete(kvEntry.name);
      record.exitPrice = fr.price;
      resolved.push({ id: record.id, result: outcome, record });
    }
  } catch (e) { console.warn('scheduledTracker error:', e.message); }
  return { checked, resolved };
}

// ── read APIs ────────────────────────────────────────────────────────────────
export async function readHistory(pair, env, limit = 50) {
  if (!env || !env.SIGNAL_CACHE) return [];
  try {
    const arr = await env.SIGNAL_CACHE.get(HISTORY_CONFIG.KV_SIGNAL_PREFIX + pairKey(pair), 'json');
    return (Array.isArray(arr) ? arr : []).slice(0, limit);
  } catch (e) { return []; }
}

/** Win-rate summary computed on the fly from stored rows. */
export async function computeStats(pair, env) {
  const rows = await readHistory(pair, env, HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR);
  const decided = rows.filter(r => r.result === 'WIN' || r.result === 'LOSS');
  const wins = decided.filter(r => r.result === 'WIN').length;
  const ties = rows.filter(r => r.result === 'TIE').length;
  const gaps = rows.filter(r => r.result === 'EXPIRY_GAP').length;
  const lookback = decided.slice(0, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
  const lbWins = lookback.filter(r => r.result === 'WIN').length;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const today = rows.filter(r => r.timestamp && new Date(r.timestamp).getTime() >= dayAgo);
  return {
    pair,
    engine: CONFIG.ENGINE,
    total: rows.length,
    decided: decided.length,
    wins,
    losses: decided.length - wins,
    ties,
    expiryGaps: gaps,
    winRate: decided.length ? +((100 * wins / decided.length).toFixed(1)) : null,
    recentWinRate: lookback.length ? +((100 * lbWins / lookback.length).toFixed(1)) : null,
    last24h: today.length,
    lastResult: rows.find(r => r.result) ? rows.find(r => r.result).result : null,
  };
}

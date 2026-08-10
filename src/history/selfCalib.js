/**
 * SELF-CALIBRATION (C7) — weekly refresh of the calibration tables.
 *
 * The 2026-08-09 calibration (CALIB in calibration.js) was derived once from
 * TRAIN 08-01..06 and then frozen. This module makes the engine drift-proof:
 * every week (CONFIG.SELF_CALIB.CRON) it recomputes the WR tables from the LAST
 * CONFIG.SELF_CALIB.WINDOW_DAYS of decided history in KV (sig:*), stores them under
 * `calib:latest`, and the engine consumes them as the ACTIVE calibration.
 *
 * Tables recomputed (window = last N days, NOT lifetime):
 *   base          — pooled WR over the window
 *   structWR      — WR per structureVerdict overall (feeds calibration.js)
 *   confBucketWR  — WR per raw-confidence bucket via coreConfidence (feeds
 *                   calibration.js — the calibrated output layer, R3 intact)
 *   hourWR        — per-UTC-hour {wins, losses, n, wr} (feeds the hour
 *                   multiplier in edgeFeatures.js, CONFIG.SELF_CALIB.MIN_HOUR_OBS gate)
 *   pairWR        — per-pair WR (informational; the live rolling-20 recent-form
 *                   gate reads stats:* directly, so this is not double-counted)
 *   sessionWR     — per-session WR (informational for the weekly review;
 *                   SESSION_PAIR_WEIGHTS stay static until a review applies it)
 *
 * Refresh cadence (documented): weekly, Monday 00:00 UTC (wrangler.toml
 * [triggers] + index.js scheduled()). On demand: recomputeCalibration(env).
 * Safety rails: fewer than MIN_OBS decided rows → keep the previous tables
 * (no write); a cell with < MIN_CELL_OBS → keeps the static CALIB value;
 * calib:latest older than MAX_AGE_DAYS is ignored by loadCalibration() so a
 * stale table can never pin the engine.
 *
 * Initial values: the static CALIB block + EDGE_FEATURES.HOUR_MULTIPLIERS
 * (both derived from TRAIN 08-01..06, see those files). No double-calibration:
 * the recomputed tables REPLACE the WR tables used by the SAME calibrated
 * output mapping (grade thresholds stay quantile-derived; re-derive them via
 * scripts/calibration_validation.py when monotonicity breaks).
 */

import { CONFIG } from '../config.js';

// ── KV schema ────────────────────────────────────────────────────────────
// calib:latest -> JSON { version, computedAt, windowDays, n, base, structWR,
//                       confBucketWR, hourWR, pairWR, sessionWR }
// (isolated under its own `calib:` prefix — never touches sig:/stats:/pending:)

function pairKey(pair) {
  return String(pair).replace(/\//g, '_').replace(/-/g, '_');
}

function confBucketOf(rawConf) {
  let c = rawConf;
  if (typeof c === 'string') {
    const m = c.match(/([\d.]+)/);
    if (m) c = parseFloat(m[1]);
  }
  if (typeof c !== 'number' || isNaN(c)) c = 72;
  if (c < 75) return '72-75';
  if (c < 80) return '76-79';
  if (c < 84) return '80-83';
  if (c < 88) return '84-87';
  return '88+';
}

function addWinLoss(table, key, winLoss) {
  if (!table[key]) table[key] = { wins: 0, losses: 0, n: 0, wr: 0 };
  const t = table[key];
  if (winLoss === 'WIN') t.wins++;
  else if (winLoss === 'LOSS') t.losses++;
  t.n = t.wins + t.losses;
  t.wr = t.n > 0 ? t.wins / t.n : 0;
}

/**
 * Recompute the calibration tables from the last WINDOW_DAYS of decided
 * history and write `calib:latest`. Fail-open: returns the tables on success,
 * null on any error or when the observation minimum is not met.
 */
export async function recomputeCalibration(env) {
  try {
    if (!env || !env.SIGNAL_CACHE) return null;

    const windowMs = (CONFIG.SELF_CALIB.WINDOW_DAYS || 14) * 24 * 3600 * 1000;
    const cutoff = Date.now() - windowMs;

    // 1. enumerate sig:* history keys
    const list = await env.SIGNAL_CACHE.list({ prefix: 'sig:' });
    if (!list || !list.keys || list.keys.length === 0) return null;

    // 2. collect decided rows inside the window
    const rows = [];
    for (const kv of list.keys) {
      let history = null;
      try { history = await env.SIGNAL_CACHE.get(kv.name, 'json'); } catch (e) { continue; }
      if (!Array.isArray(history)) continue;
      for (const rec of history) {
        if (!rec || (rec.result !== 'WIN' && rec.result !== 'LOSS')) continue;
        const t = rec.timestamp ? new Date(rec.timestamp).getTime() : NaN;
        if (!isFinite(t) || t < cutoff) continue;
        rows.push(rec);
      }
    }
    if (rows.length < (CONFIG.SELF_CALIB.MIN_OBS || 100)) {
      console.log('selfCalib: only ' + rows.length + ' decided rows in window — keeping previous tables (min ' + (CONFIG.SELF_CALIB.MIN_OBS || 100) + ')');
      return null;
    }

    // 3. tables
    const structWR = {};
    const confBucketWR = {};
    const hourWR = {};
    const pairWR = {};
    const sessionWR = {};
    let wins = 0;

    for (const rec of rows) {
      if (rec.result === 'WIN') wins++;
      const struct = rec.structureVerdict || 'N/A';
      addWinLoss(structWR, struct, rec.result);
      const bucket = confBucketOf(rec.coreConfidence);
      addWinLoss(confBucketWR, bucket, rec.result);
      try {
        const dt = new Date(rec.timestamp);
        const hour = dt.getUTCHours();
        if (!isNaN(hour)) addWinLoss(hourWR, hour, rec.result);
      } catch (e) { /* skip malformed timestamps */ }
      addWinLoss(pairWR, rec.pair || 'UNKNOWN', rec.result);
      const sess = (rec.sessionQuality && rec.sessionQuality !== 'N/A') ? rec.sessionQuality : null;
      if (sess) addWinLoss(sessionWR, sess, rec.result);
    }

    const base = wins / rows.length;

    // 4. fill MIN_CELL_OBS gaps with the static CALIB values (fail-safe)
    const { CALIB } = await import('../analysis/calibration.js');
    const minCell = CONFIG.SELF_CALIB.MIN_CELL_OBS || 30;
    const mergedStruct = { ...CALIB.structWR };
    const mergedConf = { ...CALIB.confBucketWR };
    for (const k of Object.keys(structWR)) {
      if (structWR[k].n >= minCell) mergedStruct[k] = structWR[k].wr;
    }
    for (const k of Object.keys(confBucketWR)) {
      if (confBucketWR[k].n >= minCell) mergedConf[k] = confBucketWR[k].wr;
    }

    const payload = {
      version: 'selfcalib-' + new Date().toISOString().slice(0, 10),
      computedAt: new Date().toISOString(),
      windowDays: CONFIG.SELF_CALIB.WINDOW_DAYS || 14,
      n: rows.length,
      base,
      structWR: mergedStruct,
      confBucketWR: mergedConf,
      hourWR,
      pairWR,
      sessionWR,
    };

    await env.SIGNAL_CACHE.put(
      CONFIG.SELF_CALIB.KV_KEY || 'calib:latest',
      JSON.stringify(payload),
      { expirationTtl: ((CONFIG.SELF_CALIB.WINDOW_DAYS || 14) + 2) * 24 * 3600 }
    );
    console.log('selfCalib: recomputed from ' + rows.length + ' rows (base WR ' + (base * 100).toFixed(1) + '%)');
    return payload;
  } catch (e) {
    console.warn('selfCalib recompute failed (fail-open): ' + e.message);
    return null;
  }
}

/**
 * Load the active dynamic calibration. Returns null when absent, stale
 * (> MAX_AGE_DAYS) or malformed — the engine then uses the static CALIB.
 */
export async function loadCalibration(env) {
  try {
    if (!env || !env.SIGNAL_CACHE) return null;
    const raw = await env.SIGNAL_CACHE.get(CONFIG.SELF_CALIB.KV_KEY || 'calib:latest', 'json');
    if (!raw || typeof raw !== 'object') return null;
    const computedAt = raw.computedAt ? new Date(raw.computedAt).getTime() : NaN;
    const maxAge = (CONFIG.SELF_CALIB.MAX_AGE_DAYS || 8) * 24 * 3600 * 1000;
    if (!isFinite(computedAt) || Date.now() - computedAt > maxAge) return null;
    if (typeof raw.base !== 'number' || typeof raw.structWR !== 'object' || typeof raw.confBucketWR !== 'object') return null;
    return raw;
  } catch (e) {
    return null; // fail-open: static CALIB stays authoritative
  }
}

// ── Test-only exports ────────────────────────────────────────────────────
export const __selfCalibTest = { pairKey, confBucketOf, addWinLoss };

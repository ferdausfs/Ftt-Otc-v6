import { CALIB } from './calibration.js';
import { CONFIG, HISTORY_CONFIG } from '../config.js';

export const SELF_CALIB_KEY = 'calibration:rolling:v1';
const key = pair => HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g, '_').replace(/-/g, '_');
const wr = rows => rows.length ? rows.filter(x => x.result === 'WIN').length / rows.length : null;

/** Recomputes only empirical lookup inputs from resolved forward history.
 * Grade thresholds remain frozen until separately re-derived by validation: this
 * avoids a weekly threshold fit and preserves the calibrated output contract. */
export async function refreshRollingCalibration(env, pairs = []) {
  if (!env || !env.SIGNAL_CACHE) return { refreshed: false, reason: 'NO_KV' };
  const c = CONFIG.EDGE_FEATURES;
  const old = await env.SIGNAL_CACHE.get(SELF_CALIB_KEY, 'json');
  if (old && old.generatedAt && Date.now() - Date.parse(old.generatedAt) < c.refreshIntervalHours * 3600000)
    return { refreshed: false, reason: 'NOT_DUE', snapshot: old };
  const rows = [];
  for (const pair of pairs) {
    const h = await env.SIGNAL_CACHE.get(key(pair), 'json');
    for (const row of Array.isArray(h) ? h : []) {
      const age = Date.now() - Date.parse(row.checkedAt || row.timestamp || 0);
      if ((row.result === 'WIN' || row.result === 'LOSS') && age >= 0 && age <= c.refreshDays * 86400000) rows.push(row);
    }
  }
  if (rows.length < c.refreshMinSample) return { refreshed: false, reason: 'INSUFFICIENT_SAMPLE', sampleSize: rows.length };
  const base = wr(rows);
  const structWR = { ...CALIB.structWR }; const confBucketWR = { ...CALIB.confBucketWR }; const hourMultipliers = {};
  for (const name of Object.keys(structWR)) { const v = wr(rows.filter(r => (r.structureVerdict || 'UNKNOWN') === name)); if (v !== null && rows.filter(r => (r.structureVerdict || 'UNKNOWN') === name).length >= c.refreshMinSample) structWR[name] = v; }
  for (const bucket of Object.keys(confBucketWR)) {
    const matches = rows.filter(r => { const n = parseFloat(r.coreConfidence ?? r.confidence); return bucket === '88+' ? n >= 88 : bucket === '72-75' ? n < 76 : bucket === '76-79' ? n < 80 : bucket === '80-83' ? n < 84 : n < 88; });
    const v = wr(matches); if (v !== null && matches.length >= c.refreshMinSample) confBucketWR[bucket] = v;
  }
  for (let hour = 0; hour < 24; hour++) { const x = rows.filter(r => r.signalIndicators && r.signalIndicators.hourUTC === hour); const v = wr(x); if (v !== null && x.length >= c.refreshMinSample) hourMultipliers[hour] = Math.max(c.hourMinMultiplier, Math.min(c.hourMaxMultiplier, v / base)); }
  const snapshot = { version: 'rolling-v1', generatedAt: new Date().toISOString(), sourceDays: c.refreshDays, sampleSize: rows.length, base, structWR, confBucketWR, hourMultipliers };
  await env.SIGNAL_CACHE.put(SELF_CALIB_KEY, JSON.stringify(snapshot), { expirationTtl: c.refreshDays * 2 * 86400 });
  return { refreshed: true, snapshot };
}

export async function getRollingCalibration(env) {
  try { return env && env.SIGNAL_CACHE ? await env.SIGNAL_CACHE.get(SELF_CALIB_KEY, 'json') : null; } catch (_) { return null; }
}

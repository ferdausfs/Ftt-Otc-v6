import { EDGE_FEATURE_CONFIG, HISTORY_CONFIG } from '../config.js';
import { CALIB } from './calibration.js';

const CFG = EDGE_FEATURE_CONFIG.ADAPTIVE_CALIBRATION;

function pairKeyToPair(key) {
  return String(key || '')
    .replace(HISTORY_CONFIG.KV_SIGNAL_PREFIX, '')
    .replace(/_/g, '/');
}

function numericConfidence(row) {
  // New rows persist the exact post-filter raw confidence. Before CALIB was
  // deployed `confidence` itself was raw; coreConfidence is only a pre-filter
  // fallback and therefore comes last.
  const candidates = [row && row.calibrationRawConfidence, row && row.confidence, row && row.coreConfidence];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function confidenceBucket(row) {
  const confidence = numericConfidence(row);
  if (confidence === null || confidence < 75) return '72-75';
  if (confidence < 80) return '76-79';
  if (confidence < 84) return '80-83';
  if (confidence < 88) return '84-87';
  return '88+';
}

function structureOverall(row) {
  const value = row && row.structureVerdict;
  if (value && typeof value === 'object') return value.overall || 'UNKNOWN';
  return value || 'UNKNOWN';
}

function firstSession(row) {
  if (Array.isArray(row && row.session) && row.session.length) return row.session[0];
  return (row && row.session) || 'UNKNOWN';
}

function decidedRows(rows, now) {
  const end = now.getTime();
  const start = end - CFG.lookbackDays * 24 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || (row.result !== 'WIN' && row.result !== 'LOSS') || row.cbShadow === true) return false;
    const stamp = new Date(row.timestamp).getTime();
    return Number.isFinite(stamp) && stamp >= start && stamp <= end;
  });
}

function wins(rows) {
  let count = 0;
  for (const row of rows) if (row.result === 'WIN') count++;
  return count;
}

function grouped(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = String(keyFn(row));
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

function smoothedRate(rows, base) {
  if (!rows || rows.length < CFG.minBucketRows) return null;
  const prior = CFG.shrinkageRows;
  return (wins(rows) + prior * base) / (rows.length + prior);
}

function empiricalTable(rows, keyFn, base, fallback = {}) {
  const groups = grouped(rows, keyFn);
  const output = { ...fallback };
  const samples = {};
  for (const [key, values] of Object.entries(groups)) {
    const rate = smoothedRate(values, base);
    samples[key] = values.length;
    if (rate !== null) output[key] = rate;
  }
  return { values: output, samples };
}

function multiplierTable(rows, keyFn, base) {
  const groups = grouped(rows, keyFn);
  const output = {};
  const samples = {};
  for (const [key, values] of Object.entries(groups)) {
    const rate = smoothedRate(values, base);
    samples[key] = values.length;
    if (rate === null || base <= 0) continue;
    output[key] = Math.max(CFG.weightMin, Math.min(CFG.weightMax, rate / base));
  }
  return { values: output, samples };
}

/**
 * Pure derivation used by both the weekly Worker refresh and unit tests.
 * Only the trailing configured window is admitted; lifetime counters never
 * enter this calculation.
 */
export function deriveAdaptiveProfile(allRows, now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const rows = decidedRows(allRows, date);
  if (rows.length < CFG.minRows) {
    return {
      status: 'INSUFFICIENT_DATA', rowCount: rows.length,
      requiredRows: CFG.minRows, generatedAt: date.toISOString(),
    };
  }

  const base = wins(rows) / rows.length;
  const struct = empiricalTable(rows, structureOverall, base, CALIB.structWR);
  const confidence = empiricalTable(rows, confidenceBucket, base, CALIB.confBucketWR);
  const hour = multiplierTable(rows, row => new Date(row.timestamp).getUTCHours(), base);
  const pair = multiplierTable(rows, row => row.pair || 'UNKNOWN', base);
  const session = multiplierTable(rows, firstSession, base);

  return {
    status: 'READY',
    version: 'adaptive-' + date.toISOString().slice(0, 10),
    generatedAt: date.toISOString(),
    windowStart: new Date(date.getTime() - CFG.lookbackDays * 86400000).toISOString(),
    windowEnd: date.toISOString(),
    lookbackDays: CFG.lookbackDays,
    rowCount: rows.length,
    calibration: {
      base,
      structWR: struct.values,
      confBucketWR: confidence.values,
      // Thresholds are holdout-guarded and remain the CALIB output mapper.  The
      // empirical input tables drift weekly; this avoids double calibration.
      gradeThresholds: { ...CALIB.gradeThresholds },
      confThresholds: { ...CALIB.confThresholds },
      confValues: { ...CALIB.confValues },
      version: 'adaptive-' + date.toISOString().slice(0, 10),
    },
    weights: {
      hour: hour.values,
      pair: pair.values,
      session: session.values,
    },
    samples: {
      structure: struct.samples,
      confidence: confidence.samples,
      hour: hour.samples,
      pair: pair.samples,
      session: session.samples,
    },
  };
}

async function listHistoryKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const options = { prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX, limit: 1000 };
    if (cursor) options.cursor = cursor;
    const page = await kv.list(options);
    if (!page || !Array.isArray(page.keys)) break;
    keys.push(...page.keys.map(item => item.name).filter(Boolean));
    cursor = page.list_complete === false ? page.cursor : null;
  } while (cursor);
  return keys;
}

async function loadHistoryRows(kv) {
  const keys = await listHistoryKeys(kv);
  const rows = [];
  // Keep concurrent KV reads bounded; this also makes the refresh safe if the
  // namespace later contains hundreds of pairs.
  for (let offset = 0; offset < keys.length; offset += 20) {
    const batch = keys.slice(offset, offset + 20);
    const values = await Promise.all(batch.map(async (key) => {
      try {
        const history = await kv.get(key, 'json');
        const pair = pairKeyToPair(key);
        return Array.isArray(history)
          ? history.map(row => ({ ...row, pair: row.pair || pair }))
          : [];
      } catch (_) { return []; }
    }));
    for (const value of values) rows.push(...value);
  }
  return rows;
}

export async function loadAdaptiveProfile(env, now = new Date()) {
  if (!CFG.enabled || !env || !env.SIGNAL_CACHE) return null;
  try {
    const profile = await env.SIGNAL_CACHE.get(CFG.kvKey, 'json');
    if (!profile || profile.status !== 'READY' || !profile.generatedAt) return null;
    const age = (new Date(now).getTime() - new Date(profile.generatedAt).getTime()) / 86400000;
    if (!Number.isFinite(age) || age < -1 || age > CFG.maxProfileAgeDays) return null;
    return profile;
  } catch (_) { return null; }
}

/** Weekly, idempotent refresh. Safe to call from every result-check cron. */
export async function refreshAdaptiveCalibration(env, options = {}) {
  if (!CFG.enabled || !env || !env.SIGNAL_CACHE) return { status: 'DISABLED_OR_NO_KV' };
  const now = options.now ? new Date(options.now) : new Date();
  try {
    const existing = await env.SIGNAL_CACHE.get(CFG.kvKey, 'json');
    if (!options.force && existing && existing.generatedAt) {
      const ageDays = (now.getTime() - new Date(existing.generatedAt).getTime()) / 86400000;
      if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < CFG.refreshDays) {
        return { status: 'FRESH', profile: existing };
      }
    }

    const rows = await loadHistoryRows(env.SIGNAL_CACHE);
    const profile = deriveAdaptiveProfile(rows, now);
    if (profile.status !== 'READY') return profile;
    await env.SIGNAL_CACHE.put(CFG.kvKey, JSON.stringify(profile), {
      expirationTtl: CFG.profileTtlSeconds,
    });
    return { status: 'REFRESHED', profile };
  } catch (error) {
    console.warn('adaptive calibration refresh failed (fail-open): ' + error.message);
    return { status: 'ERROR', error: error.message };
  }
}

export const __adaptiveTest = {
  confidenceBucket, structureOverall, firstSession, decidedRows,
  smoothedRate, listHistoryKeys,
};

import { CONFIG, EDGE_FEATURE_CONFIG, HISTORY_CONFIG } from '../config.js';
import { CALIB } from './calibration.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace('%', ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function decided(row) {
  // edge-v1 runs on the standard engine. OTC uses synthetic pricing and keeps
  // its separate scoring path, so mixing those outcomes would be data leakage.
  return row && (row.result === 'WIN' || row.result === 'LOSS')
    && row.cbShadow !== true && row.isOTC !== true;
}

function timestampMs(row) {
  const value = new Date(row && row.timestamp).getTime();
  return Number.isFinite(value) ? value : null;
}

function rawConfidence(row) {
  const core = finite(row && row.coreConfidence);
  if (core !== null) return core;
  return finite(row && row.confidence);
}

function confBucket(row) {
  const value = rawConfidence(row);
  if (value === null || value < 75) return '72-75';
  if (value < 80) return '76-79';
  if (value < 84) return '80-83';
  if (value < 88) return '84-87';
  return '88+';
}

function structure(row) {
  const value = row && row.structureVerdict;
  return value && typeof value === 'object' ? value.overall : value;
}

function sessionName(row) {
  if (!row) return 'UNKNOWN';
  if (Array.isArray(row.session) && row.session.length > 1) {
    const names = new Set(row.session);
    if (names.has('LONDON') && names.has('NEW_YORK')) return 'LONDON_NY';
    if (names.has('ASIAN') && names.has('LONDON')) return 'ASIAN_LONDON';
  }
  return Array.isArray(row.session) && row.session.length ? row.session[0] : 'UNKNOWN';
}

function wr(rows) {
  if (!rows.length) return null;
  return rows.filter(row => row.result === 'WIN').length / rows.length;
}

function wilson(wins, n, z = 1.96) {
  if (!n) return [null, null];
  const p = wins / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const delta = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, center - delta), Math.min(1, center + delta)];
}

function rounded(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function grouped(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === null || key === undefined || key === '') continue;
    if (!map.has(String(key))) map.set(String(key), []);
    map.get(String(key)).push(row);
  }
  return map;
}

function empiricalTable(rows, keyFn, base, config, fallback = {}) {
  const output = { ...fallback };
  const samples = {};
  for (const [key, bucket] of grouped(rows, keyFn)) {
    samples[key] = bucket.length;
    if (bucket.length < config.minBucketSamples) continue;
    const wins = bucket.filter(row => row.result === 'WIN').length;
    output[key] = rounded((wins + config.priorStrength * base)
      / (bucket.length + config.priorStrength));
  }
  return { values: output, samples };
}

function multiplierTable(rows, keyFn, base, config, fallback = {}) {
  const empirical = empiricalTable(rows, keyFn, base, config);
  const values = { ...fallback };
  for (const [key, rate] of Object.entries(empirical.values)) {
    values[key] = rounded(Math.max(config.minMultiplier,
      Math.min(config.maxMultiplier, rate / Math.max(base, 1e-9))), 3);
  }
  return { values, samples: empirical.samples };
}

function calibrationScore(row, calibration) {
  const structValue = finite(calibration.structWR[structure(row)]);
  const confValue = finite(calibration.confBucketWR[confBucket(row)]);
  return ((structValue ?? calibration.base) + (confValue ?? calibration.base)) / 2;
}

function gradeForScore(score) {
  const thresholds = CALIB.gradeThresholds;
  if (score >= thresholds.Aplus) return 'A+';
  if (score >= thresholds.A) return 'A';
  if (score >= thresholds.B) return 'B';
  return 'C';
}

function reportedConfidenceBucket(score) {
  const thresholds = CALIB.confThresholds;
  if (score < thresholds.t1) return '72-75';
  if (score < thresholds.t2) return '76-79';
  if (score < thresholds.t3) return '80-83';
  if (score < thresholds.t4) return '84-87';
  return '88-92';
}

function monotonicCalibrationValidation(rows, calibration, config) {
  const validate = (keyFn, order) => {
    const buckets = grouped(rows, row => keyFn(calibrationScore(row, calibration)));
    const cells = {};
    const populated = [];
    for (const key of order) {
      const values = buckets.get(key) || [];
      const wins = values.filter(row => row.result === 'WIN').length;
      const ci = wilson(wins, values.length);
      cells[key] = { n: values.length, wr: rounded(wr(values)), wilson95: ci.map(value => rounded(value)) };
      if (values.length >= config.minBucketSamples) populated.push(cells[key]);
    }
    let nonInverted = true;
    for (let i = 1; i < populated.length; i++) {
      const previous = populated[i - 1]; const current = populated[i];
      const overlap = previous.wilson95[0] <= current.wilson95[1]
        && current.wilson95[0] <= previous.wilson95[1];
      if (current.wr < previous.wr && !overlap) nonInverted = false;
    }
    return { cells, nonInverted, populatedBuckets: populated.length };
  };
  const grades = validate(gradeForScore, ['C','B','A','A+']);
  const confidence = validate(reportedConfidenceBucket, ['72-75','76-79','80-83','84-87','88-92']);
  return {
    grades,
    confidence,
    passed: grades.nonInverted && confidence.nonInverted,
  };
}

function simulateWeightGate(rows, tables, config) {
  const kept = [];
  for (const row of rows) {
    const confidence = rawConfidence(row);
    if (confidence === null) continue;
    const stamp = new Date(row.timestamp);
    const hour = Number.isFinite(stamp.getTime()) ? stamp.getUTCHours() : null;
    const hourMultiplier = hour === null ? 1 : finite(tables.hourMultipliers[hour]) || 1;
    const pairMultiplier = finite(tables.pairMultipliers[row.pair]) || 1;
    const sessMultiplier = finite(tables.sessionMultipliers[sessionName(row)]) || 1;
    const adaptiveMultiplier = Math.max(config.minMultiplier,
      Math.min(config.maxMultiplier, pairMultiplier * sessMultiplier));
    if (confidence * hourMultiplier * adaptiveMultiplier >= CONFIG.MIN_CONFIDENCE_FLOOR) kept.push(row);
  }
  return kept;
}

/**
 * Pure weekly recomputation. Latest holdoutDays are never used to derive a
 * table; they only decide whether the candidate snapshot may become ACTIVE.
 */
export function recomputeAdaptiveTables(rows, asOf = new Date(), overrides = {}) {
  const config = { ...EDGE_FEATURE_CONFIG.ADAPTIVE, ...overrides };
  const endMs = new Date(asOf).getTime();
  if (!Number.isFinite(endMs)) throw new Error('Invalid adaptive calibration asOf');
  const startMs = endMs - config.windowDays * DAY_MS;
  const splitMs = endMs - config.holdoutDays * DAY_MS;
  const windowRows = (Array.isArray(rows) ? rows : [])
    .filter(decided)
    .filter(row => {
      const stamp = timestampMs(row);
      return stamp !== null && stamp >= startMs && stamp <= endMs;
    })
    .sort((a, b) => timestampMs(a) - timestampMs(b));
  const train = windowRows.filter(row => timestampMs(row) < splitMs);
  const holdout = windowRows.filter(row => timestampMs(row) >= splitMs);
  const base = wr(train) ?? CALIB.base;

  const struct = empiricalTable(train, structure, base, config, CALIB.structWR);
  const conf = empiricalTable(train, confBucket, base, config, CALIB.confBucketWR);
  const hours = multiplierTable(train, row => new Date(row.timestamp).getUTCHours(), base, config,
    EDGE_FEATURE_CONFIG.HOUR.multipliers);
  const pairs = multiplierTable(train, row => row.pair, base, config);
  const sessions = multiplierTable(train, sessionName, base, config);

  const calibrationCandidate = {
    base: rounded(base),
    structWR: struct.values,
    confBucketWR: conf.values,
  };
  const candidateTables = {
    hourMultipliers: hours.values,
    pairMultipliers: pairs.values,
    sessionMultipliers: sessions.values,
  };
  const gatedHoldout = simulateWeightGate(holdout, candidateTables, config);
  const calibrationValidation = monotonicCalibrationValidation(
    holdout, calibrationCandidate, config,
  );
  const holdoutWins = holdout.filter(row => row.result === 'WIN').length;
  const gatedWins = gatedHoldout.filter(row => row.result === 'WIN').length;
  const offCi = wilson(holdoutWins, holdout.length);
  const onCi = wilson(gatedWins, gatedHoldout.length);
  const cisOverlap = offCi[0] !== null && onCi[0] !== null
    ? offCi[0] <= onCi[1] && onCi[0] <= offCi[1] : false;
  const coverage = holdout.length ? gatedHoldout.length / holdout.length : 0;
  const offWr = wr(holdout);
  const onWr = wr(gatedHoldout);
  const enough = train.length >= config.minTrainSamples
    && holdout.length >= config.minHoldoutSamples
    && coverage >= config.minimumCoverage;
  const nonHarm = onWr !== null && offWr !== null
    && (onWr >= offWr - config.holdoutWrTolerance || cisOverlap);
  const status = enough && nonHarm && calibrationValidation.passed
    ? 'ACTIVE' : 'REJECTED_HOLDOUT';

  return {
    version: 'adaptive-v1-' + new Date(endMs).toISOString().slice(0, 10),
    status,
    generatedAt: new Date(endMs).toISOString(),
    window: {
      start: new Date(startMs).toISOString(),
      trainEndExclusive: new Date(splitMs).toISOString(),
      end: new Date(endMs).toISOString(),
      trainSamples: train.length,
      holdoutSamples: holdout.length,
    },
    calibration: calibrationCandidate,
    hourMultipliers: hours.values,
    pairMultipliers: pairs.values,
    sessionMultipliers: sessions.values,
    samples: {
      structure: struct.samples,
      confidence: conf.samples,
      hour: hours.samples,
      pair: pairs.samples,
      session: sessions.samples,
    },
    validation: {
      featureOff: { n: holdout.length, wr: rounded(offWr), wilson95: offCi.map(value => rounded(value)) },
      featureOn: { n: gatedHoldout.length, wr: rounded(onWr), wilson95: onCi.map(value => rounded(value)) },
      coverage: rounded(coverage),
      cisOverlap,
      enoughSamples: enough,
      nonHarm,
      calibration: calibrationValidation,
    },
  };
}

export async function readAdaptiveSnapshot(env) {
  const config = EDGE_FEATURE_CONFIG.ADAPTIVE;
  if (!config.enabled || !env || !env.SIGNAL_CACHE) return null;
  try {
    const snapshot = await env.SIGNAL_CACHE.get(config.kvKey, 'json');
    if (!snapshot || snapshot.status !== 'ACTIVE') return null;
    const generatedMs = new Date(snapshot.generatedAt).getTime();
    if (!Number.isFinite(generatedMs) || Date.now() - generatedMs > config.ttlDays * DAY_MS) return null;
    return snapshot;
  } catch (error) {
    console.warn('Adaptive snapshot read failed (static config retained): ' + error.message);
    return null;
  }
}

async function loadWorkerHistory(env) {
  const listing = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX });
  if (!listing || !Array.isArray(listing.keys)) return [];
  const chunks = await Promise.all(listing.keys.map(async entry => {
    try {
      const value = await env.SIGNAL_CACHE.get(entry.name, 'json');
      return Array.isArray(value) ? value : [];
    } catch (error) { return []; }
  }));
  const byId = new Map();
  for (const row of chunks.flat()) {
    if (row && row.id) byId.set(row.id, row);
  }
  return [...byId.values()];
}

export async function refreshAdaptiveCalibration(env, asOf = new Date()) {
  const config = EDGE_FEATURE_CONFIG.ADAPTIVE;
  if (!config.enabled || !env || !env.SIGNAL_CACHE) return null;
  const rows = await loadWorkerHistory(env);
  const snapshot = recomputeAdaptiveTables(rows, asOf);
  await env.SIGNAL_CACHE.put(config.kvKey, JSON.stringify(snapshot), {
    expirationTtl: config.ttlDays * 24 * 60 * 60,
  });
  console.log('Adaptive calibration refresh: status=' + snapshot.status
    + ' train=' + snapshot.window.trainSamples + ' holdout=' + snapshot.window.holdoutSamples);
  return snapshot;
}

/** Cheap cron guard: one KV read every result-check tick, full refresh weekly. */
export async function maybeRefreshAdaptiveCalibration(env, asOf = new Date()) {
  const config = EDGE_FEATURE_CONFIG.ADAPTIVE;
  if (!config.enabled || !env || !env.SIGNAL_CACHE) return null;
  try {
    const existing = await env.SIGNAL_CACHE.get(config.kvKey, 'json');
    const generatedMs = existing ? new Date(existing.generatedAt).getTime() : NaN;
    const nowMs = new Date(asOf).getTime();
    if (Number.isFinite(generatedMs) && Number.isFinite(nowMs)
        && nowMs - generatedMs < config.refreshEveryDays * DAY_MS) return existing;

    // KV has no atomic create-if-absent. A short best-effort lock still prevents
    // normal duplicate work; a rare race is harmless because both writes are
    // deterministic for the same history/asOf window.
    const lock = await env.SIGNAL_CACHE.get(config.lockKey);
    if (lock) return existing || null;
    await env.SIGNAL_CACHE.put(config.lockKey, new Date(nowMs).toISOString(), { expirationTtl: config.lockTtlSeconds });
    try { return await refreshAdaptiveCalibration(env, asOf); }
    finally { await env.SIGNAL_CACHE.delete(config.lockKey).catch(() => {}); }
  } catch (error) {
    console.warn('Adaptive calibration refresh failed (fail-open): ' + error.message);
    return null;
  }
}

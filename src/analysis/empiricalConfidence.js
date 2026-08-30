/**
 * EC-V2 — Empirical Confidence v2 (2026-08-30).
 *
 * FIX-1 of the Signal Logic & Parameter Distortion Audit
 * (Workplace-drive-/reports/SIGNAL_LOGIC_DISTORTION_AUDIT_2026-08-30.md).
 *
 * Why: the v1 decision variable (vote-share consensus confidence) has no
 * predictive variance — 99.98% of surviving signals sit in ALL_* alignment
 * (D2), 5 oscillator categories are one observation counted five times (D1),
 * HTF/structure are recounted 3-4x (D3) and the calibrated ladder is still
 * non-monotone (D5). Meanwhile the features that DO hold forward (hour-of-day
 * 11.3pp spread, RSI-zone×direction, structure inversion, fill-state) are
 * marginalized into ±10% multipliers (D4).
 *
 * What: evidence-only score = weighted sum of MEASURED forward WR cells
 * (crypto pool 08-01..30, n=4,626). Every cell WR lives in
 * CONFIG.EMPIRICAL_CONFIDENCE (R4) and comes from the 2026-08-30 audits —
 * unmeasured/missing cells fall back to the pool base WR (no invented
 * numbers). NO consensus/alignment/confluence input exists in this module —
 * that is the whole point (D1-D3 removal).
 *
 * Design rules:
 *   - Pure + deterministic: no wall clock, no network, no KV.
 *   - Input-side of NOTHING: it does not touch the engine multipliers. In
 *     'shadow' mode it is additive instrumentation only; in 'decision' mode
 *     the CALLER (engine.js) replaces the report confidence/grade — this
 *     module only computes.
 *   - Fail-soft: the engine wraps the attach call in try/catch, so any error
 *     here leaves the production signal unchanged.
 *
 * Cell definitions (match the audit measurement exactly):
 *   hour        GOOD hourMult>=1.05 / BAD hourMult<=0.90 / else NEUTRAL
 *               (hourMult = the edge-features hour multiplier, static or
 *               self-calib dynamic — the same value the engine applied)
 *   BUY  RSI    <=35 EXTREME_LOW / 45-55 MID / >55 CHASE / else BASE
 *   SELL RSI    <45 CHASE / 45-55 MID / >=65 EXTREME_HIGH / else BASE
 *   structure   AGAINST / ALIGNED / NEUTRAL (MIXED + N/A → BASE)
 *   fillState   PENDING_ENTRY / INSTANT (null → BASE)
 */

import { CONFIG } from '../config.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round4 = (x) => Math.round(x * 10000) / 10000;

function isNum(v) { return typeof v === 'number' && isFinite(v); }

function hourCell(hourMult) {
  if (!isNum(hourMult)) return 'BASE';
  if (hourMult >= 1.05) return 'GOOD';
  if (hourMult <= 0.90) return 'BAD';
  return 'NEUTRAL';
}

function rsiCell(direction, rsi) {
  if (!isNum(rsi)) return 'BASE';
  if (direction === 'BUY') {
    if (rsi <= 35) return 'EXTREME_LOW';
    if (rsi > 55) return 'CHASE';
    if (rsi >= 45) return 'MID';
    return 'BASE';           // 35..45 unmeasured → pool base
  }
  if (direction === 'SELL') {
    if (rsi < 45) return 'CHASE';
    if (rsi <= 55) return 'MID';
    if (rsi >= 65) return 'EXTREME_HIGH';
    return 'BASE';           // 55..65 unmeasured → pool base
  }
  return 'BASE';
}

function structureCell(overall) {
  return (overall === 'AGAINST' || overall === 'ALIGNED' || overall === 'NEUTRAL')
    ? overall : 'BASE';
}

function fillCell(fillStatus) {
  return (fillStatus === 'PENDING_ENTRY' || fillStatus === 'INSTANT') ? fillStatus : 'BASE';
}

/**
 * Compute the EC-V2 score.
 *
 * ctx: { direction, hourMult, rsi, structureOverall, fillStatus }
 *   direction        'BUY' | 'SELL' (caller guarantees non-NO_TRADE)
 *   hourMult         edge-features hour multiplier (or null)
 *   rsi              best-TF RSI (or null)
 *   structureOverall structureVerdict.overall (or null)
 *   fillStatus       signal fillStatus (or null)
 *
 * Returns { version, mode, score, confidence, grade, cells, wrs }.
 */
export function computeEmpiricalConfidence(ctx) {
  const cfg = CONFIG.EMPIRICAL_CONFIDENCE;
  const base = cfg.baseWr;
  const direction = ctx && ctx.direction === 'SELL' ? 'SELL' : 'BUY';

  const specs = [
    { name: 'hour', weight: cfg.weights.hour,
      cell: hourCell(ctx && ctx.hourMult),
      table: cfg.cells.hour },
    { name: 'rsiDirection', weight: cfg.weights.rsiDirection,
      cell: rsiCell(direction, ctx && ctx.rsi),
      table: (cfg.cells.rsiDirection && cfg.cells.rsiDirection[direction]) || null },
    { name: 'structure', weight: cfg.weights.structure,
      cell: structureCell(ctx && ctx.structureOverall),
      table: cfg.cells.structure },
    { name: 'fillState', weight: cfg.weights.fillState,
      cell: fillCell(ctx && ctx.fillStatus),
      table: cfg.cells.fillState },
  ];

  let score = 0;
  const cells = {};
  const wrs = {};
  for (const s of specs) {
    let wr;
    if (s.cell !== 'BASE' && s.table && typeof s.table[s.cell] === 'number') {
      wr = s.table[s.cell];
    } else {
      s.cell = 'BASE';
      wr = base;
    }
    score += s.weight * wr;
    cells[s.name] = s.cell;
    wrs[s.name] = wr;
  }

  // Linear map of the measured cell-extreme range onto the 72-92 confidence
  // window (same report window as calib-v1).
  const m = cfg.map;
  const span = (m.maxScore - m.minScore) || 1;
  const confidence = clamp(
    Math.round(m.minConf + ((score - m.minScore) / span) * (m.maxConf - m.minConf)),
    m.minConf, m.maxConf,
  );

  return {
    version: cfg.version,
    mode: cfg.mode,
    score: round4(score),
    confidence,
    grade: scoreToEcGrade(score),
    cells,
    wrs,
  };
}

/**
 * Provisional grade bands on the EC score (CONFIG.EMPIRICAL_CONFIDENCE.
 * gradeBands). MARKED PROVISIONAL: re-derive from shadow-data quantiles with
 * the calib-v1 method before relying on the ladder ordering.
 */
export function scoreToEcGrade(score) {
  const b = CONFIG.EMPIRICAL_CONFIDENCE.gradeBands;
  const defs = {
    'A+': { grade: 'A+', label: 'EXCELLENT',
      description: 'EC-V2 top empirical cell (provisional bands).' },
    'A':  { grade: 'A', label: 'STRONG',
      description: 'EC-V2 high empirical cell (provisional bands).' },
    'B':  { grade: 'B', label: 'GOOD',
      description: 'EC-V2 above-pool empirical cell (provisional bands).' },
    'C':  { grade: 'C', label: 'MODERATE',
      description: 'EC-V2 pool-or-below empirical cell (provisional bands).' },
  };
  const g = score >= b.Aplus ? 'A+' : score >= b.A ? 'A' : score >= b.B ? 'B' : 'C';
  return { ...defs[g] };
}

/**
 * Attach the EC-V2 audit to a signal object (engine.js, fail-soft caller).
 *
 *   shadow mode   → signal.empiricalConfidence = ec; nothing else changes.
 *   decision mode → the caller ALSO replaces report confidence/grade; this
 *                   helper does that replacement so the engine block stays
 *                   thin (single write path, easy to audit).
 *
 * Returns the EC audit object.
 */
export function attachEmpiricalConfidence(signal, ctx) {
  const cfg = CONFIG.EMPIRICAL_CONFIDENCE;
  const ec = computeEmpiricalConfidence(ctx);
  ec.mode = cfg.mode;
  signal.empiricalConfidence = ec;
  if (cfg.mode === 'decision') {
    signal.confidence = ec.confidence + '%';
    signal.grade = ec.grade;
  }
  return ec;
}

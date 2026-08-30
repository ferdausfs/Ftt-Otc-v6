/**
 * EC-V2 — Empirical Confidence v2: mandatory test suite.
 *   node scripts/ec_v2_tests.mjs
 *
 * Covers the FIX-1 change of the Signal Logic & Parameter Distortion Audit
 * (2026-08-30): evidence-only confidence shadow. Key guarantees:
 *   1. Score cells + math are pure, deterministic and config-driven.
 *   2. SHADOW mode is strictly additive — engine decision output
 *      (direction/confidence/grade/filters/calibration) is byte-identical
 *      with EC enabled vs disabled.
 *   3. DECISION mode replaces report confidence/grade from EC-V2.
 *   4. History record persists the bounded EC fields.
 *   5. No consensus/alignment/confluence input exists anywhere in the score.
 *
 * No network/AI/KV (env={} → deterministic engine; makeKV for history).
 */

import assert from 'node:assert';
import { CONFIG, ASSET_TYPE } from '../src/config.js';
import { computeEmpiricalConfidence, attachEmpiricalConfidence, scoreToEcGrade } from '../src/analysis/empiricalConfidence.js';
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';
import { saveSignalToHistory } from '../src/history/stats.js';
import { makeCandleData } from './r71_fixtures.mjs';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

const ENV = {}; // deterministic: no AI keys, no SIGNAL_CACHE

// ── in-memory KV double (same shape as r71_tests) ───────────────────────
function makeKV() {
  const m = new Map();
  return {
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, { value: String(v) }); },
    async delete(k) { m.delete(k); },
  };
}

// ── [#1] cell classification ────────────────────────────────────────────
console.log('\n── [#1] Cell classification ──────────────────────────────');
{
  const ec = computeEmpiricalConfidence({
    direction: 'BUY', hourMult: 1.10, rsi: 50, structureOverall: 'AGAINST', fillStatus: 'PENDING_ENTRY',
  });
  eq('[#1] BUY good-hour mid-RSI AGAINST pending cells',
    ec.cells, { hour: 'GOOD', rsiDirection: 'MID', structure: 'AGAINST', fillState: 'PENDING_ENTRY' });

  const ec2 = computeEmpiricalConfidence({
    direction: 'SELL', hourMult: 0.85, rsi: 40, structureOverall: 'MIXED', fillStatus: 'INSTANT',
  });
  eq('[#1] SELL bad-hour chase-RSI MIXED instant cells',
    ec2.cells, { hour: 'BAD', rsiDirection: 'CHASE', structure: 'BASE', fillState: 'INSTANT' });

  const ec3 = computeEmpiricalConfidence({ direction: 'BUY' });
  eq('[#1] all-missing ctx → all BASE cells',
    ec3.cells, { hour: 'BASE', rsiDirection: 'BASE', structure: 'BASE', fillState: 'BASE' });
  eq('[#1] all-BASE score == baseWr', ec3.score, CONFIG.EMPIRICAL_CONFIDENCE.baseWr);

  const ec4 = computeEmpiricalConfidence({ direction: 'BUY', rsi: 37 });       // unmeasured BUY zone
  eq('[#1] BUY rsi 35-45 unmeasured → BASE', ec4.cells.rsiDirection, 'BASE');
  const ec5 = computeEmpiricalConfidence({ direction: 'SELL', rsi: 60 });      // unmeasured SELL zone
  eq('[#1] SELL rsi 55-65 unmeasured → BASE', ec5.cells.rsiDirection, 'BASE');
}

// ── [#2] weights, range and determinism ─────────────────────────────────
console.log('\n── [#2] Score math ───────────────────────────────────────');
{
  const cfg = CONFIG.EMPIRICAL_CONFIDENCE;
  const wsum = cfg.weights.hour + cfg.weights.rsiDirection + cfg.weights.structure + cfg.weights.fillState;
  eq('[#2] weights sum to 1.0', wsum, 1.0);

  const best = computeEmpiricalConfidence({
    direction: 'BUY', hourMult: 1.10, rsi: 50, structureOverall: 'AGAINST', fillStatus: 'PENDING_ENTRY',
  });
  const worst = computeEmpiricalConfidence({
    direction: 'SELL', hourMult: 0.85, rsi: 40, structureOverall: 'NEUTRAL', fillStatus: 'INSTANT',
  });
  ok('[#2] score within measured map range', best.score <= cfg.map.maxScore && worst.score >= cfg.map.minScore,
    'best=' + best.score + ' worst=' + worst.score);
  ok('[#2] confidence within 72-92 window', best.confidence <= cfg.map.maxConf && worst.confidence >= cfg.map.minConf,
    'best=' + best.confidence + ' worst=' + worst.confidence);
  ok('[#2] monotone: best > worst', best.score > worst.score && best.confidence > worst.confidence);

  // hand-check the weighted sum
  const expect = 0.30 * 0.493 + 0.25 * 0.604 + 0.25 * 0.480 + 0.20 * 0.560;
  ok('[#2] best score = weighted cell sum (hand-checked)',
    Math.abs(best.score - expect) < 1e-9, 'got ' + best.score + ' want ' + expect);

  const a = computeEmpiricalConfidence({ direction: 'BUY', hourMult: 1.0, rsi: 52, structureOverall: 'ALIGNED' });
  const b = computeEmpiricalConfidence({ direction: 'BUY', hourMult: 1.0, rsi: 52, structureOverall: 'ALIGNED' });
  eq('[#2] deterministic (same ctx → identical output)', a, b);

  // hour monotonicity through the full cell set (the 11.3pp validated edge)
  const good = computeEmpiricalConfidence({ direction: 'BUY', hourMult: 1.10 });
  const neu  = computeEmpiricalConfidence({ direction: 'BUY', hourMult: 1.00 });
  const bad  = computeEmpiricalConfidence({ direction: 'BUY', hourMult: 0.85 });
  ok('[#2] hour GOOD > NEUTRAL > BAD (validated 11.3pp edge)',
    good.confidence > neu.confidence && neu.confidence > bad.confidence,
    good.confidence + '/' + neu.confidence + '/' + bad.confidence);

  // structure inversion accepted as measured (AGAINST > ALIGNED > NEUTRAL)
  const ag = computeEmpiricalConfidence({ direction: 'BUY', structureOverall: 'AGAINST' });
  const al = computeEmpiricalConfidence({ direction: 'BUY', structureOverall: 'ALIGNED' });
  const nt = computeEmpiricalConfidence({ direction: 'BUY', structureOverall: 'NEUTRAL' });
  ok('[#2] structure AGAINST > ALIGNED > NEUTRAL (measured inversion)',
    ag.confidence > al.confidence && al.confidence > nt.confidence,
    ag.confidence + '/' + al.confidence + '/' + nt.confidence);
}

// ── [#3] NO consensus/alignment/confluence input (D1-D3 removal) ────────
console.log('\n── [#3] Consensus independence ───────────────────────────');
{
  // the public API surface takes ONLY validated-feature ctx keys
  const fn = computeEmpiricalConfidence.toString();
  ok('[#3] module never reads alignment', !/alignment/i.test(fn));
  ok('[#3] module never reads confluence', !/confluence/i.test(fn));
  ok('[#3] module never reads vote/weighted consensus',
    !/weightedBuy|weightedSell|voteShare|consensus/i.test(fn));

  // engine-level: the shadow field carries only EC data (cells/score), so it
  // is consensus-free by construction. Fixture = the ONLY valid-crypto-signal
  // fixture in this suite (grid-searched; RANGING, survives the D2 blocks).
  const cd = makeCandleData({ basePrice: 78000, vol: 75, trend: 0, seed: 19 });
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, ASSET_TYPE.CRYPTO, ENV);
  if (sig.empiricalConfidence) {
    const e = sig.empiricalConfidence;
    ok('[#3] EC payload carries no consensus fields',
      !('alignment' in e) && !('confluence' in e) && !('votes' in e));
  } else {
    console.log('   (fixture produced no valid crypto signal — [#3] payload check skipped)');
  }
}

// ── [#4] grade bands (provisional) ──────────────────────────────────────
console.log('\n── [#4] Provisional grade bands ──────────────────────────');
{
  const b = CONFIG.EMPIRICAL_CONFIDENCE.gradeBands;
  eq('[#4] A+ band', scoreToEcGrade(b.Aplus).grade, 'A+');
  eq('[#4] A band', scoreToEcGrade(b.A).grade, 'A');
  eq('[#4] B band', scoreToEcGrade(b.B).grade, 'B');
  eq('[#4] C below-B', scoreToEcGrade(b.B - 0.001).grade, 'C');
  ok('[#4] bands are ordered', b.Aplus > b.A && b.A > b.B);
}

// ── [#5] SHADOW mode: engine output strictly additive ───────────────────
console.log('\n── [#5] Shadow mode is decision-neutral ──────────────────');
{
  const ecEnabled = CONFIG.EMPIRICAL_CONFIDENCE.enabled;
  const ecMode = CONFIG.EMPIRICAL_CONFIDENCE.mode;
  const EC_FIXTURE = { basePrice: 78000, vol: 75, trend: 0, seed: 19 }; // grid-searched valid SELL (RANGING)
  try {
    const cd = makeCandleData(EC_FIXTURE);
    CONFIG.EMPIRICAL_CONFIDENCE.enabled = false;
    const off = await buildMultiTimeframeSignal('BTC/USD', cd, ASSET_TYPE.CRYPTO, ENV);
    CONFIG.EMPIRICAL_CONFIDENCE.enabled = true;
    CONFIG.EMPIRICAL_CONFIDENCE.mode = 'shadow';
    const on = await buildMultiTimeframeSignal('BTC/USD', cd, ASSET_TYPE.CRYPTO, ENV);

    if (off.finalSignal === 'NO_TRADE') {
      console.log('   (fixture blocked — shadow additivity check skipped)');
    } else {
      eq('[#5] direction unchanged', on.finalSignal, off.finalSignal);
      eq('[#5] confidence unchanged', on.confidence, off.confidence);
      eq('[#5] grade unchanged', on.grade.grade, off.grade.grade);
      eq('[#5] calibration trace unchanged', on.calibration, off.calibration);
      eq('[#5] filtersApplied unchanged', on.filtersApplied, off.filtersApplied);
      ok('[#5] shadow field present on valid crypto signal', !!on.empiricalConfidence);
      ok('[#5] disabled run has no shadow field', !off.empiricalConfidence);
      eq('[#5] shadow mode tag', on.empiricalConfidence.mode, 'shadow');
    }
  } finally {
    CONFIG.EMPIRICAL_CONFIDENCE.enabled = ecEnabled;
    CONFIG.EMPIRICAL_CONFIDENCE.mode = ecMode;
  }
}

// ── [#6] attach skips: NO_TRADE + non-crypto ────────────────────────────
console.log('\n── [#6] Attach gating ────────────────────────────────────');
{
  // non-crypto pool: the v1 measured cells are crypto-only
  const cdF = makeCandleData({ basePrice: 1.08, vol: 0.0006, trend: 0, seed: 77 });
  const sigF = await buildMultiTimeframeSignal('EUR/USD', cdF, ASSET_TYPE.FOREX, ENV);
  ok('[#6] FOREX signal carries no EC field', !sigF.empiricalConfidence);
}

// ── [#7] DECISION mode: report output from EC-V2 ────────────────────────
console.log('\n── [#7] Decision mode override ───────────────────────────');
{
  const ecEnabled = CONFIG.EMPIRICAL_CONFIDENCE.enabled;
  const ecMode = CONFIG.EMPIRICAL_CONFIDENCE.mode;
  const EC_FIXTURE = { basePrice: 78000, vol: 75, trend: 0, seed: 19 }; // grid-searched valid SELL (RANGING)
  try {
    const cd = makeCandleData(EC_FIXTURE);
    CONFIG.EMPIRICAL_CONFIDENCE.enabled = true;
    CONFIG.EMPIRICAL_CONFIDENCE.mode = 'decision';
    const sig = await buildMultiTimeframeSignal('BTC/USD', cd, ASSET_TYPE.CRYPTO, ENV);

    if (sig.finalSignal === 'NO_TRADE') {
      console.log('   (fixture blocked — decision-mode check skipped)');
    } else {
      const ec = sig.empiricalConfidence;
      ok('[#7] decision tag present', sig.empiricalConfidence.mode === 'decision');
      ok('[#7] report confidence from EC-V2', sig.confidence === ec.confidence + '%',
        'conf=' + sig.confidence + ' ec=' + ec.confidence);
      eq('[#7] report grade from EC-V2', sig.grade.grade, ec.grade.grade);
      ok('[#7] decision note in filtersApplied',
        sig.filtersApplied.some((f) => f.startsWith('EC_V2_DECISION_OUTPUT')));
      // window still respected
      ok('[#7] EC confidence within 72-92', ec.confidence >= 72 && ec.confidence <= 92);
    }
  } finally {
    CONFIG.EMPIRICAL_CONFIDENCE.enabled = ecEnabled;
    CONFIG.EMPIRICAL_CONFIDENCE.mode = ecMode;
  }
}

// ── [#8] history record persistence ─────────────────────────────────────
console.log('\n── [#8] History record fields ────────────────────────────');
{
  const cd = makeCandleData({ basePrice: 78000, vol: 75, trend: 0, seed: 19 }); // grid-searched valid SELL
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, ASSET_TYPE.CRYPTO, ENV);
  if (sig.finalSignal !== 'NO_TRADE') {
    const env = { SIGNAL_CACHE: makeKV() };
    await saveSignalToHistory(sig, 'BTC/USD', false, env, 'ec-test-1', 'test');
    // history rows live in a per-pair LIST at sig:<PAIR> (KV_SIGNAL_PREFIX)
    const list = JSON.parse((await env.SIGNAL_CACHE.get('sig:BTC_USD')) || '[]');
    const row = Array.isArray(list) ? list[list.length - 1] : null;
    ok('[#8] row saved', !!row);
    if (row) {
      ok('[#8] empiricalConfidence persisted', !!row.empiricalConfidence);
      eq('[#8] persisted version', row.empiricalConfidence.version, CONFIG.EMPIRICAL_CONFIDENCE.version);
      ok('[#8] persisted cells object', typeof row.empiricalConfidence.cells === 'object');
      ok('[#8] persisted confidence int 72-92',
        Number.isInteger(row.empiricalConfidence.confidence)
        && row.empiricalConfidence.confidence >= 72 && row.empiricalConfidence.confidence <= 92);
      ok('[#8] persisted grade letter', ['A+', 'A', 'B', 'C'].includes(row.empiricalConfidence.grade));
    }
  } else {
    console.log('   (fixture blocked — history check skipped)');
  }
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) { console.log('FAILURES: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL EC-V2 TESTS PASSED');

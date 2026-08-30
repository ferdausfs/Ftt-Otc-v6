/**
 * FIX-2 — RSI_DIRECTION_GATE SELL-side asymmetry: mandatory test suite.
 *   node scripts/rsi_gate_tests.mjs
 *
 * Evidence (Workplace-drive-/reports/SIGNAL_LOGIC_DISTORTION_AUDIT_2026-08-30
 * + EDGE_DECAY_AUDIT_2026-08-30): SELL RSI<45 = 45.7% vs SELL 45-55 = 44.6%
 * (no discrimination); TRAIN 47.4% (above pool). The ×0.85 SELL penalty
 * filtered volume without WR benefit. BUY RSI>55 = 43.3% — the chase leg IS
 * validated and stays always-on.
 *
 * Unit tests run applyEdgeFeatures directly with a deterministic ctx
 * (fixed `now` → hour 6 UTC → hourMult 1.00; no KV → recent-form 1.0).
 */

import assert from 'node:assert';
import { CONFIG } from '../src/config.js';
import { applyEdgeFeatures } from '../src/analysis/edgeFeatures.js';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};

// Fixed UTC hour 6 → static HOUR_MULTIPLIERS[6] = 1.00 (time-independent test)
const NOW = new Date('2026-08-30T06:00:00Z');

function ctx(direction, rsiVal) {
  return {
    finalDirection: direction,
    confidence: 80,
    pair: 'BTC/USD',
    assetType: 'CRYPTO',
    now: NOW,
    candleData: {},
    tfResults: {
      '5min': {
        direction, score: direction === 'BUY' ? { up: 5, down: 2 } : { up: 2, down: 5 },
        confluence: 6, alignedWithHTF: false,
      },
    },
    indicators: { '5min': { rsi: [rsiVal] } },
    env: {},
    calib: null,
  };
}

const gateCfg = () => CONFIG.EDGE_FEATURES.RSI_DIRECTION_GATE;

// ── [#1] BUY chase leg unchanged (validated) ────────────────────────────
console.log('\n── [#1] BUY chase leg stays always-on ────────────────────');
{
  const r = await applyEdgeFeatures(ctx('BUY', 60));
  ok('[#1] BUY rsi 60 → gate fired', !!r.audit.rsiGate && r.audit.rsiGate.direction === 'BUY');
  ok('[#1] penalty multiplier applied (×0.85)', Math.abs(r.audit.totalMult - 0.85) < 1e-9,
    'totalMult=' + r.audit.totalMult);
  ok('[#1] confidence 80 → 68', r.confidence === 68, 'conf=' + r.confidence);
  ok('[#1] filter note present', r.filtersApplied.some((f) => f.startsWith('RSI_DIRECTION_GATE_PENALTY')));

  const r55 = await applyEdgeFeatures(ctx('BUY', 55));
  ok('[#1] BUY rsi 55 (boundary) → no gate', !r55.audit.rsiGate && r55.audit.totalMult === 1.0);
  const r56 = await applyEdgeFeatures(ctx('BUY', 56));
  ok('[#1] BUY rsi 56 → gate fires', !!r56.audit.rsiGate);
  const rMid = await applyEdgeFeatures(ctx('BUY', 50));
  ok('[#1] BUY rsi 50 (mid) → no gate', !rMid.audit.rsiGate);
}

// ── [#2] SELL leg disabled by default (sellPenaltyEnabled: false) ───────
console.log('\n── [#2] SELL leg disabled (FIX-2) ────────────────────────');
{
  ok('[#2] config default sellPenaltyEnabled === false', gateCfg().sellPenaltyEnabled === false);

  const r = await applyEdgeFeatures(ctx('SELL', 40));
  ok('[#2] SELL rsi 40 → NO gate', !r.audit.rsiGate, JSON.stringify(r.audit.rsiGate));
  ok('[#2] no RSI multiplier (totalMult 1.0)', r.audit.totalMult === 1.0);
  ok('[#2] confidence untouched (80)', r.confidence === 80, 'conf=' + r.confidence);
  ok('[#2] no gate filter note', !r.filtersApplied.some((f) => f.startsWith('RSI_DIRECTION_GATE')));
  ok('[#2] direction survives', r.finalDirection === 'SELL');
}

// ── [#3] legacy symmetric behavior preserved behind the flag ────────────
console.log('\n── [#3] Rollback flag restores SELL leg ──────────────────');
{
  const prev = gateCfg().sellPenaltyEnabled;
  try {
    gateCfg().sellPenaltyEnabled = true;
    const r = await applyEdgeFeatures(ctx('SELL', 40));
    ok('[#3] flag=true → SELL gate fires again', !!r.audit.rsiGate && r.audit.rsiGate.direction === 'SELL');
    ok('[#3] penalty ×0.85 applied', Math.abs(r.audit.totalMult - 0.85) < 1e-9);
    ok('[#3] confidence 80 → 68', r.confidence === 68);
  } finally {
    gateCfg().sellPenaltyEnabled = prev;
  }
}

// ── [#4] SELL outside gate range unaffected either way ──────────────────
console.log('\n── [#4] SELL mid/extreme ranges ──────────────────────────');
{
  const rMid = await applyEdgeFeatures(ctx('SELL', 50));
  ok('[#4] SELL rsi 50 → no gate', !rMid.audit.rsiGate);
  const rExt = await applyEdgeFeatures(ctx('SELL', 70));
  ok('[#4] SELL rsi 70 (mean-rev extreme) → no gate', !rExt.audit.rsiGate);
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail) { console.log('FAILURES: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL RSI-GATE TESTS PASSED');

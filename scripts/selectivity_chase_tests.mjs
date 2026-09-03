/**
 * SELECTIVITY excludeChase + excludeTrending tests (v6.14.0, 2026-09-03).
 *
 * Covers the two re-enabled / new push-gate rules added after the 4-day
 * shadow window verdict:
 *   excludeTrending — TRENDING regime pushes suppressed again (35.4% WR, n=325)
 *   excludeChase    — BUY rsi>55 / SELL rsi<45 pushes suppressed (37.2% WR,
 *                     73% of volume); non-CHASE 52.3% (n=44)
 *
 * Run: node scripts/selectivity_chase_tests.mjs
 */
import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../src/config.js';
import { evaluateSelectivityGate } from '../src/analysis/selectivity.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function mkSignal(over = {}) {
  return {
    direction: 'BUY',
    marketRegime: 'RANGING',
    edgeFeatures: { rsi: 45 },
    ...over,
  };
}

const CRYPTO = ASSET_TYPE.CRYPTO;

// ── excludeChase: BUY side ──
{
  const s = mkSignal({ edgeFeatures: { rsi: 62 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('BUY rsi 62 -> blocked as chase', g.blocked && g.rules.includes('excludeChase'));
}
{
  const s = mkSignal({ edgeFeatures: { rsi: 55 } });   // exactly 55 = NOT >55
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('BUY rsi 55 (boundary) -> pass', !g.blocked);
}
{
  const s = mkSignal({ edgeFeatures: { rsi: 45 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('BUY rsi 45 (MID) -> pass', !g.blocked);
}

// ── excludeChase: SELL side ──
{
  const s = mkSignal({ direction: 'SELL', edgeFeatures: { rsi: 40 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('SELL rsi 40 -> blocked as chase', g.blocked && g.rules.includes('excludeChase'));
}
{
  const s = mkSignal({ direction: 'SELL', edgeFeatures: { rsi: 45 } }); // exactly 45 = NOT <45
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('SELL rsi 45 (boundary) -> pass', !g.blocked);
}
{
  const s = mkSignal({ direction: 'SELL', edgeFeatures: { rsi: 50 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('SELL rsi 50 (MID) -> pass', !g.blocked);
}

// ── fail-open paths ──
{
  const s = mkSignal({ edgeFeatures: {} });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('missing rsi -> fail-open pass', !g.blocked);
}
{
  const s = mkSignal({ edgeFeatures: null });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('null edgeFeatures -> fail-open pass', !g.blocked);
}
{
  const s = mkSignal({ edgeFeatures: { rsi: '62' } });  // numeric string parses
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('string rsi "62" -> parsed and blocked', g.blocked);
}
{
  const s = mkSignal({ edgeFeatures: { rsi: 'garbage' } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('non-numeric rsi -> fail-open pass', !g.blocked);
}

// ── kill switch ──
{
  const saved = CONFIG.SELECTIVITY_GATE.excludeChase;
  CONFIG.SELECTIVITY_GATE.excludeChase = false;
  const s = mkSignal({ edgeFeatures: { rsi: 70 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  CONFIG.SELECTIVITY_GATE.excludeChase = saved;
  check('excludeChase:false -> one-line rollback works', !g.blocked);
}

// ── excludeTrending (re-enabled) ──
{
  const s = mkSignal({ marketRegime: 'TRENDING', edgeFeatures: { rsi: 40 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  check('TRENDING -> blocked by excludeTrending', g.blocked && g.rules.includes('excludeTrending'));
}
{
  const s = mkSignal({ marketRegime: 'TRENDING', edgeFeatures: { rsi: 70 } });
  const g = evaluateSelectivityGate(s, 'BTC/USD', CRYPTO);
  // trending rule must fire BEFORE chase (regime is the bigger drag)
  check('TRENDING+chase -> trending reason wins', g.blocked && g.reason === 'trending-suppressed');
}

// ── order + exemptions intact ──
{
  const s = mkSignal({ edgeFeatures: { rsi: 70 } });
  const g = evaluateSelectivityGate(s, 'EUR/USD', ASSET_TYPE_OTC);
  check('OTC still exempt from everything', !g.blocked && g.reason === 'otc-exempt');
}
{
  const s = mkSignal({ edgeFeatures: { rsi: 70 } });
  const g = evaluateSelectivityGate(s, 'EUR/USD', ASSET_TYPE.FOREX);
  check('FOREX still blocked by cryptoOnly first', g.blocked && g.rules.includes('cryptoOnly'));
}

console.log('-----------------------------------------------------------');
console.log(`PASS: ${pass}   FAIL: ${fail}`);
console.log(fail === 0 ? 'ALL SELECTIVITY CHASE TESTS PASSED' : 'SOME TESTS FAILED');
process.exit(fail === 0 ? 0 : 1);

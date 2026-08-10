/**
 * FX Mode — mandatory test suite.
 *   node scripts/fx_mode_tests.mjs
 *
 * [#1] computeFxLevels: BUY/SELL, SL/TP correctness, ATR scaling
 * [#2] computeFxLevels: invalid inputs -> null
 * [#3] engine fxMode: levels attached, direction/confidence untouched
 * [#4] FTT mode (default): no mode tag, no levels, byte-identical-ish output
 * [#5] ATR-based: SL distance == ATR, TP == ATR*RR
 */

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};

const { computeFxLevels } = await import('../src/analysis/filters.js');
const { buildMultiTimeframeSignal } = await import('../src/signal/engine.js');
const { makeCandleData } = await import('./r71_fixtures.mjs');
const ENV = {};
// F3-16 (CLOCK-001/BUG-022): pin the session so the EUR/USD fixture keeps
// producing a tradable signal outside the 12-16 UTC HIGHEST overlap (the
// D2_HIGHEST_SESSION_BLOCK otherwise suppresses it).
const FIXED_SESSION = { sessions: ['NEW_YORK'], overlap: 'NONE', quality: 'HIGH', hour: 16 };

console.log('\n── [#1] computeFxLevels correctness ──');
{
  // BUY: entry 1.0800, atr 0.0020 -> SL 1.0780 (below), TP 1.0850 (above, rr 2.5)
  const buy = computeFxLevels({ entry: 1.08, atr: 0.002, direction: 'BUY', rr: 2.5 });
  ok('[#1a] BUY SL below entry', buy.sl < buy.entry, JSON.stringify(buy));
  ok('[#1b] BUY TP above entry', buy.tp > buy.entry, JSON.stringify(buy));
  ok('[#1c] SL distance == ATR', Math.abs((buy.entry - buy.sl) - 0.002) < 1e-9);
  ok('[#1d] TP distance == ATR*RR', Math.abs((buy.tp - buy.entry) - 0.005) < 1e-9);

  // SELL: entry 1.0800 -> SL above, TP below
  const sell = computeFxLevels({ entry: 1.08, atr: 0.002, direction: 'SELL', rr: 2.5 });
  ok('[#1e] SELL SL above entry', sell.sl > sell.entry, JSON.stringify(sell));
  ok('[#1f] SELL TP below entry', sell.tp < sell.entry, JSON.stringify(sell));

  // R:R metadata
  ok('[#1g] rr metadata', buy.rr === 2.5 && buy.slAtrMult === 1.0);

  // custom rr
  const rr3 = computeFxLevels({ entry: 100, atr: 1, direction: 'BUY', rr: 3 });
  ok('[#1h] custom RR', Math.abs((rr3.tp - 100) - 3) < 1e-9, JSON.stringify(rr3));
}

console.log('\n── [#2] invalid inputs -> null ──');
{
  ok('[#2a] null entry', computeFxLevels({ entry: null, atr: 0.002, direction: 'BUY' }) === null);
  ok('[#2b] null atr', computeFxLevels({ entry: 1.08, atr: null, direction: 'BUY' }) === null);
  ok('[#2c] atr 0', computeFxLevels({ entry: 1.08, atr: 0, direction: 'BUY' }) === null);
  ok('[#2d] bad direction', computeFxLevels({ entry: 1.08, atr: 0.002, direction: 'HOLD' }) === null);
}

console.log('\n── [#3] engine fxMode ──');
{
  const sig = await buildMultiTimeframeSignal('EUR/USD', makeCandleData({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 }), 'FOREX', ENV, { fxMode: true, session: FIXED_SESSION, newsBlock: null, edgeFeaturesEnabled: false });
  if (sig.finalSignal === 'SELL' || sig.finalSignal === 'BUY') {
    ok('[#3a] mode=fx set', sig.mode === 'fx');
    ok('[#3b] fxLevels present', !!sig.fxLevels);
    if (sig.fxLevels) {
      ok('[#3c] rr 2.5', sig.fxLevels.rr === 2.5);
      if (sig.finalSignal === 'SELL') {
        ok('[#3d] SELL sl>entry>tp', sig.fxLevels.sl > sig.fxLevels.entry && sig.fxLevels.tp < sig.fxLevels.entry);
      } else {
        ok('[#3d] BUY sl<entry<tp', sig.fxLevels.sl < sig.fxLevels.entry && sig.fxLevels.tp > sig.fxLevels.entry);
      }
    }
  } else {
    ok('[#3a] fixture produced tradable signal (needed for test)', false, 'final=' + sig.finalSignal);
  }
}

console.log('\n── [#4] FTT mode default unchanged ──');
{
  const sig = await buildMultiTimeframeSignal('EUR/USD', makeCandleData({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 }), 'FOREX', ENV, { session: FIXED_SESSION, newsBlock: null, edgeFeaturesEnabled: false });
  ok('[#4a] no mode tag', sig.mode === undefined);
  ok('[#4b] no fxLevels', sig.fxLevels === undefined);
  ok('[#4c] finalSignal + confidence intact', typeof sig.finalSignal === 'string' && (typeof sig.confidence === 'number' || typeof sig.confidence === 'string'));
}

console.log('\n── [#5] ATR scaling sanity (higher ATR -> wider SL) ──');
{
  const a1 = computeFxLevels({ entry: 1.08, atr: 0.001, direction: 'BUY' });
  const a2 = computeFxLevels({ entry: 1.08, atr: 0.004, direction: 'BUY' });
  const d1 = a1.entry - a1.sl, d2 = a2.entry - a2.sl;
  ok('[#5] SL wider with higher ATR (4x)', Math.abs(d2 / d1 - 4) < 0.01, `${d1} vs ${d2}`);
}

console.log('\n───────────────────────────────────────────────────────────');
console.log(`PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) { console.log('Failures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('ALL FX MODE TESTS PASSED');

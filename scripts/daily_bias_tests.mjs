/**
 * Daily-bias FX — strategy test suite.
 *
 * Covers (per the task spec):
 *   1. hand-computed classification fixtures (every reachable branch + boundaries);
 *   2. evaluation-order proofs — sweep-both beats the single-sweep cases
 *      exactly as mandated (order is part of the spec, not an implementation
 *      choice), consolidation and UNCLASSIFIED catch what remains;
 *   3. mutual exclusivity + exhaustiveness property sweep over tens of
 *      thousands of valid random OHLC tuples;
 *   4. NO-LOOKAHEAD proof by mutation: the decision for day D reads nothing
 *      but D-1 and D-2 — mutating D's own high/low (and any later candle in
 *      a series) can never change the decision; entry/exit/result resolution
 *      reads only D's open/close;
 *   5. result computation (direction x up/down/flat) and AVOID null-ness;
 *   6. PROVEN STRUCTURAL PROPERTIES of the spec itself (documented, not
 *      patched — the mandated order is the spec):
 *        - VERY_BEARISH requires c1 < l2, and l1 <= c1 < l2 forces l1 < l2,
 *          so sweep-both (checked first) always captures it first;
 *        - BULLISH requires c1 > h2 with h1 <= h2, but valid OHLC forces
 *          c1 <= h1 < ... => h1 > h2, so every bullish-shaped day is a
 *          double sweep -> sweep-both first;
 *        => for VALID OHLC the only reachable directional class is BEARISH
 *           (PUT). An exhaustive 102,541-combination grid (scripts/
 *           probe_spec_reachability.mjs, run once) confirms: BULLISH=0,
 *           VERY_BEARISH=0. The module still implements all branches; the
 *           BULLISH/VERY_BEARISH branches are exercised below through the
 *           only inputs that can reach them (invalid-OHLC shapes) purely to
 *           prove branch correctness, and the REPORT states the property.
 *
 * Run: node scripts/daily_bias_tests.mjs   (exit 0 = all green)
 */
import {
  classifyDailyBias, evaluateDailyBiasDay, isAvoidClassification, CLASSIFICATIONS,
} from '../src/strategy/dailyBiasFx.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL: ${name}`); }
}
function eqClass(actual, expected, name) {
  ok(actual.classification === expected,
    `${name}: classification=${actual.classification} expected=${expected}`);
}

// ── 1. hand-computed fixtures (all VALID OHLC unless explicitly noted) ──────
// D-2 baseline candle: h=110, l=100, c=105
const D2 = { h: 110, l: 100, c: 105 };

{
  const r = classifyDailyBias(D2, { h: 111, l: 101, c: 108 });
  eqClass(r, 'BEARISH', 'high swept + close back under D-2 high (close >= D-2 low)');
  ok(r.decision === 'PUT', 'BEARISH -> PUT');
}
{
  const r = classifyDailyBias(D2, { h: 109, l: 101, c: 104 });
  eqClass(r, 'CONSOLIDATION', 'D-1 fully inside D-2 range');
  ok(r.decision === 'NO_TRADE' && r.reason === 'CONSOLIDATION', 'CONSOLIDATION -> NO_TRADE/CONSOLIDATION');
}
{
  const r = classifyDailyBias(D2, { h: 111, l: 98, c: 104 });
  eqClass(r, 'SWEEP_BOTH', 'both extremes swept');
  ok(r.decision === 'NO_TRADE' && r.reason === 'SWEEP_BOTH', 'SWEEP_BOTH -> NO_TRADE/SWEEP_BOTH');
}
// UNCLASSIFIED case A: high sweep that closes ABOVE D-2 high (breakout continuation)
{
  const r = classifyDailyBias(D2, { h: 111, l: 100.5, c: 110.5 });
  eqClass(r, 'UNCLASSIFIED', 'high sweep + close above D-2 high is not in the spec vocabulary');
  ok(r.decision === 'NO_TRADE' && r.reason === 'UNCLASSIFIED', 'UNCLASSIFIED -> NO_TRADE/UNCLASSIFIED');
}
// UNCLASSIFIED case B: low sweep that fails to recover above D-2 high
{
  const r = classifyDailyBias(D2, { h: 109.5, l: 99, c: 106 });
  eqClass(r, 'UNCLASSIFIED', 'low sweep + close back inside is not in the spec vocabulary');
  ok(r.decision === 'NO_TRADE' && r.reason === 'UNCLASSIFIED', 'UNCLASSIFIED -> NO_TRADE/UNCLASSIFIED');
}
// BULLISH-shaped VALID candle (low swept, close above D-2 high — which forces
// a high sweep too): sweep-both runs first per the mandated order
{
  const r = classifyDailyBias(D2, { h: 112, l: 98, c: 111 });
  eqClass(r, 'SWEEP_BOTH', 'valid bullish-shaped day (l1<l2, c1>h2) is a double sweep -> SWEEP_BOTH');
}
// VERY_BEARISH-shaped VALID candle (high swept, close below D-2 low — which
// forces a low sweep too): sweep-both runs first
{
  const r = classifyDailyBias(D2, { h: 111, l: 98, c: 99 });
  eqClass(r, 'SWEEP_BOTH', 'valid very-bearish-shaped day (h1>h2, c1<l2) is a double sweep -> SWEEP_BOTH');
}
// boundary: equality does NOT count as a sweep
{
  const r = classifyDailyBias(D2, { h: 110, l: 100, c: 107 });
  eqClass(r, 'CONSOLIDATION', 'h1 == h2 and l1 == l2 -> CONSOLIDATION (sweeps are strict > / <)');
}
// boundary: close exactly AT D-2 high after a high sweep is not BEARISH
{
  const r = classifyDailyBias(D2, { h: 111, l: 101, c: 110 });
  eqClass(r, 'UNCLASSIFIED', 'close exactly at D-2 high: BEARISH needs c1 < h2');
}
// boundary: high swept, low exactly AT D-2 low, close inside
{
  const r = classifyDailyBias(D2, { h: 111, l: 100, c: 108 });
  eqClass(r, 'BEARISH', 'l1 == l2 is not a low sweep: single high sweep survives');
}
// boundary: low exactly swept, close exactly at D-2 high, high not swept -> UNCLASSIFIED
{
  const r = classifyDailyBias(D2, { h: 110, l: 99.9999, c: 110 });
  eqClass(r, 'UNCLASSIFIED', 'l1 < l2 but c1 == h2 (not >): neither BULLISH nor consolidation');
}

// ── 2. evaluation-order proofs ───────────────────────────────────────────────
{
  // bullish-shaped double sweep (h1>h2, l1<l2, c1>h2): sweep-both beats bullish
  const r = classifyDailyBias(D2, { h: 111, l: 98, c: 112 });
  eqClass(r, 'SWEEP_BOTH', 'order: sweep-both beats bullish when both match');
}
{
  // very-bearish-shaped double sweep (h1>h2, l1<l2, c1<l2): sweep-both beats very-bearish
  const r = classifyDailyBias(D2, { h: 111, l: 98, c: 99 });
  eqClass(r, 'SWEEP_BOTH', 'order: sweep-both beats very-bearish when both match');
}
{
  // consolidation must not swallow single sweeps (checked later in the chain)
  const r = classifyDailyBias(D2, { h: 111, l: 101, c: 108 });
  eqClass(r, 'BEARISH', 'order: single high sweep survives (consolidation checked later)');
}

// ── 3. mutual exclusivity + exhaustiveness property sweep ────────────────────
{
  let seed = 0x2f6e2b1;               // deterministic xorshift
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const seen = new Set();
  const N = 20000;
  for (let k = 0; k < N; k++) {
    // random but VALID OHLC pair around a random base price
    const base = 0.5 + rnd() * 200;
    const mk = (anchorClose) => {
      const o = anchorClose * (1 + (rnd() - 0.5) * 0.04);
      const c = anchorClose * (1 + (rnd() - 0.5) * 0.04);
      const h = Math.max(o, c) * (1 + rnd() * 0.02);
      const l = Math.min(o, c) * (1 - rnd() * 0.02);
      return { o, h, l, c };
    };
    const d2raw = mk(base);
    const d1 = mk(d2raw.c);
    const d2 = { h: d2raw.h, l: d2raw.l, c: d2raw.c };
    const r = classifyDailyBias(d2, d1);
    if (!CLASSIFICATIONS.includes(r.classification)) { ok(false, `property: unknown class ${r.classification}`); break; }
    seen.add(r.classification);
    // decision mapping is total and consistent
    const expect = { BULLISH: 'CALL', BEARISH: 'PUT', VERY_BEARISH: 'PUT' }[r.classification] ?? 'NO_TRADE';
    if (r.decision !== expect) { ok(false, `property: ${r.classification} -> ${r.decision} (expected ${expect})`); break; }
    // avoid classes carry a reason; directional classes do not
    if (isAvoidClassification(r.classification) !== (r.decision === 'NO_TRADE')) { ok(false, 'property: avoid-class/decision mismatch'); break; }
    if (r.decision === 'NO_TRADE' && !r.reason) { ok(false, 'property: NO_TRADE without reason'); break; }
    if (r.decision !== 'NO_TRADE' && r.reason) { ok(false, 'property: trade with blocking reason'); break; }
    // structural invariants (mutual exclusivity, restated from the class):
    if (r.classification === 'SWEEP_BOTH' && !(d1.h > d2.h && d1.l < d2.l)) { ok(false, 'property: SWEEP_BOTH invariant'); break; }
    if (r.classification === 'BEARISH' && !(d1.h > d2.h && d1.c < d2.h && d1.l >= d2.l)) { ok(false, 'property: BEARISH invariant'); break; }
    if (r.classification === 'BULLISH' && !(d1.l < d2.l && d1.c > d2.h && d1.h <= d2.h)) { ok(false, 'property: BULLISH invariant'); break; }
    if (r.classification === 'CONSOLIDATION' && !(d1.h <= d2.h && d1.l >= d2.l)) { ok(false, 'property: CONSOLIDATION invariant'); break; }
  }
  ok(true, `property sweep: ${N} valid random tuples, all classified consistently`);
  for (const c of CLASSIFICATIONS) {
    if (c !== 'VERY_BEARISH' && c !== 'BULLISH') ok(seen.has(c), `property sweep exercised ${c}`);
  }
  ok(!seen.has('BULLISH') && !seen.has('VERY_BEARISH'),
    'property sweep: BULLISH/VERY_BEARISH never appear for valid OHLC (see header note 6)');
}

// ── 4. NO-LOOKAHEAD proof by mutation ────────────────────────────────────────
{
  const d2 = { h: 110, l: 100, c: 105 };
  const d1 = { h: 111, l: 101, c: 108 };                    // BEARISH
  const d  = { o: 107.9, c: 107.0, h: 108.2, l: 106.8 };    // day D (PUT trade wins)
  const base = evaluateDailyBiasDay(d2, d1, d);
  ok(base.decision === 'PUT', 'no-lookahead setup: BEARISH -> PUT');
  ok(base.result === 'WIN', 'no-lookahead setup: PUT with close<open -> WIN');

  // mutating day D's own high/low can NEVER change the decision
  for (const mut of [{ h: 1000, l: 0.001 }, { h: 0.002, l: 0.001 }, { h: 107.95, l: 107.5 }]) {
    const r = evaluateDailyBiasDay(d2, d1, { ...d, ...mut });
    ok(r.decision === 'PUT' && r.classification === 'BEARISH',
      `no-lookahead: mutating D.h/l (${JSON.stringify(mut)}) leaves decision PUT`);
  }
  // mutating D's open/close changes at most the RESULT, never the decision
  {
    const r = evaluateDailyBiasDay(d2, d1, { ...d, o: 500, c: 0.01 });
    ok(r.decision === 'PUT' && r.classification === 'BEARISH', 'no-lookahead: mutating D.o/D.c leaves decision PUT');
    ok(r.result === 'WIN' && r.entry === 500 && r.exit === 0.01, 'mutated D.o/c flows into entry/exit/result only');
  }
  // mutating the INPUT candles does change the decision (sanity: it reads them)
  {
    const r = evaluateDailyBiasDay(d2, { h: 108, l: 101, c: 104 }, d);
    ok(r.classification === 'CONSOLIDATION' && r.decision === 'NO_TRADE',
      'sanity: mutating D-1 genuinely changes the classification');
  }
}

// ── 4b. series-level future isolation (harness-faithful mutation proof) ──────
{
  // mirror of the harness loop: row for index i is computed from (c[i-2], c[i-1], c[i]) ONLY
  const runRows = (candles) => candles.slice(2).map((d, k) => {
    const r = evaluateDailyBiasDay(candles[k], candles[k + 1], d);
    return { i: k + 2, classification: r.classification, decision: r.decision, entry: r.entry, exit: r.exit, result: r.result };
  });

  const series = [
    { o: 104.0, h: 110, l: 100, c: 105 },   // c0
    { o: 105.5, h: 111, l: 101, c: 108 },   // c1  -> day i=2 is BEARISH
    { o: 107.9, h: 108.2, l: 106.8, c: 107.0 },  // c2  (D: PUT wins)
    { o: 107.0, h: 109.0, l: 106.5, c: 108.4 },  // c3
    { o: 108.4, h: 112.0, l: 108.0, c: 111.2 },  // c4
    { o: 111.2, h: 113.0, l: 110.5, c: 112.8 },  // c5
    { o: 112.8, h: 114.0, l: 111.9, c: 113.5 },  // c6
    { o: 113.5, h: 115.0, l: 113.0, c: 114.9 },  // c7
  ];
  const rows = runRows(series);
  ok(rows[0].decision === 'PUT' && rows[0].result === 'WIN', 'series: i=2 row is PUT/WIN');

  // mutate EVERY candle strictly after day D -> day D's row must not move
  const futureMut = series.map((c, i) => (i > 2 ? { o: c.o * 10, h: c.h * 10, l: c.l * 10, c: c.c * 10 } : c));
  const rowsMut = runRows(futureMut);
  ok(JSON.stringify(rows[0]) === JSON.stringify(rowsMut[0]),
    'no-lookahead (series): mutating all candles AFTER day D leaves day D row byte-identical');

  // mutate day D's own high/low -> decision unchanged (result resolved from o/c only)
  {
    const mut = series.slice();
    mut[2] = { ...series[2], h: 9999, l: 0.001 };
    const r = runRows(mut)[0];
    ok(r.classification === 'BEARISH' && r.decision === 'PUT' && r.result === 'WIN',
      'no-lookahead (series): mutating D.h/D.l leaves classification+decision+result unchanged');
  }
  // mutate D-1 -> decision DOES change (sanity: inputs are genuinely read)
  {
    const mut = series.slice();
    mut[1] = { o: 105.5, h: 109, l: 101, c: 104 };
    ok(runRows(mut)[0].decision === 'NO_TRADE', 'sanity (series): mutating D-1 changes the decision');
  }
}

// ── 5. result computation matrix + AVOID null-ness ───────────────────────────
{
  // PUT rows through fully valid candles
  const putCases = [
    [{ o: 108.5, c: 107 }, 'WIN'],
    [{ o: 108.5, c: 110 }, 'LOSS'],
    [{ o: 108.5, c: 108.5 }, 'TIE'],
  ];
  for (const [d, res] of putCases) {
    const r = evaluateDailyBiasDay(D2, { h: 111, l: 101, c: 108 }, d);
    ok(r.decision === 'PUT' && r.result === res, `matrix: PUT close ${d.c} vs open ${d.o} -> ${res}`);
  }
  // CALL rows: the BULLISH branch is unreachable for valid OHLC (header note 6);
  // exercised here through the only inputs that classify BULLISH (invalid
  // c1>h1 shape) purely to prove the CALL branch + result math are correct.
  const callCases = [
    [{ o: 111, c: 113 }, 'WIN'],
    [{ o: 111, c: 110 }, 'LOSS'],
    [{ o: 111, c: 111 }, 'TIE'],
  ];
  for (const [d, res] of callCases) {
    const r = evaluateDailyBiasDay(D2, { h: 109, l: 98, c: 112 }, d); // BULLISH via invalid shape
    ok(r.classification === 'BULLISH' && r.decision === 'CALL' && r.result === res,
      `matrix: CALL close ${d.c} vs open ${d.o} -> ${res} (branch proof, unreachable on valid data)`);
  }
  const avoid = evaluateDailyBiasDay(D2, { h: 111, l: 98, c: 104 }, { o: 105, c: 106 });
  ok(avoid.decision === 'NO_TRADE' && avoid.entry === null && avoid.exit === null && avoid.result === null,
    'AVOID day: no entry, no exit, no result');
  ok(isAvoidClassification('SWEEP_BOTH') && isAvoidClassification('CONSOLIDATION') && isAvoidClassification('UNCLASSIFIED'),
    'isAvoidClassification covers exactly the three AVOID classes');
  ok(!isAvoidClassification('BULLISH') && !isAvoidClassification('BEARISH') && !isAvoidClassification('VERY_BEARISH'),
    'isAvoidClassification excludes directional classes');
}

console.log(`\ndaily_bias_tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

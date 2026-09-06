/**
 * Market Structure (BOS/CHoCH) — strategy test suite.
 *
 * Covers (per the task spec, the category's classic failure mode first):
 *   1. CONFIRMATION-LAG PROOF — a pivot at index i is NOT visible to the
 *      machine at bars i .. i+L-1 and IS visible starting at i+L, three ways:
 *        a. structural: on random walks, EVERY swing high i confirms at
 *           exactly i+L (chV[i+L] === high[i]) and never earlier (chV is NaN
 *           at i..i+L-1 for that pivot); conversely every confirmation maps
 *           back to a true swing high. Thousands of random pivots.
 *        b. value mutation: mutating the pivot bar's high (still a pivot,
 *           new value) changes NOTHING before i+L and changes the reference
 *           value exactly at i+L ("mutate the bar that would only matter if
 *           the lag were violated").
 *        c. behavioral discriminator: a close between the OLD swing high and
 *           a newer higher swing high breaks the OLD level before the new
 *           pivot confirms — if the new value leaked early, no event would
 *           ever fire. Fixture 2 (from scripts/ms_fixture_calc.py).
 *   2. standard NO-LOOKAHEAD mutation proof on composed decisions: mutating
 *      ALL bars after the decision bar (1m and 15m) cannot change the row.
 *   3. BOS vs CHoCH classification on a hand-built 78-bar fixture with a
 *      known event sequence (frozen from the independent Python machine in
 *      scripts/ms_fixture_calc.py): CHoCH out of UNKNOWN, BOS continuations,
 *      CHoCH flips both directions.
 *   4. C2 dispatch truth table, expiry-ladder boundaries, percentile rank,
 *      Wilder ATR(14) fixture (frozen Python numbers).
 *   5. property sweep: break-once-per-swing, trend-transition consistency,
 *      event/reference causality on random walks.
 *   6. structural note (documented, not patched): the BOTH event is
 *      unreachable under valid OHLC — a swing low strictly above an
 *      unbroken swing high can never form (forming it requires closing
 *      above the swing high first, which breaks it). The branch is still
 *      implemented and tested via direct state injection.
 *   7. real-data smoke on the fetched BTC window (small sample).
 *
 * Run: node scripts/market_structure_tests.mjs   (exit 0 = all green)
 */
import {
  PIVOT_L, ATR_PERIOD, ATR_WINDOW, EXPIRY_TIERS, MS_1M, MS_15M,
  isSwingHigh, isSwingLow, createStructureState, stepStructure, buildStructure,
  lastClosed15Index, makeBiasPointer, atrWilder, percentileRank, median,
  expiryForPercentile, decideTrigger, resolveResult, MarketStructureRunner,
  EVENT_NAME, TREND_NAME,
} from '../src/strategy/marketStructure.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; console.error(`  FAIL: ${name}`); }
}
function eq(a, b, name) {
  ok(a === b, `${name}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
}
function closeTo(a, b, name, eps = 1e-9) {
  ok(a !== undefined && a !== null && Math.abs(a - b) <= eps,
    `${name}: got ${a} expected ~${b}`);
}

// ── deterministic RNG (mulberry32) for reproducible random walks ────────────
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random valid-OHLC walk: o = prev close; h/l = max/min +- |noise|. */
function randomWalk(n, seed, start = 100) {
  const r = rng(seed);
  const bars = [];
  let prevC = start;
  for (let i = 0; i < n; i++) {
    const c = +(prevC + (r() - 0.5) * 2).toFixed(4);
    const o = prevC;
    const wickU = +(r() * 0.8).toFixed(4);
    const wickD = +(r() * 0.8).toFixed(4);
    const h = +(Math.max(o, c) + wickU).toFixed(4);
    const l = +(Math.min(o, c) - wickD).toFixed(4);
    bars.push({ t: Date.UTC(2023, 0, 1) + i * 60000, o, h, l, c });
    prevC = c;
  }
  return bars;
}

/** Build bars from closes + wick overrides (same rule as ms_fixture_calc.py). */
function buildBars(closes, dh = {}, dl = {}, t0 = Date.UTC(2023, 0, 1)) {
  const bars = [];
  let prev = closes[0];
  for (let k = 0; k < closes.length; k++) {
    const c = closes[k];
    const o = prev;
    const h = Math.max(o, c) + (dh[k] ?? 0.3);
    const l = Math.min(o, c) - (dl[k] ?? 0.2);
    if (!(h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l)) throw new Error(`bar ${k} invalid`);
    bars.push({ t: t0 + k * 60000, o, h, l, c });
    prev = c;
  }
  return bars;
}

// ════════════════════════════════════════════════════════════════════════════
// 1a. CONFIRMATION-LAG PROOF — structural sweep over random walks
// ════════════════════════════════════════════════════════════════════════════
{
  let pivotsChecked = 0, confsChecked = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const bars = randomWalk(600, seed);
    const s = buildStructure(bars);
    for (let i = PIVOT_L; i + PIVOT_L < bars.length; i++) {
      if (isSwingHigh(bars, i)) {
        pivotsChecked++;
        // NOT visible at i..i+L-1: no confirmation of THIS pivot before i+L.
        // (chV at t records the pivot confirmed at t; only pivot t-L can be
        // confirmed at t, so chV[i..i+L-1] may only contain OTHER pivots
        // j = t-L < i. Direct check: chT[t] !== bars[i].t for t in [i, i+L-1].)
        for (let t = i; t < i + PIVOT_L; t++) {
          ok(s.chT[t] !== bars[i].t, `lag: pivot-high ${i} must not confirm at ${t} < ${i + PIVOT_L}`);
        }
        // IS visible at exactly i+L
        closeTo(s.chV[i + PIVOT_L], bars[i].h, `lag: pivot-high ${i} confirms at ${i + PIVOT_L}`, 1e-9);
        eq(s.chT[i + PIVOT_L], bars[i].t, `lag: pivot-high ${i} confirmation timestamp at ${i + PIVOT_L}`);
        confsChecked++;
      }
      if (isSwingLow(bars, i)) {
        pivotsChecked++;
        for (let t = i; t < i + PIVOT_L; t++) {
          ok(s.clT[t] !== bars[i].t, `lag: pivot-low ${i} must not confirm at ${t}`);
        }
        closeTo(s.clV[i + PIVOT_L], bars[i].l, `lag: pivot-low ${i} confirms at ${i + PIVOT_L}`, 1e-9);
        eq(s.clT[i + PIVOT_L], bars[i].t, `lag: pivot-low ${i} confirmation timestamp at ${i + PIVOT_L}`);
        confsChecked++;
      }
    }
    // conversely: every recorded confirmation is a true swing point
    for (let t = 0; t < bars.length; t++) {
      if (!Number.isNaN(s.chV[t])) ok(isSwingHigh(bars, t - PIVOT_L), `conf at ${t} is a real swing high at ${t - PIVOT_L}`);
      if (!Number.isNaN(s.clV[t])) ok(isSwingLow(bars, t - PIVOT_L), `conf at ${t} is a real swing low at ${t - PIVOT_L}`);
    }
  }
  ok(pivotsChecked > 1000, `lag sweep exercised enough pivots (got ${pivotsChecked})`);
  console.log(`1a. structural lag sweep: ${pivotsChecked} pivots, ${confsChecked} confirmations checked`);
}
const L_PLACEHOLDER = PIVOT_L; // (kept above readable; const hoisting via var not needed)

// ════════════════════════════════════════════════════════════════════════════
// 1b. CONFIRMATION-LAG PROOF — value mutation on the hand-built fixture
// ════════════════════════════════════════════════════════════════════════════
const FIX1_CLOSES = [
  105, 104, 103, 102, 101, 100, 99.5, 99, 98.5, 98,
  99, 100, 100.5, 101,
  100.5, 100, 99.5, 99, 98.5,
  97,
  97.5, 98, 97.6, 97.2, 97, 96.5, 96, 95.5,
  96.2, 96.6, 96.8, 97, 96.8, 96.4, 96, 95.5,
  95,
  95.4, 95.8, 96.2, 96.6, 97, 97.4, 97.8, 98.2,
  97.9, 97.6, 97.8, 98.1, 98.3,
  98.7,
  99, 98.8, 98.5, 98.7, 99,
  100.0, 100.4, 100.2, 100.3, 100.4, 100.5,
  101.2,
  100.8, 100.5, 100.4, 100.6, 100.4, 100.5, 100.3,
  100.6, 100.2,
  99.5,
  99.5, 99.3, 99, 98.8, 98.6,
];
const FIX1_DH = { 6: 0.1, 14: 0.1, 37: 0.3, 44: 0.3, 45: 0.1, 49: 0.1, 56: 1.0, 62: 0.3, 64: 0.5, 70: 0.2 };
const FIX1_DL = { 9: 0.3, 27: 0.3, 37: 0.1, 44: 0.1, 54: 0.1, 62: 0.1, 64: 0.8, 73: 0.1 };
{
  const base = buildBars(FIX1_CLOSES, FIX1_DH, FIX1_DL);
  const mutant = base.map(b => ({ ...b }));
  mutant[13] = { ...mutant[13], h: 101.2 };   // pivot 13 stays the window max (h[14]=101.1), new value
  const sb = buildStructure(base);
  const sm = buildStructure(mutant);
  const sameNum = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;
  let firstDiff = -1;
  for (let t = 0; t < base.length; t++) {
    const same = sameNum(sb.shV[t], sm.shV[t]) && sameNum(sb.shT[t], sm.shT[t])
      && sb.eventAt[t] === sm.eventAt[t] && sb.trendAfter[t] === sm.trendAfter[t];
    if (!same && firstDiff === -1) firstDiff = t;
  }
  eq(firstDiff, 13 + PIVOT_L, 'value mutation of pivot bar 13 first changes the machine at exactly i+L=18');
  closeTo(sb.chV[18], 101.3, 'base registers 101.3 at 18', 1e-9);
  closeTo(sm.chV[18], 101.2, 'mutant registers 101.2 at 18', 1e-9);
  // and the pivot was invisible before: chV is NaN for THIS pivot at 13..17 in both
  for (let t = 13; t < 18; t++) {
    ok(Number.isNaN(sb.chV[t]) || sb.chT[t] !== base[13].t, `base: pivot 13 not confirmed at ${t}`);
    ok(Number.isNaN(sm.chV[t]) || sm.chT[t] !== base[13].t, `mutant: pivot 13 not confirmed at ${t}`);
  }
  console.log('1b. value-mutation lag proof: first machine difference at bar 18 (= 13 + L)');
}

// ════════════════════════════════════════════════════════════════════════════
// 1c. CONFIRMATION-LAG PROOF — behavioral discriminator (fixture 2)
// ════════════════════════════════════════════════════════════════════════════
{
  const bars = buildBars(
    [93.5, 93.8, 94.1, 94.4, 94.7, 94.9, 94.5, 94.2, 94.0, 93.8, 93.6, 93.4,
     94.0, 95.4, 95.2, 95.0, 94.8, 94.6, 94.4, 94.2, 94.0, 93.8, 93.6],
    { 6: 0.1, 12: 2.0 }, { 11: 0.3 },
  );
  const s = buildStructure(bars);
  const events = [];
  for (let t = 0; t < bars.length; t++) if (s.eventAt[t] !== 0) events.push([t, EVENT_NAME[s.eventAt[t]]]);
  eq(events.length, 1, 'lag discriminator: exactly one event');
  eq(events[0][0], 13, 'lag discriminator: the break of the OLD 95.2 fires at bar 13');
  eq(events[0][1], 'CHoCH_BULL', 'lag discriminator: UNKNOWN -> UP is a CHoCH');
  // the new 96.0 pivot is in play only from bar 17:
  ok(Number.isNaN(s.chV[16]) || s.chT[16] !== bars[12].t, 'new pivot 96.0 not confirmed before 17');
  closeTo(s.chV[17], 96.0, 'new pivot 96.0 confirmed at 17', 1e-9);
  // sh reference value through the break zone is the OLD level:
  for (let t = 10; t <= 16; t++) closeTo(s.shV[t], 95.2, `sh in play at ${t} is the old 95.2`, 1e-9);
  closeTo(s.shV[17], 96.0, 'sh reference switches to 96.0 only at 17', 1e-9);
  console.log('1c. behavioral lag discriminator: break of old level at 13, new value only at 17');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. BOS vs CHoCH classification — hand-built fixture (frozen from Python)
// ════════════════════════════════════════════════════════════════════════════
{
  const bars = buildBars(FIX1_CLOSES, FIX1_DH, FIX1_DL);
  const s = buildStructure(bars);
  const events = [];
  for (let t = 0; t < bars.length; t++) if (s.eventAt[t] !== 0) events.push([t, EVENT_NAME[s.eventAt[t]]]);
  const EXPECT = [
    [19, 'CHoCH_BEAR'], [25, 'BOS_BEAR'], [36, 'BOS_BEAR'], [42, 'CHoCH_BULL'],
    [50, 'BOS_BULL'], [62, 'BOS_BULL'], [72, 'CHoCH_BEAR'],
  ];
  eq(events.length, EXPECT.length, 'fixture-1 event count');
  for (let k = 0; k < Math.min(events.length, EXPECT.length); k++) {
    eq(events[k][0], EXPECT[k][0], `fixture-1 event ${k} bar`);
    eq(events[k][1], EXPECT[k][1], `fixture-1 event ${k} type`);
  }
  // trend path: UNKNOWN -> DOWN (19) -> UP (42) -> DOWN (72)
  eq(TREND_NAME[s.trendAfter[18]], 'UNKNOWN', 'trend UNKNOWN before first break');
  eq(TREND_NAME[s.trendAfter[19]], 'DOWN', 'trend DOWN after first CHoCH_BEAR');
  eq(TREND_NAME[s.trendAfter[41]], 'DOWN', 'trend DOWN before bullish flip');
  eq(TREND_NAME[s.trendAfter[42]], 'UP', 'trend UP after CHoCH_BULL');
  eq(TREND_NAME[s.trendAfter[71]], 'UP', 'trend UP before bearish flip');
  eq(TREND_NAME[s.trendAfter[72]], 'DOWN', 'trend DOWN after final CHoCH_BEAR');
  // key pivot registration facts (value + confirmation bar)
  closeTo(s.chV[18], 101.3, 'SH#1 (bar 13) value registered at 18', 1e-9);
  closeTo(s.clV[14], 97.7, 'SL#1 (bar 9) value registered at 14', 1e-9);
  closeTo(s.shV[49], 98.5, 'SH#2 (bar 44) in play from 49', 1e-9);
  closeTo(s.chV[61], 101.0, 'SH#3 (bar 56) registered at 61', 1e-9);
  closeTo(s.clV[69], 99.7, 'SL#3 (bar 64) registered at 69', 1e-9);
  // break semantics at the event bars (strict inequality + consumption)
  ok(bars[19].c < s.slV[18], 'CHoCH_BEAR bar close strictly below swing low');
  eq(bars[35].c < 95.2, false, 'bar 35 close stays above SL#2 (no early break)');
  console.log('3. BOS/CHoCH fixture: 7/7 events match the frozen Python expectation');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. NO-LOOKAHEAD MUTATION PROOF on composed decisions (Runner)
// ════════════════════════════════════════════════════════════════════════════
{
  const c1 = randomWalk(1500, 777);
  // 15m series: independent walk with matching timestamps (15x spacing)
  const c15raw = randomWalk(100, 778, 100);
  const c15 = c15raw.map((b, k) => ({ ...b, t: c1[0].t + k * MS_15M }));
  const row = (r, runner) => JSON.stringify({
    bias: r.bias, event: r.event, decision: r.decision, reason: r.reason,
    atr: r.atr, atrPct: r.atrPct, minutes: r.minutes,
    sh: r.sh, sl: r.sl, confHigh: r.confHigh, confLow: r.confLow, i15OpenT: r.i15OpenT,
  });

  const runner = new MarketStructureRunner({ c15, c1 });
  const samples = [];
  for (let i = 200; i < 1400; i += 97) samples.push(i);

  let mutatedChecks = 0;
  for (const i of samples) {
    const base = row(runner.bar(i));
    // mutate EVERY 1m bar after i (wild values) and every 15m bar whose close
    // time is after the trigger close (the "forming" HTF bars included)
    const m1 = c1.map((b, k) => (k > i
      ? { t: b.t, o: b.o + 5, h: b.h * 1.7 + 3, l: b.l / 1.7 - 3, c: b.c * 0.6 + 11 }
      : b));
    const triggerCloseT = c1[i].t + MS_1M;
    const m15 = c15.map((b, k) => (b.t + MS_15M > triggerCloseT
      ? { t: b.t, o: b.o - 7, h: b.h * 2.3 + 9, l: b.l / 2.1 - 9, c: b.c * 1.4 - 5 }
      : b));
    const mr = new MarketStructureRunner({ c15: m15, c1: m1 });
    eq(row(mr.bar(i)), base, `no-lookahead: row at ${i} unchanged after mutating all later bars (1m+15m)`);
    mutatedChecks++;
  }
  // sanity: mutating the DECISION bar or earlier MUST be able to change the row
  const i = samples[3];
  const base = row(runner.bar(i));
  const mSelf = c1.map((b, k) => (k === i ? { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c * 1.9 } : b));
  const sr = new MarketStructureRunner({ c15, c1: mSelf });
  const selfRow = row(sr.bar(i));
  ok(selfRow !== base || runner.bar(i).event === 'NONE',
    `control: mutating the decision bar can change the row (event at ${i})`);
  console.log(`2. no-lookahead mutation proof: ${mutatedChecks} sampled decision rows all immutable under future mutation`);
}

// ════════════════════════════════════════════════════════════════════════════
// 4. C2 dispatch truth table + expiry ladder + ATR fixture
// ════════════════════════════════════════════════════════════════════════════
{
  const cases = [
    ['NONE', 'UP', 100, 'NO_TRADE', 'NO_BREAK'],
    ['NONE', 'UNKNOWN', 100, 'NO_TRADE', 'NO_BREAK'],
    ['BOS_BULL', 'UP', 100, 'CALL', null],
    ['CHoCH_BULL', 'UP', 100, 'CALL', null],
    ['BOS_BEAR', 'DOWN', 100, 'PUT', null],
    ['CHoCH_BEAR', 'DOWN', 100, 'PUT', null],
    ['BOS_BULL', 'DOWN', 100, 'NO_TRADE', 'OPPOSITE_BREAK'],
    ['CHoCH_BULL', 'DOWN', 100, 'NO_TRADE', 'OPPOSITE_BREAK'],
    ['BOS_BEAR', 'UP', 100, 'NO_TRADE', 'OPPOSITE_BREAK'],
    ['CHoCH_BEAR', 'UP', 100, 'NO_TRADE', 'OPPOSITE_BREAK'],
    ['BOS_BULL', 'UNKNOWN', 100, 'NO_TRADE', 'BIAS_UNKNOWN'],
    ['CHoCH_BEAR', 'UNKNOWN', 100, 'NO_TRADE', 'BIAS_UNKNOWN'],
    ['BOTH', 'UP', 100, 'NO_TRADE', 'AMBIGUOUS'],
    ['BOTH', 'DOWN', 100, 'NO_TRADE', 'AMBIGUOUS'],
    ['BOTH', 'UNKNOWN', 100, 'NO_TRADE', 'AMBIGUOUS'],
    ['BOS_BULL', 'UP', 99, 'NO_TRADE', 'EXPIRY_INSUFFICIENT'],
    ['CHoCH_BEAR', 'DOWN', 0, 'NO_TRADE', 'EXPIRY_INSUFFICIENT'],
  ];
  for (const [ev, bias, win, dec, why] of cases) {
    const r = decideTrigger({ event: ev, bias, atrWindowLen: win });
    eq(r.decision, dec, `dispatch ${ev}/${bias}/win=${win}`);
    eq(r.reason, why, `dispatch reason ${ev}/${bias}`);
  }
  // expiry ladder boundaries (frozen tiers: >=75 -> 5m, >=25 -> 7m, else 10m)
  eq(expiryForPercentile(75), 5, 'tier boundary 75 -> 5m');
  eq(expiryForPercentile(75.0001), 5, 'tier 75.0001 -> 5m');
  eq(expiryForPercentile(74.999), 7, 'tier 74.999 -> 7m');
  eq(expiryForPercentile(25), 7, 'tier boundary 25 -> 7m');
  eq(expiryForPercentile(24.999), 10, 'tier 24.999 -> 10m');
  eq(expiryForPercentile(0), 10, 'tier 0 -> 10m');
  eq(expiryForPercentile(100), 5, 'tier 100 -> 5m');
  eq(EXPIRY_TIERS.map(t => t.minutes).join(','), '5,7,10', 'frozen ladder shape');
  // percentile rank (frozen Python outputs, window [1..10])
  const win = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  closeTo(percentileRank(win, 0.5), 0, 'pct(0.5)');
  closeTo(percentileRank(win, 1), 10, 'pct(1)');
  closeTo(percentileRank(win, 5), 50, 'pct(5)');
  closeTo(percentileRank(win, 10), 100, 'pct(10)');
  closeTo(percentileRank(win, 11), 100, 'pct(11)');
  // Wilder ATR(14) fixture (frozen Python numbers)
  const atrBars = [
    [100, 101.0, 99.0, 100.5], [100.5, 102.0, 100.0, 101.5],
    [101.5, 102.5, 100.5, 101.0], [101.0, 103.0, 100.5, 102.5],
    [102.5, 104.0, 102.0, 103.5], [103.5, 104.5, 103.0, 104.0],
    [104.0, 105.0, 103.5, 104.5], [104.5, 105.5, 104.0, 105.0],
    [105.0, 106.0, 104.5, 105.5], [105.5, 106.5, 105.0, 106.0],
    [106.0, 107.0, 105.5, 106.5], [106.5, 107.5, 106.0, 107.0],
    [107.0, 108.0, 106.5, 107.5], [107.5, 108.5, 107.0, 108.0],
    [108.0, 109.0, 107.5, 108.5], [108.5, 109.5, 108.0, 109.0],
    [109.0, 110.0, 108.5, 109.5], [109.5, 110.5, 109.0, 110.0],
    [110.0, 111.0, 109.5, 110.5], [110.5, 111.5, 110.0, 111.0],
  ].map(([o, h, l, c], k) => ({ t: k * 60000, o, h, l, c }));
  const atr = atrWilder(atrBars, 14);
  const EXPECT_ATR = { 13: 1.7142857143, 14: 1.6989795918, 15: 1.6847667638, 16: 1.6715691379, 17: 1.6593141994, 18: 1.6479346138, 19: 1.6373678556 };
  for (let k = 0; k < 13; k++) eq(atr[k], undefined, `atr undefined at ${k}`);
  for (const [k, v] of Object.entries(EXPECT_ATR)) closeTo(atr[+k], v, `atr(${k})`, 1e-8);
  closeTo(median([3, 1, 2]), 2, 'median odd');
  closeTo(median([4, 1, 2, 3]), 2.5, 'median even');
  console.log('4. dispatch truth table (17), expiry boundaries (7), percentile (5), ATR fixture (8), median (2)');
}

// ════════════════════════════════════════════════════════════════════════════
// 5. property sweep: break-once-per-swing + trend-transition consistency
// ════════════════════════════════════════════════════════════════════════════
{
  for (let seed = 101; seed <= 120; seed++) {
    const bars = randomWalk(800, seed);
    const s = buildStructure(bars);
    let lastBullRef = -1, lastBearRef = -1;
    for (let t = 1; t < bars.length; t++) {
      const ev = EVENT_NAME[s.eventAt[t]];
      const trendBefore = TREND_NAME[s.trendAfter[t - 1]];
      const trendNow = TREND_NAME[s.trendAfter[t]];
      if (ev === 'BOS_BULL' || ev === 'CHoCH_BULL') {
        // reference entering the bar was unbroken, value unchanged by break
        ok(s.shB[t - 1] === 0, `t=${t}: bull break uses unbroken sh`);
        ok(s.shV[t] === s.shV[t - 1], `t=${t}: bull break does not change sh value`);
        ok(s.shB[t] === 1, `t=${t}: sh consumed after bull break`);
        ok(bars[t].c > s.shV[t - 1], `t=${t}: bull break close strictly above sh`);
        ok(s.shT[t - 1] !== lastBullRef, `t=${t}: no second bull break on the same reference`);
        lastBullRef = s.shT[t - 1];
        ok(ev === 'BOS_BULL' ? trendBefore === 'UP' && trendNow === 'UP'
                             : trendBefore !== 'UP' && trendNow === 'UP',
          `t=${t}: ${ev} trend transition consistent`);
      }
      if (ev === 'BOS_BEAR' || ev === 'CHoCH_BEAR') {
        ok(s.slB[t - 1] === 0, `t=${t}: bear break uses unbroken sl`);
        ok(s.slV[t] === s.slV[t - 1], `t=${t}: bear break does not change sl value`);
        ok(s.slB[t] === 1, `t=${t}: sl consumed after bear break`);
        ok(bars[t].c < s.slV[t - 1], `t=${t}: bear break close strictly below sl`);
        ok(s.slT[t - 1] !== lastBearRef, `t=${t}: no second bear break on the same reference`);
        lastBearRef = s.slT[t - 1];
        ok(ev === 'BOS_BEAR' ? trendBefore === 'DOWN' && trendNow === 'DOWN'
                             : trendBefore !== 'DOWN' && trendNow === 'DOWN',
          `t=${t}: ${ev} trend transition consistent`);
      }
      if (ev === 'NONE') {
        ok(trendNow === trendBefore, `t=${t}: trend never moves without an event`);
      }
      ok(ev !== 'BOTH', `t=${t}: BOTH unreachable under valid OHLC (structural property)`);
    }
  }
  console.log('5. property sweep: 20 random walks, break-once + trend-consistency + no-BOTH invariants');
}

// ════════════════════════════════════════════════════════════════════════════
// 6. BOTH branch via direct state injection (structurally unreachable on
//    valid OHLC — see header note 6 — but the branch must still be correct)
// ════════════════════════════════════════════════════════════════════════════
{
  const state = createStructureState();
  state.sh = { v: 100, t: 1, i: 1, broken: false };
  state.sl = { v: 104, t: 2, i: 2, broken: false };
  const bars = [{ t: 10, o: 101, h: 102.5, l: 101.5, c: 102 }];  // close between 100 and 104
  const step = stepStructure(state, bars, 0);
  eq(step.event, 'BOTH', 'injected state: close between sh.v and sl.v -> BOTH');
  eq(state.trend, 'DOWN', 'injected state: BOTH applies bull leg then bear leg');
  eq(state.sh.broken, true, 'injected state: sh consumed');
  eq(state.sl.broken, true, 'injected state: sl consumed');
  eq(decideTrigger({ event: 'BOTH', bias: 'UP', atrWindowLen: 100 }).reason, 'AMBIGUOUS', 'BOTH dispatches AMBIGUOUS');
  console.log('6. BOTH branch (state injection): event, leg order, consumption, dispatch');
}

// ════════════════════════════════════════════════════════════════════════════
// 7. 15m alignment helpers + resolveResult
// ════════════════════════════════════════════════════════════════════════════
{
  const c15 = Array.from({ length: 20 }, (_, k) => ({ t: k * MS_15M, o: 1, h: 1, l: 1, c: 1 }));
  // closes at (k+1)*15m
  eq(lastClosed15Index(c15, 0), -1, 'no closed 15m at t=0');
  eq(lastClosed15Index(c15, MS_15M), 0, 'bar 0 closed exactly at 15m (inclusive)');
  eq(lastClosed15Index(c15, MS_15M - 1), -1, 'bar 0 not closed at 15m-1');
  eq(lastClosed15Index(c15, 8 * MS_15M - 1), 6, 'bar 6 last closed just before bar 7 closes');
  eq(lastClosed15Index(c15, 8 * MS_15M), 7, 'bar 7 closed exactly at 8*15m (inclusive)');
  const ptr = makeBiasPointer(c15);
  const seq = [0, MS_15M - 1, MS_15M, 8 * MS_15M - 1, 8 * MS_15M, 3 * MS_15M];  // last query is BACKWARDS
  eq(seq.map(ptr).join(','), '-1,-1,0,6,7,2', 'bias pointer matches backward scan incl. reset on backwards query');
  eq(resolveResult('CALL', 100, 101), 'WIN', 'resolve CALL up');
  eq(resolveResult('CALL', 100, 99.9), 'LOSS', 'resolve CALL down');
  eq(resolveResult('CALL', 100, 100), 'TIE', 'resolve CALL flat');
  eq(resolveResult('PUT', 100, 99), 'WIN', 'resolve PUT down');
  eq(resolveResult('PUT', 100, 100.1), 'LOSS', 'resolve PUT up');
  eq(resolveResult('PUT', 100, 100), 'TIE', 'resolve PUT flat');
  console.log('7. 15m alignment (6) + pointer equivalence incl. backwards reset (1) + resolveResult (6)');
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Runner composition cross-check + ATR window insufficiency path
// ════════════════════════════════════════════════════════════════════════════
{
  const c1 = randomWalk(900, 4242);
  const c15raw = randomWalk(60, 4243);
  const c15 = c15raw.map((b, k) => ({ ...b, t: c1[0].t + k * MS_15M }));
  const runner = new MarketStructureRunner({ c15, c1 });
  // composition agrees with the raw pieces on sampled bars
  for (let i = 150; i < 880; i += 61) {
    const r = runner.bar(i);
    const i15ref = lastClosed15Index(c15, c1[i].t + MS_1M);
    eq(r.i15, i15ref, `runner i15 at ${i} == backward-scan reference`);
    eq(r.bias, i15ref >= 0 ? TREND_NAME[runner.s15.trendAfter[i15ref]] : 'UNKNOWN', `runner bias at ${i}`);
    eq(EVENT_NAME[runner.s1.eventAt[i]], r.event, `runner event at ${i}`);
    if (r.decision !== 'NO_TRADE' || r.reason !== 'EXPIRY_INSUFFICIENT') {
      ok(r.atrWindowLen === ATR_WINDOW, `atr window full at ${i}`);
    }
  }
  // insufficient ATR window at the very start -> EXPIRY_INSUFFICIENT blocks
  const early = runner.bar(ATR_PERIOD + 5);
  ok(early.atrWindowLen < ATR_WINDOW && early.reason === 'EXPIRY_INSUFFICIENT',
    'early bar: ATR window insufficient -> EXPIRY_INSUFFICIENT');
  ok(runner.bar(ATR_PERIOD + ATR_WINDOW - 1).atrWindowLen === ATR_WINDOW,
    'first full-window bar index = ATR_PERIOD + ATR_WINDOW - 1');
  console.log('8. runner composition cross-check (13 samples) + ATR window edge (2)');
}

// ════════════════════════════════════════════════════════════════════════════
// 9. real-data smoke: fetched BTC window, sample of in-window bars
// ════════════════════════════════════════════════════════════════════════════
{
  const DATA = join(ROOT, 'backtest', 'data', 'ms');
  let c1, c15;
  try {
    c1 = JSON.parse(readFileSync(join(DATA, 'BTCUSD_1m.json'), 'utf8')).candles;
    c15 = JSON.parse(readFileSync(join(DATA, 'BTCUSD_15m.json'), 'utf8')).candles;
  } catch {
    c1 = null;
  }
  if (!c1) {
    console.log('9. real-data smoke SKIPPED (no cached BTC data)');
  } else {
    const WIN_START = Date.UTC(2023, 6, 5);
    const runner = new MarketStructureRunner({ c15, c1 });
    // first evaluated bar: the 1m candle closing exactly at the window start
    let first = -1;
    for (let i = 0; i < c1.length; i++) if (c1[i].t + MS_1M === WIN_START) { first = i; break; }
    ok(first > 0, 'BTC: found the first evaluated bar (close == window start)');
    const r = runner.bar(first);
    eq(r.entryCloseT, WIN_START, 'BTC: first decision exactly at 2023-07-05T00:00Z');
    ok(r.bias === 'UP' || r.bias === 'DOWN' || r.bias === 'UNKNOWN', 'BTC: bias is a valid state');
    ok(r.atrWindowLen === ATR_WINDOW, 'BTC: full ATR-100 window at first evaluated bar (warmup sufficient)');
    // contiguous 1m data through the whole fetch (24/7 crypto, no gaps)
    let gaps = 0;
    for (let k = 1; k < c1.length; k++) if (c1[k].t - c1[k - 1].t !== MS_1M) gaps++;
    eq(gaps, 0, 'BTC: zero 1m gaps across warmup+window+tail');
    let gaps15 = 0;
    for (let k = 1; k < c15.length; k++) if (c15[k].t - c15[k - 1].t !== MS_15M) gaps15++;
    eq(gaps15, 0, 'BTC: zero 15m gaps');
    // spot-check decisions deep in the window resolve consistently
    const mid = first + 200000;
    const rm = runner.bar(mid);
    ok(['CALL', 'PUT', 'NO_TRADE'].includes(rm.decision), 'BTC: mid-window decision valid');
    if (rm.decision === 'CALL' || rm.decision === 'PUT') {
      ok([5, 7, 10].includes(rm.minutes), 'BTC: expiry from the frozen ladder');
      const exitIdx = mid + rm.minutes;
      eq(c1[exitIdx].t, c1[mid].t + rm.minutes * MS_1M, 'BTC: exit candle timestamp exact');
      eq(resolveResult(rm.decision, c1[mid].c, c1[exitIdx].c) !== null, true, 'BTC: result resolvable');
    }
    console.log(`9. real-data smoke: BTC first-bar bias=${r.bias}, first decision=${r.decision}/${r.reason ?? 'trade ' + rm.minutes + 'm'}`);
  }
}

console.log(`\n══ market_structure_tests: ${pass} passed, ${fail} failed ══`);
process.exit(fail === 0 ? 0 : 1);

/**
 * UT Bot Alerts port — exact-match test suite.
 *
 * Every fixture here is HAND-DERIVED from the frozen Pine v4 reference
 * (see src/strategy/utBotAlerts.mjs header). Coverage by pitfall:
 *   [1] P1 ta.crossover semantics — <= on the prior bar, strict > now, na prior.
 *   [2] P3 ta.atr seeding — indicators.mjs atr() IS Pine's (tr(true) first bar,
 *       SMA seed at bar c-1, Wilder recursion) — the reuse proof.
 *   [3] P2 nz() first-bar handling — warmup trace with c=10, hand-computed:
 *       stop na through bar c-2, stop[c-1] = close - a*ATR(SMA seed), pos 0.
 *   [4] P4 nested iff structure — golden down-then-up fixture (c=3): SELL at
 *       bar 3 (branch-4 reset above price), BUY at bar 6 (branch-3 reset
 *       below price). A max/min "simplification" diverges on both bars.
 *   [5] Golden up-then-down fixture: SELL at bar 4 via breakdown reset.
 *   [6] c=1 edge: stop defined on bar 0 (cond3 + defined nLoss), current-bar
 *       equality → no cross → branch-4 reset → SELL; pos quirk pinned.
 *   [7] NO-LOOKAHEAD PROOF: truncation invariance (bit-identical prefixes),
 *       future-mutation invariance, and a leakage canary.
 *
 * Run: node scripts/utbot_tests.mjs
 */
import {
  computeUtBot, pineCrossover, lastClosedIndexTf, eventToSignal,
  UT_A_DEFAULT, UT_C_DEFAULT, MS_1M,
} from '../src/strategy/utBotAlerts.mjs';
import { atr } from '../src/strategy/indicators.mjs';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}
function eq(a, b, name, eps = 1e-9) {
  const good = a === b || (typeof a === 'number' && typeof b === 'number'
    && Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)));
  ok(good, name);
}
function isNa(v, name) { ok(v === undefined, name + ' (na=undefined)'); }

function mk(n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const r = fn(i);
    return { t: 1_700_000_000_000 + i * MS_1M, o: r.o, h: r.h, l: r.l, c: r.c };
  });
}

// ── [1] P1: ta.crossover semantics ───────────────────────────────────────────
console.log('[1] ta.crossover semantics (P1)');
{
  ok(pineCrossover(5, 4, 4.5, 4.5) === true, 'prior-bar equality IS a cross (x[1] <= y[1])');
  ok(pineCrossover(5, 4, 5, 4.5) === false, 'current-bar equality is NOT a cross (strict >)');
  ok(pineCrossover(5, 3, 4, 5) === true, 'plain cross up');
  ok(pineCrossover(4, 6, 4.5, 4) === false, 'no cross when already above');
  ok(pineCrossover(5, undefined, 4, undefined) === false, 'na prior bar -> no cross');
  ok(pineCrossover(5, 4, 4.5, undefined) === false, 'na y[1] -> no cross');
}

// ── [2] P3: atr() is Pine's ta.atr — reuse proof ─────────────────────────────
console.log('[2] ATR seeding = Pine ta.atr (P3)');
{
  // Hand-computed: TR0 = high-low (Pine tr(true)); TRi from ranges.
  const C = mk(12, i => ({
    o: 100 + i, h: 100.5 + i, l: 99.5 + i, c: 100 + i,
  }));
  // TR0 = 1, TRi = max(1, 1.5, 0.5) = 1.5 for i >= 1 (rise-by-1 bars).
  const a10 = atr(C, 10);
  for (let i = 0; i < 9; i++) isNa(a10[i], 'ATR na at bar ' + i + ' (before SMA seed)');
  eq(a10[9], (1 + 1.5 * 9) / 10, 'ATR seed at bar 9 = SMA(TR[0..9]) = 1.45');
  eq(a10[10], (a10[9] * 9 + 1.5) / 10, 'ATR bar 10 = Wilder recursion');
  eq(a10[11], (a10[10] * 9 + 1.5) / 10, 'ATR bar 11 = Wilder recursion');
  // c=1 degenerate: seed = TR0, recursion = TR itself.
  const a1 = atr(C, 1);
  eq(a1[0], 1, 'ATR(1) seed = TR0');
  eq(a1[1], 1.5, 'ATR(1) step = TR');
  // First-bar TR = high - low even when a prior close would matter (na close).
  const G = mk(3, i => ({ o: 10, h: 13, l: 9, c: 11 + i }));
  eq(atr(G, 3)[2], 4, 'TR0 = high-low enters the SMA seed');
}

// ── [3] P2: nz() first-bar handling, c=10 warmup trace ───────────────────────
console.log('[3] nz() first-bar handling (P2)');
{
  const C = mk(10, i => ({ o: 99 + i, h: 99.5 + i, l: 98.5 + i, c: 100 + i }));
  // Hand-derived TRs for THIS fixture: h-l = 1, |h_i - c[i-1]| = 0.5,
  // |l_i - c[i-1]| = 0.5 -> TR_i = 1 for every i; ATR[9] = SMA = 1 exactly.
  const r = computeUtBot(C, { a: 1, c: 10 }, { tfMs: MS_1M });
  for (let i = 0; i < 9; i++) isNa(r.stop[i], 'stop na at bar ' + i + ' (nLoss na -> iff chains yield na)');
  // Bar 9 (warmup bar): cond1 = (src>0 and src[1]>0) = true via nz stop[8]=0
  //   -> max(nz(stop[8],0)=0, src - nLoss) = 109 - 1 = 108
  eq(r.stop[9], 109 - 1, 'stop[9] = close[9] - ATR[9] = 108 (max with nz seed 0)');
  for (let i = 0; i < 10; i++) eq(r.pos[i], 0, 'pos[' + i + '] = 0 (nz(pos[1],0) seed)');
  ok(r.buy.every(b => b === false) && r.sell.every(b => b === false), 'no events during warmup (na crossover legs)');
  ok(r.events.length === 0, 'events empty during warmup');
}

// ── [4] P4: golden fixture — SELL bar 3, BUY bar 6 (c=3, a=1) ────────────────
console.log('[4] golden down-then-up fixture (P4 nested iff, both resets)');
{
  const raw = [
    { o: 100, h: 100.5, l: 99.5, c: 100 },    // 0
    { o: 100, h: 99.5, l: 98.5, c: 99 },      // 1
    { o: 99, h: 99, l: 96.8, c: 97 },         // 2
    { o: 97, h: 97.2, l: 94.8, c: 95 },       // 3  breakdown -> branch 4 reset
    { o: 95, h: 95.2, l: 93.7, c: 94 },       // 4
    { o: 94, h: 94.6, l: 93.9, c: 94.2 },     // 5
    { o: 94.2, h: 96.8, l: 94, c: 96.5 },     // 6  breakout  -> branch 3 reset
  ];
  const C = raw.map((r, i) => ({ t: 1_700_000_000_000 + i * MS_1M, ...r }));
  const r = computeUtBot(C, { a: 1, c: 3 }, { tfMs: MS_1M });

  // TR: 1, 1.5, 2.2, 2.4, 1.5, 0.7, 2.8 (hand-derived).
  const tr3 = (1 + 1.5 + 2.2) / 3;              // atr[2]  = 1.5666..
  const atr3 = (tr3 * 2 + 2.4) / 3;             // atr[3]  = 1.8444..
  const atr4 = (atr3 * 2 + 1.5) / 3;            // atr[4]  = 1.7296..
  const atr5 = (atr4 * 2 + 0.7) / 3;            // atr[5]  = 1.3864..
  const atr6 = (atr5 * 2 + 2.8) / 3;            // atr[6]  = 1.8576..

  isNa(r.stop[0], 'bar0: cond1 na (src[1] na), cond3 gives src-nLoss with nLoss na -> stop na');
  isNa(r.stop[1], 'bar1: cond1 true -> max(0, src-nLoss) with nLoss na -> stop na');
  eq(r.stop[2], 97 - tr3, 'bar2: warmup bar -> max(0, 97 - ATR_sma) = 95.4333 (stop BELOW price)');
  // bar3: src(95) < ps(95.4333), src[1](99) > ps -> NOT cond2 (needs BOTH below)
  //   -> cond3 false -> ELSE: stop = src + nLoss (branch-4 reset ABOVE price).
  //   A max()-simplification would keep the old stop here -> divergence.
  eq(r.stop[3], 95 + atr3, 'bar3: branch-4 reset stop = src + nLoss = 96.8444 (NOT min/max of prev)');
  eq(r.stop[4], Math.min(r.stop[3], 94 + atr4), 'bar4: cond2 (both below) -> min(ps, src + nLoss)');
  eq(r.stop[5], Math.min(r.stop[4], 94.2 + atr5), 'bar5: cond2 continues -> trailing min');
  // bar6: src(96.5) > ps(95.5864), src[1](94.2) < ps -> NOT cond1 (needs BOTH above)
  //   -> cond3 TRUE: stop = src - nLoss (branch-3 reset BELOW price, unconditional).
  //   A max()-simplification would keep the old stop ABOVE price -> no BUY ever.
  eq(r.stop[6], 96.5 - atr6, 'bar6: branch-3 reset stop = src - nLoss = 94.6424 (unconditional)');

  eq(r.pos[0], 0, 'pos[0] = 0 (nz seed)');
  eq(r.pos[1], 0, 'pos[1] = 0');
  eq(r.pos[2], 0, 'pos[2] = 0');
  eq(r.pos[3], -1, 'pos[3] = -1 (src[1]=97 > ps, src=95 < ps)');
  eq(r.pos[4], -1, 'pos[4] carried');
  eq(r.pos[5], -1, 'pos[5] carried');
  eq(r.pos[6], 1, 'pos[6] = +1 (src[1]=94.2 < ps, src=96.5 > ps)');

  // below = crossover(stop, ema): bar3 stop 96.8444 > ema 95 TRUE,
  //   bar2 stop 95.4333 <= ema 97 TRUE -> SELL = (95 < 96.8444) AND below.
  ok(r.sell[3] === true, 'SELL at bar 3 (stop reset above price after breakdown)');
  // above = crossover(ema, stop): bar6 96.5 > 94.6424 TRUE, bar5 94.2 <= 95.5864 TRUE -> BUY.
  ok(r.buy[6] === true, 'BUY at bar 6 (stop reset below price after breakout)');
  const others = [];
  r.buy.forEach((b, i) => { if (b && i !== 6) others.push('buy@' + i); });
  r.sell.forEach((s, i) => { if (s && i !== 3) others.push('sell@' + i); });
  ok(others.length === 0, 'no other events (got: ' + (others.join(',') || 'none') + ')');

  ok(r.events.length === 2, 'exactly 2 events');
  eq(r.events[0].i, 3, 'event[0] bar 3');
  eq(r.events[0].type, 'sell', 'event[0] sell');
  eq(r.events[0].closeT, C[3].t + MS_1M, 'event[0] closeT = open + tf');
  eq(r.events[1].i, 6, 'event[1] bar 6');
  eq(r.events[1].type, 'buy', 'event[1] buy');
  eq(r.events[1].stop, r.stop[6], 'event[1] stop matches series');
  eq(r.events[1].atr, atr6, 'event[1] atr matches hand value');
  eq(r.events[1].pos, 1, 'event[1] pos +1');

  const sig = eventToSignal(r.events[1], 'TEST/USD', {
    timestamp: 'x', a: 1, c: 3, timeframe: '1min', expiryMinutes: 1, expiryTime: 'y',
    stopPrev: r.stop[5], posPrev: r.pos[5],
  });
  ok(sig.finalSignal === 'CALL' && sig.engine === 'UT-BOT', 'buy -> CALL mapping');
  ok(sig.audit.event === 'buy' && sig.audit.key === 1 && sig.audit.atrPeriod === 3, 'audit carries indicator vocabulary');
}

// ── [5] golden up-then-down fixture — SELL at bar 4 (c=3, a=1) ───────────────
console.log('[5] golden up-then-down fixture');
{
  const raw = [
    { o: 100, h: 100.5, l: 99.5, c: 100 },     // 0
    { o: 100, h: 101, l: 99.8, c: 100.8 },     // 1
    { o: 100.8, h: 102, l: 100.5, c: 101.5 },  // 2
    { o: 101.5, h: 104, l: 101.2, c: 103.5 },  // 3
    { o: 103.5, h: 103.6, l: 100, c: 100.2 },  // 4 breakdown
  ];
  const C = raw.map((r, i) => ({ t: 1_700_000_000_000 + i * MS_1M, ...r }));
  const r = computeUtBot(C, { a: 1, c: 3 }, { tfMs: MS_1M });
  const tr2 = (1 + 1.2 + 1.5) / 3;              // 1.2333..
  const atr3 = (tr2 * 2 + 2.8) / 3;             // 1.7555..
  const atr4 = (atr3 * 2 + 3.6) / 3;            // 2.3703..
  isNa(r.stop[0], 'stop[0] na');
  isNa(r.stop[1], 'stop[1] na');
  eq(r.stop[2], 101.5 - tr2, 'stop[2] = close - ATR_sma');
  eq(r.stop[3], Math.max(r.stop[2], 103.5 - atr3), 'stop[3] = max(ps, src - nLoss) trailing');
  eq(r.stop[4], 100.2 + atr4, 'bar4: breakdown -> branch-4 reset ABOVE price = 102.5704');
  eq(r.pos[4], -1, 'pos[4] = -1');
  ok(r.sell[4] === true, 'SELL at bar 4');
  ok(r.buy.every(b => b === false), 'no buys');
  ok(r.events.length === 1 && r.events[0].type === 'sell', 'exactly 1 sell event');
}

// ── [6] c=1 edge: defined stop on bar 0 + equality handling ──────────────────
console.log('[6] c=1 first-bar + equality edges');
{
  const raw = [
    { o: 100, h: 100.5, l: 99, c: 99.5 },   // 0  TR0=1.5 -> stop0 = 98 (DEFINED)
    { o: 99.5, h: 99.6, l: 98, c: 98 },     // 1  close == stop0 exactly
  ];
  const C = raw.map((r, i) => ({ t: 1_700_000_000_000 + i * MS_1M, ...r }));
  const r = computeUtBot(C, { a: 1, c: 1 }, { tfMs: MS_1M });
  eq(r.stop[0], 99.5 - 1.5, 'bar0 with c=1: cond3 + defined nLoss -> stop = 98 (not na)');
  eq(r.pos[0], 0, 'pos[0] = 0');
  // bar1: src(98) == ps(98) -> cond1/2/3 all false (strict >, strict <) -> else:
  //   stop = 98 + 1.6 = 99.6 (reset ABOVE). Current-bar equality is NOT a cross,
  //   so no buy; but the stop crossed OVER price -> below fires -> SELL.
  eq(r.stop[1], 98 + 1.6, 'bar1: equality hits else-branch -> stop = src + nLoss = 99.6');
  ok(r.buy[1] === false, 'current-bar equality: no BUY (strict > required)');
  ok(r.sell[1] === true, 'bar1: crossover(stop, ema) fires (prior 98 <= 99.5, now 99.6 > 98) -> SELL');
  eq(r.pos[1], 0, 'pos[1] = 0 — pos uses price-vs-stop iff, pinned even though sell fired');
}

// ── [7] NO-LOOKAHEAD PROOF ───────────────────────────────────────────────────
console.log('[7] no-lookahead proofs');
{
  // Deterministic pseudo-random OHLC series (LCG — reproducible).
  let s = 20260918;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const N = 400;
  const C = [];
  let px = 100;
  for (let i = 0; i < N; i++) {
    const o = px;
    const c = o + (rnd() - 0.5) * 2;
    const h = Math.max(o, c) + rnd() * 0.8;
    const l = Math.min(o, c) - rnd() * 0.8;
    C.push({ t: 1_700_000_000_000 + i * MS_1M, o, h, l, c });
    px = c;
  }
  const full = computeUtBot(C, { a: 1, c: 10 }, { tfMs: MS_1M });

  let truncFail = 0, mutFail = 0, checked = 0;
  for (let k = 15; k < N; k += 7) {
    checked++;
    // (a) truncation invariance: prefix computation must be BIT-identical.
    const pre = computeUtBot(C.slice(0, k + 1), { a: 1, c: 10 }, { tfMs: MS_1M });
    if (pre.stop[k] !== full.stop[k] || pre.pos[k] !== full.pos[k]
      || pre.buy[k] !== full.buy[k] || pre.sell[k] !== full.sell[k]) truncFail++;
    // (b) future-mutation invariance: changing candles > k cannot touch bar k.
    const m = C.map((x, j) => (j > k
      ? { t: x.t, o: x.o * 1.31 + 0.07, h: x.h * 1.41 + 0.13, l: x.l * 0.71 + 0.03, c: x.c * 1.23 + 0.11 }
      : x));
    const mut = computeUtBot(m, { a: 1, c: 10 }, { tfMs: MS_1M });
    if (mut.stop[k] !== full.stop[k] || mut.pos[k] !== full.pos[k]
      || mut.buy[k] !== full.buy[k] || mut.sell[k] !== full.sell[k]) mutFail++;
  }
  ok(checked === 55 && truncFail === 0, 'truncation invariance: prefix == full, bit-identical (55 indices)');
  ok(mutFail === 0, 'future-mutation invariance: bar k untouched by candles > k');

  // (c) leakage canary: mutating the CURRENT candle MUST change values —
  //     proves the suite can detect leakage if it ever appears.
  const m = C.map(x => ({ ...x }));
  m[200] = { t: m[200].t, o: m[200].o, h: m[200].c + 50, l: m[200].l, c: m[200].c + 50 };
  const mut = computeUtBot(m, { a: 1, c: 10 }, { tfMs: MS_1M });
  ok(mut.atr[200] !== full.atr[200], 'canary: mutating candle 200 changes atr[200] (suite detects leakage)');
  ok(mut.stop.slice(200).some((v, j) => v !== full.stop[200 + j]),
    'canary: stop series diverges at/after bar 200');

  // (d) helper sanity on real data.
  eq(lastClosedIndexTf(C, C[99].t + MS_1M, MS_1M), 99, 'lastClosedIndexTf boundary');
  eq(lastClosedIndexTf(C, C[99].t, MS_1M), 98, 'lastClosedIndexTf excludes unclosed candle');
}

console.log('\nUT Bot exact-match tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

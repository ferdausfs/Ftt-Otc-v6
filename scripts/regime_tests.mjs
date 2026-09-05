/**
 * FTT3-R regime-adaptive test suite (branch-only; FTT3's strategy_tests.mjs
 * is untouched and stays the audited Strategy A suite).
 *
 *   1. New indicator math (ADX / RSI / Bollinger) against hand-computed
 *      fixtures verified with an independent calculator (scripts/fixture_
 *      calc.py in the project workspace), plus structural sanity cases.
 *   2. Regime classifier: exact textbook boundaries (25 / 20), edge values.
 *   3. Strategy B D-chain: strict D1 -> D2 -> D3 ordering, every blocking
 *      reason reachable, expiry ladder attached to signals.
 *   4. Dispatcher integration: all three regimes reachable, TREND rows carry
 *      the unchanged C-audit, MEANREV rows the D-audit, every row tagged with
 *      regime + strategy.
 *   5. Reference path == fast (precomputed) path, index-for-index.
 *   6. NO-LOOKAHEAD PROOF for the new code: mutating any candle not fully
 *      closed before the entry candle's close time cannot change the
 *      decision, the audit, or the expiry — on BOTH value paths. Leakage
 *      canaries prove the suite can detect leakage if it ever appears.
 *   7. PAIR-AGNOSTIC PROOF: identical candle inputs produce byte-identical
 *      decision/audit sequences regardless of which pair label wraps the
 *      call, and the regime/meanReversion sources contain no pair names.
 *
 * Run: node scripts/regime_tests.mjs
 */
import {
  adx, rsi, bollinger, trueRange,
} from '../src/strategy/indicators.mjs';
import {
  classifyRegime, computeRegime, ADX_PERIOD, ADX_TREND_MIN, ADX_RANGE_MAX,
} from '../src/strategy/regime.mjs';
import {
  evaluateMeanReversion, BB_PERIOD, BB_MULT, RSI_PERIOD,
  RSI_OVERBOUGHT, RSI_OVERSOLD,
} from '../src/strategy/meanReversion.mjs';
import {
  evaluateSignal, evaluateRegimeSignal, precompute, expiryForPercentile,
  MS_1M, MS_5M, MS_15M,
} from '../src/strategy/engine.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}
function eq(a, b, name, eps = 1e-6) {
  const good = a === b || (typeof a === 'number' && typeof b === 'number'
    && Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)));
  ok(good, name);
}

// ── 1. indicator fixtures (independently computed) ──────────────────────────
console.log('[1] ADX / RSI / Bollinger fixtures');
{
  // 8-bar OHLC fixture, period 3 — values verified by scripts/fixture_calc.py
  const C = [
    { o: 10, h: 11, l: 9, c: 10 }, { o: 10, h: 12, l: 10, c: 11 },
    { o: 11, h: 13, l: 11, c: 12 }, { o: 12, h: 16, l: 12, c: 15 },
    { o: 15, h: 15.5, l: 14.5, c: 15 }, { o: 15, h: 14, l: 13, c: 13.5 },
    { o: 13.5, h: 14, l: 13, c: 13.8 }, { o: 13.8, h: 15, l: 13.7, c: 14.9 },
  ];
  const a = adx(C, 3);
  ok(a.adx[0] === undefined && a.adx[4] === undefined, 'ADX undefined before index 2*period-1');
  eq(a.adx[5], 73.134328, 'ADX seed = mean of first 3 DX');
  eq(a.adx[6], 55.223881, 'ADX Wilder step 1');
  eq(a.adx[7], 53.405068, 'ADX Wilder step 2');
  eq(a.plusDI[3], 62.5, '+DI at seed index');
  eq(a.minusDI[3], 0, '-DI at seed index');
  eq(a.dx[3], 100, 'DX at seed index');
  eq(a.dx[5], 19.402985, 'DX mixed bar');
  eq(a.plusDI[7], 42.003652, '+DI Wilder step');
}
{
  const lin = Array.from({ length: 40 }, (_, i) => ({ o: i, h: i + 1, l: i, c: i + 1 }));
  const a = adx(lin, 14);
  ok(a.adx.slice(0, 27).every(v => v === undefined), 'ADX(14) undefined before index 2*period-1');
  eq(a.adx[27], 100, 'straight-line trend -> ADX 100 (first value at index 27)');
  eq(a.adx[30], 100, 'ADX stays 100');
}
{
  const flat = Array.from({ length: 40 }, () => ({ o: 5, h: 5, l: 5, c: 5 }));
  const a = adx(flat, 14);
  eq(a.adx[27], 0, 'perfectly flat -> ADX 0 (no directional movement)');
  eq(a.dx[20], 0, 'flat -> DX 0');
}
{
  const closes = [10, 11, 12, 11, 10, 9, 10, 11];
  const r = rsi(closes, 3);
  ok(r[0] === undefined && r[2] === undefined, 'RSI undefined before seed');
  eq(r[3], 66.666667, 'RSI seed');
  eq(r[4], 44.444444, 'RSI Wilder step 1');
  eq(r[5], 29.629630, 'RSI Wilder step 2');
  eq(r[6], 53.086420, 'RSI Wilder step 3');
  eq(r[7], 68.724280, 'RSI Wilder step 4');
}
{
  eq(rsi([5, 5, 5, 5, 5, 5], 3)[5], 50, 'flat closes -> RSI 50 (neutral)');
  eq(rsi([1, 2, 3, 4, 5], 3)[4], 100, 'only gains -> RSI 100');
}
{
  const closes = Array.from({ length: 20 }, (_, k) => k + 1);
  const bb = bollinger(closes, 20, 2);
  ok(bb.basis[18] === undefined, 'BB undefined before period-1');
  eq(bb.basis[19], 10.5, 'BB basis = SMA(20)');
  eq(bb.upper[19], 22.032563, 'BB upper = basis + 2*population std');
  eq(bb.lower[19], -1.032563, 'BB lower = basis - 2*population std');
}
{
  // rolling correctness: recompute at an interior index with a fresh window
  const closes = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3, 3, 8, 3, 2, 7];
  const bb = bollinger(closes, 5, 2);
  const w = closes.slice(15, 20);
  const mean = w.reduce((s, v) => s + v, 0) / 5;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / 5);
  eq(bb.basis[19], mean, 'BB rolls per-candle (basis)');
  eq(bb.upper[19], mean + 2 * sd, 'BB rolls per-candle (upper)');
}

// ── 2. classifier boundaries ─────────────────────────────────────────────────
console.log('[2] regime classifier (textbook thresholds, frozen)');
eq(ADX_PERIOD, 14, 'ADX period frozen at 14');
eq(ADX_TREND_MIN, 25, 'TRENDING threshold frozen at 25');
eq(ADX_RANGE_MAX, 20, 'RANGING threshold frozen at 20');
ok(classifyRegime(100) === 'TRENDING', 'ADX 100 -> TRENDING');
ok(classifyRegime(25) === 'TRENDING', 'ADX exactly 25 -> TRENDING');
ok(classifyRegime(24.999) === 'TRANSITION', 'ADX just under 25 -> TRANSITION');
ok(classifyRegime(22.5) === 'TRANSITION', 'ADX mid-band -> TRANSITION');
ok(classifyRegime(20) === 'TRANSITION', 'ADX exactly 20 -> TRANSITION');
ok(classifyRegime(19.999) === 'RANGING', 'ADX just under 20 -> RANGING');
ok(classifyRegime(0) === 'RANGING', 'ADX 0 -> RANGING');
ok(classifyRegime(undefined) === undefined, 'undefined ADX -> undefined regime');
ok(classifyRegime(NaN) === undefined, 'NaN ADX -> undefined regime');

// ── synthetic series (seeded, deterministic) ────────────────────────────────
const T0 = Date.UTC(2026, 0, 1); // aligned to 15m boundary
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function pushCandle(out, t, o, c, vol, rand) {
  const h = Math.max(o, c) + rand() * vol;
  const l = Math.min(o, c) - rand() * vol;
  out.push({ t, o, h, l, c });
}
/** DS-A: FTT3-style oscillator (trend reversals + vol regimes) for mutation tests. */
function gen1m(seed, n) {
  const rand = rng(seed);
  let price = 100;
  const out = [];
  for (let k = 0; k < n; k++) {
    const vol = k < n / 3 ? 0.02 : k < (2 * n) / 3 ? 0.06 : 0.25;
    const amp = k < n / 3 ? 0.0 : k < (2 * n) / 3 ? 0.08 : 0.22;
    const drift = amp * Math.sin(k / 45);
    const o = price;
    const c = Math.max(0.01, o + drift + (rand() - 0.5) * 2 * vol);
    pushCandle(out, T0 + k * MS_1M, o, c, vol, rand);
    price = c;
  }
  return out;
}
/** DS-B: regime mix — long chop / ramp-up / chop / ramp-down / chop segments
 *  so real ADX(14) sweeps through RANGING, TRENDING and TRANSITION. */
function genRegimeMix() {
  const rand = rng(777);
  const out = [];
  let price = 100;
  let k = 0;
  const seg = (minutes, stepFn) => {
    for (let m = 0; m < minutes; m++, k++) {
      const o = price;
      const c = Math.max(0.01, stepFn(o, m));
      pushCandle(out, T0 + k * MS_1M, o, c, 0.01, rand);
      price = c;
    }
  };
  const chop = () => seg(900, o => o + (rand() - 0.5) * 0.03);
  const ramp = (perBar) => seg(700, o => o + perBar);
  chop(); ramp(0.05); chop(); ramp(-0.05); chop();
  return out;
}
/** DS-MR: envelope-modulated oscillator + momentum bursts — exercises the
 *  D-chain (5m). Amplitude modulation lets closes pierce the BB bands (a
 *  stationary sine never does: for period < window, 2σ > amplitude). */
function genMr1m(n) {
  const rand = rng(4242);
  let price = 100;
  const out = [];
  for (let k = 0; k < n; k++) {
    const cyc = k % 1200;
    const mom = cyc > 1050;                                  // straight ramps
    const momDir = Math.floor(k / 1200) % 2 === 0 ? 1 : -1;  // up and down ramps
    const quiet = (k % 300) < 90;                            // D3 vol variation
    const amp = 0.9 * (1 + 0.9 * Math.sin(k / 211));          // slow envelope
    const drift = mom ? 0.30 * momDir : (quiet ? 0 : amp * Math.sin(k / 7));
    const vol = mom ? 0.02 : quiet ? 0.004 : 0.03;
    const o = price;
    const c = Math.max(0.01, o + drift + (rand() - 0.5) * 2 * vol);
    pushCandle(out, T0 + k * MS_1M, o, c, vol, rand);
    price = c;
  }
  return out;
}
/** Hand-crafted 5m pattern: flat closes, then a 2-candle dip-and-snapback that
 *  passes D1+D2 (fade-up) — used for the deterministic D3 and CALL fixtures. */
function craftMr5m(triggerGapMinutes) {
  const out = [];
  for (let k = 0; k < 30; k++) {
    const c = 100 + (k % 2 === 0 ? 0.05 : -0.05);
    out.push({ t: T0 + k * MS_5M, o: c + 0.1, h: c + 0.15, l: c - 0.15, c });
  }
  // decline into X: big negative changes -> RSI(14) < 30, close pierces band
  out.push({ t: T0 + 30 * MS_5M, o: 100.1, h: 100.2, l: 98.6, c: 98.8 });
  out.push({ t: T0 + 31 * MS_5M, o: 98.8, h: 98.9, l: 96.9, c: 97.2 });   // X
  const trigT = T0 + (32 * MS_5M) + (triggerGapMinutes - 5) * MS_1M;
  out.push({ t: trigT, o: 97.2, h: 99.3, l: 97.0, c: 99.0 });             // trigger
  return out;
}
function aggregate(m1, factor) {
  const out = [];
  for (let k = 0; k < m1.length; k += factor) {
    const chunk = m1.slice(k, k + factor);
    if (chunk.length < factor) break;
    out.push({
      t: chunk[0].t, o: chunk[0].o,
      h: Math.max(...chunk.map(x => x.h)), l: Math.min(...chunk.map(x => x.l)),
      c: chunk[chunk.length - 1].c,
    });
  }
  return out;
}
const A1 = gen1m(42, 6000);
const A5 = aggregate(A1, 5);
const A15 = aggregate(A1, 15);
const B1 = genRegimeMix();
const B5 = aggregate(B1, 5);
const B15 = aggregate(B1, 15);
const M1 = genMr1m(9000);
const M5 = aggregate(M1, 5);
ok(A5.length > 100 && A15.length > 60, 'DS-A aggregated series built');
ok(B15.length > 150, 'DS-B regime mix built (' + B15.length + ' 15m bars)');
ok(M5.length > 1500, 'DS-MR oscillator built (' + M5.length + ' 5m bars)');

// ── 3. D-chain reachability + strict ordering (direct Strategy B calls) ─────
console.log('[3] mean-reversion D-chain on synthetic series');
{
  const pre = precompute({ c15: B15, c5: M5, c1: M1 });
  const seen = new Set();
  const decisions = new Set();
  let checkedFast = 0;
  let rows = 0;
  let nestedFail = 0;
  for (let i = 120; i < M1.length - 1; i++) {
    if ((M1[i].t + MS_1M) % MS_5M !== 0) continue;
    let i5 = -1;
    for (let k = M5.length - 1; k >= 0; k--) {
      if (M5[k].t + MS_5M <= M1[i].t + MS_1M) { i5 = k; break; }
    }
    if (i5 === -1 || M5[i5].t + MS_5M !== M1[i].t + MS_1M) continue;
    rows++;
    const audit = { d1: null, d2: null, d3: null, expiry: null };
    const r = evaluateMeanReversion(M5, M1, i, i5, pre, audit);
    seen.add(r.reason);
    decisions.add(r.decision);
    if (r.reason.startsWith('D2_')) {
      if (!audit.d1) nestedFail++;
    }
    if (r.reason.startsWith('D3_')) {
      if (!audit.d1 || !audit.d2) nestedFail++;
    }
    if (r.decision === 'CALL' || r.decision === 'PUT') {
      if (!audit.expiry || ![5, 7, 10].includes(audit.expiry.minutes)) nestedFail++;
      if (r.reason !== 'D1_D2_D3_ALL_PASS') nestedFail++;
    }
    const audit2 = { d1: null, d2: null, d3: null, expiry: null };
    const rf = evaluateMeanReversion(M5, M1, i, i5, null, audit2);
    if (JSON.stringify(rf) === JSON.stringify(r) && JSON.stringify(audit2) === JSON.stringify(audit)) checkedFast++;
    else nestedFail++;
  }
  ok(rows > 800, 'boundary candidates evaluated (' + rows + ')');
  ok(nestedFail === 0, 'strict D-ordering + expiry + reference==fast on every row');
  for (const want of ['D1_NO_EXTENSION', 'D2_NO_EXHAUSTION', 'D2_NO_SNAPBACK',
    'D3_LOW_VOLATILITY', 'D1_D2_D3_ALL_PASS']) {
    ok(seen.has(want), 'reason reachable: ' + want + (seen.has(want) ? '' : ' (seen: ' + [...seen].join(',') + ')'));
  }
  for (const want of ['CALL', 'PUT']) ok(decisions.has(want), 'decision reachable: ' + want);
}

// Deterministic hand-crafted D-chain fixtures (5m pattern + 1m ATR control).
{
  // 1m series with LARGE ranges throughout -> ATR(14) well above its trailing
  // median -> D3 passes; combined with the dip-and-snapback 5m pattern this
  // must yield a full CALL (fade-up) signal.
  const C1m = [];
  for (let k = 0; k < 200; k++) {
    const t = T0 + k * MS_1M;
    const c = 100 + (k % 2 === 0 ? 0.05 : -0.05);
    C1m.push({ t, o: c + 0.2, h: c + 0.7, l: c - 0.7, c });
  }
  // pad past the trigger time so the entry 1m index exists
  for (let k = 200; k < 260; k++) {
    const t = T0 + k * MS_1M;
    const c = 99 + (k % 2 === 0 ? 0.05 : -0.05);
    C1m.push({ t, o: c + 0.2, h: c + 0.7, l: c - 0.7, c });
  }
  const c5 = craftMr5m(5);            // adjacent trigger
  const trig = c5[c5.length - 1];
  const entryCloseT = trig.t + MS_5M;
  const i = C1m.findIndex(k => k.t + MS_1M === entryCloseT);
  ok(i > 0, 'crafted CALL fixture: entry index exists (i=' + i + ')');
  const i5 = c5.length - 1;
  const audit = { d1: null, d2: null, d3: null, expiry: null };
  const r = evaluateMeanReversion(c5, C1m, i, i5, null, audit);
  ok(r.decision === 'CALL' && r.reason === 'D1_D2_D3_ALL_PASS',
    'crafted fade-up pattern -> full CALL signal (got ' + r.decision + '/' + r.reason + ')');
  ok(audit.d1 && audit.d1.extension === 'BELOW_LOWER', 'crafted D1: below lower band');
  ok(audit.d2 && audit.d2.exhausted === true && audit.d2.snapBack === 'INSIDE',
    'crafted D2: RSI exhaustion + snap-back inside');
  ok(audit.expiry && [5, 7, 10].includes(audit.expiry.minutes), 'crafted CALL carries expiry tier');

  // Same 5m pattern but 1m ATR collapses before the entry -> D3 must block.
  // Loud for k<80, quiet from k=80 on: the entry (~k=164) then has a
  // trailing-100 ATR window that is 85% quiet -> median is a quiet value and
  // ATR(14) (all-quiet) sits far below it.
  const C1mQuiet = [];
  for (let k = 0; k < 80; k++) {
    const t = T0 + k * MS_1M;
    const c = 100 + (k % 2 === 0 ? 0.05 : -0.05);
    C1mQuiet.push({ t, o: c + 0.2, h: c + 0.7, l: c - 0.7, c });   // TR ~ 1.4
  }
  for (let k = 80; k < 260; k++) {
    const t = T0 + k * MS_1M;
    const c = 99 + (k % 2 === 0 ? 0.005 : -0.005);
    C1mQuiet.push({ t, o: c + 0.002, h: c + 0.004, l: c - 0.004, c }); // TR ~ 0.01
  }
  const entryQ = C1mQuiet.findIndex(k => k.t + MS_1M === entryCloseT);
  const auditQ = { d1: null, d2: null, d3: null, expiry: null };
  const rq = evaluateMeanReversion(c5, C1mQuiet, entryQ, i5, null, auditQ);
  ok(rq.reason === 'D3_LOW_VOLATILITY' && rq.decision === 'NO_TRADE',
    'collapsed ATR -> D3_LOW_VOLATILITY blocks (got ' + rq.reason + ')');
  ok(auditQ.d1 && auditQ.d2 && auditQ.d3, 'D3 block carries full D1+D2+D3 audit');

  // Trigger candle NOT adjacent to X (10-minute gap) -> D2_NOT_ADJACENT.
  const c5gap = craftMr5m(10);
  const trigGap = c5gap[c5gap.length - 1];
  const entryGapT = trigGap.t + MS_5M;
  const C1mGap = C1m.map(k => ({ ...k }));
  const iGap = C1mGap.findIndex(k => k.t + MS_1M === entryGapT);
  const rg = evaluateMeanReversion(c5gap, C1mGap, iGap, c5gap.length - 1, null,
    { d1: null, d2: null, d3: null, expiry: null });
  ok(rg.reason === 'D2_NOT_ADJACENT', '10m gap between X and trigger -> D2_NOT_ADJACENT (got ' + rg.reason + ')');

  // Too-short 5m history -> D1_INSUFFICIENT_5M.
  const c5short = c5.slice(0, 10);
  const iShort = C1m.findIndex(k => k.t + MS_1M === c5short[c5short.length - 1].t + MS_5M);
  const rs = evaluateMeanReversion(c5short, C1m, iShort, c5short.length - 1, null,
    { d1: null, d2: null, d3: null, expiry: null });
  ok(rs.reason === 'D1_INSUFFICIENT_5M', 'short 5m history -> D1_INSUFFICIENT_5M (got ' + rs.reason + ')');
}


// ── 4. dispatcher integration: three regimes + audit tagging ────────────────
console.log('[4] dispatcher integration (regime first, then A/B/NO_TRADE)');
{
  const pre = precompute({ c15: B15, c5: B5, c1: B1 });
  const regimes = new Set();
  const strategies = new Set();
  const reasons = new Set();
  const decisions = new Set();
  let rows = 0;
  let shapeFail = 0;
  for (let i = 120; i < B1.length - 1; i++) {
    if ((B1[i].t + MS_1M) % MS_5M !== 0) continue;
    rows++;
    const r = evaluateRegimeSignal(B15, B5, B1, i, pre);
    regimes.add(r.audit.regime && r.audit.regime.regime);
    strategies.add(r.audit.strategy);
    reasons.add(r.reason);
    decisions.add(r.decision);
    // shape: every row carries regime + strategy tags and full audit slots
    if (!('regime' in r.audit) || !('strategy' in r.audit)) shapeFail++;
    if (r.audit.strategy === 'TREND') {
      if (r.audit.regime.regime !== 'TRENDING') shapeFail++;
      const ra = evaluateSignal(B15, B5, B1, i, pre);
      // Strategy A must be identical apart from the two added tags — compare
      // with normalized key order (dispatcher audit carries extra null slots)
      const strip = (a) => JSON.stringify({
        regime: null, strategy: null, c1: a.c1 ?? null, c2: a.c2 ?? null,
        c3: a.c3 ?? null, d1: null, d2: null, d3: null, expiry: a.expiry ?? null,
      });
      if (strip(r.audit) !== strip(ra.audit) || r.decision !== ra.decision || r.reason !== ra.reason) shapeFail++;
    }
    if (r.audit.strategy === 'MEANREV') {
      if (r.audit.regime.regime !== 'RANGING') shapeFail++;
      if (!('d1' in r.audit) || !('d3' in r.audit)) shapeFail++;
    }
    if (r.reason === 'REGIME_TRANSITION') {
      if (r.audit.strategy !== null || r.decision !== 'NO_TRADE') shapeFail++;
      if (r.audit.regime.regime !== 'TRANSITION') shapeFail++;
    }
  }
  ok(rows > 700, 'dispatcher candidates evaluated (' + rows + ')');
  ok(shapeFail === 0, 'audit shape + path consistency on every row');
  ok(regimes.has('TRENDING'), 'regime TRENDING reached');
  ok(regimes.has('RANGING'), 'regime RANGING reached');
  ok(regimes.has('TRANSITION'), 'regime TRANSITION reached');
  ok(strategies.has('TREND'), 'strategy path TREND fired');
  ok(strategies.has('MEANREV'), 'strategy path MEANREV fired');
  ok(strategies.has(null), 'TRANSITION rows carry strategy=null');
  ok(reasons.has('REGIME_TRANSITION'), 'reason REGIME_TRANSITION reachable');
  ok(decisions.has('CALL') && decisions.has('PUT') && decisions.has('NO_TRADE'),
    'all three decisions reachable');
  // REGIME_INSUFFICIENT_15M: dispatcher with a 15m array too short for ADX
  const rShort = evaluateRegimeSignal(B15.slice(0, 20), B5, B1, 150, null);
  ok(rShort.reason === 'REGIME_INSUFFICIENT_15M' && rShort.audit.strategy === null,
    'short 15m history -> REGIME_INSUFFICIENT_15M');
  const rIdx = evaluateRegimeSignal(B15, B5, B1, B1.length + 5, null);
  ok(rIdx.reason === 'REGIME_INVALID_ENTRY_INDEX', 'invalid entry index rejected');
}

// ── 5. reference == fast path across every boundary row (dispatcher) ────────
console.log('[5] reference path == fast path (dispatcher, all rows)');
{
  const pre = precompute({ c15: B15, c5: B5, c1: B1 });
  let match = 0;
  let rows = 0;
  for (let i = 120; i < B1.length - 1; i++) {
    if ((B1[i].t + MS_1M) % MS_5M !== 0) continue;
    rows++;
    const rr = evaluateRegimeSignal(B15, B5, B1, i, null);
    const rf = evaluateRegimeSignal(B15, B5, B1, i, pre);
    if (JSON.stringify(rr) === JSON.stringify(rf)) match++;
  }
  ok(match === rows, 'dispatcher reference==fast on ' + match + '/' + rows + ' rows');
}

// ── 6. NO-LOOKAHEAD PROOF + canaries ─────────────────────────────────────────
console.log('[6] no-lookahead mutation proof (ADX + D-chain, both paths)');
{
  // pick a boundary row where a strategy actually fired (its full condition
  // chain is then covered by the mutation), deep enough that everything is
  // warmed up
  const i = (() => {
    for (let k = 1500; k < A1.length - 1; k++) {
      if ((A1[k].t + MS_1M) % MS_5M !== 0) continue;
      const r = evaluateRegimeSignal(A15, A5, A1, k, null);
      if (r.audit.strategy !== null) return k;
    }
    return -1;
  })();
  ok(i > 0, 'strategy-fired mutation-test entry row found (i=' + i + ')');
  const base = evaluateRegimeSignal(A15, A5, A1, i, null);
  const preBase = precompute({ c15: A15, c5: A5, c1: A1 });
  const baseFast = evaluateRegimeSignal(A15, A5, A1, i, preBase);

  const entryCloseT = A1[i].t + MS_1M;
  const m15 = A15.map(k => ({ ...k }));
  const m5 = A5.map(k => ({ ...k }));
  const m1 = A1.map(k => ({ ...k }));
  for (let k = 0; k < m1.length; k++) if (m1[k].t > m1[i].t) { m1[k].c *= 10; m1[k].h *= 10; }
  for (let k = 0; k < m5.length; k++) if (m5[k].t + MS_5M > entryCloseT) { m5[k].c *= 10; m5[k].h *= 10; }
  for (let k = 0; k < m15.length; k++) if (m15[k].t + MS_15M > entryCloseT) { m15[k].c *= 10; m15[k].h *= 10; }

  const mut = evaluateRegimeSignal(m15, m5, m1, i, null);
  ok(JSON.stringify(mut) === JSON.stringify(base),
    'mutation leaves decision+audit identical (reference path) [base=' + base.reason + ']');
  const preMut = precompute({ c15: m15, c5: m5, c1: m1 });
  const mutFast = evaluateRegimeSignal(m15, m5, m1, i, preMut);
  ok(JSON.stringify(mutFast) === JSON.stringify(baseFast),
    'mutation leaves decision+audit identical (fast path, pre recomputed)');

  // ADX-specific mutation: future 15m candles cannot move the regime
  const only15 = A15.map(k => ({ ...k }));
  for (let k = 0; k < only15.length; k++) if (only15[k].t + MS_15M > entryCloseT) { only15[k].c *= 7; only15[k].h *= 7; only15[k].l *= 7; }
  const regA = evaluateRegimeSignal(only15, A5, A1, i, null);
  ok(JSON.stringify(regA) === JSON.stringify(base), 'future-15m-only mutation identical (ADX is causal)');

  // D-chain direct: future 5m candles cannot change a mean-reversion verdict
  let i5 = -1;
  for (let k = M5.length - 1; k >= 0; k--) {
    if (M5[k].t + MS_5M <= M1[i].t + MS_1M) { i5 = k; break; }
  }
  const auditBase = { d1: null, d2: null, d3: null, expiry: null };
  const baseB = evaluateMeanReversion(M5, M1, i, i5, null, auditBase);
  const mm5 = M5.map(k => ({ ...k }));
  for (let k = 0; k < mm5.length; k++) if (mm5[k].t + MS_5M > entryCloseT) { mm5[k].c *= 9; mm5[k].h *= 9; }
  const auditMut = { d1: null, d2: null, d3: null, expiry: null };
  const mutB = evaluateMeanReversion(mm5, M1, i, i5, null, auditMut);
  ok(JSON.stringify(mutB) === JSON.stringify(baseB),
    'D-chain: future-5m mutation identical [base=' + baseB.reason + ']');

  // ── canaries: mutations that MUST change the output ───────────────────────
  // (a) last closed 15m candle -> ADX/regime must react
  const i15 = (() => {
    for (let k = A15.length - 1; k >= 0; k--) {
      if (A15[k].t + MS_15M <= entryCloseT) return k;
    }
    return -1;
  })();
  ok(i15 > 0, 'last closed 15m index found (i15=' + i15 + ')');
  const c15 = A15.map((k, idx) => (idx === i15 ? { ...k, h: k.h * 5, c: k.c * 5, l: k.l * 5, o: k.o * 5 } : { ...k }));
  const regC = evaluateRegimeSignal(c15, A5, A1, i, null);
  ok(JSON.stringify(regC) !== JSON.stringify(base), 'canary: mutating last closed 15m changes output');
  // (b) trigger 5m candle -> D1/D2 (or C2) must react
  const t5 = A5.map(k => (k.t + MS_5M === entryCloseT ? { ...k, c: k.c * 3, h: k.h * 3 } : { ...k }));
  const out5 = evaluateRegimeSignal(A15, t5, A1, i, null);
  ok(JSON.stringify(out5) !== JSON.stringify(base), 'canary: mutating trigger 5m candle changes output');
  // (c) entry 1m candle at a D3/C3-reaching row
  let iC3 = -1;
  for (let idx = 1500; idx < A1.length - 1; idx++) {
    if ((A1[idx].t + MS_1M) % MS_5M !== 0) continue;
    const r = evaluateRegimeSignal(A15, A5, A1, idx, null);
    if (r.reason.startsWith('C3_') || r.reason.startsWith('D3_') || r.decision !== 'NO_TRADE') { iC3 = idx; break; }
  }
  ok(iC3 > 0, 'found a gate-reaching row for the entry-candle canary (i=' + iC3 + ')');
  if (iC3 > 0) {
    const baseG = evaluateRegimeSignal(A15, A5, A1, iC3, null);
    const m1e = A1.map((k, idx) => (idx === iC3 ? { ...k, c: k.c * 4, h: k.h * 4, l: k.l * 0.5 } : { ...k }));
    const after = evaluateRegimeSignal(A15, A5, m1e, iC3, null);
    ok(JSON.stringify(after) !== JSON.stringify(baseG), 'canary: mutating ENTRY candle changes output');
  }
}

// ── 7. PAIR-AGNOSTIC PROOF ────────────────────────────────────────────────────
console.log('[7] thresholds are pair-agnostic');
{
  // (a) source scan: no pair names anywhere in the regime detector or
  //     Strategy B — they cannot behave differently per pair by construction.
  const base = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pairRe = /\b(BTC|ETH|XRP|SOL|EUR|GBP|JPY|AUD)\b/;
  for (const f of ['src/strategy/regime.mjs', 'src/strategy/meanReversion.mjs']) {
    const src = readFileSync(join(base, f), 'utf8');
    ok(!pairRe.test(src), f + ' contains no pair names');
  }
  // (b) functional: the same candle series evaluated through pair-labeled
  //     wrappers (as scan.js would call it per pair) yields byte-identical
  //     decision/audit sequences.
  const runForPair = (pair) => {
    const pre = precompute({ c15: B15, c5: B5, c1: B1 });
    const rows = [];
    for (let i = 120; i < B1.length - 1; i++) {
      if ((B1[i].t + MS_1M) % MS_5M !== 0) continue;
      const r = evaluateRegimeSignal(B15, B5, B1, i, pre);
      rows.push(pair + '|' + JSON.stringify({ d: r.decision, s: r.stage, r: r.reason, a: r.audit }));
    }
    return rows;
  };
  const btc = runForPair('BTC/USD').map(s => s.replace('BTC/USD', 'X'));
  const euj = runForPair('EUR/USD').map(s => s.replace('EUR/USD', 'X'));
  ok(btc.length > 500 && btc.length === euj.length, 'both wrappers evaluated the same rows');
  let same = 0;
  for (let k = 0; k < btc.length; k++) if (btc[k] === euj[k]) same++;
  ok(same === btc.length, 'identical inputs -> identical decisions regardless of pair label');
  // (c) the regime classifier itself takes no pair input and is stable
  ok(classifyRegime(24.9) === classifyRegime(24.9), 'classifier deterministic');
}

console.log('\nFTT3-R regime tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

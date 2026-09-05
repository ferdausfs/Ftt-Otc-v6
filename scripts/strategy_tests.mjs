/**
 * FTT3 strategy test suite.
 *   1. Indicator math against hand-computed fixtures.
 *   2. Engine condition chain: strict C1 -> C2 -> C3 ordering, every blocking
 *      reason reachable, expiry tiers at exact percentile boundaries.
 *   3. Reference path == fast (precomputed) path, index-for-index.
 *   4. NO-LOOKAHEAD PROOF: mutating any candle that is not fully closed
 *      before the entry candle's close time cannot change the decision,
 *      the audit, or the expiry — on BOTH value paths (the fast path is
 *      recomputed over the mutated arrays, proving causal series).
 *   5. Leakage canary: mutating the last-closed candles DOES change values,
 *      proving this suite can detect leakage if it ever appears.
 *
 * Run: node scripts/strategy_tests.mjs
 */
import {
  ema, macd, atr, trueRange, median, percentileRank,
} from '../src/strategy/indicators.mjs';
import {
  evaluateSignal, precompute, expiryForPercentile,
  EMA_FAST, EMA_SLOW, ATR_WINDOW, MS_1M, MS_5M, MS_15M,
} from '../src/strategy/engine.mjs';

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

// ── 1. indicators ────────────────────────────────────────────────────────────
console.log('[1] indicator fixtures');
{
  const e = ema([2, 4, 6, 8, 10], 3);
  eq(e[2], 4, 'EMA seed = SMA');
  eq(e[3], 6, 'EMA step k=0.5 (idx3)');
  eq(e[4], 8, 'EMA step k=0.5 (idx4)');
  ok(e[0] === undefined && e[1] === undefined, 'EMA undefined before seed');
}
{
  const tr = trueRange([
    { o: 1, h: 4, l: 1, c: 2 }, { o: 2, h: 5, l: 2, c: 3 },
    { o: 3, h: 6, l: 3, c: 4 }, { o: 4, h: 20, l: 4, c: 5 }, { o: 5, h: 6, l: 5, c: 6 },
  ]);
  eq(tr[0], 3, 'TR0 = high-low');
  eq(tr[3], 16, 'TR gap bar');
  const a = atr([
    { o: 1, h: 4, l: 1, c: 2 }, { o: 2, h: 5, l: 2, c: 3 },
    { o: 3, h: 6, l: 3, c: 4 }, { o: 4, h: 20, l: 4, c: 5 }, { o: 5, h: 6, l: 5, c: 6 },
  ], 3);
  eq(a[2], 3, 'ATR seed = mean TR');
  eq(a[3], 22 / 3, 'ATR Wilder step 1');
  eq(a[4], (22 / 3 * 2 + 1) / 3, 'ATR Wilder step 2');
}
{
  const v = Array.from({ length: 40 }, (_, k) => k + 1);
  const m = macd(v, 12, 26, 9);
  ok(m.line[25] !== undefined && m.line[24] === undefined, 'MACD line valid from slow-1');
  eq(m.line[25], (ema(v, 12))[25] - (ema(v, 26))[25], 'MACD line = EMA12-EMA26');
  const lineCompact = m.line.slice(25, 34);
  const sigRef = ema(lineCompact, 9);
  eq(m.signal[33], sigRef[8], 'MACD signal = EMA9 of line');
}
{
  eq(median([1, 2, 3, 4]), 2.5, 'median even');
  eq(median([1, 2, 3]), 2, 'median odd');
  eq(percentileRank([1, 2, 3, 4, 5], 3), 60, 'pct rank <= semantics');
  eq(percentileRank([1, 2, 3, 4, 5], 3.5), 60, 'pct rank strictly-below values');
  eq(percentileRank([1, 2, 3, 4, 5], 0), 0, 'pct rank floor');
}

// ── 2. expiry tiers ──────────────────────────────────────────────────────────
console.log('[2] expiry tiers (fixed before backtest)');
eq(expiryForPercentile(100), 5, 'pct 100 -> 5m');
eq(expiryForPercentile(75), 5, 'pct exactly 75 -> 5m');
eq(expiryForPercentile(74.999), 7, 'pct just under 75 -> 7m');
eq(expiryForPercentile(50), 7, 'pct 50 -> 7m');
eq(expiryForPercentile(25), 7, 'pct exactly 25 -> 7m');
eq(expiryForPercentile(24.999), 10, 'pct just under 25 -> 10m');
eq(expiryForPercentile(0), 10, 'pct 0 -> 10m');

// ── synthetic series (seeded, deterministic) ────────────────────────────────
const T0 = Date.UTC(2026, 0, 1); // aligned to 15m boundary
function gen1m(seed, n) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let price = 100;
  const out = [];
  for (let k = 0; k < n; k++) {
    // Oscillating drift produces real trend reversals -> MACD crosses fire in
    // both directions and C2_WRONG_DIRECTION is reachable. Quiet/normal/burst
    // vol regimes make C3 both block and pass.
    const vol = k < n / 3 ? 0.02 : k < (2 * n) / 3 ? 0.06 : 0.25;
    const amp = k < n / 3 ? 0.0 : k < (2 * n) / 3 ? 0.08 : 0.22;
    const drift = amp * Math.sin(k / 45);
    const o = price;
    const c = Math.max(0.01, o + drift + (rand() - 0.5) * 2 * vol);
    const h = Math.max(o, c) + rand() * vol;
    const l = Math.min(o, c) - rand() * vol;
    out.push({ t: T0 + k * MS_1M, o, h, l, c });
    price = c;
  }
  return out;
}
function aggregate(m1, factor, tfMs) {
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
const C1 = gen1m(42, 6000);
const C5 = aggregate(C1, 5, MS_5M);
const C15 = aggregate(C1, 15, MS_15M);
ok(C5.length > 100 && C15.length > 60, 'aggregated 5m/15m series built');

// ── 3. chain ordering + reachable reasons + reference/fast equivalence ─────
console.log('[3] condition chain on synthetic series');
let nestedPass = 0; let nestedFail = 0;
function ok2(cond, name) { if (cond) { nestedPass++; } else { nestedFail++; console.error('  FAIL ' + name); } }
{
  const pre = precompute({ c15: C15, c5: C5, c1: C1 });
  const seen = new Set();
  const decisions = new Set();
  let checkedFast = 0;
  let boundary = 0;
  for (let i = 120; i < C1.length - 1; i++) {   // from 120: early rows hit C1_INSUFFICIENT_15M
    if ((C1[i].t + MS_1M) % MS_5M !== 0) continue;
    boundary++;
    const r = evaluateSignal(C15, C5, C1, i);
    seen.add(r.reason);
    decisions.add(r.decision);
    // strict ordering: a C2 block must carry C1 audit values, a C3 block both
    if (r.reason.startsWith('C2_')) ok2(r.audit.c1 !== null, 'C2 block carries C1 values @' + i);
    if (r.reason.startsWith('C3_')) {
      ok2(r.audit.c1 !== null && r.audit.c2 !== null, 'C3 block carries C1+C2 values @' + i);
    }
    if (r.decision === 'CALL' || r.decision === 'PUT') {
      ok2(r.audit.expiry && [5, 7, 10].includes(r.audit.expiry.minutes),
        'signal carries expiry tier @' + i);
      ok2(r.reason === 'C1_C2_C3_ALL_PASS', 'signal reason ALL_PASS @' + i);
    }
    // equivalence with the fast path
    const rf = evaluateSignal(C15, C5, C1, i, pre);
    if (JSON.stringify(rf) === JSON.stringify(r)) checkedFast++;
    else ok2(false, 'fast path mismatch @' + i + ' ' + r.reason + ' vs ' + rf.reason);
  }
  ok(boundary > 500, 'enough 5m-boundary candidates evaluated (' + boundary + ')');
  ok(checkedFast === boundary, 'reference == fast path on every candidate');
  for (const want of ['CALL', 'PUT']) {
    ok(decisions.has(want), 'decision reachable: ' + want);
  }
  for (const want of ['C1_INSUFFICIENT_15M', 'C2_NO_CROSS', 'C2_WRONG_DIRECTION',
    'C3_LOW_VOLATILITY', 'C1_C2_C3_ALL_PASS']) {
    ok(seen.has(want), 'reason reachable: ' + want + (seen.has(want) ? '' : ' (seen: ' + [...seen].join(',') + ')'));
  }
}

// C1 exact equality -> NO_TRADE (needs >=50 closed 15m candles of flat closes:
// first boundary index with 50 closed 15m bars is i = 759)
{
  const flat = Array.from({ length: 80 }, (_, k) => ({ t: T0 + k * MS_15M, o: 5, h: 5, l: 5, c: 5 }));
  const iFlat = C1.findIndex(k => k.t >= T0 + 760 * MS_1M && (k.t + MS_1M) % MS_5M === 0);
  const r = evaluateSignal(flat, C5, C1, iFlat);
  ok(r.reason === 'C1_TREND_UNDEFINED', 'flat 15m -> C1_TREND_UNDEFINED (i=' + iFlat + ', got ' + r.reason + ')');
}
// NOT_5M_BOUNDARY
{
  const iOff = C1.findIndex(k => (k.t + MS_1M) % MS_5M !== 0 && k.t >= T0 + 1000 * MS_1M);
  const r = evaluateSignal(C15, C5, C1, iOff);
  ok(r.reason === 'NOT_5M_BOUNDARY', 'off-boundary 1m -> NOT_5M_BOUNDARY');
}

// ── 4. NO-LOOKAHEAD PROOF ────────────────────────────────────────────────────
console.log('[4] no-lookahead mutation proof');
{
  const i = C1.findIndex((k, idx) => idx > 1200 && (k.t + MS_1M) % MS_5M === 0);
  const base = evaluateSignal(C15, C5, C1, i);
  const preBase = precompute({ c15: C15, c5: C5, c1: C1 });
  const baseFast = evaluateSignal(C15, C5, C1, i, preBase);

  // Mutate everything NOT fully closed before entry close time:
  const m15 = C15.map(k => ({ ...k }));
  const m5 = C5.map(k => ({ ...k }));
  const m1 = C1.map(k => ({ ...k }));
  const entryCloseT = m1[i].t + MS_1M;
  for (let k = 0; k < m1.length; k++) if (m1[k].t > m1[i].t) { m1[k].c *= 10; m1[k].h *= 10; }
  for (let k = 0; k < m5.length; k++) if (m5[k].t + MS_5M > entryCloseT) { m5[k].c *= 10; m5[k].h *= 10; }
  for (let k = 0; k < m15.length; k++) if (m15[k].t + MS_15M > entryCloseT) { m15[k].c *= 10; m15[k].h *= 10; }

  const mut = evaluateSignal(m15, m5, m1, i);
  ok(JSON.stringify(mut) === JSON.stringify(base),
    'mutation leaves decision+audit identical (reference path) [base=' + base.reason + ']');

  // Fast path over the mutated arrays: causal series must give the same values
  const preMut = precompute({ c15: m15, c5: m5, c1: m1 });
  const mutFast = evaluateSignal(m15, m5, m1, i, preMut);
  ok(JSON.stringify(mutFast) === JSON.stringify(baseFast),
    'mutation leaves decision+audit identical (fast path, pre recomputed)');

  // partial mutation of the 1m tail only (the most tempting leak)
  const m1b = C1.map((k, idx) => (idx > i ? { ...k, c: 9999, h: 9999, l: 9998, o: 9999 } : { ...k }));
  const mutB = evaluateSignal(C15, C5, m1b, i);
  ok(JSON.stringify(mutB) === JSON.stringify(base), '1m future-tail mutation identical');
}
// ── 5. leakage canary ────────────────────────────────────────────────────────
console.log('[5] leakage canary');
{
  // Canaries must target rows whose evaluation actually READS the mutated
  // candle: entry-candle mutation is only observable when the chain reaches
  // C3, so find a C3-reaching row first (C3 block or a signal).
  let iC3 = -1;
  for (let idx = 1200; idx < C1.length - 1; idx++) {
    if ((C1[idx].t + MS_1M) % MS_5M !== 0) continue;
    const r = evaluateSignal(C15, C5, C1, idx);
    if (r.reason.startsWith('C3_') || r.decision !== 'NO_TRADE') { iC3 = idx; break; }
  }
  ok(iC3 > 0, 'found a C3-reaching row for the entry-candle canary (i=' + iC3 + ')');
  if (iC3 > 0) {
    const base = evaluateSignal(C15, C5, C1, iC3);
    const m1 = C1.map((k, idx) => (idx === iC3 ? { ...k, c: k.c * 3, h: k.h * 3, l: k.l } : { ...k }));
    const after = evaluateSignal(C15, C5, m1, iC3);
    ok(JSON.stringify(after) !== JSON.stringify(base),
      'mutating the ENTRY candle changes output (canary detects leakage)');
  }
  const m5 = C5.map(k => ({ ...k }));
  if (iC3 > 0) {
    const baseC3 = evaluateSignal(C15, C5, C1, iC3);
    const i5 = m5.findIndex(k => k.t + MS_5M === C1[iC3].t + MS_1M);
    if (i5 > 35) {
      m5[i5] = { ...m5[i5], c: m5[i5].c * 2, h: m5[i5].h * 2 };
      const after5 = evaluateSignal(C15, m5, C1, iC3);
      ok(JSON.stringify(after5) !== JSON.stringify(baseC3), 'mutating last closed 5m changes output (canary)');
    }
  }
}

console.log('\nFTT3 strategy tests: ' + pass + ' passed (+' + nestedPass + ' per-row checks), ' + (fail + nestedFail) + ' failed');
if (fail + nestedFail > 0) process.exit(1);

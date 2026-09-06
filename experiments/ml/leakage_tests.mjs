/**
 * TASK 24 — ML FEASIBILITY: leakage / no-lookahead proof suite.
 * Must be 100% green BEFORE build_features runs on real data and before any
 * modeling. Same philosophy as scripts/strategy_tests.mjs (42 checks) and
 * scripts/ema_ribbon_tests.mjs (100 checks): proofs, not assumptions.
 *
 *  1.  RSI fixture (longhand independent arithmetic) + Wilder conventions
 *  2.  Bollinger closed-form fixture (population std)
 *  3.  meanStdPrefix vs independent direct loop
 *  4.  findClosed15 boundary-exact alignment (close == decision instant ok; +1ms not)
 *  5.  labelAt up/down/tie/missing
 *  6.  featureRow FUTURE-MUTATION INVARIANCE (the core no-lookahead proof)
 *  7.  featureRow TRUNCATED-RECOMPUTE EQUALITY (no global normalization leakage)
 *  8.  featureRow current-candle sensitivity (canary against frozen rows)
 *  9.  label changes when the future changes; features do not
 *  10. split_dates.json fold integrity + purge >= label window + test disjoint
 *  11. feature count/shape sanity
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FEATURE_NAMES, N_FEATURES, rsiWilder, bollinger, meanStdPrefix, prefixSum, prefixSum2,
  findClosed15, labelAt, fundAsOf, featureRow, buildSeries,
} from './features_lib.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL: ${name}`); }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// deterministic pseudo-random series (seeded LCG — no Math.random nondeterminism)
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
function synthMinute(n, t0, seed) {
  const rnd = lcg(seed);
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const ret = (rnd() - 0.5) * 0.002;
    const open = price;
    const close = open * (1 + ret);
    const hi = Math.max(open, close) * (1 + rnd() * 0.0005);
    const lo = Math.min(open, close) * (1 - rnd() * 0.0005);
    t.push(t0 + i * 60000); o.push(open); h.push(hi); l.push(lo); c.push(close);
    v.push(10 + rnd() * 100);
    price = close;
  }
  return { t, o, h, l, c, v };
}
function synth15(m1, seed) {
  void seed;
  const t = [], o = [], h = [], l = [], c = [], v = [];
  // aggregate from the 1m series (15m candles aligned to m1 grid)
  for (let i = 0; i + 15 <= m1.t.length; i += 15) {
    let hi = -Infinity, lo = Infinity, vv = 0;
    for (let k = i; k < i + 15; k++) { hi = Math.max(hi, m1.h[k]); lo = Math.min(lo, m1.l[k]); vv += m1.v[k]; }
    t.push(m1.t[i]); o.push(m1.o[i]); h.push(hi); l.push(lo); c.push(m1.c[i + 14]); v.push(vv);
  }
  return { t, o, h, l, c, v };
}

console.log('1. RSI fixture (longhand independent arithmetic)');
{
  const closes = [10, 10.5, 10.2, 10.8, 11.0, 10.9, 11.2, 11.0, 10.7, 11.3, 11.5, 11.1, 11.4, 11.6, 11.8, 11.5, 11.9];
  // diffs d1..d16:  +.5 -.2 +.6 +.2 -.1 +.3 -.2 -.3 +.6 +.2 -.4 +.3 +.2 +.2 -.3 +.4
  // seed (d1..d14): gains .5+.6+.2+.3+.6+.2+.3+.2+.2 = 3.1 -> wait: recompute longhand below
  const d = [];
  for (let i = 1; i < closes.length; i++) d.push(closes[i] - closes[i - 1]);
  // independent seed + 2 Wilder steps, written out, period 14
  let g = 0, l = 0;
  for (let i = 0; i < 14; i++) { if (d[i] > 0) g += d[i]; else l -= d[i]; }
  let ag = g / 14, al = l / 14;
  const rsiSeed = 100 - 100 / (1 + ag / al);
  const r = rsiWilder(closes, 14);
  check('rsi seed index 14 matches longhand', approx(r[14], rsiSeed, 1e-12));
  const step = (ag, al, dd) => [(ag * 13 + Math.max(dd, 0)) / 14, (al * 13 + Math.max(-dd, 0)) / 14];
  let [ag2, al2] = step(ag, al, d[14]);
  check('rsi index 15 matches longhand step', approx(r[15], 100 - 100 / (1 + ag2 / al2), 1e-12));
  let [ag3, al3] = step(ag2, al2, d[15]);
  check('rsi index 16 matches longhand step', approx(r[16], 100 - 100 / (1 + ag3 / al3), 1e-12));
  check('rsi undefined before seed', r[13] === undefined && r[0] === undefined);
  const flat = rsiWilder(new Array(20).fill(5), 14);
  check('rsi flat series -> 100 (avgLoss=0 convention)', flat[19] === 100);
  const pureDown = rsiWilder([5, 4.9, 4.8, 4.7, 4.6, 4.5, 4.4, 4.3, 4.2, 4.1, 4.0, 3.9, 3.8, 3.7, 3.6], 14);
  check('rsi pure down -> 0', pureDown[14] === 0);
  // causality: changing a later close cannot change earlier RSI
  const mutated = closes.slice(); mutated[16] = 99;
  const r2 = rsiWilder(mutated, 14);
  check('rsi causal (future close change leaves r[14] fixed)', r2[14] === r[14] && r2[15] === r[15] && r2[16] !== r[16]);
}

console.log('2. Bollinger closed-form fixture');
{
  const closes = Array.from({ length: 25 }, (_, k) => k + 1); // 1..25
  const { up, lo } = bollinger(closes, 20, 2);
  // window 1..20 at i=19: mean 10.5; variance of 1..n = (n^2-1)/12 = 33.25
  const std = Math.sqrt(33.25);
  check('bb up closed form', approx(up[19], 10.5 + 2 * std, 1e-12));
  check('bb lo closed form', approx(lo[19], 10.5 - 2 * std, 1e-12));
  check('bb undefined before period-1', up[18] === undefined);
  const flatBB = bollinger(new Array(25).fill(7), 20, 2);
  check('bb flat -> up==lo==7', flatBB.up[24] === 7 && flatBB.lo[24] === 7);
}

console.log('3. meanStdPrefix vs direct loop');
{
  const rnd = lcg(42);
  const a = Array.from({ length: 500 }, () => rnd() * 10 - 5);
  const s = prefixSum(a), s2 = prefixSum2(a);
  let ok = true;
  for (let k = 0; k < 50; k++) {
    const from = Math.floor(rnd() * 400), to = from + 20 + Math.floor(rnd() * 79);
    let sum = 0, sum2 = 0, n = 0;
    for (let i = from; i <= to; i++) { sum += a[i]; sum2 += a[i] * a[i]; n++; }
    const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const { mean: m2, std: s3 } = meanStdPrefix(s, s2, from, to);
    if (!approx(m2, mean, 1e-9) || !approx(s3, std, 1e-9)) { ok = false; break; }
  }
  check('prefix mean/std identical to direct loop on 50 random windows', ok);
}

console.log('4. findClosed15 alignment (decision instant = t+60s; 15m close = T+15m)');
{
  const t0 = Date.UTC(2024, 0, 1);
  const m15t = [];
  for (let k = 0; k < 100; k++) m15t.push(t0 + k * 900000);
  // 15m candle opening at T closes at T+900000.
  // Decision at 1m open t uses 15m candles with T+900000 <= t+60000.
  const t = t0 + 14 * 60000;   // decision instant 00:15:00 == 15m candle T=00:00 close
  check('exact-boundary: 15m candle closing EXACTLY at the decision instant IS valid',
    findClosed15(m15t, t) === 0 && m15t[0] + 900000 === t + 60000);
  const t2 = t0 + 44 * 60000;  // decision instant 00:45; T=00:30 closes 00:45 -> valid
  check('t=00:44: T=00:30 (closes exactly at the decision instant) is the context candle',
    findClosed15(m15t, t2) === 2);
  const t3 = t0 + 43 * 60000;                      // 00:43 -> decision instant 00:44; T=00:30 closes 00:45 > 00:44 invalid
  check('t=00:43: candle closing 1 minute later is excluded', findClosed15(m15t, t3) === 1);
  const t4 = t0 - 3600000;
  check('no closed candle before history -> -1', findClosed15(m15t, t4) === -1);
}

console.log('5. labelAt conventions');
{
  const t0 = Date.UTC(2024, 0, 1);
  const n = 30;
  const t = Array.from({ length: n }, (_, k) => t0 + k * 60000);
  const c = new Array(n).fill(100);
  c[10] = 101; c[15] = 100.5; c[20] = 99;
  // i=0: close[5]=100 == close[0]=100 -> tie
  check('tie -> 2', labelAt(t, c, 0, 5) === 2);
  c[5] = 100.7;  // now close[5] > close[0]
  check('up -> 1', labelAt(t, c, 0, 5) === 1);
  // i=10, H=10: close[20]=99 < close[10]=101 -> down
  check('down -> 0', labelAt(t, c, 10, 10) === 0);
  check('missing target candle -> -1 (never fabricated)', labelAt(t, c, 25, 10) === -1);
}

// ── shared synthetic universe for row proofs ─────────────────────────────────
const T0 = Date.UTC(2021, 10, 1);
const m1 = synthMinute(3000, T0, 7);
const m15 = synth15(m1, 11);
const fundT = [], fundRate = [];
for (let k = 0; k < Math.floor(3000 / 480); k++) {
  fundT.push(T0 + k * 480 * 60000);
  fundRate.push(0.0001 * Math.sin(k / 5));
}
const S = buildSeries(m1, m15, fundT, fundRate);

function rowFor(i) {
  const t = S.m1t[i];
  const j15 = findClosed15(S.m15t, t);
  const fi = fundAsOf(S.fundT, t + 60000);
  return { row: featureRow(S, i, j15, fi, 2), t, j15, fi };
}

console.log('6. featureRow FUTURE-MUTATION INVARIANCE (core no-lookahead proof)');
{
  const i = 2500;
  const before = rowFor(i);
  check('baseline row valid', before.row !== null);
  // mutate EVERY candle opening strictly after the decision candle t
  const m1b = { t: m1.t.slice(), o: m1.o.slice(), h: m1.h.slice(), l: m1.l.slice(), c: m1.c.slice(), v: m1.v.slice() };
  for (let j = i + 1; j < m1b.t.length; j++) {
    m1b.c[j] *= 1.5; m1b.h[j] *= 1.7; m1b.l[j] *= 0.6; m1b.v[j] *= 3.3; m1b.o[j] *= 1.4;
  }
  const S2 = buildSeries(m1b, m15, fundT, fundRate);
  const j15b = findClosed15(S2.m15t, before.t);
  const fib = fundAsOf(S2.fundT, before.t + 60000);
  const after = featureRow(S2, i, j15b, fib, 2);
  let identical = after !== null && before.row.length === after.length;
  if (identical) for (let k = 0; k < before.row.length; k++) if (before.row[k] !== after[k]) { identical = false; break; }
  check('mutating ALL future 1m candles (OHLCV x1.5/1.7/0.6/3.3) leaves the row bit-identical', identical);
  // also mutate future 15m candles (those closing after the decision instant)
  const m15b = { t: m15.t.slice(), o: m15.o.slice(), h: m15.h.slice(), l: m15.l.slice(), c: m15.c.slice(), v: m15.v.slice() };
  for (let j = 0; j < m15b.t.length; j++) {
    if (m15b.t[j] + 900000 > before.t + 60000) { m15b.c[j] *= 2; m15b.h[j] *= 2; m15b.l[j] *= 2; m15b.v[j] *= 2; m15b.o[j] *= 2; }
  }
  const S3 = buildSeries(m1, m15b, fundT, fundRate);
  const j15c = findClosed15(S3.m15t, before.t);
  check('mutating all 15m candles closing after the decision instant leaves the row bit-identical',
    j15c === before.j15 && (() => {
      const after3 = featureRow(S3, i, j15c, before.fi, 2);
      for (let k = 0; k < before.row.length; k++) if (before.row[k] !== after3[k]) return false;
      return true;
    })());
  // and future funding events
  const fbT = fundT.slice(), fbR = fundRate.slice();
  for (let j = 0; j < fbT.length; j++) if (fbT[j] > before.t + 60000) fbR[j] = 0.05;
  const S4 = buildSeries(m1, m15, fbT, fbR);
  const fi4 = fundAsOf(S4.fundT, before.t + 60000);
  const after4 = featureRow(S4, i, before.j15, fi4, 2);
  let id4 = after4 !== null;
  if (id4) for (let k = 0; k < before.row.length; k++) if (before.row[k] !== after4[k]) { id4 = false; break; }
  check('mutating all future funding rates leaves the row bit-identical', id4);
}

console.log('7. featureRow TRUNCATED-RECOMPUTE EQUALITY');
{
  const i = 2500;
  const before = rowFor(i);
  const cut1 = { t: m1.t.slice(0, i + 1), o: m1.o.slice(0, i + 1), h: m1.h.slice(0, i + 1), l: m1.l.slice(0, i + 1), c: m1.c.slice(0, i + 1), v: m1.v.slice(0, i + 1) };
  const keep15 = before.j15 + 1;
  const cut15 = { t: m15.t.slice(0, keep15), o: m15.o.slice(0, keep15), h: m15.h.slice(0, keep15), l: m15.l.slice(0, keep15), c: m15.c.slice(0, keep15), v: m15.v.slice(0, keep15) };
  const keepF = before.fi + 1;
  const S5 = buildSeries(cut1, cut15, fundT.slice(0, keepF), fundRate.slice(0, keepF));
  const after = featureRow(S5, i, before.j15, before.fi, 2);
  let identical = after !== null;
  if (identical) for (let k = 0; k < before.row.length; k++) if (before.row[k] !== after[k]) { identical = false; break; }
  check('row from truncated-to-decision-instant data is bit-identical to full-batch row', identical);
}

console.log('8. featureRow current-candle sensitivity (canary against frozen rows)');
{
  const i = 2500;
  const before = rowFor(i);
  const m1b = { t: m1.t.slice(), o: m1.o.slice(), h: m1.h.slice(), l: m1.l.slice(), c: m1.c.slice(), v: m1.v.slice() };
  m1b.c[i] *= 1.01;  // mutate the CURRENT candle close
  const S6 = buildSeries(m1b, m15, fundT, fundRate);
  const after = featureRow(S6, i, before.j15, before.fi, 2);
  let changed = false;
  for (let k = 0; k < before.row.length; k++) if (before.row[k] !== after[k]) { changed = true; break; }
  check('mutating the CURRENT candle close DOES change the row (rows are alive)', changed);
}

console.log('9. labels move with the future; features do not');
{
  const i = 2500;
  check('label at i, H=5 is defined on synthetic grid', [0, 1, 2].includes(labelAt(S.m1t, S.m1c, i, 5)));
  const cB = S.m1c.slice();
  const lblBefore = labelAt(S.m1t, cB, i, 5);
  cB[i + 5] = cB[i] * (lblBefore === 1 ? 0.9 : 1.1);
  const lblAfter = labelAt(S.m1t, cB, i, 5);
  check('flipping the future close flips the label', lblBefore !== lblAfter && lblAfter !== 2);
}

console.log('10. split_dates.json fold integrity');
{
  const sp = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'split_dates.json'), 'utf8'));
  const ms = (s) => Date.parse(s.replace('Z', '+00:00'));
  check('train+val+test minutes sum to total', sp.train.minutes + sp.validation.minutes + sp.test.minutes === sp.minutes_total);
  check('fracs are 70/15/15', sp.train.frac === 0.70 && sp.validation.frac === 0.15 && sp.test.frac === 0.15);
  check('test start == validation end (test disjoint from trainval)',
    ms(sp.test.start) === ms(sp.validation.end) && ms(sp.test.end) === ms(sp.T1));
  check('test end == T1', ms(sp.test.end) === ms(sp.T1));
  const folds = sp.walk_forward_folds_within_trainval;
  let foldsOk = folds.length === 5;
  for (let k = 0; k < folds.length && foldsOk; k++) {
    if (ms(folds[k].val_end) <= ms(folds[k].val_start)) foldsOk = false;
    if (k > 0 && ms(folds[k].val_start) !== ms(folds[k - 1].val_end)) foldsOk = false;
  }
  check('5 contiguous chronological folds', foldsOk);
  check('purge (60m) >= longest label window (10m)', sp.purge_minutes_between_folds >= Math.max(...sp.label_windows_minutes));
  check('first fold val block starts after the initial train block (walk-forward, amended shape)',
    ms(folds[0].val_start) === ms(sp.T0) + sp.walk_forward_initial_train_minutes * 60000);
  check('last fold ends at validation end (test never in CV)',
    ms(folds[folds.length - 1].val_end) === ms(sp.validation.end));
}

console.log('11. feature shape sanity');
{
  check('41 features declared', N_FEATURES === 41 && FEATURE_NAMES.length === 41);
  const { row } = rowFor(2500);
  check('row length matches', row.length === N_FEATURES);
  let noNan = true;
  for (const v of row) if (!Number.isFinite(v)) noNan = false;
  check('synthetic row has no NaN/Inf (fail-loud path verified elsewhere)', noNan);
  check('utc hour/dow are integers in range', Number.isInteger(row[38]) && row[38] >= 0 && row[38] <= 23 && Number.isInteger(row[39]) && row[39] >= 0 && row[39] <= 6);
}

console.log(`\nleakage_tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

/**
 * FRVP fade + triple-barrier — test suite.
 *
 * Layers:
 *   1. Python fixture cross-check (independent implementation — any
 *      disagreement is a bug in one of the two).
 *   2. allocCandleVolume unit checks (sum invariant, edges, proportions).
 *   3. decideFromProfile unit checks (barrier construction, strict
 *      inequalities, BOTH_PIERCED, POC-degenerate rule).
 *   4. REAL-DATA incremental-vs-reference equality: FrvpProfileState must
 *      produce bit-consistent profiles vs a full buildProfile recompute at
 *      EVERY decision point of a 30k-candle real BTC slice (tight 1e-9
 *      relative tolerance for FP addition-order drift; lo/hi/poc/vah/val and
 *      every decision must agree).
 *   5. No-lookahead battery: trigger candle excluded from its own profile;
 *      in-window mutations change the profile; state window is exactly the
 *      last 1440 pushed candles; fast path == reference path decisions.
 *   6. Real-data smoke: contiguity, OHLC invariants, first evaluable bar.
 *
 * Run: node scripts/frvp_tests.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildProfile, FrvpProfileState, evaluateFrvpBar, decideFromProfile,
  allocCandleVolume, FRVP_WINDOW_BARS, FRVP_BINS,
} from '../src/strategy/frvpFade.mjs';
import { resolveTripleBarrier } from '../backtest/tripleBarrier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = JSON.parse(readFileSync(join(ROOT, 'scripts', 'frvp_fixtures.json'), 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
function close(a, b, tol = 1e-9) {
  if (a == null || b == null) return a === b;
  return Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
}
function eq(a, b) { return a === b; }

// ═══ 1. Python fixture cross-check: profile ═══════════════════════════════
for (const fx of FX.profile) {
  const p = buildProfile(fx.window, { bins: fx.binsCount, vaPct: fx.vaPct });
  const e = fx.expected;
  if (e.degenerate) {
    check(`pf/${fx.name} degenerate`, p.degenerate === true, `got ${JSON.stringify(p.degenerate)}`);
    continue;
  }
  check(`pf/${fx.name} not-degenerate`, p.degenerate === false);
  check(`pf/${fx.name} lo`, close(p.lo, e.lo), `${p.lo} vs ${e.lo}`);
  check(`pf/${fx.name} hi`, close(p.hi, e.hi), `${p.hi} vs ${e.hi}`);
  check(`pf/${fx.name} width`, close(p.width, e.width), `${p.width} vs ${e.width}`);
  check(`pf/${fx.name} totalVol`, close(p.totalVol, e.totalVol), `${p.totalVol} vs ${e.totalVol}`);
  check(`pf/${fx.name} pocIdx`, eq(p.pocIdx, e.pocIdx), `${p.pocIdx} vs ${e.pocIdx}`);
  check(`pf/${fx.name} pocPrice`, close(p.pocPrice, e.pocPrice), `${p.pocPrice} vs ${e.pocPrice}`);
  check(`pf/${fx.name} vaLoIdx`, eq(p.vaLoIdx, e.vaLoIdx), `${p.vaLoIdx} vs ${e.vaLoIdx}`);
  check(`pf/${fx.name} vaHiIdx`, eq(p.vaHiIdx, e.vaHiIdx), `${p.vaHiIdx} vs ${e.vaHiIdx}`);
  check(`pf/${fx.name} vah`, close(p.vah, e.vah), `${p.vah} vs ${e.vah}`);
  check(`pf/${fx.name} val`, close(p.val, e.val), `${p.val} vs ${e.val}`);
}

// ═══ 1b. Python fixture cross-check: triple barrier ════════════════════════
for (const fx of FX.tripleBarrier) {
  const r = resolveTripleBarrier(fx.candles, fx.candlesAfterEntryIdx, {
    direction: fx.direction, entry: fx.entry, slPrice: fx.sl, tpPrice: fx.tp,
    maxHoldMs: fx.maxHoldMin * 60_000, entryTime: fx.entryCloseT, rAbs: fx.rAbs,
  });
  const e = fx.expected;
  check(`tb/${fx.name} type`, eq(r.type, e.type), `${r.type} vs ${e.type}`);
  check(`tb/${fx.name} exitT`, eq(r.exitT, e.exitT), `${r.exitT} vs ${e.exitT}`);
  check(`tb/${fx.name} exitPrice`, close(r.exitPrice, e.exitPrice), `${r.exitPrice} vs ${e.exitPrice}`);
  check(`tb/${fx.name} slGapFill`, eq(r.slGapFill, e.slGapFill));
  check(`tb/${fx.name} bothTouched`, eq(r.bothTouched, e.bothTouched));
  check(`tb/${fx.name} r`, close(r.r, e.r), `${r.r} vs ${e.r}`);
  check(`tb/${fx.name} rOpen`, close(r.rOpen, e.rOpen), `${r.rOpen} vs ${e.rOpen}`);
  check(`tb/${fx.name} minutesHeld`, eq(r.minutesHeld, e.minutesHeld), `${r.minutesHeld} vs ${e.minutesHeld}`);
}

// ═══ 2. allocCandleVolume unit checks ══════════════════════════════════════
{
  const lo = 100, width = 10, bins = 5;   // bins: [100,110),[110,120),...,[140,140+]
  // one-price candle mid-bin
  let a = allocCandleVolume({ l: 115, h: 115, v: 7 }, lo, width, bins);
  check('alloc/one-price mid', a.length === 1 && a[0][0] === 1 && a[0][1] === 7, JSON.stringify(a));
  // one-price on the LOWER edge of a bin -> that bin
  a = allocCandleVolume({ l: 120, h: 120, v: 3 }, lo, width, bins);
  check('alloc/one-price on edge', a.length === 1 && a[0][0] === 2, JSON.stringify(a));
  // one-price at the very top -> clamped into last bin
  a = allocCandleVolume({ l: 150, h: 150, v: 3 }, lo, width, bins);
  check('alloc/one-price top clamp', a.length === 1 && a[0][0] === 4, JSON.stringify(a));
  // one-price at the very bottom -> bin 0
  a = allocCandleVolume({ l: 100, h: 100, v: 3 }, lo, width, bins);
  check('alloc/one-price bottom', a.length === 1 && a[0][0] === 0, JSON.stringify(a));
  // full-span candle -> proportional halves/edges
  a = allocCandleVolume({ l: 100, h: 150, v: 50 }, lo, width, bins);
  check('alloc/full-span 5 bins', a.length === 5, JSON.stringify(a));
  check('alloc/full-span sum=v', Math.abs(a.reduce((s, x) => s + x[1], 0) - 50) < 1e-9);
  check('alloc/full-span each=10', a.every(x => Math.abs(x[1] - 10) < 1e-9));
  // partial span across two bins, uneven split 75/25
  a = allocCandleVolume({ l: 107.5, h: 120, v: 4 }, lo, width, bins);
  // [107.5,110) len 2.5 in bin0; [110,120) len 10 in bin1 -> 2.5:10 = 0.769:3.077
  check('alloc/uneven split', a.length === 2 && close(a[0][1], 4 * 2.5 / 12.5) && close(a[1][1], 4 * 10 / 12.5), JSON.stringify(a));
  // zero volume -> no contribution
  a = allocCandleVolume({ l: 105, h: 118, v: 0 }, lo, width, bins);
  check('alloc/zero-vol', a.length === 0, JSON.stringify(a));
  // sum invariant under random candles
  let okSum = true;
  for (let t = 0; t < 500; t++) {
    const l = 100 + Math.random() * 50, h = l + Math.random() * 10;
    const v = Math.random() * 100;
    const arr = allocCandleVolume({ l, h, v }, 90, 7, 11);
    const s = arr.reduce((s2, x) => s2 + x[1], 0);
    if (Math.abs(s - v) > 1e-9 * Math.max(1, v)) { okSum = false; break; }
    if (arr.some(x => x[0] < 0 || x[0] > 10)) { okSum = false; break; }
  }
  check('alloc/random sum-invariant + bin range', okSum);
}

// ═══ 3. decideFromProfile unit checks (fixture 'basic' profile) ════════════
{
  const w = FX.profile.find(f => f.name === 'basic_poc_bin2_va_richer_neighbor');
  const p = buildProfile(w.window, { bins: 4, vaPct: 0.70 });
  // p: vah=185, val=128.75, poc=156.875
  const M = 60_000, T0 = 1_700_000_000_000;

  // strict inequality: high exactly == VAH is NOT a pierce
  let d = decideFromProfile(p, { t: T0, o: 150, h: 185, l: 149, c: 160 });
  check('trig/high==VAH no trigger', d.decision === 'NO_TRADE', d.reason);
  // just above VAH + close back inside -> PUT
  d = decideFromProfile(p, { t: T0, o: 150, h: 185.0001, l: 149, c: 160 });
  check('trig/PUT strict pierce', d.decision === 'PUT', d.reason);
  check('trig/PUT SL = high + 0.1*range', close(d.sl, 185.0001 + 0.1 * (185.0001 - 149)));
  check('trig/PUT rAbs = sl - entry', close(d.rAbs, d.sl - 160));
  check('trig/PUT tp15 = entry - 1.5R', close(d.tp15, 160 - 1.5 * d.rAbs));
  check('trig/PUT tp3 = entry - 3R', close(d.tp3, 160 - 3 * d.rAbs));
  check('trig/PUT tpPoc = POC (below entry)', close(d.tpPoc, 156.875) && !d.pocDegenerate);
  // PUT with entry BELOW the POC -> degenerate classic target
  d = decideFromProfile(p, { t: T0 + M, o: 150, h: 185.0001, l: 140, c: 150 });
  check('trig/PUT poc-degenerate when POC >= entry', d.pocDegenerate === true && d.tpPoc === null, `${d.pocDegenerate}`);
  // close exactly AT VAH is not a rejection
  d = decideFromProfile(p, { t: T0, o: 150, h: 190, l: 149, c: 185 });
  check('trig/close==VAH no reject', d.decision === 'NO_TRADE' && d.reason === 'PIERCE_NO_REJECT', d.reason);
  // CALL mirror: low strictly below VAL, close back above
  d = decideFromProfile(p, { t: T0, o: 140, h: 150, l: 128.7499, c: 140 });
  check('trig/CALL strict pierce', d.decision === 'CALL', d.reason);
  check('trig/CALL SL = low - 0.1*range', close(d.sl, 128.7499 - 0.1 * (150 - 128.7499)));
  check('trig/CALL tp15 = entry + 1.5R', close(d.tp15, 140 + 1.5 * d.rAbs));
  check('trig/CALL tpPoc = POC (above entry)', close(d.tpPoc, 156.875) && !d.pocDegenerate);
  // low exactly == VAL is not a pierce
  d = decideFromProfile(p, { t: T0, o: 140, h: 150, l: 128.75, c: 140 });
  check('trig/low==VAL no trigger', d.decision === 'NO_TRADE', d.reason);
  // CALL with entry ABOVE the POC -> degenerate
  d = decideFromProfile(p, { t: T0, o: 150, h: 160, l: 120, c: 160 });
  check('trig/CALL poc-degenerate when POC <= entry', d.pocDegenerate === true && d.tpPoc === null);
  // BOTH_PIERCED wins over both raw conditions
  d = decideFromProfile(p, { t: T0, o: 150, h: 190, l: 120, c: 150 });
  check('trig/both-pierced NO_TRADE', d.decision === 'NO_TRADE' && d.reason === 'BOTH_PIERCED', d.reason);
  // warmup
  check('trig/warmup insufficient', evaluateFrvpBar(w.window.slice(0, 3), w.window[3]).decision === 'NO_TRADE'
    && evaluateFrvpBar(w.window.slice(0, 3), w.window[3]).reason === 'WARMUP_INSUFFICIENT');
}

// ═══ 4+5. REAL-DATA: state==reference equality, no-lookahead, smoke ═══════
const btc = JSON.parse(readFileSync(join(ROOT, 'backtest', 'data', 'ms', 'BTCUSD_1m.json'), 'utf8')).candles;
const N = 30_000;
const cds = btc.slice(0, N);

// smoke: contiguity + OHLC invariants over the slice
{
  let okGap = true, okOhlc = true;
  for (let i = 0; i < N; i++) {
    const c = cds[i];
    if (!(c.h >= c.l && c.h >= c.o - 1e-9 && c.h >= c.c - 1e-9 && c.l <= c.o + 1e-9 && c.l <= c.c + 1e-9 && c.v >= 0)) { okOhlc = false; break; }
    if (i > 0 && cds[i].t - cds[i - 1].t !== 60_000) { okGap = false; break; }
  }
  check('realdata/ohlc invariants (30k)', okOhlc);
  check('realdata/zero gaps (30k)', okGap);
  // first evaluable bar for the frozen window [2023-07-05T00:00Z, ...]
  const WIN_START = Date.UTC(2023, 6, 5, 0, 0, 0);
  const first = cds.findIndex(c => c.t + 60_000 >= WIN_START);
  check('realdata/first evaluable close == 2023-07-05T00:00Z', first >= 0 && cds[first].t + 60_000 === WIN_START,
    `idx=${first} close=${new Date(cds[first].t + 60_000).toISOString()}`);
  check('realdata/warmup covers 1440 before first evaluable', first >= FRVP_WINDOW_BARS);
}

// incremental state == full recompute at EVERY decision of the slice
{
  const state = new FrvpProfileState();
  let compared = 0, mismatches = 0; const firstBad = [];
  const decideFast = [], decideRef = [];
  for (let i = 0; i < N; i++) {
    if (state.ready) {
      const pi = state.profile();
      const pr = buildProfile(cds.slice(i - FRVP_WINDOW_BARS, i), { bins: FRVP_BINS });
      compared++;
      const bad = [];
      if (!(close(pi.lo, pr.lo) && close(pi.hi, pr.hi) && close(pi.totalVol, pr.totalVol))) bad.push('bounds');
      if (pi.pocIdx !== pr.pocIdx) bad.push('pocIdx');
      if (!(close(pi.pocPrice, pr.pocPrice) && close(pi.vah, pr.vah) && close(pi.val, pr.val))) bad.push('levels');
      if (pi.vaLoIdx !== pr.vaLoIdx || pi.vaHiIdx !== pr.vaHiIdx) bad.push('vaIdx');
      for (let k = 0; k < FRVP_BINS; k++) {
        if (Math.abs(pi.bins[k] - pr.bins[k]) > 1e-9 * Math.max(1, pr.bins[k])) { bad.push('bins@' + k); break; }
      }
      if (bad.length) { mismatches++; if (firstBad.length < 3) firstBad.push({ i, bad }); }
      // fast path vs reference path — full decision equality on every 7th bar
      if (i % 7 === 0) {
        const df = decideFromProfile(pi, cds[i]);
        const dr = evaluateFrvpBar(cds.slice(0, i), cds[i]);
        decideFast.push(JSON.stringify({ d: df.decision, w: df.reason, e: df.entry ?? null, s: df.sl ?? null, p: df.pocDegenerate ?? null }));
        decideRef.push(JSON.stringify({ d: dr.decision, w: dr.reason, e: dr.entry ?? null, s: dr.sl ?? null, p: dr.pocDegenerate ?? null }));
      }
    }
    state.push(cds[i]);
  }
  check('state/ready window filled', state.ready === true && state.size === FRVP_WINDOW_BARS);
  check(`state/equality on all ${compared} decisions`, mismatches === 0,
    `mismatches=${mismatches} first=${JSON.stringify(firstBad)}`);
  check('state/fast==reference decisions', decideFast.length > 1000 && decideFast.every((s, k) => s === decideRef[k]),
    `n=${decideFast.length}`);
}

// window semantics: state window == candles[k-1439..k] for random k
{
  const state = new FrvpProfileState();
  const marks = [];   // {k, snapshot} — snapshot taken right after push k
  for (let k = 0; k < N; k++) {
    state.push(cds[k]);
    // AFTER pushing candles[k]: window must be exactly [k-1439..k]
    if (k % 997 === 0 && state.ready) {
      const p = state.profile();
      marks.push({ k, snap: { lo: p.lo, hi: p.hi, poc: p.pocIdx, vah: p.vah, val: p.val } });
    }
  }
  let ok = true;
  for (const { k, snap } of marks) {
    // replay a fresh state up to k (inclusive push) — window = [k-1439..k]
    const st2 = new FrvpProfileState();
    for (let j = 0; j <= k; j++) st2.push(cds[j]);
    const p2 = st2.profile();
    if (!(close(snap.lo, p2.lo) && close(snap.hi, p2.hi) && snap.poc === p2.pocIdx && close(snap.vah, p2.vah) && close(snap.val, p2.val))) { ok = false; break; }
  }
  check(`state/window is last-1440-pushed (${marks.length} marks)`, ok && marks.length >= 20);
}

// no-lookahead mutation battery (reference path, sampled decisions)
{
  const SAMPLE = 60;
  let okTriggerExcluded = true, okInWindowMatters = true, okTailIrrelevant = true;
  let bad = '';
  for (let s = 0; s < SAMPLE; s++) {
    const i = 1500 + Math.floor((N - 1600) * (s / SAMPLE));
    const base = evaluateFrvpBar(cds.slice(0, i), cds[i]);
    const profKey = (d) => JSON.stringify({
      lo: d.profile.lo, hi: d.profile.hi, tv: d.profile.totalVol,
      poc: d.profile.pocIdx, vah: d.profile.vah, val: d.profile.val,
    });

    // (A) mutating the TRIGGER candle must not change the profile (it is
    //     excluded from its own window) — the judgment may change
    const mutTrig = { ...cds[i], h: cds[i].h + 7, l: cds[i].l - 7, v: cds[i].v * 3 };
    const mA = evaluateFrvpBar(cds.slice(0, i), mutTrig);
    if (base.profile && profKey(base) !== profKey(mA)) { okTriggerExcluded = false; bad = `A@${i}`; break; }

    // (B) mutating the candle immediately before the trigger (inside the
    //     window) MUST change the profile — proves the window is live data
    const mutArr = cds.slice(0, i).map((c, j) => j === i - 1 ? { ...c, h: c.h + 9, l: c.l - 9, v: c.v * 4 } : c);
    const mB = evaluateFrvpBar(mutArr, cds[i]);
    if (base.profile && profKey(base) === profKey(mB)) { okInWindowMatters = false; bad = `B@${i}`; break; }

    // (C) mutating bars AFTER the decision point (not passed to the
    //     reference call at all) cannot affect it — full record identical
    const tail = cds.map((c, j) => j > i ? { ...c, h: c.h + 50, l: c.l - 50, v: c.v * 5 } : c);
    const mC = evaluateFrvpBar(tail.slice(0, i), tail[i]);
    if (JSON.stringify({ ...base, profile: undefined }) !== JSON.stringify({ ...mC, profile: undefined })) {
      okTailIrrelevant = false; bad = `C@${i}`; break;
    }
  }
  check(`nolookahead/trigger excluded from own profile (${SAMPLE})`, okTriggerExcluded, bad);
  check(`nolookahead/in-window candle matters (${SAMPLE})`, okInWindowMatters, bad);
  check(`nolookahead/post-decision bars irrelevant (${SAMPLE})`, okTailIrrelevant, bad);
}

// triple-barrier invariants on random real paths (self-consistency)
{
  let ok = true; let bad = '';
  for (let t = 0; t < 300; t++) {
    const i0 = 1600 + Math.floor(Math.random() * (N - 2000));
    const trig = cds[i0];
    if (!(trig.h > trig.l)) continue;   // zero-range candle: no trade possible (harness guard)
    const entry = trig.c;
    const sl = trig.h + 0.1 * (trig.h - trig.l);
    const tp = entry - 1.5 * (sl - entry);
    const r = resolveTripleBarrier(cds, i0 + 1, {
      direction: 'SHORT', entry, slPrice: sl, tpPrice: tp,
      maxHoldMs: 120 * 60_000, entryTime: trig.t + 60_000, rAbs: sl - entry,
    });
    if (r.type === 'SL' && !(Math.abs(r.exitPrice - sl) < 1e-9)) { ok = false; bad = `SLpx@${i0}`; break; }
    if (r.type === 'TP' && !(Math.abs(r.exitPrice - tp) < 1e-9)) { ok = false; bad = `TPpx@${i0}`; break; }
    if ((r.type === 'SL' || r.type === 'TP') && r.minutesHeld < 1) { ok = false; bad = `min@${i0}`; break; }
    if (r.type === 'TIMEOUT' && r.minutesHeld !== 120) { ok = false; bad = `TOmin@${i0}:${r.minutesHeld}`; break; }
    if (r.r != null && Math.abs(r.r - ((entry - r.exitPrice) / (sl - entry))) > 1e-6) { ok = false; bad = `r@${i0}`; break; }
  }
  check('tb/real-data self-consistency (300 paths)', ok, bad);
}

console.log(`\nfrvp_tests: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.join('\n')); process.exit(1); }

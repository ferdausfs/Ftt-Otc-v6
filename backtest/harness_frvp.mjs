/**
 * FRVP fade + triple-barrier R:R exit — backtest harness. ONE block, ONE pass.
 *
 * NO SPLIT, by spec: parameters (bins=50, VA=70%, buffer=0.1x, max hold=120m,
 * TP 1.5R/3R/POC) are frozen textbook/spec defaults committed BEFORE the run
 * (691dd10) — nothing to fit, so the whole 12-month block
 * (2023-07-05T00:00Z -> 2024-07-05T00:00Z) runs once and is reported as one
 * result. Data: reused Bybit 1m (fetched for the Market Structure test with
 * 14d warmup + 1h tail, zero gaps) — LEGITIMATE reuse, stated in the report:
 * this is a new hypothesis family (value-area fade) AND a new exit model
 * (triple-barrier R:R), derived from no prior outcome in this project; the
 * 2023-07-05..2024-07-05 block is the preferred window per spec. NO decision
 * is evaluated outside the window: evaluated bars are those whose CLOSE time
 * lies in [2023-07-05T00:00Z, 2024-07-05T00:00Z] (inclusive end, exit
 * resolves in the tail).
 *
 * Window discipline (no-lookahead): the decision for 1m bar i reads the
 * profile of bars [i-1440 .. i-1] (closes strictly before bar i's close) and
 * bar i's own OHLC (fully closed at the decision moment). The harness
 * evaluates bar i BEFORE pushing it into FrvpProfileState — structurally the
 * profile can never contain bar i or anything later. Proven by mutation in
 * scripts/frvp_tests.mjs and re-proven independently by the verifier.
 *
 * Statistics (key difference from every prior report — the binary 55.56%
 * breakeven DOES NOT apply here):
 *   - headline win rate = W/(W+L) with Wilson 95% CI (timeouts excluded);
 *     conservative rate = W/(W+L+TIMEOUT)
 *   - expectancy (R) = mean realized R over TP+SL+TIMEOUT trades (timeouts
 *     at their actual realized R; censored excluded from headline, reported
 *     separately) — a strategy is profitable iff expectancy > 0
 *   - costs: gross fills are mid/barrier-price with zero fee; NET lines
 *     subtract round-trip taker fees: cost in R = (2 x perSide) / (R/entry);
 *     base assumption 0.10% per side, sensitivities 0.05% / 0.20%
 *   - inference on expectancy: normal-approx 95% CI always + seeded
 *     bootstrap 95% CI (5,000 resamples, seed 20260908) when n <= 60k
 *   - PASS gate per TP variant: n >= 30 AND net-expectancy (base cost)
 *     CI lower bound > 0. All three variants reported, never cherry-picked.
 *   - MIN_BUCKET = 30 decided trades for any reported rate bucket.
 *
 * Audit: results/FRVP_audit.jsonl.gz
 *   - one row per evaluated 1m bar  ("k":"M1"): trigger OHLC, decision,
 *     reason, full profile context (poc/vah/val/window bounds/total volume)
 *   - one row per trade             ("k":"TRD"): direction, entry, SL, R,
 *     all three TP levels with resolution type + realized R + minutes held +
 *     gap flags per variant, POC degeneracy, overlap count at entry
 *
 * Run: node backtest/harness_frvp.mjs
 */
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FrvpProfileState, decideFromProfile,
  FRVP_BINS, FRVP_VA_PCT, FRVP_BUFFER_X, FRVP_MAX_HOLD_MIN, FRVP_WINDOW_BARS,
  FRVP_TP_R1, FRVP_TP_R2,
} from '../src/strategy/frvpFade.mjs';
import { resolveTripleBarrier } from './tripleBarrier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ms');
const RESULTS = join(ROOT, 'results');

// ── frozen window (same block every prior crypto strategy used / MS fetched) ─
export const WIN_START = Date.UTC(2023, 6, 5, 0, 0, 0);   // 2023-07-05T00:00Z
export const WIN_END = Date.UTC(2024, 6, 5, 0, 0, 0);     // 2024-07-05T00:00Z

const MIN_BUCKET = 30;
const MS_1M = 60_000;
const MAX_HOLD_MS = FRVP_MAX_HOLD_MIN * MS_1M;
const PAIRS = ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD'];
const BOOTSTRAP_SEED = 20260908;
const BOOTSTRAP_ITERS = 5_000;
const BOOTSTRAP_MAX_N = 60_000;
const COST_PER_SIDE = { base: 0.001, low: 0.0005, high: 0.002 };  // taker, fraction of notional

const r6 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(6));
const r8 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(8));

// ── stats helpers (independent of any prior harness by design) ──────────────
function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { wr: null, lo: null, hi: null };
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
function normalCI(a) {
  const n = a.length, m = mean(a), s = sd(a);
  if (n === 0 || s == null) return { lo: null, hi: null, mean: m };
  const half = 1.959963985 * s / Math.sqrt(n);
  return { mean: m, lo: m - half, hi: m + half };
}
// seeded uniform LCG bootstrap percentile CI on the mean
function bootstrapCI(a, iters = BOOTSTRAP_ITERS, seed = BOOTSTRAP_SEED) {
  const n = a.length;
  if (n === 0) return { lo: null, hi: null };
  if (n > BOOTSTRAP_MAX_N) return { lo: null, hi: null, skipped: 'n>' + BOOTSTRAP_MAX_N };
  let s = seed >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const means = new Float64Array(iters);
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += a[(rnd() * n) | 0];
    means[it] = sum / n;
  }
  means.sort();
  return { lo: means[Math.floor(0.025 * iters)], hi: means[Math.ceil(0.975 * iters) - 1] };
}
function costInR(rFrac, perSide) { return (2 * perSide) / rFrac; }

// ═══════════════════════════════ per-pair pass ══════════════════════════════
function runPair(pair, gzipStream) {
  const name = pair.replace('/', '');
  const { meta, candles: c1 } = JSON.parse(readFileSync(join(DATA, `${name}_1m.json`), 'utf8'));

  // contiguity assertion (data was verified zero-gap at fetch; re-verify)
  for (let i = 1; i < c1.length; i++) {
    if (c1[i].t - c1[i - 1].t !== MS_1M) throw new Error(`${pair}: gap at index ${i}`);
  }

  let writeBuf = [];
  const write = (row) => {
    writeBuf.push(row);
    if (writeBuf.length >= 20000) {
      gzipStream.write(writeBuf.join('\n') + '\n');
      writeBuf = [];
    }
  };

  const state = new FrvpProfileState();
  let evaluated = 0, trades = 0;
  const funnel = { decisions: {}, reasons: {}, resolutions: { v15: {}, v3: {}, vPoc: {} } };
  const tradesOut = [];   // kept in memory for stats (tens of thousands max)
  let openEnds = [];      // variant-(a) hold end times for overlap stats
  let overlapped = 0;
  let zeroRangeSeen = 0;

  for (let i = 0; i < c1.length; i++) {
    const closeT = c1[i].t + MS_1M;
    if (closeT > WIN_END) break;              // past the window (tail resolves trades only)
    const inWindow = closeT >= WIN_START;

    // profile of bars [i-1440 .. i-1]: state has been pushed exactly those
    // (warmup candles BEFORE the window are pushed too — they are the window's
    // history; the push for bar i happens AFTER its decision below)
    if (inWindow) {
      const prof = state.profile();
      const d = decideFromProfile(prof, c1[i]);
      evaluated++;

      funnel.decisions[d.decision] = (funnel.decisions[d.decision] || 0) + 1;
      if (d.decision === 'NO_TRADE') funnel.reasons[d.reason] = (funnel.reasons[d.reason] || 0) + 1;

      if (d.decision === 'PUT' || d.decision === 'CALL') {
      // overlap stat: is a variant-(a) trade still open at this close?
      const stillOpen = openEnds.filter((e) => e > closeT).length;
      if (stillOpen > 0) overlapped++;
      openEnds = openEnds.filter((e) => e > closeT);
      openEnds.push(closeT + MAX_HOLD_MS);
      trades++;

      const entry = d.entry, rAbs = d.rAbs, rFrac = d.rFrac;
      const direction = d.decision === 'PUT' ? 'SHORT' : 'LONG';
      const res = (tpPrice) => resolveTripleBarrier(c1, i + 1, {
        direction, entry, slPrice: d.sl, tpPrice,
        maxHoldMs: MAX_HOLD_MS, entryTime: closeT, rAbs,
      });
      const v15 = res(d.tp15);
      const v3 = res(d.tp3);
      const vPoc = res(d.tpPoc);   // tpPoc null -> SL/TIMEOUT/CENSORED only

      for (const [tag, v] of [['v15', v15], ['v3', v3], ['vPoc', vPoc]]) {
        funnel.resolutions[tag][v.type] = (funnel.resolutions[tag][v.type] || 0) + 1;
      }
      const tr = {
        v15: { px: r6(d.tp15), res: v15.type, xT: v15.exitT, x: r6(v15.exitPrice), r: v15.r, m: v15.minutesHeld, g: v15.slGapFill ? 1 : 0, ro: v15.rOpen },
        v3: { px: r6(d.tp3), res: v3.type, xT: v3.exitT, x: r6(v3.exitPrice), r: v3.r, m: v3.minutesHeld, g: v3.slGapFill ? 1 : 0, ro: v3.rOpen },
        vPoc: { px: r6(d.tpPoc), res: vPoc.type, xT: vPoc.exitT, x: r6(vPoc.exitPrice), r: vPoc.r, m: vPoc.minutesHeld, g: vPoc.slGapFill ? 1 : 0, ro: vPoc.rOpen },
      };
      const tradeRow = {
        k: 'TRD', p: pair, t: c1[i].t, dir: d.decision,
        en: r6(entry), sl: r6(d.sl), ra: r6(rAbs), rf: r8(rFrac), buf: r6(d.buffer),
        poc: r6(prof.pocPrice), vah: r6(prof.vah), val: r6(prof.val),
        wlo: r6(prof.lo), whi: r6(prof.hi), tv: r6(prof.totalVol),
        dg: d.pocDegenerate ? 1 : 0, ov: stillOpen,
        ...tr,
      };
      write(JSON.stringify(tradeRow));
      tradesOut.push({
        pair, t: c1[i].t, dir: d.decision, entry, rAbs, rFrac, dg: d.pocDegenerate,
        v15, v3, vPoc,
      });

      write(JSON.stringify({
        k: 'M1', p: pair, t: c1[i].t, o: r6(c1[i].o), h: r6(c1[i].h), l: r6(c1[i].l), c: r6(c1[i].c),
        d: d.decision, w: d.reason,
        poc: prof.degenerate ? null : r6(prof.pocPrice),
        vah: prof.degenerate ? null : r6(prof.vah),
        val: prof.degenerate ? null : r6(prof.val),
        wlo: prof.degenerate ? null : r6(prof.lo),
        whi: prof.degenerate ? null : r6(prof.hi),
        tv: prof.degenerate ? null : r6(prof.totalVol),
        en: tradeRow.en, sl: tradeRow.sl,
      }));
    } else {
      write(JSON.stringify({
        k: 'M1', p: pair, t: c1[i].t, o: r6(c1[i].o), h: r6(c1[i].h), l: r6(c1[i].l), c: r6(c1[i].c),
        d: d.decision, w: d.reason,
        poc: prof.degenerate ? null : r6(prof.pocPrice),
        vah: prof.degenerate ? null : r6(prof.vah),
        val: prof.degenerate ? null : r6(prof.val),
        wlo: prof.degenerate ? null : r6(prof.lo),
        whi: prof.degenerate ? null : r6(prof.hi),
        tv: prof.degenerate ? null : r6(prof.totalVol),
        en: null, sl: null,
      }));
    }
    }  // end if (inWindow)

    // push AFTER deciding: the profile for bar i can never contain bar i
    state.push(c1[i]);
  }
  if (writeBuf.length) { gzipStream.write(writeBuf.join('\n') + '\n'); writeBuf = []; }

  return { pair, meta, m1Count: c1.length, evaluated, trades, funnel, tradesOut, overlapped, zeroRangeSeen };
}

// ═══════════════════════════════ aggregation ════════════════════════════════
function variantStats(trades, key) {
  const decidedR = [], allR = [], rFracs = [], wins = [], timeoutsR = [];
  let w = 0, l = 0, to = 0, cen = 0, gapCount = 0;
  for (const t of trades) {
    const v = t[key];
    const r = v.r;
    if (r != null) allR.push(r);
    // rFrac is per-TRADE (same for all variants); push it in lockstep with
    // decidedR so cost conversion stays index-aligned
    if (v.type === 'TP') { w++; wins.push(r); decidedR.push(r); rFracs.push(t.rFrac); }
    else if (v.type === 'SL') { l++; decidedR.push(r); rFracs.push(t.rFrac); if (v.g) gapCount++; }
    else if (v.type === 'TIMEOUT') { to++; timeoutsR.push(r); decidedR.push(r); rFracs.push(t.rFrac); }
    else if (v.type === 'CENSORED') { cen++; }
  }
  const n = w + l + to;                 // decided (censored excluded from headline)
  const wil = wilson(w, w + l);
  const cons = wilson(w, w + l + to);
  const exp = normalCI(decidedR);
  const boot = bootstrapCI(decidedR);
  // cost-adjusted expectancies (per-side taker fee levels)
  const netBy = {};
  for (const [tag, ps] of Object.entries(COST_PER_SIDE)) {
    const arr = decidedR.map((r, idx) => r - costInR(rFracs[idx], ps));
    const nc = normalCI(arr);
    const nb = bootstrapCI(arr);
    netBy[tag] = {
      perSide: ps, rtPctOfNotional: +(200 * ps).toFixed(3),
      point: nc.mean != null ? +nc.mean.toFixed(6) : null,
      lo: nc.lo != null ? +nc.lo.toFixed(6) : null,
      hi: nc.hi != null ? +nc.hi.toFixed(6) : null,
      bootLo: nb.lo != null ? +nb.lo.toFixed(6) : null,
      bootHi: nb.hi != null ? +nb.hi.toFixed(6) : null,
      bootUsed: nb.lo != null,
    };
  }
  // conservative gap-fill sensitivity: SL fills at the exit candle's open
  const gapSensitive = [];
  for (const t of trades) {
    const v = t[key];
    if (v.type === 'TP' || v.type === 'TIMEOUT') gapSensitive.push(v.r);
    else if (v.type === 'SL') gapSensitive.push(v.g ? (v.ro ?? v.r) : v.r);
  }
  const expGap = normalCI(gapSensitive);
  return {
    n, wins: w, losses: l, timeouts: to, censored: cen,
    wr: wil.wr, wrLo: wil.lo, wrHi: wil.hi,
    conservativeWr: cons.wr,
    timeoutRate: n + cen ? to / (n + cen) : null,
    avgWinR: mean(wins),
    avgTimeoutR: mean(timeoutsR),
    expectancy: exp.mean != null ? { gross: +exp.mean.toFixed(6), lo: +exp.lo.toFixed(6), hi: +exp.hi.toFixed(6) } : null,
    expectancyBoot: boot.lo != null ? { lo: +boot.lo.toFixed(6), hi: +boot.hi.toFixed(6) } : { lo: null, hi: null, skipped: boot.skipped ?? null },
    expectancyNet: netBy,
    gapSensitive: { count: gapCount, expectancy: expGap.mean != null ? { gross: +expGap.mean.toFixed(6), lo: +expGap.lo.toFixed(6), hi: +expGap.hi.toFixed(6) } : null },
    sufficient: n >= MIN_BUCKET,
  };
}

function main() {
  const startedIso = new Date().toISOString();
  const auditPath = join(RESULTS, 'FRVP_audit.jsonl.gz');
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(auditPath);
  gzip.pipe(out);

  const runs = [];
  for (const pair of PAIRS) {
    process.stdout.write(`run ${pair} ... `);
    const t0 = Date.now();
    const r = runPair(pair, gzip);
    console.log(`evaluated=${r.evaluated} trades=${r.trades} overlapped=${r.overlapped} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    runs.push(r);
  }
  gzip.end();
  out.on('finish', () => {
    try { finish(runs, startedIso, auditPath); } catch (e) { console.error('HARNESS FAILED:', e); process.exit(1); }
  });
}

function finish(runs, startedIso, auditPath) {
  const all = runs.flatMap((r) => r.tradesOut);
  const variants = {
    tp15: variantStats(all, 'v15'),
    tp3: variantStats(all, 'v3'),
    tpPoc: variantStats(all, 'vPoc'),
  };
  const byPair = {};
  for (const p of PAIRS) {
    const sub = all.filter((t) => t.pair === p);
    byPair[p] = { tp15: variantStats(sub, 'v15'), tp3: variantStats(sub, 'v3'), tpPoc: variantStats(sub, 'vPoc'), n: sub.length };
  }
  const byDir = {};
  for (const dir of ['PUT', 'CALL']) {
    const sub = all.filter((t) => t.dir === dir);
    byDir[dir] = { tp15: variantStats(sub, 'v15'), tp3: variantStats(sub, 'v3'), tpPoc: variantStats(sub, 'vPoc'), n: sub.length };
  }

  // PASS gate per variant: n >= 30 AND net expectancy (base cost) CI-lo > 0.
  // CI rule: bootstrap lo when available, else normal-approx lo.
  const gate = {};
  for (const [k, v] of Object.entries(variants)) {
    const net = v.expectancyNet.base;
    const loUsed = net.bootUsed ? net.bootLo : net.lo;
    gate[k] = {
      n: v.n, sufficient: v.sufficient,
      netExpectancy: net.point,
      netLoUsed: loUsed,
      ciSource: net.bootUsed ? 'bootstrap' : 'normal',
      pass: Boolean(v.sufficient && loUsed != null && loUsed > 0),
    };
  }

  const funnel = {
    evaluatedBars: runs.reduce((a, r) => a + r.evaluated, 0),
    decisions: {}, reasons: {},
    resolutions: { v15: {}, v3: {}, vPoc: {} },
    trades: all.length,
    pocDegenerate: all.filter((t) => t.dg).length,
    overlapShare: all.length ? runs.reduce((a, r) => a + r.overlapped, 0) / all.length : null,
    perPairEvaluated: Object.fromEntries(runs.map((r) => [r.pair, r.evaluated])),
    perPairTrades: Object.fromEntries(runs.map((r) => [r.pair, r.trades])),
    zeroRangeSeen: runs.reduce((a, r) => a + r.zeroRangeSeen, 0),
  };
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.funnel.decisions)) funnel.decisions[k] = (funnel.decisions[k] || 0) + v;
    for (const [k, v] of Object.entries(r.funnel.reasons)) funnel.reasons[k] = (funnel.reasons[k] || 0) + v;
    for (const tag of ['v15', 'v3', 'vPoc']) {
      for (const [k, v] of Object.entries(r.funnel.resolutions[tag])) funnel.resolutions[tag][k] = (funnel.resolutions[tag][k] || 0) + v;
    }
  }

  const summary = {
    engine: 'FRVP fade + triple-barrier R:R exit — 50-bin trailing-24h volume profile, VA 70% fade of VAH/VAL pierce-and-reject, SL = trigger wick + 0.1x range, TP variants 1.5R / 3R / POC, max hold 120m; standalone module src/strategy/frvpFade.mjs + backtest/tripleBarrier.mjs',
    startedAt: startedIso,
    auditFile: 'results/FRVP_audit.jsonl.gz',
    mode: 'single 12-month block 2023-07-05..2024-07-05, one pass, no split (parameters frozen pre-run, commit 691dd10)',
    window: { start: new Date(WIN_START).toISOString(), end: new Date(WIN_END).toISOString(), inclusiveEnd: true },
    frozenParams: {
      bins: FRVP_BINS, vaPct: FRVP_VA_PCT, bufferX: FRVP_BUFFER_X,
      maxHoldMin: FRVP_MAX_HOLD_MIN, windowBars: FRVP_WINDOW_BARS,
      tpR1: FRVP_TP_R1, tpR2: FRVP_TP_R2,
      profileWindowRule: '1440 closed 1m candles with close time strictly before the trigger close (trigger candle excluded)',
      tieBreaks: 'POC tie -> lowest-priced bin; VA expansion tie -> UP first; strict trigger inequalities',
      costAssumptions: COST_PER_SIDE,
    },
    dataReuseNote: 'Bybit 1m 2023-06-21..2024-07-05T01:00Z reused from the Market Structure fetch (warmup+tail included); legitimate per spec: new hypothesis family + new exit model, not derived from any prior outcome',
    minBucket: MIN_BUCKET,
    bootstrap: { seed: BOOTSTRAP_SEED, iters: BOOTSTRAP_ITERS, maxN: BOOTSTRAP_MAX_N },
    data: runs.map((r) => ({
      pair: r.pair, source: r.meta.source, symbol: r.meta.symbol,
      first: r.meta.first, last: r.meta.last, m1Candles: r.m1Count,
      gaps: r.meta.gaps ?? 0, evaluated: r.evaluated, trades: r.trades, overlapped: r.overlapped,
    })),
    funnel,
    variants,
    byPair,
    byDirection: byDir,
    gate,
  };
  writeFileSync(join(RESULTS, 'FRVP_summary.json'), JSON.stringify(summary, null, 2));

  // ── console headline ───────────────────────────────────────────────────────
  console.log('\n══ FRVP FADE + TRIPLE-BARRIER R:R — 12-month block, one pass ══');
  console.log(`funnel: evaluated=${funnel.evaluatedBars} decisions=${JSON.stringify(funnel.decisions)}`);
  console.log(`        noTradeReasons=${JSON.stringify(funnel.reasons)}`);
  console.log(`        trades=${funnel.trades} pocDegenerate=${funnel.pocDegenerate} overlapShare=${(100 * funnel.overlapShare).toFixed(1)}%`);
  const f = (x) => (x == null ? '-' : (100 * x).toFixed(1) + '%');
  const r6f = (x) => (x == null ? '-' : (+x).toFixed(3));
  for (const [k, label] of [['tp15', 'TP 1.5R'], ['tp3', 'TP 3R'], ['tpPoc', 'TP POC']]) {
    const v = variants[k];
    if (v.n === 0) { console.log(`\n${label}: NO DECIDED TRADES`); continue; }
    console.log(`\n${label}: n=${v.n} (W=${v.wins} L=${v.losses} TO=${v.timeouts} CEN=${v.censored})`);
    console.log(`  WR=${f(v.wr)} Wilson=[${f(v.wrLo)}, ${f(v.wrHi)}]  conservative=${f(v.conservativeWr)}  timeoutRate=${f(v.timeoutRate)}`);
    console.log(`  expectancy gross=${r6f(v.expectancy.gross)} R  CI=[${r6f(v.expectancy.lo)}, ${r6f(v.expectancy.hi)}]  (normal)`);
    if (v.expectancyBoot.lo != null) console.log(`  expectancy gross bootstrap=[${r6f(v.expectancyBoot.lo)}, ${r6f(v.expectancyBoot.hi)}]`);
    for (const [ck, cv] of Object.entries(v.expectancyNet)) {
      console.log(`  net @ ${cv.perSide * 100}%/side: ${r6f(cv.point)} R CI=[${r6f(cv.lo)}, ${r6f(cv.hi)}]${cv.bootUsed ? ` boot=[${r6f(cv.bootLo)}, ${r6f(cv.bootHi)}]` : ''}`);
    }
    console.log(`  avgWinR=${r6f(v.avgWinR)} avgTimeoutR=${r6f(v.avgTimeoutR)} gapSensitive(${v.gapSensitive.count})=${r6f(v.gapSensitive.expectancy?.gross)}`);
    console.log(`  GATE: ${gate[k].pass ? 'PASS' : 'FAIL'} (net ${gate[k].ciSource} lo ${r6f(gate[k].netLoUsed)} ${gate[k].pass ? '>' : '<='} 0)`);
  }
  console.log('\nper pair (n / WR / gross expectancy):');
  for (const p of PAIRS) {
    const b = byPair[p];
    const row = (vv) => vv.n === 0 ? '-/-/-' : `${vv.n}/${f(vv.wr)}/${r6f(vv.expectancy.gross)}`;
    console.log(`  ${p.padEnd(8)} 1.5R ${row(b.tp15)}  3R ${row(b.tp3)}  POC ${row(b.tpPoc)}`);
  }
  console.log(`\naudit: ${auditPath.replace(ROOT + '/', '')}`);
}

main();

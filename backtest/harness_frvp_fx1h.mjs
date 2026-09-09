/**
 * FRVP-FX1H fade + triple-barrier R:R exit — backtest harness. ONE block, ONE pass.
 *
 * Mirrors backtest/harness_frvp.mjs (crypto) with the differences the task
 * mandates. NO SPLIT, by spec: parameters (480-candle window, bins=50, VA=70%,
 * buffer=0.1x, max hold=240h, TP 1.5R/3R/POC) are frozen textbook/spec defaults
 * committed BEFORE the run (2af0ad2, pre-registration commit) — nothing to fit,
 * so the whole fetched block (2026-06 .. 2026-09, histdata tick feed) runs once
 * and is reported as one result, per pair. The first 480 hourly candles of each
 * pair are profile warmup; every 1h candle after that is an evaluated decision
 * (weekends are absent hours, never evaluated, never fabricated). Some pairs
 * have fewer usable candles (USD/JPY's feed ends Sep 4 with 4 fewer candles) —
 * reported per pair, NOT padded, exactly as the task requires.
 *
 * Window discipline (no-lookahead): the decision for 1h bar i reads the
 * profile of bars [i-480 .. i-1] (closes strictly before bar i's close) and
 * bar i's own OHLC (fully closed at the decision moment). The harness
 * evaluates bar i BEFORE pushing it into FrvpProfileState — structurally the
 * profile can never contain bar i or anything later. Proven by mutation in
 * scripts/frvp_fx1h_tests.mjs.
 *
 * Statistics (expectancy framing — the binary 55.56% breakeven DOES NOT apply):
 *   - headline win rate = W/(W+L) with Wilson 95% CI (timeouts excluded);
 *     conservative rate = W/(W+L+TIMEOUT)
 *   - expectancy (R) = mean realized R over TP+SL+TIMEOUT trades (timeouts
 *     at their actual realized R; censored excluded from headline, reported
 *     separately) — a strategy is profitable iff expectancy > 0
 *   - costs: gross fills are mid/barrier-price with zero cost; NET lines
 *     subtract realistic retail FX costs IN PIPS (frozen before the run):
 *       spread (round trip, crossed once) + swap per UTC-midnight crossed
 *       during the hold (multi-day holds make financing non-negligible);
 *       cost in R = cost_price / |entry - SL|
 *     base and sensitivity assumptions per pair are in FX_COSTS below and
 *     are stated explicitly in the report.
 *   - inference on expectancy: normal-approx 95% CI always + seeded
 *     bootstrap 95% CI (5,000 resamples, seed 20260908)
 *   - PASS gate per TP variant: n >= 30 AND net-expectancy (base cost)
 *     CI lower bound > 0. All three variants reported, never cherry-picked.
 *   - MIN_BUCKET = 30 decided trades for any reported rate bucket; pairs or
 *     buckets below it are FLAGGED, not reported as rates (short window).
 *
 * Audit: results/FRVP_FX1H_audit.jsonl.gz
 *   - one row per evaluated 1h bar  ("k":"H1"): trigger OHLC, decision,
 *     reason, full profile context (poc/vah/val/window bounds/total ticks)
 *   - one row per trade             ("k":"TRD"): direction, entry, SL, R
 *     (price AND pips), all three TP levels with resolution type + realized
 *     R + hours held + gap flags per variant, POC degeneracy, overlap count
 *     at entry, entry/exit times (for swap-night reconstruction)
 *
 * Run: node backtest/harness_frvp_fx1h.mjs
 */
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FrvpProfileState, decideFromProfile,
  FRVPFX_BINS, FRVPFX_VA_PCT, FRVPFX_BUFFER_X, FRVPFX_MAX_HOLD_HOURS,
  FRVPFX_WINDOW_BARS, FRVPFX_TP_R1, FRVPFX_TP_R2, FRVPFX_MS_1H,
} from '../src/strategy/frvpFadeFx1h.mjs';
import { resolveTripleBarrier } from './tripleBarrier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'fx1h');
const RESULTS = join(ROOT, 'results');

const MIN_BUCKET = 30;
const MAX_HOLD_MS = FRVPFX_MAX_HOLD_HOURS * FRVPFX_MS_1H;
const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];
const BOOTSTRAP_SEED = 20260908;
const BOOTSTRAP_ITERS = 5_000;
const BOOTSTRAP_MAX_N = 60_000;

// ── frozen FX cost assumptions (pips; committed before the run) ─────────────
// spread = round-trip cost (crossed once: half-spread in, half-spread out).
// swapPipsPerNight = flat charge per UTC-midnight crossed during the hold,
// applied to BOTH directions (conservative simplification: real swaps are
// directional and sometimes positive; we charge every night, every trade).
const FX_COSTS = {
  'EUR/USD': { pipSize: 0.0001, spreadPips: 1.0, swapPipsPerNight: 1.0 },
  'GBP/USD': { pipSize: 0.0001, spreadPips: 1.5, swapPipsPerNight: 1.0 },
  'USD/JPY': { pipSize: 0.01,   spreadPips: 1.2, swapPipsPerNight: 1.0 },
  'AUD/USD': { pipSize: 0.0001, spreadPips: 1.2, swapPipsPerNight: 1.0 },
};
const SPREAD_MULTS = { base: 1.0, low: 0.5, high: 2.0 };   // sensitivity rows
const SWAP_MULTS = { base: 1.0, high: 2.0 };               // sensitivity rows

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

/** UTC midnights strictly crossed between entry close and exit close. */
function swapNights(entryT, exitT) {
  if (exitT == null) return 0;
  return Math.floor(exitT / 86_400_000) - Math.floor(entryT / 86_400_000);
}

/** cost of one trade in R under a given spread/swap multiplier. */
function costInR(costs, rAbs, spreadMult, swapMult, entryT, exitT) {
  const costPrice = (costs.spreadPips * spreadMult + costs.swapPipsPerNight * swapMult * swapNights(entryT, exitT)) * costs.pipSize;
  return costPrice / rAbs;
}

// ═══════════════════════════════ per-pair pass ══════════════════════════════
function runPair(pair, gzipStream) {
  const name = pair.replace('/', '');
  const { meta, candles: c1 } = JSON.parse(readFileSync(join(DATA, `${name}_1h.json`), 'utf8'));
  const costs = FX_COSTS[pair];

  // data sanity: strictly increasing t, whole-hour grid (weekend gaps are
  // legitimate absent hours — no contiguity assert here, unlike crypto 1m)
  for (let i = 1; i < c1.length; i++) {
    const dt = c1[i].t - c1[i - 1].t;
    if (dt <= 0 || dt % FRVPFX_MS_1H !== 0) throw new Error(`${pair}: bad grid at index ${i} (dt=${dt})`);
  }

  let writeBuf = [];
  const write = (row) => {
    writeBuf.push(row);
    if (writeBuf.length >= 20_000) {
      gzipStream.write(writeBuf.join('\n') + '\n');
      writeBuf = [];
    }
  };

  const state = new FrvpProfileState();
  let evaluated = 0, trades = 0;
  const funnel = { decisions: {}, reasons: {}, resolutions: { v15: {}, v3: {}, vPoc: {} } };
  const tradesOut = [];   // kept in memory for stats (small n by design)
  let openEnds = [];      // variant-(a) hold end times for overlap stats
  let overlapped = 0;
  let multiNightTrades = 0;   // variant-(a) holds crossing >= 2 UTC midnights (weekend-scale holds)

  for (let i = 0; i < c1.length; i++) {
    const closeT = c1[i].t + FRVPFX_MS_1H;

    // profile of bars [i-480 .. i-1]: state has been pushed exactly those
    // (the push for bar i happens AFTER its decision below — structurally
    // the profile can never contain bar i or anything later)
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
        maxHoldMs: MAX_HOLD_MS, msPerBar: FRVPFX_MS_1H, entryTime: closeT, rAbs,
      });
      const v15 = res(d.tp15);
      const v3 = res(d.tp3);
      const vPoc = res(d.tpPoc);   // tpPoc null -> SL/TIMEOUT/CENSORED only

      for (const [tag, v] of [['v15', v15], ['v3', v3], ['vPoc', vPoc]]) {
        funnel.resolutions[tag][v.type] = (funnel.resolutions[tag][v.type] || 0) + 1;
      }
      if (swapNights(closeT, v15.exitT) >= 2) multiNightTrades++;
      const tr = {
        v15: { px: r6(d.tp15), res: v15.type, xT: v15.exitT, x: r6(v15.exitPrice), r: v15.r, h: v15.minutesHeld, g: v15.slGapFill ? 1 : 0, ro: v15.rOpen },
        v3: { px: r6(d.tp3), res: v3.type, xT: v3.exitT, x: r6(v3.exitPrice), r: v3.r, h: v3.minutesHeld, g: v3.slGapFill ? 1 : 0, ro: v3.rOpen },
        vPoc: { px: r6(d.tpPoc), res: vPoc.type, xT: vPoc.exitT, x: r6(vPoc.exitPrice), r: vPoc.r, h: vPoc.minutesHeld, g: vPoc.slGapFill ? 1 : 0, ro: vPoc.rOpen },
      };
      const tradeRow = {
        k: 'TRD', p: pair, t: c1[i].t, dir: d.decision,
        en: r6(entry), sl: r6(d.sl), ra: r8(rAbs), rf: r8(rFrac), buf: r6(d.buffer),
        rp: r6(rAbs / costs.pipSize),          // R in pips — the cost-fraction hypothesis quantity
        spread: costs.spreadPips, swap: costs.swapPipsPerNight, pip: costs.pipSize,
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
        k: 'H1', p: pair, t: c1[i].t, o: r6(c1[i].o), h: r6(c1[i].h), l: r6(c1[i].l), c: r6(c1[i].c),
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
        k: 'H1', p: pair, t: c1[i].t, o: r6(c1[i].o), h: r6(c1[i].h), l: r6(c1[i].l), c: r6(c1[i].c),
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

    // push AFTER deciding: the profile for bar i can never contain bar i
    state.push(c1[i]);
  }
  if (writeBuf.length) { gzipStream.write(writeBuf.join('\n') + '\n'); writeBuf = []; }

  return { pair, meta, h1Count: c1.length, evaluated, trades, funnel, tradesOut, overlapped, multiNightTrades };
}

// ═══════════════════════════════ aggregation ════════════════════════════════
function variantStats(trades, key) {
  const decided = [];            // {r, rFrac, rAbs, entryT, exitT, pair, type}
  let w = 0, l = 0, to = 0, cen = 0, gapCount = 0;
  const wins = [], timeoutsR = [], rPips = [];
  for (const t of trades) {
    const v = t[key];
    if (v.type === 'TP') { w++; wins.push(v.r); decided.push({ r: v.r, rAbs: t.rAbs, entryT: t.entryT, exitT: v.exitT, pair: t.pair, type: 'TP' }); }
    else if (v.type === 'SL') { l++; decided.push({ r: v.r, rAbs: t.rAbs, entryT: t.entryT, exitT: v.exitT, pair: t.pair, type: 'SL' }); if (v.g) gapCount++; }
    else if (v.type === 'TIMEOUT') { to++; timeoutsR.push(v.r); decided.push({ r: v.r, rAbs: t.rAbs, entryT: t.entryT, exitT: v.exitT, pair: t.pair, type: 'TIMEOUT' }); }
    else if (v.type === 'CENSORED') { cen++; }
  }
  const n = w + l + to;                 // decided (censored excluded from headline)
  const wil = wilson(w, w + l);
  const cons = wilson(w, w + l + to);
  const grossArr = decided.map((x) => x.r);
  const exp = normalCI(grossArr);
  const boot = bootstrapCI(grossArr);
  const nightsArr = decided.map((x) => swapNights(x.entryT, x.exitT));
  const nights = { avg: mean(nightsArr) != null ? +mean(nightsArr).toFixed(3) : null, max: nightsArr.length ? Math.max(...nightsArr) : null };

  // NET expectancy under the frozen per-pair FX cost model. Each variant's
  // exit time differs -> swap nights differ per variant (reconstructed from
  // the recorded exit time; spread is exit-time-independent).
  const netBy = {};
  for (const sTag of Object.keys(SPREAD_MULTS)) {
    for (const wTag of Object.keys(SWAP_MULTS)) {
      if (sTag === 'low' && wTag === 'high') continue;      // corner, not needed
      if (sTag === 'high' && wTag === 'low') continue;
      const key2 = sTag === 'base' ? wTag : `${sTag}Spread${wTag === 'base' ? 'BaseSwap' : wTag + 'Swap'}`;
      const arr = decided.map((x) => {
        const costs = FX_COSTS[x.pair];
        const costPrice = (costs.spreadPips * SPREAD_MULTS[sTag] + costs.swapPipsPerNight * SWAP_MULTS[wTag] * swapNights(x.entryT, x.exitT)) * costs.pipSize;
        return x.r - costPrice / x.rAbs;
      });
      const nc = normalCI(arr);
      const nb = bootstrapCI(arr);
      netBy[key2] = {
        spreadMult: SPREAD_MULTS[sTag], swapMult: SWAP_MULTS[wTag],
        point: nc.mean != null ? +nc.mean.toFixed(6) : null,
        lo: nc.lo != null ? +nc.lo.toFixed(6) : null,
        hi: nc.hi != null ? +nc.hi.toFixed(6) : null,
        bootLo: nb.lo != null ? +nb.lo.toFixed(6) : null,
        bootHi: nb.hi != null ? +nb.hi.toFixed(6) : null,
        bootUsed: nb.lo != null,
      };
    }
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
    avgRPips: (() => { const a = trades.map((t) => t.rPips ?? null).filter((x) => x != null); return mean(a); })(),
    holdNights: nights,
    expectancy: exp.mean != null ? { gross: +exp.mean.toFixed(6), lo: +exp.lo.toFixed(6), hi: +exp.hi.toFixed(6) } : null,
    expectancyBoot: boot.lo != null ? { lo: +boot.lo.toFixed(6), hi: +boot.hi.toFixed(6) } : { lo: null, hi: null, skipped: boot.skipped ?? null },
    expectancyNet: netBy,
    gapSensitive: { count: gapCount, expectancy: expGap.mean != null ? { gross: +expGap.mean.toFixed(6), lo: +expGap.lo.toFixed(6), hi: +expGap.hi.toFixed(6) } : null },
    sufficient: n >= MIN_BUCKET,
  };
}

// weekly consistency (to the extent the short window allows)
function weeklyStats(trades, key) {
  const byWeek = new Map();
  for (const t of trades) {
    const v = t[key];
    if (v.type === 'CENSORED' || v.r == null) continue;
    // ISO-ish week key: Monday 00:00 UTC of the ENTRY candle's week
    const d = new Date(t.entryT);
    const day = (d.getUTCDay() + 6) % 7;                 // Mon=0
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
    const wk = new Date(monday).toISOString().slice(0, 10);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push({ r: v.r, type: v.type });
  }
  const out = {};
  for (const [wk, arr] of [...byWeek.entries()].sort()) {
    const w = arr.filter((x) => x.type === 'TP').length;
    const l = arr.filter((x) => x.type === 'SL').length;
    const to = arr.filter((x) => x.type === 'TIMEOUT').length;
    const exp = mean(arr.map((x) => x.r));
    out[wk] = { n: arr.length, w, l, to, expectancy: exp != null ? +exp.toFixed(4) : null, sufficient: arr.length >= MIN_BUCKET };
  }
  return out;
}

function main() {
  const startedIso = new Date().toISOString();
  const auditPath = join(RESULTS, 'FRVP_FX1H_audit.jsonl.gz');
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
  // entryT needed downstream for swap-night reconstruction
  const all = runs.flatMap((r) => r.tradesOut.map((t) => ({ ...t, entryT: t.t + FRVPFX_MS_1H, rPips: t.rAbs / FX_COSTS[t.pair].pipSize })));
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
  const weekly = {
    tp15: weeklyStats(all, 'v15'),
    tp3: weeklyStats(all, 'v3'),
    tpPoc: weeklyStats(all, 'vPoc'),
  };

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
    multiNightTrades: runs.reduce((a, r) => a + r.multiNightTrades, 0),
    perPairEvaluated: Object.fromEntries(runs.map((r) => [r.pair, r.evaluated])),
    perPairTrades: Object.fromEntries(runs.map((r) => [r.pair, r.trades])),
  };
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.funnel.decisions)) funnel.decisions[k] = (funnel.decisions[k] || 0) + v;
    for (const [k, v] of Object.entries(r.funnel.reasons)) funnel.reasons[k] = (funnel.reasons[k] || 0) + v;
    for (const tag of ['v15', 'v3', 'vPoc']) {
      for (const [k, v] of Object.entries(r.funnel.resolutions[tag])) funnel.resolutions[tag][k] = (funnel.resolutions[tag][k] || 0) + v;
    }
  }

  const summary = {
    engine: 'FRVP fade FX 1h + triple-barrier R:R exit — 50-bin trailing-480h tick-volume profile, VA 70% fade of VAH/VAL pierce-and-reject, SL = trigger wick + 0.1x range, TP variants 1.5R / 3R / POC, max hold 240h; standalone module src/strategy/frvpFadeFx1h.mjs + backtest/tripleBarrier.mjs (UNCHANGED from feature/frvp-rr)',
    startedAt: startedIso,
    auditFile: 'results/FRVP_FX1H_audit.jsonl.gz',
    mode: 'single fetched block 2026-06..2026-09, one pass, no split (parameters frozen pre-run, commit 2af0ad2); first 480 hourly candles per pair are profile warmup; per-pair evaluable counts reported, not padded',
    frozenParams: {
      bins: FRVPFX_BINS, vaPct: FRVPFX_VA_PCT, bufferX: FRVPFX_BUFFER_X,
      maxHoldHours: FRVPFX_MAX_HOLD_HOURS, windowBars: FRVPFX_WINDOW_BARS,
      tpR1: FRVPFX_TP_R1, tpR2: FRVPFX_TP_R2,
      profileWindowRule: '480 closed 1h candles with close time strictly before the trigger close (trigger candle excluded)',
      tieBreaks: 'POC tie -> lowest-priced bin; VA expansion tie -> UP first; strict trigger inequalities',
      costAssumptions: { perPair: FX_COSTS, spreadMults: SPREAD_MULTS, swapMults: SWAP_MULTS, swapNightRule: 'flat charge per UTC-midnight crossed during the hold, both directions (conservative: real swaps are directional, sometimes positive)' },
    },
    dataCaveats: {
      tickVolume: 'FX volume is a tick-count proxy (histdata quote-update count per hour), NEVER real traded volume; VAH/VAL/POC are built from that proxy',
      shortWindow: 'evaluable window is ~75 calendar days per pair after warmup — far shorter than the crypto 12-month test; expect wide confidence intervals',
      source: 'histdata.com free tick feed (TwelveData unusable: no locally accessible key; demo whitelist = EUR/USD+USD/JPY only; forex rows carry no volume field)',
    },
    minBucket: MIN_BUCKET,
    bootstrap: { seed: BOOTSTRAP_SEED, iters: BOOTSTRAP_ITERS, maxN: BOOTSTRAP_MAX_N },
    data: runs.map((r) => ({
      pair: r.pair, source: r.meta.source, aggregation: r.meta.aggregation,
      first: r.meta.first, last: r.meta.last, h1Candles: r.h1Count,
      ticks: r.meta.ticks, gapHours: r.meta.gapHoursCount,
      duplicateTickTs: r.meta.duplicateTickTs, backwardsJitterSkipped: r.meta.backwardsJitterSkipped,
      evaluated: r.evaluated, trades: r.trades, overlapped: r.overlapped,
    })),
    funnel,
    variants,
    byPair,
    byDirection: byDir,
    weekly,
    gate,
  };
  writeFileSync(join(RESULTS, 'FRVP_FX1H_summary.json'), JSON.stringify(summary, null, 2));

  // ── console headline ───────────────────────────────────────────────────────
  console.log('\n══ FRVP-FX1H FADE + TRIPLE-BARRIER R:R — short-window block, one pass ══');
  console.log(`funnel: evaluated=${funnel.evaluatedBars} decisions=${JSON.stringify(funnel.decisions)}`);
  console.log(`        noTradeReasons=${JSON.stringify(funnel.reasons)}`);
  console.log(`        trades=${funnel.trades} pocDegenerate=${funnel.pocDegenerate} overlapShare=${(100 * funnel.overlapShare).toFixed(1)}% multiNight(>=2)=${funnel.multiNightTrades}`);
  const f = (x) => (x == null ? '-' : (100 * x).toFixed(1) + '%');
  const r6f = (x) => (x == null ? '-' : (+x).toFixed(3));
  for (const [k, label] of [['tp15', 'TP 1.5R'], ['tp3', 'TP 3R'], ['tpPoc', 'TP POC']]) {
    const v = variants[k];
    if (v.n === 0) { console.log(`\n${label}: NO DECIDED TRADES`); continue; }
    console.log(`\n${label}: n=${v.n} (W=${v.wins} L=${v.losses} TO=${v.timeouts} CEN=${v.censored})${v.sufficient ? '' : ' [BELOW MIN-BUCKET 30]'}`);
    console.log(`  WR=${f(v.wr)} Wilson=[${f(v.wrLo)}, ${f(v.wrHi)}]  conservative=${f(v.conservativeWr)}  timeoutRate=${f(v.timeoutRate)}`);
    console.log(`  expectancy gross=${r6f(v.expectancy.gross)} R  CI=[${r6f(v.expectancy.lo)}, ${r6f(v.expectancy.hi)}]  (normal)`);
    if (v.expectancyBoot.lo != null) console.log(`  expectancy gross bootstrap=[${r6f(v.expectancyBoot.lo)}, ${r6f(v.expectancyBoot.hi)}]`);
    for (const [ck, cv] of Object.entries(v.expectancyNet)) {
      console.log(`  net [spread x${cv.spreadMult}, swap x${cv.swapMult}]: ${r6f(cv.point)} R CI=[${r6f(cv.lo)}, ${r6f(cv.hi)}]${cv.bootUsed ? ` boot=[${r6f(cv.bootLo)}, ${r6f(cv.bootHi)}]` : ''}`);
    }
    console.log(`  avgWinR=${r6f(v.avgWinR)} avgTimeoutR=${r6f(v.avgTimeoutR)} avgR_pips=${r6f(v.avgRPips)} gapSensitive(${v.gapSensitive.count})=${r6f(v.gapSensitive.expectancy?.gross)}`);
    console.log(`  GATE: ${gate[k].pass ? 'PASS' : 'FAIL'} (net ${gate[k].ciSource} lo ${r6f(gate[k].netLoUsed)} ${gate[k].pass ? '>' : '<='} 0)`);
  }
  console.log('\nper pair (n / WR / gross expectancy / net-base expectancy):');
  for (const p of PAIRS) {
    const b = byPair[p];
    const row = (vv) => vv.n === 0 ? '-/-/-/-' : `${vv.n}/${f(vv.wr)}/${r6f(vv.expectancy.gross)}/${r6f(vv.expectancyNet.base.point)}${vv.sufficient ? '' : '[<30]'}`;
    console.log(`  ${p.padEnd(8)} 1.5R ${row(b.tp15)}  3R ${row(b.tp3)}  POC ${row(b.tpPoc)}`);
  }
  console.log('\nweekly consistency (n / expectancy gross) per variant:');
  for (const [k, label] of [['tp15', '1.5R'], ['tp3', '3R'], ['tpPoc', 'POC']]) {
    const wk = weekly[k];
    console.log(`  ${label}: ` + Object.entries(wk).map(([w2, s]) => `${w2.slice(5)} n=${s.n} E=${s.expectancy ?? '-'}${s.sufficient ? '' : '[<30]'}`).join(' | '));
  }
  console.log(`\naudit: ${auditPath.replace(ROOT + '/', '')}`);
}

main();

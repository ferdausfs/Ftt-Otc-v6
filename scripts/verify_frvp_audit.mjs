/**
 * FRVP audit verifier — INDEPENDENT re-derivation of every reported number.
 *
 * Fresh code (does NOT import src/strategy/frvpFade.mjs, backtest/
 * tripleBarrier.mjs, or backtest/harness_frvp.mjs): re-implements the profile
 * math, the barrier construction, and the triple-barrier walk from the frozen
 * spec text, then checks the audit + summary end to end.
 *
 * Checks:
 *   A. file/row integrity: every TRD row has a matching M1 row; M1 rows only
 *      inside the frozen window; OHLC invariants; evaluated counts.
 *   B. profile re-derivation on sampled M1 rows (every 997th + every trigger
 *      M1 + 2,000 random): window = candles[i-1440..i-1] (strictly-before
 *      rule), inline reference build -> poc/vah/val/wlo/whi/tv match.
 *   C. trade re-resolution for EVERY trade x 3 variants: SL from the raw
 *      trigger candle + 0.1x range, TP prices from entry/R, POC degeneracy,
 *      independent walk (inclusive touches, both->SL, fills at barrier,
 *      TIMEOUT at 120m, CENSORED on data end) -> type/exit price/R/minutes/
 *      gap flag all match the audit row.
 *   D. full re-aggregation: funnel, W/L/TO/CEN, Wilson WR, expectancy
 *      (gross + net at 0.05/0.10/0.20% per side), timeout rate, per pair,
 *      by direction, degenerate-POC count, gate booleans, bootstrap CI
 *      reproduction (same seed) -> byte-equal to FRVP_summary.json at its
 *      rounding.
 *   E. monthly expectancy consistency table (reported, not gated).
 *
 * Run: node scripts/verify_frvp_audit.mjs
 */
import { readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ms');
const RESULTS = join(ROOT, 'results');
const WIN_START = Date.UTC(2023, 6, 5, 0, 0, 0);
const WIN_END = Date.UTC(2024, 6, 5, 0, 0, 0);
const MS_1M = 60_000;
const BINS = 50, VA_PCT = 0.70, BUFFER_X = 0.1, MAX_HOLD_MIN = 120, WINDOW = 1440;
const TP_R1 = 1.5, TP_R2 = 3.0;
const PAIRS = ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD'];
const BOOT_SEED = 20260908, BOOT_ITERS = 5_000, BOOT_MAX_N = 60_000;

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
const close = (a, b, tol = 1e-6) => (a == null || b == null ? a === b : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)));

// ── independent profile build (fresh implementation) ────────────────────────
function profileOf(win) {
  let lo = Infinity, hi = -Infinity, tv = 0;
  for (const c of win) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; tv += c.v; }
  if (!(hi > lo) || !(tv > 0)) return { degenerate: true };
  const w = (hi - lo) / BINS;
  const bv = new Float64Array(BINS);
  for (const c of win) {
    const { l, h, v } = c;
    if (!(v > 0)) continue;
    if (h === l) {
      let k = Math.floor((l - lo) / w); k = Math.max(0, Math.min(BINS - 1, k));
      bv[k] += v; continue;
    }
    const fLo = Math.max(0, (l - lo) / w), fHi = Math.min(BINS, (h - lo) / w);
    const span = fHi - fLo;
    if (!(span > 0)) continue;
    const k0 = Math.max(0, Math.min(BINS - 1, Math.floor(fLo)));
    const k1 = Math.max(0, Math.min(BINS - 1, Math.floor(Math.max(fHi - 1e-12, fLo))));
    for (let k = k0; k <= k1; k++) {
      const len = Math.min(fHi, k + 1) - Math.max(fLo, k);
      if (len > 0) bv[k] += v * (len / span);
    }
  }
  let poc = 0; for (let k = 1; k < BINS; k++) if (bv[k] > bv[poc]) poc = k;
  const pocPrice = lo + (poc + 0.5) * w;
  let vaLo = poc, vaHi = poc, cum = bv[poc];
  const target = VA_PCT * tv;
  let kLo = poc - 1, kHi = poc + 1;
  while (cum < target && (kLo >= 0 || kHi <= BINS - 1)) {
    let k;
    if (kLo < 0) k = kHi++;
    else if (kHi > BINS - 1) k = kLo--;
    else k = (bv[kHi] >= bv[kLo]) ? kHi++ : kLo--;
    cum += bv[k];
    if (k < vaLo) vaLo = k; if (k > vaHi) vaHi = k;
  }
  return { degenerate: false, lo, hi, tv, poc, pocPrice, vah: lo + (vaHi + 1) * w, val: lo + vaLo * w };
}

// ── independent triple-barrier walk (fresh implementation) ──────────────────
function walk(candles, firstIdx, dir, entry, sl, tp, entryT) {
  const holdEnd = entryT + MAX_HOLD_MIN * MS_1M;
  let last = null;
  for (let i = firstIdx; i < candles.length; i++) {
    const c = candles[i];
    if (c.t + MS_1M > holdEnd) break;
    last = c;
    const slT = dir === 'SHORT' ? c.h >= sl : c.l <= sl;
    const tpT = tp != null && (dir === 'SHORT' ? c.l <= tp : c.h >= tp);
    if (slT || tpT) {
      const type = slT ? 'SL' : 'TP';
      const px = slT ? sl : tp;
      const gap = slT && (dir === 'SHORT' ? c.o >= sl : c.o <= sl);
      return { type, px, closeT: c.t + MS_1M, open: c.o, gap, both: slT && tpT };
    }
  }
  if (!last) return { type: 'CENSORED', px: null, closeT: null, open: null, gap: false, both: false };
  const exact = last.t + MS_1M === holdEnd;
  return { type: exact ? 'TIMEOUT' : 'CENSORED', px: last.c, closeT: last.t + MS_1M, open: last.o, gap: false, both: false };
}

// ── stats (fresh implementation) ────────────────────────────────────────────
function wilson(w, n) {
  if (!n) return { wr: null, lo: null, hi: null };
  const z = 1.959963985, p = w / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function normalCI(a) {
  const n = a.length; if (!n) return { mean: null, lo: null, hi: null };
  const m = mean(a);
  let v = 0; for (const x of a) v += (x - m) * (x - m);
  const s = n > 1 ? Math.sqrt(v / (n - 1)) : null;
  if (s == null) return { mean: m, lo: null, hi: null };
  const half = 1.959963985 * s / Math.sqrt(n);
  return { mean: m, lo: m - half, hi: m + half };
}
function bootCI(a) {
  const n = a.length;
  if (!n || n > BOOT_MAX_N) return { lo: null, hi: null };
  let s = BOOT_SEED >>> 0;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const ms = new Float64Array(BOOT_ITERS);
  for (let it = 0; it < BOOT_ITERS; it++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += a[(rnd() * n) | 0];
    ms[it] = sum / n;
  }
  ms.sort();
  return { lo: ms[Math.floor(0.025 * BOOT_ITERS)], hi: ms[Math.ceil(0.975 * BOOT_ITERS) - 1] };
}
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(6));
const r8 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(8));

// ── load audit (buffer gunzip — audit fits in memory comfortably) ───────────
async function main() {
  console.log('loading audit...');
  const { gunzipSync } = await import('node:zlib');
  const buf = gunzipSync(readFileSync(join(RESULTS, 'FRVP_audit.jsonl.gz')));
  const lines = buf.toString('utf8').split('\n');
  const m1 = [], trd = [];
  for (const ln of lines) {
    if (!ln) continue;
    const row = JSON.parse(ln);
    if (row.k === 'M1') m1.push(row);
    else if (row.k === 'TRD') trd.push(row);
  }
  console.log(`rows: M1=${m1.length} TRD=${trd.length}`);
  const summary = JSON.parse(readFileSync(join(RESULTS, 'FRVP_summary.json'), 'utf8'));

  // per-pair candle maps
  const pairData = new Map();
  for (const p of PAIRS) {
    const name = p.replace('/', '');
    const { candles } = JSON.parse(readFileSync(join(DATA, `${name}_1m.json`), 'utf8'));
    pairData.set(p, candles);
  }
  const idxByT = new Map();   // per pair handled via sorted t -> index map
  const tIndex = new Map();
  for (const p of PAIRS) {
    const c = pairData.get(p);
    const m = new Map();
    for (let i = 0; i < c.length; i++) m.set(c[i].t, i);
    tIndex.set(p, m);
  }

  // ── A. row integrity ──────────────────────────────────────────────────────
  check('A/m1 count == summary evaluated', m1.length === summary.funnel.evaluatedBars, `${m1.length} vs ${summary.funnel.evaluatedBars}`);
  check('A/trd count == summary trades', trd.length === summary.funnel.trades, `${trd.length} vs ${summary.funnel.trades}`);
  const m1ByKey = new Map();
  let okInWin = true, okOhlc = true, bad = '';
  for (const r of m1) {
    if (r.t + MS_1M < WIN_START || r.t + MS_1M > WIN_END) { okInWin = false; bad = `${r.p}@${r.t}`; break; }
    if (!(r.h >= r.l && r.h >= r.o - 1e-9 && r.h >= r.c - 1e-9 && r.l <= r.o + 1e-9 && r.l <= r.c + 1e-9)) { okOhlc = false; bad = `${r.p}@${r.t}`; break; }
    m1ByKey.set(r.p + '|' + r.t, r);
  }
  check('A/m1 rows all inside frozen window (close-time)', okInWin, bad);
  check('A/m1 OHLC invariants', okOhlc, bad);
  const m1ByPair = new Map(PAIRS.map((p) => [p, 0]));
  for (const r of m1) m1ByPair.set(r.p, m1ByPair.get(r.p) + 1);
  check('A/m1 per-pair == 527,041', PAIRS.every((p) => m1ByPair.get(p) === 527041), JSON.stringify([...m1ByPair]));

  let okMatch = true; bad = '';
  for (const t of trd) {
    const m = m1ByKey.get(t.p + '|' + t.t);
    if (!m || (m.d !== 'PUT' && m.d !== 'CALL') || m.d !== t.dir) { okMatch = false; bad = `${t.p}@${t.t}`; break; }
  }
  check('A/every TRD has matching trigger M1', okMatch, bad);

  // ── B. profile re-derivation on sampled rows ──────────────────────────────
  const sampleIdx = new Set();
  for (let i = 0; i < m1.length; i += 997) sampleIdx.add(i);
  for (let i = 0; i < m1.length; i += 1) { if (m1[i].d === 'PUT' || m1[i].d === 'CALL') sampleIdx.add(i); if (sampleIdx.size > 20000) break; }
  let extra = 0;
  while (extra < 2000) { sampleIdx.add(Math.floor(Math.random() * m1.length)); extra++; }
  let okProf = true; bad = ''; let profChecked = 0;
  for (const i of sampleIdx) {
    const r = m1[i];
    const c = pairData.get(r.p);
    const idx = tIndex.get(r.p).get(r.t);
    if (idx == null || idx < WINDOW) { okProf = false; bad = `idx ${r.p}@${r.t}`; break; }
    const p = profileOf(c.slice(idx - WINDOW, idx));
    profChecked++;
    if (p.degenerate || close(r.poc, p.pocPrice) === false || close(r.vah, p.vah) === false
      || close(r.val, p.val) === false || close(r.wlo, p.lo) === false || close(r.whi, p.hi) === false
      || close(r.tv, p.tv) === false) {
      okProf = false; bad = `prof ${r.p}@${r.t} row=(${r.poc},${r.vah},${r.val},${r.wlo},${r.whi},${r.tv}) re=(${p.pocPrice},${p.vah},${p.val},${p.lo},${p.hi},${p.tv})`;
      break;
    }
    if (profChecked >= 25000) break;
  }
  check(`B/profile re-derived on ${profChecked} sampled rows`, okProf, bad);

  // ── C. trade re-resolution (EVERY trade, 3 variants) ─────────────────────
  let okTrades = true; bad = ''; let tradeChecked = 0;
  const reResolved = [];
  for (const t of trd) {
    const c = pairData.get(t.p);
    const idx = tIndex.get(t.p).get(t.t);
    if (idx == null) { okTrades = false; bad = `no candle ${t.p}@${t.t}`; break; }
    const trig = c[idx];
    // barrier construction from the RAW trigger candle
    const range = trig.h - trig.l;
    if (!(range > 0)) { okTrades = false; bad = `zero-range trigger in audit ${t.p}@${t.t}`; break; }
    const buf = BUFFER_X * range;
    const sl = t.dir === 'PUT' ? trig.h + buf : trig.l - buf;
    const entry = trig.c;
    const rAbs = t.dir === 'PUT' ? sl - entry : entry - sl;
    const dir = t.dir === 'PUT' ? 'SHORT' : 'LONG';
    if (!(close(t.en, entry) && close(t.sl, sl) && close(t.ra, rAbs) && close(t.buf, buf))) {
      okTrades = false; bad = `barriers ${t.p}@${t.t} row=(${t.en},${t.sl},${t.ra}) re=(${entry},${sl},${rAbs})`;
      break;
    }
    const rFracExact = rAbs / entry;
    if (!close(t.rf, rFracExact, 1e-6)) { okTrades = false; bad = `rFrac ${t.p}@${t.t} row=${t.rf} re=${rFracExact}`; break; }
    const entryT = trig.t + MS_1M;
    // re-derive the EXACT profile context from raw candles (the audit row's
    // poc/vah/val are r6-rounded display values; barriers must use full
    // precision — a rounded POC can move a touch to an adjacent candle)
    const prof = profileOf(c.slice(idx - WINDOW, idx));
    if (prof.degenerate
      || !close(t.poc, prof.pocPrice) || !close(t.vah, prof.vah) || !close(t.val, prof.val)
      || !close(t.wlo, prof.lo) || !close(t.whi, prof.hi) || !close(t.tv, prof.tv)) {
      okTrades = false; bad = `profile ${t.p}@${t.t} row=(${t.poc},${t.vah},${t.val}) re=(${prof.pocPrice},${prof.vah},${prof.val})`;
      break;
    }
    const tps = { v15: entry + (dir === 'SHORT' ? -TP_R1 : TP_R1) * rAbs, v3: entry + (dir === 'SHORT' ? -TP_R2 : TP_R2) * rAbs };
    // POC degeneracy + tpPoc (exact POC price)
    const poc = prof.pocPrice;
    const degen = t.dir === 'PUT' ? !(poc < entry) : !(poc > entry);
    if ((t.dg === 1) !== degen) { okTrades = false; bad = `degen ${t.p}@${t.t}`; break; }
    const vPocTp = degen ? null : poc;
    const checks = [];
    for (const [key, tp] of [['v15', tps.v15], ['v3', tps.v3], ['vPoc', vPocTp]]) {
      const r = walk(c, idx + 1, dir, entry, sl, tp, entryT);
      const rowV = t[key];
      const signed = (px) => (px == null ? null : +((dir === 'SHORT' ? entry - px : px - entry) / rAbs).toFixed(8));
      const rr = signed(r.px);
      const ro = (r.type === 'SL' && r.gap) ? +((dir === 'SHORT' ? entry - r.open : r.open - entry) / rAbs).toFixed(8) : null;
      if (rowV.res !== r.type
        || !close(rowV.px, tp == null ? null : tp, 1e-6)
        || !close(rowV.x, r.px, 1e-6)
        || !close(rowV.r, rr, 1e-8)
        || rowV.m !== (r.closeT == null ? 0 : Math.round((r.closeT - entryT) / MS_1M))
        || (rowV.g ? 1 : 0) !== (r.gap ? 1 : 0)
        || !close(rowV.ro ?? null, ro, 1e-8)) {
        okTrades = false;
        bad = `walk ${t.p}@${t.t} ${key}: row=(${rowV.res},${rowV.x},${rowV.r},${rowV.m},${rowV.g}) re=(${r.type},${r.px},${rr},${r.closeT == null ? 0 : Math.round((r.closeT - entryT) / MS_1M)},${r.gap ? 1 : 0})`;
        break;
      }
      checks.push({ key, res: r.type, r: rr, m: r.closeT == null ? 0 : Math.round((r.closeT - entryT) / MS_1M), g: r.gap ? 1 : 0, ro });
    }
    if (!okTrades) break;
    tradeChecked++;
    reResolved.push({ pair: t.p, dir: t.dir, t: t.t, rFrac: rFracExact, dg: degen, closeT: entryT, v15: checks[0], v3: checks[1], vPoc: checks[2] });
  }
  check(`C/all ${tradeChecked} trades re-resolved (3 variants each)`, okTrades && tradeChecked === trd.length, bad);

  // ── D. re-aggregation ─────────────────────────────────────────────────────
  function agg(rows, key) {
    let w = 0, l = 0, to = 0, cen = 0, gap = 0;
    const decided = [], fracs = [], wins = [], tos = [];
    for (const t of rows) {
      const v = t[key];
      if (v.res === 'TP') { w++; decided.push(v.r); fracs.push(t.rFrac); wins.push(v.r); }
      else if (v.res === 'SL') { l++; decided.push(v.r); fracs.push(t.rFrac); if (v.g) gap++; }
      else if (v.res === 'TIMEOUT') { to++; decided.push(v.r); fracs.push(t.rFrac); tos.push(v.r); }
      else cen++;
    }
    const n = w + l + to;
    const wil = wilson(w, w + l);
    const exp = normalCI(decided);
    const net = {};
    for (const [tag, ps] of [['low', 0.0005], ['base', 0.001], ['high', 0.002]]) {
      const arr = decided.map((r, i2) => r - (2 * ps) / fracs[i2]);
      const nc = normalCI(arr); const nb = bootCI(arr);
      net[tag] = { perSide: ps, point: nc.mean != null ? +nc.mean.toFixed(6) : null, lo: nc.lo != null ? +nc.lo.toFixed(6) : null, hi: nc.hi != null ? +nc.hi.toFixed(6) : null, bootLo: nb.lo != null ? +nb.lo.toFixed(6) : null, bootHi: nb.hi != null ? +nb.hi.toFixed(6) : null, bootUsed: nb.lo != null };
    }
    return {
      n, wins: w, losses: l, timeouts: to, censored: cen,
      wr: wil.wr, wrLo: wil.lo, wrHi: wil.hi,
      conservativeWr: wilson(w, w + l + to).wr,
      timeoutRate: n + cen ? to / (n + cen) : null,
      avgWinR: mean(wins), avgTimeoutR: mean(tos),
      expectancy: exp.mean != null ? { gross: +exp.mean.toFixed(6), lo: +exp.lo.toFixed(6), hi: +exp.hi.toFixed(6) } : null,
      expectancyNet: net, gapCount: gap, sufficient: n >= 30,
    };
  }
  const vStats = { tp15: agg(reResolved, 'v15'), tp3: agg(reResolved, 'v3'), tpPoc: agg(reResolved, 'vPoc') };
  for (const [k, v] of Object.entries(vStats)) {
    const s = summary.variants[k];
    check(`D/${k} n`, v.n === s.n);
    check(`D/${k} W/L/TO/CEN`, v.wins === s.wins && v.losses === s.losses && v.timeouts === s.timeouts && v.censored === s.censored, `${JSON.stringify({ w: v.wins, l: v.losses, to: v.timeouts, c: v.censored })} vs ${JSON.stringify({ w: s.wins, l: s.losses, to: s.timeouts, c: s.censored })}`);
    check(`D/${k} WR`, close(v.wr, s.wr, 1e-9) && close(v.wrLo, s.wrLo, 1e-9) && close(v.wrHi, s.wrHi, 1e-9));
    check(`D/${k} conservative+timeoutRate`, close(v.conservativeWr, s.conservativeWr, 1e-9) && close(v.timeoutRate, s.timeoutRate, 1e-9));
    check(`D/${k} avgWinR/avgTimeoutR`, close(v.avgWinR, s.avgWinR, 1e-6) && close(v.avgTimeoutR, s.avgTimeoutR, 1e-6));
    check(`D/${k} expectancy`, v.expectancy && s.expectancy && close(v.expectancy.gross, s.expectancy.gross) && close(v.expectancy.lo, s.expectancy.lo) && close(v.expectancy.hi, s.expectancy.hi));
    for (const tag of ['low', 'base', 'high']) {
      const a = v.expectancyNet[tag], b = s.expectancyNet[tag];
      check(`D/${k} net@${tag}`, close(a.point, b.point) && close(a.lo, b.lo) && close(a.hi, b.hi) && close(a.bootLo ?? undefined, b.bootLo ?? undefined) && close(a.bootHi ?? undefined, b.bootHi ?? undefined));
    }
    check(`D/${k} sufficient`, v.sufficient === s.sufficient);
  }
  // funnel re-aggregation
  const dec = { NO_TRADE: 0, PUT: 0, CALL: 0 };
  for (const r of m1) dec[r.d]++;
  check('D/funnel decisions', dec.NO_TRADE === summary.funnel.decisions.NO_TRADE && dec.PUT === summary.funnel.decisions.PUT && dec.CALL === summary.funnel.decisions.CALL);
  // per-pair + by-direction
  for (const p of PAIRS) {
    const sub = reResolved.filter((t) => t.pair === p);
    for (const [k, key] of [['tp15', 'v15'], ['tp3', 'v3'], ['tpPoc', 'vPoc']]) {
      const a = agg(sub, key), b = summary.byPair[p][k];
      check(`D/byPair ${p} ${k}`, a.n === b.n && a.wins === b.wins && a.losses === b.losses && close(a.expectancy?.gross, b.expectancy?.gross) && close(a.wr, b.wr, 1e-9));
    }
  }
  for (const d of ['PUT', 'CALL']) {
    const sub = reResolved.filter((t) => t.dir === d);
    for (const [k, key] of [['tp15', 'v15'], ['tp3', 'v3'], ['tpPoc', 'vPoc']]) {
      const a = agg(sub, key), b = summary.byDirection[d][k];
      check(`D/byDir ${d} ${k}`, a.n === b.n && a.wins === b.wins && a.losses === b.losses && close(a.expectancy?.gross, b.expectancy?.gross));
    }
  }
  // gate reproduction
  for (const [k, v] of Object.entries(vStats)) {
    const g = summary.gate[k];
    const net = v.expectancyNet.base;
    const loUsed = net.bootUsed ? net.bootLo : net.lo;
    check(`D/gate ${k}`, g.pass === Boolean(v.sufficient && loUsed != null && loUsed > 0) && g.n === v.n && close(g.netLoUsed, loUsed));
  }
  // bootstrap reproduction on gross (already covered via net boot; do gross explicitly)
  for (const [k, key] of [['tp15', 'v15'], ['tp3', 'v3'], ['tpPoc', 'vPoc']]) {
    const arr = reResolved.filter((t) => t[key].res !== 'CENSORED').map((t) => t[key].r);
    const nb = bootCI(arr);
    check(`D/boot gross ${k}`, nb.lo != null && summary.variants[k].expectancyBoot.lo != null
      ? close(nb.lo, summary.variants[k].expectancyBoot.lo) : true);
  }
  // degenerate count
  check('D/pocDegenerate count', reResolved.filter((t) => t.dg).length === summary.funnel.pocDegenerate);
  // CENSORED must be 0 (tail fully resolves) — assert explicitly
  check('D/zero censored trades', vStats.tp15.censored === 0 && vStats.tp3.censored === 0 && vStats.tpPoc.censored === 0);

  // ── E. monthly expectancy consistency (reported, informational) ──────────
  const months = new Map();
  for (const t of reResolved) {
    const mo = new Date(t.closeT).toISOString().slice(0, 7);
    if (!months.has(mo)) months.set(mo, []);
    months.get(mo).push(t);
  }
  const monthly = {};
  for (const [mo, rows] of [...months.entries()].sort()) {
    monthly[mo] = { n: rows.length, tp15: +mean(rows.map((t) => t.v15.r)).toFixed(4), tp3: +mean(rows.map((t) => t.v3.r)).toFixed(4), tpPoc: +mean(rows.map((t) => t.vPoc.r)).toFixed(4) };
  }

  console.log(`\nverify_frvp_audit: ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.join('\n')); process.exit(1); }
  console.log('\nmonthly gross expectancy (informational):');
  for (const [mo, m] of Object.entries(monthly)) {
    console.log(`  ${mo} n=${String(m.n).padStart(5)}  1.5R=${m.tp15}  3R=${m.tp3}  POC=${m.tpPoc}`);
  }
  const { writeFileSync: wf } = await import('node:fs');
  wf(join(RESULTS, 'FRVP_monthly.json'), JSON.stringify(monthly, null, 2));
}

main().catch((e) => { console.error('VERIFIER FAILED:', e); process.exit(1); });

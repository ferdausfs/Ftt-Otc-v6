/**
 * Independent verifier for the FRVP-FX1H audit — re-derives EVERYTHING from
 * the raw candle files + the audit stream with FRESH code (no imports from
 * the strategy module or the harness beyond the UNCHANGED engine contract,
 * which is re-implemented inline here too).
 *
 * Philosophy (same as the crypto verifier): the harness's numbers are
 * trusted only insofar as they can be reproduced from the audit + raw data
 * by an independent implementation. Checks:
 *   1. Audit integrity: every H1 row matches the raw 1h candle (OHLC exact),
 *      timestamps align, every post-warmup bar appears exactly once per pair.
 *   2. Every TRD row: re-derive the profile (independent builder), the
 *      trigger decision, SL/R/TP levels, and re-walk ALL THREE variants
 *      candle by candle from the raw series — resolution type, exit time,
 *      exit price, realized R, hours held, gap flag must match.
 *   3. Funnel: decisions/reasons/resolutions re-counted from rows.
 *   4. Statistics: WR + Wilson, expectancy (normal + seeded bootstrap),
 *      net expectancy under the frozen per-pair cost model (spread + swap
 *      nights), per-pair/per-direction, weekly buckets, gate — re-derived
 *      from TRD rows and compared to the summary JSON.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MS_1H = 3_600_000;
const BINS = 50, VA = 0.70, BUF_X = 0.1, HOLD_H = 240, WIN = 480;
const TP_R1 = 1.5, TP_R2 = 3.0;
const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];
const FX_COSTS = {
  'EUR/USD': { pipSize: 0.0001, spreadPips: 1.0, swapPipsPerNight: 1.0 },
  'GBP/USD': { pipSize: 0.0001, spreadPips: 1.5, swapPipsPerNight: 1.0 },
  'USD/JPY': { pipSize: 0.01,   spreadPips: 1.2, swapPipsPerNight: 1.0 },
  'AUD/USD': { pipSize: 0.0001, spreadPips: 1.2, swapPipsPerNight: 1.0 },
};
const BOOTSTRAP_SEED = 20260908, BOOTSTRAP_ITERS = 5_000;

let pass = 0, fail = 0; const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
}
function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { wr: null, lo: null, hi: null };
  const p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function sd(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }
function normalCI(a) { const n = a.length, m = mean(a), s = sd(a); if (n === 0 || s == null) return { lo: null, hi: null, mean: m }; const h = 1.959963985 * s / Math.sqrt(n); return { mean: m, lo: m - h, hi: m + h }; }
function bootstrapCI(a, iters = BOOTSTRAP_ITERS, seed = BOOTSTRAP_SEED) {
  const n = a.length; if (n === 0) return { lo: null, hi: null };
  let s = seed >>> 0; const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const means = new Float64Array(iters);
  for (let it = 0; it < iters; it++) { let sum = 0; for (let j = 0; j < n; j++) sum += a[(rnd() * n) | 0]; means[it] = sum / n; }
  means.sort();
  return { lo: means[Math.floor(0.025 * iters)], hi: means[Math.ceil(0.975 * iters) - 1] };
}
const nights = (a, b) => (b == null ? 0 : Math.floor(b / 86_400_000) - Math.floor(a / 86_400_000));

// ── independent profile + trigger (fresh implementation) ────────────────────
function allocVol(l, h, v, lo, width, bins) {
  if (!(v > 0) || !(width > 0)) return [];
  if (h === l) { let k = Math.floor((l - lo) / width); k = Math.max(0, Math.min(bins - 1, k)); return [[k, v]]; }
  const fLo = Math.max(0, (l - lo) / width), fHi = Math.min(bins, (h - lo) / width);
  const span = fHi - fLo; if (!(span > 0)) return [];
  const out = [];
  const kS = Math.min(bins - 1, Math.floor(fLo)), kE = Math.min(bins - 1, Math.floor(Math.max(fHi - 1e-12, fLo)));
  for (let k = kS; k <= kE; k++) {
    const len = Math.min(fHi, k + 1) - Math.max(fLo, k);
    if (len > 0) out.push([k, v * (len / span)]);
  }
  if (!out.length) out.push([kS, v]);
  return out;
}
function buildProfileIndep(win) {
  let lo = Infinity, hi = -Infinity, tv = 0;
  for (const c of win) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; tv += c.v; }
  if (!(hi > lo) || !(tv > 0)) return { degenerate: true, reason: !(hi > lo) ? 'FLAT_WINDOW' : 'ZERO_VOLUME' };
  const width = (hi - lo) / BINS;
  const bv = new Float64Array(BINS);
  for (const c of win) for (const [k, vol] of allocVol(c.l, c.h, c.v, lo, width, BINS)) bv[k] += vol;
  let poc = 0; for (let k = 1; k < BINS; k++) if (bv[k] > bv[poc]) poc = k;
  const pocPrice = lo + (poc + 0.5) * width;
  let vaLo = poc, vaHi = poc, cum = bv[poc]; const target = VA * tv;
  let kLo = poc - 1, kHi = poc + 1;
  while (cum < target && (kLo >= 0 || kHi <= BINS - 1)) {
    let k;
    if (kLo < 0) k = kHi++; else if (kHi > BINS - 1) k = kLo--;
    else k = (bv[kHi] >= bv[kLo]) ? kHi++ : kLo--;
    cum += bv[k]; if (k < vaLo) vaLo = k; if (k > vaHi) vaHi = k;
  }
  return { degenerate: false, lo, hi, totalVol: tv, pocPrice, vah: lo + (vaHi + 1) * width, val: lo + vaLo * width };
}
function decideIndep(win, trig) {
  const p = buildProfileIndep(win);
  if (p.degenerate) return { decision: 'NO_TRADE', reason: p.reason };
  const pierceTop = trig.h > p.vah, pierceBot = trig.l < p.val;
  if (pierceTop && pierceBot) return { decision: 'NO_TRADE', reason: 'BOTH_PIERCED', p };
  let decision = null;
  if (pierceTop && trig.c < p.vah) decision = 'PUT';
  else if (pierceBot && trig.c > p.val) decision = 'CALL';
  if (decision == null) return { decision: 'NO_TRADE', reason: pierceTop || pierceBot ? 'PIERCE_NO_REJECT' : 'NO_TRIGGER', p };
  const range = trig.h - trig.l;
  if (!(range > 0)) return { decision: 'NO_TRADE', reason: 'ZERO_RANGE', p };
  const entry = trig.c;
  const sl = decision === 'PUT' ? trig.h + BUF_X * range : trig.l - BUF_X * range;
  const rAbs = decision === 'PUT' ? sl - entry : entry - sl;
  const sign = decision === 'PUT' ? -1 : 1;
  const pocDegenerate = decision === 'PUT' ? !(p.pocPrice < entry) : !(p.pocPrice > entry);
  return {
    decision, reason: 'TRIGGER', p, entry, sl, rAbs,
    tp15: entry + sign * TP_R1 * rAbs, tp3: entry + sign * TP_R2 * rAbs,
    tpPoc: pocDegenerate ? null : p.pocPrice, pocDegenerate,
  };
}
/** independent triple-barrier walk (mirrors the frozen engine contract) */
function walkIndep(candles, firstIdx, direction, entry, sl, tp, entryCloseT) {
  const holdEnd = entryCloseT + HOLD_H * MS_1H;
  const isLong = direction === 'LONG';
  let last = null;
  for (let i = firstIdx; i < candles.length; i++) {
    const c = candles[i], closeT = c.t + MS_1H;
    if (closeT > holdEnd) break;
    last = i;
    const slT = isLong ? c.l <= sl : c.h >= sl;
    const tpT = tp != null && (isLong ? c.h >= tp : c.l <= tp);
    if (slT || tpT) {
      const type = slT ? 'SL' : 'TP';
      const exitPrice = slT ? sl : tp;
      const gap = slT && (isLong ? c.o <= sl : c.o >= sl);
      const r = +(((isLong ? exitPrice - entry : entry - exitPrice) / Math.abs(entry - sl))).toFixed(8);
      return { type, exitT: closeT, exitPrice, slGapFill: gap, r, hours: Math.round((closeT - entryCloseT) / MS_1H), exitIdx: i };
    }
  }
  if (last == null) return { type: 'CENSORED', exitT: null, exitPrice: null, slGapFill: false, r: null, hours: 0, exitIdx: null };
  const lastCloseT = candles[last].t + MS_1H;
  const exact = lastCloseT === holdEnd;
  const exitPrice = candles[last].c;
  const r = +(((isLong ? exitPrice - entry : entry - exitPrice) / Math.abs(entry - sl))).toFixed(8);
  return { type: exact ? 'TIMEOUT' : 'CENSORED', exitT: lastCloseT, exitPrice, slGapFill: false, r, hours: Math.round((lastCloseT - entryCloseT) / MS_1H), exitIdx: last };
}

// ── load raw + audit ────────────────────────────────────────────────────────
const raw = {};
for (const p of PAIRS) {
  raw[p] = JSON.parse(readFileSync(join(ROOT, 'backtest', 'data', 'fx1h', `${p.replace('/', '')}_1h.json`), 'utf8')).candles;
}
const auditText = gunzipSync(readFileSync(join(ROOT, 'results', 'FRVP_FX1H_audit.jsonl.gz'))).toString('utf8');
const rows = auditText.trim().split('\n').map((l) => JSON.parse(l));
const h1 = rows.filter((r) => r.k === 'H1');
const trd = rows.filter((r) => r.k === 'TRD');
check('audit/no unknown row kinds', rows.every((r) => r.k === 'H1' || r.k === 'TRD'), `${rows.length} rows`);
check('audit/row count = H1+TRD', h1.length + trd.length === rows.length, `${h1.length}+${trd.length} vs ${rows.length}`);

// ── 1. H1 rows vs raw candles ───────────────────────────────────────────────
{
  const byPair = {};
  for (const r of h1) (byPair[r.p] ??= []).push(r);
  let okAll = true, bad = '';
  for (const p of PAIRS) {
    const rs = byPair[p] ?? [];
    const candles = raw[p];
    if (rs.length !== candles.length) { okAll = false; bad = `${p}: ${rs.length} H1 rows vs ${candles.length} candles`; break; }
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i], c = candles[i];
      // rows carry 6dp-rounded prices; compare rounding-aware
      const q6 = (x) => +x.toFixed(6);
      if (r.t !== c.t || r.o !== q6(c.o) || r.h !== q6(c.h) || r.l !== q6(c.l) || r.c !== q6(c.c)) { okAll = false; bad = `${p}@${i}: row vs candle mismatch`; break; }
    }
    if (!okAll) break;
  }
  check('H1/every bar present once, OHLC == raw (all pairs)', okAll, bad);
}

// ── 2. TRD rows: full independent re-derivation ─────────────────────────────
{
  let okRow = true, okWalk = true, bad = '';
  let checkedTrades = 0, checkedVariants = 0;
  for (const t of trd) {
    const candles = raw[t.p];
    const i0 = candles.findIndex((c) => c.t === t.t);
    if (i0 < 0) { okRow = false; bad = `TRD ${t.p}@${t.t}: entry candle not found`; break; }
    if (i0 < WIN) { okRow = false; bad = `TRD ${t.p}@${t.t}: entry inside warmup (idx ${i0})`; break; }
    const d = decideIndep(candles.slice(i0 - WIN, i0), candles[i0]);
    if (d.decision !== t.dir || d.reason !== 'TRIGGER') { okRow = false; bad = `TRD ${t.p}@${t.t}: decision ${d.decision}/${d.reason} vs row ${t.dir}`; break; }
    const q = (x) => (x == null ? null : +x.toFixed(6));
    const q8 = (x) => (x == null ? null : +x.toFixed(8));
    if (q(d.entry) !== t.en || q(d.sl) !== t.sl || q8(d.rAbs) !== t.ra) { okRow = false; bad = `TRD ${t.p}@${t.t}: entry/SL/R mismatch`; break; }
    if (q(d.p.pocPrice) !== t.poc || q(d.p.vah) !== t.vah || q(d.p.val) !== t.val) { okRow = false; bad = `TRD ${t.p}@${t.t}: profile levels mismatch`; break; }
    if ((d.pocDegenerate ? 1 : 0) !== t.dg) { okRow = false; bad = `TRD ${t.p}@${t.t}: pocDegenerate mismatch`; break; }
    if (q(d.rAbs / FX_COSTS[t.p].pipSize) !== t.rp) { okRow = false; bad = `TRD ${t.p}@${t.t}: rPips mismatch`; break; }
    checkedTrades++;
    const entryCloseT = t.t + MS_1H;
    for (const [tag, tpPrice] of [['v15', d.tp15], ['v3', d.tp3], ['vPoc', d.tpPoc]]) {
      const w = walkIndep(candles, i0 + 1, t.dir === 'PUT' ? 'SHORT' : 'LONG', d.entry, d.sl, tpPrice, entryCloseT);
      const r = t[tag];
      const q2 = (x) => (x == null ? null : +x.toFixed(6));
      if (w.type !== r.res || w.exitT !== r.xT || q2(w.exitPrice) !== r.x || w.slGapFill !== !!r.g || w.hours !== r.h) {
        okWalk = false; bad = `TRD ${t.p}@${t.t} ${tag}: walk ${w.type}@${w.exitT}/${w.exitPrice}/${w.hours}h vs row ${r.res}@${r.xT}/${r.x}/${r.h}h`; break;
      }
      if ((w.r == null ? null : w.r) !== r.r) { okWalk = false; bad = `TRD ${t.p}@${t.t} ${tag}: r ${w.r} vs ${r.r}`; break; }
      checkedVariants++;
    }
    if (!okWalk) break;
  }
  check(`TRD/decision+profile re-derived independently (${checkedTrades} trades)`, okRow, bad);
  check(`TRD/all 3 variants re-walked from raw candles (${checkedVariants} walks)`, okWalk, bad);
}

// ── 3+4. funnel + statistics re-derivation from rows ───────────────────────
const S = JSON.parse(readFileSync(join(ROOT, 'results', 'FRVP_FX1H_summary.json'), 'utf8'));
{
  // funnel from H1 rows
  const decisions = {}, reasons = {};
  let evaluated = 0;
  for (const r of h1) {
    evaluated++;
    decisions[r.d] = (decisions[r.d] || 0) + 1;
    if (r.d === 'NO_TRADE') reasons[r.w] = (reasons[r.w] || 0) + 1;
  }
  check('funnel/evaluated bars', evaluated === S.funnel.evaluatedBars, `${evaluated} vs ${S.funnel.evaluatedBars}`);
  check('funnel/decisions', JSON.stringify(decisions) === JSON.stringify(S.funnel.decisions), JSON.stringify(decisions));
  check('funnel/reasons', JSON.stringify(reasons) === JSON.stringify(S.funnel.reasons), JSON.stringify(reasons));

  // resolutions per variant from TRD rows
  for (const tag of ['v15', 'v3', 'vPoc']) {
    const res = {};
    for (const t of trd) res[t[tag].res] = (res[t[tag].res] || 0) + 1;
    check(`funnel/resolutions ${tag}`, JSON.stringify(res) === JSON.stringify(S.funnel.resolutions[tag]), JSON.stringify(res));
  }
  check('funnel/trades', trd.length === S.funnel.trades, `${trd.length} vs ${S.funnel.trades}`);
  check('funnel/pocDegenerate', trd.filter((t) => t.dg).length === S.funnel.pocDegenerate);

  // per-variant stats re-derivation
  const keyOf = { v15: 'tp15', v3: 'tp3', vPoc: 'tpPoc' };
  for (const [vk, sk] of Object.entries(keyOf)) {
    const decided = [], wins = []; let w = 0, l = 0, to = 0, cen = 0;
    for (const t of trd) {
      const v = t[vk];
      if (v.res === 'TP') { w++; wins.push(v.r); decided.push({ r: v.r, rAbs: t.ra, entryT: t.t + MS_1H, exitT: v.xT, pair: t.p, spread: t.spread, swap: t.swap, pip: t.pip }); }
      else if (v.res === 'SL') { l++; decided.push({ r: v.r, rAbs: t.ra, entryT: t.t + MS_1H, exitT: v.xT, pair: t.p, spread: t.spread, swap: t.swap, pip: t.pip }); }
      else if (v.res === 'TIMEOUT') { to++; decided.push({ r: v.r, rAbs: t.ra, entryT: t.t + MS_1H, exitT: v.xT, pair: t.p, spread: t.spread, swap: t.swap, pip: t.pip }); }
      else if (v.res === 'CENSORED') cen++;
    }
    const n = w + l + to;
    const wil = wilson(w, w + l);
    const v = S.variants[sk];
    check(`${sk}/n`, n === v.n, `${n} vs ${v.n}`);
    check(`${sk}/W/L/TO/CEN`, w === v.wins && l === v.losses && to === v.timeouts && cen === v.censored);
    check(`${sk}/WR`, Math.abs(wil.wr - v.wr) < 1e-9, `${wil.wr} vs ${v.wr}`);
    check(`${sk}/WR Wilson CI`, Math.abs(wil.lo - v.wrLo) < 1e-9 && Math.abs(wil.hi - v.wrHi) < 1e-9);
    const gross = decided.map((x) => x.r);
    const nc = normalCI(gross);
    check(`${sk}/expectancy gross`, Math.abs(nc.mean - v.expectancy.gross) < 1e-6 && Math.abs(nc.lo - v.expectancy.lo) < 1e-6 && Math.abs(nc.hi - v.expectancy.hi) < 1e-6,
      `${nc.mean} vs ${v.expectancy.gross}`);
    const boot = bootstrapCI(gross);
    check(`${sk}/expectancy bootstrap`, Math.abs(boot.lo - v.expectancyBoot.lo) < 1e-6 && Math.abs(boot.hi - v.expectancyBoot.hi) < 1e-6);
    // net (base costs): recompute cost from the ROW-CARRIED per-trade cost fields
    const netArr = decided.map((x) => {
      const costPrice = (x.spread + x.swap * nights(x.entryT, x.exitT)) * x.pip;
      return x.r - costPrice / x.rAbs;
    });
    const ncNet = normalCI(netArr);
    const bootNet = bootstrapCI(netArr);
    check(`${sk}/net-base point`, Math.abs(ncNet.mean - v.expectancyNet.base.point) < 1e-6, `${ncNet.mean} vs ${v.expectancyNet.base.point}`);
    check(`${sk}/net-base CI`, Math.abs(ncNet.lo - v.expectancyNet.base.lo) < 1e-6 && Math.abs(ncNet.hi - v.expectancyNet.base.hi) < 1e-6);
    check(`${sk}/net-base bootstrap`, Math.abs(bootNet.lo - v.expectancyNet.base.bootLo) < 1e-6 && Math.abs(bootNet.hi - v.expectancyNet.base.bootHi) < 1e-6);
    // gate
    const gate = S.gate[sk];
    check(`${sk}/gate re-derived`, gate.pass === (n >= 30 && bootNet.lo > 0), `pass=${gate.pass}, n=${n}, bootLo=${bootNet.lo}`);
  }

  // per-pair n + gross expectancy (1.5R variant spot depth)
  for (const p of PAIRS) {
    const sub = trd.filter((t) => t.p === p);
    check(`perPair/${p} n`, sub.length === S.byPair[p].n, `${sub.length} vs ${S.byPair[p].n}`);
    const dec = sub.map((t) => t.v15).filter((v) => v.res !== 'CENSORED').map((v) => v.r);
    const m = mean(dec);
    check(`perPair/${p} 1.5R gross expectancy`, Math.abs(m - S.byPair[p].tp15.expectancy.gross) < 1e-6, `${m} vs ${S.byPair[p].tp15.expectancy.gross}`);
  }
  // per-direction n
  for (const dir of ['PUT', 'CALL']) {
    check(`byDir/${dir} n`, trd.filter((t) => t.dir === dir).length === S.byDirection[dir].n);
  }

  // weekly buckets re-derivation (1.5R)
  {
    const wkMap = new Map();
    for (const t of trd) {
      const v = t.v15;
      if (v.res === 'CENSORED' || v.r == null) continue;
      const d = new Date(t.t + MS_1H);
      const day = (d.getUTCDay() + 6) % 7;
      const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
      const wk = new Date(monday).toISOString().slice(0, 10);
      (wkMap.get(wk) ?? wkMap.set(wk, []).get(wk)).push(v);
    }
    const wks = S.weekly.tp15;
    check('weekly/1.5R bucket count', wkMap.size === Object.keys(wks).length, `${wkMap.size} vs ${Object.keys(wks).length}`);
    let okWk = true, badWk = '';
    for (const [wk, arr] of wkMap) {
      const s = wks[wk];
      if (!s) { okWk = false; badWk = `week ${wk} missing in summary`; break; }
      const w = arr.filter((x) => x.res === 'TP').length;
      const l = arr.filter((x) => x.res === 'SL').length;
      const to = arr.filter((x) => x.res === 'TIMEOUT').length;
      const m = mean(arr.map((x) => x.r));
      if (s.n !== arr.length || s.w !== w || s.l !== l || s.to !== to || Math.abs(s.expectancy - m) > 1e-4) { okWk = false; badWk = `week ${wk}: ${JSON.stringify(s)} vs n=${arr.length} W=${w} L=${l} TO=${to} E=${m}`; break; }
    }
    check('weekly/1.5R buckets re-derived', okWk, badWk);
  }
}

console.log(`\nverify_frvp_fx1h_audit: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.join('\n')); process.exit(1); }

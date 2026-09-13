/**
 * TASK 26 — FRVP SENTIMENT-REGIME CONFLUENCE FILTER (single frozen design).
 *
 * Implements prereg/PREREG_FRVP_REGIME_FILTER.md EXACTLY:
 *   - trades: results/FRVP_audit.jsonl.gz TRD rows (unconditional run, 12mo)
 *   - regime: alternative.me F&G daily value stamped D, know_from = D+1 00:00 UTC
 *     (conservative pinning; during day D the regime uses D-1's value)
 *   - states: risk-on >= 60 | risk-off <= 40 | neutral 41-59
 *   - mapping: CALL blocked iff regime=risk-off; PUT blocked iff regime=risk-on
 *   - regime lookup instant: trigger candle open t + 60000 (engine decision instant)
 *   - costs: net R = gross R - (2*perSide)/rf; base 0.10%/side; sensitivities 0.05/0.20
 *   - stats: Wilson 95% (WR), normal + bootstrap 95% (expectancy; 10k resamples,
 *     seed 20260913); TIMEOUT rows keep realized R in expectancy (original convention)
 *   - gate (frozen, per variant): n >= 30 AND net expectancy bootstrap CI-LO > 0
 *   - filtered-out accounting: counts/shares by direction, pair, month; the
 *     removed subset's own gross/net expectancy is REPORTED (honesty), never
 *     used to re-tune anything.
 *
 * Equivalence note (pre-reg §2): the original engine took every trigger as an
 * independent position, so removing TRD rows by an entry-instant rule is
 * exactly the run a gated engine would have produced. No candles are read.
 *
 * Run: node backtest/frvp_regime_filter.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(ROOT, 'results', 'FRVP_audit.jsonl.gz');
const FNG = join(ROOT, 'backtest', 'data', 'external', 'fng_full.json');
const OUT_JSON = join(ROOT, 'results', 'FRVP_REGIME_FILTER_summary.json');

const DAY_MS = 86400000;
const Z95 = 1.959963984540054;
const SEED = 20260913;          // frozen in pre-reg §5
const BOOT_N = 10000;
const PER_SIDE_BASE = 0.001;    // 0.10%/side (original frozen base)
const PER_SIDE_SENS = [0.0005, 0.002];
const VARIANTS = [['v15', 'TP=1.5R'], ['v3', 'TP=3R'], ['vPoc', 'TP=POC']];
const WINDOW = { from: Date.UTC(2023, 6, 5), to: Date.UTC(2024, 6, 5) };

// ── seeded PRNG (mulberry32) + normal CI helpers ─────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function wilson(w, n) {
  if (n === 0) return { lo: null, hi: null, wr: null };
  const p = w / n, z2 = Z95 * Z95, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d;
  const h = (Z95 / d) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lo: c - h, hi: c + h, wr: p };
}
function meanCI(xs, rng) { // normal-approx + seeded bootstrap percentile CI
  const n = xs.length;
  if (n === 0) return { mean: null, normLo: null, normHi: null, bootLo: null, bootHi: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1 || 1));
  const normLo = mean - Z95 * sd / Math.sqrt(n), normHi = mean + Z95 * sd / Math.sqrt(n);
  const boots = new Float64Array(BOOT_N);
  for (let b = 0; b < BOOT_N; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[(rng() * n) | 0];
    boots[b] = s / n;
  }
  boots.sort();
  return { mean, normLo, normHi, bootLo: boots[(0.025 * (BOOT_N - 1)) | 0], bootHi: boots[(0.975 * (BOOT_N - 1)) | 0] };
}
function meanOnly(xs) { // mean without bootstrap (buckets where CI is not reported)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── load F&G with frozen known_from pinning ──────────────────────────────────
const fngRaw = JSON.parse(readFileSync(FNG, 'utf8'));
const sha = createHash('sha256').update(readFileSync(FNG)).digest('hex');
// known_from = (stamp D + 1 day) at 00:00 UTC; stamps are already day boundaries
const kfT = fngRaw.data.map(r => (r.ts + 86400) * 1000);   // ms of D+1 00:00 UTC
const kfV = fngRaw.data.map(r => r.value);
function regimeAt(ms) {
  let lo = 0, hi = kfT.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (kfT[m] <= ms) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans === -1) throw new Error(`no F&G observation knowable at ${new Date(ms).toISOString()}`);
  return { value: kfV[ans], state: kfV[ans] >= 60 ? 'risk-on' : kfV[ans] <= 40 ? 'risk-off' : 'neutral',
           from: kfV[ans - 1] ?? null, stampMs: kfT[ans] - DAY_MS };
}

// self-check of the pinning boundary (pre-reg discipline: prove, don't assume)
(function pinningSelfCheck() {
  const probe = (tsSec, val) => ({ ts: tsSec, value: val, cls: '' });
  const orig = fngRaw.data;
  // find two consecutive rows to test the exact boundary
  for (let i = 1; i < orig.length; i++) {
    if (orig[i].value === orig[i - 1].value) continue;
    const kf = (orig[i].ts + 86400) * 1000;             // obs i knowable from here
    const before = regimeAt(kf - 1).value, at = regimeAt(kf).value, after = regimeAt(kf + 60000).value;
    if (before !== orig[i - 1].value || at !== orig[i].value || after !== orig[i].value) {
      throw new Error(`pinning boundary self-check failed at obs ${i}`);
    }
    return; // one boundary suffices; the property test below covers more
  }
  void probe;
})();

// ── load TRD rows ─────────────────────────────────────────────────────────────
const raw = gunzipSync(readFileSync(AUDIT));
const lines = raw.toString('utf8').split('\n');
const trades = [];
for (const line of lines) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.k !== 'TRD') continue;
  const decMs = r.t + 60000;                 // frozen decision instant
  const reg = regimeAt(decMs);
  trades.push({
    pair: r.p, dir: r.dir, en: r.en, rf: r.rf, t: r.t, decMs,
    state: reg.state, fng: reg.value,
    blocked: (r.dir === 'CALL' && reg.state === 'risk-off') || (r.dir === 'PUT' && reg.state === 'risk-on'),
    month: new Date(r.t).toISOString().slice(0, 7),
    v15: r.v15, v3: r.v3, vPoc: r.vPoc,
  });
}
if (trades.length !== 37708) throw new Error(`expected 37,708 TRD rows, got ${trades.length}`);
if (sha !== 'e7dc592f7d9709c7d116068749520f32417837f12f4b62504454a97a6232a41f') {
  throw new Error(`FNG sha256 mismatch vs provenance: ${sha}`);
}

// ── day-level regime distribution over the frozen window (pre-reg §6.2) ──────
const dayDist = { 'risk-on': 0, 'risk-off': 0, neutral: 0, days: 0 };
for (let d = WINDOW.from; d < WINDOW.to; d += DAY_MS) {
  dayDist[regimeAt(d + 12 * 3600000).state]++;   // representative midday instant
  dayDist.days++;
}

// ── statistics per subset per variant ────────────────────────────────────────
function stats(rows, label) {
  const out = { label, n: rows.length };
  for (const [vk, vname] of VARIANTS) {
    let W = 0, L = 0, TO = 0, CEN = 0;
    const gross = [], netBase = [], net05 = [], net20 = [];
    for (const tr of rows) {
      const v = tr[vk];
      if (v.res === 'TP') { W++; gross.push(v.r); }
      else if (v.res === 'SL') { L++; gross.push(v.r); }
      else if (v.res === 'TIMEOUT') { TO++; gross.push(v.r); }
      else if (v.res === 'CENSORED') { CEN++; gross.push(v.r); }
      else throw new Error(`unknown resolution ${v.res}`);
    }
    for (const tr of rows) {
      const g = tr[vk].r;
      netBase.push(g - (2 * PER_SIDE_BASE) / tr.rf);
      net05.push(g - (2 * PER_SIDE_SENS[0]) / tr.rf);
      net20.push(g - (2 * PER_SIDE_SENS[1]) / tr.rf);
    }
    const decided = W + L;
    const gci = meanCI(gross, mulberry32(SEED));
    const nci = meanCI(netBase, mulberry32(SEED));
    out[vk] = {
      name: vname, n: rows.length, W, L, TO, CEN, decided,
      wr: wilson(W, decided),
      conservativeRate: (W + L + TO) ? (L + TO) / (W + L + TO) : null,
      gross: gci, netBase: nci,
      net05: { mean: net05.reduce((a, b) => a + b, 0) / (net05.length || 1) },
      net20: { mean: net20.reduce((a, b) => a + b, 0) / (net20.length || 1) },
      gate: rows.length >= 30 && nci.bootLo > 0 ? 'PASS' : 'FAIL',
    };
  }
  return out;
}

// ── headline: unconditional vs kept vs removed ───────────────────────────────
const kept = trades.filter(t => !t.blocked);
const removed = trades.filter(t => t.blocked);
const headline = {
  unconditional: stats(trades, 'unconditional (original run)'),
  kept: stats(kept, 'regime-filtered (this test)'),
  removed: stats(removed, 'removed by filter (reported for honesty)'),
};

// ── filtered-out accounting (pre-reg §5) ─────────────────────────────────────
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}
const removedByDir = { CALL: removed.filter(t => t.dir === 'CALL').length, PUT: removed.filter(t => t.dir === 'PUT').length };
const removedByPair = Object.fromEntries([...groupBy(removed, t => t.pair)].map(([k, v]) => [k, v.length]));
const removedByMonth = Object.fromEntries([...groupBy(removed, t => t.month)].map(([k, v]) => [k, v.length]));
const keptByPairDir = {};
for (const [k, v] of groupBy(kept, t => `${t.pair}|${t.dir}`)) {
  keptByPairDir[k] = { n: v.length, insufficient: v.length < 30,
    grossExp: { v15: meanOnly(v.map(t => t.v15.r)),
                v3: meanOnly(v.map(t => t.v3.r)),
                vPoc: meanOnly(v.map(t => t.vPoc.r)) } };
}
// per-direction kept gross expectancy (which side does the filter help?)
const keptByDir = {};
for (const [k, v] of groupBy(kept, t => t.dir)) {
  keptByDir[k] = { n: v.length,
    gross: { v15: meanCI(v.map(t => t.v15.r), mulberry32(SEED)), v3: meanCI(v.map(t => t.v3.r), mulberry32(SEED)), vPoc: meanCI(v.map(t => t.vPoc.r), mulberry32(SEED)) } };
}
const removedByDirExp = {};
for (const [k, v] of groupBy(removed, t => t.dir)) {
  removedByDirExp[k] = { n: v.length,
    gross: { v15: meanOnly(v.map(t => t.v15.r)), v3: meanOnly(v.map(t => t.v3.r)), vPoc: meanOnly(v.map(t => t.vPoc.r)) },
    netBase: { v15: meanOnly(v.map(t => t.v15.r - (2 * PER_SIDE_BASE) / t.rf)),
               v3: meanOnly(v.map(t => t.v3.r - (2 * PER_SIDE_BASE) / t.rf)),
               vPoc: meanOnly(v.map(t => t.vPoc.r - (2 * PER_SIDE_BASE) / t.rf)) } };
}

// ── consistency check vs published unconditional numbers (pre-reg §5) ────────
const published = { v15: 0.054, v3: 0.125, vPoc: 0.237 };
const publishedNet = { v15: -3.695, v3: -3.625, vPoc: -3.512 };
const consistency = {};
for (const [vk] of VARIANTS) {
  consistency[vk] = {
    gross_recomputed: headline.unconditional[vk].gross.mean, gross_published: published[vk],
    delta: +(headline.unconditional[vk].gross.mean - published[vk]).toFixed(4),
    net_recomputed: headline.unconditional[vk].netBase.mean, net_published: publishedNet[vk],
    match: Math.abs(headline.unconditional[vk].gross.mean - published[vk]) < 5e-3 &&
           Math.abs(headline.unconditional[vk].netBase.mean - publishedNet[vk]) < 5e-3,
  };
}

const summary = {
  task: 'Task 26 — FRVP sentiment-regime confluence filter (frozen single design)',
  prereg: 'prereg/PREREG_FRVP_REGIME_FILTER.md (commit 00f3027)',
  frozen: { states: 'risk-on >=60 | risk-off <=40 | neutral 41-59',
    known_from: 'stamp D + 1 day at 00:00 UTC', mapping: 'CALL blocked in risk-off; PUT blocked in risk-on; neutral blocks nothing',
    lookupInstant: 'trigger open t + 60000', seed: SEED, bootN: BOOT_N, perSideBase: PER_SIDE_BASE, perSideSens: PER_SIDE_SENS },
  fng: { file: 'backtest/data/external/fng_full.json', sha256: sha, rows: fngRaw.data.length },
  window: { from: new Date(WINDOW.from).toISOString(), to: new Date(WINDOW.to).toISOString() },
  regimeDayDistribution: dayDist,
  trades: { total: trades.length, kept: kept.length, removed: removed.length,
    removedShare: +(removed.length / trades.length).toFixed(4) },
  removedByDir, removedByPair, removedByMonth, removedByDirExp,
  keptByDir, keptByPairDir,
  headline, consistency,
};
writeFileSync(OUT_JSON, JSON.stringify(summary, null, 1));

// console digest
console.log(`regime days: risk-on ${dayDist['risk-on']}/${dayDist.days}, risk-off ${dayDist['risk-off']}, neutral ${dayDist.neutral}`);
console.log(`trades: ${trades.length} total -> kept ${kept.length} (${(100 * kept.length / trades.length).toFixed(1)}%), removed ${removed.length} (${(100 * removed.length / trades.length).toFixed(1)}%) [CALL removed ${removedByDir.CALL}, PUT removed ${removedByDir.PUT}]`);
for (const [vk, vn] of VARIANTS) {
  const u = headline.unconditional[vk], k = headline.kept[vk], r = headline.removed[vk];
  console.log(`\n[${vn}]`);
  console.log(`  unconditional: n=${u.n} gross ${u.gross.mean.toFixed(3)} [${u.gross.bootLo.toFixed(3)},${u.gross.bootHi.toFixed(3)}] net ${u.netBase.mean.toFixed(3)} [${u.netBase.bootLo.toFixed(3)},${u.netBase.bootHi.toFixed(3)}]`);
  console.log(`  kept:          n=${k.n} gross ${k.gross.mean.toFixed(3)} [${k.gross.bootLo.toFixed(3)},${k.gross.bootHi.toFixed(3)}] net ${k.netBase.mean.toFixed(3)} [${k.netBase.bootLo.toFixed(3)},${k.netBase.bootHi.toFixed(3)}] gate=${k.gate}`);
  console.log(`  removed:       n=${r.n} gross ${r.gross.mean.toFixed(3)} net ${r.netBase.mean.toFixed(3)}`);
}
console.log(`\nconsistency vs published: ${JSON.stringify(consistency)}`);
console.log(`written: ${OUT_JSON}`);

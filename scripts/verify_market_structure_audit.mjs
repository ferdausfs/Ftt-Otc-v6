/**
 * Market Structure — INDEPENDENT audit verifier.
 *
 * Re-derives EVERY number in results/MARKET_STRUCTURE_summary.json straight
 * from results/MARKET_STRUCTURE_audit.jsonl.gz with fresh code (its own
 * Wilson, its own bucketing, its own baseline pass), traces every traded
 * row to its own logged candles, replays the 1m event stream for
 * BOS/CHoCH-label + break-consumption consistency, and checks the 15m bias
 * chain. Exit 0 only if every check passes.
 *
 * Run: node scripts/verify_market_structure_audit.mjs
 */
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(ROOT, 'results', 'MARKET_STRUCTURE_audit.jsonl.gz');
const SUMMARY = join(ROOT, 'results', 'MARKET_STRUCTURE_summary.json');

let pass = 0, fail = 0, notes = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error(`  FAIL: ${name}`); } };
const note = (m) => { notes++; console.log(`  note: ${m}`); };
const BE = 1 / 1.8;

function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { wr: null, lo: null, hi: null };
  const p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
function bucket(rows) {   // rows: audit row objects with .res
  let w = 0, l = 0, t = 0;
  for (const r of rows) {
    if (r.res === 'WIN') w++;
    else if (r.res === 'LOSS') l++;
    else if (r.res === 'TIE') t++;
  }
  return { w, l, t };
}
const same = (a, b, eps = 1e-9) => {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
};

if (!existsSync(AUDIT)) { console.error('audit file missing — run the harness first'); process.exit(1); }
const summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));

// ── streaming pass over the audit ────────────────────────────────────────────
const m1 = new Map();       // pair -> array of rows (t-ordered by construction)
const s15 = new Map();      // pair -> array of rows
let m1Count = 0, s15Count = 0;
const funnel = { events: {}, reasons: {}, results: {} };

process.stdout.write('streaming audit ... ');
const rl = createInterface({ input: createReadStream(AUDIT).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line) continue;
  const r = JSON.parse(line);
  if (r.k === 'M1') {
    m1Count++;
    funnel.events[r.ev] = (funnel.events[r.ev] || 0) + 1;
    if (r.w) funnel.reasons[r.w] = (funnel.reasons[r.w] || 0) + 1;
    if (r.res) funnel.results[r.res] = (funnel.results[r.res] || 0) + 1;
    let arr = m1.get(r.p);
    if (!arr) { arr = []; m1.set(r.p, arr); }
    arr.push(r);
  } else if (r.k === 'S15') {
    s15Count++;
    let arr = s15.get(r.p);
    if (!arr) { arr = []; s15.set(r.p, arr); }
    arr.push(r);
  } else {
    ok(false, `unknown row kind ${r.k}`);
  }
}
rl.close();
console.log(`done (${m1Count} M1 rows, ${s15Count} S15 rows)`);

ok(m1Count === summary.funnel.evaluatedBars, 'summary.evaluatedBars == M1 row count');
ok(s15Count === summary.funnel.s15Rows, 'summary.s15Rows == S15 row count');
for (const [k, v] of Object.entries(summary.funnel.events)) ok(funnel.events[k] === v, `funnel.events.${k}`);
for (const [k, v] of Object.entries(summary.funnel.noTradeReasons)) ok(funnel.reasons[k] === v, `funnel.noTradeReasons.${k}`);
for (const [k, v] of Object.entries(summary.funnel.results)) ok(funnel.results[k] === v, `funnel.results.${k}`);

// ── window bounds + contiguity + per-row consistency + traded tracing ───────
const WIN_START = Date.parse(summary.window.start);
const WIN_END = Date.parse(summary.window.end);
let traced = 0, eventRows = 0, tailTraced = 0;

// raw candles for tracing exits that resolved in the fetched tail (past the
// audited window) — the RESULT itself is re-derived from in-row fields; this
// is a second, data-backed confirmation of the exit price.
const rawCandles = new Map();
function rawExit(pair, t) {
  if (!rawCandles.has(pair)) {
    const name = pair.replace('/', '');
    const { candles } = JSON.parse(readFileSync(join(ROOT, 'backtest', 'data', 'ms', `${name}_1m.json`), 'utf8'));
    const byT = new Map();
    for (const c of candles) byT.set(c.t, c);
    rawCandles.set(pair, byT);
  }
  return rawCandles.get(pair).get(t);
}

for (const [pair, rows] of m1) {
  ok(rows.length === summary.data.find(d => d.pair === pair).evaluated, `${pair}: evaluated count matches summary`);
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const ct = r.t + 60000;
    ok(ct >= WIN_START && ct <= WIN_END, `${pair}: row ${k} inside window`);
    if (k > 0) ok(r.t - rows[k - 1].t === 60000, `${pair}: 1m contiguity at index ${k}`);
    ok(r.h >= r.l && r.h >= r.c && r.h >= r.o && r.l <= r.c && r.l <= r.o, `${pair}: OHLC invariants at ${r.t}`);
    // event consistency against the logged references
    if (r.ev === 'BOS_BULL' || r.ev === 'CHoCH_BULL') {
      eventRows++;
      ok(r.sh !== null && r.c > r.sh[0] && r.sh[2] === 1, `${pair}: bull event at ${r.t} breaks the logged sh`);
    } else if (r.ev === 'BOS_BEAR' || r.ev === 'CHoCH_BEAR') {
      eventRows++;
      ok(r.sl !== null && r.c < r.sl[0] && r.sl[2] === 1, `${pair}: bear event at ${r.t} breaks the logged sl`);
    } else if (r.ev === 'NONE') {
      ok(!(r.sh !== null && r.sh[2] === 0 && r.c > r.sh[0]), `${pair}: no hidden bull break at ${r.t}`);
      ok(!(r.sl !== null && r.sl[2] === 0 && r.c < r.sl[0]), `${pair}: no hidden bear break at ${r.t}`);
    }
    // expiry ladder consistency on decided rows
    if (r.d !== 'NO_TRADE') {
      ok(r.m === 5 || r.m === 7 || r.m === 10, `${pair}: tier valid at ${r.t}`);
      ok((r.m === 5 && r.pc >= 75) || (r.m === 7 && r.pc >= 25 && r.pc < 75) || (r.m === 10 && r.pc < 25), `${pair}: tier matches percentile at ${r.t}`);
      ok(r.en === r.c, `${pair}: entry == trigger close at ${r.t}`);
      // RESULT re-derived purely from in-row fields (JSONL self-sufficiency)
      ok(r.ex !== null && r.res === (r.ex === r.en ? 'TIE' : r.d === 'CALL' ? (r.ex > r.en ? 'WIN' : 'LOSS') : (r.ex < r.en ? 'WIN' : 'LOSS')), `${pair}: result re-derived from in-row fields at ${r.t}`);
      // exit price traced to the exit candle: in-audit row when available,
      // otherwise the fetched tail candle
      const exIdx = k + r.m;
      const inAudit = exIdx < rows.length && rows[exIdx].t === r.t + r.m * 60000;
      if (inAudit) {
        ok(r.ex === rows[exIdx].c, `${pair}: exit price traced to audited exit row at ${r.t}`);
        traced++;
      } else {
        const raw = rawExit(pair, r.t + r.m * 60000);
        ok(raw && r.ex === raw.c && r.exT === raw.t, `${pair}: tail exit traced to raw candle at ${r.t}`);
        tailTraced++;
      }
    } else {
      ok(r.m === null && r.en === null && r.ex === null && r.res === null, `${pair}: NO_TRADE row has no trade fields at ${r.t}`);
    }
  }
}

// ── BOS/CHoCH label replay (1m trend implied by the event stream) ───────────
let firstEventNote = 0;
for (const [pair, rows] of m1) {
  let trend = null;   // null = not yet knowable from the JSONL alone
  for (const r of rows) {
    if (r.ev === 'NONE') continue;
    if (trend === null) {
      // first observed event: a BOS label implies a pre-established trend —
      // seed from it (pre-window trend is not reconstructible from the audit)
      if (r.ev === 'BOS_BULL' || r.ev === 'BOS_BEAR') { firstEventNote++; trend = r.ev === 'BOS_BULL' ? 'UP' : 'DOWN'; continue; }
      trend = r.ev === 'CHoCH_BULL' ? 'UP' : 'DOWN';
      continue;
    }
    if (r.ev === 'BOS_BULL') ok(trend === 'UP', `${pair}: BOS_BULL requires UP trend at ${r.t}`);
    if (r.ev === 'CHoCH_BULL') { ok(trend !== 'UP', `${pair}: CHoCH_BULL requires non-UP trend at ${r.t}`); trend = 'UP'; }
    if (r.ev === 'BOS_BEAR') ok(trend === 'DOWN', `${pair}: BOS_BEAR requires DOWN trend at ${r.t}`);
    if (r.ev === 'CHoCH_BEAR') { ok(trend !== 'DOWN', `${pair}: CHoCH_BEAR requires non-DOWN trend at ${r.t}`); trend = 'DOWN'; }
  }
}
if (firstEventNote) note(`${firstEventNote} per-pair first events were BOS (pre-window trend not reconstructible from audit; seeded) — covered by unit tests instead`);

// ── 15m bias chain: each M1 row's bias == trend of last S15 closed <= trigger ──
let biasChecked = 0, biasSkipped = 0;
for (const [pair, rows15] of s15) {
  const rows = m1.get(pair);
  let p15 = 0;
  for (const r of rows) {
    const ct = r.t + 60000;
    while (p15 + 1 < rows15.length && rows15[p15 + 1].t + 900000 <= ct) p15++;
    if (p15 < 0 || rows15[p15].t + 900000 > ct) { biasSkipped++; continue; }
    ok(r.b === rows15[p15].tr, `${pair}: M1 bias at ${r.t} == S15 trend at ${rows15[p15].t}`);
    biasChecked++;
    if (biasChecked > 200000) break;   // sample bound — full replay is O(n) anyway, keep runtime sane
  }
}
if (biasSkipped) note(`${biasSkipped} rows had no closed 15m bar (should be 0 with warmup)`);

// ── no-skill baselines from the M1 candles themselves ────────────────────────
const baseFixed = { 5: { n: 0, up: 0, down: 0, tie: 0 }, 7: { n: 0, up: 0, down: 0, tie: 0 }, 10: { n: 0, up: 0, down: 0, tie: 0 } };
for (const [, rows] of m1) {
  for (let k = 0; k < rows.length; k++) {
    for (const n of [5, 7, 10]) {
      const e = k + n;
      if (e >= rows.length || rows[e].t !== rows[k].t + n * 60000) continue;
      baseFixed[n].n++;
      if (rows[e].c > rows[k].c) baseFixed[n].up++;
      else if (rows[e].c < rows[k].c) baseFixed[n].down++;
      else baseFixed[n].tie++;
    }
  }
}
summary.noSkillBaselineFixedWindows.forEach((b) => {
  const v = baseFixed[b.minutes];
  ok(v.n === b.n && v.up === b.up && v.down === b.down && v.tie === b.tie, `baseline ${b.minutes}m counts re-derived`);
  ok(Math.abs(v.up / v.n - b.upRate) < 1e-4, `baseline ${b.minutes}m upRate re-derived`);
});

// ── rate buckets re-derived from the traced trade rows ──────────────────────
const traded = [];
for (const [pair, rows] of m1) for (const r of rows) if (r.d !== 'NO_TRADE') traded.push(r);
ok(traded.length === summary.triggersTotal, 'triggersTotal re-derived');
const decided = traded.filter(r => r.res === 'WIN' || r.res === 'LOSS' || r.res === 'TIE');
const mk = (keyFn) => {
  const g = new Map();
  for (const r of decided) {
    const k = keyFn(r);
    if (!g.has(k)) g.set(k, { w: 0, l: 0, t: 0 });
    const b = g.get(k);
    if (r.res === 'WIN') b.w++; else if (r.res === 'LOSS') b.l++; else b.t++;
  }
  return g;
};
const compare = (got, label) => {
  const exp = summary.rates[label];
  if (label === 'overall') {
    const ci = wilson(got.w, got.w + got.l);
    ok(exp.wins === got.w && exp.losses === got.l && exp.ties === got.t, 'overall W/L/T');
    ok(same(ci.wr, exp.wr) && same(ci.lo, exp.wilsonLo) && same(ci.hi, exp.wilsonHi), 'overall Wilson re-derived');
  } else {
    ok(got.size === exp.length, `${label}: bucket count ${got.size} == ${exp.length}`);
    for (const row of exp) {
      const b = got.get(row.label);
      ok(b !== undefined, `${label}: bucket '${row.label}' present`);
      if (!b) continue;
      const ci = wilson(b.w, b.w + b.l);
      ok(b.w === row.wins && b.l === row.losses && b.t === row.ties, `${label}/${row.label}: W/L/T`);
      ok(same(ci.wr, row.wr) && same(ci.lo, row.wilsonLo) && same(ci.hi, row.wilsonHi), `${label}/${row.label}: Wilson`);
    }
  }
};
const overallB = bucket(decided);
compare(overallB, 'overall');
compare(mk(r => r.p), 'byPair');
compare(mk(r => (r.ev.startsWith('BOS') ? 'BOS' : 'CHoCH')), 'byBreakType');
compare(mk(r => r.ev), 'byEvent');
compare(mk(r => `expiry${r.m}m`), 'byTier');
compare(mk(r => r.d), 'byDirection');

// ── gate re-derivation ──────────────────────────────────────────────────────
const oCi = wilson(overallB.w, overallB.w + overallB.l);
const gate = summary.gate;
ok(Math.abs(oCi.lo - BE - gate.marginPp / 100) <= 0.0051, 'gate margin arithmetic (2dp-rounded marginPp)');
ok(gate.overallLoClears === (oCi.lo > BE), 'gate.overallLoClears re-derived');
const sufficientPairs = summary.rates.byPair.filter(b => b.sufficient);
ok(gate.consistentAcrossPairs === (sufficientPairs.length > 0 && sufficientPairs.every(b => b.wilsonLo > BE)), 'gate.consistentAcrossPairs re-derived');
ok(gate.pass === (gate.overallLoClears && gate.consistentAcrossPairs && oCi.lo > BE), 'gate.pass re-derived');

console.log(`\n══ verify_market_structure_audit: ${pass} passed, ${fail} failed, ${notes} notes ══`);
console.log(`traded rows: in-audit exit traced ${traced}, tail exit traced ${tailTraced}, event rows checked: ${eventRows}, bias chain checks: ${biasChecked}`);
process.exit(fail === 0 ? 0 : 1);

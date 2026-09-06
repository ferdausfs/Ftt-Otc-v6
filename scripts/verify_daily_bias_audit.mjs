/**
 * Independent recount of every headline number in the daily-bias FX report,
 * straight from results/DAILY_BIAS_FX_audit.jsonl — the "no report claim
 * that can't be traced back to a logged row" check.
 *
 * Deliberately independent:
 *   - the classifier is REIMPLEMENTED inline here (not imported from
 *     src/strategy/dailyBiasFx.mjs) so a logic bug in the module cannot
 *     verify itself;
 *   - Wilson CI is reimplemented here;
 *   - the no-skill baselines are recomputed from the RAW candle files,
 *     not from the summary;
 *   - every audit row is cross-checked against the raw candle files
 *     (values + day labels) and against its own logged raw values.
 *
 * Run: node scripts/verify_daily_bias_audit.mjs   -> exit 0 if all green.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = readFileSync(join(ROOT, 'results', 'DAILY_BIAS_FX_audit.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse);
const S = JSON.parse(readFileSync(join(ROOT, 'results', 'DAILY_BIAS_FX_summary.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL ${name}`); }
}
function eqNum(a, b, name, eps = 1e-9) {
  const good = a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps);
  ok(good, `${name}: audit=${a} summary=${b}`);
}

// independent classifier (spec order: sweep-both -> very-bearish -> bearish -> bullish -> consolidation -> unclassified)
function classify(d2, d1) {
  if (d1.h > d2.h && d1.l < d2.l) return { classification: 'SWEEP_BOTH', decision: 'NO_TRADE', reason: 'SWEEP_BOTH' };
  if (d1.h > d2.h && d1.c < d2.l) return { classification: 'VERY_BEARISH', decision: 'PUT', reason: null };
  if (d1.h > d2.h && d1.c < d2.h) return { classification: 'BEARISH', decision: 'PUT', reason: null };
  if (d1.l < d2.l && d1.c > d2.h) return { classification: 'BULLISH', decision: 'CALL', reason: null };
  if (d1.h <= d2.h && d1.l >= d2.l) return { classification: 'CONSOLIDATION', decision: 'NO_TRADE', reason: 'CONSOLIDATION' };
  return { classification: 'UNCLASSIFIED', decision: 'NO_TRADE', reason: 'UNCLASSIFIED' };
}
// independent Wilson
function wilsonLo(w, n) {
  if (!n) return null;
  const z = 1.959963984540054;
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c - s) / d;
}
const dayLabel = (tMs) => new Date(tMs + 3600000).toISOString().slice(0, 10);

console.log('Independent recount from results/DAILY_BIAS_FX_audit.jsonl (' + rows.length + ' rows)');

// ── 1. row-level integrity: raw values match source candles; classification,
//       decision and result are all re-derivable from the logged raw values ──
const srcByPair = {};
const PAIR_LABEL = { EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD', USDJPY: 'USD/JPY', AUDUSD: 'AUD/USD' };
for (const name of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']) {
  srcByPair[name] = JSON.parse(readFileSync(join(ROOT, 'backtest', 'data', 'daily', `${name}_d1.json`), 'utf8')).candles;
}
const r6 = (x) => +x.toFixed(6);
let srcChecked = 0;
for (const name of Object.keys(srcByPair)) {
  const pair = PAIR_LABEL[name];
  const candles = srcByPair[name];
  const pr = rows.filter(r => r.pair === pair);
  ok(pr.length === candles.length - 2, `${pair}: audit rows (${pr.length}) == candles-2 (${candles.length - 2})`);
  for (let k = 0; k < pr.length; k++) {
    const row = pr[k], d2 = candles[k], d1 = candles[k + 1], d = candles[k + 2];
    // values trace back to the raw source files
    if (row.dt !== d.t || row.d1t !== d1.t || row.d2t !== d2.t) { ok(false, `${pair} row ${k}: timestamps match source`); break; }
    if (row.dayD !== dayLabel(d.t) || row.dayD1 !== dayLabel(d1.t) || row.dayD2 !== dayLabel(d2.t)) { ok(false, `${pair} row ${k}: day labels`); break; }
    if (row.d2.h !== r6(d2.h) || row.d2.l !== r6(d2.l) || row.d2.c !== r6(d2.c)) { ok(false, `${pair} row ${k}: D-2 values`); break; }
    if (row.d1.h !== r6(d1.h) || row.d1.l !== r6(d1.l) || row.d1.c !== r6(d1.c)) { ok(false, `${pair} row ${k}: D-1 values`); break; }
    if (row.d.o !== r6(d.o) || row.d.c !== r6(d.c)) { ok(false, `${pair} row ${k}: day-D open/close`); break; }
    srcChecked++;
    // decision + classification re-derivable from the row's OWN raw values
    const c = classify({ h: row.d2.h, l: row.d2.l, c: row.d2.c }, { h: row.d1.h, l: row.d1.l, c: row.d1.c });
    if (c.classification !== row.classification || c.decision !== row.decision || c.reason !== row.reason) {
      ok(false, `${pair} ${row.dayD}: reclassified ${c.classification}/${c.decision} but row says ${row.classification}/${row.decision}`);
      break;
    }
    // result re-derivable from decision + day-D open/close
    if (row.decision === 'NO_TRADE') {
      if (row.entry !== null || row.exit !== null || row.result !== null) { ok(false, `${pair} ${row.dayD}: AVOID row must have null entry/exit/result`); break; }
    } else {
      const exp = row.d.c === row.d.o ? 'TIE' : row.decision === 'CALL' ? (row.d.c > row.d.o ? 'WIN' : 'LOSS') : (row.d.c < row.d.o ? 'WIN' : 'LOSS');
      if (row.result !== exp) { ok(false, `${pair} ${row.dayD}: result ${row.result} != re-derived ${exp}`); break; }
      if (row.entry !== row.d.o || row.exit !== row.d.c) { ok(false, `${pair} ${row.dayD}: entry/exit != day-D open/close`); break; }
    }
  }
  ok(true, `${pair}: ${pr.length} rows re-derived (values, class, decision, result) against source`);
}
console.log(`  (${srcChecked} rows traced to raw candles)`);

// ── 2. funnel ────────────────────────────────────────────────────────────────
const noTrade = rows.filter(r => r.decision === 'NO_TRADE');
const traded = rows.filter(r => r.decision !== 'NO_TRADE');
eqNum(rows.length, S.funnel.evaluatedDays, 'evaluated days');
eqNum(traded.length, S.funnel.tradedDays, 'traded days');
eqNum(noTrade.length, S.funnel.avoidedDays, 'avoided days');
const reasonCounts = {};
for (const r of noTrade) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
for (const [k, v] of Object.entries(S.funnel.avoidedByReason)) eqNum(reasonCounts[k] || 0, v, 'avoid reason ' + k);

// ── 3. headline buckets ──────────────────────────────────────────────────────
function tally(rs) {
  let w = 0, l = 0, t = 0;
  for (const r of rs) {
    if (r.result === 'WIN') w++;
    else if (r.result === 'LOSS') l++;
    else if (r.result === 'TIE') t++;
  }
  return { w, l, t };
}
function checkRate(R, rs, name) {
  const { w, l, t } = tally(rs);
  eqNum(w, R.wins, `${name} wins`);
  eqNum(l, R.losses, `${name} losses`);
  eqNum(t, R.ties, `${name} ties`);
  const dec = w + l;
  if (dec) {
    eqNum(w / dec, R.wr, `${name} WR`);
    eqNum(wilsonLo(w, dec), R.wilsonLo, `${name} Wilson-LO`, 1e-9);
    eqNum(w / (dec + t), R.conservativeWr, `${name} conservative WR`, 1e-9);
  }
  ok(R.sufficient === (dec >= 30), `${name} sufficient flag`);
}
checkRate(S.rates.overall, traded, 'overall');
for (const P of S.rates.byPair) checkRate(P, traded.filter(r => r.pair === P.label), 'pair ' + P.label);
for (const C of S.rates.byClassification) checkRate(C, traded.filter(r => r.classification === C.label), 'class ' + C.label);
for (const D of S.rates.byDirection) checkRate(D, traded.filter(r => r.decision === D.label), 'direction ' + D.label);

// BULLISH / VERY_BEARISH structural zeros (proven property, must hold in data)
const bull = rows.filter(r => r.classification === 'BULLISH').length;
const vbear = rows.filter(r => r.classification === 'VERY_BEARISH').length;
eqNum(bull, 0, 'BULLISH rows (unreachable under spec order, valid OHLC)');
eqNum(vbear, 0, 'VERY_BEARISH rows (unreachable under spec order, valid OHLC)');

// ── 4. no-skill baselines recomputed from RAW candle files ───────────────────
let pUp = 0, pDown = 0, pTie = 0;
for (const B of S.noSkillBaselineFullHistory) {
  const candles = srcByPair[B.pair.replace('/', '')];
  let up = 0, down = 0, tie = 0;
  for (const c of candles) { if (c.c > c.o) up++; else if (c.c < c.o) down++; else tie++; }
  eqNum(up, B.up, `${B.pair} baseline up`);
  eqNum(down, B.down, `${B.pair} baseline down`);
  eqNum(tie, B.tie, `${B.pair} baseline tie`);
  ok(Math.abs(up / (up + down) - B.upRate) <= 5e-5, `${B.pair} upRate (summary stores 4dp)`);
  pUp += up; pDown += down; pTie += tie;
}
ok(Math.abs(pUp / (pUp + pDown) - S.noSkillBaselinePooled.upRate) <= 5e-5, 'pooled upRate (summary stores 4dp)');

// ── 5. gate (fractions everywhere; breakeven stored as percent for display) ─
const BE_FRAC = 1 / 1.8;
const lo = wilsonLo(S.rates.overall.wins, S.rates.overall.wins + S.rates.overall.losses);
ok(S.gate.breakeven === +(100 * BE_FRAC).toFixed(4), 'gate breakeven value (percent, display)');
ok(S.gate.overallLoClears === (lo > BE_FRAC), 'gate overallLoClears recomputation (fraction compare)');
ok(Math.abs(S.gate.marginPp - 100 * (lo - BE_FRAC)) <= 0.02, 'gate margin percentage points');
ok(S.gate.pass === false || (lo > BE_FRAC && S.rates.byPair.filter(p => p.sufficient).every(p => p.wilsonLo > BE_FRAC)),
  'gate PASS implies consistency (verifier never fabricates a PASS)');

console.log(`\nverify_daily_bias_audit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

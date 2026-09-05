/**
 * Independent recount of every headline number straight from
 * results/audit_signals.jsonl (the committed OOS audit), compared against
 * results/harness_summary.json. This is the "no report claim that can't be
 * traced back to a logged row" check.
 *
 * Run: node scripts/verify_audit.mjs   -> exit 0 if every number matches.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = readFileSync(join(ROOT, 'results', 'audit_signals.jsonl'), 'utf8')
  .trim().split('\n').map(JSON.parse);
const S = JSON.parse(readFileSync(join(ROOT, 'results', 'harness_summary.json'), 'utf8'));

let pass = 0, fail = 0;
function eq(a, b, name, eps = 1e-9) {
  const good = a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps);
  if (good) { pass++; } else { fail++; console.error(`  FAIL ${name}: audit=${a} summary=${b}`); }
}

// independent Wilson (reimplemented here on purpose)
function wilson(w, n) {
  const z = 1.959963984540054;
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

function tally(rs) {
  let w = 0, l = 0, t = 0, sig = 0, cand = 0;
  for (const r of rs) {
    cand++;
    if (r.decision === 'NO_TRADE') continue;
    sig++;
    if (r.result === 'WIN') w++;
    else if (r.result === 'LOSS') l++;
    else if (r.result === 'TIE') t++;
  }
  return { cand, sig, w, l, t };
}
function group(rs, key) {
  const m = new Map();
  for (const r of rs) {
    if (r.decision === 'NO_TRADE') continue;
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

console.log('Independent recount from results/audit_signals.jsonl (' + rows.length + ' rows)');

// ── overall ──
const A = tally(rows);
eq(A.cand, S.oosFunnel.total, 'OOS candidates');
eq(A.sig, S.oosFunnel.signals, 'OOS signals');
eq(A.sig, S.oosSignals, 'OOS signals (top-level)');
eq(A.t, S.oosTies, 'ties');
const gaps = rows.filter(r => r.result === 'EXPIRY_GAP').length;
eq(gaps, S.oosExpiryGaps, 'expiry gaps');
eq(A.w, S.rates.overall.wins, 'overall wins');
eq(A.l, S.rates.overall.losses, 'overall losses');
const wr = A.w / (A.w + A.l);
eq(wr, S.rates.overall.wr, 'overall WR');
const [lo] = wilson(A.w, A.w + A.l);
eq(lo, S.rates.overall.wilsonLo, 'overall Wilson-LO');
const cons = A.w / (A.w + A.l + A.t);
eq(cons, S.rates.overall.conservativeWr, 'conservative WR');

// ── funnel reason counts (recomputed from rows) ──
const reasonCounts = {};
for (const r of rows) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
for (const [k, v] of Object.entries(S.oosFunnel.reasons)) eq(reasonCounts[k] || 0, v, 'reason ' + k);

// ── per-market / per-pair / per-tier ──
for (const [label, keyFn, list] of [
  ['market', r => r.market, S.rates.byMarket],
  ['pair', r => r.pair, S.rates.byPair],
  ['tier', r => 'expiry' + r.expiryMinutes, S.rates.byTier],
]) {
  const g = group(rows, keyFn);
  for (const row of list) {
    const k = row.label.replace('OOS ', '');
    const rs = g.get(k) || [];
    const t = tally(rs);
    eq(t.w, row.wins, `${label} ${k} wins`);
    eq(t.l, row.losses, `${label} ${k} losses`);
    eq(t.t, row.ties, `${label} ${k} ties`);
    if (t.w + t.l > 0) {
      eq(t.w / (t.w + t.l), row.wr, `${label} ${k} WR`);
      const [l2] = wilson(t.w, t.w + t.l);
      eq(l2, row.wilsonLo, `${label} ${k} Wilson-LO`);
    }
  }
}

// ── baseline up-rates recomputed from audit rows (same gap handling) ──
// The audit rows carry entryPrice for every boundary candidate; the baseline
// needs exit prices which are only logged for signals. Instead verify the
// baseline sample counts structurally: every candidate row has entryPrice,
// and signal rows' priceDelta == exitPrice - entryPrice.
let deltaChecked = 0;
for (const r of rows) {
  if (r.decision === 'NO_TRADE') { if (r.entryPrice != null) deltaChecked++; continue; }
  if (r.result === 'EXPIRY_GAP') { if (r.exitPrice == null) deltaChecked++; continue; }
  if (r.exitPrice != null && Math.abs((r.exitPrice - r.entryPrice) - r.priceDelta) <= 1e-5) deltaChecked++;
}
eq(deltaChecked, rows.length, 'entry/exit arithmetic traceable on every row');

// split integrity: audit file must contain ONLY OOS rows
const badSplit = rows.filter(r => r.split !== 'OOS').length;
eq(badSplit, 0, 'audit_signals.jsonl contains only OOS rows');
const minTs = Math.min(...rows.map(r => Date.parse(r.ts)));
if (!(minTs >= Date.parse(S.splitDate))) { fail++; console.error('  FAIL OOS row before split date'); }
else pass++;

console.log(`\nverify_audit: ${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);

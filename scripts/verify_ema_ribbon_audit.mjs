/**
 * Independent recount of every headline number straight from
 * results/EMA_RIBBON_audit.jsonl.gz (the committed audit), compared against
 * results/ema_ribbon_summary.json. Same standard as scripts/verify_audit.mjs:
 * no report claim that can't be traced back to a logged row.
 *
 * Strengthened vs the older audits: every row carries dir5/dir7/dir10
 * no-skill direction markers, so (a) the baseline up-rates are recomputable
 * from the audit alone, and (b) every signal's result must agree with the
 * direction marker of its own expiry window.
 *
 * Run: node scripts/verify_ema_ribbon_audit.mjs   -> exit 0 if every number matches.
 */
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(ROOT, 'results', 'EMA_RIBBON_audit.jsonl.gz');
const SUMMARY = join(ROOT, 'results', 'ema_ribbon_summary.json');
if (!existsSync(AUDIT)) { console.error('audit .gz missing'); process.exit(1); }
const S = JSON.parse(readFileSync(SUMMARY, 'utf8'));

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

const FROM_MS = Date.parse(S.evalFrom);
const TO_MS = Date.parse(S.evalTo);

// ── streaming tally ──────────────────────────────────────────────────────────
const tally = {
  rows: 0, signals: 0, w: 0, l: 0, t: 0, gaps: 0,
  reasons: {},
  byPair: new Map(), byTier: new Map(), byDir: new Map(),
  dir: { 5: { valid: 0, up: 0, down: 0, tie: 0 }, 7: { valid: 0, up: 0, down: 0, tie: 0 }, 10: { valid: 0, up: 0, down: 0, tie: 0 } },
  windowViolations: 0, resultDirMismatch: 0, priceArithFail: 0, structureFail: 0,
};
function bump(map, key, result) {
  if (!map.has(key)) map.set(key, { w: 0, l: 0, t: 0 });
  const g = map.get(key);
  if (result === 'WIN') g.w++;
  else if (result === 'LOSS') g.l++;
  else if (result === 'TIE') g.t++;
}

const rl = createInterface({ input: createReadStream(AUDIT).pipe(createGunzip()), crlfDelay: Infinity });
for await (const line of rl) {
  const r = JSON.parse(line);
  tally.rows++;
  tally.reasons[r.reason] = (tally.reasons[r.reason] || 0) + 1;

  // window integrity: decisions only inside the frozen evaluation window
  const tsMs = Date.parse(r.ts);
  if (!(tsMs >= FROM_MS && tsMs < TO_MS)) tally.windowViolations++;

  // no-skill markers: structure + tallies
  for (const n of [5, 7, 10]) {
    const v = r['dir' + n];
    if (v === null || v === undefined) continue;
    const t = tally.dir[n];
    t.valid++;
    if (v === 1) t.up++;
    else if (v === -1) t.down++;
    else if (v === 0) t.tie++;
    else tally.structureFail++;
  }

  if (r.decision === 'NO_TRADE') {
    if (r.expiryMinutes !== null || r.exitPrice !== null) tally.structureFail++;
    continue;
  }
  tally.signals++;
  if (r.result === 'WIN') { tally.w++; bump(tally.byPair, r.pair, 'WIN'); bump(tally.byTier, 'expiry' + r.expiryMinutes, 'WIN'); bump(tally.byDir, r.decision, 'WIN'); }
  else if (r.result === 'LOSS') { tally.l++; bump(tally.byPair, r.pair, 'LOSS'); bump(tally.byTier, 'expiry' + r.expiryMinutes, 'LOSS'); bump(tally.byDir, r.decision, 'LOSS'); }
  else if (r.result === 'TIE') { tally.t++; bump(tally.byPair, r.pair, 'TIE'); bump(tally.byTier, 'expiry' + r.expiryMinutes, 'TIE'); bump(tally.byDir, r.decision, 'TIE'); }
  else if (r.result === 'EXPIRY_GAP') { tally.gaps++; }
  else tally.structureFail++;

  // a decided signal's result must agree with its own expiry-window marker.
  // dirN is ABSOLUTE price direction (+1 up / -1 down / 0 tie); the result is
  // DIRECTION-RELATIVE: CALL wins on up, PUT wins on down.
  if (r.result !== 'EXPIRY_GAP') {
    const d = r['dir' + r.expiryMinutes];
    const up = r.result === 'WIN' ? r.decision === 'CALL' : r.result === 'LOSS' ? r.decision === 'PUT' : null;
    const expect = up === null ? 0 : up ? 1 : -1;
    if (d !== expect) tally.resultDirMismatch++;
  }
  // entry/exit arithmetic on every resolved signal
  if (r.exitPrice != null && r.entryPrice != null) {
    if (Math.abs((r.exitPrice - r.entryPrice) - r.priceDelta) > 1e-5) tally.priceArithFail++;
  }
}

console.log(`Independent recount from results/EMA_RIBBON_audit.jsonl.gz (${tally.rows} rows)`);

// ── structural integrity first ──
eq(tally.windowViolations, 0, 'all decisions inside the frozen window');
eq(tally.structureFail, 0, 'row structure (no-trade fields, marker values)');
eq(tally.resultDirMismatch, 0, 'every signal result agrees with its own dirN marker');
eq(tally.priceArithFail, 0, 'priceDelta == exitPrice - entryPrice on every resolved signal');

// ── overall ──
eq(tally.rows, S.totalEvaluated, 'total evaluated boundaries');
eq(tally.signals, S.totalSignals, 'total signals');
eq(tally.t, S.totalTies, 'ties');
eq(tally.gaps, S.totalExpiryGaps, 'expiry gaps');
eq(tally.w, S.rates.overall.wins, 'overall wins');
eq(tally.l, S.rates.overall.losses, 'overall losses');
eq(tally.w / (tally.w + tally.l), S.rates.overall.wr, 'overall WR');
const [lo] = wilson(tally.w, tally.w + tally.l);
eq(lo, S.rates.overall.wilsonLo, 'overall Wilson-LO');
eq(tally.w / (tally.w + tally.l + tally.t), S.rates.overall.conservativeWr, 'conservative WR');

// ── funnel ──
for (const [k, v] of Object.entries(S.funnel)) eq(tally.reasons[k] || 0, v, 'reason ' + k);
const reasonSum = Object.values(tally.reasons).reduce((a, b) => a + b, 0);
eq(reasonSum, tally.rows, 'funnel covers every row');

// ── per-pair / per-tier / per-direction ──
for (const [map, list, strip] of [
  [tally.byPair, S.rates.byPair, 'pair '],
  [tally.byTier, S.rates.byTier, ''],
  [tally.byDir, S.rates.byDirection, ''],
]) {
  for (const row of list) {
    const k = row.label.startsWith(strip) && strip ? row.label.slice(strip.length) : row.label;
    const g = map.get(k) || { w: 0, l: 0, t: 0 };
    eq(g.w, row.wins, `${row.label} wins`);
    eq(g.l, row.losses, `${row.label} losses`);
    eq(g.t, row.ties, `${row.label} ties`);
    if (g.w + g.l > 0) {
      eq(g.w / (g.w + g.l), row.wr, `${row.label} WR`);
      const [l2] = wilson(g.w, g.w + g.l);
      eq(l2, row.wilsonLo, `${row.label} Wilson-LO`);
    }
  }
}

// ── baseline up-rates recomputed from dirN markers alone ──
for (const b of S.noSkillBaselineUpRate) {
  const t = tally.dir[b.minutes];
  eq(t.valid, b.valid, `baseline ${b.minutes}m valid`);
  eq(t.up, b.up, `baseline ${b.minutes}m up`);
  eq(t.down, b.down, `baseline ${b.minutes}m down`);
  eq(t.tie, b.tie, `baseline ${b.minutes}m tie`);
  eq(+(t.up / t.valid).toFixed(4), b.upRate, `baseline ${b.minutes}m upRate`);
}

// ── summary data section agrees with the audit ──
eq(S.data.reduce((a, d) => a + d.evaluated, 0), tally.rows, 'per-pair evaluated sums to total');
eq(S.data.reduce((a, d) => a + d.signals, 0), tally.signals, 'per-pair signals sum to total');

console.log(`\nverify_ema_ribbon_audit: ${pass} checks passed, ${fail} failed`);
if (fail > 0) process.exit(1);

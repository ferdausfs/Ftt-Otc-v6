/**
 * Daily-bias FX — full-history backtest harness (ONE block, ONE pass).
 *
 * NO SPLIT, by spec: daily resolution has never been touched anywhere in
 * this project, so the entire available history for each pair runs as a
 * single block, one pass, reported as such (same convention as the FTT3-R
 * and EMA Ribbon full-block validations).
 *
 * Discipline (same standard as every prior report):
 *   - every evaluated day is written to results/DAILY_BIAS_FX_audit.jsonl:
 *     pair, day labels + raw timestamps, RAW D-2/D-1 high/low/close, day-D
 *     open/close, classification, decision, reason, entry, exit, result.
 *     Every AVOID day is logged too, with its reason (sweep-both /
 *     consolidation / unclassified). Every number in the report must be
 *     re-derivable from this file (scripts/verify_daily_bias_audit.mjs).
 *   - Win rate = Wilson 95% CI; buckets under MIN_BUCKET=30 decided trades
 *     are flagged INSUFFICIENT, never reported as a rate.
 *   - No-skill baseline: plain daily up-rate (close > open) per pair over
 *     the same full history, ties counted separately.
 *   - PASS/FAIL gate: Wilson lower bound vs breakeven 55.56% at 0.80 payout
 *     (100 / 1.80). PASS additionally requires consistency across pairs.
 *   - The rule is fully mechanical from D-2/D-1 values — there is no
 *     parameter to tune, and none may be added after seeing results.
 *
 * Run: node backtest/harness_daily_bias.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateDailyBiasDay, dayLabel } from '../src/strategy/dailyBiasFx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'daily');
const RESULTS = join(ROOT, 'results');

const MIN_BUCKET = 30;                    // decided trades for a reported rate
const PAYOUT = 0.80;                      // broker payout assumption (see report)
const BE_FRAC = 1 / (1 + PAYOUT);         // breakeven as a FRACTION: 0.555556
const BE_PCT = 100 * BE_FRAC;             // display form: 55.5556%

const PAIRS = [
  { pair: 'EUR/USD', name: 'EURUSD' },
  { pair: 'GBP/USD', name: 'GBPUSD' },
  { pair: 'USD/JPY', name: 'USDJPY' },
  { pair: 'AUD/USD', name: 'AUDUSD' },
];

const r6 = (x) => (x == null ? null : +x.toFixed(6));
const r8 = (x) => (x == null ? null : +x.toFixed(8));

// ── stats helpers (independent of any prior harness by design) ──────────────
function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { lo: null, hi: null, wr: null };
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
function pct(x) { return x == null ? 'n/a' : (100 * x).toFixed(1) + '%'; }

function rateRow(label, w, l, t) {
  const decided = w + l;
  const ci = wilson(w, decided);
  const cons = wilson(w, decided + t);
  return {
    label, wins: w, losses: l, ties: t,
    wr: decided ? ci.wr : null,
    wilsonLo: decided ? ci.lo : null,
    wilsonHi: decided ? ci.hi : null,
    conservativeWr: (decided + t) ? cons.wr : null,
    sufficient: decided >= MIN_BUCKET,
    note: decided >= MIN_BUCKET ? null : `INSUFFICIENT (n=${decided} < ${MIN_BUCKET})`,
  };
}
function tally(rows) {
  let w = 0, l = 0, t = 0;
  for (const r of rows) {
    if (r.result === 'WIN') w++;
    else if (r.result === 'LOSS') l++;
    else if (r.result === 'TIE') t++;
  }
  return { w, l, t };
}
function groupRate(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    if (r.decision === 'NO_TRADE') continue;
    const k = keyFn(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of g) {
    const { w, l, t } = tally(rs);
    out.push(rateRow(k, w, l, t));
  }
  return out;
}

// ── per-pair run ─────────────────────────────────────────────────────────────
function runPair({ pair, name }) {
  const { meta, candles } = JSON.parse(readFileSync(join(DATA, `${name}_d1.json`), 'utf8'));
  const rows = [];
  // day D needs two prior candles: indices 0 and 1 are warmup (no D-2 exists)
  for (let i = 2; i < candles.length; i++) {
    const d2 = candles[i - 2], d1 = candles[i - 1], d = candles[i];
    const r = evaluateDailyBiasDay(d2, d1, d);
    rows.push({
      pair,
      dayD: dayLabel(d.t), dayD1: dayLabel(d1.t), dayD2: dayLabel(d2.t),
      dt: d.t, d1t: d1.t, d2t: d2.t,
      d2: { h: r6(d2.h), l: r6(d2.l), c: r6(d2.c) },
      d1: { h: r6(d1.h), l: r6(d1.l), c: r6(d1.c) },
      d: { o: r6(d.o), c: r6(d.c) },
      classification: r.classification,
      decision: r.decision,
      reason: r.reason,
      entry: r6(r.entry),
      exit: r6(r.exit),
      priceDelta: r8(r.exit != null ? r.exit - r.entry : null),
      result: r.result,
    });
  }
  // plain daily up-rate over the pair's FULL available history (no-skill baseline)
  let up = 0, down = 0, tie = 0;
  for (const c of candles) {
    if (c.c > c.o) up++;
    else if (c.c < c.o) down++;
    else tie++;
  }
  return { pair, meta, candles, rows, baseline: { up, down, tie, n: up + down } };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  const runs = PAIRS.map(runPair);
  const rows = runs.flatMap(x => x.rows);
  const traded = rows.filter(r => r.decision !== 'NO_TRADE');

  // ── funnel ─────────────────────────────────────────────────────────────────
  const funnel = {
    candlesPerPair: Object.fromEntries(runs.map(x => [x.pair, x.candles.length])),
    warmupDays: Object.fromEntries(runs.map(x => [x.pair, 2])),
    evaluatedDays: rows.length,
    tradedDays: traded.length,
    avoidedDays: rows.length - traded.length,
    avoidedByReason: rows.filter(r => r.decision === 'NO_TRADE').reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1; return acc;
    }, {}),
    perPairTraded: Object.fromEntries(runs.map(x => [x.pair, x.rows.filter(r => r.decision !== 'NO_TRADE').length])),
  };

  // ── rate buckets ───────────────────────────────────────────────────────────
  const { w, l, t } = tally(traded);
  const overall = rateRow('overall', w, l, t);
  const byPair = groupRate(traded, r => r.pair).sort((a, b) => a.label.localeCompare(b.label));
  const byClass = ['BULLISH', 'BEARISH', 'VERY_BEARISH'].map(cl => {
    const rs = traded.filter(r => r.classification === cl);
    const tt = tally(rs);
    return rateRow(cl, tt.w, tt.l, tt.t);
  });
  const byDirection = groupRate(traded, r => r.decision).sort((a, b) => a.label.localeCompare(b.label));

  // ── no-skill baselines ─────────────────────────────────────────────────────
  const baselines = runs.map(x => ({
    pair: x.pair,
    up: x.baseline.up, down: x.baseline.down, tie: x.baseline.tie,
    upRate: +(x.baseline.up / x.baseline.n).toFixed(4),
    downRate: +(x.baseline.down / x.baseline.n).toFixed(4),
  }));
  const pooled = runs.reduce((a, x) => ({ up: a.up + x.baseline.up, down: a.down + x.baseline.down, tie: a.tie + x.baseline.tie }), { up: 0, down: 0, tie: 0 });
  const pooledBaseline = { ...pooled, n: pooled.up + pooled.down, upRate: +(pooled.up / (pooled.up + pooled.down)).toFixed(4) };

  // up-rate restricted to the days the strategy actually traded (diagnostic:
  // shows whether the AVOID filter shifted the window, nothing more)
  const tradedDayBaseline = runs.map(x => {
    const days = x.rows.filter(r => r.decision !== 'NO_TRADE');
    // recover up/down from the row's own d.o/d.c
    let up = 0, down = 0, tie = 0;
    for (const r of days) {
      if (r.d.c > r.d.o) up++; else if (r.d.c < r.d.o) down++; else tie++;
    }
    return { pair: x.pair, up, down, tie, upRate: (up + down) ? +(up / (up + down)).toFixed(4) : null };
  });

  // ── gate (all comparisons in FRACTIONS; margin in percentage points) ─────
  const pairLoOk = byPair.filter(b => b.sufficient).every(b => b.wilsonLo > BE_FRAC);
  const sufficientBuckets = byPair.filter(b => b.sufficient).length;
  const gate = {
    breakeven: +BE_PCT.toFixed(4),
    payout: PAYOUT,
    overallLoClears: Boolean(overall.sufficient && overall.wilsonLo != null && overall.wilsonLo > BE_FRAC),
    marginPp: overall.wilsonLo != null ? +((overall.wilsonLo - BE_FRAC) * 100).toFixed(2) : null,
    consistentAcrossPairs: Boolean(sufficientBuckets > 0 && pairLoOk),
    pass: Boolean(overall.sufficient && overall.wilsonLo != null && overall.wilsonLo > BE_FRAC && pairLoOk),
  };

  // ── write audit + summary ──────────────────────────────────────────────────
  writeFileSync(join(RESULTS, 'DAILY_BIAS_FX_audit.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const summary = {
    engine: 'Daily Liquidity-Sweep Bias (FX) — D-2/D-1 sweep classifier, entry at D open, expiry at D close; standalone module src/strategy/dailyBiasFx.mjs',
    startedAt: startedIso,
    mode: 'full available history, one block, one pass (no split — daily resolution never touched before)',
    payoutAssumption: PAYOUT,
    breakevenWr: +BE_PCT.toFixed(4),
    minBucket: MIN_BUCKET,
    data: runs.map(x => ({
      pair: x.pair, first: x.meta.first, last: x.meta.last, candles: x.meta.count,
      droppedAtSource: x.meta.droppedNulls, droppedPartialTail: x.meta.droppedPartial.length,
      maxGapDays: x.meta.maxGapDays, gapsOver5Days: x.meta.gapsOver5Days.length,
    })),
    funnel,
    tradedTotal: traded.length,
    rates: { overall, byPair, byClassification: byClass, byDirection },
    noSkillBaselineFullHistory: baselines,
    noSkillBaselinePooled: pooledBaseline,
    diagnosticUpRateOnTradedDaysOnly: tradedDayBaseline,
    gate,
    specNote: 'Under the mandated evaluation order (sweep-both first) with valid OHLC candles, BULLISH and VERY_BEARISH are mathematically unreachable: see scripts/daily_bias_tests.mjs header note 6 and the report. The literal spec trades BEARISH (PUT) days only.',
  };
  writeFileSync(join(RESULTS, 'DAILY_BIAS_FX_summary.json'), JSON.stringify(summary, null, 2));

  // ── console headline ───────────────────────────────────────────────────────
  console.log('══ DAILY BIAS FX — full available history, one block ══');
  for (const x of runs) {
    console.log(`${x.pair.padEnd(8)} candles=${x.candles.length} evaluated=${x.rows.length} traded=${x.rows.filter(r => r.decision !== 'NO_TRADE').length}`);
  }
  console.log(`\nfunnel: evaluated=${funnel.evaluatedDays} traded=${funnel.tradedDays} avoided=${funnel.avoidedDays} (${JSON.stringify(funnel.avoidedByReason)})`);
  const f = (x) => x == null ? '-' : (100 * x).toFixed(1) + '%';
  for (const r of [overall, ...byPair, ...byClass, ...byDirection]) {
    console.log(`${r.label.padEnd(16)} W=${r.wins} L=${r.losses} T=${r.ties}  WR=${f(r.wr)}  CI=[${f(r.wilsonLo)}, ${f(r.wilsonHi)}]  ${r.note ?? ''}`);
  }
  console.log('\nNo-skill baseline (plain daily up-rate, full history):');
  for (const b of baselines) console.log(`  ${b.pair.padEnd(8)} up=${b.up} down=${b.down} tie=${b.tie} upRate=${(100 * b.upRate).toFixed(1)}% downRate=${(100 * b.downRate).toFixed(1)}%`);
  console.log(`  POOLED   upRate=${(100 * pooledBaseline.upRate).toFixed(1)}%`);
  console.log(`\nGATE (Wilson-LO > breakeven ${BE_PCT.toFixed(2)}% @ payout ${PAYOUT}, consistent across pairs): ${gate.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  Wilson-LO ${f(overall.wilsonLo)} vs breakeven ${f(BE_FRAC)} -> margin ${(100 * (overall.wilsonLo - BE_FRAC)).toFixed(2)}pp`);
  console.log('audit: results/DAILY_BIAS_FX_audit.jsonl (every evaluated day)');
}

main();

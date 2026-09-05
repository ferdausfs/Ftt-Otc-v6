/**
 * FTT3-R CRYPTO EXT harness — 12-month NEVER-TOUCHED window, single block.
 *
 * PRE-REGISTERED CONTEXT (all frozen BEFORE this run — see PRE_REGISTRATION.md
 * and the pre-registration commit afb905f):
 *   - Regime thresholds ADX 25/20 (textbook), Strategy A = FTT3 C1/C2/C3
 *     unchanged, Strategy B = BB(20, 2σ population) + RSI(14) 70/30 +
 *     adjacency + snap-back, D3 = C3 math, expiry ladder 75/25 -> 5/7/10m.
 *   - NO parameter is tuned here. This window (2025-07-05T00:00Z ..
 *     2026-07-04T23:59:59Z evaluation span) predates every candle this
 *     project ever fetched (earliest prior data: 2026-07-05T00:00Z). It is
 *     reported as ONE block — there is no in-sample/OOS split because there
 *     is no tuning step.
 *   - Minimum bucket: 30 decided signals per reported rate (Wilson 95% CI);
 *     smaller buckets are flagged INSUFFICIENT, never presented as a rate.
 *   - Payout assumption 0.80 -> breakeven 55.5556% WR.
 *   - The burned 2026-07-05..09-05 window is NOT fetched, touched, or
 *     cross-referenced: backtest/data_ext ends exactly at 2026-07-05T00:00Z.
 *     The 14-day head buffer (2025-06-21..07-05) is indicator warmup only —
 *     no decision is evaluated inside it.
 *
 * Outcome convention (identical to harness.mjs / harness_regime.mjs): TIE
 * excluded from the headline W/(W+L), conservative W/(W+L+T) also reported;
 * missing exit candle -> EXPIRY_GAP, excluded, visible in the audit.
 *
 * Audit: results/FTT3R_CRYPTO_EXT_audit.jsonl — EVERY evaluated boundary
 * decision (CALL/PUT/NO_TRADE) for the 4 crypto pairs, with regime + strategy
 * tags, full condition values behind each verdict/block, entry/exit, result,
 * and per-row no-skill direction markers (dir5/dir7/dir10) so the baseline is
 * re-derivable from the JSONL itself.
 *
 * Run: node backtest/harness_crypto_ext.mjs
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateRegimeSignal, precompute, MS_1M, MS_5M, MS_15M, ATR_WINDOW } from '../src/strategy/engine.mjs';

// ════════════════════════════════════════════════════════════════════════════
// FROZEN EVALUATION WINDOW — never-touched 12-month crypto block.
// entryCloseT is restricted to [EVAL_START_MS, EVAL_END_MS). DO NOT EDIT.
// ════════════════════════════════════════════════════════════════════════════
export const EVAL_START = '2025-07-05T00:00:00Z';
export const EVAL_END = '2026-07-05T00:00:00Z';
// ════════════════════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data_ext');
const RESULTS = join(ROOT, 'results');

const START_MS = Date.parse(EVAL_START);
const END_MS = Date.parse(EVAL_END);
const MIN_BUCKET = 30;
const ATR_WARMUP_1M = ATR_WINDOW + 14;
const ADX_WARMUP_15M = 2 * 14;
const PAYOUT = 0.80;
const BREAKEVEN = 100 / (1 + PAYOUT);

const PAIRS = [
  { pair: 'BTC/USD', market: 'crypto' }, { pair: 'ETH/USD', market: 'crypto' },
  { pair: 'XRP/USD', market: 'crypto' }, { pair: 'SOL/USD', market: 'crypto' },
];

// ── stats helpers (same conventions as harness.mjs / harness_regime.mjs) ────
function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { lo: null, hi: null, wr: null };
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}

// ── per-pair run (ext window only) ──────────────────────────────────────────
function loadPair(name) {
  const out = {};
  for (const tf of ['m1', 'm5', 'm15']) {
    const file = join(DATA, `${name}_${tf}.json`);
    if (!existsSync(file)) throw new Error(`missing data file ${name}_${tf}.json — fetch real data first (no synthesis)`);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j.candles || j.candles.length === 0) throw new Error(`zero candles in ${name}_${tf}.json — aborting`);
    out[tf] = j.candles;
  }
  return out;
}

function dirMarker(c1, i, n) {
  const exitIdx = i + n;
  if (exitIdx >= c1.length || c1[exitIdx].t !== c1[i].t + n * MS_1M) return null;
  const d = c1[exitIdx].c - c1[i].c;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

function buildRow(pair, market, r, c1, i, entryCloseT) {
  const row = {
    pair, market,
    ts: new Date(entryCloseT).toISOString(),
    decision: r.decision, stage: r.stage, reason: r.reason,
    regime: r.audit.regime ? r.audit.regime.regime : null,
    adx: r.audit.regime ? r.audit.regime.adx : null,
    strategy: r.audit.strategy,
    c1: r.audit.c1, c2: r.audit.c2, c3: r.audit.c3,
    d1: r.audit.d1, d2: r.audit.d2, d3: r.audit.d3,
    expiryMinutes: r.audit.expiry ? r.audit.expiry.minutes : null,
    atrPercentile: (r.audit.c3 && r.audit.c3.atrPercentile != null)
      ? r.audit.c3.atrPercentile
      : (r.audit.d3 ? r.audit.d3.atrPercentile : null),
    entryPrice: (r.decision === 'CALL' || r.decision === 'PUT' || r.audit.c1 || r.audit.d1)
      ? +c1[i].c.toFixed(6) : null,
    exitTime: null, exitPrice: null, result: null, priceDelta: null,
    dir5: dirMarker(c1, i, 5), dir7: dirMarker(c1, i, 7), dir10: dirMarker(c1, i, 10),
  };
  if (r.decision === 'CALL' || r.decision === 'PUT') {
    const n = r.audit.expiry.minutes;
    const exitIdx = i + n;
    if (exitIdx < c1.length && c1[exitIdx].t === c1[i].t + n * MS_1M) {
      const entry = c1[i].c, exit = c1[exitIdx].c;
      row.exitTime = new Date(c1[exitIdx].t + MS_1M).toISOString();
      row.exitPrice = +exit.toFixed(6);
      row.priceDelta = +(exit - entry).toFixed(8);
      if (exit === entry) row.result = 'TIE';
      else if (r.decision === 'CALL') row.result = exit > entry ? 'WIN' : 'LOSS';
      else row.result = exit < entry ? 'WIN' : 'LOSS';
    } else {
      row.result = 'EXPIRY_GAP';
    }
  }
  return row;
}

const AUDIT = join(RESULTS, 'FTT3R_CRYPTO_EXT_audit.jsonl');

function runPair({ pair, market }) {
  const name = pair.replace('/', '');
  const d = loadPair(name);
  const c1 = d.m1, c5 = d.m5, c15 = d.m15;
  const pre = precompute({ c15, c5, c1 });

  const warmupEndT = c1[0].t + ATR_WARMUP_1M * MS_1M;
  const adxReadyT = c15.length > ADX_WARMUP_15M ? c15[ADX_WARMUP_15M].t + MS_15M : Infinity;

  let skippedPreWindow = 0, skippedPostWindow = 0, skippedWarmup = 0;
  let pairRows = 0, pairSignals = 0, pairGaps = 0;
  const funnel = {};
  // rate buckets: key -> {w,l,t}
  const buckets = new Map();
  const bump = (key, result) => {
    if (!buckets.has(key)) buckets.set(key, { w: 0, l: 0, t: 0 });
    const b = buckets.get(key);
    if (result === 'WIN') b.w++; else if (result === 'LOSS') b.l++; else if (result === 'TIE') b.t++;
  };
  const batch = [];
  const flush = () => {
    if (batch.length) { appendFileSync(AUDIT, batch.join('\n') + '\n'); batch.length = 0; }
  };

  for (let i = 0; i < c1.length; i++) {
    const entryCloseT = c1[i].t + MS_1M;
    if (entryCloseT < START_MS) { skippedPreWindow++; continue; }     // warmup buffer — never evaluated
    if (entryCloseT >= END_MS) { skippedPostWindow++; continue; }     // window ends strictly 2026-07-05T00:00Z
    if (entryCloseT < warmupEndT || entryCloseT < adxReadyT) { skippedWarmup++; continue; }
    if (entryCloseT % MS_5M !== 0) continue;                          // decisions only exist at 5m boundaries

    const r = evaluateRegimeSignal(c15, c5, c1, i, pre);
    const row = buildRow(pair, market, r, c1, i, entryCloseT);

    pairRows++;
    funnel[r.reason] = (funnel[r.reason] || 0) + 1;
    if (r.decision !== 'NO_TRADE') {
      pairSignals++;
      if (row.result === 'EXPIRY_GAP') pairGaps++;
      bump('OVERALL', row.result);
      bump('pair:' + pair, row.result);
      if (row.strategy) bump('strategy:' + row.strategy, row.result);
      if (row.strategy) bump('pairstrat:' + pair + '|' + row.strategy, row.result);
      if (row.regime) bump('regime:' + row.regime, row.result);
      bump('tier:' + row.expiryMinutes + 'm', row.result);
      bump('dir:' + r.decision, row.result);
    }
    batch.push(JSON.stringify(row));
    if (batch.length >= 20000) flush();
  }
  flush();

  return { pair, market, pairRows, pairSignals, pairGaps, funnel, buckets,
           skippedPreWindow, skippedPostWindow, skippedWarmup,
           first: new Date(c1[0].t).toISOString(), last: new Date(c1[c1.length - 1].t).toISOString() };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  console.log(`FTT3-R CRYPTO EXT harness — never-touched window ${EVAL_START} .. ${EVAL_END} (single block, no split)`);
  writeFileSync(AUDIT, '');   // fresh audit per run — never append across runs

  const perPair = [];
  const merged = new Map();
  for (const p of PAIRS) {
    const t0 = Date.now();
    const res = runPair(p);
    perPair.push(res);
    for (const [k, v] of res.buckets) {
      if (!merged.has(k)) merged.set(k, { w: 0, l: 0, t: 0 });
      const m = merged.get(k);
      m.w += v.w; m.l += v.l; m.t += v.t;
    }
    console.log(`${p.pair.padEnd(8)} rows=${res.pairRows} signals=${res.pairSignals} ` +
                `data=${res.first.slice(0, 10)}..${res.last.slice(0, 10)} ` +
                `(skipped: pre-window ${res.skippedPreWindow}, post-window ${res.skippedPostWindow}, warmup ${res.skippedWarmup}) ` +
                `[${((Date.now() - t0) / 1000).toFixed(0)}s]`);
  }

  const totalRows = perPair.reduce((n, r) => n + r.pairRows, 0);
  const totalSignals = perPair.reduce((n, r) => n + r.pairSignals, 0);
  const totalGaps = perPair.reduce((n, r) => n + r.pairGaps, 0);
  const funnel = {};
  for (const r of perPair) for (const [k, v] of Object.entries(r.funnel)) funnel[k] = (funnel[k] || 0) + v;

  const overall = merged.get('OVERALL') || { w: 0, l: 0, t: 0 };
  const decided = overall.w + overall.l;

  const summary = {
    engine: 'FTT3-R regime-adaptive (ADX14@15m: >=25 TRENDING -> A: C1/C2/C3; <20 RANGING -> B: D1/D2/D3; 20-25 TRANSITION -> NO_TRADE; expiry tiers 75/25 -> 5/7/10m)',
    startedAt: startedIso,
    window: { start: EVAL_START, end: EVAL_END, singleBlock: true, walkForward: false },
    burnedWindowTouched: false,
    payoutAssumption: PAYOUT,
    breakevenWr: +BREAKEVEN.toFixed(4),
    minBucket: MIN_BUCKET,
    pairs: perPair.map(p => ({ pair: p.pair, rows: p.pairRows, signals: p.pairSignals, expiryGaps: p.pairGaps,
      dataStart: p.first, dataEnd: p.last, skipped: {
        preWindow: p.skippedPreWindow, postWindow: p.skippedPostWindow, warmup: p.skippedWarmup } })),
    totalRows, totalSignals,
    ties: overall.t,
    expiryGaps: totalGaps,
    funnel,
    buckets: Object.fromEntries([...merged.entries()].map(([k, v]) => [k, v])),
    auditFile: 'results/FTT3R_CRYPTO_EXT_audit.jsonl',
  };
  writeFileSync(join(RESULTS, 'FTT3R_CRYPTO_EXT_summary.json'), JSON.stringify(summary, null, 2));

  const auditSize = statSync(AUDIT).size;
  console.log(`\naudit: ${AUDIT} (${(auditSize / 1e6).toFixed(1)} MB, ${totalRows} rows, ${totalSignals} signals)`);
  console.log(`\n══ EXT-WINDOW BUCKETS (min n=${MIN_BUCKET} per rate; breakeven ${BREAKEVEN.toFixed(2)}% @ payout ${PAYOUT}) ══`);
  const fmt = (x) => x == null ? '-' : (100 * x).toFixed(1) + '%';
  const order = ['OVERALL', 'strategy:TREND', 'strategy:MEANREV', 'regime:TRENDING', 'regime:RANGING',
    'pair:BTC/USD', 'pair:ETH/USD', 'pair:XRP/USD', 'pair:SOL/USD'];
  for (const k of order) {
    const v = merged.get(k);
    if (!v) { console.log(`${k.padEnd(24)} — no decided signals`); continue; }
    const n = v.w + v.l;
    const ci = wilson(v.w, n);
    const suff = n >= MIN_BUCKET ? '' : `  INSUFFICIENT (n=${n} < ${MIN_BUCKET})`;
    console.log(`${k.padEnd(24)} W=${v.w} L=${v.l} T=${v.t}  WR=${fmt(ci.wr)}  CI=[${fmt(ci.lo)}, ${fmt(ci.hi)}]${suff}`);
  }
  for (const [k, v] of [...merged.entries()].filter(([k]) => k.startsWith('pairstrat:')).sort()) {
    const n = v.w + v.l;
    const ci = wilson(v.w, n);
    const suff = n >= MIN_BUCKET ? '' : `  INSUFFICIENT (n=${n} < ${MIN_BUCKET})`;
    console.log(`${k.padEnd(24)} W=${v.w} L=${v.l} T=${v.t}  WR=${fmt(ci.wr)}  CI=[${fmt(ci.lo)}, ${fmt(ci.hi)}]${suff}`);
  }
  const gate = ci => ci.lo != null && ci.lo * 100 > BREAKEVEN;
  const oci = wilson(overall.w, decided);
  console.log(`\nOVERALL GATE (Wilson-LO > breakeven ${BREAKEVEN.toFixed(2)}%): ` +
              `${decided >= MIN_BUCKET ? (gate(oci) ? 'PASS' : 'FAIL') : 'NOT EVALUABLE (n<' + MIN_BUCKET + ')'}`);
  console.log('Baseline up-rates are re-derived from the dir5/dir7/dir10 markers in the audit JSONL by the report script.');
}

main();

/**
 * EMA RIBBON — full-window backtest harness. ONE BLOCK, NO SPLIT, NO TUNING.
 *
 * PRE-REGISTERED (see PRE_REGISTRATION_EMA_RIBBON.md, committed before this
 * harness ever touches the target data):
 *   - Evaluation window 2024-07-05T00:00Z .. 2025-07-05T00:00Z — genuinely
 *     unused history (every crypto candle this project had fetched before
 *     covers 2025-07-05T00:00Z onwards). Warmup candles before the window
 *     feed indicators only and are NEVER evaluated. No split: the whole
 *     12-month block is one pre-registered OOS result, reported once.
 *   - Parameters frozen: bias EMA 5/13/55 @15m, trigger EMA 5/7/13 @1m,
 *     expiry = the FTT3 ATR ladder (ATR14 @1m, trailing-100 percentile,
 *     tiers 75/25 -> 5/7/10m) reused verbatim — expiry selects duration,
 *     never gates entries. No volatility condition, no third condition,
 *     no pair-specific anything.
 *   - Minimum bucket: 30 decided signals per reported rate (Wilson 95% CI);
 *     smaller buckets are flagged INSUFFICIENT, never quoted as a rate.
 *   - Payout assumption 0.80 -> breakeven 55.5556% WR (same as every prior
 *     test here). The actual broker payout must be confirmed before
 *     finalizing any live decision; the report carries a sensitivity note.
 *   - Outcome convention (identical to prior harnesses): TIE stored and
 *     counted separately, excluded from the headline W/(W+L); conservative
 *     W/(W+L+T) also reported; missing exit candle -> EXPIRY_GAP, excluded.
 *   - Every evaluated boundary (signal AND every NO_TRADE with its blocking
 *     reason and raw values) is written to results/EMA_RIBBON_audit.jsonl.gz,
 *     including per-row no-skill direction markers dir5/dir7/dir10 (+1 up /
 *     -1 down / 0 tie / null gap) so the baseline is recomputable from the
 *     audit alone. scripts/verify_ema_ribbon_audit.mjs re-derives every
 *     reported number from that file independently.
 *
 * Run: node backtest/harness_ema_ribbon.mjs
 */
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  evaluateEmaRibbon, precomputeEmaRibbon,
  BIAS_FAST, BIAS_MID, BIAS_SLOW, TRIG_FAST, TRIG_MID, TRIG_SLOW,
  ATR_PERIOD, ATR_WINDOW, MS_1M, MS_15M,
} from '../src/strategy/emaRibbon.mjs';

// ════════════════════════════════════════════════════════════════════════════
// EVALUATION WINDOW — FROZEN IN THE PRE-REGISTRATION COMMIT. NEVER RE-SLICED.
// ════════════════════════════════════════════════════════════════════════════
export const EVAL_FROM = '2024-07-05T00:00:00Z';
export const EVAL_TO = '2025-07-05T00:00:00Z';
// ════════════════════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ext2');
const RESULTS = join(ROOT, 'results');

const FROM_MS = Date.parse(EVAL_FROM);
const TO_MS = Date.parse(EVAL_TO);
const MIN_BUCKET = 30;
const PAYOUT = 0.80;
const BREAKEVEN = 100 / (1 + PAYOUT);   // 55.5556%

const PAIRS = [
  { pair: 'BTC/USD', market: 'crypto' }, { pair: 'ETH/USD', market: 'crypto' },
  { pair: 'XRP/USD', market: 'crypto' }, { pair: 'SOL/USD', market: 'crypto' },
];

// ── stats helpers (same conventions as harness.mjs / harness_regime.mjs) ─────
function wilson(w, n, z = 1.959963985) {
  if (n === 0) return { lo: null, hi: null, wr: null };
  const p = w / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { wr: p, lo: (c - s) / d, hi: (c + s) / d };
}
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
function groupRate(map, prefix) {
  return [...map.entries()].map(([k, v]) => rateRow(prefix + k, v.w, v.l, v.t));
}
function bump(map, key, result) {
  if (!map.has(key)) map.set(key, { w: 0, l: 0, t: 0 });
  const g = map.get(key);
  if (result === 'WIN') g.w++;
  else if (result === 'LOSS') g.l++;
  else if (result === 'TIE') g.t++;
}
const r8 = (v) => (v == null ? null : +v.toFixed(8));
const r6 = (v) => (v == null ? null : +v.toFixed(6));

// ── per-pair run ─────────────────────────────────────────────────────────────
function loadPair(name) {
  const out = {};
  for (const tf of ['m1', 'm15']) {
    const file = join(DATA, `${name}_${tf}.json`);
    if (!existsSync(file)) throw new Error(`missing data file ${name}_${tf}.json — fetch real data first (no synthesis)`);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (!j.candles || j.candles.length === 0) throw new Error(`zero candles in ${name}_${tf}.json — aborting`);
    out[tf] = j.candles;
    out[`${tf}Meta`] = j.meta;
  }
  return out;
}

function runPair({ pair, market }, auditPath) {
  const name = pair.replace('/', '');
  const d = loadPair(name);
  const c15 = d.m15, c1 = d.m1;
  const pre = precomputeEmaRibbon({ c15, c1 });

  // first evaluable boundary: entry close at/after the window open
  let first = -1;
  for (let i = 0; i < c1.length; i++) {
    if (c1[i].t + MS_1M >= FROM_MS) { first = i; break; }
  }
  if (first === -1) throw new Error(`${pair}: no 1m candle at/after ${EVAL_FROM} — bad data`);

  // WARMUP PROOF at the first evaluable boundary — fail loudly, never shorten
  {
    const entryCloseT = c1[first].t + MS_1M;
    let i15 = 0;
    while (i15 + 1 < c15.length && c15[i15 + 1].t + MS_15M <= entryCloseT) i15++;
    const need = [
      ['EMA55(15m) defined', pre.ema55_15[i15] !== undefined],
      ['EMA13(15m) defined', pre.ema13_15[i15] !== undefined],
      ['ATR window starts >= 100 closed 1m candles', first >= ATR_WINDOW - 1 + ATR_PERIOD && pre.atr1[first - (ATR_WINDOW - 1)] !== undefined],
      ['1m EMAs defined', pre.ema13_1[first] !== undefined && pre.ema13_1[first - 1] !== undefined],
    ];
    for (const [what, good] of need) {
      if (!good) throw new Error(`${pair}: warmup insufficient at first boundary — ${what}. Fetch more lookback; do NOT evaluate uninitialized indicators.`);
    }
  }

  let buf = [];
  const flush = () => { if (buf.length) { appendFileSync(auditPath, buf.join('\n') + '\n'); buf = []; } };

  const stats = {
    pair, market,
    evaluated: 0, skippedWarmup: first, skippedAfterWindow: 0,
    signals: 0, dirTally: { 5: { valid: 0, up: 0, down: 0, tie: 0 }, 7: { valid: 0, up: 0, down: 0, tie: 0 }, 10: { valid: 0, up: 0, down: 0, tie: 0 } },
    rates: { byTier: new Map(), byDir: new Map() }, wins: 0, losses: 0, ties: 0, gaps: 0,
    dataMeta: { m1: d.m1Meta, m15: d.m15Meta },
  };
  const reasons = {};

  let i15 = 0;
  for (let i = first; i < c1.length; i++) {
    const entryCloseT = c1[i].t + MS_1M;
    if (entryCloseT >= TO_MS) { stats.skippedAfterWindow = c1.length - i; break; }
    while (i15 + 1 < c15.length && c15[i15 + 1].t + MS_15M <= entryCloseT) i15++;
    stats.evaluated++;

    // per-row no-skill direction markers over the three expiry windows
    const dir = { 5: null, 7: null, 10: null };
    for (const n of [5, 7, 10]) {
      const x = i + n;
      if (x < c1.length && c1[x].t === c1[i].t + n * MS_1M) {
        const t = stats.dirTally[n];
        t.valid++;
        if (c1[x].c > c1[i].c) { dir[n] = 1; t.up++; }
        else if (c1[x].c < c1[i].c) { dir[n] = -1; t.down++; }
        else { dir[n] = 0; t.tie++; }
      }
    }

    const r = evaluateEmaRibbon(c15, c1, i, Object.assign(pre, { i15 }));
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;

    const row = {
      pair, market,
      ts: new Date(entryCloseT).toISOString(),
      decision: r.decision, stage: r.stage, reason: r.reason,
      c1: r.audit.c1 ? {
        ema5: r8(r.audit.c1.ema5), ema13: r8(r.audit.c1.ema13), ema55: r8(r.audit.c1.ema55),
        bias: r.audit.c1.bias,
      } : null,
      c2: r.audit.c2 ? {
        ema5: r8(r.audit.c2.ema5), ema7: r8(r.audit.c2.ema7), ema13: r8(r.audit.c2.ema13),
        ema5Prev: r8(r.audit.c2.ema5Prev), ema7Prev: r8(r.audit.c2.ema7Prev), ema13Prev: r8(r.audit.c2.ema13Prev),
        flip: r.audit.c2.flip,
      } : null,
      expiryMinutes: r.audit.expiry ? r.audit.expiry.minutes : null,
      atrPercentile: r.audit.atr ? +r.audit.atr.atrPercentile.toFixed(4) : null,
      entryPrice: r.audit.c1 ? r6(c1[i].c) : null,
      exitTime: null, exitPrice: null, result: null, priceDelta: null,
      dir5: dir[5], dir7: dir[7], dir10: dir[10],
    };

    if (r.decision === 'CALL' || r.decision === 'PUT') {
      stats.signals++;
      const n = r.audit.expiry.minutes;
      const exitIdx = i + n;
      if (exitIdx < c1.length && c1[exitIdx].t === c1[i].t + n * MS_1M) {
        const entry = c1[i].c, exit = c1[exitIdx].c;
        row.exitTime = new Date(c1[exitIdx].t + MS_1M).toISOString();
        row.exitPrice = r6(exit);
        row.priceDelta = +(exit - entry).toFixed(8);
        if (exit === entry) row.result = 'TIE';
        else if (r.decision === 'CALL') row.result = exit > entry ? 'WIN' : 'LOSS';
        else row.result = exit < entry ? 'WIN' : 'LOSS';
      } else {
        row.result = 'EXPIRY_GAP';
      }
      bump(stats.rates.byTier, 'expiry' + n, row.result);
      bump(stats.rates.byDir, r.decision, row.result);
      if (row.result === 'WIN') stats.wins++;
      else if (row.result === 'LOSS') stats.losses++;
      else if (row.result === 'TIE') stats.ties++;
      else stats.gaps++;
    }
    buf.push(JSON.stringify(row));
    if (buf.length >= 50000) flush();
  }
  flush();
  stats.reasons = reasons;
  return stats;
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  console.log(`EMA Ribbon harness — one pre-registered block ${EVAL_FROM} -> ${EVAL_TO} (no split, no tuning)`);
  const auditPath = join(RESULTS, 'EMA_RIBBON_audit.jsonl');
  if (existsSync(auditPath)) unlinkSync(auditPath);

  const all = [];
  for (const p of PAIRS) {
    const s = runPair(p, auditPath);
    all.push(s);
    console.log(`${p.pair.padEnd(8)} evaluated=${s.evaluated} signals=${s.signals} (W${s.wins}/L${s.losses}/T${s.ties}/gap${s.gaps}) warmupSkipped=${s.skippedWarmup}`);
  }

  // ── aggregate (from tallies; the verify script re-derives from the audit) ──
  const rows = { w: 0, l: 0, t: 0 };
  for (const s of all) { rows.w += s.wins; rows.l += s.losses; rows.t += s.ties; }
  const overall = rateRow('overall', rows.w, rows.l, rows.t);
  const byPair = all.map(s => rateRow('pair ' + s.pair, s.wins, s.losses, s.ties));
  const tierMerged = new Map();
  const dirMerged = new Map();
  for (const s of all) {
    for (const [k, v] of s.rates.byTier) {
      if (!tierMerged.has(k)) tierMerged.set(k, { w: 0, l: 0, t: 0 });
      const g = tierMerged.get(k); g.w += v.w; g.l += v.l; g.t += v.t;
    }
    for (const [k, v] of s.rates.byDir) {
      if (!dirMerged.has(k)) dirMerged.set(k, { w: 0, l: 0, t: 0 });
      const g = dirMerged.get(k); g.w += v.w; g.l += v.l; g.t += v.t;
    }
  }
  const byTier = groupRate(tierMerged, '');
  const byDirection = groupRate(dirMerged, '');

  // no-skill baseline: up-rate over all evaluated boundaries, same gap/tie
  // handling as the strategy (ties stay in the denominator — P(up), and the
  // audit's dirN fields let anyone recompute this exactly)
  const baselines = [5, 7, 10].map(n => {
    const agg = { minutes: n, valid: 0, up: 0, down: 0, tie: 0 };
    for (const s of all) {
      const b = s.dirTally[n];
      agg.valid += b.valid; agg.up += b.up; agg.down += b.down; agg.tie += b.tie;
    }
    agg.upRate = agg.valid ? +(agg.up / agg.valid).toFixed(4) : null;
    return agg;
  });

  const funnel = {};
  for (const s of all) for (const [k, v] of Object.entries(s.reasons || {})) funnel[k] = (funnel[k] || 0) + v;

  const summary = {
    engine: `EMA Ribbon (C1 EMA ${BIAS_FAST}/${BIAS_MID}/${BIAS_SLOW}@15m full-order bias, C2 EMA ${TRIG_FAST}/${TRIG_MID}/${TRIG_SLOW}@1m flip trigger matching C1; expiry = FTT3 ATR${ATR_PERIOD}@1m trailing-${ATR_WINDOW} percentile ladder 75/25 -> 5/7/10m, reused, no gate)`,
    startedAt: startedIso,
    evalFrom: EVAL_FROM, evalTo: EVAL_TO,
    splitUsed: false,
    payoutAssumption: PAYOUT,
    breakevenWr: +BREAKEVEN.toFixed(4),
    minBucket: MIN_BUCKET,
    data: all.map(s => ({
      pair: s.pair, evaluated: s.evaluated, signals: s.signals,
      warmupSkipped: s.skippedWarmup, afterWindowSkipped: s.skippedAfterWindow,
      m1Count: s.dataMeta.m1.count, m1MissingOnGrid: s.dataMeta.m1.missingOnGrid,
      m1MaxGapMinutes: s.dataMeta.m1.maxGapMinutes,
      m15Count: s.dataMeta.m15.count, m15MissingOnGrid: s.dataMeta.m15.missingOnGrid,
      m15MaxGapMinutes: s.dataMeta.m15.maxGapMinutes,
    })),
    totalEvaluated: all.reduce((a, s) => a + s.evaluated, 0),
    totalSignals: all.reduce((a, s) => a + s.signals, 0),
    totalTies: rows.t,
    totalExpiryGaps: all.reduce((a, s) => a + s.gaps, 0),
    funnel,
    rates: { overall, byPair, byTier, byDirection },
    noSkillBaselineUpRate: baselines,
  };
  writeFileSync(join(RESULTS, 'ema_ribbon_summary.json'), JSON.stringify(summary, null, 2));

  // ── gzip the audit (raw jsonl stays out of git; .gz is the artifact) ──────
  flushAndGzip(auditPath);

  // ── verdict ────────────────────────────────────────────────────────────────
  const fmt = (x) => x == null ? '-' : (100 * x).toFixed(1) + '%';
  console.log('\n══ HEADLINE (one 12-month block, touched once) ══');
  for (const r of [overall, ...byDirection, ...byTier, ...byPair]) {
    console.log(`${r.label.padEnd(24)} W=${r.wins} L=${r.losses} T=${r.ties}  WR=${fmt(r.wr)}  CI=[${fmt(r.wilsonLo)}, ${fmt(r.wilsonHi)}]  ${r.note ?? ''}`);
  }
  console.log('\nNo-skill baseline up-rate (all evaluated boundaries):');
  for (const b of baselines) console.log(`  ${b.minutes}m window: n=${b.valid} up=${b.up} down=${b.down} tie=${b.tie} upRate=${b.upRate}`);

  const decided = overall.wins + overall.losses;
  const gate = overall.wilsonLo != null && overall.wilsonLo * 100 > BREAKEVEN;
  const verdict = !overall.sufficient ? 'INSUFFICIENT' : (gate ? 'PASS' : 'FAIL');
  console.log(`\nVERDICT: ${verdict}`);
  console.log(`GATE (Wilson-LO > breakeven ${BREAKEVEN.toFixed(2)}% @ payout ${PAYOUT}): ${gate ? 'PASS' : 'FAIL'} (decided n=${decided})`);
  console.log('audit: results/EMA_RIBBON_audit.jsonl.gz (every evaluated boundary, dir5/dir7/dir10 markers)');
  if (verdict === 'INSUFFICIENT') process.exitCode = 2;
}

function flushAndGzip(auditPath) {
  const gz = spawnSync('gzip', ['-9', '-f', auditPath], { stdio: 'inherit' });
  if (gz.status !== 0 || !existsSync(auditPath + '.gz')) {
    throw new Error('gzip of audit failed — refusing to leave an uncompressed multi-GB artifact behind');
  }
}

main();

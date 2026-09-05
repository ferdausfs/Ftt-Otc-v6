/**
 * FTT3-R — regime-adaptive backtest harness. FRESH WINDOW ONLY.
 *
 * PRE-REGISTERED (frozen in the pre-registration commit BEFORE this harness
 * ever runs on post-split data — see PRE_REGISTRATION.md):
 *   - REGIME_SPLIT_DATE below is the moment the fresh OOS window opens. Rows
 *     BEFORE the split are NEVER evaluated here: the FTT3 OOS window (through
 *     2026-09-05) is burned — it produced the FTT3 verdict and must not leak
 *     into this one, not even for diagnostics.
 *   - Regime thresholds ADX 25/20 (textbook values, not tuned on any FTT
 *     dataset), Strategy A params (unchanged FTT3), Strategy B params
 *     (BB 20/2σ population, RSI 14 Wilder 70/30, adjacency requirement),
 *     expiry ladder 75/25 -> 5/7/10 min — all fixed in src/strategy/*.
 *   - Minimum bucket: 30 decided signals per reported rate (Wilson 95% CI;
 *     smaller buckets are flagged INSUFFICIENT, never reported as a rate).
 *   - Payout assumption 0.80 -> breakeven 55.5556% WR. Confirm the live
 *     broker's actual payout before finalizing any verdict.
 *   - VERDICT IS DEFERRED until the OVERALL fresh bucket has >= 30 decided
 *     signals. A run with fewer prints DEFERRED and stops — wait for the
 *     live FTT3 collector to accumulate post-split data. NEVER re-slice the
 *     old window to fill buckets.
 *
 * Outcome convention (identical to backtest/harness.mjs): TIE excluded from
 * the headline W/(W+L) rate, conservative W/(W+L+T) also reported; missing
 * exit candle -> EXPIRY_GAP, excluded.
 *
 * Data: backtest/data/{PAIR}_{m1,m5,m15}.json (same layout as the FTT3
 * harness; the cached files end 2026-09-05T01:00Z). When the fresh window
 * has accumulated, RE-FETCH with windows that reach back before the split
 * for indicator warmup and extend to "now", e.g.:
 *   crypto m1/m5/m15 : from 2026-09-05T00:00Z minus 2 days  -> now
 *   forex  5m/15m    : from max(2026-09-05 minus 60d, Yahoo 60d cap) -> now
 *   forex  1m        : from max(2026-09-05 minus 29d, now-29d)      -> now
 * Zero candles -> loud failure (no synthesis, ever).
 *
 * Run: node backtest/harness_regime.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateRegimeSignal, precompute, MS_1M, MS_5M, MS_15M, ATR_WINDOW } from '../src/strategy/engine.mjs';

// ════════════════════════════════════════════════════════════════════════════
// FRESH-WINDOW SPLIT — COMMITTED IN THE PRE-REGISTRATION COMMIT.
// The FTT3 OOS window (..2026-09-05) is burned. Everything at/after this
// instant is genuinely new evidence. DO NOT EDIT AFTERWARDS.
// ════════════════════════════════════════════════════════════════════════════
export const REGIME_SPLIT_DATE = '2026-09-05T00:00:00Z';
// ════════════════════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data');
const RESULTS = join(ROOT, 'results');

const SPLIT_MS = Date.parse(REGIME_SPLIT_DATE);
const MIN_BUCKET = 30;
const ATR_WARMUP_1M = ATR_WINDOW + 14;   // 1m candles before C3/D3 can pass
const ADX_WARMUP_15M = 2 * 14;           // first ADX(14) at 15m index 27
const PAYOUT = 0.80;
const BREAKEVEN = 100 / (1 + PAYOUT);    // 55.5556%

const PAIRS = [
  { pair: 'BTC/USD', market: 'crypto' }, { pair: 'ETH/USD', market: 'crypto' },
  { pair: 'XRP/USD', market: 'crypto' }, { pair: 'SOL/USD', market: 'crypto' },
  { pair: 'EUR/USD', market: 'forex' }, { pair: 'GBP/USD', market: 'forex' },
  { pair: 'USD/JPY', market: 'forex' }, { pair: 'AUD/USD', market: 'forex' },
];

// ── stats helpers (same conventions as harness.mjs) ──────────────────────────
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
function groupRate(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    if (r.result !== 'WIN' && r.result !== 'LOSS' && r.result !== 'TIE') continue;
    const k = keyFn(r);
    if (!g.has(k)) g.set(k, { w: 0, l: 0, t: 0 });
    g.get(k)[r.result === 'WIN' ? 'w' : r.result === 'LOSS' ? 'l' : 't']++;
  }
  return g;
}
function wl(rows) {
  let w = 0, l = 0, t = 0;
  for (const r of rows) {
    if (r.result === 'WIN') w++;
    else if (r.result === 'LOSS') l++;
    else if (r.result === 'TIE') t++;
  }
  return [w, l, t];
}

// ── per-pair run (fresh window only) ─────────────────────────────────────────
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

function runPair({ pair, market }) {
  const name = pair.replace('/', '');
  const d = loadPair(name);
  const c1 = d.m1, c5 = d.m5, c15 = d.m15;
  const lastCandleT = c1[c1.length - 1].t;
  const pre = precompute({ c15, c5, c1 });

  const rows = [];
  const base = { 5: { valid: 0, up: 0, down: 0, tie: 0 }, 7: { valid: 0, up: 0, down: 0, tie: 0 }, 10: { valid: 0, up: 0, down: 0, tie: 0 } };
  let skippedBeforeSplit = 0;
  let skippedWarmup = 0;
  const warmupEndT = c1[0].t + ATR_WARMUP_1M * MS_1M;
  const adxReadyT = c15.length > ADX_WARMUP_15M ? c15[ADX_WARMUP_15M].t + MS_15M : Infinity;

  for (let i = 0; i < c1.length; i++) {
    const entryCloseT = c1[i].t + MS_1M;
    if (entryCloseT < SPLIT_MS) { skippedBeforeSplit++; continue; }   // burned window — never evaluated
    if (entryCloseT < warmupEndT || entryCloseT < adxReadyT) { skippedWarmup++; continue; }
    if ((c1[i].t + MS_1M) % MS_5M !== 0) continue;

    // no-skill baseline tally: up-rate over each expiry window across ALL
    // fresh boundary candidates (identical gap/tie handling as the strategy)
    for (const n of [5, 7, 10]) {
      const exitIdx = i + n;
      if (exitIdx >= c1.length || c1[exitIdx].t !== c1[i].t + n * MS_1M) continue;
      base[n].valid++;
      if (c1[exitIdx].c > c1[i].c) base[n].up++;
      else if (c1[exitIdx].c < c1[i].c) base[n].down++;
      else base[n].tie++;
    }

    const r = evaluateRegimeSignal(c15, c5, c1, i, pre);
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
    rows.push(row);
  }
  return { pair, market, rows, lastCandleT, skippedBeforeSplit, skippedWarmup, base };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  console.log(`FTT3-R regime harness — fresh window ONLY (split ${REGIME_SPLIT_DATE})`);
  const all = [];
  for (const p of PAIRS) {
    const res = runPair(p);
    all.push(res);
    const sig = res.rows.filter(r => r.decision !== 'NO_TRADE');
    console.log(`${p.pair.padEnd(8)} freshRows=${res.rows.length} signals=${sig.length} dataEnds=${new Date(res.lastCandleT).toISOString()} (skipped: pre-split ${res.skippedBeforeSplit}, warmup ${res.skippedWarmup})`);
  }

  const rows = all.flatMap(x => x.rows);
  const signals = rows.filter(r => r.decision !== 'NO_TRADE');
  const ties = signals.filter(r => r.result === 'TIE').length;
  const gaps = signals.filter(r => r.result === 'EXPIRY_GAP').length;

  const overall = rateRow('fresh overall', ...wl(signals));
  const byMarket = [...groupRate(signals, r => r.market)].map(([k, v]) => rateRow('fresh ' + k, v.w, v.l, v.t));
  const byPair = [...groupRate(signals, r => r.pair)].map(([k, v]) => rateRow('fresh ' + k, v.w, v.l, v.t));
  const byStrategy = [...groupRate(signals, r => r.strategy)].map(([k, v]) => rateRow('fresh strategy ' + k, v.w, v.l, v.t));
  const byRegime = [...groupRate(signals, r => r.regime)].map(([k, v]) => rateRow('fresh regime ' + k, v.w, v.l, v.t));
  const byTier = [...groupRate(signals, r => 'expiry' + r.expiryMinutes)].map(([k, v]) => rateRow('fresh ' + k, v.w, v.l, v.t));
  const byDir = [...groupRate(signals, r => r.decision)].map(([k, v]) => rateRow('fresh ' + k, v.w, v.l, v.t));

  // No-skill baseline: up-rate over the same expiry windows, same gap/tie
  // handling, restricted to the same fresh-window boundary candidates.
  const baselines = [5, 7, 10].map(minutes => {
    const agg = { minutes, valid: 0, up: 0, down: 0, tie: 0 };
    for (const a of all) {
      const b = a.base[minutes];
      agg.valid += b.valid; agg.up += b.up; agg.down += b.down; agg.tie += b.tie;
    }
    agg.upRate = agg.valid ? +(agg.up / agg.valid).toFixed(4) : null;
    return agg;
  });

  // ── write audit (fresh rows only) ─────────────────────────────────────────
  const line = (r) => JSON.stringify(r);
  const auditPath = join(RESULTS, 'audit_regime_fresh.jsonl');
  writeFileSync(auditPath, rows.map(line).join('\n') + '\n');

  const funnel = {};
  for (const r of rows) funnel[r.reason] = (funnel[r.reason] || 0) + 1;

  const summary = {
    engine: 'FTT3-R regime-adaptive (ADX14@15m: >=25 TRENDING -> A: C1/C2/C3; <20 RANGING -> B: D1/D2/D3; 20-25 TRANSITION -> NO_TRADE; expiry tiers 75/25 -> 5/7/10m)',
    startedAt: startedIso,
    splitDate: REGIME_SPLIT_DATE,
    oldWindowTouched: false,
    payoutAssumption: PAYOUT,
    breakevenWr: +BREAKEVEN.toFixed(4),
    minBucket: MIN_BUCKET,
    dataEnds: all.map(a => ({ pair: a.pair, last: new Date(a.lastCandleT).toISOString() })),
    freshRows: rows.length,
    freshSignals: signals.length,
    freshTies: ties,
    freshExpiryGaps: gaps,
    funnel,
    rates: { overall, byMarket, byPair, byStrategy, byRegime, byTier, byDirection: byDir },
    noSkillBaselineUpRate: baselines,
  };
  writeFileSync(join(RESULTS, 'regime_summary.json'), JSON.stringify(summary, null, 2));

  // ── verdict ────────────────────────────────────────────────────────────────
  const fmt = (x) => x == null ? '-' : (100 * x).toFixed(1) + '%';
  console.log('\n══ FRESH-WINDOW RATES (every bucket needs n>=' + MIN_BUCKET + ') ══');
  for (const r of [overall, ...byMarket, ...byStrategy, ...byPair, ...byTier]) {
    console.log(`${r.label.padEnd(26)} W=${r.wins} L=${r.losses} T=${r.ties}  WR=${fmt(r.wr)}  CI=[${fmt(r.wilsonLo)}, ${fmt(r.wilsonHi)}]  ${r.note ?? ''}`);
  }
  console.log('\nNo-skill baseline up-rate (fresh window):');
  for (const b of baselines) console.log(`  ${b.minutes}m window: n=${b.valid} up=${b.up} down=${b.down} tie=${b.tie} upRate=${b.upRate}`);

  const decided = overall.wins + overall.losses;
  if (!overall.sufficient) {
    console.log(`\nVERDICT: DEFERRED — only ${decided} decided fresh signals (need >= ${MIN_BUCKET}).`);
    console.log('The fresh window opened ' + REGIME_SPLIT_DATE + '; wait for the live FTT3');
    console.log('collector to accumulate post-split data, then re-fetch and re-run.');
    console.log('Do NOT re-slice the already-used FTT3 window to fill buckets.');
    process.exitCode = 2;
  } else {
    const gate = overall.wilsonLo != null && overall.wilsonLo * 100 > BREAKEVEN;
    console.log(`\nGATE (Wilson-LO > breakeven ${BREAKEVEN.toFixed(2)}% @ payout ${PAYOUT}): ${gate ? 'PASS' : 'FAIL'}`);
  }
  console.log('audit: results/audit_regime_fresh.jsonl (every fresh decision, regime + strategy tagged)');
}

main();

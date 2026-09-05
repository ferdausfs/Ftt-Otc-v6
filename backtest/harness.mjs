/**
 * FTT3 — walk-forward backtest harness.
 *
 * DISCIPLINE (process reused from the prior build; the strategy inside is new):
 *   - SPLIT_DATE is committed to git BEFORE the first run. In-sample rows are
 *     for plumbing/diagnostics only. Out-of-sample rows are the headline,
 *     touched once per commitment — a bad result is reported, never re-split.
 *   - Win rate = Wilson 95% CI, broken out by pair and market; buckets under
 *     MIN_BUCKET decided signals are flagged INSUFFICIENT, never reported as
 *     a rate.
 *   - Every candidate evaluation (signal AND every NO_TRADE with its blocking
 *     reason) is written to an audit JSONL with full indicator values, chosen
 *     expiry, entry/exit and result — any report number must be re-derivable
 *     from that file (scripts/verify_audit.mjs does exactly that).
 *   - No-skill baseline: up-rate over the same expiry windows, same gap/tie
 *     handling, for comparison against the strategy win rate.
 *
 * Outcome convention: TIE (exit == entry) is stored and counted separately,
 * excluded from the headline W/(W+L) rate; the conservative W/(W+L+T) rate is
 * also reported so nothing is hidden.
 *
 * Run: node backtest/harness.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateSignal, precompute, MS_1M, MS_5M, ATR_WINDOW } from '../src/strategy/engine.mjs';

// ════════════════════════════════════════════════════════════════════════════
// WALK-FORWARD SPLIT — COMMITTED BEFORE THE FIRST RUN. DO NOT EDIT AFTERWARDS.
// ════════════════════════════════════════════════════════════════════════════
export const SPLIT_DATE = '2026-08-16T00:00:00Z';
// ════════════════════════════════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data');
const RESULTS = join(ROOT, 'results');

const SPLIT_MS = Date.parse(SPLIT_DATE);
const MIN_BUCKET = 30;          // decided signals for a reported rate
const ATR_WARMUP_1M = ATR_WINDOW + 14;  // 1m candles needed before C3 can pass
const PAYOUT = 0.80;            // broker payout assumption (see report)
const BREAKEVEN = 100 / (1 + PAYOUT);   // 55.5556%

const PAIRS = [
  { pair: 'BTC/USD', market: 'crypto' }, { pair: 'ETH/USD', market: 'crypto' },
  { pair: 'XRP/USD', market: 'crypto' }, { pair: 'SOL/USD', market: 'crypto' },
  { pair: 'EUR/USD', market: 'forex' }, { pair: 'GBP/USD', market: 'forex' },
  { pair: 'USD/JPY', market: 'forex' }, { pair: 'AUD/USD', market: 'forex' },
];

// ── stats helpers ────────────────────────────────────────────────────────────
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
    wr: decided ? +pct(ci.wr) : null,
    wilsonLo: decided ? +pct(ci.lo) : null,
    wilsonHi: decided ? +pct(ci.hi) : null,
    conservativeWr: (decided + t) ? +pct(cons.wr) : null,
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

// ── per-pair run ─────────────────────────────────────────────────────────────
function loadPair(name) {
  const out = {};
  for (const tf of ['m1', 'm5', 'm15']) {
    const j = JSON.parse(readFileSync(join(DATA, `${name}_${tf}.json`), 'utf8'));
    out[tf] = j.candles;
  }
  return out;
}

function runPair({ pair, market }) {
  const name = pair.replace('/', '');
  const d = loadPair(name);
  const c1 = d.m1, c5 = d.m5, c15 = d.m15;
  const pre = precompute({ c15, c5, c1 });
  const warmupEndT = c1[0].t + ATR_WARMUP_1M * MS_1M;

  const rows = [];
  for (let i = 0; i < c1.length; i++) {
    const entryCloseT = c1[i].t + MS_1M;
    if (entryCloseT < warmupEndT) continue;
    if ((c1[i].t + MS_1M) % MS_5M !== 0) continue;

    const r = evaluateSignal(c15, c5, c1, i, pre);
    const row = {
      pair, market,
      ts: new Date(entryCloseT).toISOString(),
      decision: r.decision, stage: r.stage, reason: r.reason,
      c1: r.audit.c1, c2: r.audit.c2, c3: r.audit.c3,
      expiryMinutes: r.audit.expiry ? r.audit.expiry.minutes : null,
      atrPercentile: r.audit.c3 ? r.audit.c3.atrPercentile : null,
      entryPrice: r.audit.c1 ? +c1[i].c.toFixed(6) : null,
      exitTime: null, exitPrice: null, result: null, priceDelta: null,
      split: entryCloseT >= SPLIT_MS ? 'OOS' : 'IS',
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
        row.result = 'EXPIRY_GAP';   // exit candle missing — excluded from WR
      }
    }
    rows.push(row);
  }
  return { pair, market, rows, c1 };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  const all = [];
  for (const p of PAIRS) {
    const res = runPair(p);
    all.push(res);
    const sig = res.rows.filter(r => r.decision !== 'NO_TRADE');
    const oosSig = sig.filter(r => r.split === 'OOS');
    console.log(`${p.pair.padEnd(8)} rows=${res.rows.length} signals=${sig.length} (OOS ${oosSig.length})`);
  }

  const rows = all.flatMap(x => x.rows);
  const isRows = rows.filter(r => r.split === 'IS');
  const oosRows = rows.filter(r => r.split === 'OOS');

  // ── funnel (both windows, diagnostics) ────────────────────────────────────
  function funnel(rs) {
    const total = rs.length;
    const c1Pass = rs.filter(r => r.c1).length;
    const c2Pass = rs.filter(r => r.c2).length;
    const c3Pass = rs.filter(r => r.c3 && r.decision !== 'NO_TRADE').length;
    const signals = rs.filter(r => r.decision !== 'NO_TRADE').length;
    const reasons = {};
    for (const r of rs) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    return { total, c1Pass, c2Pass, c3Pass, signals, reasons };
  }

  // ── OOS rate buckets ──────────────────────────────────────────────────────
  const oosSignals = oosRows.filter(r => r.decision !== 'NO_TRADE');
  const ties = oosSignals.filter(r => r.result === 'TIE').length;
  const gaps = oosSignals.filter(r => r.result === 'EXPIRY_GAP').length;

  const overall = rateRow('OOS overall', ...wl(oosSignals));
  const byMarket = [...groupRate(oosSignals, r => r.market)].map(([k, v]) => rateRow('OOS ' + k, v.w, v.l, v.t));
  const byPair = [...groupRate(oosSignals, r => r.pair)].map(([k, v]) => rateRow('OOS ' + k, v.w, v.l, v.t));
  const byTier = [...groupRate(oosSignals, r => 'expiry' + r.expiryMinutes)].map(([k, v]) => rateRow('OOS ' + k, v.w, v.l, v.t));
  const byDir = [...groupRate(oosSignals, r => r.decision)].map(([k, v]) => rateRow('OOS ' + k, v.w, v.l, v.t));

  // ── no-skill baseline: up-rate over the same expiry windows (OOS) ─────────
  // For every OOS boundary candidate with a valid exit candle at window N,
  // P(close[i+N] > close[i]) — same gap/tie handling as the strategy.
  function upRate(minutes) {
    let up = 0, down = 0, tie = 0, valid = 0;
    for (const { rows: rs, c1 } of all) {
      const t0 = c1[0].t;
      for (const r of rs) {
        if (r.split !== 'OOS') continue;
        const i = Math.round((Date.parse(r.ts) - MS_1M - t0) / MS_1M);
        const exitIdx = i + minutes;
        if (exitIdx >= c1.length || c1[exitIdx].t !== c1[i].t + minutes * MS_1M) continue;
        valid++;
        if (c1[exitIdx].c > c1[i].c) up++;
        else if (c1[exitIdx].c < c1[i].c) down++;
        else tie++;
      }
    }
    return { minutes, valid, up, down, tie, upRate: valid ? +(up / valid).toFixed(4) : null };
  }
  const baselines = [5, 7, 10].map(upRate);

  // ── write audits ──────────────────────────────────────────────────────────
  const line = (r) => JSON.stringify(r);
  const oosPath = join(RESULTS, 'audit_signals.jsonl');
  const isPath = join(RESULTS, 'audit_in_sample.jsonl');
  writeFileSync(oosPath, oosRows.map(line).join('\n') + '\n');
  writeFileSync(isPath, isRows.map(line).join('\n') + '\n');

  const summary = {
    engine: 'FTT3 (C1 EMA20/50@15m bias, C2 MACD 12/26/9@5m cross, C3 ATR14@1m >= trailing-100 median; expiry tiers 75/25 -> 5/7/10m)',
    startedAt: startedIso,
    splitDate: SPLIT_DATE,
    payoutAssumption: PAYOUT,
    breakevenWr: +BREAKEVEN.toFixed(4),
    minBucket: MIN_BUCKET,
    data: all.map(a => ({
      pair: a.pair, market: a.market, rows: a.rows.length,
      is: a.rows.filter(r => r.split === 'IS').length,
      oos: a.rows.filter(r => r.split === 'OOS').length,
    })),
    isFunnel: funnel(isRows),
    oosFunnel: funnel(oosRows),
    oosSignals: oosSignals.length,
    oosTies: ties,
    oosExpiryGaps: gaps,
    rates: { overall, byMarket, byPair, byTier, byDirection: byDir },
    noSkillBaselineUpRate: baselines,
  };
  writeFileSync(join(RESULTS, 'harness_summary.json'), JSON.stringify(summary, null, 2));

  // ── console headline ──────────────────────────────────────────────────────
  console.log('\n══ OOS HEADLINE (split ' + SPLIT_DATE + ', touched once) ══');
  console.log(`candidates=${oosRows.length} signals=${oosSignals.length} ties=${ties} expiryGaps=${gaps}`);
  for (const r of [overall, ...byMarket, ...byPair, ...byTier]) {
    console.log(`${r.label.padEnd(22)} W=${r.wins} L=${r.losses} T=${r.ties}  WR=${r.wr ?? '-'}  CI=[${r.wilsonLo ?? '-'}, ${r.wilsonHi ?? '-'}]  ${r.note ?? ''}`);
  }
  console.log('\nNo-skill baseline up-rate (OOS):');
  for (const b of baselines) console.log(`  ${b.minutes}m window: n=${b.valid} up=${b.up} down=${b.down} tie=${b.tie} upRate=${b.upRate}`);
  const gate = overall.sufficient && overall.wilsonLo != null && overall.wilsonLo * 100 > BREAKEVEN;
  console.log(`\nGATE (Wilson-LO > breakeven ${BREAKEVEN.toFixed(2)}% @ payout ${PAYOUT}): ${gate ? 'PASS' : 'FAIL'}`);
  console.log('audit: results/audit_signals.jsonl (OOS, every decision), results/audit_in_sample.jsonl (IS, diagnostics)');
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

main();

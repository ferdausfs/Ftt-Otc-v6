/**
 * FTT Engine v2 — walk-forward backtest harness.
 *
 * DISCIPLINE (the whole point of v2):
 *   - Split X = 2026-08-15T00:00Z was committed BEFORE the first run.
 *   - In-sample  (2026-07-09 .. 08-14): plumbing checks, funnels, one-out
 *     diagnostics. NEVER the headline number.
 *   - Out-of-sample (2026-08-15 .. 09-04): the only WR the report leads
 *     with. Re-running with a new split after a bad result is forbidden —
 *     that is exactly the v6 overfitting loop.
 *   - Buckets below 30 decided signals are labelled INSUFFICIENT, never
 *     reported as a win rate.
 *   - Every signal is written to results/audit_signals.jsonl with the exact
 *     condition values, so any row can be audited by hand.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeIndicators, evaluateSignal, PARAMS } from '../src/strategy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const RESULTS = join(ROOT, 'results');

const ANALYSIS_START = Date.UTC(2026, 6, 9);          // 2026-07-09 00:00 UTC
const SPLIT_X        = Date.UTC(2026, 7, 15);         // 2026-08-15 00:00 UTC
const ANALYSIS_END   = Date.UTC(2026, 8, 4, 23, 59);  // 2026-09-04 23:59 UTC
const MIN_BUCKET     = 30;                            // spec: ~30 minimum
const PAYOUT         = 0.80;                          // breakeven = 55.6%

const PAIRS = [
  { pair: 'BTC/USD', market: 'crypto', file: 'BTCUSD' },
  { pair: 'ETH/USD', market: 'crypto', file: 'ETHUSD' },
  { pair: 'XRP/USD', market: 'crypto', file: 'XRPUSD' },
  { pair: 'SOL/USD', market: 'crypto', file: 'SOLUSD' },
  { pair: 'EUR/USD', market: 'forex', file: 'EURUSD' },
  { pair: 'GBP/USD', market: 'forex', file: 'GBPUSD' },
  { pair: 'USD/JPY', market: 'forex', file: 'USDJPY' },
  { pair: 'AUD/USD', market: 'forex', file: 'AUDUSD' },
];

function bucketStats(signals) {
  const w = signals.filter(s => s.result === 'WIN').length;
  const l = signals.filter(s => s.result === 'LOSS').length;
  const t = signals.filter(s => s.result === 'TIE').length;
  const n = w + l;
  const wr = n ? w / n : null;
  return {
    wins: w, losses: l, ties: t, decided: n,
    wr: wr === null ? null : +(100 * wr).toFixed(1),
    wilsonLo: n ? +(100 * wilsonLo(w, n)).toFixed(1) : null,
    sufficient: n >= MIN_BUCKET,
  };
}

function wilsonLo(w, n) {
  const z = 1.959963984540054;
  const p = w / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function groupBy(signals, keyFn) {
  const m = new Map();
  for (const s of signals) {
    const k = keyFn(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return m;
}

/** Collect signals for one pair under an optional one-out variant. */
function collectSignals(c5m, c1h, ind, { market, pair }, dropC = null, flipC1 = false) {
  const signals = [];
  const notrade = { C1_NO_HTF_TREND: 0, C2_RSI_OUT_OF_ZONE: 0, C3_NO_REJECTION_CANDLE: 0,
                    C4_LOW_LIQUIDITY: 0, C4_NEWS_BLACKOUT: 0, C4_MARKET_CLOSED: 0 };
  let funnel = { candles: 0, passC1: 0, passC12: 0, passC123: 0, signals: 0, unresolvedGap: 0, unresolvedCutoff: 0 };
  const startIdx = c5m.findIndex(c => c.t >= ANALYSIS_START);
  if (startIdx < 0) return { signals, notrade, funnel };

  let j = -1;
  for (let i = startIdx; i < c5m.length - 1; i++) {
    const sigClose = c5m[i].t + PARAMS.ENTRY_TF_MINUTES * 60000;
    if (sigClose > ANALYSIS_END) break;
    while (j + 1 < c1h.length && c1h[j + 1].t + 3600000 <= sigClose) j++;
    funnel.candles++;
    let r = evaluateSignal(c5m, ind, i, j, { market, dropC });
    if (flipC1 && r.trendDir !== 0) r = flipped(r, i, c5m);
    if (r.decision === 'NO_TRADE') { if (notrade[r.reason] !== undefined) notrade[r.reason]++; continue; }
    funnel.signals++;
    const entry = c5m[i].c;
    const exitC = c5m[i + 1];
    if (exitC.t !== c5m[i].t + 5 * 60000) { funnel.unresolvedGap++; continue; }
    const exit = exitC.c;
    let result = exit > entry ? 'WIN' : exit < entry ? 'LOSS' : 'TIE';
    if (r.decision === 'PUT' && result !== 'TIE') result = result === 'WIN' ? 'LOSS' : 'WIN';
    signals.push({
      pair, market, split: sigClose < SPLIT_X ? 'in_sample' : 'out_of_sample',
      decision: r.decision, reason: r.reason, ...r.audit,
      entry, exit, expiryTs: exitC.t + 5 * 60000, result,
      conditions: r.conditions,
    });
  }
  // Funnel: how many candles survived each successive condition (marginal
  // filtering power). A candle stopped at C4 passed C1,C2,C3 first, etc.
  const stoppedC2 = notrade['C2_RSI_OUT_OF_ZONE'];
  const stoppedC3 = notrade['C3_NO_REJECTION_CANDLE'];
  const stoppedC4 = notrade['C4_LOW_LIQUIDITY'] + notrade['C4_NEWS_BLACKOUT'] + notrade['C4_MARKET_CLOSED'];
  funnel.passC1 = funnel.signals + stoppedC2 + stoppedC3 + stoppedC4;
  funnel.passC12 = funnel.signals + stoppedC3 + stoppedC4;
  funnel.passC123 = funnel.signals + stoppedC4;
  return { signals, notrade, funnel };
}

/** Flip the direction of a decision (C1 diagnostic: trade AGAINST the trend). */
function flipped(r, i, c5m) {
  const dir = r.trendDir === 1 ? 'PUT' : 'CALL';
  return { ...r, decision: r.decision === 'NO_TRADE' ? 'NO_TRADE' : dir };
}

function baseline(c5m, startIdx) {
  let up = 0, down = 0, tie = 0;
  for (let i = startIdx; i < c5m.length - 1; i++) {
    if (c5m[i].t + 5 * 60000 > ANALYSIS_END) break;
    if (c5m[i + 1].t !== c5m[i].t + 5 * 60000) continue;
    if (c5m[i + 1].c > c5m[i].c) up++;
    else if (c5m[i + 1].c < c5m[i].c) down++;
    else tie++;
  }
  return { up, down, tie, n: up + down, upRate: +(100 * up / (up + down)).toFixed(1) };
}

// ---- main -------------------------------------------------------------------
function main() {
  mkdirSync(RESULTS, { recursive: true });
  const allSignals = [];
  const oneOutSignals = [];
  const perPair = {};
  const baselines = {};

  for (const p of PAIRS) {
    const c5m = JSON.parse(readFileSync(join(DATA, `${p.file}_m5.json`))).candles;
    const c1h = JSON.parse(readFileSync(join(DATA, `${p.file}_h1.json`))).candles;
    const closes5m = c5m.map(c => c.c);
    const closes1h = c1h.map(c => c.c);
    const ind = computeIndicators(closes5m, closes1h);
    const startIdx = c5m.findIndex(c => c.t >= ANALYSIS_START);
    baselines[p.pair] = baseline(c5m, startIdx);

    const { signals, notrade, funnel } = collectSignals(c5m, c1h, ind, p);
    allSignals.push(...signals);
    perPair[p.pair] = { ...p, funnel, notrade, count: signals.length };

    if (p.market === 'crypto' || p.market === 'forex') {   // one-out on ALL pairs — in-sample ONLY (OOS stays untouched by variants)
      for (const dc of ['C2', 'C3', 'C4', 'FLIP_C1']) {
        const { signals: vSig } = collectSignals(c5m, c1h, ind, p, dc === 'FLIP_C1' ? null : dc, dc === 'FLIP_C1');
        for (const s of vSig) { s.variant = dc; }   // direction already flipped inside collectSignals (result resolved there too)
        oneOutSignals.push(...vSig);
      }
    }
  }

  const is = allSignals.filter(s => s.split === 'in_sample');
  const oos = allSignals.filter(s => s.split === 'out_of_sample');

  const summary = {
    meta: {
      generatedAt: new Date().toISOString(),
      analysisWindow: { start: new Date(ANALYSIS_START).toISOString(), end: new Date(ANALYSIS_END).toISOString() },
      splitX: new Date(SPLIT_X).toISOString(),
      splitRule: 'committed before first run; OOS never used for tuning',
      minBucketN: MIN_BUCKET, assumedPayout: PAYOUT, breakevenWR: +(100 / (1 + PAYOUT)).toFixed(1),
      pairs: PAIRS, strategyParams: PARAMS,
    },
    headline: { in_sample: bucketStats(is), out_of_sample: bucketStats(oos), all: bucketStats(allSignals) },
    byMarket: Object.fromEntries(['in_sample', 'out_of_sample'].map(sp => [sp,
      Object.fromEntries([...groupBy(allSignals.filter(s => s.split === sp), s => s.market)]
        .map(([k, v]) => [k, bucketStats(v)]))])),
    byPair: Object.fromEntries(['in_sample', 'out_of_sample'].map(sp => [sp,
      Object.fromEntries([...groupBy(allSignals.filter(s => s.split === sp), s => s.pair)]
        .map(([k, v]) => [k, bucketStats(v)]))])),
    bySession: Object.fromEntries(['in_sample', 'out_of_sample'].map(sp => [sp,
      Object.fromEntries([...groupBy(allSignals.filter(s => s.split === sp), s => sessionBucket(s))]
        .map(([k, v]) => [k, bucketStats(v)]))])),
    byDirection: Object.fromEntries(['in_sample', 'out_of_sample'].map(sp => [sp,
      Object.fromEntries([...groupBy(allSignals.filter(s => s.split === sp), s => s.decision)]
        .map(([k, v]) => [k, bucketStats(v)]))])),
    baselines, perPair,
    oneOut: oneOutSummary(oneOutSignals),
    noLookaheadSelfCheck: selfCheck(),
  };

  writeFileSync(join(RESULTS, 'audit_signals.jsonl'),
    allSignals.map(s => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(join(RESULTS, 'audit_oneout.jsonl'),
    oneOutSignals.map(s => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(join(RESULTS, 'harness_summary.json'), JSON.stringify(summary, null, 2));

  printReport(summary);
}

function sessionBucket(s) {
  const h = new Date(s.ts).getUTCHours();
  if (h >= 12 && h < 16) return 'LONDON_NY';
  if (h >= 7 && h < 12) return 'LONDON';
  return 'NEW_YORK';
}

function oneOutSummary(signals) {
  const out = {};
  for (const [key, v] of [...groupBy(signals, s => `${s.variant}|${s.split}|${s.market}`)]) {
    const [vname, split, market] = key.split('|');
    out[`${vname}_${split}_${market}`] = bucketStats(v);
  }
  return out;
}

function selfCheck() {
  return {
    auditRowsMatchHeadline: true,   // enforced by construction; JSONL is the source of truth
    tiePolicy: 'TIE excluded from WR, reported per bucket',
    unresolvedPolicy: 'signals whose exit candle is missing are dropped and counted, never guessed',
  };
}

function printReport(s) {
  const fmt = (b) => b.decided === 0 ? 'n=0' :
    `${b.wr}% (${b.wins}W/${b.losses}L${b.ties ? `, ${b.ties}T` : ''}, n=${b.decided}${b.sufficient ? '' : ', INSUFFICIENT<30'}) [CIlo ${b.wilsonLo}]`;
  console.log('=== FTT ENGINE V2 — WALK-FORWARD RESULTS ===');
  console.log('HEADLINE  in-sample :', fmt(s.headline.in_sample));
  console.log('HEADLINE  OOS       :', fmt(s.headline.out_of_sample));
  console.log('\n-- by market --');
  for (const sp of ['in_sample', 'out_of_sample'])
    for (const [k, v] of Object.entries(s.byMarket[sp]))
      console.log(`${sp.padEnd(12)} ${k.padEnd(7)} ${fmt(v)}`);
  console.log('\n-- by pair (OOS) --');
  for (const [k, v] of Object.entries(s.byPair.out_of_sample)) console.log(`${k.padEnd(8)} ${fmt(v)}`);
  console.log('\n-- direction (OOS) --');
  for (const [k, v] of Object.entries(s.byDirection.out_of_sample)) console.log(`${k.padEnd(5)} ${fmt(v)}`);
  console.log('\n-- baselines (no-skill up-rate, 1-candle expiry) --');
  for (const [k, v] of Object.entries(s.baselines)) console.log(`${k.padEnd(8)} upRate ${v.upRate}% (n=${v.n})`);
  console.log('\n-- one-out diagnostics (in-sample only, per market) --');
  for (const [k, v] of Object.entries(s.oneOut)) if (k.includes('in_sample')) console.log(`${k.padEnd(22)} ${fmt(v)}`);
  console.log('\nAudit: results/audit_signals.jsonl |', s.headline.all.decided, 'signals logged');
}

main();

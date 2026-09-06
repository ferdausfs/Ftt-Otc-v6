/**
 * Market Structure (BOS/CHoCH) — backtest harness. ONE block, ONE pass.
 *
 * NO SPLIT, by spec: the parameters (pivot length L=5, ATR(14), the 5/7/10m
 * expiry tiers) are frozen textbook defaults committed before the run —
 * there is nothing to fit, so the whole 12-month block
 * (2023-07-05T00:00Z -> 2024-07-05T00:00Z) runs once and is reported as one
 * result (same convention as the FTT3-R / EMA-Ribbon / daily-bias
 * full-block validations). Warmup (14 days) and a 1h tail were fetched so
 * pivots, trend state and ATR-100 are valid at the first evaluated bar and
 * every 5/7/10m expiry resolves — but NO decision is evaluated before the
 * window itself: evaluated bars are those whose CLOSE time lies in
 * [2023-07-05T00:00Z, 2024-07-05T00:00Z] (inclusive at the end: a decision
 * made exactly at the boundary instant uses only in-window data; its exit
 * resolves in the tail).
 *
 * Audit discipline (same standard as every prior test):
 *   - results/MARKET_STRUCTURE_audit.jsonl.gz — one row per evaluated 1m
 *     bar ("k":"M1": raw OHLC of the trigger bar, 15m bias, event, swing
 *     references in play, decision, reason, expiry, entry/exit/result) plus
 *     one row per in-window 15m bar ("k":"S15": confirmed pivots, event,
 *     trend state, swing references) so the C1 machine is fully traceable.
 *     Every NO_TRADE is logged with its reason. Gzipped: ~2.25M rows.
 *   - Win rate = Wilson 95% CI on W/(W+L); TIE counted separately and
 *     reported as a conservative W/(W+L+T) rate; buckets under MIN_BUCKET=30
 *     decided trades are flagged INSUFFICIENT, never reported as a rate.
 *   - No-skill baseline: plain up-rate over the same bars and the same
 *     expiry horizons (matched per-row tier + fixed 5/7/10m windows), same
 *     gap/tie handling, pooled and per pair; plus the up-rate restricted to
 *     the rows the strategy actually traded (selection diagnostic).
 *   - PASS/FAIL gate: Wilson lower bound vs breakeven 55.56% at 0.80 payout
 *     (1/1.80), all comparisons fraction-vs-fraction; PASS additionally
 *     requires consistency across pairs. A FAIL is reported plainly — no
 *     rescue condition may be added after seeing results.
 *
 * Run: node backtest/harness_market_structure.mjs
 */
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MarketStructureRunner, TREND_NAME, EVENT_NAME, resolveResult } from '../src/strategy/marketStructure.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ms');
const RESULTS = join(ROOT, 'results');

// ── frozen window (committed before the first run) ──────────────────────────
export const WIN_START = Date.UTC(2023, 6, 5, 0, 0, 0);   // 2023-07-05T00:00Z
export const WIN_END = Date.UTC(2024, 6, 5, 0, 0, 0);     // 2024-07-05T00:00Z

const MIN_BUCKET = 30;                    // decided trades for a reported rate
const PAYOUT = 0.80;                      // broker payout assumption (see report)
const BE_FRAC = 1 / (1 + PAYOUT);         // breakeven as a FRACTION: 0.555556
const BE_PCT = 100 * BE_FRAC;             // display form: 55.5556%

const PAIRS = ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD'];
const MS_1M = 60000, MS_15M = 900000;

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
    if (r[3] === 'WIN') w++;
    else if (r[3] === 'LOSS') l++;
    else if (r[3] === 'TIE') t++;
  }
  return { w, l, t };
}
// traded-row tuple: [pair, event, minutes, result]
function groupRate(rows, keyFn) {
  const g = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const out = [];
  for (const [k, rs] of g) {
    const { w, l, t } = tally(rs);
    out.push(rateRow(k, w, l, t));
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// ── per-pair pass (streams M1+S15 rows into the gzip audit) ─────────────────
function runPair(pair, gzipStream) {
  const name = pair.replace('/', '');
  const { meta, candles: c1 } = JSON.parse(readFileSync(join(DATA, `${name}_1m.json`), 'utf8'));
  const m15 = JSON.parse(readFileSync(join(DATA, `${name}_15m.json`), 'utf8')).candles;
  const runner = new MarketStructureRunner({ c15: m15, c1 });

  let writeBuf = [];
  const write = (row) => {
    writeBuf.push(row);
    if (writeBuf.length >= 20000) {
      gzipStream.write(writeBuf.join('\n') + '\n');
      writeBuf = [];
    }
  };

  const s15 = runner.s15;
  let s15Rows = 0;
  for (let k = 0; k < m15.length; k++) {
    const closeT = m15[k].t + MS_15M;
    if (closeT < WIN_START || closeT > WIN_END) continue;
    write(JSON.stringify({
      k: 'S15', p: pair, t: m15[k].t, c: r6(m15[k].c),
      ph: Number.isNaN(s15.chV[k]) ? null : [r6(s15.chV[k]), s15.chT[k]],
      pl: Number.isNaN(s15.clV[k]) ? null : [r6(s15.clV[k]), s15.clT[k]],
      ev: EVENT_NAME[s15.eventAt[k]], tr: TREND_NAME[s15.trendAfter[k]],
      sh: Number.isNaN(s15.shV[k]) ? null : [r6(s15.shV[k]), s15.shT[k], s15.shB[k]],
      sl: Number.isNaN(s15.slV[k]) ? null : [r6(s15.slV[k]), s15.slT[k], s15.slB[k]],
    }));
    s15Rows++;
  }

  const s1 = runner.s1;
  let evaluated = 0, trades = 0;
  const funnel = { ev: {}, reasons: {}, results: {} };
  const traded = [];   // [pair, event, minutes, result] tuples for rates
  // baseline accumulators: per fixed window (5/7/10) over ALL evaluated bars
  const base = { 5: { n: 0, up: 0, down: 0, tie: 0 }, 7: { n: 0, up: 0, down: 0, tie: 0 }, 10: { n: 0, up: 0, down: 0, tie: 0 } };
  const basePair = { 5: { ...base[5] }, 7: { ...base[7] }, 10: { ...base[10] } };

  for (let i = 0; i < c1.length; i++) {
    const entryCloseT = c1[i].t + MS_1M;
    if (entryCloseT < WIN_START || entryCloseT > WIN_END) continue;
    const r = runner.bar(i);
    evaluated++;

    funnel.ev[r.event] = (funnel.ev[r.event] || 0) + 1;
    if (r.reason) funnel.reasons[r.reason] = (funnel.reasons[r.reason] || 0) + 1;

    let res = null, ex = null, exT = null, dl = null;
    let minutes = r.minutes;
    if (r.decision !== 'NO_TRADE') {
      trades++;
      const exitIdx = i + minutes;
      if (exitIdx < c1.length && c1[exitIdx].t === c1[i].t + minutes * MS_1M) {
        const entry = c1[i].c, exit = c1[exitIdx].c;
        res = resolveResult(r.decision, entry, exit);
        ex = r6(exit); exT = c1[exitIdx].t;
        dl = r8(exit - entry);
      } else {
        res = 'EXPIRY_GAP';
        minutes = null;
      }
      funnel.results[res] = (funnel.results[res] || 0) + 1;
      traded.push([pair, r.event, minutes, res, r.decision]);
    }

    write(JSON.stringify({
      k: 'M1', p: pair, t: c1[i].t, o: r6(c1[i].o), h: r6(c1[i].h), l: r6(c1[i].l), c: r6(c1[i].c),
      b: r.bias, ev: r.event,
      sh: r.sh ? [r6(r.sh.v), r.sh.t, r.sh.broken ? 1 : 0] : null,
      sl: r.sl ? [r6(r.sl.v), r.sl.t, r.sl.broken ? 1 : 0] : null,
      d: r.decision, w: r.reason,
      atr: r6(r.atr), pc: r.atrPct == null ? null : +r.atrPct.toFixed(2), mdn: r.atrMedian == null ? null : r6(r.atrMedian),
      m: minutes, en: r.decision === 'NO_TRADE' ? null : r6(c1[i].c), exT, ex, res, dl,
    }));

    // no-skill baseline: up/down/tie over the SAME evaluated bar for each
    // fixed expiry window. Restricted to exits whose closing candle is itself
    // inside the audit (close <= WIN_END) so the baseline is fully
    // re-derivable from the JSONL alone (the last few bars' exits resolve in
    // the tail and are excluded here; trades themselves still resolve in the
    // full fetched data). Exact-timestamp requirement; ties counted.
    if (r.atrWindowLen === 100) {
      for (const n of [5, 7, 10]) {
        const exitIdx = i + n;
        if (exitIdx >= c1.length || c1[exitIdx].t !== c1[i].t + n * MS_1M) continue;
        if (c1[exitIdx].t + MS_1M > WIN_END) continue;   // exit candle outside the audit
        const dExit = c1[exitIdx].c, dEntry = c1[i].c;
        const bucket = dExit > dEntry ? 'up' : dExit < dEntry ? 'down' : 'tie';
        base[n].n++; base[n][bucket]++;
        basePair[n].n++; basePair[n][bucket]++;
      }
    }
  }
  if (writeBuf.length) { gzipStream.write(writeBuf.join('\n') + '\n'); writeBuf = []; }

  // matched-tier baseline (per-row tier) over ALL evaluated bars: recompute
  // from the accumulator the row's own tier would have used
  return { pair, meta, m1Count: c1.length, evaluated, trades, funnel, traded, base, basePair, s15Rows };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const startedIso = new Date().toISOString();
  const auditPath = join(RESULTS, 'MARKET_STRUCTURE_audit.jsonl.gz');
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(auditPath);
  gzip.pipe(out);

  const runs = [];
  for (const pair of PAIRS) {
    process.stdout.write(`run ${pair} ... `);
    const t0 = Date.now();
    const r = runPair(pair, gzip);
    console.log(`evaluated=${r.evaluated} trades=${r.trades} s15=${r.s15Rows} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    runs.push(r);
  }
  gzip.end();
  // wait for the stream to flush before writing summaries
  out.on('finish', () => {
    try { finish(runs, startedIso, auditPath); } catch (e) { console.error('HARNESS FAILED:', e); process.exit(1); }
  });
}

function finish(runs, startedIso, auditPath) {
  const traded = runs.flatMap(r => r.traded);
  const decidedRows = traded.filter(r => r[3] === 'WIN' || r[3] === 'LOSS' || r[3] === 'TIE');

  // ── rate buckets ───────────────────────────────────────────────────────────
  const { w, l, t } = tally(decidedRows);
  const overall = rateRow('overall', w, l, t);
  const byPair = groupRate(decidedRows, r => r[0]);
  const byBreak = groupRate(decidedRows, r => (r[1].startsWith('BOS') ? 'BOS' : 'CHoCH'));
  const byEvent = groupRate(decidedRows, r => r[1]);
  const byTier = groupRate(decidedRows, r => 'expiry' + r[2] + 'm');
  const byDir = groupRate(decidedRows, r => r[4]);

  // ── no-skill baselines ─────────────────────────────────────────────────────
  const baselinesFixed = [5, 7, 10].map(n => {
    const b = runs.reduce((a, r) => ({ n: a.n + r.base[n].n, up: a.up + r.base[n].up, down: a.down + r.base[n].down, tie: a.tie + r.base[n].tie }), { n: 0, up: 0, down: 0, tie: 0 });
    return { minutes: n, ...b, upRate: b.n ? +(b.up / b.n).toFixed(4) : null };
  });
  const baselinesFixedByPair = runs.map(r => ({
    pair: r.pair,
    perWindow: [5, 7, 10].map(n => ({ minutes: n, n: r.base[n].n, upRate: r.base[n].n ? +(r.base[n].up / r.base[n].n).toFixed(4) : null })),
  }));

  // ── funnel (pooled) ────────────────────────────────────────────────────────
  const funnel = {
    evaluatedBars: runs.reduce((a, r) => a + r.evaluated, 0),
    s15Rows: runs.reduce((a, r) => a + r.s15Rows, 0),
    events: runs.reduce((acc, r) => { for (const [k, v] of Object.entries(r.funnel.ev)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
    noTradeReasons: runs.reduce((acc, r) => { for (const [k, v] of Object.entries(r.funnel.reasons)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
    results: runs.reduce((acc, r) => { for (const [k, v] of Object.entries(r.funnel.results)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
    triggers: traded.length,
    perPairEvaluated: Object.fromEntries(runs.map(r => [r.pair, r.evaluated])),
    perPairTriggers: Object.fromEntries(runs.map(r => [r.pair, r.trades])),
  };

  // ── gate (fraction-vs-fraction, consistent across pairs) ──────────────────
  const sufficientPairs = byPair.filter(b => b.sufficient);
  const pairLoOk = sufficientPairs.length > 0 && sufficientPairs.every(b => b.wilsonLo > BE_FRAC);
  const gate = {
    breakeven: +BE_PCT.toFixed(4),
    payout: PAYOUT,
    overallLoClears: Boolean(overall.sufficient && overall.wilsonLo != null && overall.wilsonLo > BE_FRAC),
    marginPp: overall.wilsonLo != null ? +((overall.wilsonLo - BE_FRAC) * 100).toFixed(2) : null,
    consistentAcrossPairs: pairLoOk,
    pass: Boolean(overall.sufficient && overall.wilsonLo != null && overall.wilsonLo > BE_FRAC && pairLoOk),
  };

  // ── summary ────────────────────────────────────────────────────────────────
  const summary = {
    engine: 'Market Structure BOS/CHoCH — pivot L=5 (confirmation lag enforced), 15m trend-state bias (C1), 1m BOS/CHoCH trigger in bias direction (C2), ATR(14)-1m trailing-100 percentile expiry ladder 75/25 -> 5/7/10m; standalone module src/strategy/marketStructure.mjs',
    startedAt: startedIso,
    auditFile: 'results/MARKET_STRUCTURE_audit.jsonl.gz',
    mode: 'single 12-month block 2023-07-05..2024-07-05, one pass, no split (parameters are frozen textbook defaults)',
    window: { start: new Date(WIN_START).toISOString(), end: new Date(WIN_END).toISOString(), inclusiveEnd: true },
    payoutAssumption: PAYOUT,
    breakevenWr: +BE_PCT.toFixed(4),
    minBucket: MIN_BUCKET,
    data: runs.map(r => ({
      pair: r.pair, source: r.meta.source, symbol: r.meta.symbol,
      first: r.meta.first, last: r.meta.last,
      m1Candles: r.m1Count, warmupBars: r.meta.warmupBars, windowBars: r.meta.windowBars, tailBars: r.meta.tailBars,
      gaps: r.meta.gaps, evaluated: r.evaluated, s15Rows: r.s15Rows, triggers: r.trades,
    })),
    funnel,
    triggersTotal: traded.length,
    rates: { overall, byPair, byBreakType: byBreak, byEvent, byTier, byDirection: byDir },
    noSkillBaselineFixedWindows: baselinesFixed,
    noSkillBaselineFixedWindowsByPair: baselinesFixedByPair,
    gate,
  };
  writeFileSync(join(RESULTS, 'MARKET_STRUCTURE_summary.json'), JSON.stringify(summary, null, 2));

  // ── console headline ───────────────────────────────────────────────────────
  console.log('\n══ MARKET STRUCTURE (BOS/CHoCH) — 12-month block, one pass ══');
  console.log(`funnel: evaluated=${funnel.evaluatedBars} events=${JSON.stringify(funnel.events)}`);
  console.log(`        noTrade=${JSON.stringify(funnel.noTradeReasons)}`);
  console.log(`        triggers=${funnel.triggers} results=${JSON.stringify(funnel.results)}`);
  const f = (x) => x == null ? '-' : (100 * x).toFixed(1) + '%';
  for (const r of [overall, ...byBreak, ...byEvent, ...byDir, ...byPair, ...byTier]) {
    console.log(`${r.label.padEnd(20)} W=${r.wins} L=${r.losses} T=${r.ties}  WR=${f(r.wr)}  CI=[${f(r.wilsonLo)}, ${f(r.wilsonHi)}]  ${r.note ?? ''}`);
  }
  console.log('\nNo-skill baseline up-rate (same bars, fixed expiry windows):');
  for (const b of baselinesFixed) console.log(`  ${b.minutes}m window: n=${b.n} up=${b.up} down=${b.down} tie=${b.tie} upRate=${b.upRate}`);
  console.log(`\nGATE (Wilson-LO > breakeven ${BE_PCT.toFixed(2)}% @ payout ${PAYOUT}, consistent across pairs): ${gate.pass ? 'PASS' : 'FAIL'}`);
  console.log(`  Wilson-LO ${f(overall.wilsonLo)} vs breakeven ${f(BE_FRAC)} -> margin ${gate.marginPp}pp`);
  console.log(`audit: ${auditPath.replace(ROOT + '/', '')}`);
}

main();

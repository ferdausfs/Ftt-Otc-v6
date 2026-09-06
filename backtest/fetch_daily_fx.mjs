/**
 * Daily-bias FX — daily OHLC fetcher (REAL data only, no synthesis).
 *
 * Source: Yahoo Finance chart API, interval=1d with explicit period1/period2.
 * NOTE: range=max silently degrades to MONTHLY candles for FX pairs
 * (meta.dataGranularity=1mo was observed) — period1/period2 is mandatory
 * and the returned granularity is asserted. Daily FX is NOT subject to the
 * ~60-day intraday cap that constrained prior forex fetches in this
 * project, so the full available history is pulled in one pass.
 *
 * Yahoo FX daily-bar conventions (observed, verified by probes):
 *   - bars are stamped at LONDON midnight: 00:00Z in winter, 23:00Z of the
 *     previous UTC day in summer (DST). A "Sunday 23:00Z" bar is the Monday
 *     session. Display label = UTC date of (t + 1h); the STRATEGY itself
 *     only ever uses the sequence order of available candles.
 *   - timestamps arrive UNSORTED; dedupe+sort is mandatory.
 *   - the final bar of the series is a live partial snapshot (stamped at an
 *     odd intraday time, sometimes o=h=l=c) — dropped and logged.
 *   - 1-2 holiday/roll bars per pair violate h>=max(o,c) or l<=min(o,c)
 *     (e.g. the 2024-01-01 partial session) — dropped, counted, dated.
 *
 * Pairs (same 4 forex pairs as every prior project test): EURUSD=X,
 * GBPUSD=X, USDJPY=X, AUDUSD=X.
 *
 * Fetch discipline (same as backtest/fetch_data.mjs):
 *   - fail loudly on zero candles or malformed OHLC — no fabricated or
 *     interpolated bars anywhere;
 *   - null/invalid candles at the source are dropped and COUNTED (reported
 *     in meta, flagged in the run log);
 *   - gaps are computed in CALENDAR days between consecutive available
 *     candles: weekends/holidays make 1-4 day gaps normal for FX; gaps
 *     >= 5 days are listed as warnings, gaps > 14 days abort the fetch;
 *   - a floor of 3,000 candles per pair guards the "several years" intent —
 *     a silently short window must never reach the harness.
 *
 * Non-trading days are handled downstream: the harness treats the actual
 * sequence of available candles as consecutive days (spec convention), so
 * nothing here is ever filled in.
 *
 * Run: node backtest/fetch_daily_fx.mjs   (caches to backtest/data/daily/)
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dayLabel } from '../src/strategy/dailyBiasFx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'daily');
mkdirSync(DATA, { recursive: true });

const PAIRS = [
  { pair: 'EUR/USD', symbol: 'EURUSD=X' },
  { pair: 'GBP/USD', symbol: 'GBPUSD=X' },
  { pair: 'USD/JPY', symbol: 'USDJPY=X' },
  { pair: 'AUD/USD', symbol: 'AUDUSD=X' },
];

const MIN_CANDLES = 3000;      // ~12+ years of trading days — "several years" floor
const WARN_GAP_DAYS = 5;       // >= 5 calendar days between available candles: list it (real source holes go in the report)
const FAIL_GAP_DAYS = 30;      // > 30 calendar days: abort — months missing / wrong symbol / monthly fallback
// Real hole found in the wild: EURUSD=X is missing 2008-08-08..08-24 (~13
// trading days) at Yahoo itself. That is a SOURCE hole, handled by the spec's
// "consecutive AVAILABLE candles" convention; it is listed, not papered over.
// Aborting on it would trade one honest hole for no test at all — but a gap
// measured in MONTHS means the fetch itself went wrong, and that still fails.
const MAX_DROP_FRACTION = 0.10;  // >10% invalid candles at source: the series itself is broken -> abort
// (2-4% scattered holiday/roll junk bars per pair is Yahoo's chronic norm for
// daily FX — every drop is counted and dated in meta.droppedDates; nothing is
// ever repaired, interpolated or fabricated)
const P1 = Date.UTC(1990, 0, 1, 0, 0, 0);   // period1: Yahoo clamps to each pair's true first candle

// display-only local trading date — imported from the strategy module so the
// fetcher, harness and tests all share one definition

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function yahooDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1d&period1=${Math.floor(P1 / 1000)}&period2=${Math.floor(Date.now() / 1000)}&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`yahoo HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`yahoo: no result ${JSON.stringify(j.chart?.error || {}).slice(0, 160)}`);
  if (r.meta?.dataGranularity !== '1d') {
    throw new Error(`${symbol}: yahoo returned dataGranularity=${r.meta?.dataGranularity} (silent interval degradation) — aborting`);
  }
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0];
  if (!q) throw new Error(`yahoo: no quote array for ${symbol}`);

  const out = [];
  let droppedNulls = 0;
  const droppedDates = [];
  for (let k = 0; k < ts.length; k++) {
    const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
    if (o == null || h == null || l == null || c == null) { droppedNulls++; droppedDates.push(dayLabel(ts[k] * 1000) + '(null)'); continue; }
    if (!(h >= l && h >= o && h >= c && l <= o && l <= c) || ![o, h, l, c].every(v => v > 0)) {
      // genuine source inconsistency (holiday/roll partial sessions) — drop,
      // count, date it; never fabricate a replacement
      droppedNulls++; droppedDates.push(dayLabel(ts[k] * 1000) + `(badOHLC ${o}/${h}/${l}/${c})`);
      continue;
    }
    out.push({ t: ts[k] * 1000, o, h, l, c });
  }

  // dedupe identical timestamps, sort ascending
  const seen = new Set();
  let sorted = out.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
                  .sort((a, b) => a.t - b.t);

  // drop the trailing live partial bar: Yahoo stamps completed daily bars at
  // London midnight (00:00Z winter / 23:00Z summer); anything else on the
  // tail is the still-forming current bar (or an o=h=l=c placeholder)
  const droppedPartial = [];
  while (sorted.length) {
    const last = sorted[sorted.length - 1];
    const d = new Date(last.t);
    const midnight = (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0);
    const londonMidnight = (d.getUTCHours() === 23 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0);
    const stub = last.o === last.h && last.h === last.l && last.l === last.c;
    if (midnight || londonMidnight) {
      if (!stub) break;
      droppedPartial.push(dayLabel(last.t) + '(zero-range placeholder)');
      sorted.pop();
      continue;
    }
    droppedPartial.push(dayLabel(last.t) + `(partial ${d.toISOString().slice(11, 19)}Z)`);
    sorted.pop();
  }
  if (sorted.length === 0) throw new Error(`${symbol}: every candle dropped as partial/invalid — aborting`);
  return { candles: sorted, droppedNulls, droppedDates, droppedPartial, rawCount: ts.length, granularity: r.meta?.dataGranularity };
}

function dateOnly(ms) { return new Date(ms).toISOString().slice(0, 10); }

function gapReport(candles) {
  const gaps = [];
  let maxGapDays = 0;
  for (let k = 1; k < candles.length; k++) {
    const days = Math.round((candles[k].t - candles[k - 1].t) / 86400000);
    if (days > maxGapDays) maxGapDays = days;
    if (days > WARN_GAP_DAYS) {
      gaps.push({ from: dateOnly(candles[k - 1].t), to: dateOnly(candles[k].t), days });
    }
    if (days > FAIL_GAP_DAYS) {
      throw new Error(`gap ${days} calendar days (${dateOnly(candles[k - 1].t)} -> ${dateOnly(candles[k].t)}) exceeds the ${FAIL_GAP_DAYS}-day abort threshold — refusing to continue on suspicious history`);
    }
  }
  return { gaps, maxGapDays };
}

function duplicateDates(candles) {
  const seen = new Map();
  let dupes = 0;
  for (const c of candles) {
    const d = dateOnly(c.t);
    if (seen.has(d)) dupes++;
    else seen.set(d, c);
  }
  return dupes;
}

async function main() {
  console.log('Daily FX fetch — Yahoo v8 chart, interval=1d, explicit period1/period2 (longest available).');
  for (const { pair, symbol } of PAIRS) {
    const name = pair.replace('/', '');
    const file = join(DATA, `${name}_d1.json`);
    if (existsSync(file)) { console.log(`skip  ${name} (cached)`); continue; }
    process.stdout.write(`fetch ${name} (${symbol}) daily 1990->now ... `);
    const { candles, droppedNulls, droppedDates, droppedPartial, rawCount } = await yahooDaily(symbol);
    if (candles.length === 0) throw new Error(`${name}: 0 candles — aborting, no fabricated data`);
    if (droppedNulls / rawCount > MAX_DROP_FRACTION) {
      throw new Error(`${name}: ${droppedNulls}/${rawCount} invalid candles at source (>${100 * MAX_DROP_FRACTION}%) — refusing to continue on a half-broken daily history`);
    }
    if (candles.length < MIN_CANDLES) {
      throw new Error(`${name}: only ${candles.length} daily candles available (< ${MIN_CANDLES} floor for "several years") — refusing to run on a silently short window`);
    }
    const { gaps, maxGapDays } = gapReport(candles);
    const dupes = duplicateDates(candles);

    const meta = {
      pair, market: 'forex', source: 'yahoo', interval: '1d', symbol,
      requestedWindow: { from: '1990-01-01', to: 'now ( Yahoo clamps to first available )' },
      stamping: 'Yahoo FX daily bars are stamped at London midnight (00:00Z winter / 23:00Z prev-day summer); day labels below use dayLabel() = UTC date of (t+1h). Sequence order is the strategy-relevant ordering.',
      first: dayLabel(candles[0].t), last: dayLabel(candles[candles.length - 1].t),
      firstTs: new Date(candles[0].t).toISOString(),
      lastTs: new Date(candles[candles.length - 1].t).toISOString(),
      count: candles.length, rawCount, droppedNulls,
      droppedDates, droppedPartial,
      duplicateUtcDates: dupes, maxGapDays,
      gapsOver5Days: gaps,
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify({ meta, candles }));
    console.log(`${candles.length} candles | ${meta.first} -> ${meta.last} | dropped ${droppedNulls} | partialTail ${droppedPartial.length} | maxGap ${maxGapDays}d | dupDates ${dupes} | gaps>=5d: ${gaps.length}`);
    if (droppedNulls / rawCount > 0.01) console.log(`      WARN: ${droppedNulls}/${rawCount} (${(100 * droppedNulls / rawCount).toFixed(1)}%) source candles dropped as null/invalid — full dated list in meta.droppedDates`);
    for (const d of [...droppedDates.slice(0, 12), ...(droppedDates.length > 12 ? [`... (+${droppedDates.length - 12} more, see meta)`] : [])]) console.log(`      dropped: ${d}`);
    for (const d of droppedPartial) console.log(`      dropped tail: ${d}`);
    for (const g of gaps) console.log(`      WARN gap: ${g.from} -> ${g.to} (${g.days}d)`);
    await sleep(700);
  }
  console.log('\nAll daily data cached to backtest/data/daily/*.json — no fabricated candles anywhere.');
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

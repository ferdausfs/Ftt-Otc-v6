/**
 * FTT Engine v2 — historical candle fetcher (REAL data only, no synthesis).
 *
 * Sources (both keyless):
 *   Crypto : Bybit spot klines (BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT — note: USDT
 *            quote, an honest ~basis-level proxy for the project's /USD pairs)
 *   Forex  : Yahoo Finance chart API (EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X;
 *            5m history capped at ~60 days by Yahoo)
 *
 * OTC: Olymp Trade synthetic feeds have no public historical source — the
 * spec itself orders real-market validation FIRST; OTC is deferred and
 * reported as pending data, never simulated.
 *
 * Fixed windows (committed before any backtest run):
 *   1h data from   2026-06-08T00:00Z  (EMA200 stabilization buffer)
 *   5m data from   2026-07-01T00:00Z  (RSI warmup)
 *   5m data to     2026-09-04T23:59Z  (analysis cutoff, clean day boundary)
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');

const MS = { m5: 5 * 60000, h1: 60 * 60000 };
const WIN = {
  h1From: Date.UTC(2026, 5, 8),   // 2026-06-08
  m5From: Date.UTC(2026, 6, 1),   // 2026-07-01
  m5To:   Date.UTC(2026, 8, 4, 23, 59, 0),  // 2026-09-04 23:59
};

const CRYPTO = [
  { pair: 'BTC/USD', symbol: 'BTCUSDT' },
  { pair: 'ETH/USD', symbol: 'ETHUSDT' },
  { pair: 'XRP/USD', symbol: 'XRPUSDT' },
  { pair: 'SOL/USD', symbol: 'SOLUSDT' },
];
const FOREX = [
  { pair: 'EUR/USD', symbol: 'EURUSD=X' },
  { pair: 'GBP/USD', symbol: 'GBPUSD=X' },
  { pair: 'USD/JPY', symbol: 'USDJPY=X' },
  { pair: 'AUD/USD', symbol: 'AUDUSD=X' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bybitKlines(symbol, ivMin, from, to) {
  const out = [];
  let end = to;
  while (end > from) {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
                `&interval=${ivMin}&start=${from}&end=${end}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bybit HTTP ${res.status}`);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
    const list = j.result?.list || [];
    if (list.length === 0) break;
    for (const r of list) {
      // [start, open, high, low, close, volume, turnover] — newest first
      out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const oldest = Math.min(...list.map(r => +r[0]));
    if (list.length < 1000) break;
    end = oldest - 1;
    await sleep(200);
  }
  return dedupeSort(out);
}

async function yahooCandles(symbol, interval, from, to) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=${interval}&period1=${Math.floor(from / 1000)}&period2=${Math.floor(to / 1000)}` +
              `&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`yahoo HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`yahoo: no result ${JSON.stringify(j.chart?.error || {}).slice(0, 120)}`);
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  let droppedNulls = 0;
  for (let k = 0; k < ts.length; k++) {
    const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
    if (o == null || h == null || l == null || c == null) { droppedNulls++; continue; }
    if (!(h >= l && h >= o && h >= c && l <= o && l <= c)) { droppedNulls++; continue; }
    out.push({ t: ts[k] * 1000, o, h, l, c, v: q.volume?.[k] ?? 0 });
  }
  const sorted = dedupeSort(out);
  sorted.droppedNulls = droppedNulls;   // attached, stripped by save()
  return sorted;
}

function dedupeSort(arr) {
  const seen = new Set();
  return arr.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
            .sort((a, b) => a.t - b.t);
}

function sanity(name, candles, ivMs) {
  let maxGap = 0;
  for (let k = 1; k < candles.length; k++) {
    maxGap = Math.max(maxGap, candles[k].t - candles[k - 1].t);
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at ${k}`);
  }
  return { maxGapH: +(maxGap / 3600000).toFixed(2) };
}

async function main() {
  const jobs = [];
  for (const { pair, symbol } of CRYPTO) {
    jobs.push({ name: pair.replace('/', ''), pair, market: 'crypto', source: 'bybit',
                files: { h1: [symbol, 60, WIN.h1From, WIN.m5To], m5: [symbol, 5, WIN.m5From, WIN.m5To] } });
  }
  for (const { pair, symbol } of FOREX) {
    // Yahoo caps intraday history: 5m -> ~60 days. Clamp the 5m window to the
    // cap instead of failing (analysis start 07-08 still keeps ~1 day of RSI
    // warmup = 288 candles, enough for Wilder smoothing to converge).
    const m5From = Math.max(WIN.m5From, Date.now() - 59 * 86400000);
    jobs.push({ name: pair.replace('/', ''), pair, market: 'forex', source: 'yahoo',
                files: { h1: [symbol, '1h', WIN.h1From, WIN.m5To], m5: [symbol, '5m', m5From, WIN.m5To] } });
  }

  for (const job of jobs) {
    for (const [tf, [symbol, iv, from, to]] of Object.entries(job.files)) {
      const file = join(DATA, `${job.name}_${tf}.json`);
      if (existsSync(file)) { console.log(`skip  ${job.name} ${tf} (cached)`); continue; }
      process.stdout.write(`fetch ${job.name} ${tf} (${job.source}) ... `);
      let candles;
      if (job.source === 'bybit') candles = await bybitKlines(symbol, iv, from, to);
      else candles = await yahooCandles(symbol, iv, from, to);
      const dropped = candles.droppedNulls ?? 0;
      delete candles.droppedNulls;
      if (candles.length === 0) throw new Error(`${job.name} ${tf}: 0 candles — aborting, no fabricated data`);
      const { maxGapH } = sanity(`${job.name} ${tf}`, candles, MS[tf]);
      const meta = {
        pair: job.pair, market: job.market, source: job.source, interval: tf,
        symbol, requestedFrom: new Date(from).toISOString(), requestedTo: new Date(to).toISOString(),
        first: new Date(candles[0].t).toISOString(), last: new Date(candles[candles.length - 1].t).toISOString(),
        count: candles.length, droppedNulls: dropped, maxGapHours: maxGapH,
      };
      writeFileSync(file, JSON.stringify({ meta, candles }));
      console.log(`${candles.length} candles | ${meta.first} -> ${meta.last} | dropped ${dropped} | maxGap ${maxGapH}h`);
      await sleep(400);
    }
  }
  console.log('\nAll data cached to data/*.json — no fabricated candles anywhere.');
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

/**
 * FTT3 — historical candle fetcher (REAL data only, no synthesis, fails
 * loudly on zero candles). Sources are keyless public APIs:
 *
 *   Crypto : Bybit spot klines  (BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT — USDT quote,
 *            an honest ~basis-level proxy for the project's /USD pairs)
 *   Forex  : Yahoo Finance chart API (EURUSD=X, GBPUSD=X, USDJPY=X, AUDUSD=X)
 *            — Yahoo caps 1m history at ~30 days, 5m/15m at ~60 days.
 *
 * OTC pairs: no legitimate historical source exists — out of scope by spec.
 *
 * Fixed windows (written into the code before any backtest run):
 *   crypto all TFs : 2026-07-05T00:00Z .. 2026-09-05T01:00Z  (analysis 07-07..)
 *   forex 5m/15m   : 2026-07-05T00:00Z .. 2026-09-05T01:00Z
 *   forex 1m       : max(2026-08-05, now-29d) .. 2026-09-05T01:00Z (Yahoo cap)
 * The 2-day head buffer covers EMA50(15m) + MACD(5m) + ATR100(1m) warmup.
 * The 1h tail past 09-04 23:59 covers 10-minute expiry resolution.
 *
 * Run: node backtest/fetch_data.mjs   (caches to backtest/data/*.json)
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data');
mkdirSync(DATA, { recursive: true });

const FROM_CRYPTO = Date.UTC(2026, 6, 5, 0, 0, 0);   // 2026-07-05
// Yahoo intraday cap: 5m/15m only exist for the last ~60 days — clamp instead
// of failing (v2 convention). Still far earlier than any forex 1m data.
const FROM_FOREX_H = Math.max(Date.UTC(2026, 6, 5, 0, 0, 0), Date.now() - 59 * 86400000);
const FROM_FOREX_1M = Math.max(Date.UTC(2026, 7, 5, 0, 0, 0), Date.now() - 29 * 86400000);
const TO = Date.UTC(2026, 8, 5, 1, 0, 0);            // 2026-09-05T01:00Z

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
    await sleep(180);
  }
  return dedupeSort(out);
}

async function yahooCandles(symbol, interval, from, to) {
  // Yahoo caps intraday history per request; 1m must be chunked into <=7d
  // windows. Overlap is trimmed by dedupeSort.
  const ivMs = interval === '1m' ? 60000 : interval === '5m' ? 300000 : 900000;
  const chunkMs = interval === '1m' ? 7 * 86400000 : 30 * 86400000;
  const out = [];
  let droppedNulls = 0;
  for (let a = from; a < to; a += chunkMs) {
    const b = Math.min(a + chunkMs, to);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=${interval}&period1=${Math.floor(a / 1000)}&period2=${Math.floor(b / 1000)}` +
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
    for (let k = 0; k < ts.length; k++) {
      const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
      if (o == null || h == null || l == null || c == null) { droppedNulls++; continue; }
      if (!(h >= l && h >= o && h >= c && l <= o && l <= c)) { droppedNulls++; continue; }
      // keep only candles whose OPEN time lies inside the requested window
      if (ts[k] * 1000 < a || ts[k] * 1000 >= b) continue;
      out.push({ t: ts[k] * 1000, o, h, l, c, v: q.volume?.[k] ?? 0 });
    }
    await sleep(500);
  }
  const sorted = dedupeSort(out);
  sorted.droppedNulls = droppedNulls;
  return sorted;
}

function dedupeSort(arr) {
  const seen = new Set();
  return arr.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
            .sort((a, b) => a.t - b.t);
}

function sanity(name, candles) {
  let maxGapMin = 0;
  for (let k = 1; k < candles.length; k++) {
    maxGapMin = Math.max(maxGapMin, (candles[k].t - candles[k - 1].t) / 60000);
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at ${k}`);
  }
  return { maxGapMin: +maxGapMin.toFixed(1) };
}

async function main() {
  const jobs = [];
  for (const { pair, symbol } of CRYPTO) {
    jobs.push({ name: pair.replace('/', ''), pair, market: 'crypto', source: 'bybit',
      files: { m1: [symbol, 1, FROM_CRYPTO, TO], m5: [symbol, 5, FROM_CRYPTO, TO], m15: [symbol, 15, FROM_CRYPTO, TO] } });
  }
  for (const { pair, symbol } of FOREX) {
    jobs.push({ name: pair.replace('/', ''), pair, market: 'forex', source: 'yahoo',
      files: { m1: [symbol, '1m', FROM_FOREX_1M, TO], m5: [symbol, '5m', FROM_FOREX_H, TO], m15: [symbol, '15m', FROM_FOREX_H, TO] } });
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
      const { maxGapMin } = sanity(`${job.name} ${tf}`, candles);
      const meta = {
        pair: job.pair, market: job.market, source: job.source, interval: tf,
        symbol, requestedFrom: new Date(from).toISOString(), requestedTo: new Date(to).toISOString(),
        first: new Date(candles[0].t).toISOString(), last: new Date(candles[candles.length - 1].t).toISOString(),
        count: candles.length, droppedNulls: dropped, maxGapMinutes: maxGapMin,
      };
      writeFileSync(file, JSON.stringify({ meta, candles }));
      console.log(`${candles.length} candles | ${meta.first} -> ${meta.last} | dropped ${dropped} | maxGap ${maxGapMin}m`);
      await sleep(300);
    }
  }
  console.log('\nAll data cached to backtest/data/*.json — no fabricated candles anywhere.');
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

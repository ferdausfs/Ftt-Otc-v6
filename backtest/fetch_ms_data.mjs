/**
 * Market Structure (BOS/CHoCH) — historical candle fetcher.
 *
 * Modeled on backtest/fetch_data.mjs (same Bybit spot source, same
 * fail-loudly discipline) for the NEXT genuinely unused crypto window:
 *
 *   Analysis window : 2023-07-05T00:00Z .. 2024-07-05T00:00Z  (~12 months)
 *   Warmup head     : 2023-06-21T00:00Z (14 days) — pivots L=5, trend state
 *                     and ATR-100 are valid before the first evaluated bar;
 *                     NO decision is evaluated before the window itself.
 *   Tail            : to 2024-07-05T01:00Z — resolves 10-minute expiries of
 *                     triggers fired in the last minutes of the window.
 *
 * Pairs: BTC/USD, ETH/USD, XRP/USD, SOL/USD (Bybit spot USDT quote — the
 * same honest ~basis-level proxy for /USD used by every prior crypto test).
 * Timeframes: 1m (trigger + expiry) and 15m (bias).
 *
 * REAL data only, no synthesis, no interpolation: zero candles aborts; gaps
 * are NEVER filled — crypto trades 24/7 so any gap is Bybit downtime; gaps
 * are inventoried loudly and left as holes (the harness treats candles as a
 * consecutive AVAILABLE sequence, and expiry resolution requires the exact
 * exit candle to exist, so holes can only produce EXPIRY_GAP, never fakes).
 *
 * Run: node backtest/fetch_ms_data.mjs   (caches to backtest/data/ms/*.json)
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ms');
mkdirSync(DATA, { recursive: true });

const FROM = Date.UTC(2023, 5, 21, 0, 0, 0);   // 2023-06-21T00:00Z (14d warmup)
const WIN_START = Date.UTC(2023, 6, 5, 0, 0, 0); // 2023-07-05T00:00Z
const WIN_END = Date.UTC(2024, 6, 5, 0, 0, 0);   // 2024-07-05T00:00Z
const TO = Date.UTC(2024, 6, 5, 1, 0, 0);        // 2024-07-05T01:00Z (tail)

const PAIRS = [
  { pair: 'BTC/USD', symbol: 'BTCUSDT' },
  { pair: 'ETH/USD', symbol: 'ETHUSDT' },
  { pair: 'XRP/USD', symbol: 'XRPUSDT' },
  { pair: 'SOL/USD', symbol: 'SOLUSDT' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchOnce(url, tries = 5) {
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bybit HTTP ${res.status}`);
      const j = await res.json();
      if (j.retCode !== 0) throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
      return j;
    } catch (e) {
      if (a === tries) throw e;
      await sleep(400 * a);   // brief backoff, then retry — fail loudly only on final failure
    }
  }
}

async function bybitKlines(symbol, ivMin, from, to) {
  const out = [];
  let end = to;
  let reqs = 0;
  while (end > from) {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
                `&interval=${ivMin}&start=${from}&end=${end}&limit=1000`;
    const j = await fetchOnce(url);
    reqs++;
    const list = j.result?.list || [];
    if (list.length === 0) break;
    for (const r of list) {
      // [start, open, high, low, close, volume, turnover] — newest first
      out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const oldest = Math.min(...list.map(r => +r[0]));
    if (list.length < 1000) break;
    end = oldest - 1;
    if (reqs % 100 === 0) console.log(`  ... ${symbol} back to ${new Date(oldest).toISOString()} (${reqs} requests, ${out.length} candles)`);
    await sleep(150);
  }
  const sorted = dedupeSort(out);
  sorted.requests = reqs;
  return sorted;
}

function dedupeSort(arr) {
  const seen = new Set();
  return arr.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
            .sort((a, b) => a.t - b.t);
}

/** Inventory every gap > `ivMs`; abort only on absurd fetch bugs (> 24h on 1m). */
function gapAudit(name, candles, ivMs) {
  const gaps = [];
  for (let k = 1; k < candles.length; k++) {
    const g = candles[k].t - candles[k - 1].t;
    if (g > ivMs) gaps.push({ from: new Date(candles[k - 1].t).toISOString(), minutes: g / 60000 });
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at index ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at index ${k}`);
    if (candles[k].h < candles[k].c || candles[k].h < candles[k].o ||
        candles[k].l > candles[k].c || candles[k].l > candles[k].o)
      throw new Error(`${name}: OHLC invariant violated at index ${k}`);
  }
  const maxGapMin = gaps.length ? Math.max(...gaps.map(g => g.minutes)) : 0;
  const absurd = ivMs === 60000 ? 24 * 60 : 24 * 60 * 4;
  if (maxGapMin > absurd) {
    throw new Error(`${name}: max gap ${maxGapMin}m exceeds ${absurd}m — fetch bug, aborting (no fabricated data)`);
  }
  if (gaps.length) {
    console.log(`  NOTE ${name}: ${gaps.length} real source gaps, max ${maxGapMin}m — ` +
      gaps.slice(0, 8).map(g => `${g.from}(+${g.minutes}m)`).join(', ') +
      (gaps.length > 8 ? ` … +${gaps.length - 8} more` : ''));
  }
  return { count: gaps.length, maxGapMinutes: +maxGapMin.toFixed(1), maxAllowedMinutes: absurd };
}

async function fetchPair({ pair, symbol }) {
  const name = pair.replace('/', '');
  for (const [tf, ivMs] of [['1m', 60000], ['15m', 900000]]) {
    const file = join(DATA, `${name}_${tf}.json`);
    if (existsSync(file)) { console.log(`skip  ${name} ${tf} (cached)`); continue; }
    console.log(`fetch ${name} ${tf} ... start t=${new Date().toISOString()}`);
    const candles = await bybitKlines(symbol, tf === '1m' ? 1 : 15, FROM, TO);
    delete candles.requests;
    if (candles.length === 0) throw new Error(`${name} ${tf}: 0 candles — aborting, no fabricated data`);
    const gaps = gapAudit(`${name} ${tf}`, candles, ivMs);
    // warmup/window split stats (report only — the harness enforces its own bounds)
    const inWin = candles.filter(c => c.t >= WIN_START && c.t < WIN_END).length;
    const warmup = candles.filter(c => c.t < WIN_START).length;
    const tail = candles.filter(c => c.t >= WIN_END).length;
    const meta = {
      pair, market: 'crypto', source: 'bybit', interval: tf, symbol,
      requestedFrom: new Date(FROM).toISOString(), requestedTo: new Date(TO).toISOString(),
      windowStart: new Date(WIN_START).toISOString(), windowEnd: new Date(WIN_END).toISOString(),
      warmupBars: warmup, windowBars: inWin, tailBars: tail,
      first: new Date(candles[0].t).toISOString(), last: new Date(candles[candles.length - 1].t).toISOString(),
      count: candles.length, gaps,
    };
    writeFileSync(file, JSON.stringify({ meta, candles }));
    console.log(`${candles.length} candles | ${meta.first} -> ${meta.last} | warmup ${warmup} / window ${inWin} / tail ${tail}`);
    await sleep(250);
  }
}

async function main() {
  const only = process.argv[2] ? process.argv[2].toUpperCase() : null;   // e.g. `node fetch_ms_data.mjs BTC`
  console.log(`window ${new Date(WIN_START).toISOString()} -> ${new Date(WIN_END).toISOString()} + 1h tail; warmup from ${new Date(FROM).toISOString()}`);
  for (const p of PAIRS) {
    if (only && !p.pair.replace('/', '').startsWith(only)) continue;
    await fetchPair(p);   // sequential pairs; ~150ms/request inside
  }
  console.log('\nAll data cached to backtest/data/ms/*.json — no fabricated candles anywhere.');
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

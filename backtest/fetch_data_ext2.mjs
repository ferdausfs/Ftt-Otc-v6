/**
 * EMA RIBBON — extended-history fetcher for the 2024-07-05..2025-07-05 window
 * (genuinely unused: every crypto candle previously fetched by this project
 * covers 2025-07-05T00:00Z onwards). REAL data only, no synthesis, fails
 * loudly on zero candles / missing warmup.
 *
 * Source: Bybit spot klines (BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT — USDT quote,
 * the same honest ~basis-level proxy for the project's /USD pairs used by
 * backtest/fetch_data.mjs). Crypto only: the strategy needs 1m + 15m.
 *
 * Frozen windows (written before any backtest run):
 *   evaluation : 2024-07-05T00:00Z .. 2025-07-05T00:00Z  (decisions inside)
 *   warmup     : 7 days before  -> covers EMA55(15m) seed/convergence and
 *                 the full trailing-100 ATR(14) 1m window at the first
 *                 evaluable boundary (needs 114 1m candles; 7d = 10,080)
 *   tail       : 15 min past the end -> resolves 10-minute expiries of the
 *                 last boundaries
 *
 * Run:            node backtest/fetch_data_ext2.mjs
 * Smoke plumbing: node backtest/fetch_data_ext2.mjs --smoke
 *                 (BTCUSDT only, 4-day slice, writes to backtest/data/ext2_smoke)
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE = process.argv.includes('--smoke');

// ── frozen constants ─────────────────────────────────────────────────────────
const EVAL_FROM = Date.UTC(2024, 6, 5, 0, 0, 0);   // 2024-07-05T00:00Z
const EVAL_TO = Date.UTC(2025, 6, 5, 0, 0, 0);     // 2025-07-05T00:00Z
const WARMUP_MS = 7 * 86400000;
const TAIL_MS = 15 * 60000;
const FETCH_FROM = EVAL_FROM - WARMUP_MS;          // 2024-06-28T00:00Z
const FETCH_TO = EVAL_TO + TAIL_MS;                // 2025-07-05T00:15Z

const CRYPTO = [
  { pair: 'BTC/USD', symbol: 'BTCUSDT' },
  { pair: 'ETH/USD', symbol: 'ETHUSDT' },
  { pair: 'XRP/USD', symbol: 'XRPUSDT' },
  { pair: 'SOL/USD', symbol: 'SOLUSDT' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bybitKlines(symbol, ivMin, from, to) {
  const out = [];
  let end = to;
  let pages = 0;
  while (end > from) {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
                `&interval=${ivMin}&start=${from}&end=${end}&limit=1000`;
    let j;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`bybit HTTP ${res.status}`);
      j = await res.json();
      if (j.retCode === 0) break;
      if (j.retCode === 10006) {   // too many visits — back off and retry
        await sleep(1200 * attempt);
        continue;
      }
      throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
    }
    if (!j || j.retCode !== 0) throw new Error(`bybit rate-limited after retries`);
    const list = j.result?.list || [];
    if (list.length === 0) break;
    for (const r of list) {
      // [start, open, high, low, close, volume, turnover] — newest first
      out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    const oldest = Math.min(...list.map(r => +r[0]));
    pages++;
    if (list.length < 1000) break;
    end = oldest - 1;
    await sleep(180);
  }
  return { candles: dedupeSort(out), pages };
}

function dedupeSort(arr) {
  const seen = new Set();
  return arr.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
            .sort((a, b) => a.t - b.t);
}

function sanity(name, candles, ivMs) {
  let maxGapMin = 0;
  for (let k = 1; k < candles.length; k++) {
    maxGapMin = Math.max(maxGapMin, (candles[k].t - candles[k - 1].t) / 60000);
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at ${k}`);
  }
  // gap accounting vs the theoretical grid (loud, not fatal — the audit
  // handles missing candles honestly; the report states the counts)
  const expected = Math.floor((candles[candles.length - 1].t - candles[0].t) / ivMs) + 1;
  const missing = expected - candles.length;
  return { maxGapMin: +maxGapMin.toFixed(1), expected, missing };
}

async function main() {
  const DATA = join(ROOT, 'backtest', 'data', SMOKE ? 'ext2_smoke' : 'ext2');
  mkdirSync(DATA, { recursive: true });
  const from = SMOKE ? FETCH_FROM : FETCH_FROM;
  const to = SMOKE ? FETCH_FROM + 4 * 86400000 : FETCH_TO;

  for (const { pair, symbol } of (SMOKE ? CRYPTO.slice(0, 1) : CRYPTO)) {
    for (const [tf, ivMs] of [['m1', 60000], ['m15', 900000]]) {
      const file = join(DATA, `${pair.replace('/', '')}_${tf}.json`);
      if (existsSync(file)) { console.log(`skip  ${pair} ${tf} (cached)`); continue; }
      process.stdout.write(`fetch ${pair} ${tf} (${symbol}) ... `);
      const { candles, pages } = await bybitKlines(symbol, tf === 'm1' ? 1 : 15, from, to);
      if (candles.length === 0) throw new Error(`${pair} ${tf}: 0 candles — aborting, no fabricated data`);
      if (candles[0].t > from + 120000) {
        throw new Error(`${pair} ${tf}: data starts at ${new Date(candles[0].t).toISOString()}, ` +
          `requested ${new Date(from).toISOString()} — warmup unavailable, refusing to continue`);
      }
      const { maxGapMin, expected, missing } = sanity(`${pair} ${tf}`, candles, ivMs);
      const meta = {
        pair, market: 'crypto', source: 'bybit', interval: tf, symbol,
        requestedFrom: new Date(from).toISOString(), requestedTo: new Date(to).toISOString(),
        evalFrom: new Date(EVAL_FROM).toISOString(), evalTo: new Date(EVAL_TO).toISOString(),
        first: new Date(candles[0].t).toISOString(), last: new Date(candles[candles.length - 1].t).toISOString(),
        count: candles.length, expectedOnGrid: expected, missingOnGrid: missing,
        maxGapMinutes: maxGapMin, pages,
      };
      writeFileSync(file, JSON.stringify({ meta, candles }));
      console.log(`${candles.length} candles | ${meta.first} -> ${meta.last} | missing ${missing} | maxGap ${maxGapMin}m | pages ${pages}`);
      await sleep(300);
    }
  }
  console.log(`\nAll data cached to ${DATA} — no fabricated candles anywhere.`);
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

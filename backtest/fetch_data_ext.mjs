/**
 * FTT3-R EXT — historical candle fetcher for the 12-month NEVER-TOUCHED
 * crypto window. REAL data only, no synthesis, fails loudly on zero candles.
 *
 *   Source  : Bybit spot klines (BTCUSDT/ETHUSDT/XRPUSDT/SOLUSDT — USDT
 *             quote, the same honest ~basis-level proxy the FTT3 fetch used)
 *   Window  : 2025-06-21T00:00Z .. 2026-07-05T00:00:00Z
 *             - evaluation window (frozen): 2025-07-05T00:00Z .. 2026-07-04
 *             - the 14-day head buffer covers EMA50(15m) + MACD(5m) +
 *               ADX(14) + ATR100(1m) warmup — no decision evaluated inside it
 *             - TO is EXACTLY 2026-07-05T00:00Z: no candle from the burned
 *               2026-07-05..09-05 window is fetched, even for tail expiry
 *               resolution (tail signals resolve EXPIRY_GAP instead)
 *   TFs     : 1m, 5m, 15m
 *
 * Resume-safe: <name>.part + atomic rename; completed files are skipped.
 * Gap counts + open-time alignment are reported loudly per file (Bybit spot
 * has occasional 1m holes; they resolve EXPIRY_GAP downstream — never
 * interpolated).
 *
 * CLI: node backtest/fetch_data_ext.mjs                 -> all 12 files
 *      node backtest/fetch_data_ext.mjs BTCUSD m1       -> one file
 */
import { writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data_ext');
mkdirSync(DATA, { recursive: true });

const FROM = Date.UTC(2025, 5, 21, 0, 0, 0);   // 2025-06-21T00:00Z warmup head
const TO = Date.UTC(2026, 6, 5, 0, 0, 0);      // 2026-07-05T00:00:00Z strict end
const EVAL_START = '2025-07-05T00:00:00Z';     // documented for the meta record
const EVAL_END = '2026-07-05T00:00:00Z';

const CRYPTO = [
  { pair: 'BTC/USD', symbol: 'BTCUSDT' },
  { pair: 'ETH/USD', symbol: 'ETHUSDT' },
  { pair: 'XRP/USD', symbol: 'XRPUSDT' },
  { pair: 'SOL/USD', symbol: 'SOLUSDT' },
];
const TF_MS = { m1: 60000, m5: 300000, m15: 900000 };
const TF_IV = { m1: 1, m5: 5, m15: 15 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bybitKlines(symbol, ivMin, from, to, label) {
  const out = [];
  let pages = 0;
  let end = to;
  while (end > from) {
    const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
                `&interval=${ivMin}&start=${from}&end=${end}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`bybit HTTP ${res.status} on ${label} page ${pages + 1}`);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error(`bybit ${j.retCode}: ${j.retMsg} on ${label}`);
    const list = j.result?.list || [];
    if (list.length === 0) break;
    for (const r of list) {
      // [start, open, high, low, close, volume, turnover] — newest first
      out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    }
    pages++;
    if (pages % 50 === 0)
      console.log(`    ${label}: page ${pages}, ${out.length} candles so far`);
    const oldest = Math.min(...list.map(r => +r[0]));
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

function sanity(name, candles, tfMs) {
  if (candles.length === 0) throw new Error(`${name}: 0 candles — aborting, no fabricated data`);
  let maxGapMin = 0, gaps = 0, misaligned = 0;
  for (let k = 1; k < candles.length; k++) {
    const dMin = (candles[k].t - candles[k - 1].t) / 60000;
    if (dMin > maxGapMin) maxGapMin = dMin;
    if (dMin > tfMs / 60000) gaps += Math.round(dMin / (tfMs / 60000)) - 1;
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at index ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at index ${k}`);
  }
  for (const c of candles) if (c.t % tfMs !== 0) misaligned++;
  if (misaligned > 0) throw new Error(`${name}: ${misaligned} candles with misaligned open times`);
  const expected = Math.floor((TO - FROM) / tfMs);
  return { maxGapMin: +maxGapMin.toFixed(1), gaps, misaligned, expected,
           coverage: +(100 * candles.length / expected).toFixed(2) };
}

async function fetchOne(name, pair, symbol, tf) {
  const file = join(DATA, `${name}_${tf}.json`);
  if (existsSync(file)) { console.log(`skip  ${name} ${tf} (cached)`); return; }
  const partFile = file + '.part';
  console.log(`fetch ${name} ${tf} from Bybit spot (${symbol}) ...`);
  const { candles, pages } = await bybitKlines(symbol, TF_IV[tf], FROM, TO, `${name} ${tf}`);
  const s = sanity(`${name} ${tf}`, candles, TF_MS[tf]);
  const meta = {
    pair, market: 'crypto', source: 'bybit', interval: tf, symbol,
    requestedFrom: new Date(FROM).toISOString(), requestedTo: new Date(TO).toISOString(),
    evalWindow: { start: EVAL_START, end: EVAL_END },
    first: new Date(candles[0].t).toISOString(), last: new Date(candles[candles.length - 1].t).toISOString(),
    count: candles.length, expectedCount: s.expected, coveragePct: s.coverage,
    missingCandles: s.gaps, maxGapMinutes: s.maxGapMin, misaligned: s.misaligned,
    pages,
  };
  writeFileSync(partFile, JSON.stringify({ meta, candles }));
  renameSync(partFile, file);
  console.log(`  DONE ${name} ${tf}: ${candles.length} candles (${s.coverage}% of expected) | ` +
              `${meta.first} -> ${meta.last} | gaps ${s.gaps} | maxGap ${s.maxGapMin}m | pages ${pages}`);
}

async function main() {
  console.log(`FTT3-R EXT fetch: ${new Date(FROM).toISOString()} -> ${new Date(TO).toISOString()}`);
  console.log(`(evaluation window ${EVAL_START} .. ${EVAL_END}; head buffer = warmup only; ` +
              `no burned-window candle fetched)\n`);

  // Optional CLI selector: <NAME> <tf> — one file per invocation (sandbox-safe
  // synchronous chunking; each 1m file fits well inside the command timeout).
  const [selName, selTf] = process.argv.slice(2);
  for (const { pair, symbol } of CRYPTO) {
    const name = pair.replace('/', '');
    if (selName && name !== selName) continue;
    for (const tf of ['m1', 'm5', 'm15']) {
      if (selTf && tf !== selTf) continue;
      await fetchOne(name, pair, symbol, tf);
      await sleep(300);
    }
  }
  console.log('\nAll EXT data cached to backtest/data_ext/*.json — no fabricated candles anywhere.');
}

main().catch(e => { console.error('FETCH FAILED:', e.message); process.exit(1); });

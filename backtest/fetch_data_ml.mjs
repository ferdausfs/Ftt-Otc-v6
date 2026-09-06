/**
 * TASK 24 — ML FEASIBILITY: raw data fetcher (candles + funding rate).
 * Fetches RAW inputs only — no feature math lives in this file. The split
 * boundaries are frozen in experiments/ml/split_dates.json (committed BEFORE
 * any feature code is written) — this fetcher only needs the raw span.
 *
 * Sources (identical to every prior crypto fetch in this project):
 *   candles : Bybit spot v5 klines, 1m + 15m (USDT quote — the same honest
 *             ~basis-level proxy for the project's /USD pairs)
 *   funding : Bybit v5 /v5/market/funding/history, category=linear (USDT
 *             perp funding — the genuine crypto-specific input requested)
 *
 * Availability probed 2026-09-06 (experiments/ml/probe_bybit.py):
 *   spot 1m: BTC/ETH 2021-07-05, XRP 2021-07-20, SOL 2021-10-21 -> now
 *   funding: all 4 pairs from 2021-08-16 onward
 * => frozen ML window 2021-11-01T00:00Z .. 2026-09-05T00:00Z (SOL gets
 *    10.7 days of warmup before T0 — every trailing feature window full)
 *
 * REAL data only. Zero candles, h<l, non-positive close -> abort loudly.
 * No interpolation, no synthesis, ever. Resumable per year-chunk file.
 *
 * Run:        node backtest/fetch_data_ml.mjs [--budget-seconds N] [--pairs A,B] [--status]
 *             (sandbox runs this in repeated foreground invocations; chunk
 *              files cache progress, so re-invoking resumes)
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'backtest', 'data', 'ml');

// ── frozen constants ─────────────────────────────────────────────────────────
const T0 = Date.UTC(2021, 10, 1, 0, 0, 0);        // 2021-11-01T00:00Z (window open)
const T1 = Date.UTC(2026, 8, 5, 0, 0, 0);         // 2026-09-05T00:00Z (window close)
const WARMUP_FROM = T0 - 7 * 86400000;            // 2021-10-25T00:00Z (fetch start)
const FETCH_TO = T1 + 15 * 60000;                 // tail: resolves last 10m label

const PAIRS = [
  { pair: 'BTC/USD', symbol: 'BTCUSDT' },
  { pair: 'ETH/USD', symbol: 'ETHUSDT' },
  { pair: 'XRP/USD', symbol: 'XRPUSDT' },
  { pair: 'SOL/USD', symbol: 'SOLUSDT' },
];

// year-chunks: [WARMUP_FROM -> 2022-01-01), [2022), [2023), [2024), [2025), [2026-01-01 -> FETCH_TO]
function yearChunks() {
  const chunks = [];
  let from = WARMUP_FROM;
  for (let y = 2022; y <= 2026; y++) {
    const jan = Date.UTC(y, 0, 1);
    chunks.push({ from, to: Math.min(jan, FETCH_TO), label: `${y - 1}tail` });
    from = jan;
  }
  chunks.push({ from, to: FETCH_TO, label: 'end' });
  return chunks;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bybitGet(url) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) { await sleep(1500 * attempt); continue; }
      throw new Error(`bybit HTTP ${res.status} for ${url}`);
    }
    const j = await res.json();
    if (j.retCode === 0) return j;
    if (j.retCode === 10006) { await sleep(1200 * attempt); continue; }  // too many visits
    throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
  }
  throw new Error(`bybit rate-limited after retries: ${url}`);
}

async function fetchKlineChunk(symbol, ivMin, from, to) {
  const out = [];
  let end = to;
  let pages = 0;
  while (end > from) {
    const j = await bybitGet(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}` +
      `&interval=${ivMin}&start=${from}&end=${end}&limit=1000`);
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
    await sleep(150);
  }
  const seen = new Set();
  const candles = out.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
    .sort((a, b) => a.t - b.t);
  return { candles, pages };
}

function chunkSanity(name, candles, ivMs, from, to) {
  if (candles.length === 0) throw new Error(`${name}: 0 candles in chunk — aborting, no fabricated data`);
  for (let k = 1; k < candles.length; k++) {
    if (!(candles[k].h >= candles[k].l)) throw new Error(`${name}: h<l at ${k}`);
    if (!(candles[k].c > 0)) throw new Error(`${name}: non-positive close at ${k}`);
  }
  const first = candles[0].t, last = candles[candles.length - 1].t;
  const expected = Math.floor((last - first) / ivMs) + 1;
  const missing = expected - candles.length;
  let maxGapMin = 0;
  for (let k = 1; k < candles.length; k++) {
    maxGapMin = Math.max(maxGapMin, (candles[k].t - candles[k - 1].t) / 60000);
  }
  return { first, last, expected, missing, maxGapMin: +maxGapMin.toFixed(1) };
}

async function fetchFunding(symbol, from, to) {
  const out = [];
  let end = to;
  let pages = 0;
  while (end > from) {
    const j = await bybitGet(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}` +
      `&startTime=${from}&endTime=${end}&limit=200`);
    const list = j.result?.list || [];
    if (list.length === 0) break;
    for (const r of list) {
      out.push({ t: +r.fundingRateTimestamp, rate: +r.fundingRate });
    }
    const oldest = Math.min(...out.map(x => x.t));
    pages++;
    if (list.length < 200) break;
    end = oldest - 1;
    await sleep(150);
  }
  const seen = new Set();
  const recs = out.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)))
    .sort((a, b) => a.t - b.t);
  return { recs, pages };
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const budgetS = (() => { const i = args.indexOf('--budget-seconds'); return i === -1 ? 1e9 : +args[i + 1]; })();
const pairFilter = (() => { const i = args.indexOf('--pairs'); return i === -1 ? null : args[i + 1].split(','); })();
const chunks = yearChunks();
const activePairs = pairFilter ? PAIRS.filter(p => pairFilter.includes(p.symbol)) : PAIRS;
const started = Date.now();
let stop = false;

mkdirSync(DATA, { recursive: true });

if (statusOnly) {
  for (const { pair, symbol } of PAIRS) {
    for (const tf of ['m1', 'm15']) {
      const have = chunks.filter(c => existsSync(join(DATA, `${symbol}_${tf}_${c.label}.json`))).length;
      const f = existsSync(join(DATA, `${symbol}_funding.json`));
      console.log(`${symbol} ${tf}: ${have}/${chunks.length} chunks | funding: ${f ? 'yes' : 'no'}`);
    }
  }
  console.log('fetch_data_ml: status only.');
  process.exit(0);
}

for (const { pair, symbol } of activePairs) {
  if (stop) break;
  for (const [tf, ivMs, ivMin] of [['m1', 60000, 1], ['m15', 900000, 15]]) {
    if (stop) break;
    for (const ch of chunks) {
      if (stop) break;
      const file = join(DATA, `${symbol}_${tf}_${ch.label}.json`);
      if (existsSync(file)) continue;
      if (Date.now() - started > budgetS * 1000) { console.log('budget reached — stopping cleanly (resume by re-running)'); stop = true; break; }
      process.stdout.write(`fetch ${pair} ${tf} [${ch.label}] ${new Date(ch.from).toISOString()}..${new Date(ch.to).toISOString()} ... `);
      const { candles, pages } = await fetchKlineChunk(symbol, ivMin, ch.from, ch.to);
      const s = chunkSanity(`${pair} ${tf} ${ch.label}`, candles, ivMs, ch.from, ch.to);
      const meta = {
        pair, symbol, interval: tf, chunk: ch.label,
        requestedFrom: new Date(ch.from).toISOString(), requestedTo: new Date(ch.to).toISOString(),
        first: new Date(s.first).toISOString(), last: new Date(s.last).toISOString(),
        count: candles.length, expectedOnGrid: s.expected, missingOnGrid: s.missing,
        maxGapMinutes: s.maxGapMin, pages,
      };
      writeFileSync(file, JSON.stringify({ meta, candles }));
      console.log(`${candles.length} candles | missing ${s.missing} | maxGap ${s.maxGapMin}m | pages ${pages}`);
      await sleep(250);
    }
  }
  // funding rate (one file per pair)
  if (!stop) {
    const file = join(DATA, `${symbol}_funding.json`);
    if (!existsSync(file)) {
      process.stdout.write(`fetch ${pair} funding (linear) ... `);
      const { recs, pages } = await fetchFunding(symbol, WARMUP_FROM - 30 * 86400000, FETCH_TO);
      if (recs.length === 0) throw new Error(`${pair}: 0 funding records — aborting`);
      writeFileSync(file, JSON.stringify({
        meta: { pair, symbol, source: 'bybit linear perp funding', count: recs.length,
                first: new Date(recs[0].t).toISOString(), last: new Date(recs[recs.length - 1].t).toISOString() },
        records: recs,
      }));
      console.log(`${recs.length} records | pages ${pages}`);
      await sleep(250);
    }
  }
}

// cross-chunk continuity manifest per pair+tf (loud accounting, never synthesis)
if (!statusOnly && !stop) {
  for (const { pair, symbol } of activePairs) {
    for (const tf of ['m1', 'm15']) {
      const files = chunks.map(c => join(DATA, `${symbol}_${tf}_${c.label}.json`)).filter(existsSync);
      if (files.length !== chunks.length) { console.log(`manifest ${symbol} ${tf}: ${files.length}/${chunks.length} chunks (incomplete)`); continue; }
      let total = 0, totalMissing = 0, maxGap = 0, crossGaps = [];
      for (let i = 0; i < files.length; i++) {
        const { meta, candles } = JSON.parse(readFileSync(files[i], 'utf8'));
        void meta;
        total += candles.length;
        totalMissing += meta.missingOnGrid;
        maxGap = Math.max(maxGap, meta.maxGapMinutes);
        if (i > 0) {
          const prev = JSON.parse(readFileSync(files[i - 1], 'utf8'));
          const gapMin = (candles[0].t - prev.candles[prev.candles.length - 1].t) / 60000;
          if (gapMin > 1) crossGaps.push(`${gapMin}m @ chunk ${i}`);
        }
      }
      const manifest = { pair, symbol, tf, chunks: files.length, candlesTotal: total,
        missingOnGridTotal: totalMissing, maxGapMinutes: maxGap, crossChunkGaps: crossGaps,
        coverageOfFrozenWindow: { T0: new Date(T0).toISOString(), T1: new Date(T1).toISOString() } };
      writeFileSync(join(DATA, `${symbol}_${tf}_manifest.json`), JSON.stringify(manifest, null, 1));
      console.log(`manifest ${symbol} ${tf}: ${total} candles, missing ${totalMissing}, maxGap ${maxGap}m, crossGaps [${crossGaps.join(', ') || 'none'}]`);
    }
  }
}

if (statusOnly) {
  for (const { pair, symbol } of PAIRS) {
    for (const tf of ['m1', 'm15']) {
      const have = chunks.filter(c => existsSync(join(DATA, `${symbol}_${tf}_${c.label}.json`))).length;
      const f = existsSync(join(DATA, `${symbol}_funding.json`));
      console.log(`${symbol} ${tf}: ${have}/${chunks.length} chunks | funding: ${f ? 'yes' : 'no'}`);
    }
  }
}
console.log('fetch_data_ml: done.');

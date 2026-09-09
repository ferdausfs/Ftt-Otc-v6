/**
 * FX 1h data fetcher for the FRVP-FX1H test — histdata.com free tick feed.
 *
 * WHY THE SOURCE SWITCH (documented, not buried — mirrors the task's own
 * caveats): the task spec assumed TwelveData. TwelveData is not usable for
 * this test from this environment:
 *   (1) no API key is available locally (the project's live keys are
 *       Cloudflare worker secrets, not accessible to backtest jobs), and
 *   (2) the public demo key whitelists only EUR/USD and USD/JPY (GBP/USD and
 *       AUD/USD return 401), and
 *   (3) TwelveData forex time_series rows carry NO volume field at all
 *       (verified 2026-09-09: OHLC only) — and a volume proxy is
 *       structurally required: the entire hypothesis is a VOLUME profile.
 * histdata.com's free tick feed needs no key and provides the same class of
 * proxy the task warned about: hourly VOLUME = COUNT OF TICKS (quote
 * updates). The task's caveat #1 ("FX volume is tick volume, not real traded
 * volume") applies VERBATIM to this source and is restated wherever volume
 * is discussed.
 *
 * WINDOW: the task scoped a short test ("~60-day cap" was a TwelveData
 * free-tier premise). histdata imposes no such cap; to keep the test as
 * scoped we fetch 2026-06 .. 2026-09 (partial): ~99 calendar days total,
 * of which the first 480 hourly candles (~20 trading days) are profile
 * warmup and the evaluable remainder is ~75 calendar days — the same
 * short-data regime the task anticipated, with per-pair counts reported.
 *
 * Aggregation: bid/ask mids -> 1h OHLC; volume = tick count. Timestamps are
 * GMT (histdata convention) -> candle t = hour OPEN in ms UTC (same
 * convention as every other dataset in this repo).
 *
 * Output: backtest/data/fx1h/{PAIR}_1h.json  { meta, candles:[{t,o,h,l,c,v}] }
 * Raw tick CSVs cached under backtest/data/fx1h/raw/ (gitignored).
 *
 * Run: node backtest/fetch_fx1h_data.mjs
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'backtest', 'data', 'fx1h');
const RAW_DIR = join(OUT_DIR, 'raw');
const LOG = join(OUT_DIR, 'fetch_log.txt');

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'];
const MONTHS = ['202606', '202607', '202608', '202609'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MS_H = 3_600_000;

const log = (m) => { console.log(m); appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); };

function monthUrl(pair, ym) {
  const y = ym.slice(0, 4);
  const m = parseInt(ym.slice(4), 10);      // no leading zero in the URL path
  return {
    page: `https://www.histdata.com/download-free-forex-historical-data/?/ascii/tick-data-quotes/${pair.toLowerCase()}/${y}/${m}`,
    date: y,
    datemonth: ym,
  };
}

async function downloadTickCsv(pair, ym) {
  const csvPath = join(RAW_DIR, `DAT_ASCII_${pair}_T_${ym}.csv`);
  if (existsSync(csvPath) && readFileSync(csvPath).length > 1_000_000) {
    log(`  ${pair} ${ym}: raw CSV cached`);
    return csvPath;
  }
  const { page, date, datemonth } = monthUrl(pair, ym);
  // token dance: GET the month page, extract the tk token, POST get.php
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(page, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (!res.ok) throw new Error(`page ${res.status}`);
      const html = await res.text();
      const tk = (html.match(/name="tk"[^>]*value="([a-f0-9]+)"/) || [])[1];
      if (!tk) throw new Error('tk token not found');
      const body = new URLSearchParams({ tk, date, datemonth, platform: 'ASCII', timeframe: 'T', fxpair: pair });
      const zipRes = await fetch('https://www.histdata.com/get.php', {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: page,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!zipRes.ok) throw new Error(`zip ${zipRes.status}`);
      const buf = Buffer.from(await zipRes.arrayBuffer());
      if (buf.length < 10_000) throw new Error(`zip too small: ${buf.length}`);
      const zipPath = join(RAW_DIR, `T_${pair}_${ym}.zip`);
      writeFileSync(zipPath, buf);
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', RAW_DIR]);
      const csv = join(RAW_DIR, `DAT_ASCII_${pair}_T_${ym}.csv`);
      if (!existsSync(csv)) throw new Error('csv not extracted');
      log(`  ${pair} ${ym}: downloaded ${(buf.length / 1e6).toFixed(1)}MB zip -> ${(existsSync(csv) ? readFileSync(csv).length : 0) / 1e6 | 0}MB csv`);
      return csv;
    } catch (e) {
      log(`  ${pair} ${ym}: attempt ${attempt} failed: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 3_000 * attempt));
    }
  }
}

/** parse "20260802 170011000" (GMT, ms precision) -> ms UTC */
function parseTs(s) {
  //           YYYYMMDD HHMMSSmmm
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const H = +s.slice(9, 11), M = +s.slice(11, 13), S = +s.slice(13, 15), ms = +s.slice(15, 18);
  return Date.UTC(y, mo - 1, d, H, M, S, ms);
}

function aggregatePair(pair) {
  const candles = [];
  // The feed carries ~1-second backwards timestamp jitter (a tick dated 1s
  // before its predecessor). Within an hour this is harmless (same bucket);
  // when it crosses an hour boundary it would create a non-monotonic candle
  // series. Discipline: such ticks are SKIPPED and COUNTED, never re-timed.
  let ticks = 0, nonMonotonic = 0, dupTs = 0, backwardsJitterSkipped = 0, prevTs = -1;
  let cur = null;   // { t, o, h, l, c, v }
  const flush = () => { if (cur) { candles.push(cur); cur = null; } };

  for (const ym of MONTHS) {
    const csvPath = join(RAW_DIR, `DAT_ASCII_${pair}_T_${ym}.csv`);
    if (!existsSync(csvPath)) continue;
    const text = readFileSync(csvPath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      // columns: GMT ts (ms), ask, bid, askVolume(0)  ->  mid price
      const c1 = ln.indexOf(','), c2 = ln.indexOf(',', c1 + 1), c3 = ln.indexOf(',', c2 + 1);
      if (c1 < 0 || c2 < 0 || c3 < 0) continue;
      const ts = parseTs(ln.slice(0, c1));
      const ask = +ln.slice(c1 + 1, c2);
      const bid = +ln.slice(c2 + 1, c3);
      if (!(ts > 0) || !(ask > 0) || !(bid > 0)) continue;
      if (ts === prevTs) dupTs++;
      else if (ts < prevTs) nonMonotonic++;
      prevTs = ts;
      const mid = (ask + bid) / 2;
      const hourT = Math.floor(ts / MS_H) * MS_H;
      if (cur && hourT < cur.t) { backwardsJitterSkipped++; continue; }  // backwards jitter across an hour boundary: skip, count, never re-time
      if (!cur || cur.t !== hourT) { flush(); cur = { t: hourT, o: mid, h: mid, l: mid, c: mid, v: 0 }; }
      if (mid > cur.h) cur.h = mid;
      if (mid < cur.l) cur.l = mid;
      cur.c = mid;      // last tick in the hour
      cur.v += 1;
      ticks++;
    }
  }
  flush();
  return { candles, stats: { ticks, nonMonotonic, dupTs, backwardsJitterSkipped } };
}

function validate(pair, candles) {
  let badOHLC = 0, zeroVol = 0, gapHours = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!(c.h >= c.l && c.h >= c.o && c.h >= c.c && c.l <= c.o && c.l <= c.c)) badOHLC++;
    if (!(c.v > 0)) zeroVol++;
    if (i > 0) {
      const dt = c.t - candles[i - 1].t;
      if (dt <= 0) throw new Error(`${pair}: non-increasing t at ${i}`);
      if (dt > MS_H) gapHours.push({ at: new Date(c.t).toISOString(), skippedHours: dt / MS_H - 1 });
    }
  }
  return { badOHLC, zeroVol, gapHours };
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });
  log(`=== FX 1h fetch start (histdata tick feed, ${PAIRS.join('/')} x ${MONTHS.join('/')}) ===`);
  for (const pair of PAIRS) {
    log(`${pair}: downloading ${MONTHS.length} monthly tick packages ...`);
    for (const ym of MONTHS) await downloadTickCsv(pair, ym);
    const { candles, stats } = aggregatePair(pair);
    const v = validate(pair, candles);
    if (v.badOHLC > 0 || v.zeroVol > 0) throw new Error(`${pair}: validation failed ${JSON.stringify(v)}`);
    if (stats.backwardsJitterSkipped > 0) log(`${pair}: NOTE ${stats.backwardsJitterSkipped} backwards-jitter ticks skipped at hour boundaries (counted, never re-timed)`);
    const meta = {
      pair: `${pair.slice(0, 3)}/${pair.slice(3)}`,
      market: 'forex',
      source: 'histdata.com free tick feed (ASCII TICK, GMT)',
      aggregation: '1h OHLC from bid/ask mid; volume = tick count (tick-count proxy, NOT real traded volume)',
      interval: '1h',
      months: MONTHS,
      first: new Date(candles[0].t).toISOString(),
      last: new Date(candles[candles.length - 1].t).toISOString(),
      candles: candles.length,
      ticks: stats.ticks,
      duplicateTickTs: stats.dupTs,
      nonMonotonicTickTs: stats.nonMonotonic,
      backwardsJitterSkipped: stats.backwardsJitterSkipped,
      badOHLC: v.badOHLC,
      zeroVolumeCandles: v.zeroVol,
      gapHoursCount: v.gapHours.length,
      gapSample: v.gapHours.slice(0, 3),
      note: 'FX volume is a tick-count proxy (quote-update count), never real traded volume; weekends/holidays are absent hours, not fabricated candles',
    };
    const outPath = join(OUT_DIR, `${pair}_1h.json`);
    writeFileSync(outPath, JSON.stringify({ meta, candles }));
    log(`${pair}: ${candles.length} 1h candles, ${stats.ticks} ticks, ${v.gapHours.length} gaps -> ${outPath}`);
  }
  log('=== fetch complete ===');
}

main().catch((e) => { console.error('FETCH FAILED:', e); process.exit(1); });

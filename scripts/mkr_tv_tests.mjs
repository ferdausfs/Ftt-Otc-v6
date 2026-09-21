/**
 * Multi Kernel Regression — MODE 'tv' tests (the chart-default repaint
 * branch, ported exactly from the official ChartPrime source 2026-09-21).
 *
 * Covers the user-reported defect (Task 35): the bot was computing the
 * script's OTHER branch (non-repaint), producing flips at candles where the
 * user's TV chart shows none and missing the label TV does show. The tv
 * mode reproduces the chart: two-sided kernel fit over the newest 500
 * closed candles, "Up" at curve local minima, "Down" at local maxima,
 * each label knowable one candle after its bar (gateT), idempotent through
 * history dedup.
 *
 * Run: node scripts/mkr_tv_tests.mjs
 */

import {
  computeMkrTv, MKR_MODE_TV, kernelFn,
} from '../src/strategy/multiKernelRegression.mjs';
import { INDICATORS } from '../src/strategy/registry.mjs';
import { mkrEventToSignal } from '../src/strategy/multiKernelRegression.mjs';
import { pushSignalToSubscribers, formatMkrText } from '../src/handlers/push.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n' + name); }

const TF = 900_000; // 15min
function mkCandles(closes, t0 = 1_700_000_000_000) {
  return closes.map((c, i) => ({ t: t0 + i * TF, o: c, h: c, l: c, c }));
}

function rampCloses(n, from = 100, step = 0.5) {
  return Array.from({ length: n }, (_, i) => from + step * i);
}

section('T1 constant market — curve flat, zero labels');
{
  const s = computeMkrTv(mkCandles(Array(120).fill(50)), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  ok(s.mode === MKR_MODE_TV, "series.mode === 'tv'");
  ok(s.events.length === 0, 'flat series -> no events');
  ok(Math.abs(s.value[s.value.length - 1] - 50) < 1e-9, 'curve equals constant price');
}

section('T2 monotonic ramp — smooth curve, zero labels (no fabricated flips)');
{
  const s = computeMkrTv(mkCandles(rampCloses(300)), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  ok(s.events.length === 0, 'strictly rising market -> zero Up/Down labels');
  ok(s.lastDelta > 0, 'curve rising at the last bar');
}

section('T3 V-shape — exactly one Up at the valley, one candle delayed');
{
  const down = Array.from({ length: 200 }, (_, i) => 200 - 0.8 * i);   // 200 -> 41
  const up = Array.from({ length: 99 }, (_, i) => 41 + 0.9 * (i + 1));  // long rising leg
  const closes = down.concat(up);                                       // valley at idx 199
  const s = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  const ups = s.events.filter(e => e.type === 'up');
  const downs = s.events.filter(e => e.type === 'down');
  ok(ups.length === 1 && downs.length === 0, 'V-shape -> exactly one Up label, no Down');
  const valleyIdx = 199;
  ok(Math.abs(ups[0].i - valleyIdx) <= 3, 'label anchored at the valley bar (±3 smoothing bars), got idx ' + ups[0].i);
  ok(ups[0].gateT - ups[0].closeT === ups[0].offset * TF, 'label candle closes `offset` periods before detection close');
  ok(ups[0].closeT === mkCandles(closes)[ups[0].i].t + TF, 'closeT = label candle close');
}

section('T4 inverted-V — exactly one Down at the peak');
{
  const up = Array.from({ length: 200 }, (_, i) => 100 + 0.7 * i);
  const down = Array.from({ length: 99 }, (_, i) => 239.3 - 0.6 * (i + 1));
  const closes = up.concat(down);   // peak at idx 199
  const s = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  const downs = s.events.filter(e => e.type === 'down');
  ok(downs.length === 1 && s.events.length === 1, 'inverted-V -> exactly one Down label');
  ok(Math.abs(downs[0].i - 199) <= 3, 'Down anchored at the peak bar (±3), got idx ' + downs[0].i);
}

section('T5 timing — fresh extremum near the edge is detectable with its gate');
{
  const down = Array.from({ length: 250 }, (_, i) => 300 - 0.8 * i);
  const up = Array.from({ length: 30 }, (_, i) => 101 + 1.2 * (i + 1)); // valley 30 bars back
  const closes = down.concat(up);
  const s = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  const evs = s.events.filter(e => e.type === 'up');
  ok(evs.length >= 1, 'valley detected');
  ok(evs[0].gateT === mkCandles(closes)[closes.length - 1].t + TF, 'gateT = newest closed candle close');
  ok(evs[0].closeT === mkCandles(closes)[evs[0].i].t + TF, 'closeT anchors the label bar');
}

section('T6 fresh-deploy guard + emit window — no stale archaeology');
{
  // Valley 80 bars back + clear rise: live tick enumerates it (within the
  // 120-bar emit window); fresh deploy does not.
  const down = Array.from({ length: 210 }, (_, i) => 200 - 0.8 * i);
  const up = Array.from({ length: 80 }, (_, i) => 32 + 0.5 * i); // valley at idx 209 (80 bars back)
  const closes = down.concat(up);
  const fresh = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: true });
  ok(fresh.events.length === 0, 'fresh=true: old valley NOT backfilled');
  const live = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  ok(live.events.some(e => e.type === 'up' && Math.abs(e.i - 209) <= 6), 'fresh=false: recent chart label enumerated');
}
{
  // Valley 140 bars back (beyond the 120-bar emit window): never delivered,
  // even on a live tick — it is frozen chart history.
  const down = Array.from({ length: 150 }, (_, i) => 200 - 0.8 * i);
  const up = Array.from({ length: 140 }, (_, i) => 81 + 0.5 * i); // valley at idx 149 (offset 140)
  const closes = down.concat(up);
  const live = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  ok(live.events.length === 0, 'emit window: 140-bar-old extremum NOT delivered');
}

section('T7 closed-candle discipline — forming candle never enters the curve');
{
  const closes = rampCloses(300);
  const candles = mkCandles(closes);
  candles.push({ t: candles[candles.length - 1].t + TF, o: 1e9, h: 1e9, l: 1e9, c: 1e9 }); // forming outlier
  const s = computeMkrTv(candles, { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, lastClosed: candles.length - 2 });
  ok(s.lastValue < 1e6, 'forming outlier excluded from the fit (lastValue=' + s.lastValue.toFixed(2) + ')');
  const sAll = computeMkrTv(candles.slice(0, -1), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF });
  ok(Math.abs(s.lastValue - sAll.lastValue) < 1e-9, 'identical to computing without the forming candle');
}

section('T8 registry dispatch — default tv, nrp still available');
{
  const mkr = INDICATORS.find(i => i.id === 'mkr');
  ok(mkr.defaultCfg.mode === 'tv', 'registry defaultCfg.mode = tv (chart parity by default)');
  const candles = mkCandles(rampCloses(320));
  const sTv = mkr.compute(candles, { ...mkr.defaultCfg }, { tfMs: TF });
  ok(sTv.mode === 'tv', "registry compute -> mode 'tv' series");
  const sNrp = mkr.compute(candles, { ...mkr.defaultCfg, mode: 'nrp' }, { tfMs: TF });
  ok(sNrp.mode === undefined && Array.isArray(sNrp.events), "registry compute mode:'nrp' -> legacy engine");
  ok(Array.isArray(mkr.params.find(p => p.key === 'mode').options) && mkr.params.find(p => p.key === 'mode').options.length === 2,
    "bot UI gets a Mode enum (tv/nrp)");
}

section('T9 mkrEventToSignal — tv audit carries confirmedAt + mode');
{
  const ev = { i: 5, t: 1_700_000_400_000, closeT: 1_700_000_490_000, gateT: 1_700_000_580_000, type: 'up', price: 111.5, value: 111.2, valuePrev: 111.3, stdev: 0.4 };
  const sig = mkrEventToSignal(ev, 'SOL/USD', { mode: 'tv', kernel: 'Laplace', bandwidth: 14, timeframe: '15min', timestamp: '2026-09-20T10:45:00.000Z' });
  ok(sig.audit.mode === 'tv', 'audit.mode = tv');
  ok(sig.audit.confirmedAt === new Date(1_700_000_580_000).toISOString(), 'audit.confirmedAt = detection close (ISO)');
  ok(sig.finalSignal === 'BUY' && sig.audit.label === 'Up', 'CFD direction mapping unchanged');
}

section('T10 push locks — per-indicator independence (mkr Up never blocked by utbot BUY)');
{
  const origFetch = global.fetch;
  let sends = 0;
  global.fetch = async () => { sends++; return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); };
  const BOT_KV = {
    async get(key, type) {
      if (key === 'auto_users') return type === 'json' ? ['8429957782'] : JSON.stringify(['8429957782']);
      if (key === 'u:8429957782') return type === 'json' ? { autoEnabled: true } : JSON.stringify({ autoEnabled: true });
      return null;
    },
    async put() {},
  };
  const SIGNAL_CACHE = {
    store: new Map(),
    async get(k, t) { const v = this.store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { this.store.set(k, String(v)); },
  };
  const env = { BOT_KV, SIGNAL_CACHE, BOT_TOKEN: 'TEST:TOKEN' };
  const r1 = await pushSignalToSubscribers({ signalId: 's1', pair: 'SOL/USD', direction: 'BUY', lockTag: 'mkr', text: 'MKR UP' }, env);
  const r2 = await pushSignalToSubscribers({ signalId: 's2', pair: 'SOL/USD', direction: 'BUY', lockTag: 'utbot', text: 'UT BOT BUY' }, env);
  const r3 = await pushSignalToSubscribers({ signalId: 's3', pair: 'SOL/USD', direction: 'BUY', lockTag: 'mkr', text: 'MKR UP dup' }, env);
  ok(r1.sent === 1 && r2.sent === 1, 'both indicators delivered despite same pair+direction');
  ok(r3.sent === 0, 'same indicator+direction still locked (idempotent)');
  ok(sends === 2, 'exactly two Telegram sends');
  global.fetch = origFetch;
}

section('T11 premium message — tv mode shows label candle + confirmation');
{
  const sig = {
    pair: 'SOL/USD', timeframe: '15min',
    entryPrice: 111.65, entryTime: '2026-09-20T10:45:00.000Z',
    audit: { event: 'up', mode: 'tv', kernel: 'Laplace', bandwidth: 14, value: 111.2, confirmedAt: '2026-09-20T11:00:00.000Z' },
  };
  const t = formatMkrText(sig);
  ok(t.includes('📍 Signal candle: 2026-09-20 10:45 UTC'), 'label candle line (what TV anchors)');
  ok(t.includes('☑️ Confirmed at close: 2026-09-20 11:00 UTC'), 'confirmation close line');
  ok(t.includes('📈 <b>UP</b>') && t.includes('Multi Kernel Regression'.toUpperCase()), 'bold indicator + UP');
  const nrpSig = { ...sig, audit: { ...sig.audit, mode: 'nrp', confirmedAt: undefined } };
  const tNrp = formatMkrText(nrpSig);
  ok(tNrp.includes('⏰ Candle closed: 2026-09-20 10:45 UTC') && !tNrp.includes('Confirmed'), 'nrp mode keeps the old candle line');
}

section('T12 kernel weight sanity — Laplace symmetric (script kernel(diff, bandwidth))');
{
  const f = kernelFn('Laplace');
  ok(Math.abs(f(-3, 14) - f(3, 14)) < 1e-15, 'w(-d) === w(d) for Laplace');
  ok(Math.abs(f(0, 14) - 1 / 28) < 1e-15, 'w(0) = 1/(2*bw)');
}

console.log('\n══════════════════════════════');
console.log('mkr_tv_tests: ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════');
process.exitCode = fail ? 1 : 0;

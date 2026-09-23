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
 * Emission rule (stale-alert fix, 2026-09-21): tv mode is REPAINTING, so a
 * normal tick may deliver ONLY the newest knowable label (offset 1).
 * Older offsets are emittable solely through the proven-downtime catch-up
 * window (lastScanT vs now, hard cap 4 candles). T5 pins the regression
 * (an extremum that first becomes true at offset > 1 during normal
 * operation must NOT be emitted — the old 120-candle window delivered an
 * 18h45m-old extremum as "fresh"); T6 pins the downtime window.
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
const T0 = 1_700_000_000_000;
function mkCandles(closes, t0 = T0) {
  return closes.map((c, i) => ({ t: t0 + i * TF, o: c, h: c, l: c, c }));
}

function rampCloses(n, from = 100, step = 0.5) {
  return Array.from({ length: n }, (_, i) => from + step * i);
}

// gateT of a fixture = close of its newest candle (computeMkrTv anchors
// every event's detection close there).
function gateTOf(closes) { return T0 + closes.length * TF; }

// Scan-tick meta against a specific fixture: missed = how many candle
// closes the scanner provably skipped (0 = routine tick, no backfill).
function metaFor(closes, missed = 0, extra = {}) {
  const gateT = gateTOf(closes);
  return { tfMs: TF, fresh: false, now: gateT + 5_000, lastScanT: gateT - (missed + 1) * TF, ...extra };
}

// Short sharp V fixtures (probe-verified label offsets, Laplace bw=14):
function vUpFixture() {   // valley 5 bars from the edge -> Up label at offset 1
  const down = Array.from({ length: 250 }, (_, i) => 300 - 0.8 * i);
  const valley = 300 - 0.8 * 249;
  const up = Array.from({ length: 5 }, (_, i) => valley + 2 * (i + 1));
  return down.concat(up);
}
function vDownFixture() {  // peak 2 bars from the edge -> Down label at offset 1
  const up = Array.from({ length: 250 }, (_, i) => 100 + 0.7 * i);
  const peak = 100 + 0.7 * 249;
  const down = Array.from({ length: 2 }, (_, i) => peak - 5 * (i + 1));
  return up.concat(down);
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

section('T3 V-shape — one Up at offset 1 (the live "just printed" label)');
{
  // Sharp reversal 5 bars from the edge: the smoothed curve bottoms at the
  // second-newest bar, so the label is knowable at the very next close —
  // exactly what a live TV chart shows as freshly printed. (Short fixture
  // because the emission rule only ever surfaces offset 1 in normal
  // operation; the smoothing lag between the raw-price valley and the
  // curve minimum is ~4 bars on a 5-bar leg.)
  const closes = vUpFixture();
  const s = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  const ups = s.events.filter(e => e.type === 'up');
  const downs = s.events.filter(e => e.type === 'down');
  ok(ups.length === 1 && downs.length === 0, 'sharp V -> exactly one Up label, no Down');
  ok(ups[0].offset === 1, 'label offset = 1 (newest knowable), got ' + ups[0].offset);
  ok(Math.abs(ups[0].i - 249) <= 5, 'label anchored at the valley bar (±5 smoothing lag), got idx ' + ups[0].i);
  ok(ups[0].gateT - ups[0].closeT === ups[0].offset * TF, 'label candle closes `offset` periods before detection close');
  ok(ups[0].closeT === mkCandles(closes)[ups[0].i].t + TF, 'closeT = label candle close');
  ok(ups[0].gateT === gateTOf(closes), 'gateT = newest closed candle close (detection boundary)');
}

section('T4 inverted-V — one Down at offset 1');
{
  const closes = vDownFixture();
  const s = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  const downs = s.events.filter(e => e.type === 'down');
  ok(downs.length === 1 && s.events.length === 1, 'sharp inverted-V -> exactly one Down label');
  ok(downs[0].offset === 1, 'label offset = 1 (newest knowable), got ' + downs[0].offset);
  ok(Math.abs(downs[0].i - 249) <= 5, 'Down anchored at the peak bar (±5), got idx ' + downs[0].i);
  ok(downs[0].gateT === gateTOf(closes), 'gateT = newest closed candle close');
}

section('T5 THE BUG REGRESSION — extremum first-true at offset > 1 in normal operation is NEVER emitted');
{
  // The reported defect: a valley whose sign-flip condition first becomes
  // satisfiable ~80 closed candles back (20h on 15min) was delivered as a
  // "fresh" alert with confirmedAt = the current tick — an 18h45m gap.
  // Normal operation (routine tick, no missed scans) must emit NOTHING:
  // the two-sided fit reshapes old offsets every bar, so those extremums
  // are chart history resurfacing, not live events.
  const down = Array.from({ length: 210 }, (_, i) => 200 - 0.8 * i);
  const up = Array.from({ length: 80 }, (_, i) => 32 + 0.5 * i); // valley ~80 bars back
  const closes = down.concat(up);

  // (a) plain live tick, no downtime meta at all (old T6 shape)
  const live = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  ok(live.events.length === 0, 'offset-80 valley + no-proof meta -> zero events (was: emitted)');

  // (b) routine tick WITH explicit proof meta: now/lastScanT one period apart
  const tick = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, metaFor(closes, 0));
  ok(tick.events.length === 0, 'offset-80 valley + normal-tick proof (0 missed) -> zero events');

  // (c) same for a ~30-bar valley (old T5 fixture shape)
  const down2 = Array.from({ length: 250 }, (_, i) => 300 - 0.8 * i);
  const up2 = Array.from({ length: 30 }, (_, i) => 101 + 1.2 * (i + 1));
  const closes2 = down2.concat(up2);
  const tick2 = computeMkrTv(mkCandles(closes2), { kernel: 'Laplace', bandwidth: 14 }, metaFor(closes2, 0));
  ok(tick2.events.length === 0, 'offset-30 valley + normal-tick proof -> zero events');

  // (d) frozen archaeology stays frozen even under the maximum downtime window
  const down3 = Array.from({ length: 150 }, (_, i) => 200 - 0.8 * i);
  const up3 = Array.from({ length: 140 }, (_, i) => 81 + 0.5 * i); // valley ~140 bars back
  const closes3 = down3.concat(up3);
  const outage = computeMkrTv(mkCandles(closes3), { kernel: 'Laplace', bandwidth: 14 }, metaFor(closes3, 10));
  ok(outage.events.length === 0, 'offset-140 valley + 10 missed ticks -> STILL zero events (beyond cap)');

  // (e) fresh deploy never backfills either
  const fresh = computeMkrTv(mkCandles(closes), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: true });
  ok(fresh.events.length === 0, 'fresh=true: old valley NOT backfilled');
}

section('T6 downtime catch-up — backfill ONLY for proven missed ticks, hard cap 4');
{
  // down-label aging: peak 4 bars from the edge -> Down label at offset 2.
  const peakUp = Array.from({ length: 250 }, (_, i) => 100 + 0.7 * i);
  const peak = 100 + 0.7 * 249;
  const off2 = peakUp.concat(Array.from({ length: 4 }, (_, i) => peak - 3 * (i + 1)));

  // (a) scanner missed 1 tick (lastScanT two periods behind): label knowable
  // during the outage is still fresh enough -> emitted.
  const caught = computeMkrTv(mkCandles(off2), { kernel: 'Laplace', bandwidth: 14 }, metaFor(off2, 1));
  ok(caught.events.length === 1 && caught.events[0].type === 'down' && caught.events[0].offset === 2,
    'missed=1: offset-2 Down delivered (catch-up)');

  // (b) THE SAME fixture on a routine tick: NOT emitted. The window opens
  // for downtime only, never on every tick.
  const routine = computeMkrTv(mkCandles(off2), { kernel: 'Laplace', bandwidth: 14 }, metaFor(off2, 0));
  ok(routine.events.length === 0, 'missed=0 (routine tick): offset-2 Down NOT delivered');

  // (c) manual poll mid-candle: elapsed < 1 period -> no downtime proof.
  const midGate = gateTOf(off2);
  const mid = computeMkrTv(mkCandles(off2), { kernel: 'Laplace', bandwidth: 14 },
    { tfMs: TF, fresh: false, now: midGate - 0.5 * TF, lastScanT: midGate - TF });
  ok(mid.events.length === 0, 'mid-candle manual poll: no backfill');

  // (d) no-proof meta (caller cannot compare lastScanT to now): fail closed.
  const noProof = computeMkrTv(mkCandles(off2), { kernel: 'Laplace', bandwidth: 14 }, { tfMs: TF, fresh: false });
  ok(noProof.events.length === 0, 'missing now/lastScanT: fail closed, no backfill');

  // (e) fresh deploy beats a stale-looking cursor: newest label only.
  const freshWins = computeMkrTv(mkCandles(off2), { kernel: 'Laplace', bandwidth: 14 }, metaFor(off2, 1, { fresh: true }));
  ok(freshWins.events.length === 0, 'fresh=true wins over stale lastScanT: no backfill');

  // (f) up-label at offset 4 = exactly the hard cap: delivered at missed=3.
  const vDown = Array.from({ length: 250 }, (_, i) => 300 - 0.8 * i);
  const valley = 300 - 0.8 * 249;
  const off4 = vDown.concat(Array.from({ length: 4 }, (_, i) => valley + 5 * (i + 1)));
  const atCap = computeMkrTv(mkCandles(off4), { kernel: 'Laplace', bandwidth: 14 }, metaFor(off4, 3));
  ok(atCap.events.length === 1 && atCap.events[0].type === 'up' && atCap.events[0].offset === 4,
    'missed=3: offset-4 Up delivered (exactly at the cap)');

  // (g) offset 5 is beyond the cap even with a huge outage: never delivered.
  const off5 = vDown.concat(Array.from({ length: 4 }, (_, i) => valley + 8 * (i + 1)));
  const beyond = computeMkrTv(mkCandles(off5), { kernel: 'Laplace', bandwidth: 14 }, metaFor(off5, 10));
  ok(beyond.events.length === 0, 'missed=10: offset-5 Up NOT delivered (hard cap 4, not 1+missed)');
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

section('T8 registry dispatch — default nrp (causal), tv opt-in');
{
  const mkr = INDICATORS.find(i => i.id === 'mkr');
  ok(mkr.defaultCfg.mode === 'nrp', 'registry defaultCfg.mode = nrp (causal production default since v1.9.0)');
  const candles = mkCandles(rampCloses(320));
  const sNrp = mkr.compute(candles, { ...mkr.defaultCfg }, { tfMs: TF });
  ok(sNrp.mode === undefined && Array.isArray(sNrp.events), "registry default compute -> causal nrp engine");
  const sTv = mkr.compute(candles, { ...mkr.defaultCfg, mode: 'tv' }, { tfMs: TF });
  ok(sTv.mode === 'tv', "registry compute mode:'tv' -> repaint branch (opt-in)");
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

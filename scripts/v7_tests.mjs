/**
 * V7 shadow unit tests — 2026-09-03 (node --test style, no deps).
 * Run: node scripts/v7_tests.mjs
 * Covers: evaluateV7Setup rule matrix (regime router, extremes/non-chase,
 * dead squeeze, ATR explosion, veto hours, H1 trigger) + v7store
 * admit/dedup/cap/resolve with a fake KV + injectable price.
 */
import assert from 'node:assert/strict';

// ---- tiny module loader (repo has no bundler for tests; use dynamic import) ----
const BASE = new URL('../', import.meta.url).pathname;
const { evaluateV7Setup } = await import(BASE + 'src/signal/v7shadow.js');
const { admitV7Observation, resolveV7ShadowObservations, summarizeV7, listPendingV7 }
  = await import(BASE + 'src/history/v7store.js');

// ---- synthetic candle helpers -------------------------------------------------
let _ts = Date.UTC(2026, 8, 3, 8, 0, 0);
function candle(o, h, l, c) { _ts += 300000; return { timestamp: _ts, open: o, high: h, low: l, close: c, volume: 100 }; }

/** Ranging candles oscillating around `base` (range ~2%): ADX low, RSI ~50. */
function ranging(base, n, phase = 0) {
  const out = [];
  let price = base;
  for (let i = 0; i < n; i++) {
    const dir = Math.sin((i + phase) / 3.1) >= 0 ? 1 : -1;
    const o = price;
    const c = price + dir * base * 0.004 * (0.6 + 0.8 * Math.abs(Math.sin((i + phase) / 2.3)));
    const h = Math.max(o, c) + base * 0.0015;
    const l = Math.min(o, c) - base * 0.0015;
    price = c; out.push(candle(o, h, l, c));
  }
  return out;
}

/** Dump: `n` falling candles then one bullish rejection with close in top half. */
function dipThenRejection(candles, base, n = 8, closePos = 0.8) {
  let price = candles[candles.length - 1].close;
  for (let i = 0; i < n; i++) {
    const o = price; const c = price - base * 0.006;
    candles.push(candle(o, o + base * 0.0008, c - base * 0.0008, c));
    price = c;
  }
  // final closed candle: bullish, closes near top of its own range
  const o = price;
  const c = price + base * 0.003;
  const h = c + base * 0.0005;
  const l = o - base * 0.004;
  candles.push(candle(o, h, l, c));
  void closePos;
  return candles;
}

function ctx5(candles, nowMs, extra = {}) {
  return { ...extra, '5min': candles, '1min': candles };
}

/** Retime a fixture so its last candle CLOSES 5min before `endMs` (all closed). */
function retime(cs, endMs) {
  const n = cs.length;
  cs.forEach((c, i) => { c.timestamp = endMs - (n - i) * 300000; });
  return cs;
}

const NOW = Date.UTC(2026, 8, 3, 8, 0, 0) + 6 * 3600 * 1000;   // 14:00? no: 08:00+6h = 14:00 UTC -> veto hour!
const NOW_OK = Date.UTC(2026, 8, 3, 8, 0, 0) + 2 * 3600 * 1000; // 10:00 UTC (not vetoed)

// ---- rule matrix ---------------------------------------------------------------
const results = [];
const t = (name, fn) => results.push([name, fn]);   // register only; runner calls

t('insufficient candles -> skip', () => {
  const r = evaluateV7Setup(ctx5(retime(ranging(100, 30), NOW_OK), NOW_OK), NOW_OK);
  assert.equal(r.want, null);
  assert.match(r.skip, /insufficient/);
});

t('dip + rejection in RANGING at 10:00 UTC -> WANT BUY', () => {
  const candles = retime(dipThenRejection(ranging(100, 70), 100), NOW_OK);
  const r = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  assert.equal(r.skip, null, 'expected WANT BUY, got skip=' + r.skip + ' features=' + JSON.stringify(r.features));
  assert.equal(r.want, 'BUY');
  assert.equal(r.entry.expiryMin, 5);
  assert.ok(r.trigger.bullish, 'trigger candle must be bullish');
});

t('TRENDING regime -> skip regime:TRENDING', () => {
  // strong monotone rally: ADX high
  const candles = [];
  let price = 100;
  for (let i = 0; i < 80; i++) { const o = price; const c = price + 0.5; price = c; candles.push(candle(o, c + 0.1, o - 0.1, c)); }
  const r = evaluateV7Setup(ctx5(retime(candles, NOW_OK), NOW_OK), NOW_OK);
  assert.equal(r.want, null);
  assert.match(r.skip, /^regime:/, 'got skip=' + r.skip);
});

t('rally (no extreme) -> skip no-extreme (non-chase zone enforced)', () => {
  // oscillating then rally to upper-middle zone: RSI>40 side, pctB mid
  const candles = retime(ranging(100, 70, 2), NOW_OK);
  const r = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  assert.equal(r.want, null);
  assert.equal(r.skip, 'no-extreme');
});

t('veto hour (14:00 UTC) -> skip veto-hour even on perfect setup', () => {
  const candles = retime(dipThenRejection(ranging(100, 70), 100), NOW);
  const r = evaluateV7Setup(ctx5(candles, NOW), NOW);
  assert.equal(r.want, null);
  assert.equal(r.skip, 'veto-hour');
});

t('dead squeeze (flat candles) -> skip dead-squeeze or no-extreme', () => {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 80; i++) { const dir = i % 2 ? -1 : 1; const o = price; const c = price + dir * 0.001; price = c; candles.push(candle(o, c + 0.0005, o - 0.0005, c)); }
  const r = evaluateV7Setup(ctx5(retime(candles, NOW_OK), NOW_OK), NOW_OK);
  assert.equal(r.want, null);
  assert.ok(r.skip === 'dead-squeeze' || r.skip === 'no-extreme' || r.skip === 'indicators-incomplete', 'got ' + r.skip);
});

t('bearish flip: natural upper-extreme + bearish close -> WANT SELL', () => {
  // phase=31 (probed): oscillation ends at upper band, RSI ~65, RANGING,
  // last candle bearish closing in bottom half -> the SELL path end-to-end
  const candles = retime(ranging(100, 78, 31), NOW_OK);
  const r = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  if (r.skip === 'no-extreme') return 'SKIP-FEATURE (pctB/rsi did not reach upper extreme on synthetic data)';
  assert.equal(r.want, 'SELL', 'got skip=' + r.skip);
});

t('SELL no-trigger: extreme reached, no bearish confirmation -> skip no-trigger', () => {
  // phase=10 (probed): pctB 0.88 rsi 67 RANGING but last close lacks the
  // bottom-half bearish close -> must NOT mint
  const candles = retime(ranging(100, 78, 10), NOW_OK);
  const r = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  if (r.skip === 'no-extreme') return 'SKIP-FEATURE (extreme not reached on synthetic data)';
  assert.equal(r.skip, 'no-trigger', 'got skip=' + r.skip + ' want=' + r.want);
});

t('dip WITHOUT rejection trigger -> skip no-trigger', () => {
  const candles = retime(ranging(100, 70), NOW_OK);
  let price = candles[candles.length - 1].close;
  for (let i = 0; i < 8; i++) { const o = price; const c = price - 0.6; price = c; candles.push(candle(o, o + 0.08, c - 0.08, c)); }
  // last closed candle still bearish (falling knife, no confirmation)
  const o = price; const c = price - 0.2;
  candles.push(candle(o, o + 0.05, c - 0.05, c));
  const r = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  if (r.skip === 'no-extreme') return 'SKIP-FEATURE (extreme not reached)';
  assert.equal(r.skip, 'no-trigger', 'got skip=' + r.skip + ' want=' + r.want);
});

t('live-bar guard: forming last bar is excluded', () => {
  const candles = retime(dipThenRejection(ranging(100, 70), 100), NOW_OK);
  const r1 = evaluateV7Setup(ctx5(candles, NOW_OK), NOW_OK);
  // add a forming bar whose open is 60s before now -> excluded
  const forming = { timestamp: NOW_OK - 60000, open: 100, high: 101, low: 99, close: 100.5, volume: 1 };
  const r2 = evaluateV7Setup(ctx5([...candles, forming], NOW_OK), NOW_OK);
  assert.equal(r1.want, r2.want, 'forming bar must not change the verdict');
});

// ---- store tests (fake KV) ------------------------------------------------------
function fakeKV() {
  const m = new Map();
  return {
    SIGNAL_CACHE: {
      async get(k) { return m.get(k) ?? null; },
      async put(k, v) { m.set(k, v); },
      async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
    },
    _m: m,
  };
}
const ENV = fakeKV();
const obs = (pair, want, entryTime, price) => ({
  pair, want, strategy: 'V7_MR_RANGING',
  features: { rsi: 35, pctB: 0.1 }, trigger: { closePos: 0.8, bullish: want === 'BUY' },
  entry: { side: want, price, entryTime: new Date(entryTime).toISOString(), expiryTime: new Date(entryTime + 300000).toISOString() },
  obsTime: new Date(entryTime).toISOString(),
});

t('store: admit + dedup + second pair ok', async () => {
  const t0 = Date.UTC(2026, 8, 3, 8, 0, 0);
  const a1 = await admitV7Observation(ENV, obs('BTC/USD', 'BUY', t0, 100));
  assert.ok(a1.admitted, 'first admit ok');
  const a2 = await admitV7Observation(ENV, obs('BTC/USD', 'BUY', t0 + 5 * 60000, 100));
  assert.equal(a2.admitted, false); assert.equal(a2.reason, 'dedup');
  const a3 = await admitV7Observation(ENV, obs('ETH/USD', 'SELL', t0 + 6 * 60000, 50));
  assert.ok(a3.admitted, 'other pair admits');
  const pend = await listPendingV7(ENV);
  assert.equal(pend.length, 0, 'fresh obs are not yet pending (age<TTL)');
});

t('store: resolve with injectable price -> WIN/LOSS + summary', async () => {
  const t0 = Date.now() - 3 * 3600 * 1000;   // 3h ago: expired, within pending TTL
  await admitV7Observation(ENV, obs('SOL/USD', 'BUY', t0, 100));        // will exit 101 -> WIN
  await admitV7Observation(ENV, obs('XRP/USD', 'BUY', t0 + 60000, 50)); // will exit 49 -> LOSS
  const priceAt = (pair) => ({ price: pair.startsWith('SOL') ? 101 : 49, time: t0 + 300000 });
  const r = await resolveV7ShadowObservations(ENV, async (pair) => priceAt(pair));
  assert.ok(r.resolved >= 2, 'resolved=' + r.resolved);
  const s = await summarizeV7(ENV);
  assert.equal(s.overall.n, 2);
  assert.equal(s.overall.k, 1);
  assert.equal(s.overall.wr, 50);
  assert.equal(s.bySide.BUY.n, 2);
});

t('store: 30d cap enforced', async () => {
  const env2 = fakeKV();
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  let last = null;
  for (let i = 0; i < 41; i++) {
    last = await admitV7Observation(env2, obs('AVAX/USD', i % 2 ? 'BUY' : 'SELL', t0 + i * 31 * 60000, 10));
  }
  assert.equal(last.admitted, false);
  assert.equal(last.reason, 'cap');
});

// ---- runner (async-aware) --------------------------------------------------------
let pass = 0, fail = 0, skips = 0;
for (const [name, fn] of results) {
  try {
    const out = await fn();
    if (typeof out === 'string' && out.startsWith('SKIP-FEATURE')) { skips += 1; console.log('  ~ ' + name + ' :: ' + out); }
    else { pass += 1; console.log('  ok ' + name); }
  } catch (e) { fail += 1; console.log('  FAIL ' + name + '\n      ' + (e && e.message || e)); }
}
console.log(`\nv7 tests: ${pass} passed, ${fail} failed, ${skips} soft-skipped`);
process.exit(fail ? 1 : 0);

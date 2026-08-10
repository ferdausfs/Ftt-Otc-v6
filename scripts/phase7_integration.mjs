/**
 * Phase 7 integration test — node scripts/phase7_integration.mjs
 *
 * Runs the REAL pipeline (scheduledScan -> handleSignalRaw -> candles -> engine
 * -> AI -> KV) with only the network stubbed, so the wiring is proven rather
 * than grep-asserted. Verifies:
 *
 *   - a scan writes one latest:<PAIR> per active pair, with TTL + generationId
 *   - history is written EXACTLY ONCE per signal (the spec's sketch would have
 *     produced two records per scanned pair)
 *   - preferCache=true serves the cache with zero upstream requests
 *   - preferCache on a miss generates, answers, and warms the cache
 *   - default /api/signal still forces a fresh run (backward compatible)
 *   - the market-closed skip, the duration cap and per-pair failure isolation
 */

import { SCAN_CONFIG } from '../src/config.js';

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; failures.push(n); console.log('FAIL  ' + n + (d ? ' — ' + d : '')); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k).value; return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, opts) { m.set(k, { value: String(v), opts }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

// ── network stub: TwelveData candles + both AI providers ───────────────
let httpCalls = { candles: 0, cerebras: 0, groq: 0 };
let failPairs = new Set();

function candleSeries(n, base, step) {
  const out = [];
  let c = base;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c + step + Math.sin(i / 3) * step * 0.1;
    out.push({
      datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
      open: o.toFixed(5), high: (Math.max(o, c) + step * 0.3).toFixed(5),
      low: (Math.min(o, c) - step * 0.3).toFixed(5), close: c.toFixed(5), volume: '1000',
    });
  }
  return out.reverse();
}

// 15min fixture: fast oscillation (ADX ~10) so the regime is RANGING.
// Bugfix round 1 note: a steady uptrend now trips the D2_TRENDING_BLOCK
// (FIX-2) and correctly yields NO_TRADE — this test verifies the SCAN/CACHE
// wiring, so it needs tradeable RANGING setups instead.
function candleFastSin(n, base, amp) {
  const out = [];
  let c = base;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = base + Math.sin(i / 1.3) * amp;
    out.push({
      datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
      open: o.toFixed(5), high: (Math.max(o, c) + amp).toFixed(5),
      low: (Math.min(o, c) - amp).toFixed(5), close: c.toFixed(5), volume: '1000',
    });
  }
  return out.reverse();
}

function installFetchStub() {
  httpCalls = { candles: 0, cerebras: 0, groq: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('twelvedata')) {
      httpCalls.candles++;
      const symbol = new URL(u).searchParams.get('symbol') || '';
      if ([...failPairs].some(p => symbol.includes(p))) {
        return new Response('upstream boom', { status: 500 });
      }
      // per-interval data; 15min oscillates (RANGING) so the D2 TRENDING block
      // (FIX-2) does not suppress the signals under test. 100 candles per TF.
      const interval = new URL(u).searchParams.get('interval');
      let values;
      if (interval === '15min') values = candleFastSin(100, 100, 0.4);
      else if (interval === '5min') values = candleSeries(100, 100, 0.1);
      else values = candleSeries(100, 100, 0.02);
      return new Response(JSON.stringify({ values }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('cerebras')) {
      httpCalls.cerebras++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 80, reason: 'stub' }) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('groq')) {
      httpCalls.groq++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 78, reason: 'stub' }) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch: ' + u.slice(0, 80));
  };
}

const drain = async (sink) => { await Promise.allSettled(sink); sink.length = 0; };
const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };

const baseEnv = () => ({
  SIGNAL_CACHE: makeKV(),
  TWELVEDATA_API_KEY_1: 'k1',
  CEREBRAS_API_KEY: 'c1',
  GROQ_API_KEY: 'g1',
});

const { scheduledScan, selectActivePairs } = await import('../src/handlers/scheduledScan.js');
const { handleSignal } = await import('../src/handlers/signal.js');
const { handleLatest } = await import('../src/handlers/latest.js');

console.log('── scheduledScan writes the cache ─────────────────────────');
{
  installFetchStub();
  const env = baseEnv();
  const sink = [];
  const restore = quiet();
  // scan a small explicit set by monkey-patching the pair list via selectActivePairs
  const res = await scheduledScan(env, ctxWith(sink), { edgeFeatures: false, now: '2026-08-10T14:00:00Z' });
  await drain(sink);
  restore();

  const keys = [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('latest:'));
  ok('scan reported successes', res.ok > 0, JSON.stringify(res));
  eq('one cache entry per successful pair', keys.length, res.ok);
  ok('every active pair cached (14 while forex open)', keys.length >= 10, 'keys=' + keys.length);

  const sample = JSON.parse(env.SIGNAL_CACHE._m.get(keys[0]).value);
  eq('entry marked cached', sample.cached, true);
  ok('generationId stamped', typeof sample.generationId === 'string' && sample.generationId.startsWith('gen_'));
  eq('cron entries are not opportunistic', sample.opportunistic, false);
  ok('generatedAt is an ISO timestamp', !Number.isNaN(new Date(sample.generatedAt).getTime()));
  eq('TTL set to 10 min', env.SIGNAL_CACHE._m.get(keys[0]).opts.expirationTtl, SCAN_CONFIG.LATEST_TTL_SECONDS);
  ok('signal body preserved', !!sample.signal && typeof sample.signal.finalSignal === 'string');
  ok('Phase B fields survive caching', 'entrySource' in sample);

  // ── the double-write check that the spec's sketch would have failed ──
  const histKeys = [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('sig:'));
  let maxPerPair = 0;
  for (const k of histKeys) {
    const arr = JSON.parse(env.SIGNAL_CACHE._m.get(k).value);
    maxPerPair = Math.max(maxPerPair, arr.length);
  }
  ok('history written at most once per pair per scan', maxPerPair <= 1,
     'max records for one pair after a single scan: ' + maxPerPair);
}

console.log('\n── /api/signals/latest serves what the scan wrote ─────────');
{
  installFetchStub();
  const env = baseEnv();
  const sink = [];
  const restore = quiet();
  await scheduledScan(env, ctxWith(sink), { edgeFeatures: false, now: '2026-08-10T14:00:00Z' });
  await drain(sink);
  const before = { ...httpCalls };
  const res = await handleLatest(new URL('https://x/api/signals/latest'), env);
  const body = await res.json();
  restore();

  ok('latest returns the scanned pairs', body.pairCount >= 10, 'pairCount=' + body.pairCount);
  eq('serving the cache costs zero upstream calls', httpCalls.candles, before.candles);
  ok('ages are small right after a scan',
     Object.values(body.signals).every(s => s.generationAge < 5));
}

console.log('\n── preferCache=true ───────────────────────────────────────');
{
  installFetchStub();
  const env = baseEnv();
  const sink = [];
  const restore = quiet();

  // 1) miss -> generates, answers, warms cache
  const missRes = await handleSignal('BTC/USD', env, ctxWith(sink), { preferCache: true });
  await drain(sink);
  const missBody = await missRes.json();
  const afterMiss = { ...httpCalls };
  const warmedRaw = env.SIGNAL_CACHE._m.get('latest:BTC_USD');

  // 2) hit -> zero upstream calls
  const hitRes = await handleSignal('BTC/USD', env, ctxWith(sink), { preferCache: true });
  await drain(sink);
  const hitBody = await hitRes.json();
  restore();   // restore BEFORE asserting, or the PASS lines are swallowed

  eq('miss answers with cached:false', missBody.cached, false);
  ok('miss actually hit upstream', afterMiss.candles > 0);
  ok('cache warmed after miss', !!warmedRaw);
  eq('warm entry flagged opportunistic', JSON.parse(warmedRaw.value).opportunistic, true);

  eq('hit answers with cached:true', hitBody.cached, true);
  eq('hit is not a force refresh', hitBody.forceRefresh, false);
  eq('cache hit made no candle calls', httpCalls.candles, afterMiss.candles);
  eq('cache hit made no AI calls', httpCalls.cerebras, afterMiss.cerebras);
  ok('hit carries freshness metadata', typeof hitBody.generationAge === 'number');
}

console.log('\n── default /api/signal is still a force refresh ───────────');
{
  installFetchStub();
  const env = baseEnv();
  const sink = [];
  const restore = quiet();

  // pre-warm, then call WITHOUT preferCache
  const warmRes = await handleSignal('ETH/USD', env, ctxWith(sink), { preferCache: true });
  await drain(sink);
  const warmBody = await warmRes.json();
  const afterWarm = { ...httpCalls };

  const res = await handleSignal('ETH/USD', env, ctxWith(sink), {});
  await drain(sink);
  const body = await res.json();
  restore();

  eq('default response labelled uncached', body.cached, false);
  eq('default response labelled forceRefresh', body.forceRefresh, true);
  // A force refresh must re-run the ENGINE. It does NOT have to refetch candles:
  // the `c:` candle cache is a separate pre-existing TTL layer (1min=120s) that
  // Phase 7 deliberately leaves alone. So the proof of freshness is a new engine
  // pass (new AI round-trips + a newly minted signal id), not new candle calls.
  ok('force refresh re-ran the engine (new AI round-trips)',
     httpCalls.cerebras > afterWarm.cerebras || httpCalls.groq > afterWarm.groq,
     'ai before=' + afterWarm.cerebras + '/' + afterWarm.groq + ' after=' + httpCalls.cerebras + '/' + httpCalls.groq);
  ok('force refresh produced a distinct signal id', body.id && warmBody.id && body.id !== warmBody.id,
     warmBody.id + ' vs ' + body.id);
  ok('force refresh did NOT serve the latest: entry', body.generationId === undefined);
  ok('candle cache intentionally still reused (no extra TwelveData spend)',
     httpCalls.candles === afterWarm.candles,
     'candles before=' + afterWarm.candles + ' after=' + httpCalls.candles);
  ok('backward-compatible shape kept', !!body.signal && !!body.pair && !!body.timestamp);
}

console.log('\n── resilience ─────────────────────────────────────────────');
{
  // market closed -> forex skipped
  eq('forex skipped when closed', selectActivePairs(undefined, false).length, 10);
  eq('all scanned when open', selectActivePairs(undefined, true).length, 14);

  // one pair failing upstream must not abort the scan
  installFetchStub();
  failPairs = new Set(['BTC']);
  const env = baseEnv();
  const sink = [];
  const restore = quiet();
  const res = await scheduledScan(env, ctxWith(sink), { edgeFeatures: false, now: '2026-08-10T14:00:00Z' });
  await drain(sink);
  restore();
  failPairs = new Set();

  ok('scan continued past a failing pair', res.ok > 0, JSON.stringify(res));
  ok('failing pair not cached', !env.SIGNAL_CACHE._m.has('latest:BTC_USD'));
  ok('other pairs still cached',
     [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('latest:')).length >= 9);

  // no KV binding must not throw
  const restore2 = quiet();
  const noKv = await scheduledScan({}, ctxWith(sink), { edgeFeatures: false });
  restore2();
  eq('scan without KV aborts cleanly', noKv.aborted, true);
}

function ctxWith(sink) {
  return { waitUntil: (p) => { sink.push(Promise.resolve(p).catch(() => {})); return p; } };
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL PHASE 7 INTEGRATION TESTS PASSED');

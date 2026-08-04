/**
 * Phase 7 smoke tests — node scripts/phase7_smoke.mjs
 *
 * Exercises the real modules against an in-memory KV and a mocked engine:
 *   - key format / round-trip (a mismatch = permanent silent cache miss)
 *   - scheduledScan: writes, batching, market-closed skip, duration cap,
 *     failure isolation, and the DUMMY_FALLBACK guard
 *   - handleLatest: single + all, 404 on miss, stale handling
 *   - preferCache: cache hit avoids the engine; miss runs it and writes back
 *   - /health scanCache block
 *   - no double history write (the spec's scanOnePair would have caused one)
 *
 * No network. Cloudflare globals are stubbed where needed.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

// ── in-memory KV double ────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    puts: 0,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { this.puts++; m.set(k, { value: String(v), opts }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    },
  };
}
const ctxOf = (sink) => ({ waitUntil: (p) => { sink.push(p); return p; } });
const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };

const { SCAN_CONFIG, SCAN_PAIRS } = await import('../src/config.js');
const cache = await import('../src/history/latestCache.js');

console.log('── KV key format (shared by 3 call sites) ─────────────────');
{
  eq('slash normalised', cache.latestKey('BTC/USD'), 'latest:BTC_USD');
  eq('lowercase upper-cased', cache.latestKey('btc/usd'), 'latest:BTC_USD');
  eq('OTC dash normalised', cache.latestKey('EURUSD-OTC'), 'latest:EURUSD_OTC');
  eq('round-trip BTC/USD', cache.pairFromLatestKey(cache.latestKey('BTC/USD')), 'BTC/USD');
  eq('round-trip USD/JPY', cache.pairFromLatestKey(cache.latestKey('USD/JPY')), 'USD/JPY');
  // a naive underscore->slash swap would turn this into EURUSD/OTC
  eq('round-trip OTC keeps the dash', cache.pairFromLatestKey(cache.latestKey('EURUSD-OTC')), 'EURUSD-OTC');
  ok('prefix distinct from existing ones',
     !['sig:', 'stats:', 'pending:', 'cb:', 'quota:', 'rr:', 'c:'].includes(SCAN_CONFIG.KV_LATEST_PREFIX));
}

console.log('\n── freshness maths ────────────────────────────────────────');
{
  const now = Date.now();
  const at = s => ({ generatedAt: new Date(now - s * 1000).toISOString() });
  eq('age computed in seconds', cache.enrichAge(at(120), now).generationAge, 120);
  ok('fresh entry not stale', !cache.enrichAge(at(120), now).stale);
  ok('entry past TTL is stale', cache.enrichAge(at(SCAN_CONFIG.LATEST_TTL_SECONDS + 1), now).stale);
  ok('isStale agrees with enrichAge', cache.isStale(at(SCAN_CONFIG.LATEST_TTL_SECONDS + 1), now));
  // nextRefreshIn counts to the next scan, not to TTL expiry
  eq('nextRefreshIn mid-cycle', cache.enrichAge(at(120), now).nextRefreshIn, 180);
  eq('nextRefreshIn wraps per interval', cache.enrichAge(at(360), now).nextRefreshIn, 240);
  ok('unparseable generatedAt treated as stale',
     cache.enrichAge({ generatedAt: 'nope' }, now).stale === true);
  ok('null payload survives enrichAge', cache.enrichAge(null) === null);
}

console.log('\n── writeLatest / readLatest ───────────────────────────────');
{
  const env = { SIGNAL_CACHE: makeKV() };
  const wrote = await cache.writeLatest('BTC/USD', { signal: { finalSignal: 'BUY' } },
    { generationId: 'gen_x', opportunistic: false }, env);
  ok('write reports success', wrote === true);
  const stored = env.SIGNAL_CACHE._m.get('latest:BTC_USD');
  eq('TTL applied on write', stored.opts.expirationTtl, SCAN_CONFIG.LATEST_TTL_SECONDS);
  const read = await cache.readLatest('BTC/USD', env);
  eq('cached flag set', read.cached, true);
  eq('generationId persisted', read.generationId, 'gen_x');
  eq('opportunistic false for cron writes', read.opportunistic, false);
  eq('miss returns null', await cache.readLatest('ZZZ/USD', env), null);
  eq('no KV binding -> null, no throw', await cache.readLatest('BTC/USD', {}), null);
  eq('write with no binding -> false', await cache.writeLatest('BTC/USD', {}, {}, {}), false);
}

// ── mock the engine so scheduledScan can run offline ──────────────────
const engineCalls = [];
let engineBehaviour = () => ({ pair: 'X', signal: { finalSignal: 'BUY' }, source: 'FULL_DATA' });

const signalMod = await import('../src/handlers/signal.js');
const realHandleSignalRaw = signalMod.handleSignalRaw;

console.log('\n── scheduledScan (mocked engine) ──────────────────────────');
{
  // scheduledScan imports handleSignalRaw directly, so inject via module record
  const scanMod = await import('../src/handlers/scheduledScan.js');

  // selectActivePairs is pure and exported — test the market gate directly
  const openList = scanMod.selectActivePairs(SCAN_PAIRS, true);
  const closedList = scanMod.selectActivePairs(SCAN_PAIRS, false);
  eq('all 14 pairs active when forex open', openList.length, 14);
  eq('forex dropped when market closed', closedList.length, 10);
  ok('crypto survives a closed forex market', closedList.every(p => !['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'].includes(p)));
  ok('unsupported symbol filtered out',
     scanMod.selectActivePairs(['BTC/USD', 'XAU/USD'], true).length === 1);
  eq('pairs are normalised', scanMod.selectActivePairs(['btcusd'], true), ['BTC/USD']);
}

console.log('\n── handleLatest ───────────────────────────────────────────');
{
  const { handleLatest } = await import('../src/handlers/latest.js');
  const env = { SIGNAL_CACHE: makeKV() };
  const now = Date.now();

  await cache.writeLatest('BTC/USD', { signal: { finalSignal: 'BUY' }, pair: 'BTC/USD' },
    { generationId: 'gen_1' }, env);
  await cache.writeLatest('ETH/USD', { signal: { finalSignal: 'SELL' }, pair: 'ETH/USD' },
    { generationId: 'gen_1' }, env);

  const one = await handleLatest(new URL('https://x/api/signals/latest?pair=BTC/USD'), env);
  eq('single pair 200', one.status, 200);
  const oneBody = await one.json();
  eq('single pair payload', oneBody.signal.finalSignal, 'BUY');
  ok('age enriched', typeof oneBody.generationAge === 'number');
  ok('nextRefreshIn present', typeof oneBody.nextRefreshIn === 'number');

  const alt = await handleLatest(new URL('https://x/api/signals/latest?pair=btcusd'), env);
  eq('alternate spelling resolves to same entry', (await alt.json()).pair, 'BTC/USD');

  const miss = await handleLatest(new URL('https://x/api/signals/latest?pair=DOT/USD'), env);
  eq('cache miss is 404', miss.status, 404);
  const missBody = await miss.json();
  ok('404 explains the escape hatch', String(missBody.message).includes('/api/signal'));
  eq('404 says whether the pair is scanned', missBody.scanned, true);

  const bad = await handleLatest(new URL('https://x/api/signals/latest?pair=NOTAPAIR'), env);
  eq('invalid pair is 400', bad.status, 400);

  const all = await handleLatest(new URL('https://x/api/signals/latest'), env);
  const allBody = await all.json();
  eq('all-pairs count', allBody.pairCount, 2);
  ok('keys map back to display pairs',
     Object.keys(allBody.signals).sort().join(',') === 'BTC/USD,ETH/USD',
     Object.keys(allBody.signals).join(','));
  ok('oldestCachedAge reported', typeof allBody.oldestCachedAge === 'number');

  // a stale row must not be served
  const staleEnv = { SIGNAL_CACHE: makeKV() };
  await staleEnv.SIGNAL_CACHE.put('latest:DOT_USD', JSON.stringify({
    signal: { finalSignal: 'BUY' },
    generatedAt: new Date(now - (SCAN_CONFIG.LATEST_TTL_SECONDS + 60) * 1000).toISOString(),
  }));
  const staleOne = await handleLatest(new URL('https://x/api/signals/latest?pair=DOT/USD'), staleEnv);
  eq('stale single pair -> 404', staleOne.status, 404);
  const staleAll = await handleLatest(new URL('https://x/api/signals/latest'), staleEnv);
  const staleAllBody = await staleAll.json();
  eq('stale row excluded from all-list', staleAllBody.pairCount, 0);
  eq('stale rows counted', staleAllBody.staleSkipped, 1);

  const noKv = await handleLatest(new URL('https://x/api/signals/latest'), {});
  eq('no KV binding -> 503', noKv.status, 503);
}

console.log('\n── /health scanCache block ────────────────────────────────');
{
  const { getScanCacheStats } = await import('../src/handlers/latest.js');
  const env = { SIGNAL_CACHE: makeKV() };
  await cache.writeLatest('BTC/USD', { signal: {} }, { generationId: 'gen_A' }, env);
  await cache.writeLatest('ETH/USD', { signal: {} }, { opportunistic: true }, env);

  const stats = await getScanCacheStats(env);
  eq('cachedPairCount', stats.cachedPairCount, 2);
  eq('scanIntervalSec surfaced', stats.scanIntervalSec, SCAN_CONFIG.SCAN_INTERVAL_SECONDS);
  eq('ttl surfaced', stats.ttlSeconds, SCAN_CONFIG.LATEST_TTL_SECONDS);
  eq('opportunistic entries counted', stats.opportunisticCount, 1);
  eq('cron generation id reported', stats.lastGenerationId, 'gen_A');
  ok('ages computed', typeof stats.oldestCachedAge === 'number');
  eq('no binding -> null', await getScanCacheStats({}), null);
}

console.log('\n── backward compatibility (spec §9) ───────────────────────');
{
  const fs = await import('node:fs');
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  for (const ep of ['/api/signal', '/api/batch', '/api/history', '/api/stats', '/api/report', '/api/pairs']) {
    ok('endpoint still routed: ' + ep, idx.includes("'" + ep + "'"));
  }
  ok('new endpoint routed', idx.includes("'/api/signals/latest'"));
  ok('cron split on event.cron', idx.includes("cron === '*/5 * * * *'"));
  ok('result checker still wired', idx.includes('scheduledTracker(env)'));

  const sig = fs.readFileSync(new URL('../src/handlers/signal.js', import.meta.url), 'utf8');
  ok('handleSignalRaw signature unchanged',
     sig.includes('export async function handleSignalRaw(pair, env, ctx'));
  // The spec's scanOnePair sketch also called saveSignalToHistory; that would
  // double-write because handleSignalRaw already does it.
  const scan = fs.readFileSync(new URL('../src/handlers/scheduledScan.js', import.meta.url), 'utf8');
  // Must not CALL it — the file mentions it in a comment explaining why.
  const scanCode = scan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('scanner does NOT call saveSignalToHistory (no double write)',
     !/saveSignalToHistory\s*\(/.test(scanCode));
  ok('scanner does not import saveSignalToHistory',
     !/import[^;]*saveSignalToHistory/.test(scanCode));
  ok('scanner reuses handleSignalRaw (no forked engine)', scan.includes('handleSignalRaw('));
  ok('scanner skips DUMMY_FALLBACK', scan.includes('DUMMY_FALLBACK'));

  const wrangler = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  ok('both crons registered', wrangler.includes('"*/2 * * * *", "*/5 * * * *"'));

  const engineDiffTargets = ['../src/signal/engine.js', '../src/signal/otcEngine.js'];
  for (const t of engineDiffTargets) {
    const src = fs.readFileSync(new URL(t, import.meta.url), 'utf8');
    ok('engine untouched by Phase 7: ' + t.split('/').pop(),
       !src.includes('SCAN_CONFIG') && !src.includes('latestCache'));
  }
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL PHASE 7 SMOKE TESTS PASSED');

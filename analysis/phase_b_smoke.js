/**
 * Phase B smoke tests — run with:  node analysis/phase_b_smoke.js
 *
 * Covers PHASE_B_FIX_PROMPT §4.4f (7 key/rotation assertions) plus the
 * circuit-breaker flow and the entrySource / derivedAiStatus mapping.
 * Pure in-memory: no network, no wrangler, no KV binding required.
 */

import { getApiKeys, getNextRotationIndex, readRotationIndex } from '../src/fetch/keys.js';
import { getCBState, isTripped, applyResult } from '../src/history/circuitBreaker.js';
import { incrementQuota, readQuota } from '../src/history/quota.js';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

// ── in-memory KV double ────────────────────────────────────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, String(v)); return undefined; },
    async delete(k) { m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    },
  };
}

const K = i => 'key_' + String(i).padStart(3, '0');

console.log('── §4.4f  key loading + rotation ──────────────────────────');

// 1. numbered format, 19 keys, no upper cap
{
  const env = {};
  for (let i = 1; i <= 19; i++) env['TWELVEDATA_API_KEY_' + i] = K(i);
  const keys = getApiKeys(env);
  eq('4.4f-1 numbered format loads all 19 keys', keys.length, 19);
  eq('4.4f-1 order preserved (first)', keys[0], K(1));
  eq('4.4f-1 order preserved (last)', keys[18], K(19));
}

// 2. JSON array format, 19 keys
{
  const arr = []; for (let i = 1; i <= 19; i++) arr.push(K(i));
  const keys = getApiKeys({ TWELVEDATA_API_KEYS: JSON.stringify(arr) });
  eq('4.4f-2 JSON array format loads all 19 keys', keys.length, 19);
}

// 3. gap tolerance — _1, _2, _5, _19
{
  const env = { TWELVEDATA_API_KEY_1: K(1), TWELVEDATA_API_KEY_2: K(2),
                TWELVEDATA_API_KEY_5: K(5), TWELVEDATA_API_KEY_19: K(19) };
  const keys = getApiKeys(env);
  eq('4.4f-3 gap tolerance length', keys.length, 4);
  ok('4.4f-3 numeric-index ordering (not lexicographic)',
     JSON.stringify(keys) === JSON.stringify([K(1), K(2), K(5), K(19)]), JSON.stringify(keys));
}

// 4. duplicate values deduped
{
  const env = { TWELVEDATA_API_KEY_1: 'same_key', TWELVEDATA_API_KEY_5: 'same_key' };
  eq('4.4f-4 duplicate keys deduped', getApiKeys(env).length, 1);
}

// 5. rotation spreads load across all keys
{
  const env = { SIGNAL_CACHE: makeKV() };
  const hits = [0, 0, 0, 0, 0];
  for (let i = 0; i < 100; i++) hits[await getNextRotationIndex(env, 5)]++;
  const inRange = hits.every(h => h >= 15 && h <= 25);
  ok('4.4f-5 rotation hits each of 5 keys 15-25 times', inRange, JSON.stringify(hits));
  eq('4.4f-5 hits sum to 100', hits.reduce((a, b) => a + b, 0), 100);
  ok('4.4f-5 readRotationIndex readable', (await readRotationIndex(env)) >= 0);
  eq('4.4f-5 single key short-circuits to 0', await getNextRotationIndex(env, 1), 0);
  eq('4.4f-5 no-KV env short-circuits to 0', await getNextRotationIndex({}, 5), 0);
}

// ── fetch-layer behaviour (mock global fetch) ──────────────────────────
const realFetch = globalThis.fetch;
function mockFetch(handler) { globalThis.fetch = handler; }
function restoreFetch() { globalThis.fetch = realFetch; }

function candleBody() {
  return JSON.stringify({ values: [
    { datetime: '2026-07-28 12:00:00', open: '1.1', high: '1.2', low: '1.0', close: '1.15', volume: '0' },
    { datetime: '2026-07-28 11:59:00', open: '1.1', high: '1.2', low: '1.0', close: '1.14', volume: '0' },
  ] });
}

const { fetchCandles } = await import('../src/fetch/candles.js');

// 6. 19 keys, first 18 rate-limited, 19th succeeds → cap really is gone
{
  const env = { SIGNAL_CACHE: makeKV() };
  for (let i = 1; i <= 19; i++) env['TWELVEDATA_API_KEY_' + i] = K(i);
  let calls = 0;
  const realWarn = console.warn; console.warn = () => {};   // expected 429 noise
  mockFetch(async () => {
    calls++;
    if (calls < 19) return new Response('rate limit', { status: 429 });
    return new Response(candleBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const res = await fetchCandles('EUR/USD', '1min', 100, env, 'FOREX');
  restoreFetch(); console.warn = realWarn;
  eq('4.4f-6 all 19 keys attempted before success', calls, 19);
  ok('4.4f-6 19th attempt returns candles', Array.isArray(res) && res.length === 2,
     JSON.stringify(res).slice(0, 120));
  eq('4.4f-6 quota counted 19 HTTP attempts', await readQuota(env), 19);
}

// 7. rotation must not multiply calls — one success = one HTTP call
{
  const env = { SIGNAL_CACHE: makeKV() };
  for (let i = 1; i <= 5; i++) env['TWELVEDATA_API_KEY_' + i] = K(i);
  let calls = 0;
  const usedKeys = [];
  mockFetch(async (url) => {
    calls++;
    usedKeys.push(new URL(url).searchParams.get('apikey'));
    return new Response(candleBody(), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  for (let i = 0; i < 5; i++) await fetchCandles('EUR/USD', '1min', 100, env, 'FOREX');
  restoreFetch();
  eq('4.4f-7 5 invocations => exactly 5 HTTP calls', calls, 5);
  eq('4.4f-7 5 distinct keys used (load actually spread)', new Set(usedKeys).size, 5);
  eq('4.4f-7 quota == HTTP call count', await readQuota(env), 5);
}

console.log('\n── §4.5  circuit breaker flow ─────────────────────────────');
{
  const env = { SIGNAL_CACHE: makeKV() };
  eq('CB fresh pair not tripped', (await isTripped('BTC/USD', env)).tripped, false);

  await applyResult('BTC/USD', 'LOSS', env);
  eq('CB 1 loss -> streak 1', (await getCBState('BTC/USD', env)).lossStreak, 1);
  eq('CB 1 loss -> still not tripped', (await isTripped('BTC/USD', env)).tripped, false);

  await applyResult('BTC/USD', 'LOSS', env);
  const st2 = await getCBState('BTC/USD', env);
  eq('CB 2 losses -> streak 2', st2.lossStreak, 2);
  ok('CB 2 losses -> cooldownUntil set', !!st2.cooldownUntil, JSON.stringify(st2));
  const trip = await isTripped('BTC/USD', env);
  eq('CB 2 losses -> tripped', trip.tripped, true);
  const hoursOut = (new Date(trip.cooldownUntil).getTime() - Date.now()) / 3600000;
  ok('CB cooldown is ~6h', hoursOut > 5.9 && hoursOut <= 6.0, hoursOut.toFixed(3) + 'h');

  eq('CB is per-pair (ETH untouched)', (await isTripped('ETH/USD', env)).tripped, false);

  await applyResult('BTC/USD', 'UNKNOWN', env);
  eq('CB UNKNOWN ignored (streak unchanged)', (await getCBState('BTC/USD', env)).lossStreak, 2);

  await applyResult('BTC/USD', 'WIN', env);
  const st3 = await getCBState('BTC/USD', env);
  eq('CB WIN resets streak', st3.lossStreak, 0);
  eq('CB WIN clears cooldown', st3.cooldownUntil, null);
  eq('CB WIN -> not tripped', (await isTripped('BTC/USD', env)).tripped, false);

  // expired cooldown auto-clears on read
  await applyResult('XRP/USD', 'LOSS', env);
  await applyResult('XRP/USD', 'LOSS', env);
  const s = await getCBState('XRP/USD', env);
  s.cooldownUntil = new Date(Date.now() - 1000).toISOString();
  await env.SIGNAL_CACHE.put('cb:XRP_USD', JSON.stringify(s));
  eq('CB expired cooldown reads as not tripped', (await isTripped('XRP/USD', env)).tripped, false);

  // key normalisation
  await applyResult('EURUSD-OTC', 'LOSS', env);
  await applyResult('EURUSD-OTC', 'LOSS', env);
  eq('CB OTC pair key normalised', (await isTripped('EURUSD-OTC', env)).tripped, true);

  eq('CB no-KV env is a no-op', (await isTripped('BTC/USD', {})).tripped, false);
}

console.log('\n── §4.3  quota counter ────────────────────────────────────');
{
  const env = { SIGNAL_CACHE: makeKV() };
  eq('quota starts at 0', await readQuota(env), 0);
  for (let i = 0; i < 7; i++) await incrementQuota(env);
  eq('quota after 7 increments', await readQuota(env), 7);
  const day = new Date().toISOString().slice(0, 10);
  ok('quota key is UTC-day scoped', env.SIGNAL_CACHE._m.has('quota:' + day));
  await incrementQuota({});   // must not throw
  eq('quota no-KV env returns -1', await readQuota({}), -1);
}

console.log('\n── §3.2  entrySource mapping + §4.6 aiStatus ──────────────');
{
  const src = await import('node:fs').then(m => m.promises.readFile('src/handlers/signal.js', 'utf8'));
  ok('entrySource FRESH_API at cacheHits 0', src.includes("=== 0) return 'FRESH_API'"));
  ok('entrySource CACHE_PARTIAL at 1|2', src.includes("=== 1 || cacheHits === 2) return 'CACHE_PARTIAL'"));
  ok('entrySource CACHE_ALL at 3', src.includes("=== 3) return 'CACHE_ALL'"));
  const st = await import('node:fs').then(m => m.promises.readFile('src/history/stats.js', 'utf8'));
  ok('record carries structureVerdict', st.includes('structureVerdict:'));
  ok('record carries aiStatus', st.includes('aiStatus:'));
  ok('record carries coreConfidence', st.includes('coreConfidence:'));
  ok('record carries entrySource', st.includes('entrySource:'));
  ok('shadow rows skip updatePairStats', st.includes('if (!record.cbShadow) await updatePairStats'));
  ok('CB funnel hook present in updatePairStats', st.includes('cbApplyResult(pair, winLoss, env)'));
  ok('retry cap uses PENDING_MAX_CHECKS', st.includes('record.checks >= HISTORY_CONFIG.PENDING_MAX_CHECKS'));
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL SMOKE TESTS PASSED');

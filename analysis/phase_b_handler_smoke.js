/**
 * Phase B — handler-level circuit-breaker check (§4.5 check sites).
 * node analysis/phase_b_handler_smoke.js
 *
 * Runs the real handleSignalRaw against mocked candle data with the CB already
 * in cooldown, and asserts the §3.3 shadow contract:
 *   response.signal.finalSignal === 'NO_TRADE'
 *   response.circuitBreaker.{tripped, cooldownUntil, cbShadow}
 *   a history row IS written, tagged cbShadow:true, carrying the would-be
 *   direction so the counterfactual stays measurable
 *   stats/CB state are NOT touched by that row
 */

import { handleSignalRaw } from '../src/handlers/signal.js';
import { applyResult } from '../src/history/circuitBreaker.js';

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

// Deterministic uptrend with mild noise — enough structure that the engine
// actually emits BUY (a perfectly flat ramp trips MIXED_ALIGNMENT).
function candles(n, base, step, noise) {
  const out = []; let c = base;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c + step + Math.sin(i / 3) * noise;
    out.push({ datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
               open: o.toFixed(5), high: (Math.max(o, c) + step * 0.3).toFixed(5),
               low: (Math.min(o, c) - step * 0.3).toFixed(5), close: c.toFixed(5), volume: '1000' });
  }
  return out.reverse();   // TwelveData returns newest-first
}

const ctx = { waitUntil: (p) => { pending.push(p); } };
let pending = [];
async function drain() { const p = pending; pending = []; await Promise.all(p); }

const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };

globalThis.fetch = async () => new Response(JSON.stringify({ values: candles(120, 100, 0.2, 0.02) }),
                                            { status: 200, headers: { 'content-type': 'application/json' } });

console.log('── §4.5  CB NOT tripped: normal emit path unchanged ───────');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  const r = quiet();
  const res = await handleSignalRaw('BTC/USD', env, ctx);
  await drain();
  r();
  ok('response has no circuitBreaker block', res.circuitBreaker === undefined);
  ok('entrySource exposed on response', typeof res.entrySource === 'string', String(res.entrySource));
  ok('entrySource is a valid enum value',
     ['FRESH_API', 'CACHE_PARTIAL', 'CACHE_ALL'].includes(res.entrySource), String(res.entrySource));
  ok('coreConfidence present on signal', typeof res.signal.coreConfidence === 'number',
     String(res.signal.coreConfidence));
}

console.log('\n── §3.3  CB tripped: NO_TRADE + shadow row ────────────────');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  await applyResult('BTC/USD', 'LOSS', env);
  await applyResult('BTC/USD', 'LOSS', env);      // arms the 6h cooldown

  const r = quiet();
  const res = await handleSignalRaw('BTC/USD', env, ctx);
  await drain();
  r();

  eq('finalSignal forced to NO_TRADE', res.signal.finalSignal, 'NO_TRADE');
  eq('circuitBreaker.tripped', res.circuitBreaker.tripped, true);
  eq('circuitBreaker.cbShadow', res.circuitBreaker.cbShadow, true);
  ok('cooldownUntil is in the future', new Date(res.circuitBreaker.cooldownUntil).getTime() > Date.now());
  ok('wouldBeSignal exposed for the client', ['BUY', 'SELL'].includes(res.circuitBreaker.wouldBeSignal),
     String(res.circuitBreaker.wouldBeSignal));

  const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
  ok('shadow row written to history', Array.isArray(hist) && hist.length === 1, JSON.stringify(hist && hist.length));
  eq('shadow row tagged', hist[0].cbShadow, true);
  ok('shadow row keeps the would-be direction', ['BUY', 'SELL'].includes(hist[0].direction), hist[0].direction);
  ok('shadow row carries entrySource', typeof hist[0].entrySource === 'string', String(hist[0].entrySource));

  eq('no pair stats written by a shadow emit', await env.SIGNAL_CACHE.get('stats:BTC_USD', 'json'), null);
  const cb = await env.SIGNAL_CACHE.get('cb:BTC_USD', 'json');
  eq('CB lossStreak untouched by a shadow emit', cb.lossStreak, 2);
}

console.log('\n── §4.5  OTC path check site ──────────────────────────────');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  await applyResult('EURUSD-OTC', 'LOSS', env);
  await applyResult('EURUSD-OTC', 'LOSS', env);
  const r = quiet();
  const res = await handleSignalRaw('EURUSD-OTC', env, ctx);
  await drain();
  r();
  eq('OTC finalSignal forced to NO_TRADE', res.signal.finalSignal, 'NO_TRADE');
  eq('OTC circuitBreaker.tripped', res.circuitBreaker.tripped, true);
  const hist = await env.SIGNAL_CACHE.get('sig:EURUSD_OTC', 'json');
  ok('OTC shadow row written', Array.isArray(hist) && hist.length === 1);
  eq('OTC shadow row tagged', hist[0].cbShadow, true);
  eq('OTC stats untouched', await env.SIGNAL_CACHE.get('stats:EURUSD_OTC', 'json'), null);
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL HANDLER SMOKE TESTS PASSED');

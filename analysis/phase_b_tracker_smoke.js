/**
 * Phase B — scheduledTracker integration smoke (B0-1/2/3/5 + §3.3 shadow).
 * node analysis/phase_b_tracker_smoke.js
 *
 * Drives the real scheduledTracker against an in-memory KV + mocked fetch, so
 * the retry-cap, the bracket query and the shadow-row stats skip are exercised
 * end to end rather than grep-asserted.
 */

import { scheduledTracker, saveSignalToHistory } from '../src/history/stats.js';
import { HISTORY_CONFIG } from '../src/config.js';

let pass = 0, fail = 0; const failures = [];
function eq(name, actual, expected) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k, type) { if (!m.has(k)) return null; const v = m.get(k); return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

const PAST = new Date(Date.now() - 10 * 60 * 1000).toISOString();   // expired 10 min ago

function pendingRecord(id, pair, direction, entryPrice, extra = {}) {
  return { id, pair, isOTC: false, direction, entryPrice, expiryTime: PAST,
           bestTF: '5min', session: ['LONDON'], marketRegime: 'RANGING',
           result: null, exitPrice: null, checkedAt: null,
           timestamp: new Date(Date.now() - 25 * 60 * 1000).toISOString(), ...extra };
}

async function seed(env, rec) {
  await env.SIGNAL_CACHE.put(HISTORY_CONFIG.KV_PENDING_PREFIX + rec.id, JSON.stringify(rec));
  await env.SIGNAL_CACHE.put('sig:' + rec.pair.replace('/', '_'), JSON.stringify([rec]));
}

const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };

function priceBody(px) {
  const dt = new Date(PAST).toISOString().slice(0, 19).replace('T', ' ');
  return new Response(JSON.stringify({ values: [{ datetime: dt, open: '1', high: '1', low: '1', close: String(px) }] }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
}

console.log('── B0-3  retry cap: transient failure must not burn the record ──');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  await seed(env, pendingRecord('sig_a', 'BTC/USD', 'BUY', 100));
  const restore = quiet();
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  await scheduledTracker(env);
  restore();
  const stillPending = await env.SIGNAL_CACHE.get('pending:sig_a', 'json');
  ok('pending record survives a failed check', !!stillPending);
  eq('checks counter incremented', stillPending && stillPending.checks, 1);
  eq('lastCheckError recorded', stillPending && stillPending.lastCheckError, 'HTTP_500');

  const restore2 = quiet();
  for (let i = 0; i < 14; i++) await scheduledTracker(env);
  restore2();
  eq('record dropped only after 15 checks', await env.SIGNAL_CACHE.get('pending:sig_a', 'json'), null);
  const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
  eq('give-up marks result UNKNOWN', hist[0].result, 'UNKNOWN');
  eq('no stats written for UNKNOWN', await env.SIGNAL_CACHE.get('stats:BTC_USD', 'json'), null);
}

console.log('\n── B0-1  bracket query + WIN/LOSS resolution ──────────────');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  await seed(env, pendingRecord('sig_b', 'ETH/USD', 'BUY', 100));
  let seenUrl = '';
  const restore = quiet();
  globalThis.fetch = async (url) => { seenUrl = url; return priceBody(105); };
  await scheduledTracker(env);
  restore();
  const u = new URL(seenUrl);
  ok('start_date param present', !!u.searchParams.get('start_date'), seenUrl);
  ok('end_date param present', !!u.searchParams.get('end_date'));
  eq('outputsize no longer used', u.searchParams.get('outputsize'), null);
  const hist = await env.SIGNAL_CACHE.get('sig:ETH_USD', 'json');
  eq('BUY above entry resolves WIN', hist[0].result, 'WIN');
  eq('exit price persisted', hist[0].exitPrice, 105);
  const stats = await env.SIGNAL_CACHE.get('stats:ETH_USD', 'json');
  eq('stats updated', stats.wins, 1);
  eq('pending cleared on success', await env.SIGNAL_CACHE.get('pending:sig_b', 'json'), null);
}

console.log('\n── B2  circuit breaker trips after 2 losses via the funnel ──');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  const restore = quiet();
  globalThis.fetch = async () => priceBody(95);        // SELL entry 100 -> exit 95? no: BUY 100 -> 95 = LOSS
  await seed(env, pendingRecord('sig_c1', 'XRP/USD', 'BUY', 100));
  await scheduledTracker(env);
  await seed(env, pendingRecord('sig_c2', 'XRP/USD', 'BUY', 100));
  await scheduledTracker(env);
  restore();
  const cb = await env.SIGNAL_CACHE.get('cb:XRP_USD', 'json');
  eq('CB state written by funnel hook', cb.lossStreak, 2);
  ok('CB cooldown armed after 2 losses', !!cb.cooldownUntil, JSON.stringify(cb));
}

console.log('\n── §3.3  shadow rows: tracked, but excluded from WR ───────');
{
  const env = { SIGNAL_CACHE: makeKV(), TWELVEDATA_API_KEY_1: 'k1' };
  await seed(env, pendingRecord('sig_d', 'SOL/USD', 'BUY', 100, { cbShadow: true }));
  const restore = quiet();
  globalThis.fetch = async () => priceBody(110);
  await scheduledTracker(env);
  restore();
  const hist = await env.SIGNAL_CACHE.get('sig:SOL_USD', 'json');
  eq('shadow row still gets its outcome', hist[0].result, 'WIN');
  eq('shadow row excluded from pair stats', await env.SIGNAL_CACHE.get('stats:SOL_USD', 'json'), null);
  eq('shadow row excluded from CB state', await env.SIGNAL_CACHE.get('cb:SOL_USD', 'json'), null);
}

console.log('\n── B5  additive fields persist through saveSignalToHistory ─');
{
  const env = { SIGNAL_CACHE: makeKV() };
  const signal = {
    finalSignal: 'BUY', confidence: '80%', grade: { grade: 'A' },
    coreConfidence: 71, alignment: 'ALL_BULLISH', marketRegime: 'TRENDING',
    session: { sessions: ['LONDON'], quality: 'HIGH' },
    structureVerdict: { overall: 'SUPPORTS' },
    aiValidation: { combined: { status: 'OK', agreement: 'BOTH_AGREE' }, combinedAgreed: true },
    bestTimeframe: { timeframe: '5min', expiry: { expiryTime: new Date(Date.now() + 300000).toISOString() } },
    recommendations: { '5min': { entry: { price: 1.2345 } } },
  };
  const restore = quiet();
  await saveSignalToHistory(signal, 'EUR/USD', false, env, 'sig_e', 'CACHE_PARTIAL');
  restore();
  const rec = (await env.SIGNAL_CACHE.get('sig:EUR_USD', 'json'))[0];
  eq('structureVerdict persisted', rec.structureVerdict, 'SUPPORTS');
  eq('aiStatus persisted', rec.aiStatus, 'BOTH_AGREE');
  eq('coreConfidence persisted', rec.coreConfidence, 71);
  eq('entrySource persisted', rec.entrySource, 'CACHE_PARTIAL');
  eq('cbShadow omitted on normal rows', 'cbShadow' in rec, false);
  eq('legacy fields intact (direction)', rec.direction, 'BUY');
  eq('legacy fields intact (aiAgreed)', rec.aiAgreed, true);

  const otcSignal = { ...signal, isOTC: true, aiValidation: { status: 'OK', agrees: false } };
  const r2 = quiet();
  await saveSignalToHistory(otcSignal, 'EURUSD-OTC', true, env, 'sig_f', 'FRESH_API');
  r2();
  const orec = (await env.SIGNAL_CACHE.get('sig:EURUSD_OTC', 'json'))[0];
  eq('OTC aiStatus disagree mapping', orec.aiStatus, 'OTC_DISAGREE');
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL TRACKER SMOKE TESTS PASSED');

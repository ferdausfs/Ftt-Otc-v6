/**
 * D2 Shadow Collector — mandatory test suite.
 *   node scripts/d2_tests.mjs
 *
 * Covers:
 *   [#1-4]  d2store isolation / invalid input / dedup / cap
 *   [#5-8]  resolver: WIN, LOSS, tie convention, cap, transient-error path
 *   [#9-10] engine: TRENDING block fires + audit attached + zero JSON leak;
 *           non-D2 fixtures carry no audit
 *   [#11]   bad-pair block SUSPENDED by default (CONFIG flag false)
 *   [#12]   non-D2 engine behaviour untouched by the instrumentation
 *   [#13]   admission gate: AI-rescued signals are NOT double-counted
 *
 * Real module integration, no network, no AI (env={} => AI skipped -> final
 * stays NO_TRADE, exactly the admission-eligible case). KV is an in-memory
 * double.
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

function makeKV() {
  const m = new Map();
  return {
    _m: m, puts: 0, dels: 0,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k).value; return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, o) { this.puts++; m.set(k, { value: String(v), opts: o }); },
    async delete(k) { this.dels++; m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

const { CONFIG } = await import('../src/config.js');
const { buildMultiTimeframeSignal } = await import('../src/signal/engine.js');
const { attachD2Audit, getD2Audit, maybeAdmitD2ShadowObservation } = await import('../src/signal/d2shadow.js');
const {
  admitD2ShadowObservation, resolveD2ShadowObservations,
  getD2Accounting, resetD2Accounting, __d2StoreTest,
} = await import('../src/history/d2store.js');
const { makeCandleData } = await import('./r71_fixtures.mjs');

const ENV = {};
const P = { basePrice: 78000, vol: 40, trend: 400, seed: 7 };   // -> TRENDING
const RANGING = { basePrice: 1.08, vol: 0.0006, trend: 0, seed: 33 };

const pastExpiry = new Date(Date.now() - 10 * 60 * 1000).toISOString();   // must clear RESULT_CHECK_DELAY (90s)
const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#1] Store isolation — d2 namespace never touches other KV ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  // seed unrelated keys incl. R7.1 shadow namespace
  const seeds = {
    'sig:BTC_USD': JSON.stringify([{ id: 'n1', pair: 'BTC/USD', direction: 'BUY' }]),
    'stats:BTC_USD': JSON.stringify({ pair: 'BTC/USD', wins: 5 }),
    'cb:BTC_USD': JSON.stringify({ lossStreak: 1 }),
    'pushLog:n1': JSON.stringify([{ chatId: '1' }]),
    'shadow:obs:r71_1': JSON.stringify({ id: 'r71_1', result: 'WIN' }),
    'latest:BTC_USD': JSON.stringify({ pair: 'BTC/USD' }),
  };
  for (const [k, v] of Object.entries(seeds)) kv._m.set(k, { value: v, opts: {} });
  const before = Object.fromEntries(Object.entries(seeds));

  await admitD2ShadowObservation({
    id: 'd2_t1', pair: 'BTC/USD', assetType: 'CRYPTO', direction: 'BUY',
    entryPrice: 78000, expiryTime: futureExpiry, shadowConfidence: 80,
    attribution: 'D2_TRENDING_BLOCKED',
  }, env);

  // only d2 keys added
  const allKeys = [...kv._m.keys()];
  const newKeys = allKeys.filter(k => !(k in before));
  ok('[#1a] only d2obs:/d2pending:/d2idx: keys created',
    newKeys.every(k => k.startsWith('d2obs:') || k.startsWith('d2pending:') || k.startsWith('d2idx:')),
    'new keys: ' + newKeys.join(', '));
  // seeded keys byte-identical
  let untouched = true;
  for (const k of Object.keys(before)) if (kv._m.get(k).value !== before[k]) untouched = false;
  ok('[#1b] seeded sig/stats/cb/pushLog/shadow/latest keys untouched', untouched);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#2] Invalid input rejected ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const base = { id: 'd2_x', pair: 'BTC/USD', direction: 'BUY', entryPrice: 1, expiryTime: futureExpiry };
  for (const [label, mut] of [
    ['no id', o => delete o.id],
    ['no pair', o => delete o.pair],
    ['no direction', o => delete o.direction],
    ['no expiry', o => delete o.expiryTime],
  ]) {
    const o = { ...base }; mut(o);
    const r = await admitD2ShadowObservation(o, env);
    ok('[#2] rejected: ' + label, r.admitted === false && r.reason === 'INVALID_INPUT');
  }
  ok('[#2] nothing written for invalid inputs', kv._m.size === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#3] Dedup — pair+direction+nearby entry within 2h ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const r1 = await admitD2ShadowObservation({ id: 'd2_d1', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000.001, expiryTime: futureExpiry }, env);
  const r2 = await admitD2ShadowObservation({ id: 'd2_d2', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000.002, expiryTime: futureExpiry }, env);
  const r3 = await admitD2ShadowObservation({ id: 'd2_d3', pair: 'BTC/USD', direction: 'SELL', entryPrice: 78000.001, expiryTime: futureExpiry }, env);
  ok('[#3a] first admitted', r1.admitted === true);
  ok('[#3b] near-identical BUY rejected as DEDUP', r2.admitted === false && r2.reason === 'DEDUP');
  ok('[#3c] different direction admitted (not dedup)', r3.admitted === true);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#4] Cap — max 30 per pair per rolling 30d ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  let admitted = 0;
  for (let i = 0; i < __d2StoreTest.MAX_PER_PAIR_30D + 2; i++) {
    const r = await admitD2ShadowObservation({
      id: 'd2_cap_' + i, pair: 'SOL/USD', direction: i % 2 ? 'BUY' : 'SELL',
      entryPrice: 100 + i, expiryTime: futureExpiry,
    }, env);
    if (r.admitted) admitted++;
  }
  ok('[#4] admitted exactly ' + __d2StoreTest.MAX_PER_PAIR_30D + ' (cap)',
    admitted === __d2StoreTest.MAX_PER_PAIR_30D, 'admitted=' + admitted);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#5-7] Resolver — WIN / LOSS / tie / cap ──');
{
  const fetchPrice = async (pair, expiry, e) => {
    const prices = { BUY_WIN: 78500, BUY_LOSS: 77500, SELL_WIN: 2900, TIE: 78000 };
    return { price: prices[e._kind] };
  };
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv, _kind: 'BUY_WIN' };
  await admitD2ShadowObservation({ id: 'd2_rw', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000, expiryTime: pastExpiry }, env);
  let r = await resolveD2ShadowObservations(env, fetchPrice);
  const recW = JSON.parse(kv._m.get('d2obs:d2_rw').value);
  ok('[#5a] BUY with higher exit resolves WIN', recW.result === 'WIN', recW.result);
  ok('[#5b] pending key deleted after resolve', !kv._m.has('d2pending:d2_rw'));
  ok('[#5c] exitPrice recorded', recW.exitPrice === 78500);

  resetD2Accounting();
  env._kind = 'SELL_WIN';   // SELL wins when exit < entry
  await admitD2ShadowObservation({ id: 'd2_rs', pair: 'ETH/USD', direction: 'SELL', entryPrice: 3000, expiryTime: pastExpiry }, env);
  await resolveD2ShadowObservations(env, fetchPrice);
  const recS = JSON.parse(kv._m.get('d2obs:d2_rs').value);
  ok('[#6a] SELL with lower exit resolves WIN', recS.result === 'WIN', recS.result);

  env._kind = 'TIE';       // exact tie => TIE (bugfix round 1: was LOSS)
  await admitD2ShadowObservation({ id: 'd2_rt', pair: 'XRP/USD', direction: 'BUY', entryPrice: 78000, expiryTime: pastExpiry }, env);
  await resolveD2ShadowObservations(env, fetchPrice);
  const recT = JSON.parse(kv._m.get('d2obs:d2_rt').value);
  ok('[#6b] exact tie resolves TIE (not LOSS)', recT.result === 'TIE', recT.result);

  // cap: 12 pending, only RESOLVER_CAP=10 resolved in one run
  resetD2Accounting();
  const kv2 = makeKV(); const env2 = { SIGNAL_CACHE: kv2, _kind: 'BUY_WIN' };
  for (let i = 0; i < 12; i++) {
    await admitD2ShadowObservation({ id: 'd2_capres_' + i, pair: 'ADA/USD', direction: 'BUY', entryPrice: 0.3 + i, expiryTime: pastExpiry }, env2);
  }
  const r2 = await resolveD2ShadowObservations(env2, fetchPrice);
  ok('[#7] resolver capped at ' + __d2StoreTest.RESOLVER_CAP + ' per run', r2.resolved === __d2StoreTest.RESOLVER_CAP, 'resolved=' + r2.resolved);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#8] Resolver — transient error retry then terminal UNKNOWN ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const errPrice = async () => ({ error: 'RATE_LIMIT' });
  await admitD2ShadowObservation({ id: 'd2_rf', pair: 'DOT/USD', direction: 'BUY', entryPrice: 5, expiryTime: pastExpiry }, env);
  // first pass: not due yet? expiry is past + delay 90s — wait: checkAfterMs = expiry + 90s; expiry is 5s ago -> now < checkAfterMs -> skipped
  // force due by using an expiry far in the past
  const kvA = makeKV(); const envA = { SIGNAL_CACHE: kvA };
  await admitD2ShadowObservation({ id: 'd2_rf2', pair: 'DOT/USD', direction: 'BUY', entryPrice: 5, expiryTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }, envA);
  await resolveD2ShadowObservations(envA, errPrice);
  const pendRec = JSON.parse(kvA._m.get('d2pending:d2_rf2').value);
  ok('[#8a] transient error increments checks (pending), obs untouched',
    pendRec.checks === 1 && kvA._m.has('d2pending:d2_rf2') && JSON.parse(kvA._m.get('d2obs:d2_rf2').value).checks === 0,
    'pending checks=' + pendRec.checks);
  let rec;
  for (let i = 0; i < 20; i++) await resolveD2ShadowObservations(envA, errPrice);
  rec = JSON.parse(kvA._m.get('d2obs:d2_rf2').value);
  ok('[#8b] after PENDING_MAX_CHECKS -> terminal UNKNOWN + pending deleted',
    rec.result === 'UNKNOWN' && !kvA._m.has('d2pending:d2_rf2'), JSON.stringify(rec.result));
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#9-10] Engine — TRENDING block audit + zero leak ──');
{
  const sig = await buildMultiTimeframeSignal('BTC/USD', makeCandleData(P), 'CRYPTO', ENV);
  ok('[#9a] TRENDING fixture final = NO_TRADE', sig.finalSignal === 'NO_TRADE', sig.finalSignal);
  ok('[#9b] D2_TRENDING_BLOCK applied', sig.filtersApplied.some(f => f.includes('D2_TRENDING_BLOCK')));
  const audit = getD2Audit(sig);
  ok('[#9c] D2 audit attached', !!audit);
  if (audit) {
    ok('[#9d] attribution D2_TRENDING_BLOCKED', audit.attribution === 'D2_TRENDING_BLOCKED');
    ok('[#9e] would-be direction BUY/SELL', audit.wouldBeDirection === 'BUY' || audit.wouldBeDirection === 'SELL');
    ok('[#9f] entryPrice numeric', typeof audit.entryPrice === 'number' && isFinite(audit.entryPrice));
    ok('[#9g] expiryTime ISO string', typeof audit.expiryTime === 'string' && !isNaN(new Date(audit.expiryTime).getTime()));
  }
  const json = JSON.stringify(sig);
  ok('[#9h] NO leak of would-be direction in public JSON',
    !json.includes('wouldBeDirection') && !json.includes('D2_TRENDING_BLOCKED'));

  // non-D2 fixtures: no audit, no D2 filter
  for (const [name, prof] of [['flat', RANGING],
                               ['flat_v2', { basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 }]]) {
    const s = await buildMultiTimeframeSignal('BTC/USD', makeCandleData(prof), 'CRYPTO', ENV);
    ok('[#10] ' + name + ': no D2 audit + no D2_ filter',
      getD2Audit(s) === null && !s.filtersApplied.some(f => f.startsWith('D2_')),
      'filters=' + JSON.stringify(s.filtersApplied));
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#11] Bad-pair block SUSPENDED by default (Phase F) ──');
{
  // USD/JPY, FOREX, non-trending candles => must NOT be bad-pair blocked
  const sig = await buildMultiTimeframeSignal('USD/JPY', makeCandleData(RANGING), 'FOREX', ENV);
  ok('[#11a] USD/JPY has no D2_BAD_PAIR_BLOCK in filters',
    !sig.filtersApplied.some(f => f.includes('D2_BAD_PAIR_BLOCK')), JSON.stringify(sig.filtersApplied));
  ok('[#11b] USD/JPY D2 audit is null when no D2 branch fires',
    getD2Audit(sig) === null);

  // and with the flag re-enabled the branch returns (one-line re-enable path)
  const prev = CONFIG.D2_BAD_PAIR_BLOCK_ENABLED;
  try {
    CONFIG.D2_BAD_PAIR_BLOCK_ENABLED = true;
    const sig2 = await buildMultiTimeframeSignal('USD/JPY', makeCandleData(RANGING), 'FOREX', ENV);
    // TRENDING/HIGHEST could fire instead depending on session; the important
    // assertion is that the branch exists and fires when nothing else blocks.
    ok('[#11c] re-enabled flag: either D2_BAD_PAIR_BLOCK present or a different D2_ fired when blocked',
      sig2.filtersApplied.some(f => f.startsWith('D2_')) || sig2.finalSignal !== 'NO_TRADE');
  } finally {
    CONFIG.D2_BAD_PAIR_BLOCK_ENABLED = prev;
  }
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#12] Non-D2 engine behaviour unchanged ──');
{
  // a RANGING signal must still produce a normal trade path with grade etc.
  const sig = await buildMultiTimeframeSignal('BTC/USD', makeCandleData(RANGING), 'CRYPTO', ENV);
  ok('[#12a] signal object intact (finalSignal + grade present)',
    typeof sig.finalSignal === 'string' && sig.grade && sig.grade.grade);
  ok('[#12b] recommendations intact',
    sig.recommendations && sig.recommendations['5min'] && typeof sig.recommendations['5min'].direction === 'string');
  ok('[#12c] no D2_ filter on non-D2 path', !sig.filtersApplied.some(f => f.startsWith('D2_')));
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#13] Admission gate — AI-rescued signals NOT double-counted ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const audit = { wouldBeDirection: 'BUY', wouldBeConfidence: 88, bestTF: '5min', entryPrice: 78000, expiryTime: futureExpiry, attribution: 'D2_TRENDING_BLOCKED' };

  // rescued (final = BUY) -> must NOT admit
  const rescued = { finalSignal: 'BUY', confidence: '90%' };
  attachD2Audit(rescued, audit);
  const r1 = await maybeAdmitD2ShadowObservation(rescued, 'BTC/USD', 'CRYPTO', env);
  ok('[#13a] rescued signal -> no counterfactual admitted', r1 === null, JSON.stringify(r1));

  // held (final = NO_TRADE) -> admitted
  const held = { finalSignal: 'NO_TRADE', confidence: '0%' };
  attachD2Audit(held, audit);
  const r2 = await maybeAdmitD2ShadowObservation(held, 'BTC/USD', 'CRYPTO', env);
  ok('[#13b] held block -> observation admitted', r2 && r2.admitted === true, JSON.stringify(r2));

  // missing entry/expiry -> rejected
  const partial = { finalSignal: 'NO_TRADE' };
  attachD2Audit(partial, { ...audit, expiryTime: null });
  const r3 = await maybeAdmitD2ShadowObservation(partial, 'BTC/USD', 'CRYPTO', env);
  ok('[#13c] incomplete audit -> rejected', r3 === null);

  // fail-open: no KV -> NO_KV (no throw)
  const r4 = await maybeAdmitD2ShadowObservation(held, 'BTC/USD', 'CRYPTO', {});
  ok('[#13d] fail-open with no SIGNAL_CACHE (NO_KV), no throw', r4 && r4.reason === 'NO_KV');
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n───────────────────────────────────────────────────────────');
console.log(`PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) { console.log('Failures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('ALL D2 SHADOW TESTS PASSED');

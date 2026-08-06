/**
 * Forex SELL Probe — mandatory test suite.
 *   node scripts/probe_tests.mjs
 *
 * Covers:
 *   [#1-4]  probeStore isolation / invalid input / dedup / cap
 *   [#5-7]  resolver: WIN / LOSS / tie + FLIPPED counterfactual correctness
 *   [#8]    resolver transient-error -> retry then terminal UNKNOWN
 *   [#9]    engine: FOREX SELL attaches probe audit + zero JSON leak
 *   [#10]   non-forex / non-SELL signals carry no probe audit
 *   [#11]   admission gate: only FOREX SELL admitted; fail-open no KV
 *
 * Real module integration, no network, no AI (env={} deterministic). KV is an
 * in-memory double.
 */

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

const { buildMultiTimeframeSignal } = await import('../src/signal/engine.js');
const { attachProbeAudit, getProbeAudit, maybeAdmitForexSellProbe } = await import('../src/signal/probeShadow.js');
const {
  admitProbeObservation, resolveProbeObservations,
  getProbeAccounting, resetProbeAccounting, __probeStoreTest,
} = await import('../src/history/probeStore.js');
const { makeCandleData } = await import('./r71_fixtures.mjs');

const ENV = {};
const FX_SELL = { basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 };   // -> EUR/USD SELL

const pastExpiry = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#1] Store isolation — probe: namespace never touches other KV ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const seeds = {
    'sig:EUR_USD': JSON.stringify([{ id: 'n1', pair: 'EUR/USD', direction: 'SELL' }]),
    'stats:EUR_USD': JSON.stringify({ pair: 'EUR/USD', wins: 5 }),
    'cb:EUR_USD': JSON.stringify({ lossStreak: 1 }),
    'shadow:obs:r71_1': JSON.stringify({ id: 'r71_1', result: 'WIN' }),
    'd2obs:d2_1': JSON.stringify({ id: 'd2_1', result: 'LOSS' }),
    'latest:EUR_USD': JSON.stringify({ pair: 'EUR/USD' }),
  };
  for (const [k, v] of Object.entries(seeds)) kv._m.set(k, { value: v, opts: {} });
  const before = Object.fromEntries(Object.entries(seeds));

  await admitProbeObservation({
    id: 'probe_t1', pair: 'EUR/USD', assetType: 'FOREX', direction: 'SELL',
    entryPrice: 1.08, expiryTime: futureExpiry, shadowConfidence: 80,
    auditSummary: { regime: 'RANGING', sessionQuality: 'HIGH', higherTFTrend: null, alignment: 'ALL_BEARISH', rsi: 70 },
  }, env);

  const newKeys = [...kv._m.keys()].filter(k => !(k in before));
  ok('[#1a] only probe: keys created', newKeys.every(k => k.startsWith('probe:obs:') || k.startsWith('probe:pending:') || k.startsWith('probe:idx:')),
    'new: ' + newKeys.join(', '));
  let untouched = true;
  for (const k of Object.keys(before)) if (kv._m.get(k).value !== before[k]) untouched = false;
  ok('[#1b] seeded sig/stats/cb/shadow/d2/latest keys untouched', untouched);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#2] Invalid input rejected ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const base = { id: 'probe_x', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.08, expiryTime: futureExpiry };
  for (const [label, mut] of [
    ['no id', o => delete o.id],
    ['no pair', o => delete o.pair],
    ['no direction', o => delete o.direction],
    ['no expiry', o => delete o.expiryTime],
  ]) {
    const o = { ...base }; mut(o);
    const r = await admitProbeObservation(o, env);
    ok('[#2] rejected: ' + label, r.admitted === false && r.reason === 'INVALID_INPUT');
  }
  ok('[#2] nothing written', kv._m.size === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#3] Dedup — same pair+direction+nearby entry within 2h ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const r1 = await admitProbeObservation({ id: 'probe_d1', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.08001, expiryTime: futureExpiry }, env);
  const r2 = await admitProbeObservation({ id: 'probe_d2', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.08002, expiryTime: futureExpiry }, env);
  const r3 = await admitProbeObservation({ id: 'probe_d3', pair: 'EUR/USD', direction: 'BUY', entryPrice: 1.08001, expiryTime: futureExpiry }, env);
  ok('[#3a] first admitted', r1.admitted === true);
  ok('[#3b] near-identical SELL rejected as DEDUP', r2.admitted === false && r2.reason === 'DEDUP');
  ok('[#3c] different direction admitted', r3.admitted === true);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#4] Cap — max per pair per rolling 30d ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  let admitted = 0;
  for (let i = 0; i < __probeStoreTest.MAX_PER_PAIR_30D + 2; i++) {
    const r = await admitProbeObservation({
      id: 'probe_cap_' + i, pair: 'GBP/USD', direction: i % 2 ? 'SELL' : 'BUY',
      entryPrice: 1.3 + i * 0.001, expiryTime: futureExpiry,
    }, env);
    if (r.admitted) admitted++;
  }
  ok('[#4] admitted exactly ' + __probeStoreTest.MAX_PER_PAIR_30D + ' (cap)',
    admitted === __probeStoreTest.MAX_PER_PAIR_30D, 'admitted=' + admitted);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#5-7] Resolver — WIN/LOSS/tie + FLIPPED counterfactual ──');
{
  const fetchPrice = async (pair, expiry, e) => ({ price: e._px });
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv, _px: 1.085 };  // SELL entry 1.08, exit 1.085 -> SELL LOSS, flipped BUY WIN

  // SELL loss (exit > entry)
  await admitProbeObservation({ id: 'probe_r1', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.08, expiryTime: pastExpiry }, env);
  await resolveProbeObservations(env, fetchPrice);
  const rec1 = JSON.parse(kv._m.get('probe:obs:probe_r1').value);
  ok('[#5a] SELL with higher exit = LOSS (actual)', rec1.result === 'LOSS', rec1.result);
  ok('[#5b] flipped BUY = WIN', rec1.flippedResult === 'WIN', rec1.flippedResult);
  ok('[#5c] pending deleted', !kv._m.has('probe:pending:probe_r1'));

  // SELL win (exit < entry)
  env._px = 1.075;
  await admitProbeObservation({ id: 'probe_r2', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.09, expiryTime: pastExpiry }, env);
  await resolveProbeObservations(env, fetchPrice);
  const rec2 = JSON.parse(kv._m.get('probe:obs:probe_r2').value);
  ok('[#6a] SELL with lower exit = WIN (actual)', rec2.result === 'WIN', rec2.result);
  ok('[#6b] flipped BUY = LOSS', rec2.flippedResult === 'LOSS', rec2.flippedResult);

  // tie (exit == entry) -> TIE (bugfix round 1: was LOSS for both directions)
  env._px = 1.10;
  await admitProbeObservation({ id: 'probe_r3', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.10, expiryTime: pastExpiry }, env);
  await resolveProbeObservations(env, fetchPrice);
  const rec3 = JSON.parse(kv._m.get('probe:obs:probe_r3').value);
  ok('[#6c] tie -> TIE (not LOSS)', rec3.result === 'TIE', rec3.result);
  ok('[#6d] tie -> flipped stays UNKNOWN (no flip on a tie)', rec3.flippedResult === 'UNKNOWN', rec3.flippedResult);

  // cap per run
  resetProbeAccounting();
  const kv2 = makeKV(); const env2 = { SIGNAL_CACHE: kv2, _px: 1.085 };
  for (let i = 0; i < 12; i++) {
    await admitProbeObservation({ id: 'probe_capres_' + i, pair: 'USD/JPY', direction: 'SELL', entryPrice: 155 + i, expiryTime: pastExpiry }, env2);
  }
  const r2 = await resolveProbeObservations(env2, fetchPrice);
  ok('[#7] resolver capped at ' + __probeStoreTest.RESOLVER_CAP + ' per run', r2.resolved === __probeStoreTest.RESOLVER_CAP, 'resolved=' + r2.resolved);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#8] Resolver — transient error retry then terminal UNKNOWN ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const errPrice = async () => ({ error: 'RATE_LIMIT' });
  await admitProbeObservation({ id: 'probe_rf', pair: 'AUD/USD', direction: 'SELL', entryPrice: 0.7, expiryTime: new Date(Date.now() - 10 * 60 * 1000).toISOString() }, env);
  await resolveProbeObservations(env, errPrice);
  const pend = JSON.parse(kv._m.get('probe:pending:probe_rf').value);
  ok('[#8a] transient error increments checks (pending)', pend.checks === 1 && kv._m.has('probe:pending:probe_rf'));
  for (let i = 0; i < 20; i++) await resolveProbeObservations(env, errPrice);
  const obs = JSON.parse(kv._m.get('probe:obs:probe_rf').value);
  ok('[#8b] after PENDING_MAX_CHECKS -> UNKNOWN + pending deleted',
    obs.result === 'UNKNOWN' && obs.flippedResult === 'UNKNOWN' && !kv._m.has('probe:pending:probe_rf'));
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#9-10] Engine — FOREX SELL audit attach + no leak; others carry none ──');
{
  const sig = await buildMultiTimeframeSignal('EUR/USD', makeCandleData(FX_SELL), 'FOREX', ENV);
  ok('[#9a] fixture final = SELL', sig.finalSignal === 'SELL', sig.finalSignal);
  const audit = getProbeAudit(sig);
  ok('[#9b] probe audit attached on FOREX SELL', !!audit);
  if (audit) {
    ok('[#9c] attribution FOREX_SELL_PROBE', audit.attribution === 'FOREX_SELL_PROBE');
    ok('[#9d] direction SELL', audit.direction === 'SELL');
    ok('[#9e] context: regime + sessionQuality + alignment present',
      !!audit.regime && !!audit.sessionQuality && !!audit.alignment);
    ok('[#9f] entryPrice + expiryTime present', typeof audit.entryPrice === 'number' && !!audit.expiryTime);
  }
  ok('[#9g] NO leak in public JSON', !JSON.stringify(sig).includes('FOREX_SELL_PROBE') && !JSON.stringify(sig).includes('probe.audit'));

  // CRYPTO SELL -> no audit
  const crSig = await buildMultiTimeframeSignal('BTC/USD', makeCandleData({ basePrice: 78000, vol: 60, trend: 18, seed: 11 }), 'CRYPTO', ENV);
  ok('[#10a] CRYPTO signal carries no probe audit', getProbeAudit(crSig) === null);

  // FOREX non-SELL (BUY or NO_TRADE) -> no audit
  const fxBuy = await buildMultiTimeframeSignal('EUR/USD', makeCandleData({ basePrice: 1.08, vol: 0.002, trend: 0.0004, seed: 44 }), 'FOREX', ENV);
  ok('[#10b] non-SELL forex carries no probe audit', getProbeAudit(fxBuy) === null, 'final=' + fxBuy.finalSignal);
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#11] Admission gate — only FOREX SELL admitted; fail-open ──');
{
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  const audit = { attribution: 'FOREX_SELL_PROBE', direction: 'SELL', confidence: 80, bestTF: '15min', entryPrice: 1.08, expiryTime: futureExpiry, regime: 'RANGING', sessionQuality: 'HIGH', higherTFTrend: null, alignment: 'ALL_BEARISH', rsi: 70 };

  // FOREX SELL -> admitted
  const sellSig = { finalSignal: 'SELL' };
  attachProbeAudit(sellSig, audit);
  const r1 = await maybeAdmitForexSellProbe(sellSig, 'EUR/USD', 'FOREX', env);
  ok('[#11a] FOREX SELL admitted', r1 && r1.admitted === true, JSON.stringify(r1));

  // non-forex -> rejected
  const r2 = await maybeAdmitForexSellProbe(sellSig, 'BTC/USD', 'CRYPTO', env);
  ok('[#11b] CRYPTO rejected', r2 === null);

  // no audit -> rejected
  const r3 = await maybeAdmitForexSellProbe({ finalSignal: 'SELL' }, 'EUR/USD', 'FOREX', env);
  ok('[#11c] no audit rejected', r3 === null);

  // fail-open no KV
  const r4 = await maybeAdmitForexSellProbe(sellSig, 'EUR/USD', 'FOREX', {});
  ok('[#11d] no SIGNAL_CACHE -> NO_KV, no throw', r4 && r4.reason === 'NO_KV');
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n───────────────────────────────────────────────────────────');
console.log(`PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) { console.log('Failures:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('ALL PROBE TESTS PASSED');

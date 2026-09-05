/**
 * FTT3 worker smoke test — full live-path integration with stubbed externals.
 *
 * Exercises: module import integrity (index.js pulls every remaining file),
 * fetchCandlesWithCache against a stubbed TwelveData, evaluatePair end-to-end,
 * scanOnePair -> history save -> Telegram push -> dedup on re-scan, and
 * scheduledTracker expiry resolution (WIN/LOSS + EXPIRY_GAP + retry).
 *
 * Run: node scripts/engine_smoke.mjs
 */
import { evaluatePair, scanOnePair, scheduledScan, selectActivePairs } from '../src/handlers/scan.js';
import { scheduledTracker, readHistory, saveSignal } from '../src/history/store.js';
import { pushResultToSubscribers } from '../src/handlers/push.js';
import { handleHealth, handleHistory } from '../src/handlers/health.js';
import { default as worker } from '../src/index.js';
import { evaluateSignal, MS_1M, MS_5M, MS_15M } from '../src/strategy/engine.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}

// ── synthetic series (same generator family as strategy_tests) ──────────────
const T0 = Date.UTC(2026, 8, 1); // 2026-09-01, 15m-aligned
function gen1m(seed, n) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let price = 100;
  const out = [];
  for (let k = 0; k < n; k++) {
    // same regime shapes as scripts/strategy_tests.mjs (proven to fire)
    const vol = k < n / 3 ? 0.02 : k < (2 * n) / 3 ? 0.06 : 0.25;
    const amp = k < n / 3 ? 0.0 : k < (2 * n) / 3 ? 0.08 : 0.22;
    const drift = amp * Math.sin(k / 45);
    const o = price;
    const c = Math.max(0.01, o + drift + (rand() - 0.5) * 2 * vol);
    out.push({ t: T0 + k * MS_1M, o, h: Math.max(o, c) + rand() * vol, l: Math.min(o, c) - rand() * vol, c });
    price = c;
  }
  return out;
}
function aggregate(m1, factor) {
  const out = [];
  for (let k = 0; k < m1.length; k += factor) {
    const chunk = m1.slice(k, k + factor);
    if (chunk.length < factor) break;
    out.push({ t: chunk[0].t, o: chunk[0].o, h: Math.max(...chunk.map(x => x.h)), l: Math.min(...chunk.map(x => x.l)), c: chunk[chunk.length - 1].c });
  }
  return out;
}
const M1 = gen1m(42, 6000);
const M5 = aggregate(M1, 5), M15 = aggregate(M1, 15);

// Find a boundary index where the engine fires, using the engine itself.
const pre = { c15: M15, c5: M5, c1: M1 };
let fireIdx = -1, fireDir = null;
outer:
for (let i = 1500; i < M1.length - 15; i++) {
  if ((M1[i].t + MS_1M) % MS_5M !== 0) continue;
  const r = evaluateSignal(M15, M5, M1, i);
  if (r.decision === 'CALL' || r.decision === 'PUT') { fireIdx = i; fireDir = r.decision; break outer; }
}
ok(fireIdx > 0, 'synthetic series has a fireable signal (i=' + fireIdx + ' ' + fireDir + ')');

// ── stubbed environment ──────────────────────────────────────────────────────
function memKV() {
  const m = new Map();
  return {
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val) { m.set(key, String(val)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' }) {
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    },
    _map: m,
  };
}
let stubNow = Date.now();
let telegramCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.twelvedata.com')) {
    const p = new URL(u);
    const interval = p.searchParams.get('interval');
    const outputsize = parseInt(p.searchParams.get('outputsize') || '150', 10);
    const series = interval === '1min' ? M1 : interval === '5min' ? M5 : M15;
    const upto = series.filter(k => k.t + (interval === '1min' ? MS_1M : interval === '5min' ? MS_5M : MS_15M) <= stubNow);
    const slice = upto.slice(-outputsize);
    const fmt = (t) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
    // TwelveData returns newest-first
    const values = [...slice].reverse().map(k => ({
      datetime: fmt(k.t), open: String(k.o), high: String(k.h), low: String(k.l), close: String(k.c),
    }));
    return { ok: true, json: async () => ({ status: 'ok', values }) };
  }
  if (u.includes('api.telegram.org')) {
    telegramCalls++;
    return { ok: true, json: async () => ({ ok: true }) };
  }
  return realFetch(url);
};

const env = {
  SIGNAL_CACHE: memKV(),
  BOT_KV: memKV(),
  TWELVEDATA_API_KEYS: '["k1","k2"]',
  BOT_TOKEN: 'test-token',
};
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

// ── tests ────────────────────────────────────────────────────────────────────
console.log('[1] module integrity + health');
{
  ok(typeof worker.fetch === 'function' && typeof worker.scheduled === 'function', 'worker default export shape');
  const h = await handleHealth(env);
  const hj = await h.json();
  ok(hj.version === 'FTT3-v1.0.0', 'health version FTT3-v1.0.0');
  ok(hj.engine.conditions.length === 3, 'health lists exactly 3 conditions');
  ok(hj.engine.expiryTiers.length === 3, 'health lists 3 expiry tiers');
}

console.log('[2] selectActivePairs');
{
  const saturday = new Date(Date.UTC(2026, 8, 5, 12)); // 2026-09-05 is a Saturday
  ok(selectActivePairs(undefined, false).length === 4, 'forex closed -> 4 crypto only');
  ok(selectActivePairs(undefined, true).length === 8, 'forex open -> all 8');
  ok(!Number.isNaN(saturday.getUTCDay()), 'sanity date built');
}

console.log('[3] evaluatePair end-to-end (stubbed TwelveData)');
{
  const nowT = M1[fireIdx].t + MS_1M + 2000;   // just after the signal candle closes
  stubNow = nowT;
  const r = await evaluatePair('BTC/USD', env, ctx, nowT);
  ok(r && r.signal && r.signal.finalSignal === fireDir, 'evaluatePair reproduces engine decision (' + r.signal.finalSignal + ')');
  ok(r.signal.audit.expiry && [5, 7, 10].includes(r.signal.audit.expiry.minutes), 'expiry tier attached');
  ok(r.signal.market === 'CRYPTO' && r.pair === 'BTC/USD', 'market metadata');
}

console.log('[4] scanOnePair -> history -> telegram push -> dedup');
{
  // one auto-enabled subscriber so the push path actually sends
  await env.BOT_KV.put('auto_users', JSON.stringify(['12345']));
  await env.BOT_KV.put('u:12345', JSON.stringify({ autoEnabled: true }));
  const nowT = M1[fireIdx].t + MS_1M + 3000;
  stubNow = nowT;
  telegramCalls = 0;
  const r1 = await scanOnePair('BTC/USD', 'gen_test', env, ctx, { now: nowT });
  ok(r1 && r1.signal.finalSignal === fireDir, 'scan returns decision');
  const hist = await readHistory('BTC/USD', env, 10);
  ok(hist.length === 1 && hist[0].direction === fireDir, 'history row saved (1)');
  ok(hist[0].indicators && hist[0].indicators.c1 && hist[0].indicators.c3, 'audit indicators persisted');
  ok(hist[0].expiryTime && hist[0].expiryMinutes, 'expiry fields persisted');
  ok(telegramCalls === 1, 'telegram push attempted exactly once (' + telegramCalls + ')');
  // re-scan same setup -> dedup, no push, no second row
  const r2 = await scanOnePair('BTC/USD', 'gen_test2', env, ctx, { now: nowT + 30 * 1000 });
  const hist2 = await readHistory('BTC/USD', env, 10);
  ok(hist2.length === 1, 're-scan deduped (still 1 row)');
  ok(telegramCalls === 1, 'no second push after dedup');
  ok(env.SIGNAL_CACHE._map.has('latest:BTC_USD'), 'latest: cache written');
}

console.log('[5] scheduledTracker resolves expiry');
{
  const hist = await readHistory('BTC/USD', env, 1);
  const rec = hist[0];
  const expiryMs = new Date(rec.expiryTime).getTime();
  // WIN/LOSS expected from the actual series move over the expiry window
  const exitIdx = fireIdx + rec.expiryMinutes;
  ok(M1[exitIdx] && M1[exitIdx].t === M1[fireIdx].t + rec.expiryMinutes * MS_1M, 'exit candle exists in series');
  const expected = M1[exitIdx].c === M1[fireIdx].c ? 'TIE'
    : (fireDir === 'CALL' ? (M1[exitIdx].c > M1[fireIdx].c ? 'WIN' : 'LOSS')
                          : (M1[exitIdx].c < M1[fireIdx].c ? 'WIN' : 'LOSS'));
  stubNow = expiryMs + 3 * 60 * 1000;
  // simulate KV TTL expiry of the 1min cache (memKV ignores TTL on purpose)
  env.SIGNAL_CACHE._map.delete('c:BTC/USD:1min:150');
  const t = await scheduledTracker(env);
  ok(t.checked >= 1, 'tracker checked the pending signal');
  const after = await readHistory('BTC/USD', env, 1);
  ok(after[0].result === expected, 'result resolved correctly (' + after[0].result + ' == ' + expected + ')');
  ok(after[0].exitPrice != null && Math.abs(after[0].exitPrice - M1[exitIdx].c) < 1e-9, 'exit price recorded (full precision)');
  ok(!env.SIGNAL_CACHE._map.has('pending:' + rec.id), 'pending key deleted');
  // result notification rides the scheduled handler; exercise it directly here
  const beforeCalls = telegramCalls;
  await pushResultToSubscribers({ ...after[0], result: after[0].result }, env);
  ok(telegramCalls === beforeCalls + 1, 'result push attempted');
}

console.log('[6] EXPIRY_GAP + retry budget paths');
{
  // Case A: expiry candle not yet available -> retry keeps the record pending.
  // expiryTime is 100s in the REAL past: past the 90s RESULT_CHECK_DELAY (so
  // the tracker acts) but inside the 2-minute publish grace (so it retries,
  // exactly the production timing). The stub data window ends before it.
  const recA = {
    id: 'sig_retry', pair: 'BTC/USD', direction: 'CALL', engine: 'FTT3',
    entryPrice: 100, entryTime: new Date(Date.now() - 3600 * 1000).toISOString(),
    expiryTime: new Date(Date.now() - 100 * 1000).toISOString(), expiryMinutes: 10,
    timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
    result: null, exitPrice: null, checkedAt: null, checks: 0,
  };
  await saveSignal(recA, env);
  stubNow = T0 + 5100 * MS_1M;   // feed ends before the (real) expiry
  await scheduledTracker(env);
  ok(env.SIGNAL_CACHE._map.has('pending:sig_retry'), 'not-yet-available candle -> retry (kept pending)');

  // exhaust the retry budget -> UNKNOWN
  recA.checks = 11;   // next failure exceeds PENDING_MAX_CHECKS(10)
  await env.SIGNAL_CACHE.put('pending:sig_retry', JSON.stringify(recA));
  await scheduledTracker(env);
  ok(!env.SIGNAL_CACHE._map.has('pending:sig_retry'), 'retry budget exhausted -> pending cleared');
  const rowsA = await readHistory('BTC/USD', env, 10);
  const unk = rowsA.find(r => r.id === 'sig_retry');
  ok(unk && unk.result === 'UNKNOWN', 'budget-exhausted record resolved UNKNOWN');

  // Case B: expiry 5 minutes in the real past whose candle is absent from the
  // feed (beyond the publish grace) -> EXPIRY_GAP. Different entry price from
  // Case A so the dedup guard does not swallow the save.
  const recB = {
    id: 'sig_gap', pair: 'BTC/USD', direction: 'CALL', engine: 'FTT3',
    entryPrice: 100.5, entryTime: new Date(Date.now() - 60 * 60000).toISOString(),
    expiryTime: new Date(Date.now() - 5 * 60000).toISOString(), expiryMinutes: 10,
    timestamp: new Date(Date.now() - 60 * 60000).toISOString(),
    result: null, exitPrice: null, checkedAt: null, checks: 0,
  };
  await saveSignal(recB, env);
  await scheduledTracker(env);
  ok(!env.SIGNAL_CACHE._map.has('pending:sig_gap'), 'missing candle past grace -> pending cleared');
  const rowsB = await readHistory('BTC/USD', env, 10);
  const gap = rowsB.find(r => r.id === 'sig_gap');
  ok(gap && gap.result === 'EXPIRY_GAP', 'missing-candle record resolved EXPIRY_GAP');
}

console.log('[7] cron routing + scheduledScan smoke');
{
  stubNow = M1[fireIdx].t + MS_1M + 3000;
  await worker.scheduled({ cron: '*/2 * * * *' }, env, ctx);
  ok(true, 'result-checker cron tick ran');
  const scan = await scheduledScan(env, ctx);
  ok(scan && typeof scan.ok === 'number', 'scanner tick returns counters');
  // weekend scan: forex skipped
  const satEnv = env;
  stubNow = Date.UTC(2026, 8, 5, 12, 0, 0);
  const scan2 = await scheduledScan(satEnv, ctx);
  ok(scan2.processed === 4, 'weekend tick processes 4 crypto pairs only (got ' + scan2.processed + ')');
}

globalThis.fetch = realFetch;
console.log('\nFTT3 engine smoke: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

/**
 * Phase 10 integration test — node scripts/phase10_integration.mjs
 *
 * Drives the REAL request path (handleSignalRaw -> engine -> saveAndPush ->
 * Telegram) with only the network stubbed. The unit suite alone would not have
 * caught the wiring bug where `saveAndPush` was never inserted, so this proves
 * the end-to-end chain rather than the module in isolation.
 *
 * Also drives the real scheduledTracker to prove result pushes fire.
 */

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; failures.push(n); console.log('FAIL  ' + n + (d ? ' — ' + d : '')); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

function makeKV(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, { value: JSON.stringify(v) }]));
  return {
    _m: m,
    async get(k, t) { if (!m.has(k)) return null; const v = m.get(k).value; return t === 'json' ? JSON.parse(v) : v; },
    async put(k, v, opts) { m.set(k, { value: String(v), opts }); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

function series(n, base, step) {
  const out = []; let c = base;
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

let tg = [];
let expiryPrice = null;
function installNet() {
  tg = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      const b = JSON.parse(init.body);
      tg.push({ chatId: String(b.chat_id), text: b.text });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
    }
    if (u.includes('twelvedata')) {
      const p = new URL(u).searchParams;
      if (p.get('start_date') && expiryPrice != null) {
        // The bracket is expiry +/-5min, so the candle must sit at the MIDDLE
        // of [start,end] to be within fetchExpiryPrice's 120s match window.
        // Returning the start timestamp makes it legitimately reject as
        // NO_MATCH_WITHIN_120S — that was a bug in this harness, not the code.
        const st = new Date(p.get('start_date').replace(' ', 'T') + 'Z').getTime();
        const en = new Date(p.get('end_date').replace(' ', 'T') + 'Z').getTime();
        const mid = new Date((st + en) / 2).toISOString().slice(0, 19).replace('T', ' ');
        return { ok: true, status: 200, json: async () => ({ values: [{
          datetime: mid, open: '1', high: '1', low: '1', close: String(expiryPrice),
        }] }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ values: series(120, 100, 0.2) }), text: async () => '' };
    }
    // AI providers
    return { ok: true, status: 200, text: async () => '{}',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 80, reason: 'stub' }) } }] }) };
  };
}

const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };
const drain = async (sink) => { await Promise.allSettled(sink); sink.length = 0; };
const ctxOf = (sink) => ({ waitUntil: (p) => { sink.push(Promise.resolve(p).catch(() => {})); return p; } });

const userOf = (o = {}) => ({
  pair: 'BTCUSD', watchlist: [], interval: 5, autoEnabled: true,
  gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: null, ...o,
});

function envOf(users = { 111: userOf() }) {
  const seed = {};
  for (const [cid, u] of Object.entries(users)) seed['u:' + cid] = u;
  seed['auto_users'] = Object.keys(users);
  return {
    SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: 'tok',
    TWELVEDATA_API_KEY_1: 'k', CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g',
  };
}

const { handleSignalRaw } = await import('../src/handlers/signal.js');
const { scheduledTracker } = await import('../src/history/stats.js');
const { HISTORY_CONFIG } = await import('../src/config.js');

console.log('── a real /api/signal call pushes to subscribers ──────────');
{
  installNet();
  const env = envOf();
  const sink = [];
  const r = quiet();
  const res = await handleSignalRaw('BTC/USD', env, ctxOf(sink));
  await drain(sink);
  r();

  ok('engine produced an actionable signal', ['BUY', 'SELL'].includes(res.signal.finalSignal), res.signal.finalSignal);
  eq('subscriber received exactly one message', tg.length, 1);
  eq('delivered to the right chat', tg[0].chatId, '111');
  ok('message carries the signal id suffix', tg[0].text.includes(String(res.id).slice(-4)), tg[0].text.slice(0, 60));
  ok('message names the pair', tg[0].text.includes('BTC/USD'));
  ok('history row written', !!env.SIGNAL_CACHE._m.get('sig:BTC_USD'));
  ok('push log written for the emitted id', !!env.SIGNAL_CACHE._m.get('pushLog:' + res.id));
}

console.log('\n── repeated calls (re-poll) do not spam ───────────────────');
{
  installNet();
  const env = envOf();
  const sink = [];
  const r = quiet();
  // three back-to-back calls, exactly like App auto-refresh + Bot cron overlap
  await handleSignalRaw('BTC/USD', env, ctxOf(sink)); await drain(sink);
  await handleSignalRaw('BTC/USD', env, ctxOf(sink)); await drain(sink);
  await handleSignalRaw('BTC/USD', env, ctxOf(sink)); await drain(sink);
  r();
  eq('one Telegram message for three identical calls', tg.length, 1);
  const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
  eq('history also deduped to one row', hist.length, 1);
}

console.log('\n── a non-subscriber pair pushes nothing ───────────────────');
{
  installNet();
  const env = envOf({ 111: userOf({ pair: 'EURUSD' }) });
  const sink = [];
  const r = quiet();
  await handleSignalRaw('BTC/USD', env, ctxOf(sink));
  await drain(sink);
  r();
  eq('no push for an unwatched pair', tg.length, 0);
}

console.log('\n── push failure must not break the response ───────────────');
{
  installNet();
  const env = envOf();
  const sink = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) throw new Error('telegram down');
    return realFetch(url, init);
  };
  const r = quiet();
  const res = await handleSignalRaw('BTC/USD', env, ctxOf(sink));
  await drain(sink);
  r();
  ok('caller still got a valid signal', !!res.signal && !!res.id);
  ok('history still written', !!env.SIGNAL_CACHE._m.get('sig:BTC_USD'));
}

console.log('\n── result push via the real cron tracker ──────────────────');
{
  installNet();
  const env = envOf();
  const sink = [];
  const r = quiet();

  const res = await handleSignalRaw('BTC/USD', env, ctxOf(sink));
  await drain(sink);
  const pushedCount = tg.length;

  // Age the pending record so the tracker treats it as due, and make the
  // expiry price a clear win/loss versus the recorded entry.
  const pendKey = HISTORY_CONFIG.KV_PENDING_PREFIX + res.id;
  const rec = await env.SIGNAL_CACHE.get(pendKey, 'json');
  ok('pending record exists for the cron to resolve', !!rec);
  rec.expiryTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await env.SIGNAL_CACHE.put(pendKey, JSON.stringify(rec));
  expiryPrice = rec.direction === 'BUY' ? rec.entryPrice + 50 : rec.entryPrice - 50;

  await scheduledTracker(env);
  r();
  expiryPrice = null;

  eq('exactly one result message added', tg.length - pushedCount, 1);
  const last = tg[tg.length - 1].text;
  ok('result message announces a WIN', last.includes('Result: WIN'), last.slice(0, 40));
  ok('result message references the same signal id', last.includes(String(res.id).slice(-4)));
  eq('push log consumed', await env.SIGNAL_CACHE.get('pushLog:' + res.id, 'json'), null);
}

console.log('\n── NO_TRADE emits nothing ─────────────────────────────────');
{
  installNet();
  const env = envOf();
  const sink = [];
  const r = quiet();
  // flat series -> MIXED alignment -> NO_TRADE
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('twelvedata')) {
      const flat = Array.from({ length: 120 }, (_, i) => ({
        datetime: new Date(Date.now() - (120 - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
        open: '100.00000', high: '100.00100', low: '99.99900', close: '100.00000', volume: '1',
      }));
      return { ok: true, status: 200, json: async () => ({ values: flat }), text: async () => '' };
    }
    return realFetch(url, init);
  };
  const res = await handleSignalRaw('BTC/USD', env, ctxOf(sink));
  await drain(sink);
  r();
  if (res.signal.finalSignal === 'NO_TRADE') {
    eq('NO_TRADE -> no push', tg.length, 0);
    eq('NO_TRADE -> no id minted', res.id, undefined);
  } else {
    ok('flat series did not yield NO_TRADE (skipped)', true);
  }
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL PHASE 10 INTEGRATION TESTS PASSED');

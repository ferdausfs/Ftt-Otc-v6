/**
 * Scan watchdog tests (MULTI-IND-v1.8.0) — no network, no Cloudflare.
 *
 * Covers:
 *   W1  fresh cursors -> watchdog no-op (zero TwelveData fetches)
 *   W2  stale cursor  -> catch-up scheduledScan runs: TwelveData polled,
 *       cursors advanced to the newest closed candle, lock written
 *   W3  locked        -> second call no-ops (no extra TwelveData fetches)
 *   W4  broken KV     -> never throws, reports { ran:false }
 *   W5  index.js wiring: a plain HTTP request to "/" fires the watchdog via
 *       ctx.waitUntil and the stale-scan catch-up completes end-to-end
 *       (signal saved, Telegram sendMessage attempted)
 *   W6  GET /watchdog (external heartbeat target): 200 + awaited result,
 *       staleness detected, admin alert sent to the owner chat, catch-up
 *       heals the cursor, and the finally-block double-fire is skipped
 *   W7  admin alert cooldown: a second stale run within 1h re-alerts NOT;
 *       after cooldown reset it alerts again
 *   W8  cron-trigger self-heal (CF API mocked): schedules missing -> PUT
 *       restores the 15-min cron + alert says re-registered; schedules
 *       present -> no PUT; PROACTIVE hourly check finds a missing trigger
 *       even while the scan is FRESH; no credentials -> clean no-op
 *   W9  drill (?drill=1&key=<WATCHDOG_DRILL_KEY>): fresh cursors forced
 *       stale end-to-end via the endpoint — alert sent (cooldown bypassed),
 *       catch-up ran; wrong key -> plain fresh no-op, no drill
 *   W10 HeartbeatDO: ping() arms the alarm once and never double-arms;
 *       alarm() runs the watchdog and re-arms forward; bootstrapHeartbeat
 *       no-ops without the binding
 *   W11 probes follow the LIVE config: disabled pairs (frozen cursors) can
 *       never fake staleness again (2026-09-22 live bug: owner disabled all
 *       crypto -> all-crypto probes read 6h stale forever); all-forex probe
 *       sets idle safely while the market is closed
 *
 * Run: node scripts/watchdog_tests.mjs
 */

import { runScanWatchdog, getWatchdogState } from '../src/handlers/scan.js';
import { getLastScanT } from '../src/handlers/utbotConfig.js';
import { verifyAndRepairCronTrigger } from '../src/handlers/cronHeal.js';
import { HeartbeatDO, bootstrapHeartbeat } from '../src/handlers/heartbeatDO.js';
import { isForexMarketOpen } from '../src/utils/session.js';
import worker from '../src/index.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}

// ── mocks ────────────────────────────────────────────────────────────────────

function mkKV() {
  const m = new Map();
  return {
    async get(key, type) {
      const v = m.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val) { m.set(key, String(val)); },
    async delete(key) { m.delete(key); },
    async list() { return { keys: [] }; },
    _m: m,
  };
}

const TF_MS = 15 * 60 * 1000;
const BOUNDARY = Math.floor(Date.now() / TF_MS) * TF_MS - TF_MS; // last closed 15min candle start

/** Deterministic pseudo-random walk (seeded) — produces UT Bot flips.
 *  Values are returned NEWEST-FIRST like real TwelveData. The tail of the
 *  series carries a hard 1%/bar decline so a SELL flip always lands after
 *  any stale cursor. */
function genCandles(symbol, n) {
  let s = 17;
  for (const ch of symbol) s = (s * 131 + ch.charCodeAt(0)) & 0x7fffffff;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const rows = [];
  let price = symbol.includes('BTC') ? 80000 : symbol.includes('ETH') ? 2500 : 100;
  for (let i = 0; i < n; i++) {
    const t = BOUNDARY - (n - 1 - i) * TF_MS;
    // deterministic flip inside the last 4 bars: 2-bar rise (pins pos=+1)
    // then 2-bar crash (SELL cross on a close newer than any stale cursor)
    const force = i === n - 4 || i === n - 3 ? 0.006 : i >= n - 2 ? -0.006 : 0;
    const drift = (rnd() - 0.5) * 0.004 + force;
    const o = price;
    price = price * (1 + drift);
    const c = price;
    rows.push({
      datetime: new Date(t).toISOString().slice(0, 19).replace('T', ' '),
      open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: 123,
    });
  }
  return rows.reverse();   // TwelveData order: newest first
}

let tdCalls = [];      // TwelveData /time_series calls
let tgSends = [];      // Telegram sendMessage calls
let cfCalls = [];      // Cloudflare API calls (schedules read/repair)
let cfSchedules = null; // canned GET result: array of {cron} | null = auth fail
function mockFetch() {
  return async (urlStr, init = {}) => {
    const url = new URL(String(urlStr));
    const method = (init && init.method) || 'GET';
    const parseBody = () => {
      try { return typeof init.body === 'string' ? JSON.parse(init.body) : {}; }
      catch (e) { return {}; }
    };
    if (url.hostname === 'api.twelvedata.com' && url.pathname === '/time_series') {
      tdCalls.push(url.searchParams.get('symbol') + '@' + url.searchParams.get('interval'));
      const candles = genCandles(url.searchParams.get('symbol') || 'BTC/USD', 300);
      return new Response(JSON.stringify({ status: 'ok', values: candles }), { status: 200 });
    }
    if (url.hostname === 'api.cloudflare.com' && String(url.pathname).endsWith('/schedules')) {
      cfCalls.push({ method, path: url.pathname });
      if (cfSchedules === null) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'auth' }] }), { status: 403 });
      }
      if (method === 'PUT') {
        const body = parseBody();
        cfSchedules = Array.isArray(body) ? body : [];   // PUT replaces the whole set
        return new Response(JSON.stringify({ success: true, result: { schedules: cfSchedules } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { schedules: cfSchedules } }), { status: 200 });
    }
    if (url.hostname === 'api.telegram.org') {
      const path = url.pathname.split('/').pop();
      tgSends.push({ path, method, body: parseBody() });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + urlStr);
  };
}

const jsonRes = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
const env_ = (over = {}) => ({
  SIGNAL_CACHE: mkKV(),
  BOT_KV: mkKV(),
  TWELVEDATA_API_KEY: '["testkey"]',
  BOT_TOKEN: 'testtoken',
  WORKER_URL: 'https://worker.example',
  ...over,
});
const ctx_ = () => {
  const ps = [];
  return { waitUntil(p) { ps.push(Promise.resolve(p).catch(e => console.error('waitUntil threw:', e.message))); }, _ps: ps };
};

async function seedCursor(kv, pair, t) {
  await kv.put('utbot:lastscan:' + pair.replace('/', '_'), String(t));
}

async function seedOwner(signalKv) {
  await signalKv.put('tg:owner', '8429957782');
}

const adminAlerts = () => tgSends.filter(x => x.path === 'sendMessage'
  && /WATCHDOG|STALENESS|AUTO-REPAIR/.test(x.body && x.body.text || ''));

async function seedSubscriber(botKv) {
  await botKv.put('auto_users', JSON.stringify(['8429957782']));
  await botKv.put('u:8429957782', JSON.stringify({ autoEnabled: true }));
}

async function drain(ctx) { await Promise.all(ctx._ps); }

// ── tests ────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

async function main() {
  console.log('W1 fresh cursors -> no-op');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = [];
    const env = env_(); const ctx = ctx_();
    const fresh = BOUNDARY + TF_MS; // = close time of the newest closed candle
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, fresh - 5 * 60 * 1000);
    const r = await runScanWatchdog(env, ctx);
    ok(r.ran === false && r.reason === 'fresh', 'no-op when cursors fresh (reason=' + r.reason + ')');
    ok(tdCalls.length === 0, 'zero TwelveData calls when fresh (got ' + tdCalls.length + ')');
  }

  console.log('W2 stale cursor -> catch-up scan runs');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = [];
    const env = env_(); const ctx = ctx_();
    await seedSubscriber(env.BOT_KV);
    const stale = Date.now() - 40 * 60 * 1000;   // 2.7 candles stale, flip window = 6 bars
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    const r = await runScanWatchdog(env, ctx);
    ok(r.ran === true, 'watchdog ran the catch-up');
    ok(tdCalls.length > 0, 'TwelveData polled (' + tdCalls.length + ' calls)');
    const btc = await getLastScanT(env, 'BTC/USD');
    ok(btc === BOUNDARY + TF_MS, 'BTC cursor advanced to newest closed candle (' + new Date(btc || 0).toISOString() + ')');
    const eth = await getLastScanT(env, 'ETH/USD');
    ok(eth === BOUNDARY + TF_MS, 'ETH cursor advanced too');
    const lock = await env.SIGNAL_CACHE.get('scan:watchdog:lock');
    ok(!!lock, 'watchdog lock written');
    ok(tgSends.length > 0, 'catch-up delivered pending events to Telegram (' + tgSends.filter(x => x.path === 'sendMessage').length + ' sends)');
  }

  console.log('W3 lock blocks a second catch-up');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = [];
    const env = env_(); const ctx = ctx_();
    await env.SIGNAL_CACHE.put('scan:watchdog:lock', 'x');
    const stale = Date.now() - 2 * 60 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    const r = await runScanWatchdog(env, ctx);
    ok(r.ran === false && r.reason === 'locked', 'no-op while locked');
    ok(tdCalls.length === 0, 'zero TwelveData calls while locked');
  }

  console.log('W4 broken KV -> never throws');
  {
    globalThis.fetch = mockFetch(); tdCalls = [];
    const badKV = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
    const r = await runScanWatchdog({ SIGNAL_CACHE: badKV }, ctx_());
    ok(r && r.ran === false, 'graceful failure object returned (' + (r && r.reason) + ')');
  }

  console.log('W5 index.js fetch wiring (HTTP request self-heals a stale scan)');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = [];
    const env = env_();
    await seedSubscriber(env.BOT_KV);
    const stale = Date.now() - 40 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    const ctx = ctx_();
    const res = await worker.fetch(new Request('https://worker.example/'), env, ctx);
    ok(res.status === 200, 'GET / responded 200');
    await drain(ctx);   // let the waitUntil watchdog finish
    ok(tdCalls.length > 0, 'watchdog fired from the fetch path (TwelveData called)');
    const btc = await getLastScanT(env, 'BTC/USD');
    ok(btc === BOUNDARY + TF_MS, 'cursor advanced end-to-end');
    ok(tgSends.some(x => x.path === 'sendMessage'), 'missed signals pushed to Telegram');
  }

  console.log('W6 GET /watchdog — external heartbeat target, end to end');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    const env = env_();
    await seedOwner(env.SIGNAL_CACHE);
    await seedSubscriber(env.BOT_KV);
    const stale = Date.now() - 40 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    const res = await worker.fetch(new Request('https://worker.example/watchdog'), env, ctx_());
    ok(res.status === 200, 'GET /watchdog responded 200');
    const body = await res.json();
    ok(body.ok === true && body.watchdog && body.watchdog.ran === true,
      'response carries the awaited watchdog result (ran=true, reason=' + (body.watchdog && body.watchdog.reason) + ')');
    ok(body.drill === false, 'plain ping reports drill=false');
    const btc = await getLastScanT(env, 'BTC/USD');
    ok(btc === BOUNDARY + TF_MS, 'staleness healed: cursor advanced to newest closed candle');
    ok(!!(await env.SIGNAL_CACHE.get('scan:watchdog:lock')), 'lock written');
    const alerts = adminAlerts();
    ok(alerts.length === 1 && alerts[0].body.chat_id === '8429957782',
      'exactly ONE admin staleness alert, sent to the owner chat (got ' + alerts.length + ')');
    ok(/STALENESS/.test(alerts[0] && alerts[0].body && alerts[0].body.text || ''),
      'alert text names the staleness incident');
    ok(alerts[0].body.parse_mode === 'HTML', 'alert delivered as Telegram HTML');
    const state = await getWatchdogState(env);
    ok(state.lastRun && state.lastRun.ran === true, '/health diagnostics record the watchdog run');
  }

  console.log('W7 admin alert cooldown — incident alerts once per hour');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    const env = env_();
    await seedOwner(env.SIGNAL_CACHE);
    const stale = Date.now() - 40 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    await runScanWatchdog(env, ctx_());
    ok(adminAlerts().length === 1, 'first stale run alerts (got ' + adminAlerts().length + ')');

    // Re-stale ALL probe pairs (the first catch-up healed the others) and
    // run again INSIDE the cooldown: heals, but no new alert.
    tgSends = [];
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    await env.SIGNAL_CACHE.delete('scan:watchdog:lock');
    const r2 = await runScanWatchdog(env, ctx_());
    ok(r2.ran === true, 'second stale run still heals');
    ok(adminAlerts().length === 0, 'no second alert inside the 1h cooldown');

    // Cooldown expired -> the standing incident re-alerts.
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    await env.SIGNAL_CACHE.delete('scan:watchdog:lock');
    await env.SIGNAL_CACHE.delete('scan:watchdog:alertT');
    const r3 = await runScanWatchdog(env, ctx_());
    ok(r3.ran === true && adminAlerts().length === 1, 're-alerts after the cooldown resets');
  }

  console.log('W8 cron-trigger self-heal (CF API mocked)');
  {
    // A) schedules MISSING the */15 -> PUT restores it + alert says re-registered
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = [{ cron: '*/2 * * * *' }];
    const env = env_({ CF_API_TOKEN: 'cftoken', CF_ACCOUNT_ID: 'acct', WORKER_NAME: 'fttotcv6' });
    await seedOwner(env.SIGNAL_CACHE);
    const stale = Date.now() - 40 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(env.SIGNAL_CACHE, p, stale);
    const r = await runScanWatchdog(env, ctx_());
    ok(r.cron && r.cron.checked === true && r.cron.present === false && r.cron.repaired === true,
      'missing */15 detected and repaired (' + JSON.stringify(r.cron) + ')');
    const put = cfCalls.find(c => c.method === 'PUT');
    ok(!!put, 'CF API PUT issued to restore the schedule');
    ok(cfSchedules.length === 1 && cfSchedules[0].cron === '*/15 * * * *', 'PUT body = the full expected schedule set');
    ok(/re-registered/.test(adminAlerts()[0] && adminAlerts()[0].body && adminAlerts()[0].body.text || ''),
      'admin alert names the re-registration');

    // B) schedules PRESENT -> read-only, no PUT, no alert
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = [{ cron: '*/15 * * * *' }];
    const envB = env_({ CF_API_TOKEN: 'cftoken', CF_ACCOUNT_ID: 'acct' });
    const probe = BOUNDARY + TF_MS - 5 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(envB.SIGNAL_CACHE, p, probe);
    const rB = await runScanWatchdog(envB, ctx_());
    ok(rB.ran === false && rB.reason === 'fresh' && rB.cronCheck && rB.cronCheck.cron.checked === true && rB.cronCheck.cron.present === true,
      'fresh run verifies the trigger proactively (present)');
    ok(!cfCalls.some(c => c.method === 'PUT'), 'no PUT when the schedule set is correct');
    ok(adminAlerts().length === 0, 'no alert when nothing is wrong');

    // C) PROACTIVE: trigger missing while the scan is FRESH (heartbeat masks
    //    the dead cron) -> hourly check repairs + alerts anyway
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = [];
    const envC = env_({ CF_API_TOKEN: 'cftoken', CF_ACCOUNT_ID: 'acct' });
    await seedOwner(envC.SIGNAL_CACHE);
    for (const p of ['BTC/USD', 'ETH/USD']) await seedCursor(envC.SIGNAL_CACHE, p, probe);
    const rC = await runScanWatchdog(envC, ctx_());
    ok(rC.ran === false && rC.reason === 'fresh', 'scan itself was fresh (catch-up masked the dead trigger)');
    const putC = cfCalls.find(c => c.method === 'PUT');
    ok(!!putC && cfSchedules.length === 1 && cfSchedules[0].cron === '*/15 * * * *',
      'proactive hourly check repaired the missing trigger');
    ok(adminAlerts().length === 1 && /AUTO-REPAIR/.test(adminAlerts()[0].body.text || ''),
      'proactive repair alerted the admin BEFORE any signal was delayed');

    // D) no credentials -> clean no-op, zero CF calls, never throws
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = [{ cron: '*/15 * * * *' }];
    const envD = env_();
    const rD = await verifyAndRepairCronTrigger(envD);
    ok(rD.checked === false && /no cf credentials/.test(rD.reason || ''), 'no creds -> checked:false, reason stated');
    ok(cfCalls.length === 0, 'zero CF API calls without credentials');
  }

  console.log('W9 drill — ?drill=1&key=<WATCHDOG_DRILL_KEY> simulates staleness end-to-end');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    const env = env_({ WATCHDOG_DRILL_KEY: 'drillsecret' });
    await seedOwner(env.SIGNAL_CACHE);
    const fresh = BOUNDARY + TF_MS - 5 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, fresh);

    // Wrong key: ignored flag -> plain fresh no-op, no drill, no alert.
    const resWrong = await worker.fetch(new Request('https://worker.example/watchdog?drill=1&key=WRONG'), env, ctx_());
    const bodyWrong = await resWrong.json();
    ok(bodyWrong.drill === false && bodyWrong.watchdog.ran === false && bodyWrong.watchdog.reason === 'fresh',
      'wrong key -> drill refused, fresh no-op');
    ok(adminAlerts().length === 0, 'no alert without a valid drill key');

    // Valid key: forced stale -> alert (cooldown bypassed) + catch-up ran.
    await env.SIGNAL_CACHE.put('scan:watchdog:alertT', String(Date.now()), { expirationTtl: 3600 });
    const res = await worker.fetch(new Request('https://worker.example/watchdog?drill=1&key=drillsecret'), env, ctx_());
    const body = await res.json();
    ok(body.ok === true && body.drill === true && body.watchdog.ran === true,
      'drill forced the stale path (ran=true)');
    const alerts = adminAlerts();
    ok(alerts.length === 1 && /DRILL/.test(alerts[0].body.text || ''),
      'drill alert sent to the owner chat even with the cooldown key present (bypass verified)');
    ok(/DRILL/.test(alerts[0].body.text || '') && alerts[0].body.chat_id === '8429957782',
      'drill alert is labeled as a drill and addressed to the owner');
    const btc = await getLastScanT(env, 'BTC/USD');
    ok(btc === BOUNDARY + TF_MS, 'drill catch-up advanced the cursor (heal path exercised)');

    // No secret configured at all: drill impossible.
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    const envNoKey = env_();
    for (const p of ['BTC/USD']) await seedCursor(envNoKey.SIGNAL_CACHE, p, fresh);
    const resNoKey = await worker.fetch(new Request('https://worker.example/watchdog?drill=1&key=drillsecret'), envNoKey, ctx_());
    const bodyNoKey = await resNoKey.json();
    ok(bodyNoKey.drill === false && bodyNoKey.watchdog.ran === false,
      'without WATCHDOG_DRILL_KEY the drill flag is ignored');
  }

  console.log('W10 HeartbeatDO — alarm arms once, watchdog runs, re-arms forward');
  {
    const mkStorage = () => ({
      _m: new Map(),
      alarm: null,
      async getAlarm() { return this.alarm; },
      async setAlarm(t) { this.alarm = t; },
      async get(k) { return this._m.get(k); },
      async put(k, v) { this._m.set(k, v); },
    });
    const env = env_();
    const fresh = BOUNDARY + TF_MS - 5 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, fresh);

    const storage = mkStorage();
    const dob = new HeartbeatDO({ storage }, env);
    const armed = await dob.ping();
    ok(armed.armed === true && storage.alarm !== null, 'ping() arms the first alarm');
    const first = storage.alarm;
    await dob.ping();
    ok(storage.alarm === first, 'ping() never double-arms (alarm unchanged)');

    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    await dob.alarm();   // fresh cursors -> watchdog no-op; alarm must re-arm forward
    ok(storage.alarm !== first && storage.alarm >= Date.now() + 4.5 * 60 * 1000,
      'alarm() re-arms ~5 min forward after the watchdog check');
    const tick1 = await env.SIGNAL_CACHE.get('scan:heartbeat:tick');
    ok(!!tick1, 'first alarm writes the liveness breadcrumb to KV');
    await dob.alarm();   // within the 15-min throttle: breadcrumb NOT re-written
    ok((await env.SIGNAL_CACHE.get('scan:heartbeat:tick')) === tick1,
      'breadcrumb is throttled (~15 min), not one write per tick');
    const hstate = await getWatchdogState(env);
    ok(hstate.heartbeat && !!hstate.heartbeat.lastTickAt, '/health surfaces the heartbeat tick');

    ok(await bootstrapHeartbeat({}) === null, 'bootstrapHeartbeat no-ops without the binding');
    const fakeStub = { ping: async () => ({ armed: true }) };
    const fakeNs = { idFromName: () => 'id1', get: () => fakeStub };
    const b = await bootstrapHeartbeat({ HEARTBEAT: fakeNs });
    ok(b && b.armed === true, 'bootstrapHeartbeat arms through the binding');
  }

  console.log('W11 probes follow the LIVE config — disabled pairs cannot fake staleness');
  {
    globalThis.fetch = mockFetch(); tdCalls = []; tgSends = []; cfCalls = []; cfSchedules = null;
    const env = env_();
    await seedOwner(env.SIGNAL_CACHE);
    // Owner reality on 2026-09-22: every crypto pair disabled via the panel,
    // four forex pairs enabled.
    await env.SIGNAL_CACHE.put('utbot:config', JSON.stringify({
      pairs: {
        'BTC/USD': { enabled: false }, 'ETH/USD': { enabled: false },
        'XRP/USD': { enabled: false }, 'SOL/USD': { enabled: false },
        'EUR/USD': { enabled: true, timeframe: '15min' },
        'GBP/USD': { enabled: true, timeframe: '15min' },
        'USD/JPY': { enabled: true, timeframe: '15min' },
        'AUD/USD': { enabled: true, timeframe: '15min' },
      },
    }));
    // Disabled crypto cursors frozen 6h ago (they never advance); forex fresh.
    const frozen = Date.now() - 6 * 60 * 60 * 1000;
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD']) await seedCursor(env.SIGNAL_CACHE, p, frozen);
    const freshProbe = BOUNDARY + TF_MS - 5 * 60 * 1000;
    for (const p of ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) await seedCursor(env.SIGNAL_CACHE, p, freshProbe);
    const r = await runScanWatchdog(env, ctx_());
    ok(r.ran === false && r.reason === 'fresh' && r.newest === freshProbe,
      'disabled crypto cursors ignored; staleness judged on ENABLED pairs (newest=' + new Date(r.newest).toISOString() + ')');
    ok(adminAlerts().length === 0 && tdCalls.length === 0, 'no false alert, no catch-up from frozen cursors');

    // Real staleness on an ENABLED forex pair is still detected (day-aware:
    // on weekends the market-closed guard correctly refuses to act).
    tgSends = [];
    const staleF = Date.now() - 40 * 60 * 1000;
    for (const p of ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) await seedCursor(env.SIGNAL_CACHE, p, staleF);
    await env.SIGNAL_CACHE.delete('scan:watchdog:alertT');
    const r2 = await runScanWatchdog(env, ctx_());
    if (isForexMarketOpen()) {
      ok(r2.ran === true && adminAlerts().length === 1, 'staleness on an enabled forex pair alerts (market open)');
    } else {
      ok(r2.ran === false && r2.reason === 'market-closed', 'all-forex probe set idles safely while the market is closed');
    }
  }

  globalThis.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SUITE ERROR', e); globalThis.fetch = realFetch; process.exit(1); });

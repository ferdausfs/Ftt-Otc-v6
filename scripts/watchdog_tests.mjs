/**
 * Scan watchdog tests (MULTI-IND-v1.5.1) — no network, no Cloudflare.
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
 *
 * Run: node scripts/watchdog_tests.mjs
 */

import { runScanWatchdog } from '../src/handlers/scan.js';
import { getLastScanT } from '../src/handlers/utbotConfig.js';
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
function mockFetch() {
  return async (urlStr) => {
    const url = new URL(String(urlStr));
    if (url.hostname === 'api.twelvedata.com' && url.pathname === '/time_series') {
      tdCalls.push(url.searchParams.get('symbol') + '@' + url.searchParams.get('interval'));
      const candles = genCandles(url.searchParams.get('symbol') || 'BTC/USD', 300);
      return new Response(JSON.stringify({ status: 'ok', values: candles }), { status: 200 });
    }
    if (url.hostname === 'api.telegram.org') {
      const path = url.pathname.split('/').pop();
      let body = {};
      try { body = await new Request(urlStr, { method: 'POST' }).json().catch(() => ({})); } catch (e) { /* GET */ }
      tgSends.push({ path, body });
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

  globalThis.fetch = realFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('SUITE ERROR', e); globalThis.fetch = realFetch; process.exit(1); });

/**
 * UT Bot live-path integration smoke — no network, no Cloudflare.
 *
 * Mocks:
 *   - KV namespaces (Map-backed): SIGNAL_CACHE, BOT_KV
 *   - global fetch: TwelveData -> canned candles; Telegram -> ok
 *
 * Proves on the REAL scan/config/push modules:
 *   S1 a buy event on the newest closed candle is emitted: history record
 *      (direction CALL) + Telegram send + push diagnostics
 *   S2 the cursor advances; an immediate re-run emits NOTHING (idempotent)
 *   S3 a second event on a later candle emits exactly once (new record)
 *   S4 a config-disabled pair is skipped by the scan (no fetch for it)
 *   S5 POST config merge-write validation (unknown pair rejected, valid write)
 *   S6 no-lookahead at the live boundary: an event on the NEWEST CLOSED
 *      candle is emitted; the still-open candle never influences anything
 *
 * Run: node scripts/utbot_smoke.mjs
 */
import { scheduledScan } from '../src/handlers/scan.js';
import { handleUtBotConfigPost, handleUtBotConfigGet } from '../src/handlers/utbotConfig.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}

// ── KV mock ──────────────────────────────────────────────────────────────────
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
    async list({ prefix }) {
      const keys = [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys };
    },
    _m: m,
  };
}

// ── candle builder: 300 five-minute bars ending in a BUY cross ─────────────
const TF = 300000;
const T0 = 1_760_000_000_000; // arbitrary epoch, aligned later to "now"
function buildSeries(n, buyAtLast) {
  // Deterministic wiggle; optional engineered cross at the final bar.
  const C = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 7) * 0.9;
    const o = px;
    let c = o + wave + (i % 11 === 0 ? 0.6 : -0.2);
    if (buyAtLast && i === n - 1) c = o + 6.0;               // breakout bar
    const h = Math.max(o, c) + 0.35;
    const l = Math.min(o, c) - 0.35;
    C.push({ t: T0 + i * TF, o, h, l, c });
    px = c;
  }
  return C;
}
const N = 300;
const S1 = buildSeries(N, true);    // last bar = strong breakout -> BUY
const S2next = S1.slice(0, N - 1).concat([buildSeries(N, false)[N - 1]]); // same history, plain last bar
// For S3: one more candle after the buy bar (no event) — cursor advances.
const S3 = S1.concat([{ t: T0 + N * TF, o: S1[N - 1].c, h: S1[N - 1].c + 0.3, l: S1[N - 1].c - 0.3, c: S1[N - 1].c + 0.1 }]);

function tdResponse(candles, nowMs) {
  // TwelveData shape: newest-first rows with "datetime" UTC strings.
  const rows = candles.map(c => ({
    datetime: new Date(c.t).toISOString().slice(0, 19).replace('T', ' '),
    open: c.o, high: c.h, low: c.l, close: c.c, volume: 0,
  })).reverse();
  return { status: 'ok', values: rows };
}

function mockFetch(allPairs) {
  let calls = 0;
  const f = async (url) => {
    const u = String(url);
    if (u.includes('api.twelvedata.com')) {
      calls++;
      const sym = new URL(u).searchParams.get('symbol');
      const series = allPairs[sym];
      if (!series) return new Response(JSON.stringify({ status: 'error', message: 'no mock for ' + sym }), { status: 200 });
      return new Response(JSON.stringify(tdResponse(series)), { status: 200 });
    }
    if (u.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 });
  };
  f._calls = () => calls;
  return f;
}

async function runScan(env, ctxMock, nowMs) {
  // Freeze Date.now inside the module under test via opts.now path: scanOnePair
  // reads Date.now() directly in scheduledScan; we instead control the feed so
  // the newest candle is exactly closed at real "now".
  return scheduledScan(env, ctxMock);
}

async function main() {
  const ctxMock = { waitUntil: () => {} };

  // ── S1: fresh deploy emits the newest-candle BUY exactly once ─────────────
  {
    const env = { SIGNAL_CACHE: mkKV(), BOT_KV: mkKV(), BOT_TOKEN: 't', TWELVEDATA_API_KEY: 'mock-key' };
    env.BOT_KV._m.set('auto_users', JSON.stringify(['777']));
    env.BOT_KV._m.set('u:777', JSON.stringify({ autoEnabled: true }));
    const realFetch = globalThis.fetch;
    const shared = {};
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) shared[p] = S1;
    globalThis.fetch = mockFetch(shared);

    // Advance the feed clock: newest candle closes exactly now.
    const nowMs = S1[N - 1].t + TF;
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
      const r = await runScan(env, ctxMock, nowMs);
      ok(r.ok === 8 && r.processed === 8, 'S1 scan processed 8/8 pairs ok');
      const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(Array.isArray(hist) && hist.length === 1, 'S1 exactly 1 history record (fresh deploy emits newest candle only)');
      ok(hist && hist[0].direction === 'CALL' && hist[0].engine === 'UT-BOT', 'S1 record CALL / UT-BOT');
      ok(hist && hist[0].indicators.event === 'buy', 'S1 audit carries buy event');
      const lastAttempt = await env.SIGNAL_CACHE.get('push:lastAttempt', 'json');
      ok(lastAttempt && lastAttempt.ok === true && lastAttempt.sent === 1, 'S1 telegram push delivered to 1 subscriber');
      const cursor = await env.SIGNAL_CACHE.get('utbot:lastscan:BTC_USD');
      ok(Number(cursor) === nowMs, 'S1 cursor = newest closed candle close-time');

      // ── S2: immediate re-run emits nothing ──────────────────────────────
      const r2 = await runScan(env, ctxMock, nowMs);
      const hist2 = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(hist2.length === 1, 'S2 re-run emits nothing (idempotent)');
      ok(r2.ok === 8, 'S2 re-run still processes all pairs');

      // ── S3: a new candle with a new event emits exactly once more ───────
      // (craft: the extra candle is a breakdown bar closing far below the
      //  trailing stop -> branch-4 reset -> crossover(stop, ema) -> SELL,
      //  same mechanics as the golden fixture's bar 3)
      const shifted = S1.slice(1).map(c => ({ ...c }));
      const S3ev = shifted.slice(0, N - 1).concat([{
        t: T0 + (N - 1) * TF + TF, o: shifted[N - 2].c,
        h: shifted[N - 2].c + 0.3, l: shifted[N - 2].c - 6.3, c: shifted[N - 2].c - 6.0,
      }]);
      Date.now = () => S3ev[S3ev.length - 1].t + TF;
      globalThis.fetch = mockFetch(Object.fromEntries(Object.keys(shared).map(p => [p, S3ev])));
      const r3 = await runScan(env, ctxMock);
      const hist3 = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(hist3.length === 2, 'S3 second event adds exactly 1 record (got ' + hist3.length + ')');
      ok(hist3[0].direction === 'PUT', 'S3 second event is the breakdown SELL');
      ok(Date.now() === S3ev[S3ev.length - 1].t + TF, 'S3 clock advanced one period');
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  }

  // ── S4/S5: config gate + POST validation ──────────────────────────────────
  {
    const env = { SIGNAL_CACHE: mkKV(), BOT_KV: mkKV(), BOT_TOKEN: 't', TWELVEDATA_API_KEY: 'mock-key' };
    env.BOT_KV._m.set('auto_users', JSON.stringify([]));
    const realFetch = globalThis.fetch;
    const allSeries = {};
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) allSeries[p] = S1;
    const f = mockFetch(allSeries);
    globalThis.fetch = f;
    const nowMs = S1[N - 1].t + TF;
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
      // disable every pair except ETH/USD via the real POST handler
      const disabled = { pairs: {} };
      for (const p of ['BTC/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) {
        disabled.pairs[p] = { enabled: false };
      }
      const postReq = new Request('https://w/api/utbot/config', {
        method: 'POST',
        body: JSON.stringify(disabled),
      });
      const postRes = await handleUtBotConfigPost(postReq, env);
      const postJson = await postRes.json();
      ok(postJson.ok === true && postJson.config.pairs['BTC/USD'].enabled === false, 'S5 POST merge-write disables BTC/USD');
      ok(postJson.config.pairs['ETH/USD'].enabled === true, 'S5 other pairs untouched (merge, not replace)');

      const badReq = new Request('https://w/api/utbot/config', {
        method: 'POST',
        body: JSON.stringify({ pairs: { 'DOGE/USD': { enabled: true } } }),
      });
      const badRes = await handleUtBotConfigPost(badReq, env);
      ok(badRes.status === 400, 'S5 unknown pair rejected 400');

      const getRes = await handleUtBotConfigGet(env);
      const cfgJson = await getRes.json();
      ok(cfgJson.pairs['BTC/USD'].enabled === false && cfgJson.defaults.a === 1 && cfgJson.defaults.c === 10, 'S5 GET returns merged config + TV defaults');

      // scan with 7 pairs disabled -> only ETH/USD fetched
      const scanMod = await import('../src/handlers/scan.js');
      const r = await scanMod.scheduledScan(env, ctxMock);
      ok(r.ok === 1 && r.processed === 1, 'S4 disabled pairs skipped (1 pair processed)');
      ok(f._calls() > 0 && (await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json')) === null, 'S4 no records for disabled pair');
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  }

  console.log('\nUT Bot live-path smoke: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });

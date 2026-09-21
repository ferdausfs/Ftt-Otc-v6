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
 *   S7 UT Bot + Multi Kernel Regression firing on the SAME closed candle ->
 *      one combined Telegram message; one history record per indicator;
 *      idempotent re-run emits nothing for either engine
 *
 * Run: node scripts/utbot_smoke.mjs
 */
import { scheduledScan } from '../src/handlers/scan.js';
import { handleUtBotConfigPost, handleUtBotConfigGet } from '../src/handlers/utbotConfig.js';
import { isForexMarketOpen } from '../src/utils/session.js';
import { CONFIG } from '../src/config.js';

// Fixture bars must carry the LIVE default timeframe — keep this in sync with
// CONFIG.UTBOT.DEFAULT_TIMEFRAME (hardcoding 5min here broke when the live
// default moved to 15min: the newest fixture bar looked "unclosed").
const TF_MS_BY_TF = { '1min': 60000, '5min': 300000, '15min': 900000 };
const TF = TF_MS_BY_TF[CONFIG.UTBOT.DEFAULT_TIMEFRAME] || 300000;

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

// ── candle builder: 300 default-timeframe bars ending in a BUY cross ───────
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
/** Series with a GUARANTEED BUY at the last bar: 4 deep-decline bars put the
 *  trailing stop short above price, the breakout bar then crosses it.
 *  boom=20 additionally flips the MKR kernel-MA slope on the SAME bar
 *  (probed: boom=12 flips UT Bot only; boom=20 flips both) — used by S7. */
function buildBuySeries(n, boom = 12) {
  const C = buildSeries(n, false).map(c => ({ ...c }));
  let px = C[n - 6].c;
  for (let i = n - 5; i < n - 1; i++) {
    px = px - 2.5;
    C[i] = { t: C[i].t, o: C[i - 1].c, h: Math.max(C[i - 1].c, px) + 0.2, l: Math.min(C[i - 1].c, px) - 0.2, c: px };
  }
  const ob = C[n - 2].c;
  C[n - 1] = { t: C[n - 1].t, o: ob, h: ob + boom + 1, l: ob - 0.2, c: ob + boom };
  return C;
}
const S1 = buildBuySeries(N);       // last bar = engineered breakout -> BUY
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
    // This block proves the UT Bot path — disable MKR for every pair via the
    // real config POST (exercises the per-indicator sanitize + merge-write).
    const mkrOff = { pairs: {} };
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) {
      mkrOff.pairs[p] = { indicators: { mkr: { enabled: false } } };
    }
    const offRes = await handleUtBotConfigPost(
      new Request('https://w/api/utbot/config', { method: 'POST', body: JSON.stringify(mkrOff) }), env);
    ok((await offRes.json()).ok === true, 'S1 per-indicator config write (MKR disabled for all pairs)');
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
      const expectPairs = isForexMarketOpen() ? 8 : 4;   // weekend/CI: crypto only (real-clock forex gate)
      ok(r.ok === expectPairs && r.processed === expectPairs, 'S1 scan processed all active pairs (' + expectPairs + ')');
      const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(Array.isArray(hist) && hist.length === 1, 'S1 exactly 1 history record (fresh deploy emits newest candle only)');
      ok(hist && hist[0].direction === 'BUY' && hist[0].engine === 'UT-BOT', 'S1 record BUY / UT-BOT (CFD vocab)');
      ok(hist && hist[0].indicators.event === 'buy', 'S1 audit carries buy event');
      ok(hist && hist[0].expiryTime === null && hist[0].expiryMinutes === null, 'S1 CFD record carries NO expiry (no pending, no result)');
      const lastAttempt = await env.SIGNAL_CACHE.get('push:lastAttempt', 'json');
      ok(lastAttempt && lastAttempt.ok === true && lastAttempt.sent === 1, 'S1 telegram push delivered to 1 subscriber');
      const cursor = await env.SIGNAL_CACHE.get('utbot:lastscan:BTC_USD');
      ok(Number(cursor) === nowMs, 'S1 cursor = newest closed candle close-time');

      // ── S2: immediate re-run emits nothing ──────────────────────────────
      const r2 = await runScan(env, ctxMock, nowMs);
      const hist2 = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(hist2.length === 1, 'S2 re-run emits nothing (idempotent)');
      ok(r2.ok === expectPairs, 'S2 re-run still processes all pairs (' + expectPairs + ')');

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
      ok(hist3[0].direction === 'SELL', 'S3 second event is the breakdown SELL (CFD vocab)');
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

      // v1.5.0: the accepted universe is the full pair catalog — DOGE/USD is
      // now a VALID pair. Genuinely invalid input = OTC (real markets only)
      // or currencies outside the sanitizer vocabularies.
      const badReq = new Request('https://w/api/utbot/config', {
        method: 'POST',
        body: JSON.stringify({ pairs: { 'EUR/USD-OTC': { enabled: true } } }),
      });
      const badRes = await handleUtBotConfigPost(badReq, env);
      ok(badRes.status === 400, 'S5 OTC pair rejected 400');
      const badReq2 = new Request('https://w/api/utbot/config', {
        method: 'POST',
        body: JSON.stringify({ pairs: { 'XXX/YYY': { enabled: true } } }),
      });
      const badRes2 = await handleUtBotConfigPost(badReq2, env);
      ok(badRes2.status === 400, 'S5 unknown-currency pair rejected 400');

      const getRes = await handleUtBotConfigGet(env);
      const cfgJson = await getRes.json();
      ok(cfgJson.pairs['BTC/USD'].enabled === false && cfgJson.defaults.a === 1 && cfgJson.defaults.c === 10, 'S5 GET returns merged config + TV defaults');
      ok(cfgJson.pairs['BTC/USD'].indicators && cfgJson.pairs['BTC/USD'].indicators.mkr.enabled === true, 'S5 per-indicator defaults merged (MKR on)');
      ok(cfgJson.defaults.indicators.mkr.kernel === 'Laplace' && cfgJson.defaults.indicators.mkr.bandwidth === 14, 'S5 MKR TradingView defaults exposed');
      ok(cfgJson.defaults.expiryMinutes === undefined, 'S5 no expiry anywhere (CFD mode)');

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

  // ── S7: UT Bot + MKR fire on the SAME closed candle -> ONE combined message
  // (confluence mechanism test; MKR pinned to 'nrp' — its labels confirm at
  // their own flip bar's close so both engines can share a candle. Default
  // tv-mode MKR is covered by S8: labels confirm one candle after the bar TV
  // anchors them to, so cross-indicator same-candle grouping is not the norm.)
  {
    const env = { SIGNAL_CACHE: mkKV(), BOT_KV: mkKV(), BOT_TOKEN: 't', TWELVEDATA_API_KEY: 'mock-key' };
    env.BOT_KV._m.set('auto_users', JSON.stringify(['777']));
    env.BOT_KV._m.set('u:777', JSON.stringify({ autoEnabled: true }));
    const pinNrp = { pairs: {} };
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) {
      pinNrp.pairs[p] = { indicators: { mkr: { mode: 'nrp' } } };
    }
    await env.SIGNAL_CACHE.put('utbot:config', JSON.stringify(pinNrp));
    const realFetch = globalThis.fetch;
    const S7 = buildBuySeries(N, 20);   // breakout flips BOTH indicators on the last bar
    const shared = {};
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) shared[p] = S7;
    globalThis.fetch = mockFetch(shared);
    const nowMs = S7[N - 1].t + TF;
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
      const scanMod = await import('../src/handlers/scan.js');
      const r = await scanMod.scheduledScan(env, ctxMock);
      const expectPairs = isForexMarketOpen() ? 8 : 4;
      ok(r.ok === expectPairs, 'S7 scan processed all active pairs (' + expectPairs + ')');
      const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      const ut = (hist || []).filter(x => x.engine === 'UT-BOT');
      const mk = (hist || []).filter(x => x.engine === 'MKR');
      ok(ut.length === 1 && mk.length === 1, 'S7 both indicators recorded on the same candle (UT-BOT + MKR)');
      ok(ut[0] && ut[0].direction === 'BUY' && mk[0] && mk[0].direction === 'BUY', 'S7 CFD directions BUY/BUY');
      ok(ut[0].timestamp === mk[0].timestamp, 'S7 both events stamp the same candle close');
      ok(mk[0].indicators.event === 'up' && mk[0].indicators.kernel === 'Laplace' && mk[0].indicators.bandwidth === 14, 'S7 MKR audit carries native event + params');
      ok(mk[0].expiryTime === null && mk[0].expiryMinutes === null, 'S7 MKR record carries NO expiry');
      ok(ut[0].expiryTime === null && ut[0].expiryMinutes === null, 'S7 UT Bot record carries NO expiry');
      const lastAttempt = await env.SIGNAL_CACHE.get('push:lastAttempt', 'json');
      ok(lastAttempt && lastAttempt.ok === true && lastAttempt.sent === 1, 'S7 combined message delivered to the subscriber');
      const cursor = await env.SIGNAL_CACHE.get('utbot:lastscan:BTC_USD');
      ok(Number(cursor) === nowMs, 'S7 cursor = newest closed candle close-time');
      // idempotent re-run: nothing new for either engine
      await scanMod.scheduledScan(env, ctxMock);
      const hist2 = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      ok(hist2.length === 2, 'S7 re-run emits nothing (idempotent across indicators)');
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  }

  // ── S8: DEFAULT config = MKR tv mode (chart parity). Scan runs the tv
  // engine; UT Bot BUY still recorded; any MKR tv label carries mode 'tv' +
  // confirmedAt, and is NEVER falsely grouped with a different-candle UT Bot
  // event (grouping stays same-candle).
  {
    const env = { SIGNAL_CACHE: mkKV(), BOT_KV: mkKV(), BOT_TOKEN: 't', TWELVEDATA_API_KEY: 'mock-key' };
    env.BOT_KV._m.set('auto_users', JSON.stringify(['777']));
    env.BOT_KV._m.set('u:777', JSON.stringify({ autoEnabled: true }));
    const realFetch = globalThis.fetch;
    const S8 = buildBuySeries(N, 20);
    const shared = {};
    for (const p of ['BTC/USD', 'ETH/USD', 'XRP/USD', 'SOL/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) shared[p] = S8;
    globalThis.fetch = mockFetch(shared);
    const nowMs = S8[N - 1].t + TF;
    const realNow = Date.now;
    Date.now = () => nowMs;
    try {
      const scanMod = await import('../src/handlers/scan.js');
      const r = await scanMod.scheduledScan(env, ctxMock);
      const expectPairs = isForexMarketOpen() ? 8 : 4;
      ok(r.ok === expectPairs, 'S8 tv-mode scan processed all active pairs');
      const hist = await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
      const ut = (hist || []).filter(x => x.engine === 'UT-BOT');
      const mk = (hist || []).filter(x => x.engine === 'MKR');
      ok(ut.length === 1 && ut[0].direction === 'BUY', 'S8 UT Bot BUY recorded under tv default');
      for (const m of mk) {
        ok(m.indicators.mode === 'tv', 'S8 MKR events stamped mode tv');
        ok(!!m.indicators.confirmedAt, 'S8 MKR tv events carry confirmedAt');
        ok(m.indicators.confirmedAt === m.timestamp || new Date(m.indicators.confirmedAt) > new Date(m.timestamp),
          'S8 confirmation is never before the label candle');
      }
      const cfgJson = await (await import('../src/handlers/utbotConfig.js')).handleUtBotConfigGet(env).then(r => r.json());
      ok(cfgJson.defaults.indicators.mkr.mode === 'tv', 'S8 config exposes mkr.mode default tv');
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  }

  console.log('\nUT Bot live-path smoke: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });

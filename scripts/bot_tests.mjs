/**
 * Telegram bot panel tests — no network, no Cloudflare.
 *
 * Mocks:
 *   - KV namespaces (Map-backed): SIGNAL_CACHE, BOT_KV
 *   - global fetch: Telegram API captured (method + body logged); anything
 *     else throws (catches accidental TwelveData calls)
 *
 * Covers:
 *   B1  webhook secret verification (403 without/wrong header, 200 with)
 *   B2  /start claims owner; second chat denied; unknown command answered
 *   B3  pair toggle pt:<PAIR> writes config (on->off->on) + toast answered
 *   B4  pa:on/pa:off write every pair
 *   B5  indicator toggle single pair (ir:<pair>:mkr) leaves other indicator
 *       and other pairs untouched
 *   B6  indicator toggle all-pairs (ir:all:utbot): any OFF -> all ON;
 *       all ON -> all OFF
 *   B7  params via buttons: a, c, kernel (enum), bandwidth — valid values
 *       applied, invalid values rejected with error toast, config unchanged
 *   B8  timeframe tset:<scope>:<tf> — valid applied, invalid rejected
 *   B9  mergePairPatch deep-merge regression: partial indicators patch
 *       must NOT reset a sibling key (bandwidth) to default
 *   B10 custom input: aw:... sets await state, numeric reply applies and
 *       clears it, bad value keeps it, /reset cancels
 *   B11 ensureTelegramWebhook: registers once with a KV-stored secret,
 *       no-op when already correct
 *   B12 setup endpoint: one-time key consumed, owner seeded from push
 *       subscribers, second call rejected
 *   B13 every rendered callback_data is <= 64 bytes; MKR editor lists all
 *       17 kernels; non-owner callback rejected
 *   B14 /scan: invalid pair rejected; valid pair flows through the real
 *       scan path (fails gracefully under mocked network)
 *   B15 status endpoint reports version/webhook/owner without secrets
 *
 * Run: node scripts/bot_tests.mjs
 */

import {
  handleTelegramUpdate, handleTelegramSetup, handleTelegramStatus, ensureTelegramWebhook,
} from '../src/handlers/telegramBot.js';
import { getUtBotConfig, mergePairPatch } from '../src/handlers/utbotConfig.js';
import { INDICATOR_BY_ID } from '../src/strategy/registry.mjs';
import { MKR_KERNELS } from '../src/strategy/multiKernelRegression.mjs';

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
    _m: m,
  };
}

const jsonRes = (obj) => new Response(JSON.stringify(obj), {
  headers: { 'Content-Type': 'application/json' },
});

const WORKER_URL = 'https://worker.example';
let whUrl = '';            // Telegram-side webhook state (mocked)
let tgLog = [];            // [{ method, body }]

function installFetch() {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      const method = u.split('/').pop();
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      tgLog.push({ method, body });
      if (method === 'getWebhookInfo') {
        return jsonRes({ ok: true, result: { url: whUrl, pending_update_count: 0 } });
      }
      if (method === 'setWebhook') { whUrl = body.url; return jsonRes({ ok: true, result: true }); }
      return jsonRes({ ok: true, result: {} });
    }
    throw new Error('unexpected external fetch: ' + u);
  };
}

function mkEnv() {
  return {
    SIGNAL_CACHE: mkKV(),
    BOT_KV: mkKV(),
    BOT_TOKEN: '123:test',
    WORKER_URL,
  };
}

function upd(update, secret = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return new Request(WORKER_URL + '/api/telegram/webhook', {
    method: 'POST', headers, body: JSON.stringify(update),
  });
}

function cbUpdate(data, chatId = 111, msgId = 10) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: 'cb' + Math.floor(Math.random() * 1e9),
      data,
      from: { id: chatId },
      message: { message_id: msgId, chat: { id: chatId, type: 'private' } },
    },
  };
}

function textUpdate(text, chatId = 111) {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: { message_id: 5, chat: { id: chatId, type: 'private' }, from: { id: chatId }, text },
  };
}

async function feed(env, update, secret) {
  const res = await handleTelegramUpdate(upd(update, secret), env, { waitUntil: () => {} });
  return res;
}

function lastSent(env) { return tgLog[tgLog.length - 1] || null; }
function sentMethods() { return tgLog.map(x => x.method); }
async function cfgOf(env) { return (await getUtBotConfig(env)).pairs; }

// ── B1: webhook secret verification ─────────────────────────────────────────
console.log('B1 webhook secret verification');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');

  let res = await feed(env, textUpdate('/menu'), null);           // no header
  ok(res.status === 403, 'B1 no header -> 403');
  res = await feed(env, textUpdate('/menu'), 'wrong');            // wrong header
  ok(res.status === 403, 'B1 wrong header -> 403');
  res = await feed(env, textUpdate('/menu'), 'sec1');             // correct
  ok(res.status === 200, 'B1 correct header -> 200');
  ok(sentMethods().includes('sendMessage'), 'B1 /menu produced a sendMessage');
}

// ── B2: owner claim ──────────────────────────────────────────────────────────
console.log('B2 owner claim');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  tgLog = [];

  await feed(env, textUpdate('/start'), 'sec1');
  ok(await env.SIGNAL_CACHE.get('tg:owner') === '111', 'B2 first /start claims chat 111');
  ok(sentMethods().includes('sendMessage'), 'B2 menu sent after claim');

  tgLog = [];
  await feed(env, textUpdate('/start', 222), 'sec1');
  ok(await env.SIGNAL_CACHE.get('tg:owner') === '111', 'B2 second chat does NOT steal ownership');
  const deny = lastSent(env);
  ok(deny && deny.method === 'sendMessage' && /private/i.test(deny.body.text || ''), 'B2 second chat denied with explanation');

  tgLog = [];
  await feed(env, textUpdate('/frobnicate'), 'sec1');
  ok(lastSent(env) && /Unknown command/.test(lastSent(env).body.text || ''), 'B2 unknown command answered');

  tgLog = [];
  await feed(env, textUpdate('/id', 222), 'sec1');
  ok(/chat id: 222/.test(lastSent(env).body.text || ''), 'B2 /id is open to any chat');
}

// ── B3/B4: pair toggles ──────────────────────────────────────────────────────
console.log('B3/B4 pair toggles');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  tgLog = [];
  await feed(env, cbUpdate('pt:EUR/USD'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].enabled === false, 'B3 pt toggle turns EUR/USD OFF');
  ok(lastSent(env) && lastSent(env).method === 'answerCallbackQuery'
     && /OFF/.test(lastSent(env).body.text || ''), 'B3 toast says OFF');

  await feed(env, cbUpdate('pt:EUR/USD'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].enabled === true, 'B3 second tap turns EUR/USD back ON');

  await feed(env, cbUpdate('pt:BTC/USD'), 'sec1');
  await feed(env, cbUpdate('pa:on'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.enabled === true), 'B4 pa:on enables every pair');

  await feed(env, cbUpdate('pa:off'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.enabled === false), 'B4 pa:off disables every pair');
  await feed(env, cbUpdate('pa:on'), 'sec1');
}

// ── B5/B6: indicator toggles ─────────────────────────────────────────────────
console.log('B5/B6 indicator toggles');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  await feed(env, cbUpdate('ir:EUR/USD:mkr'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === false, 'B5 MKR OFF for EUR/USD only');
  ok(pairs['EUR/USD'].indicators.utbot.enabled === true, 'B5 UT Bot untouched on EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.enabled === true, 'B5 MKR untouched on BTC/USD');

  await feed(env, cbUpdate('ir:EUR/USD:mkr'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === true, 'B5 second tap re-enables MKR');

  // all-scope: one pair OFF -> tap enables ALL
  await mergePairPatch(env, { 'BTC/USD': { indicators: { utbot: { enabled: false } } } });
  await feed(env, cbUpdate('ir:all:utbot'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.utbot.enabled === true), 'B6 any-OFF -> ir:all enables all');
  ok(Object.values(pairs).every(p => p.indicators.mkr.enabled === true), 'B6 ir:all:utbot leaves mkr alone');

  // all ON -> tap disables ALL
  await feed(env, cbUpdate('ir:all:utbot'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.utbot.enabled === false), 'B6 all-ON -> ir:all disables all');
  await feed(env, cbUpdate('ir:all:utbot'), 'sec1');   // restore
}

// ── B7: params via buttons ───────────────────────────────────────────────────
console.log('B7 params via buttons');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  await feed(env, cbUpdate('pv:utbot:BTC/USD:a:2.5'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 2.5, 'B7 a=2.5 applied to BTC/USD');
  ok(pairs['EUR/USD'].a === 1, 'B7 a untouched on EUR/USD');

  tgLog = [];
  await feed(env, cbUpdate('pv:utbot:BTC/USD:a:99'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 2.5, 'B7 out-of-bounds a rejected, config unchanged');
  ok(/between/.test(lastSent(env).body.text || ''), 'B7 error toast explains bounds');

  await feed(env, cbUpdate('pv:utbot:all:c:14'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.c === 14), 'B7 c=14 applied to all pairs');

  await feed(env, cbUpdate('pv:mkr:all:kernel:Cauchy'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.mkr.kernel === 'Cauchy'), 'B7 kernel Cauchy applied to all pairs');

  tgLog = [];
  await feed(env, cbUpdate('pv:mkr:all:kernel:NotAKernel'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.mkr.kernel === 'Cauchy'), 'B7 bogus kernel rejected');

  await feed(env, cbUpdate('pv:mkr:EUR/USD:bandwidth:20'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 20 applied to EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.bandwidth === 14, 'B7 bandwidth untouched on BTC/USD');

  tgLog = [];
  await feed(env, cbUpdate('pv:mkr:EUR/USD:bandwidth:0'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 0 rejected (min 1)');
  await feed(env, cbUpdate('pv:mkr:EUR/USD:bandwidth:300'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 300 rejected (max 200)');
}

// ── B8: timeframe ────────────────────────────────────────────────────────────
console.log('B8 timeframe');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  await feed(env, cbUpdate('tset:all:5min'), 'sec1');
  let pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.timeframe === '5min'), 'B8 tset:all:5min applied everywhere');

  tgLog = [];
  await feed(env, cbUpdate('tset:BTC/USD:7min'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].timeframe === '5min', 'B8 invalid timeframe rejected');

  await feed(env, cbUpdate('tset:BTC/USD:1min'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].timeframe === '1min' && pairs['EUR/USD'].timeframe === '5min',
    'B8 per-pair timeframe independent');
  await feed(env, cbUpdate('tset:all:15min'), 'sec1');
}

// ── B9: deep-merge regression ────────────────────────────────────────────────
console.log('B9 mergePairPatch deep-merge');
{
  installFetch();
  const env = mkEnv();
  await mergePairPatch(env, { 'BTC/USD': { indicators: { mkr: { bandwidth: 50 } } } });
  await mergePairPatch(env, { 'BTC/USD': { indicators: { mkr: { enabled: false } } } });
  const pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].indicators.mkr.bandwidth === 50, 'B9 sibling key (bandwidth) survives partial patch');
  ok(pairs['BTC/USD'].indicators.mkr.enabled === false, 'B9 patched key applied');
  ok(pairs['BTC/USD'].indicators.mkr.kernel === 'Laplace', 'B9 default kernel intact');
  ok(pairs['BTC/USD'].a === 1 && pairs['BTC/USD'].c === 10, 'B9 pair-level values intact');
}

// ── B10: custom input flow ───────────────────────────────────────────────────
console.log('B10 custom value input');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  await feed(env, cbUpdate('aw:utbot:all:c'), 'sec1');
  const recRaw = await env.SIGNAL_CACHE.get('tg:await:111');
  ok(!!recRaw, 'B10 aw sets await state');
  ok(/ATR/.test(JSON.parse(recRaw).label || ''), 'B10 await record carries param label');

  await feed(env, textUpdate('25'), 'sec1');
  let pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.c === 25), 'B10 numeric reply applied to all pairs');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) === null, 'B10 await state cleared on success');

  await feed(env, cbUpdate('aw:utbot:BTC/USD:a'), 'sec1');
  tgLog = [];
  await feed(env, textUpdate('999'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 1, 'B10 out-of-range input rejected');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) !== null, 'B10 await state KEPT on failure (retry allowed)');
  ok(/Could not set/.test(lastSent(env).body.text || ''), 'B10 failure message shown');

  await feed(env, textUpdate('1.5'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 1.5, 'B10 retry after failure succeeds');

  await feed(env, cbUpdate('aw:utbot:BTC/USD:c'), 'sec1');
  await feed(env, textUpdate('/reset'), 'sec1');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) === null, 'B10 /reset cancels pending input');

  tgLog = [];
  await feed(env, textUpdate('hello'), 'sec1');
  ok(/\/menu/.test(lastSent(env).body.text || ''), 'B10 plain text without pending state gets the menu hint');
}

// ── B11: ensureTelegramWebhook ───────────────────────────────────────────────
console.log('B11 webhook self-registration');
{
  installFetch();
  whUrl = '';
  tgLog = [];
  const env = mkEnv();

  const r1 = await ensureTelegramWebhook(env);
  ok(r1.ok === true && r1.registered === true, 'B11 first ensure registers');
  const setCalls = tgLog.filter(x => x.method === 'setWebhook');
  ok(setCalls.length === 1, 'B11 exactly one setWebhook call');
  ok(setCalls[0].body.url === WORKER_URL + '/api/telegram/webhook', 'B11 webhook URL is the worker URL');
  ok(typeof setCalls[0].body.secret_token === 'string' && setCalls[0].body.secret_token.length >= 16,
    'B11 secret token generated');
  ok(await env.SIGNAL_CACHE.get('tg:webhookSecret') === setCalls[0].body.secret_token,
    'B11 secret stored in KV');

  tgLog = [];
  const r2 = await ensureTelegramWebhook(env);
  ok(r2.ok === true, 'B11 second ensure ok');
  ok(tgLog.filter(x => x.method === 'setWebhook').length === 0, 'B11 no re-register when URL matches');
}

// ── B12: setup endpoint ──────────────────────────────────────────────────────
console.log('B12 one-time setup endpoint');
{
  installFetch();
  whUrl = '';
  tgLog = [];
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:setupKey', 'k9');
  await env.BOT_KV.put('auto_users', JSON.stringify(['999']));
  await env.BOT_KV.put('u:999', JSON.stringify({ autoEnabled: true, chatId: 999 }));

  const req = new Request(WORKER_URL + '/api/telegram/setup?key=k9', { method: 'GET' });
  const res = await handleTelegramSetup(req, env);
  const j = await res.json();
  ok(j.ok === true, 'B12 setup succeeded');
  ok(j.owner === '999' && j.ownerSeeded === '999', 'B12 owner seeded from auto-enabled subscriber');
  ok(j.notified === true, 'B12 owner notified');
  ok(whUrl === WORKER_URL + '/api/telegram/webhook', 'B12 webhook registered via setup');
  ok((await env.SIGNAL_CACHE.get('tg:setupKey')) === null, 'B12 setup key deleted (one-time)');

  const res2 = await handleTelegramSetup(req, env);
  ok(res2.status === 403, 'B12 replayed setup key -> 403');

  const res3 = await handleTelegramSetup(
    new Request(WORKER_URL + '/api/telegram/setup?key=other', { method: 'GET' }), env);
  ok(res3.status === 403, 'B12 wrong setup key -> 403');
}

// ── B13: keyboard audit + non-owner callback ─────────────────────────────────
console.log('B13 keyboard audit + non-owner rejection');
{
  installFetch();
  const env = mkEnv();
  const { default: registryNote } = { default: null }; // (placeholder to keep import order explicit)
  const cfg = await getUtBotConfig(env);
  // Rebuild every view through the real handlers is covered elsewhere; here
  // walk the exported views by triggering callbacks and capturing edits.
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');
  const views = [];
  const navs = ['m:main', 'm:pairs', 'm:ind', 'is:all', 'is:EUR/USD', 'ir:all:utbot',
    'ir:EUR/USD:mkr', 'm:prm', 'ps:utbot', 'ps:mkr', 'pe:utbot:all', 'pe:utbot:EUR/USD',
    'pe:mkr:all', 'pe:mkr:BTC/USD', 'm:tf', 'tx:all', 'tx:EUR/USD', 'm:status'];
  for (const data of navs) {
    tgLog = [];
    await feed(env, cbUpdate(data), 'sec1');
    const edit = tgLog.find(x => x.method === 'editMessageText');
    if (edit) views.push(edit.body);
  }
  let maxLen = 0, bad = [];
  for (const v of views) {
    for (const row of (v.reply_markup ? v.reply_markup.inline_keyboard : [])) {
      for (const b of row) {
        const n = Buffer.byteLength(String(b.callback_data), 'utf8');
        maxLen = Math.max(maxLen, n);
        if (n > 64 || !/^[a-z]+:/.test(String(b.callback_data))) bad.push(b.callback_data);
      }
    }
  }
  ok(bad.length === 0 && maxLen <= 64, 'B13 all callback_data <= 64 bytes (max ' + maxLen + ')');

  const mkrEdit = views.find(v => /Params - Multi Kernel Regression/.test(v.text) && /Scope: all pairs/.test(v.text));
  const kernelTexts = [];
  for (const row of (mkrEdit ? mkrEdit.reply_markup.inline_keyboard : [])) {
    for (const b of row) if (MKR_KERNELS.some(k => (b.callback_data || '').endsWith('kernel:' + k))) kernelTexts.push(b.callback_data);
  }
  ok(kernelTexts.length === MKR_KERNELS.length,
    'B13 MKR editor lists all 17 kernels (' + kernelTexts.length + '/17)');

  // utbot editor shows a and c rows
  const utEdit = views.find(v => /Params - UT Bot Alerts/.test(v.text) && /Scope: all pairs/.test(v.text));
  ok(!!utEdit && /Key Value \(a\): 1/.test(utEdit.text) && /ATR Period \(c\): 10/.test(utEdit.text),
    'B13 UT Bot editor shows current a/c');

  // non-owner callback rejected, config untouched
  const before = await cfgOf(env);
  tgLog = [];
  await feed(env, cbUpdate('pt:BTC/USD', 222), 'sec1');
  const after = await cfgOf(env);
  ok(lastSent(env) && lastSent(env).method === 'answerCallbackQuery'
     && /Not allowed/.test(lastSent(env).body.text || ''), 'B13 non-owner callback rejected');
  ok(JSON.stringify(before) === JSON.stringify(after), 'B13 non-owner callback changed nothing');
}

// ── B14: /scan ───────────────────────────────────────────────────────────────
console.log('B14 /scan command');
{
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');

  tgLog = [];
  await feed(env, textUpdate('/scan NOTAPIIR'), 'sec1');
  ok(/Unknown pair/.test(lastSent(env).body.text || ''), 'B14 invalid pair rejected');

  tgLog = [];
  await feed(env, textUpdate('/scan EUR/USD'), 'sec1');
  const scanMsgs = tgLog.filter(x => x.method === 'sendMessage');
  ok(scanMsgs.length === 2, 'B14 valid pair: started + result messages');
  ok(scanMsgs[0] && /Scanning EUR\/USD/.test(scanMsgs[0].body.text || ''), 'B14 started message first');
  ok(scanMsgs[1] && /Scan failed/.test(scanMsgs[1].body.text || ''),
    'B14 scan path runs (fails gracefully under mocked network)');
}

// ── B15: status endpoint ─────────────────────────────────────────────────────
console.log('B15 telegram status endpoint');
{
  installFetch();
  whUrl = WORKER_URL + '/api/telegram/webhook';
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:owner', '111');
  await env.BOT_KV.put('auto_users', JSON.stringify(['999']));

  const res = await handleTelegramStatus(env);
  const j = await res.json();
  ok(j.ok === true && j.version === 'MULTI-IND-v1.3.0', 'B15 version reported');
  ok(j.ownerClaimed === true, 'B15 ownerClaimed true');
  ok(j.webhook && j.webhook.registered === true, 'B15 webhook registered reported');
  ok(j.subscribers.length === 1 && j.subscribers[0] === '999', 'B15 subscribers listed');
  ok(JSON.stringify(j).indexOf('sec') === -1 || !/webhookSecret/.test(JSON.stringify(j)),
    'B15 no secret material in status output');
}

console.log('\nbot_tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);

/**
 * Telegram bot panel tests (TV-style panel, MULTI-IND-v1.4.0) — no network,
 * no Cloudflare.
 *
 * Mocks:
 *   - KV namespaces (Map-backed): SIGNAL_CACHE, BOT_KV
 *   - global fetch: Telegram API captured (method + body logged); anything
 *     else throws (catches accidental TwelveData calls)
 *
 * Covers:
 *   B1  webhook secret verification (403 without/wrong header, 200 with)
 *   B2  /start claims owner; second chat denied; unknown command answered
 *   B3  pair scanning toggle pt:<pair> from the panel (on->off->on) + toast
 *   B4  pa:on/pa:off write every pair; pair picker shows state markers
 *   B5  indicator checkbox toggle tg:<pair>:<ind> — only that pair+indicator
 *       changes
 *   B6  PANEL AUDIT: P:<pair> renders the full TV-style settings dialog —
 *       every input listed with current value (text) + dropdown buttons
 *   B7  dropdown value set dv:<pair>:<ind>:<key>:<value> — a, c, kernel,
 *       bandwidth; valid applied, invalid rejected with error toast
 *   B8  timeframe dropdown ts:<pair>:<tf> — valid applied, invalid rejected
 *   B9  mergePairPatch deep-merge regression: partial indicators patch
 *       must NOT reset a sibling key (bandwidth) to default
 *   B10 custom input: dc:... sets await state, numeric reply applies and
 *       clears it, bad value keeps it, /reset cancels
 *   B11 ensureTelegramWebhook: registers once with a KV-stored secret,
 *       no-op when already correct
 *   B12 setup endpoint: one-time key consumed, owner seeded from push
 *       subscribers, second call rejected
 *   B13 keyboard audit: every rendered callback_data <= 64 bytes; kernel
 *       dropdown lists all 17 kernels; legacy buttons land on the picker;
 *       non-owner callback rejected + no-op
 *   B14 /scan + /panel commands
 *   B15 status endpoint reports version/webhook/owner without secrets
 *
 * Run: node scripts/bot_tests.mjs
 */

import {
  handleTelegramUpdate, handleTelegramSetup, handleTelegramStatus, ensureTelegramWebhook,
} from '../src/handlers/telegramBot.js';
import { getUtBotConfig, mergePairPatch } from '../src/handlers/utbotConfig.js';
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

function lastSent() { return tgLog[tgLog.length - 1] || null; }
function sentMethods() { return tgLog.map(x => x.method); }
function lastEdit() {
  for (let i = tgLog.length - 1; i >= 0; i--) if (tgLog[i].method === 'editMessageText') return tgLog[i].body;
  return null;
}
async function cfgOf(env) { return (await getUtBotConfig(env)).pairs; }

async function ownerEnv() {
  installFetch();
  const env = mkEnv();
  await env.SIGNAL_CACHE.put('tg:webhookSecret', 'sec1');
  await env.SIGNAL_CACHE.put('tg:owner', '111');
  return env;
}

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
  ok(/FTT panel/.test(lastSent().body.text || ''), 'B2 menu sent after claim (pair picker)');

  tgLog = [];
  await feed(env, textUpdate('/start', 222), 'sec1');
  ok(await env.SIGNAL_CACHE.get('tg:owner') === '111', 'B2 second chat does NOT steal ownership');
  ok(lastSent() && /private/i.test(lastSent().body.text || ''), 'B2 second chat denied with explanation');

  tgLog = [];
  await feed(env, textUpdate('/frobnicate'), 'sec1');
  ok(lastSent() && /Unknown command/.test(lastSent().body.text || ''), 'B2 unknown command answered');

  tgLog = [];
  await feed(env, textUpdate('/id', 222), 'sec1');
  ok(/chat id: 222/.test(lastSent().body.text || ''), 'B2 /id is open to any chat');
}

// ── B3/B4: pair scanning toggles ─────────────────────────────────────────────
console.log('B3/B4 pair scanning toggles');
{
  const env = await ownerEnv();

  tgLog = [];
  await feed(env, cbUpdate('pt:EUR/USD'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].enabled === false, 'B3 pt toggle turns EUR/USD OFF');
  const edit = lastEdit();
  ok(edit && /SETTINGS - EUR\/USD/.test(edit.text) && /Scanning: OFF/.test(edit.text),
    'B3 panel re-rendered with Scanning: OFF');
  ok(lastSent() && lastSent().method === 'answerCallbackQuery' && /OFF/.test(lastSent().body.text || ''),
    'B3 toast says OFF');

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

  // picker shows scanning markers
  tgLog = [];
  await feed(env, cbUpdate('pp'), 'sec1');
  const picker = lastEdit();
  ok(picker && /FTT panel/.test(picker.text), 'B4 picker rendered');
  ok(picker.reply_markup.inline_keyboard.flat().every(b => /^P:/.test(b.callback_data)
    || ['pa:on', 'pa:off', 'm:status', 'pp'].includes(b.callback_data)),
    'B4 picker buttons all route to panels or global actions');
}

// ── B5: indicator checkbox toggle ────────────────────────────────────────────
console.log('B5 indicator checkbox toggle');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('tg:EUR/USD:mkr'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === false, 'B5 MKR OFF for EUR/USD only');
  ok(pairs['EUR/USD'].indicators.utbot.enabled === true, 'B5 UT Bot untouched on EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.enabled === true, 'B5 MKR untouched on BTC/USD');
  const edit = lastEdit();
  ok(edit && new RegExp('\\u2610 Multi Kernel Regression').test(edit.text),
    'B5 panel shows empty checkbox for disabled indicator');
  ok(lastSent() && /OFF - EUR\/USD/.test(lastSent().body.text || ''), 'B5 toast names indicator + pair');

  await feed(env, cbUpdate('tg:EUR/USD:mkr'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === true, 'B5 second tap re-enables MKR');
}

// ── B6: panel audit ──────────────────────────────────────────────────────────
console.log('B6 TV-style panel audit');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('P:EUR/USD'), 'sec1');
  const panel = lastEdit();
  ok(!!panel, 'B6 P renders an editMessageText');
  ok(/SETTINGS - EUR\/USD/.test(panel.text), 'B6 header names the pair');
  ok(/Scanning: ON \| Timeframe: 15min/.test(panel.text), 'B6 scanning + timeframe line');
  ok(/\u2611 UT Bot Alerts/.test(panel.text), 'B6 UT Bot checkbox checked');
  ok(/Key Value \(a\) = 1/.test(panel.text) && /ATR Period \(c\) = 10/.test(panel.text),
    'B6 UT Bot inputs with current values');
  ok(/\u2611 Multi Kernel Regression/.test(panel.text), 'B6 MKR checkbox checked');
  ok(/Kernel = Laplace/.test(panel.text) && /Bandwidth = 14/.test(panel.text),
    'B6 MKR inputs with current values');
  ok(/Tap a line to change it/.test(panel.text), 'B6 usage hint present');

  const cbs = panel.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(cbs.includes('pt:EUR/USD') && cbs.includes('td:EUR/USD'), 'B6 scanning + tf buttons');
  ok(cbs.includes('tg:EUR/USD:utbot') && cbs.includes('tg:EUR/USD:mkr'), 'B6 checkbox buttons');
  ok(cbs.includes('dr:EUR/USD:utbot:a') && cbs.includes('dr:EUR/USD:utbot:c')
     && cbs.includes('dr:EUR/USD:mkr:kernel') && cbs.includes('dr:EUR/USD:mkr:bandwidth'),
    'B6 dropdown buttons for every input');
  ok(cbs.includes('pp') && cbs.includes('m:status'), 'B6 change-pair + status buttons');

  // dropdown audit: current value marked, all kernel options present
  await feed(env, cbUpdate('dr:EUR/USD:mkr:kernel'), 'sec1');
  const dd = lastEdit();
  ok(/current: Laplace/.test(dd.text), 'B6 kernel dropdown shows current');
  const kernelCbs = dd.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(MKR_KERNELS.every(k => kernelCbs.includes('dv:EUR/USD:mkr:kernel:' + k)),
    'B6 kernel dropdown lists all 17 kernels');
  ok(dd.reply_markup.inline_keyboard.flat().some(b => b.text.startsWith('\u203A')),
    'B6 current option marked in dropdown');

  await feed(env, cbUpdate('dr:EUR/USD:utbot:a'), 'sec1');
  const ddA = lastEdit();
  ok(/Allowed range: 0.1 to 20/.test(ddA.text), 'B6 numeric dropdown shows range');
  ok(ddA.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'dc:EUR/USD:utbot:a'),
    'B6 numeric dropdown has Custom value entry');
}

// ── B7: dropdown value sets ──────────────────────────────────────────────────
console.log('B7 dropdown value sets');
{
  const env = await ownerEnv();

  tgLog = [];
  await feed(env, cbUpdate('dv:BTC/USD:utbot:a:2.5'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 2.5, 'B7 a=2.5 applied to BTC/USD');
  ok(pairs['EUR/USD'].a === 1, 'B7 a untouched on EUR/USD');
  const edit = lastEdit();
  ok(edit && /Key Value \(a\) = 2.5/.test(edit.text), 'B7 panel text shows new value');

  tgLog = [];
  await feed(env, cbUpdate('dv:BTC/USD:utbot:a:99'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].a === 2.5, 'B7 out-of-bounds a rejected, config unchanged');
  ok(/between/.test(lastSent().body.text || ''), 'B7 error toast explains bounds');

  await feed(env, cbUpdate('dv:BTC/USD:utbot:c:14'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].c === 14 && pairs['EUR/USD'].c === 10, 'B7 c applied per pair');

  await feed(env, cbUpdate('dv:EUR/USD:mkr:kernel:Cauchy'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.kernel === 'Cauchy', 'B7 kernel Cauchy applied to EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.kernel === 'Laplace', 'B7 kernel untouched on BTC/USD');

  tgLog = [];
  await feed(env, cbUpdate('dv:EUR/USD:mkr:kernel:NotAKernel'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.kernel === 'Cauchy', 'B7 bogus kernel rejected');

  await feed(env, cbUpdate('dv:EUR/USD:mkr:bandwidth:20'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 20 applied to EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.bandwidth === 14, 'B7 bandwidth untouched on BTC/USD');

  tgLog = [];
  await feed(env, cbUpdate('dv:EUR/USD:mkr:bandwidth:0'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 0 rejected (min 1)');
  await feed(env, cbUpdate('dv:EUR/USD:mkr:bandwidth:300'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.bandwidth === 20, 'B7 bandwidth 300 rejected (max 200)');

  tgLog = [];
  await feed(env, cbUpdate('dv:EUR/USD:utbot:a:0.5'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].a === 0.5, 'B7 fractional preset works');
}

// ── B8: timeframe dropdown ───────────────────────────────────────────────────
console.log('B8 timeframe');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('td:EUR/USD'), 'sec1');
  const dd = lastEdit();
  ok(/Timeframe/.test(dd.text) && dd.reply_markup.inline_keyboard.flat()
    .filter(b => /^ts:EUR\/USD:/.test(b.callback_data)).length === 3,
    'B8 tf dropdown offers 3 timeframes');

  await feed(env, cbUpdate('ts:EUR/USD:5min'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].timeframe === '5min' && pairs['BTC/USD'].timeframe === '15min',
    'B8 ts applies per pair only');
  ok(lastEdit() && /Timeframe: 5min/.test(lastEdit().text), 'B8 panel shows new timeframe');

  tgLog = [];
  await feed(env, cbUpdate('ts:BTC/USD:7min'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].timeframe === '15min', 'B8 invalid timeframe rejected');
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
  const env = await ownerEnv();

  await feed(env, cbUpdate('dc:EUR/USD:utbot:c'), 'sec1');
  const recRaw = await env.SIGNAL_CACHE.get('tg:await:111');
  ok(!!recRaw, 'B10 dc sets await state');
  const rec = JSON.parse(recRaw);
  ok(rec.pair === 'EUR/USD' && rec.v === 2, 'B10 await record carries pair + schema version');
  ok(/ATR/.test(rec.label || ''), 'B10 await record carries param label');
  ok(lastEdit() && /Send a number for ATR Period \(c\)/.test(lastEdit().text),
    'B10 prompt message replaces the dropdown');

  await feed(env, textUpdate('25'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].c === 25 && pairs['BTC/USD'].c === 10, 'B10 numeric reply applied to that pair only');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) === null, 'B10 await state cleared on success');
  ok(lastEdit() && /SETTINGS - EUR\/USD/.test(lastEdit().text),
    'B10 panel restored after custom input');

  await feed(env, cbUpdate('dc:EUR/USD:utbot:a'), 'sec1');
  tgLog = [];
  await feed(env, textUpdate('999'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].a === 1, 'B10 out-of-range input rejected');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) !== null, 'B10 await state KEPT on failure (retry allowed)');
  ok(/Could not set/.test(lastSent().body.text || ''), 'B10 failure message shown');

  await feed(env, textUpdate('1.5'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].a === 1.5, 'B10 retry after failure succeeds');

  await feed(env, cbUpdate('dc:EUR/USD:utbot:c'), 'sec1');
  await feed(env, textUpdate('/reset'), 'sec1');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) === null, 'B10 /reset cancels pending input');

  tgLog = [];
  await feed(env, textUpdate('hello'), 'sec1');
  ok(/\/menu/.test(lastSent().body.text || ''), 'B10 plain text without pending state gets the menu hint');
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

// ── B13: keyboard audit + legacy buttons + non-owner ─────────────────────────
console.log('B13 keyboard audit + legacy + non-owner');
{
  const env = await ownerEnv();
  const views = [];
  const navs = ['m:main', 'pp', 'P:EUR/USD', 'P:BTC/USD',
    'dr:EUR/USD:utbot:a', 'dr:EUR/USD:utbot:c', 'dr:EUR/USD:mkr:kernel',
    'dr:EUR/USD:mkr:bandwidth', 'td:EUR/USD', 'm:status'];
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
        if (n > 64 || !/^[a-zA-Z]+:|^pp$/.test(String(b.callback_data))) bad.push(b.callback_data);
      }
    }
  }
  ok(bad.length === 0 && maxLen <= 64, 'B13 all callback_data <= 64 bytes (max ' + maxLen + ')');

  // legacy buttons from old panel versions must NOT error
  tgLog = [];
  await feed(env, cbUpdate('pe:mkr:all'), 'sec1');
  const legacy = lastEdit();
  ok(legacy && /FTT panel/.test(legacy.text) && /older panel/.test(legacy.text),
    'B13 legacy callback lands on the current picker with a note');
  tgLog = [];
  await feed(env, cbUpdate('ir:all:utbot'), 'sec1');
  ok(lastEdit() && /FTT panel/.test(lastEdit().text), 'B13 second legacy op also safe');

  // non-owner callback rejected, config untouched
  const before = await cfgOf(env);
  tgLog = [];
  await feed(env, cbUpdate('pt:BTC/USD', 222), 'sec1');
  const after = await cfgOf(env);
  ok(lastSent() && lastSent().method === 'answerCallbackQuery'
     && /Not allowed/.test(lastSent().body.text || ''), 'B13 non-owner callback rejected');
  ok(JSON.stringify(before) === JSON.stringify(after), 'B13 non-owner callback changed nothing');
}

// ── B14: /scan + /panel ──────────────────────────────────────────────────────
console.log('B14 /scan and /panel commands');
{
  const env = await ownerEnv();

  tgLog = [];
  await feed(env, textUpdate('/scan NOTAPIIR'), 'sec1');
  ok(/Unknown pair/.test(lastSent().body.text || ''), 'B14 invalid pair rejected');

  tgLog = [];
  await feed(env, textUpdate('/scan EUR/USD'), 'sec1');
  const scanMsgs = tgLog.filter(x => x.method === 'sendMessage');
  ok(scanMsgs.length === 2, 'B14 valid pair: started + result messages');
  ok(scanMsgs[0] && /Scanning EUR\/USD/.test(scanMsgs[0].body.text || ''), 'B14 started message first');
  ok(scanMsgs[1] && /Scan failed/.test(scanMsgs[1].body.text || ''),
    'B14 scan path runs (fails gracefully under mocked network)');

  tgLog = [];
  await feed(env, textUpdate('/panel BTC/USD'), 'sec1');
  const p = lastSent();
  ok(p && /SETTINGS - BTC\/USD/.test(p.body.text || '')
     && /Key Value \(a\) = 1/.test(p.body.text || ''), 'B14 /panel <PAIR> opens that pair panel');

  tgLog = [];
  await feed(env, textUpdate('/panel'), 'sec1');
  ok(/SETTINGS - /.test(lastSent().body.text || ''), 'B14 /panel without arg opens first pair');
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
  ok(j.ok === true && j.version === 'MULTI-IND-v1.4.0', 'B15 version reported');
  ok(j.ownerClaimed === true, 'B15 ownerClaimed true');
  ok(j.webhook && j.webhook.registered === true, 'B15 webhook registered reported');
  ok(j.subscribers.length === 1 && j.subscribers[0] === '999', 'B15 subscribers listed');
  ok(!/tg:webhookSecret/.test(JSON.stringify(j)), 'B15 no secret material in status output');
}

console.log('\nbot_tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);

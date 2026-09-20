/**
 * Telegram bot panel tests (premium mockup UI, MULTI-IND-v1.5.1) — no
 * network, no Cloudflare.
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
 *   B4  pa:on/pa:off write every pair; main menu renders with state
 *   B5  indicator toggle tg:<pair>:<ind> — only that pair+indicator changes
 *   B6  PANEL AUDIT: P:<pair> renders the full settings panel — every input
 *       with current value (text) + dropdown buttons, explicit ON/OFF state
 *   B7  dropdown value set dv:<pair>:<ind>:<key>:<value> — valid applied,
 *       invalid rejected with error toast
 *   B8  timeframe dropdown ts:<pair>:<tf> — valid applied, invalid rejected
 *   B9  mergePairPatch deep-merge regression: partial indicators patch
 *       must NOT reset a sibling key (bandwidth) to default
 *   B10 custom input: dc:... sets await state, numeric reply applies and
 *       clears it, bad value keeps it, /reset cancels
 *   B11 ensureTelegramWebhook: registers once with a KV-stored secret
 *   B12 setup endpoint: one-time key consumed, owner seeded, replay 403
 *   B13 keyboard audit: every rendered callback_data <= 64 bytes; kernel
 *       dropdown lists all 17 kernels; legacy buttons land on the menu;
 *       non-owner callback rejected + no-op
 *   B14 /scan + /panel commands
 *   B15 status endpoint reports version/webhook/owner without secrets
 *   B16 UNIVERSE: full catalog seeded (66 pairs, extra ones OFF), add a pair
 *       from the panel (pt:USD/INR), scanner derivation picks it up, OTC +
 *       junk pairs rejected
 *   B17 SEARCH: "eurusd" -> EUR/USD, partial "gbp", non-catalog "usdinr",
 *       no-match hint, await state lifecycle
 *   B18 ALL-PAIRS settings screen: dva/tga/tsa apply to every pair, mixed
 *       display, tda dropdown
 *   B19 Scan now (sc:) — graceful under mocked network, panel re-renders
 *   B20 Select Pair categories: menu, majors listing, act = enabled only
 *
 * Run: node scripts/bot_tests.mjs
 */

import {
  handleTelegramUpdate, handleTelegramSetup, handleTelegramStatus, ensureTelegramWebhook,
} from '../src/handlers/telegramBot.js';
import { getUtBotConfig, mergePairPatch } from '../src/handlers/utbotConfig.js';
import { enabledPairsFromConfig } from '../src/handlers/scan.js';
import { MKR_KERNELS } from '../src/strategy/multiKernelRegression.mjs';
import { CATALOG_PAIRS, searchPairs, orderPairs, isKnownPair } from '../src/utils/pairCatalog.js';

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
function sentTexts() { return tgLog.filter(x => x.method === 'sendMessage').map(x => x.body.text || ''); }
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
  ok(/FTT Panel/i.test(lastSent().body.text || ''), 'B2 menu sent after claim (main menu)');

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

  // main menu renders with add/search/status buttons
  tgLog = [];
  await feed(env, cbUpdate('pp'), 'sec1');
  const menu = lastEdit();
  ok(menu && /FTT Panel/i.test(menu.text), 'B4 main menu rendered');
  const cbs = menu.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(['cat', 'srch', 'as', 'm:status', 'pp'].every(x => cbs.includes(x)),
    'B4 menu has Add pair + Search + All-pairs settings + Status');
  ok(cbs.some(d => /^P:/.test(d)), 'B4 active pairs route to their panels');
}

// ── B5: indicator toggle ─────────────────────────────────────────────────────
console.log('B5 indicator toggle');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('tg:EUR/USD:mkr'), 'sec1');
  let pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === false, 'B5 MKR OFF for EUR/USD only');
  ok(pairs['EUR/USD'].indicators.utbot.enabled === true, 'B5 UT Bot untouched on EUR/USD');
  ok(pairs['BTC/USD'].indicators.mkr.enabled === true, 'B5 MKR untouched on BTC/USD');
  const edit = lastEdit();
  ok(edit && /Multi Kernel Regression: OFF/.test(edit.text),
    'B5 panel shows explicit OFF for disabled indicator');
  ok(lastSent() && /OFF - EUR\/USD/.test(lastSent().body.text || ''), 'B5 toast names indicator + pair');

  await feed(env, cbUpdate('tg:EUR/USD:mkr'), 'sec1');
  pairs = await cfgOf(env);
  ok(pairs['EUR/USD'].indicators.mkr.enabled === true, 'B5 second tap re-enables MKR');
}

// ── B6: panel audit ──────────────────────────────────────────────────────────
console.log('B6 settings panel audit');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('P:EUR/USD'), 'sec1');
  const panel = lastEdit();
  ok(!!panel, 'B6 P renders an editMessageText');
  ok(/SETTINGS - EUR\/USD/.test(panel.text), 'B6 header names the pair');
  ok(/Scanning: ON/.test(panel.text) && /Timeframe: 15min/.test(panel.text),
    'B6 scanning + timeframe line with explicit state');
  ok(/UT Bot Alerts: ON/.test(panel.text), 'B6 UT Bot row shows ON');
  ok(/Key Value \(a\): 1/.test(panel.text) && /ATR Period \(c\): 10/.test(panel.text),
    'B6 UT Bot inputs with current values');
  ok(/Multi Kernel Regression: ON/.test(panel.text), 'B6 MKR row shows ON');
  ok(/Kernel: Laplace/.test(panel.text) && /Bandwidth: 14/.test(panel.text),
    'B6 MKR inputs with current values');
  ok(/Tap a line to change it/.test(panel.text), 'B6 usage hint present');

  const cbs = panel.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(cbs.includes('pt:EUR/USD') && cbs.includes('td:EUR/USD'), 'B6 scanning + tf buttons');
  ok(cbs.includes('tg:EUR/USD:utbot') && cbs.includes('tg:EUR/USD:mkr'), 'B6 indicator toggle buttons');
  ok(cbs.includes('dr:EUR/USD:utbot:a') && cbs.includes('dr:EUR/USD:utbot:c')
     && cbs.includes('dr:EUR/USD:mkr:kernel') && cbs.includes('dr:EUR/USD:mkr:bandwidth'),
    'B6 dropdown buttons for every input');
  ok(cbs.includes('cat') && cbs.includes('sc:EUR/USD') && cbs.includes('m:status') && cbs.includes('pp'),
    'B6 change-pair + scan-now + status + main buttons');

  // dropdown audit: current value marked, all kernel options present
  await feed(env, cbUpdate('dr:EUR/USD:mkr:kernel'), 'sec1');
  const dd = lastEdit();
  ok(/current: Laplace/.test(dd.text), 'B6 kernel dropdown shows current');
  const kernelCbs = dd.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(MKR_KERNELS.every(k => kernelCbs.includes('dv:EUR/USD:mkr:kernel:' + k)),
    'B6 kernel dropdown lists all 17 kernels');
  ok(dd.reply_markup.inline_keyboard.flat().some(b => b.text.startsWith('\u2705')),
    'B6 current option marked with a check in the dropdown');
  ok(kernelCbs.includes('P:EUR/USD'), 'B6 dropdown has Back to panel');

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
  ok(edit && /Key Value \(a\): 2\.5/.test(edit.text), 'B7 panel text shows new value');

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
  ok(rec.pair === 'EUR/USD' && rec.v === 3 && rec.t === 'param',
    'B10 await record carries pair + schema v3');
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
  const navs = ['m:main', 'pp', 'cat', 'cat:maj', 'cat:exo', 'cat:cry', 'srch', 'as',
    'P:EUR/USD', 'P:USD/INR', 'dr:EUR/USD:utbot:a', 'dr:EUR/USD:utbot:c',
    'dr:EUR/USD:mkr:kernel', 'dr:USD/INR:mkr:kernel', 'dr:EUR/USD:mkr:bandwidth',
    'td:EUR/USD', 'tda', 'dra:utbot:a', 'dra:mkr:kernel', 'm:status'];
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
        if (n > 64 || !/^[a-zA-Z]+(:|$)/.test(String(b.callback_data))) bad.push(b.callback_data);
      }
    }
  }
  ok(bad.length === 0 && maxLen <= 64, 'B13 all callback_data <= 64 bytes (max ' + maxLen + ')');
  ok(views.length >= navs.length - 1, 'B13 every nav produced a view');

  // legacy buttons from old panel versions must NOT error
  tgLog = [];
  await feed(env, cbUpdate('pe:mkr:all'), 'sec1');
  const legacy = lastEdit();
  ok(legacy && /FTT Panel/i.test(legacy.text) && /older panel/.test(legacy.text),
    'B13 legacy callback lands on the current menu with a note');
  tgLog = [];
  await feed(env, cbUpdate('ir:all:utbot'), 'sec1');
  ok(lastEdit() && /FTT Panel/i.test(lastEdit().text), 'B13 second legacy op also safe');

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
     && /Key Value \(a\): 1/.test(p.body.text || ''), 'B14 /panel <PAIR> opens that pair panel');

  tgLog = [];
  await feed(env, textUpdate('/panel'), 'sec1');
  ok(/SETTINGS - /.test(lastSent().body.text || ''), 'B14 /panel without arg opens first pair');

  tgLog = [];
  await feed(env, textUpdate('/panel eurusd'), 'sec1');
  ok(/SETTINGS - EUR\/USD/.test(lastSent().body.text || ''), 'B14 /panel resolves "eurusd" style input');
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
  ok(j.ok === true && /^MULTI-IND-v\d+\.\d+\.\d+$/.test(j.version || ''), 'B15 version reported (' + j.version + ')');
  ok(j.ownerClaimed === true, 'B15 ownerClaimed true');
  ok(j.webhook && j.webhook.registered === true, 'B15 webhook registered reported');
  ok(j.subscribers.length === 1 && j.subscribers[0] === '999', 'B15 subscribers listed');
  ok(!/tg:webhookSecret/.test(JSON.stringify(j)), 'B15 no secret material in status output');
}

// ── B16: full pair universe ──────────────────────────────────────────────────
console.log('B16 full pair universe');
{
  const env = await ownerEnv();

  // catalog seeded: defaults ON, everything else OFF
  const pairs = await cfgOf(env);
  ok(pairs['BTC/USD'].enabled === true && pairs['EUR/USD'].enabled === true,
    'B16 default 8 pairs seeded ON');
  ok(pairs['USD/CHF'].enabled === false && pairs['USD/INR'].enabled === false,
    'B16 extra catalog pairs seeded OFF (quota guard)');
  ok(CATALOG_PAIRS.length >= 60, 'B16 catalog has 60+ pairs (' + CATALOG_PAIRS.length + ')');

  // add a pair straight from the panel
  tgLog = [];
  await feed(env, cbUpdate('pt:USD/INR'), 'sec1');
  const after = await cfgOf(env);
  ok(after['USD/INR'] && after['USD/INR'].enabled === true, 'B16 pt:USD/INR enables a non-default pair');
  ok(/SETTINGS - USD\/INR/.test(lastEdit().text) && /Scanning: ON/.test(lastEdit().text),
    'B16 panel for the new pair shows Scanning: ON');

  // scanner derivation follows the config, not a hardcoded list
  const cfg = await getUtBotConfig(env);
  const enabled = enabledPairsFromConfig(cfg);
  ok(enabled.includes('USD/INR') && enabled.includes('BTC/USD'), 'B16 enabledPairsFromConfig picks up new pair');
  ok(!enabled.includes('USD/CHF'), 'B16 disabled pairs stay out of the scan');

  // ordering: catalog first (majors before crypto), custom pairs after
  const ordered = orderPairs(cfg.pairs);
  ok(ordered.indexOf('EUR/USD') < ordered.indexOf('BTC/USD') && ordered.indexOf('BTC/USD') >= 0,
    'B16 orderPairs keeps catalog order');

  // OTC + junk never enter the store
  const r1 = await mergePairPatch(env, { 'EUR/USD-OTC': { enabled: true } });
  ok(r1.ok === false, 'B16 OTC pair rejected');
  const r2 = await mergePairPatch(env, { 'XXX/YYY': { enabled: true } });
  ok(r2.ok === false, 'B16 junk pair rejected');
  ok(isKnownPair('USD/CNH') && !isKnownPair('EUR/USD-OTC'), 'B16 isKnownPair filters OTC');

  // disabling works the same way
  await feed(env, cbUpdate('pt:USD/INR'), 'sec1');
  const off = await cfgOf(env);
  ok(off['USD/INR'].enabled === false, 'B16 second tap disables the pair again');
}

// ── B17: pair search ─────────────────────────────────────────────────────────
console.log('B17 pair search');
{
  // resolver unit checks
  ok(searchPairs('eurusd')[0] === 'EUR/USD', 'B17 "eurusd" resolves EUR/USD');
  ok(searchPairs('EUR/USD')[0] === 'EUR/USD', 'B17 "EUR/USD" resolves directly');
  ok(searchPairs('gbpjpy')[0] === 'GBP/JPY', 'B17 "gbpjpy" resolves GBP/JPY');
  ok(searchPairs('btc').includes('BTC/USD'), 'B17 "btc" lists BTC/USD');
  ok(searchPairs('usdinr')[0] === 'USD/INR', 'B17 "usdinr" resolves non-popular pair');
  ok(searchPairs('zzzqq').length === 0, 'B17 garbage query matches nothing');

  // bot flow: srch -> type -> results
  const env = await ownerEnv();
  await feed(env, cbUpdate('srch'), 'sec1');
  const rec = JSON.parse(await env.SIGNAL_CACHE.get('tg:await:111'));
  ok(rec && rec.t === 'search' && rec.v === 3, 'B17 srch arms the search await state');
  const prompt = lastEdit();
  ok(prompt && /Search pair/.test(prompt.text), 'B17 prompt message shown');

  await feed(env, textUpdate('eurusd'), 'sec1');
  const results = lastEdit();
  ok(results && /Search: "eurusd"/.test(results.text), 'B17 results view names the query');
  ok(results.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'P:EUR/USD'),
    'B17 EUR/USD tappable in results');
  ok((await env.SIGNAL_CACHE.get('tg:await:111')) === null, 'B17 await state cleared after search');

  await feed(env, cbUpdate('srch'), 'sec1');
  tgLog = [];
  await feed(env, textUpdate('zzzqq'), 'sec1');
  const none = lastEdit();
  ok(none && /0 matches/.test(none.text) && /Try eurusd/.test(none.text),
    'B17 no-match view gives a hint');
  ok(none.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'srch'),
    'B17 no-match view offers New search');
}

// ── B18: all-pairs settings ──────────────────────────────────────────────────
console.log('B18 all-pairs settings');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('as'), 'sec1');
  const asv = lastEdit();
  ok(asv && /All-pairs settings/.test(asv.text), 'B18 all-pairs screen renders');
  ok(/UT Bot Alerts: ON/.test(asv.text), 'B18 global indicator state shown');
  ok(/Key Value \(a\): 1/.test(asv.text), 'B18 global param value shown');

  tgLog = [];
  await feed(env, cbUpdate('dva:utbot:a:2'), 'sec1');
  let pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.a === 2), 'B18 dva sets a=2 on EVERY pair');
  ok(/Key Value \(a\): 2/.test(lastEdit().text), 'B18 screen refreshes with new value');

  await feed(env, cbUpdate('tga:mkr'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.mkr.enabled === false), 'B18 tga turns MKR OFF everywhere');

  // mixed state after a partial change; mixed -> all ON
  await mergePairPatch(env, { 'BTC/USD': { indicators: { mkr: { enabled: true } } } });
  await feed(env, cbUpdate('as'), 'sec1');
  ok(/Multi Kernel Regression: mixed/.test(lastEdit().text), 'B18 mixed state displayed');
  await feed(env, cbUpdate('tga:mkr'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.mkr.enabled === true), 'B18 mixed -> all ON');

  await feed(env, cbUpdate('tda'), 'sec1');
  const tdd = lastEdit();
  ok(tdd.reply_markup.inline_keyboard.flat().filter(b => /^tsa:/.test(b.callback_data)).length === 3,
    'B18 tda dropdown offers 3 timeframes for all pairs');
  await feed(env, cbUpdate('tsa:5min'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.timeframe === '5min'), 'B18 tsa sets timeframe everywhere');

  tgLog = [];
  await feed(env, cbUpdate('dva:mkr:bandwidth:999'), 'sec1');
  pairs = await cfgOf(env);
  ok(Object.values(pairs).every(p => p.indicators.mkr.bandwidth === 14), 'B18 out-of-range global set rejected');
}

// ── B19: scan now ────────────────────────────────────────────────────────────
console.log('B19 scan now');
{
  const env = await ownerEnv();

  tgLog = [];
  await feed(env, cbUpdate('sc:EUR/USD'), 'sec1');
  const texts = sentTexts();
  ok(texts.some(t => /Scanning EUR\/USD now/.test(t)), 'B19 scan-now starts with a status message');
  ok(texts.some(t => /Scan failed/.test(t)), 'B19 fails gracefully under mocked network');
  const panel = lastEdit();
  ok(panel && /SETTINGS - EUR\/USD/.test(panel.text), 'B19 panel re-rendered after scan');

  // disabled pair: preview explicitly marked, still no crash
  await feed(env, cbUpdate('pt:EUR/USD'), 'sec1');   // OFF
  tgLog = [];
  await feed(env, cbUpdate('sc:EUR/USD'), 'sec1');
  ok(sentTexts().some(t => /Scan failed|preview only/.test(t)), 'B19 disabled-pair preview path safe');
  await feed(env, cbUpdate('pt:EUR/USD'), 'sec1');   // back ON
}

// ── B20: Select Pair categories ──────────────────────────────────────────────
console.log('B20 Select Pair categories');
{
  const env = await ownerEnv();

  await feed(env, cbUpdate('cat'), 'sec1');
  const cats = lastEdit();
  ok(cats && /Select Pair/.test(cats.text), 'B20 categories screen renders');
  const cbs = cats.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  ok(['cat:act', 'cat:maj', 'cat:min', 'cat:exo', 'cat:cry', 'srch', 'pp'].every(x => cbs.includes(x)),
    'B20 all categories + search + main present');

  await feed(env, cbUpdate('cat:maj'), 'sec1');
  const maj = lastEdit();
  const majPairs = maj.reply_markup.inline_keyboard.flat()
    .filter(b => /^P:/.test(b.callback_data)).map(b => b.callback_data.slice(2));
  ok(majPairs.length === 7 && majPairs.includes('EUR/USD') && majPairs.includes('NZD/USD'),
    'B20 majors category lists the 7 majors');
  ok(maj.reply_markup.inline_keyboard.flat().some(b => b.text.startsWith('\u2705')),
    'B20 active pairs marked in the listing');

  await feed(env, cbUpdate('cat:exo'), 'sec1');
  const exo = lastEdit();
  ok(exo.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'P:USD/INR'),
    'B20 exotics include USD/INR');

  await feed(env, cbUpdate('cat:act'), 'sec1');
  const act = lastEdit();
  const actPairs = act.reply_markup.inline_keyboard.flat()
    .filter(b => /^P:/.test(b.callback_data)).map(b => b.callback_data.slice(2));
  ok(actPairs.length === 8 && actPairs.includes('BTC/USD'), 'B20 act category = enabled pairs only');

  await feed(env, cbUpdate('cat:bogus'), 'sec1');
  ok(lastEdit() && /Select Pair/.test(lastEdit().text), 'B20 bogus category falls back to the menu');
}

console.log('\nbot_tests: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);

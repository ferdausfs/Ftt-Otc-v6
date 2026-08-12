/**
 * Phase 10 smoke tests — node scripts/phase10_smoke.mjs
 *
 * Runs the REAL push module against in-memory KV doubles and a mocked Telegram
 * API. Covers the §5 checklist plus the two failure modes the spec did not
 * anticipate: duplicate pushes from repeated /api/signal calls, and the
 * Bot's actual gradeFilter vocabulary.
 *
 * No network.
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

let tg = [];
let tgFailFor = new Set();
function installTelegram() {
  tg = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('api.telegram.org')) throw new Error('unexpected fetch ' + u);
    const body = JSON.parse(init.body);
    tg.push({ chatId: String(body.chat_id), text: body.text, parseMode: body.parse_mode });
    if (tgFailFor.has(String(body.chat_id))) {
      return { ok: false, status: 403, text: async () => 'blocked by user', json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
  };
}

const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };

const sigOf = (over = {}, sigOver = {}) => ({
  id: 'sig_1785400000000_abcd',
  pair: 'BTC/USD',
  signal: {
    finalSignal: 'BUY',
    confidence: '87%',
    grade: { grade: 'A', label: 'EXCELLENT' },
    bestTimeframe: { timeframe: '5min' },
    recommendations: { '5min': { entry: { price: 63750 }, expiry: { totalMinutes: 10, countdown: { label: '2m 30s' } } } },
    higherTFTrend: 'BUY', marketRegime: 'TRENDING', regimeAdvice: 'Trend continuation',
    entryReason: 'EMA stack bullish (5>13>55). RSI 62 — room to run!',
    aiValidation: { status: 'OK', agrees: true },
    ...sigOver,
  },
  ...over,
});

const userOf = (o = {}) => ({
  pair: 'BTCUSD', watchlist: [], interval: 5, autoEnabled: true,
  gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: null, ...o,
});

const envOf = (users = {}, autoUsers = null) => {
  const seed = {};
  for (const [cid, u] of Object.entries(users)) seed['u:' + cid] = u;
  seed['auto_users'] = autoUsers || Object.keys(users);
  return { BOT_TOKEN: 'tok', BOT_KV: makeKV(seed), SIGNAL_CACHE: makeKV() };
};

const push = await import('../src/handlers/pushToSubscribers.js');

console.log('── §5: matching + fan-out ─────────────────────────────────');
{
  installTelegram();
  const env = envOf({ 111: userOf(), 222: userOf({ watchlist: ['BTCUSD'] , pair: 'EURUSD' }), 333: userOf() });
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf(), env);
  r();
  eq('3 matching subscribers -> 3 Telegram calls', tg.length, 3);
  eq('reported pushed count', out.pushed, 3);
  ok('watchlist match works (222 via watchlist)', tg.some(m => m.chatId === '222'));
  ok('push log written', !!env.SIGNAL_CACHE._m.get('pushLog:sig_1785400000000_abcd'));
}

console.log('\n── §5: filters ────────────────────────────────────────────');
{
  installTelegram();
  const env = envOf({ 111: userOf({ minConfidence: 80 }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({}, { confidence: '75%' }), env);
  r();
  eq('minConfidence 80 vs 75% signal -> no push', tg.length, 0);
}
{
  installTelegram();
  const env = envOf({ 111: userOf({ gradeFilter: 'A' }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({}, { grade: { grade: 'B', label: 'GOOD' } }), env);
  r();
  eq("gradeFilter 'A' vs grade B -> no push", tg.length, 0);
}
{
  // The Bot only ever stores ALL | AB | A. 'AB' must accept B — the spec's
  // numeric rank table would have rejected it.
  installTelegram();
  const env = envOf({ 111: userOf({ gradeFilter: 'AB' }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({}, { grade: { grade: 'B', label: 'GOOD' } }), env);
  r();
  eq("gradeFilter 'AB' accepts grade B", tg.length, 1);
}
{
  installTelegram();
  const env = envOf({ 111: userOf({ aiOnlyMode: true }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({}, { aiValidation: { status: 'OK', agrees: false } }), env);
  r();
  eq('aiOnlyMode with disagreeing AI -> no push', tg.length, 0);
}
{
  installTelegram();
  const env = envOf({ 111: userOf({ autoEnabled: false }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf(), env);
  r();
  eq('autoEnabled=false -> no push', tg.length, 0);
}
{
  installTelegram();
  const env = envOf({ 111: userOf({ pair: 'EURUSD', watchlist: ['GBPUSD'] }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf(), env);   // BTC/USD
  r();
  eq('pair not watched -> no push', tg.length, 0);
}

console.log('\n── §5: NO_TRADE and guards ────────────────────────────────');
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf({}, { finalSignal: 'NO_TRADE' }), env);
  r();
  eq('NO_TRADE -> 0 pushes', tg.length, 0);
  eq('reported as not actionable', out.skipped, 'not-actionable');
}
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  delete env.BOT_TOKEN;
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf(), env);
  r();
  eq('no BOT_TOKEN -> inert, no throw', out.skipped, 'no-token');
  eq('no Telegram calls', tg.length, 0);
}
{
  installTelegram();
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf(), { BOT_TOKEN: 't', SIGNAL_CACHE: makeKV() });
  r();
  eq('no BOT_KV -> no matches, no throw', out.skipped, 'no-match');
}

console.log('\n── §5: one failure must not block the others ──────────────');
{
  installTelegram();
  tgFailFor = new Set(['222']);
  const env = envOf({ 111: userOf(), 222: userOf(), 333: userOf() });
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf(), env);
  r();
  tgFailFor = new Set();
  eq('all three attempted', tg.length, 3);
  eq('two delivered', out.pushed, 2);
  const log = await env.SIGNAL_CACHE.get('pushLog:sig_1785400000000_abcd', 'json');
  eq('failed chat excluded from push log', log.map(e => e.chatId).sort(), ['111', '333']);
}

console.log('\n── duplicate-push guard (not in spec — see report §1.4) ───');
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  const r = quiet();
  // Same setup, three different signalIds — exactly what repeated /api/signal
  // calls produce (App auto-refresh 60s, Bot cron, manual views).
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_a' }), env);
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_b' }), env);
  const third = await push.pushSignalToSubscribers(sigOf({ id: 'sig_c' }), env);
  r();
  eq('same pair+direction pushed once inside the window', tg.length, 1);
  eq('subsequent attempts report locked', third.skipped, 'locked');
}
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_a' }), env);
  // opposite direction is a genuinely new event and must get through
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_b' }, { finalSignal: 'SELL' }), env);
  r();
  eq('direction flip pushes again', tg.length, 2);
}
{
  installTelegram();
  const env = envOf({ 111: userOf({ watchlist: ['ETHUSD'] }) });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_a' }), env);
  await push.pushSignalToSubscribers(sigOf({ id: 'sig_b', pair: 'ETH/USD' }), env);
  r();
  eq('different pair pushes independently', tg.length, 2);
}

console.log('\n── §5: result push ────────────────────────────────────────');
{
  installTelegram();
  const env = envOf({ 111: userOf(), 222: userOf() });
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf(), env);
  const beforeResult = tg.length;
  const record = { id: 'sig_1785400000000_abcd', pair: 'BTC/USD', direction: 'BUY', entryPrice: 63750 };
  const out = await push.pushResultToSubscribers(record, 'WIN', 63900, env);
  r();
  eq('result pushed to both original recipients', tg.length - beforeResult, 2);
  eq('reported', out.pushed, 2);
  ok('result text carries the verdict', tg[tg.length - 1].text.includes('Result: WIN'));
  ok('result text shows entry -> exit', tg[tg.length - 1].text.includes('63750'));
  eq('push log consumed (no double result)', await env.SIGNAL_CACHE.get('pushLog:sig_1785400000000_abcd', 'json'), null);
}
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  const r = quiet();
  const out = await push.pushResultToSubscribers(
    { id: 'never_pushed', pair: 'BTC/USD', direction: 'BUY', entryPrice: 1 }, 'WIN', 2, env);
  r();
  eq('signal that was never pushed -> no result push', tg.length, 0);
  eq('reported', out.skipped, 'never-pushed');
}
{
  installTelegram();
  const env = envOf({ 111: userOf() });
  const r = quiet();
  const out = await push.pushResultToSubscribers(
    { id: 'x', pair: 'BTC/USD', direction: 'BUY', entryPrice: 1 }, 'UNKNOWN', null, env);
  r();
  eq('UNKNOWN never pushes', out.skipped, 'undecided');
}

console.log('\n── §5.5: message format ───────────────────────────────────');
{
  const msg = push.formatSignalMessage(sigOf());
  ok('has signal number', msg.includes('📌 Signal No. abcd'));
  ok('has pair and timeframe', msg.includes('📊 BTC/USD | 5min'));
  ok('has direction line', msg.includes('🟢 BUY  87%  A EXCELLENT'));
  ok('has entry', msg.includes('💰 Entry: 63750'));
  ok('has expiry', msg.includes('⏰ Expiry: 10 min'));
  ok('has countdown', msg.includes('🕐 Candle closes: 2m 30s'));
  ok('has live-push footer', msg.includes('⚡ Live push · fresh generation'));
  ok('NO cached wording (Phase 9 mistake)', !/cached/i.test(msg));

  // Plain text: no parse_mode is sent, so these characters are safe as-is.
  installTelegram();
  const r = quiet();
  await push.pushSignalToSubscribers(sigOf(), envOf({ 111: userOf() }));
  r();
  eq('sendMessage omits parse_mode', tg[0].parseMode, undefined);
  ok('raw punctuation preserved verbatim', tg[0].text.includes('(5>13>55)') && tg[0].text.includes('run!'));

  // missing optional fields must not print "undefined"
  const sparse = push.formatSignalMessage({ id: 'sig_z', pair: 'X/Y', signal: { finalSignal: 'SELL', confidence: '70%' } });
  ok('sparse signal renders without undefined', !sparse.includes('undefined'), sparse);

  const res = push.formatResultMessage({ id: 'sig_q', pair: 'BTC/USD', direction: 'BUY', entryPrice: 63750 }, 'LOSS', 63700);
  ok('loss emoji', res.includes('❌'));
  ok('crypto delta uses 2dp not 0.0000', res.includes('-50.00'), res);
  const fx = push.formatResultMessage({ id: 'f', pair: 'EUR/USD', direction: 'SELL', entryPrice: 1.1730 }, 'WIN', 1.1725);
  ok('forex delta uses 5dp', /\+0\.0005/.test(fx), fx);
}

console.log('\n── §5.6: /health block ────────────────────────────────────');
{
  const env = envOf({ 111: userOf(), 222: userOf() });
  await env.SIGNAL_CACHE.put('pushLog:a', '[]');
  await env.SIGNAL_CACHE.put('pushLog:b', '[]');
  const stats = await push.getPushStats(env);
  eq('pushEnabled', stats.pushEnabled, true);
  eq('botKvBound', stats.botKvBound, true);
  eq('pushesLast24h counted', stats.pushesLast24h, 2);
  eq('subscriberCount from auto_users', stats.subscriberCount, 2);
  eq('noTokenReason null when token set', stats.noTokenReason, null);
  ok('subscriber snapshot present', Array.isArray(stats.subscribers) && stats.subscribers.length === 2);
  const off = await push.getPushStats({ SIGNAL_CACHE: makeKV() });
  eq('pushEnabled false without token', off.pushEnabled, false);
  eq('noTokenReason missing when secret absent', off.noTokenReason, 'missing');
}

console.log('\n── lock released on telegram fail (live 2026-08-12) ────');
{
  installTelegram();
  tgFailFor = new Set(['111']);
  const env = envOf({ 111: userOf() });
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf({ id: 'sig_fail1' }), env);
  r();
  tgFailFor = new Set();
  eq('failed send reports telegram-fail', out.skipped, 'telegram-fail');
  eq('lock not held after failed send',
    [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('pushLock:')).length, 0);
  const retry = await push.pushSignalToSubscribers(sigOf({ id: 'sig_fail2' }), env);
  eq('retry after fail is delivered', retry.pushed, 1);
  ok('lastAttempt recorded', !!env.SIGNAL_CACHE._m.get('push:lastAttempt'));
}

console.log('\n── auto_users shape hardening ──────────────────────────');
{
  eq('normalize numbers/objects/u: prefix',
    push.normalizeAutoUsers([111, 'u:222', { chatId: '333' }]),
    ['111', '222', '333']);
  installTelegram();
  const env = { BOT_TOKEN: 'tok', BOT_KV: makeKV({ 'u:111': userOf(), auto_users: [111] }), SIGNAL_CACHE: makeKV() };
  const r = quiet();
  const out = await push.pushSignalToSubscribers(sigOf(), env);
  r();
  eq('numeric auto_users entry still matches', out.pushed, 1);
}

console.log('\n── wiring + bans ──────────────────────────────────────────');
{
  const fs = await import('node:fs');
  const rd = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

  const sig = rd('src/handlers/signal.js');
  ok('signal.js imports the push module', sig.includes("from './pushToSubscribers.js'"));
  ok('both emit paths go through saveAndPush', (sig.match(/saveAndPush\(/g) || []).length === 3);
  ok('push is chained behind the dedup result', sig.includes('saveResult.deduped'));
  ok('push runs inside waitUntil (non-blocking)',
    sig.includes('ctx.waitUntil(persist)') || sig.includes('ctx.waitUntil(saveAndPush('));
  ok('scanner/fetch can await persist so scheduled isolate cannot drop the push',
    sig.includes('opts.awaitPersist'));

  const stats = rd('src/history/stats.js');
  ok('result checker pushes results', stats.includes('pushResultToSubscribers(record, winLoss, exitPrice, env)'));

  const health = rd('src/handlers/health.js');
  ok('/health exposes phase10', health.includes('phase10'));

  const wr = rd('wrangler.toml');
  ok('BOT_KV bound', wr.includes('binding = "BOT_KV"'));
  ok('bot namespace id correct', wr.includes('39653d1f9b5147259cf3791658f131d7'));
  // Phase F round 2: the weekly self-calibration cron (C7) was ADDED — the
  // result checker (*/2) and scanner (*/5) crons are unchanged.
  ok('crons unchanged', wr.includes('crons = ["*/2 * * * *", "*/5 * * * *", "0 0 * * 1"]'));

  ok('no deploy commands', !/wrangler deploy|git push/.test(sig + stats + health + wr));
  const pushSrc = rd('src/handlers/pushToSubscribers.js');
  // The words appear in the header comment explaining WHY it is absent;
  // assert on code by stripping comments first.
  const pushCode = pushSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no parse_mode in code (Bot Bug#1)', !pushCode.includes('parse_mode'));
  ok('uses auto_users index, not a full u: scan',
     pushSrc.includes("get('auto_users'") && !pushSrc.includes("list({ prefix: 'u:'"));
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL PHASE 10 SMOKE TESTS PASSED');

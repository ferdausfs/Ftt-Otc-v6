/**
 * Push formatting tests (v1.6.0 "premium" message rework, 2026-09-20).
 *
 * Covers the user-reported defects:
 *   - combined confluence messages printed `undefined: BUY` because the
 *     formatter read a `name` string the scanner never set -> names must
 *     always come from the registry object (it.ind.name) and always render
 *   - raw float dumps (80412.68099470844) -> fmtPrice magnitude formatting
 *   - plain-text look -> parse_mode HTML with bold indicator names
 *   - NEW safety net: a Telegram HTML parse error retries the same signal
 *     as plain text, so formatting can never drop a delivery
 *
 * Run: node scripts/push_format_tests.mjs
 */

import {
  escHtml, fmtPrice, formatUtBotText, formatMkrText, formatCombinedText,
  pushSignalToSubscribers,
} from '../src/handlers/push.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n' + name); }

/* Fixtures — exactly the shapes the scanner builds (items have `ind`, not `name`). */
const utSig = {
  engine: 'UT-BOT', finalSignal: 'BUY', pair: 'BTC/USD', market: 'CRYPTO',
  timeframe: '15min', timestamp: '2026-09-20T10:15:00.000Z',
  entryPrice: 80411.1, entryTime: '2026-09-20T10:15:00.000Z',
  audit: { event: 'buy', key: 1, atrPeriod: 10, stop: 80549.64889428618, timeframe: '15min' },
};
const mkrSig = {
  engine: 'MKR', finalSignal: 'BUY', pair: 'BTC/USD', market: 'CRYPTO',
  timeframe: '15min', timestamp: '2026-09-20T10:15:00.000Z',
  entryPrice: 80552, entryTime: '2026-09-20T10:15:00.000Z',
  audit: { event: 'up', label: 'Up', kernel: 'Laplace', bandwidth: 14, value: 80359.3504956639, timeframe: '15min' },
};
const utInd = { id: 'utbot', name: 'UT Bot Alerts', icon: '📈' };
const mkrInd = { id: 'mkr', name: 'Multi Kernel Regression', icon: '📊' };
const scannerItems = [
  { ind: utInd, sig: utSig, record: {}, label: 'BUY', detail: 'trailing stop 80549.64889428618' },
  { ind: mkrInd, sig: mkrSig, record: {}, label: 'UP', detail: 'kernel MA 80359.3504956639 (Laplace x14)' },
];

section('P1 fmtPrice — magnitude tiers, zero-trim, thousands grouping');
ok(fmtPrice(80412.68099470844) === '80,412.68', 'BTC stop 80412.68099 -> 80,412.68');
ok(fmtPrice(2583.459549603228) === '2,583.46', 'ETH stop 2583.4595 -> 2,583.46');
ok(fmtPrice(80552) === '80,552', 'integer entry 80552 -> 80,552 (no .00)');
ok(fmtPrice(80411.1) === '80,411.1', 'entry 80411.1 -> 80,411.1');
ok(fmtPrice(108.2768607590418) === '108.277', 'SOL 108.2768 -> 108.277 (3dp tier)');
ok(fmtPrice(1.3778977962197714) === '1.3779', 'XRP stop 1.37789 -> 1.3779 (5dp trim)');
ok(fmtPrice(1.3826) === '1.3826', 'XRP entry 1.3826 unchanged');
ok(fmtPrice(1.08654) === '1.08654', 'forex 5dp EUR/USD kept');
ok(fmtPrice(155.123) === '155.123', 'JPY 3dp tier');
ok(fmtPrice(0.00001234) === '0.00001234', 'micro price 8dp tier');
ok(fmtPrice(-80412.68) === '-80,412.68', 'negative keeps sign + grouping');
ok(fmtPrice('abc') === 'abc', 'non-numeric passthrough');
ok(fmtPrice(null) === '' && fmtPrice(undefined) === '', 'null/undefined -> empty line omitted');

section('P2 escHtml — Telegram HTML safety');
ok(escHtml('<b>&x') === '&lt;b&gt;&amp;x', 'escapes < > & (Telegram HTML needs no quot)');
ok(escHtml(null) === '', 'null -> empty');

section('P3 formatUtBotText — bold indicator name, clean numbers');
const tUt = formatUtBotText(utSig);
ok(tUt.includes('🤖 <b>UT BOT ALERTS</b> · <b>BTC/USD</b> (15min)'), 'bold indicator + pair header');
ok(tUt.includes('🟢 <b>BUY</b>'), 'green BUY label');
ok(tUt.includes('Candle closed: 2026-09-20 10:15 UTC'), 'candle close time');
ok(tUt.includes('💰 Entry: <code>80,411.1</code>'), 'entry clean');
ok(tUt.includes('🛑 Trailing Stop: <code>80,549.65</code>'), 'stop clean (was 80549.64889428618)');
ok(/⚙️ a=1 · c=10 · FTT v\d+\.\d+\.\d+/.test(tUt), 'params footer with version');
ok(!/undefined/.test(tUt), 'no "undefined" anywhere');
ok(!/\d{6,}\.\d{4,}/.test(tUt), 'no raw float dump with 4+ decimals');
ok(/<b>/.test(tUt), 'uses Telegram HTML bold');

section('P4 formatMkrText — MKR own vocabulary UP/DOWN');
const tMkr = formatMkrText(mkrSig);
ok(tMkr.includes('📊 <b>MULTI KERNEL REGRESSION</b> · <b>BTC/USD</b> (15min)'), 'bold MKR header');
ok(tMkr.includes('📈 <b>UP</b>'), 'UP label');
ok(tMkr.includes('🌀 Kernel MA: <code>80,359.35</code> (Laplace ×14)'), 'kernel MA clean + kernel tag');
ok(tMkr.includes('💰 Close: <code>80,552</code>'), 'close price clean');
ok(/⚙️ Laplace · bw=14 · FTT v\d+\.\d+\.\d+/.test(tMkr), 'kernel footer');
const tMkrDown = formatMkrText({ ...mkrSig, audit: { ...mkrSig.audit, event: 'down' } });
ok(tMkrDown.includes('📉 <b>DOWN</b>'), 'DOWN label red/green aware');

section('P5 formatCombinedText — scanner shape WITHOUT name field (the bug)');
const tComb = formatCombinedText(scannerItems);
ok(tComb.includes('⚡ <b>CONFLUENCE SIGNAL</b> · <b>BTC/USD</b> (15min)'), 'confluence header');
ok(tComb.includes('📈 <b>UT Bot Alerts</b> → 🟢 <b>BUY</b>'), 'UT Bot block: registry name + label (was undefined: BUY)');
ok(tComb.includes('📊 <b>Multi Kernel Regression</b> → 📈 <b>UP</b>'), 'MKR block: registry name + label');
ok(tComb.includes('🛑 Trailing Stop: <code>80,549.65</code>'), 'UT Bot stop inside block');
ok(tComb.includes('🌀 Kernel MA: <code>80,359.35</code> (Laplace ×14)'), 'MKR MA inside block');
ok(tComb.includes('💰 Entry: <code>80,411.1</code>'), 'shared entry line (first sig = UT Bot)');
ok(tComb.includes('✅ <i>Both indicators fired together</i>'), '2-indicator confluence footer');
ok(!/undefined/.test(tComb), 'THE bug: no "undefined" even without name field');
ok(!/\d\.\d{6,}/.test(tComb), 'no raw float dumps anywhere');

section('P6 combined with unknown indicator id — generic fallback');
const tUnk = formatCombinedText([
  { ind: { id: 'future', name: 'Future <Indicator>', icon: '🔮' }, sig: utSig, record: {}, label: 'BUY', detail: 'raw <detail> & stuff' },
]);
ok(tUnk.includes('🔮 <b>Future &lt;Indicator&gt;</b> → 🟢 <b>BUY</b>'), 'generic block: name escaped, label shown');
ok(tUnk.includes('raw &lt;detail&gt; &amp; stuff'), 'detail line HTML-escaped');
ok(!/undefined/.test(tUnk), 'still no undefined');
ok(tUnk.includes('✅ <i>1 indicators fired together</i>'), 'n!==2 plural footer');

section('P7 delivery — parse_mode HTML + plain-text retry on parse error');
const origFetch = global.fetch;
let tgCalls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  tgCalls.push({ url: String(url), body });
  if (tgCalls.length === 1) {
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};
const BOT_KV = {
  async get(key, type) {
    if (key === 'auto_users') return type === 'json' ? ['8429957782'] : JSON.stringify(['8429957782']);
    if (key === 'u:8429957782') return type === 'json' ? { autoEnabled: true } : JSON.stringify({ autoEnabled: true });
    return null;
  },
  async put() {},
};
const SIGNAL_CACHE = {
  store: new Map(),
  async get(k, t) { const v = this.store.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
  async put(k, v) { this.store.set(k, String(v)); },
};
const env = { BOT_KV, SIGNAL_CACHE, BOT_TOKEN: 'TEST:TOKEN' };
{
  const r = await pushSignalToSubscribers(
    { signalId: 'sig_p7', pair: 'BTC/USD', direction: 'BUY', text: formatUtBotText(utSig) }, env);
  ok(r.pushed === true && r.sent === 1, 'delivered after plain-text retry');
  ok(tgCalls.length === 2, 'exactly two sendMessage attempts');
  ok(tgCalls[0].body.parse_mode === 'HTML', 'first attempt uses parse_mode HTML');
  ok(!tgCalls[1].body.parse_mode, 'retry drops parse_mode');
  ok(!/[<>]/.test(tgCalls[1].body.text), 'retry text is plain (tags stripped)');
  ok(tgCalls[1].body.text.includes('UT BOT ALERTS'), 'retry keeps the signal text');
  ok(tgCalls[0].body.disable_web_page_preview === true, 'link previews disabled');
}

section('P8 delivery — 30-min push lock still idempotent');
{
  const r = await pushSignalToSubscribers(
    { signalId: 'sig_p7', pair: 'BTC/USD', direction: 'BUY', text: formatUtBotText(utSig) }, env);
  ok(r.pushed === false && r.sent === 0, 'same (user,pair,direction) locked — no duplicate');
  ok(tgCalls.length === 2, 'no extra Telegram calls after lock');
}

global.fetch = origFetch;

console.log('\n══════════════════════════════');
console.log('push_format_tests: ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════');
process.exitCode = fail ? 1 : 0;

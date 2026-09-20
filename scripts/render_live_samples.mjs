/**
 * Render the three premium message formats against LIVE latest-cache data
 * (fetched from /api/signals/latest) — a pixel-accurate preview of what
 * Telegram will deliver on the next signal, and a last-mile HTML sanity
 * check with real pair/kernel names from production config.
 *
 * Run: node scripts/render_live_samples.mjs [path-to-json]
 */
import { readFile } from 'node:fs/promises';
import { formatUtBotText, formatMkrText, formatCombinedText } from '../src/handlers/push.js';

const raw = JSON.parse(await readFile(process.argv[2] || '/home/z/my-project/scripts/latest_btc.json', 'utf8'));
const s = raw.signal;
const ind = s.indicators || {};

const utSig = {
  pair: s.pair, timeframe: s.timeframe,
  entryPrice: s.currentPrice, entryTime: s.timestamp,
  audit: { event: s.audit.event, key: s.audit.key, atrPeriod: s.audit.atrPeriod, stop: s.audit.stop, timeframe: s.timeframe },
};
const mkrSig = {
  pair: s.pair, timeframe: s.timeframe,
  entryPrice: s.currentPrice, entryTime: s.timestamp,
  audit: { event: ind.mkr && ind.mkr.dirUp ? 'up' : 'down', kernel: ind.mkr && ind.mkr.kernel, bandwidth: ind.mkr && ind.mkr.bandwidth, value: ind.mkr && ind.mkr.value, timeframe: s.timeframe },
};

console.log('══════════════ SINGLE: UT BOT (live data ' + s.pair + ') ══════════════');
console.log(formatUtBotText(utSig).replace(/</g, '\n<<')); // tags visible for terminal preview
console.log('\n══════════════ SINGLE: MKR (live data) ══════════════');
console.log(formatMkrText(mkrSig).replace(/</g, '\n<<'));
console.log('\n══════════════ CONFLUENCE (live data) ══════════════');
console.log(formatCombinedText([
  { ind: { id: 'utbot', name: 'UT Bot Alerts', icon: '📈' }, sig: utSig, label: utSig.audit.event === 'buy' ? 'BUY' : 'SELL', detail: '' },
  { ind: { id: 'mkr', name: 'Multi Kernel Regression', icon: '📊' }, sig: mkrSig, label: mkrSig.audit.event === 'up' ? 'UP' : 'DOWN', detail: '' },
]).replace(/</g, '\n<<'));

// Last-mile safety: render must be valid Telegram HTML (balanced tags).
const texts = [formatUtBotText(utSig), formatMkrText(mkrSig)];
texts.push(formatCombinedText([
  { ind: { id: 'utbot', name: 'UT Bot Alerts', icon: '📈' }, sig: utSig, label: 'BUY', detail: '' },
  { ind: { id: 'mkr', name: 'Multi Kernel Regression', icon: '📊' }, sig: mkrSig, label: 'UP', detail: '' },
]));
let bad = 0;
for (const t of texts) {
  const open = (t.match(/<(b|i|code)>/g) || []).length;
  const close = (t.match(/<\/(b|i|code)>/g) || []).length;
  if (open !== close) { bad++; console.error('UNBALANCED TAGS in:\n' + t); }
}
console.log('\nHTML tag balance: ' + (bad === 0 ? 'OK (all messages)' : bad + ' BAD'));

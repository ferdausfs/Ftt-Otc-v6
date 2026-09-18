/**
 * Cross-check: JS port (src/strategy/utBotAlerts.mjs) vs the independent
 * Python reference (scripts/utbot_reference.py, derived separately from the
 * frozen Pine text). Requires agreement on stop/pos/atr to 1e-12 relative
 * and EXACT agreement on every buy/sell event.
 *
 * Run:  python3 scripts/utbot_reference.py scripts/utbot_crosscheck_data.json 2000 20260918
 *       node scripts/utbot_crosscheck.mjs scripts/utbot_crosscheck_data.json
 */
import { readFileSync } from 'node:fs';
import { computeUtBot } from '../src/strategy/utBotAlerts.mjs';

const path = process.argv[2] || 'scripts/utbot_crosscheck_data.json';
const data = JSON.parse(readFileSync(path, 'utf8'));
const { candles, ref, params } = data;

const js = computeUtBot(candles, { a: params.a, c: params.c }, { tfMs: 60000 });

let checked = 0, numFail = 0, eventFail = 0, naMismatch = 0;
const EPS = 1e-12;

function close(a, b) {
  if (a === undefined && b === null) return true;      // na agreement
  if (a === undefined || b === null) return false;      // na vs value
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

for (let i = 0; i < candles.length; i++) {
  checked++;
  if (!close(js.stop[i], ref.stop[i])) numFail++;
  if (!close(js.atr[i], ref.atr[i])) numFail++;
  const pOk = js.pos[i] === undefined ? ref.pos[i] === null : js.pos[i] === ref.pos[i];
  if (!pOk) numFail++;
  if (js.buy[i] !== ref.buy[i] || js.sell[i] !== ref.sell[i]) eventFail++;
}

const jsEvents = js.events.map(e => e.i + ':' + e.type).join(',');
const refEvents = ref.buy.map((b, i) => (b ? i + ':buy' : ref.sell[i] ? i + ':sell' : null))
  .filter(Boolean).join(',');

console.log('bars checked: ' + checked);
console.log('JS events:    ' + jsEvents);
console.log('PY events:    ' + refEvents);
console.log('numeric mismatches: ' + numFail + ', event mismatches: ' + eventFail
  + ', na-pattern mismatches: ' + naMismatch);

if (numFail === 0 && eventFail === 0 && jsEvents === refEvents) {
  console.log('CROSSCHECK PASS — two independent implementations agree');
} else {
  console.error('CROSSCHECK FAIL');
  process.exit(1);
}

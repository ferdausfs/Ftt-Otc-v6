/**
 * Replay the live MKR tv engine over the worker's ACTUAL cached candle
 * window for a pair — prints every label the current curve carries (what
 * TV would show right now) with candle times in UTC.
 *
 * Run: node scripts/mkr_replay_live.mjs <kv-cache-json> [pair]
 */
import { readFile } from 'node:fs/promises';
import { computeMkrTv } from '../src/strategy/multiKernelRegression.mjs';

const file = process.argv[2] || '/home/z/my-project/scripts/sol_cache.json';
const pair = process.argv[3] || 'SOL/USD';
const rows = JSON.parse(await readFile(file, 'utf8'));
const candles = rows.map(c => ({
  t: new Date(String(c.datetime).replace(' ', 'T') + 'Z').getTime(),
  o: c.open, h: c.high, l: c.low, c: c.close,
})).filter(k => Number.isFinite(k.t));

const tfMs = candles.length >= 2 ? candles[1].t - candles[0].t : 900_000;
// Production treats the last CLOSED candle as the fit edge.
const now = Date.now();
let lastClosed = candles.length - 1;
while (lastClosed >= 0 && candles[lastClosed].t + tfMs > now) lastClosed--;

console.log('pair:', pair, '| rows:', candles.length, '| last closed:', new Date(candles[lastClosed].t).toISOString().slice(0, 16).replace('T', ' '), 'UTC');
const s = computeMkrTv(candles, { kernel: 'Laplace', bandwidth: 14 }, { tfMs, lastClosed, fresh: false });
console.log('curve last value:', s.lastValue?.toFixed(4), '| rising:', s.dirUp[candles.length - 1]);
console.log('labels on the CURRENT curve (what TV shows now):');
for (const e of s.events) {
  const labelT = new Date(candles[e.i].t).toISOString().slice(0, 16).replace('T', ' ');
  const confT = new Date(e.gateT).toISOString().slice(0, 16).replace('T', ' ');
  console.log('  ' + (e.type === 'up' ? 'UP  ' : 'DOWN') + ' | label candle ' + labelT + ' UTC | confirmed close ' + confT + ' UTC | close ' + e.price);
}

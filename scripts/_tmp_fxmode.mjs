import { makeCandleData } from './r71_fixtures.mjs';
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';
const ENV = {};

const profiles = [
  ['EUR/USD fx-sell', 'EUR/USD', 'FOREX', { basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 }],
  ['BTC/USD fx-buy',  'BTC/USD', 'CRYPTO', { basePrice: 78000, vol: 40, trend: 400, seed: 7 }],
];
for (const [name, pair, at, prof] of profiles) {
  const sig = await buildMultiTimeframeSignal(pair, makeCandleData(prof), at, ENV, { fxMode: true });
  console.log(`${name}: final=${sig.finalSignal} conf=${sig.confidence} mode=${sig.mode}`);
  console.log(`   fxLevels: ${JSON.stringify(sig.fxLevels)}`);
  console.log(`   leak? ${JSON.stringify(sig).includes('fxLevels') ? 'in-JSON' : 'no-leak'}`);
}

// FTT mode unchanged (no fxMode)
const sig2 = await buildMultiTimeframeSignal('EUR/USD', makeCandleData({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 }), 'FOREX', ENV);
console.log(`\nFTT mode (no opt): final=${sig2.finalSignal} mode=${sig2.mode || 'undefined'} fxLevels=${sig2.fxLevels || 'undefined'}`);

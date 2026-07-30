// Quick end-to-end smoke: run the real engine on generated candles, confirm it
// returns a signal and attaches the private R7.1 audit. No network/AI/KV.
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';
import { getEngineAudit } from '../src/signal/r71shadow.js';
import { makeCandleData } from './r71_fixtures.mjs';

const env = {}; // no AI keys, no SIGNAL_CACHE -> deterministic, dynAdj=0

const scenarios = [
  { name: 'bullish crypto', profile: { basePrice: 78000, vol: 60, trend: 18, seed: 11 } },
  { name: 'bearish crypto', profile: { basePrice: 78000, vol: 60, trend: -18, seed: 22 } },
  { name: 'neutral forex',  profile: { basePrice: 1.08,  vol: 0.0006, trend: 0, seed: 33 } },
];

for (const s of scenarios) {
  const candleData = makeCandleData(s.profile);
  const sig = await buildMultiTimeframeSignal('BTC/USD', candleData, 'CRYPTO', env);
  const audit = getEngineAudit(sig);
  console.log('---', s.name, '---');
  console.log('  finalSignal :', sig.finalSignal, ' confidence:', sig.confidence);
  console.log('  audit?      :', !!audit);
  if (audit) {
    console.log('  attribution :', audit.attribution, '| comparability:', audit.comparability);
    console.log('  prodPreAi   :', audit.productionPreAiDirection, '| shadow:', audit.shadowFinalDirection);
    console.log('  diagnostic  :', JSON.stringify(audit.diagnostic));
  }
  // Symbol must NOT leak into JSON
  const json = JSON.stringify(sig);
  console.log('  audit leaks in JSON?', json.includes('structureAudit') || json.includes('r71'));
}

console.log('\nSMOKE DONE');

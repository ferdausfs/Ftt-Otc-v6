/**
 * Bugfix round 1 regression suite — node scripts/fix_tests.mjs
 *
 * Covers the 6 approved fixes + CHECK-A:
 *   T1  FIX-6  classifyOutcome tie convention (WIN/LOSS/TIE)
 *   T2  FIX-4  /api/report idempotency (no double-count, pending key deleted)
 *   T3  FIX-3  fillStatus uses an independent current price (PENDING_ENTRY reachable)
 *   T4  FIX-1  push fires on signal; nopush=1 suppresses it (raw + wrapper)
 *   T5  FIX-2  D2 TRENDING block is NOT overridden by AI rescue
 *   T6  FIX-5  post-AI confidence floor: no BUY/SELL below 72% + wiring check
 *   T7  CHECK-A passAI accepts the post-AI dual-combiner shape
 *
 * Engine runs use real modules with only network stubbed (same pattern as
 * phase10_integration.mjs); KV is an in-memory double.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyOutcome } from '../src/history/stats.js';
import { passAI } from '../src/handlers/pushToSubscribers.js';
import { handleReport } from '../src/handlers/health.js';
import { handleSignalRaw, handleSignal } from '../src/handlers/signal.js';
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

// ── in-memory KV ──────────────────────────────────────────────
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

// NOTE: candle fields must be NUMBERS — the engine's EMA/ATR math concatenates
// strings ("90.00" + "90.10") into NaN. In production the fetch layer
// parseFloats raw API values; here we pre-parse.
// Fixtures are returned in TWELVEDATA ORDER (newest candle FIRST) because the
// production fetch layer (fetchCandles) reverses them before the engine sees
// them. Direct engine callers (T3) must reverse back with [...x].reverse().
// Fixed 0.15 candle range: verified to produce BUY/RANGING/77% through the
// full /api/signal path.
function series(n, base, step) {
  const out = []; let c = base;
  for (let i = 0; i < n; i++) {
    const o = c; c = c + step;
    out.push({
      datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
      open: o, high: Math.max(o, c) + 0.15,
      low: Math.min(o, c) - 0.15, close: c, volume: 1000,
    });
  }
  return out.reverse();
}

// fast oscillation → ADX ~10 (RANGING regime). Needed so the D2 TRENDING block
// (FIX-2) does not interfere with the fillStatus / push assertions — a steady
// uptrend now legitimately produces NO_TRADE. Newest-first, see series() note.
function seriesFastSin(n, base, amp) {
  const out = []; let c = base;
  for (let i = 0; i < n; i++) {
    const o = c;
    c = base + Math.sin(i / 1.3) * amp;
    out.push({
      datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
      open: o, high: Math.max(o, c) + amp,
      low: Math.min(o, c) - amp, close: c, volume: 1000,
    });
  }
  return out.reverse();
}

const quiet = () => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; return () => { console.warn = w; console.log = l; }; };
const drain = async (sink) => { await Promise.allSettled(sink); sink.length = 0; };
const ctxOf = (sink) => ({ waitUntil: (p) => { sink.push(Promise.resolve(p).catch(() => {})); return p; } });

const confPct = (sig) => parseInt(String((sig && sig.confidence) || '0%').replace('%', ''), 10) || 0;

console.log('── T1: classifyOutcome tie convention (FIX-6) ─────────────');
{
  eq('BUY up -> WIN', classifyOutcome('BUY', 100, 105), 'WIN');
  eq('BUY down -> LOSS', classifyOutcome('BUY', 100, 95), 'LOSS');
  eq('SELL down -> WIN', classifyOutcome('SELL', 100, 95), 'WIN');
  eq('SELL up -> LOSS', classifyOutcome('SELL', 100, 105), 'LOSS');
  eq('BUY exact tie -> TIE', classifyOutcome('BUY', 74.03, 74.03), 'TIE');
  eq('SELL exact tie -> TIE', classifyOutcome('SELL', 0.842, 0.842), 'TIE');
  eq('BUY float-wiggle tie -> TIE', classifyOutcome('BUY', 74.03, 74.03 + 1e-13), 'TIE');
  eq('missing exit -> UNKNOWN', classifyOutcome('BUY', 100, null), 'UNKNOWN');
}

console.log('\n── T2: /api/report idempotency (FIX-4) ───────────────────');
{
  const entryPrice = 100;
  const histRow = {
    id: 'sig_1', pair: 'TEST/USD', direction: 'BUY', confidence: '80%', grade: 'A',
    entryPrice, expiryTime: new Date(Date.now() + 600000).toISOString(), bestTF: '5min',
    alignment: 'ALL_BULLISH', marketRegime: 'RANGING', session: ['24/7'], sessionQuality: 'N/A',
    aiAgreed: true, timestamp: new Date().toISOString(), result: null, exitPrice: null, checkedAt: null,
  };
  const env = { SIGNAL_CACHE: makeKV({
    'sig:TEST_USD': [histRow],
    'pending:sig_1': { ...histRow },
  }) };

  const r1 = await handleReport(new URL('https://x/api/report?id=sig_1&result=WIN'), env);
  const b1 = await r1.json();
  const stats1 = await env.SIGNAL_CACHE.get('stats:TEST_USD', 'json');
  const pendingAfter1 = await env.SIGNAL_CACHE.get('pending:sig_1');

  ok('first report success', b1.success === true);
  eq('first report counts one win', stats1 && stats1.wins, 1);
  eq('first report counts zero losses', stats1 && stats1.losses, 0);
  ok('pending key deleted after report', pendingAfter1 === null);

  const r2 = await handleReport(new URL('https://x/api/report?id=sig_1&result=LOSS'), env);
  const b2 = await r2.json();
  const stats2 = await env.SIGNAL_CACHE.get('stats:TEST_USD', 'json');

  ok('second report flagged alreadyRecorded', b2.alreadyRecorded === true);
  eq('no double count: wins still 1', stats2 && stats2.wins, 1);
  eq('no double count: losses still 0', stats2 && stats2.losses, 0);
  eq('totalSignals not inflated', stats2 && stats2.totalSignals, 1);
  const hist = await env.SIGNAL_CACHE.get('sig:TEST_USD', 'json');
  eq('history row keeps the first verdict', hist[0].result, 'WIN');
}

console.log('\n── T3: fillStatus uses an independent current price (FIX-3) ─');
{
  // direct engine call -> fixtures must be chronological (oldest first)
  const rev = (arr) => [...arr].reverse();
  const candleData = {
    // 1min: mild uptrend (freshest data, current price ~91.99)
    '1min': rev(series(100, 90, 0.02)),
    // 5min: strong uptrend -> BUY votes
    '5min': rev(series(100, 90, 0.1)),
    // 15min: fast oscillation -> ADX ~10, RANGING regime (no D2 block)
    '15min': rev(seriesFastSin(100, 90, 0.4)),
  };
  const r = quiet();
  const sig = await buildMultiTimeframeSignal('TEST/USD', candleData, 'CRYPTO', {}, {});
  r();

  ok('engine produced a tradeable signal', sig.finalSignal === 'BUY' || sig.finalSignal === 'SELL', sig.finalSignal);
  if (sig.finalSignal !== 'NO_TRADE') {
    eq('fillStatus reflects price away from entry', sig.fillStatus, 'PENDING_ENTRY');
    ok('entryDistancePct > 0', sig.entryDistancePct > 0, 'got ' + sig.entryDistancePct);
    ok('currentPrice != entryPrice', sig.currentPrice !== sig.entryPrice,
      sig.currentPrice + ' vs ' + sig.entryPrice);
    // T6 invariant: any emitted BUY/SELL must be at/above the 72% floor
    ok('emitted confidence at/above 72% floor', confPct(sig) >= 72, sig.confidence);
  }

  // sub-case: all TFs end at the same close -> INSTANT is correct.
  // Identical fastSin series for every TF (RANGING, same last close, and the
  // best TF is the lowest — so entry == current price by construction).
  const same = {
    '1min': rev(seriesFastSin(100, 100, 0.4)),
    '5min': rev(seriesFastSin(100, 100, 0.4)),
    '15min': rev(seriesFastSin(100, 100, 0.4)),
  };
  const r2 = quiet();
  const sig2 = await buildMultiTimeframeSignal('TEST/USD', same, 'CRYPTO', {}, {});
  r2();
  if (sig2.finalSignal !== 'NO_TRADE') {
    eq('fillStatus INSTANT when entry == current', sig2.fillStatus, 'INSTANT');
  }
}

console.log('\n── T4: push fires; nopush=1 suppresses (FIX-1) ───────────');
{
  let tg = [];
  const installNet = () => {
    tg = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        const b = JSON.parse(init.body);
        tg.push({ chatId: String(b.chat_id), text: b.text });
        return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
      }
      if (u.includes('twelvedata')) {
        // per-interval data: 15min oscillates (RANGING, ADX ~10) so the D2
        // TRENDING block (FIX-2) does not suppress the signal under test.
        // 100 candles: verified BUY/RANGING/77% (fastSin phase is stable here;
        // 120 candles flips the 15min vote to SELL -> MIXED -> NO_TRADE).
        const interval = new URL(u).searchParams.get('interval');
        let values;
        if (interval === '15min') values = seriesFastSin(100, 100, 0.4);
        else if (interval === '5min') values = series(100, 100, 0.1);
        else values = series(100, 100, 0.02);
        return { ok: true, status: 200, json: async () => ({ values }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 85, reason: 'stub', concerns: null }) } }] }), text: async () => '' };
    };
  };
  const envOf = () => {
    const seed = { 'u:111': { pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: null } };
    seed['auto_users'] = ['111'];
    return { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: 'tok', TWELVEDATA_API_KEY_1: 'k', CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' };
  };

  installNet();
  const env1 = envOf(); const sink1 = [];
  const q1 = quiet();
  const res1 = await handleSignalRaw('BTC/USD', env1, ctxOf(sink1));
  await drain(sink1); q1();
  ok('T4a: engine produced an actionable signal', ['BUY', 'SELL'].includes(res1.signal.finalSignal), res1.signal.finalSignal);
  eq('T4a: subscriber received exactly one message', tg.length, 1);
  ok('T4a: push log written for the emitted id', !!env1.SIGNAL_CACHE._m.get('pushLog:' + res1.id));

  installNet();
  const env2 = envOf(); const sink2 = [];
  const q2 = quiet();
  const res2 = await handleSignalRaw('BTC/USD', env2, ctxOf(sink2), { noPush: true });
  await drain(sink2); q2();
  ok('T4b: engine still produced a signal with nopush', ['BUY', 'SELL'].includes(res2.signal.finalSignal), res2.signal.finalSignal);
  eq('T4b: nopush suppresses the push', tg.length, 0);

  installNet();
  const env3 = envOf(); const sink3 = [];
  const q3 = quiet();
  const resp3 = await handleSignal('BTC/USD', env3, ctxOf(sink3), { noPush: true });
  const body3 = await resp3.json();
  await drain(sink3); q3();
  ok('T4c: handleSignal forwards nopush (response ok)', body3 && !body3.error && body3.signal, '');
  eq('T4c: nopush via handleSignal suppresses the push', tg.length, 0);
}

console.log('\n── T5: D2 TRENDING block not overridden by AI rescue (FIX-2) ─');
{
  const rev = (arr) => [...arr].reverse();
  const candleData = {
    '1min': rev(series(100, 90, 0.1)),
    '5min': rev(series(100, 90, 0.1)),
    '15min': rev(series(100, 90, 0.1)),
  };
  // AI keys present + stub fetch agreeing BUY — pre-fix this revived the trade
  globalThis.fetch = async (url) => {
    const u = String(url);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 88, reason: 'stub', concerns: null }) } }] }), text: async () => '' };
  };
  const env = { CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' };
  const r = quiet();
  const sig = await buildMultiTimeframeSignal('TEST/USD', candleData, 'CRYPTO', env, {});
  r();

  eq('TRENDING signal stays NO_TRADE despite AI agreement', sig.finalSignal, 'NO_TRADE');
  ok('D2_TRENDING_BLOCK applied', (sig.filtersApplied || []).some(f => f.includes('D2_TRENDING_BLOCK')),
    JSON.stringify(sig.filtersApplied));
  ok('AI rescue explicitly skipped for the D2 block', (sig.filtersApplied || []).some(f => f.includes('AI_RESCUE_SKIPPED')),
    JSON.stringify(sig.filtersApplied));
  ok('no AI_RESCUE revival', !(sig.filtersApplied || []).some(f => f.startsWith('AI_RESCUE:')));
}

console.log('\n── T6: post-AI confidence floor (FIX-5) ─────────────────');
{
  const engineSrc = fs.readFileSync(fileURLToPath(new URL('../src/signal/engine.js', import.meta.url)), 'utf8');
  const aiEnd = engineSrc.indexOf('DUAL_AI_DISAGREE_BLOCK');
  const floorIdx = engineSrc.indexOf('BELOW_FLOOR_AFTER_AI');
  const buildIdx = engineSrc.indexOf('BUILD OUTPUTS');
  ok('post-AI floor check present in engine', floorIdx > -1);
  ok('floor check sits after the AI block, before outputs', floorIdx > aiEnd && floorIdx < buildIdx);
  ok('floor uses MIN_CONFIDENCE_FLOOR constant', engineSrc.slice(floorIdx, floorIdx + 200).includes('MIN_CONFIDENCE_FLOOR'));
}

console.log('\n── T7: passAI accepts the post-AI shape (CHECK-A) ────────');
{
  // standard engine post-AI shape: no top-level status (combine.js replaces it)
  const standard = { aiValidation: { cerebras: {}, groq: {}, combined: { status: 'OK', signal: 'BUY' }, combinedAgreed: true, agrees: true } };
  // OTC shape: top-level status
  const otc = { aiValidation: { status: 'OK', signal: 'BUY', agrees: true } };
  const skipped = { aiValidation: { status: 'SKIPPED' } };
  const oldBroken = { aiValidation: { combined: { status: 'OK' }, agrees: true } }; // no top-level status (pre-fix shape)

  ok('passAI(aiOnly=false) always true', passAI(standard, false) === true);
  ok('standard post-AI shape accepted', passAI(standard, true) === true);
  ok('OTC shape accepted', passAI(otc, true) === true);
  ok('SKIPPED rejected', passAI(skipped, true) === false);
  ok('pre-fix shape now accepted too (status derived from combined)', passAI(oldBroken, true) === true);
}

console.log('\n───────────────────────────────────────────────────────────');
console.log(fail === 0 ? 'PASS: ' + pass + '   FAIL: 0' : 'PASS: ' + pass + '   FAIL: ' + fail);
console.log(fail === 0 ? 'ALL FIX TESTS PASSED' : 'FAILURES: ' + failures.join(', '));
process.exit(fail === 0 ? 0 : 1);

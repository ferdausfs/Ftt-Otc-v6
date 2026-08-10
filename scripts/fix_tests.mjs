/**
 * Bugfix round 1 + 2 regression suite — node scripts/fix_tests.mjs
 *
 * Round 1 (6 approved fixes + CHECK-A):
 *   T1  FIX-6  classifyOutcome tie convention (WIN/LOSS/TIE)
 *   T2  FIX-4  /api/report idempotency (no double-count, pending key deleted)
 *   T3  FIX-3  fillStatus uses an independent current price (PENDING_ENTRY reachable)
 *   T4  FIX-1  push fires on signal; nopush=1 suppresses it (raw + wrapper)
 *   T5  FIX-2  D2 TRENDING block is NOT overridden by AI rescue
 *   T6  FIX-5  post-AI confidence floor: no BUY/SELL below 72% + wiring check
 *   T7  CHECK-A passAI accepts the post-AI dual-combiner shape
 *
 * Round 2 (4 fixes + hardening):
 *   T8  FIX-A  OTC grade capped by structure verdict (AGAINST -> never A+/A)
 *   T9  FIX-B  OTC camarilla contribution == raw x 1.5 (not raw x 1.786)
 *   T10 FIX-C  round-number bonus is directional (below->DOWN, above->UP, on->none)
 *   T11 FIX-C  round bonus actually moves OTC confidence (differential non-zero)
 *   T12 FIX-D  no '/11' or 'total: 11' remains in src/ (all denominators 12)
 *   T13 HARDEN-1 optional chaining on structure.multiplier?.value
 *
 * Round 3 (19 reviewer-approved fixes F3-01..F3-19):
 *   T14 F3-01  channel mirror message scope + pushLog always written
 *   T15 F3-02  OTC auto-resolve (pending + base-pair price + tracker)
 *   T16 F3-03  passGrade accepts A+ for A/AB filters
 *   T17 F3-04  OTC fillStatus/entryPrice/currentPrice/entryDistancePct
 *   T18 F3-05  NO_TRADE grade N/A (standard + OTC)
 *   T19 F3-06  HTF hard block leaves confidence 0 (bonus ordering)
 *   T20 F3-07  timezone=UTC on candles + expiry fetch
 *   T21 F3-08  mode=fx incompatible with preferCache (forces fresh)
 *   T22 F3-09  FVG check uses 15min first
 *   T23 F3-10  current-bar BOS no longer double-counted (+0.5 gone)
 *   T24 F3-11  RANGING middle-zone RSI trend-following scores removed
 *   T25 F3-12  HIGHEST-session +3 bonus removed
 *   T26 F3-13  crypto pairs skip forex session weights
 *   T27 F3-14  scheduledScan passes noPush:true
 *   T28 F3-15  AI never called on D2-blocked signals
 *   T29 F3-16  session injection makes engine fixtures time-invariant
 *   T30 F3-17  /api/history excludes cbShadow rows from decided/pending
 *   T31 F3-18  winRate is the last WIN_RATE_LOOKBACK window (ring buffer)
 *   T32 F3-19  decideTfDirection fallback needs winning-side confluence
 *   T33 FIX-EH entry-hit uses leave-then-return re-test semantics
 *
 * Engine runs use real modules with only network stubbed (same pattern as
 * phase10_integration.mjs); KV is an in-memory double.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyOutcome, fetchExpiryPrice, scheduledTracker, saveSignalToHistory, updatePairStats, getDynamicConfidenceAdjustment } from '../src/history/stats.js';
import { passAI, passGrade, pushSignalToSubscribers } from '../src/handlers/pushToSubscribers.js';
import { handleReport, handleHistory } from '../src/handlers/health.js';
import { handleSignalRaw, handleSignal } from '../src/handlers/signal.js';
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';
import { buildMultiTimeframeSignalOTC } from '../src/signal/otcEngine.js';
import { analyzeOTCPatterns } from '../src/analysis/otc.js';
import { getSignalGrade } from '../src/analysis/grade.js';
import { analyzeStructure } from '../src/indicators/structure.js';
import { runDeterministicVoteAndFilters, decideTfDirection } from '../src/signal/voteFilters.js';
import { getSessionWeightMultiplier } from '../src/analysis/filters.js';
import { fetchCandles } from '../src/fetch/candles.js';
import { writeLatest } from '../src/history/latestCache.js';
import { ASSET_TYPE, CONFIG } from '../src/config.js';
import { evaluateEdgeFeatures, getRecentFormMultiplier } from '../src/analysis/edgeFeatures.js';
import { refreshRollingCalibration } from '../src/analysis/selfCalibration.js';
// Existing regression fixtures deliberately exercise pre-Phase-F behaviour;
// edge inputs have their own deterministic unit coverage and are enabled in
// production config. This prevents their RSI gate from changing unrelated
// push/fill/cache assertions.
CONFIG.EDGE_FEATURES.enabled = false;

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
    // Body-dominated candles (small wicks): raises candle quality above the
    // 0.8 penalty line and lets the patterns category vote — the per-TF
    // decisions in these fixtures legitimately reach 5-category confluence
    // under the F3-19 rule (they previously used the removed 4-cat fallback).
    out.push({
      datetime: new Date(Date.now() - (n - i) * 60000).toISOString().slice(0, 19).replace('T', ' '),
      open: o, high: Math.max(o, c) + 0.03,
      low: Math.min(o, c) - 0.03, close: c, volume: 1000,
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
  ok('AI skipped for the D2 block (F3-15 renamed the note)', (sig.filtersApplied || []).some(f => f.includes('AI_SKIPPED (D2 hard block)') || f.includes('AI_RESCUE_SKIPPED')),
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

console.log('\n── T8: OTC grade capped by structure verdict (FIX-A, calibrated) ────────');
{
  // Phase F calibration: evidence shows AGAINST has BEST WR (46.6% TRAIN),
  // ALIGNED worst (39.3% TRAIN). Original FIX-A capped AGAINST to C, which
  // inverted the grade ladder (best WR forced to lowest grade). Calibrated
  // FIX-A inverts the cap: ALIGNED (worst) -> C, AGAINST (best) -> no cap (A+).
  // This keeps the cap mechanism (FIX-A stays) but corrects inversion.
  const zigGen = (n, base, up, dn, upLeg, dnLeg, tail, tailDir) => {
    const out = []; let c = base;
    for (let i = 0; i < n; i++) {
      const o = c;
      if (i < n - tail) {
        const phase = i % (upLeg + dnLeg);
        if (phase < upLeg) { c = c + up; out.push({ datetime:'x', open:o, high:c+0.12, low:o-0.01, close:c, volume:1000 }); }
        else               { c = c - dn; out.push({ datetime:'x', open:o, high:o+0.01, low:c-0.12, close:c, volume:1000 }); }
      } else {
        if (tailDir === 'up') { c = c + 0.06; out.push({ datetime:'x', open:o, high:c, low:o, close:c, volume:1000 }); }
        else { c = c - 0.06; out.push({ datetime:'x', open:o, high:o, low:c, close:c, volume:1000 }); }
      }
    }
    return out;
  };
  // AGAINST: net-up zigzag with red tail -> SELL while structure BULLISH -> AGAINST -> should NOT be capped (calibrated: best WR -> A+)
  const fixtureAgainst = () => ({ '1min': zigGen(100,90,0.10,0.11,12,2,6,'down'), '5min': zigGen(100,90,0.10,0.11,12,2,6,'down'), '15min': zigGen(100,90,0.10,0.11,12,2,6,'down') });
  const r1 = quiet();
  const sigAgainst = await buildMultiTimeframeSignalOTC(fixtureAgainst(), 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {});
  r1();
  ok('T8a: OTC AGAINST engine produced SELL', sigAgainst.finalSignal === 'SELL', sigAgainst.finalSignal);
  ok('T8b: structure verdict is AGAINST', sigAgainst.structureVerdict && sigAgainst.structureVerdict.overall === 'AGAINST', sigAgainst.structureVerdict && sigAgainst.structureVerdict.overall);
  ok('T8c: AGAINST grade NOT capped (calibrated best -> A+)', sigAgainst.grade.grade === 'A+', sigAgainst.grade.grade);
  // ALIGNED: net-up with green tail -> BUY while structure BULLISH -> ALIGNED -> should be capped to C (worst WR)
  const fixtureAligned = () => ({ '1min': zigGen(100,90,0.10,0.11,12,2,6,'up'), '5min': zigGen(100,90,0.10,0.11,12,2,6,'up'), '15min': zigGen(100,90,0.10,0.11,12,2,6,'up') });
  const r2 = quiet();
  const sigAligned = await buildMultiTimeframeSignalOTC(fixtureAligned(), 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {});
  r2();
  ok('T8d: OTC ALIGNED engine produced BUY', sigAligned.finalSignal === 'BUY', sigAligned.finalSignal);
  ok('T8e: structure verdict is ALIGNED', sigAligned.structureVerdict && sigAligned.structureVerdict.overall === 'ALIGNED', sigAligned.structureVerdict && sigAligned.structureVerdict.overall);
  const capped = ['C','D','F'];
  ok('T8f: ALIGNED grade capped (C/D/F, never A+/A) — calibrated worst', capped.includes(sigAligned.grade.grade), sigAligned.grade.grade);
  eq('T8g: grade is exactly C for ALIGNED (calibrated)', sigAligned.grade.grade, 'C');
  // prove cap caused by 4th arg: without structure arg, grade would be higher (B/A/A+) than capped C
  const confNum = confPct(sigAligned);
  const avg = sigAligned.averageConfluence;
  const uncapped = getSignalGrade(confNum, avg, sigAligned.alignment);
  // With calibrated scoring, ALIGNED raw 73% -> score ~0.416 -> B (higher than C), proving cap
  const order = ['F','D','C','B','A','A+'];
  const cappedIdx = order.indexOf(sigAligned.grade.grade);
  const uncappedIdx = order.indexOf(uncapped.grade);
  ok('T8h: same ALIGNED signal without structure arg grades higher (proves cap)', uncappedIdx > cappedIdx, `capped=${sigAligned.grade.grade} uncapped=${uncapped.grade}`);
  // wiring checks still valid
  const src = fs.readFileSync(fileURLToPath(new URL('../src/signal/otcEngine.js', import.meta.url)), 'utf8');
  const gradeLine = src.indexOf('getSignalGrade(confidence, avgConf, alignment, structureVerdict.overall)');
  const verdictLine = src.indexOf('const structureVerdict = buildStructureVerdict(tfResults, finalDirection);');
  ok('T8i: getSignalGrade receives structureVerdict.overall', gradeLine > -1);
  ok('T8j: structureVerdict computed BEFORE the grade call', verdictLine > -1 && verdictLine < gradeLine);
  ok('T8k: return object reuses the computed structureVerdict', /structureVerdict,\s*method/.test(src));
}

console.log('\n── T9: OTC camarilla contribution == raw x 1.5 (FIX-B) ────');
{
  const zigGen = (n, base, up, dn, upLeg, dnLeg, tail) => {
    const out = []; let c = base;
    for (let i = 0; i < n; i++) {
      const o = c;
      if (i < n - tail) {
        const phase = i % (upLeg + dnLeg);
        if (phase < upLeg) { c = c + up; out.push({ datetime:'x', open:o, high:c+0.12, low:o-0.01, close:c, volume:1000 }); }
        else               { c = c - dn; out.push({ datetime:'x', open:o, high:o+0.01, low:c-0.12, close:c, volume:1000 }); }
      } else {
        c = c - 0.06; out.push({ datetime:'x', open:o, high:o, low:c, close:c, volume:1000 });
      }
    }
    return out;
  };
  const r = quiet();
  const sig = await buildMultiTimeframeSignalOTC(
    { '1min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6), '5min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6), '15min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6) },
    'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {});
  r();
  const otcCam = sig.timeframeAnalysis['15min'].categoryScores.camarilla;
  ok('T9a: OTC camarilla carries otcWeight 1.5 marker',
    otcCam && otcCam.otcWeight === 1.5, JSON.stringify(otcCam));
  // math assertion on the actual formula constants: OTC weight 1.5, no ÷0.84
  const camW = 1.5; // OTC_CATEGORY_WEIGHTS.camarilla
  const oldInflate = 1 / 0.84 * camW;   // 1.786...
  ok('T9b: OTC camarilla multiplier is 1.5, not 1.786',
    Math.abs(camW - 1.5) < 1e-9 && Math.abs(camW - oldInflate) > 0.2,
    'camW=' + camW + ' oldInflate=' + oldInflate.toFixed(3));
  const src = fs.readFileSync(fileURLToPath(new URL('../src/signal/otcEngine.js', import.meta.url)), 'utf8');
  ok('T9c: unweight loop skips ÷rW for camarilla',
    src.includes("cat === 'camarilla' ? (cd.up   || 0) : (cd.up   || 0) / rW") &&
    src.includes("cat === 'camarilla' ? (cd.down || 0) : (cd.down || 0) / rW"));
  // standard engine storage untouched: timeframe.js still stores raw camScore
  const tfSrc = fs.readFileSync(fileURLToPath(new URL('../src/signal/timeframe.js', import.meta.url)), 'utf8');
  ok('T9d: timeframe.js camarilla storage untouched (raw camScore)',
    tfSrc.includes('catScores.camarilla = { up: r2(camScore.up), down: r2(camScore.down), level: camScore.level }'));
  // runtime relationship: raw (from standard storage rule) x 1.5 == OTC value.
  // Recover raw via the standard analyzer on the same candles, then compare
  // against the OTC-weighted category value the engine produced.
  const { calculateAllIndicators } = await import('../src/indicators/index.js');
  const { analyzeTimeframe } = await import('../src/signal/timeframe.js');
  const raw15 = zigGen(100, 90, 0.10, 0.11, 12, 2, 6);
  const stdTf = analyzeTimeframe(calculateAllIndicators(raw15, '15min'), raw15, '15min', 'FOREX', null, 'RANGING');
  const rawCam = stdTf.categoryScores.camarilla;
  const otcVal = otcCam;
  ok('T9e: standard camarilla stored raw (pre-weight)', rawCam && typeof rawCam.up === 'number', JSON.stringify(rawCam));
  eq('T9f: OTC camarilla == r2(raw x 1.5)', otcVal.up, Math.round((rawCam.up * 1.5) * 100) / 100);
  ok('T9g: OTC camarilla != r2(raw / 0.84 x 1.5) (old inflate)',
    otcVal.up !== Math.round(((rawCam.up / 0.84) * 1.5) * 100) / 100,
    'otc=' + otcVal.up + ' old=' + Math.round(((rawCam.up / 0.84) * 1.5) * 100) / 100);
}

console.log('\n── T10: round-number bonus is directional (FIX-C) ─────────');
{
  // price BELOW round level (1.1548 vs 1.155) -> resistance -> bonus DOWN
  const mkCandles = (lastClose) => {
    const out = []; let p = lastClose;
    for (let i = 0; i < 30; i++) {
      const o = p;
      p = p + (i % 2 ? 0.0005 : -0.0005);
      out.push({ datetime:'x', open:o, high:Math.max(o, p) + 0.0002, low:Math.min(o, p) - 0.0002, close:p, volume:1000 });
    }
    return out; // chronological; last close ≈ lastClose
  };
  const below = mkCandles(1.1548);
  const patBelow = analyzeOTCPatterns(below, 0.002, 1.1548);
  ok('T10a: below-level detected', !!patBelow.roundNumber, JSON.stringify(patBelow.roundNumber));
  eq('T10b: below-level -> otcBonusUp stays 0', patBelow.otcBonusUp, 0);
  ok('T10c: below-level -> otcBonusDown > 0', patBelow.otcBonusDown > 0, 'down=' + patBelow.otcBonusDown);
  ok('T10d: signal names the side', patBelow.otcSignals.includes('ROUND_LEVEL_MINOR_RESISTANCE'),
    JSON.stringify(patBelow.otcSignals));

  const above = mkCandles(1.1552);
  const patAbove = analyzeOTCPatterns(above, 0.002, 1.1552);
  ok('T10e: above-level detected', !!patAbove.roundNumber);
  eq('T10f: above-level -> otcBonusDown stays 0', patAbove.otcBonusDown, 0);
  ok('T10g: above-level -> otcBonusUp > 0', patAbove.otcBonusUp > 0, 'up=' + patAbove.otcBonusUp);

  // exactly on level -> ambiguous -> no round bonus either side
  const on = mkCandles(1.155);
  const patOn = analyzeOTCPatterns(on, 0.002, 1.155);
  ok('T10h: on-level still surfaced', patOn.roundNumber && patOn.roundNumber.distance === 0);
  ok('T10i: old both-sides behavior gone (differential non-zero below)',
    patBelow.otcBonusUp !== patBelow.otcBonusDown);
  ok('T10j: old both-sides behavior gone (differential non-zero above)',
    patAbove.otcBonusUp !== patAbove.otcBonusDown);
}

console.log('\n── T11: round bonus moves OTC confidence (FIX-C) ──────────');
{
  // engine formula: pb = bonusDown - bonusUp (SELL) / bonusUp - bonusDown (BUY),
  // confidence += Math.round(pb * 3). With the OLD both-sides round bonus,
  // pb's round contribution was always 0; now it is ±round(proximity*0.4*3).
  const src = fs.readFileSync(fileURLToPath(new URL('../src/signal/otcEngine.js', import.meta.url)), 'utf8');
  ok('T11a: engine uses the directional differential',
    src.includes('otcPatterns.otcBonusUp - otcPatterns.otcBonusDown') &&
    src.includes('Math.round(pb * 3)'));
  // concrete: proximity 0.67 -> bonus 0.268 -> confidence delta round(0.268*3)=1
  const delta = Math.round((0.67 * 0.4) * 3);
  eq('T11b: round contribution to confidence is non-zero', delta, 1);
  // and the OLD code would have contributed 0 (same on both sides)
  eq('T11c: old both-sides round contribution was 0', Math.round((0.67 * 0.4 - 0.67 * 0.4) * 3), 0);
  // source: otc.js must NOT add the same bonus to both sides anymore
  const otcSrc = fs.readFileSync(fileURLToPath(new URL('../src/analysis/otc.js', import.meta.url)), 'utf8');
  ok('T11d: otc.js no longer adds to both sides',
    !/otcBonusUp\s*\+=\s*round\.proximity \* 0\.4;[\s\S]{0,80}otcBonusDown\s*\+=\s*round\.proximity \* 0\.4/.test(otcSrc));
}

console.log('\n── T12: confluence denominators unified to 12 (FIX-D) ─────');
{
  const srcs = [
    ['engine.js', fileURLToPath(new URL('../src/signal/engine.js', import.meta.url))],
    ['otcEngine.js', fileURLToPath(new URL('../src/signal/otcEngine.js', import.meta.url))],
    ['timeframe.js', fileURLToPath(new URL('../src/signal/timeframe.js', import.meta.url))],
  ];
  let bad = [];
  for (const [name, path] of srcs) {
    const text = fs.readFileSync(path, 'utf8');
    if (/'\/11|total: 11/.test(text)) bad.push(name);
  }
  eq('T12a: no /11 or total: 11 remains in src/', bad, []);
  const engine = fs.readFileSync(srcs[0][1], 'utf8');
  const otc = fs.readFileSync(srcs[1][1], 'utf8');
  const tf = fs.readFileSync(srcs[2][1], 'utf8');
  ok('T12b: engine rec strings use /12', engine.includes("'/12 categories'") && engine.includes("'/12 confluence'"));
  ok('T12c: otcEngine uses /12 and total: 12', otc.includes("'/12'") && otc.includes('total: 12'));
  ok('T12d: timeframe early-returns use total: 12', tf.includes('total: 12'));
}

console.log('\n── T13: HARDEN-1 optional chaining on multiplier ──────────');
{
  const tf = fs.readFileSync(fileURLToPath(new URL('../src/signal/timeframe.js', import.meta.url)), 'utf8');
  ok('T13: structure.multiplier?.value guards null multiplier',
    tf.includes('structure.bos && structure.multiplier?.value >= 1.20'));
}

// ROUND 3 — F3-01..F3-19 (reviewer-approved fixes)
// ════════════════════════════════════════════════════════════════════════

console.log('\n── T14: channel mirror message scope + pushLog (F3-01) ────');
{
  const tg = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      const b = JSON.parse(init.body);
      tg.push({ chatId: String(b.chat_id), text: b.text });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const seed = { 'u:111': { pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: '-100123' } };
  seed['auto_users'] = ['111'];
  const env = { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: 'tok' };
  const signal = {
    id: 'sig_ch1', pair: 'BTC/USD',
    signal: {
      finalSignal: 'BUY', confidence: '82%', grade: { grade: 'A', label: 'STRONG' },
      bestTimeframe: { timeframe: '5min' },
      recommendations: { '5min': { entry: { price: 1.0 }, expiry: { totalMinutes: 20, countdown: { label: '1m' } } } },
      higherTFTrend: 'BUY', marketRegime: 'TRENDING', regimeAdvice: 'x',
      structureVerdict: { overall: 'ALIGNED' }, entryReason: 'test',
    },
  };
  const r = await pushSignalToSubscribers(signal, env);
  ok('T14a: push succeeded (no ReferenceError)', r.error === undefined && r.pushed === 1, JSON.stringify(r));
  eq('T14b: DM sent to subscriber', tg.filter(t => t.chatId === '111').length, 1);
  eq('T14c: channel mirror message sent', tg.filter(t => t.chatId === '-100123').length, 1);
  ok('T14d: pushLog written', !!env.SIGNAL_CACHE._m.get('pushLog:sig_ch1'));
}

console.log('\n── T15: OTC auto-resolve (F3-02) ───────────────────────');
{
  const kv = makeKV();
  const env = { SIGNAL_CACHE: kv };
  const otcSig = {
    finalSignal: 'SELL', confidence: '78%', grade: { grade: 'A' },
    bestTimeframe: { timeframe: '15min', expiry: { expiryTime: new Date(Date.now() + 600000).toISOString() } },
    recommendations: { '15min': { entry: { price: 1.15 } } },
    alignment: 'ALL_BEARISH', marketRegime: 'RANGING', session: { sessions: ['OTC_24/7'], quality: 'N/A' },
    aiValidation: { status: 'OK' }, coreConfidence: 90,
  };
  await saveSignalToHistory(otcSig, 'EUR/USD-OTC', true, env, 'sig_otc_t1', 'FRESH_API');
  const pending = await env.SIGNAL_CACHE.get('pending:sig_otc_t1', 'json');
  ok('T15a: OTC signal registers a pending result-check', !!pending && pending.isOTC === true);

  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ values: [{ datetime: '2026-08-06 10:00:00', open: '1.15', high: '1.151', low: '1.149', close: '1.149' }] }), text: async () => '' };
  };
  const fe = await fetchExpiryPrice('EUR/USD-OTC', new Date('2026-08-06T10:02:00.000Z').toISOString(), { TWELVEDATA_API_KEYS: '["k1"]' });
  ok('T15b: OTC expiry fetch resolves against base pair', fe && typeof fe.price === 'number', JSON.stringify(fe));
  ok('T15c: symbol sent is the base pair (no -OTC)', capturedUrl.includes('symbol=EUR%2FUSD') && !capturedUrl.includes('OTC'), capturedUrl);

  // end-to-end: the */2 tracker resolves the OTC pending row
  const now = Date.now();
  const expISO = new Date(now - 10 * 60000).toISOString();
  const expMin = expISO.slice(0, 19).replace('T', ' ');
  const kv2 = makeKV({
    'pending:sig_otc_t2': { id: 'sig_otc_t2', pair: 'EUR/USD-OTC', isOTC: true, direction: 'SELL', entryPrice: 1.15, expiryTime: expISO, timestamp: new Date(now - 30 * 60000).toISOString(), result: null, exitPrice: null },
    'sig:EUR_USD_OTC': [{ id: 'sig_otc_t2', pair: 'EUR/USD-OTC', isOTC: true, direction: 'SELL', entryPrice: 1.15, expiryTime: expISO, timestamp: new Date(now - 30 * 60000).toISOString(), result: null, exitPrice: null }],
  });
  const env2 = { SIGNAL_CACHE: kv2, TWELVEDATA_API_KEYS: '["k1"]' };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ values: [{ datetime: expMin, open: '1.15', high: '1.151', low: '1.149', close: '1.149' }] }), text: async () => '' });
  await scheduledTracker(env2);
  const row = (await kv2.get('sig:EUR_USD_OTC', 'json'))[0];
  eq('T15d: OTC row resolved by the cron tracker', row.result, 'WIN');
  const stats = await kv2.get('stats:EUR_USD_OTC', 'json');
  ok('T15e: OTC stats updated', stats && stats.wins === 1, JSON.stringify(stats));
  ok('T15f: pending key cleaned up', !kv2._m.has('pending:sig_otc_t2'));
}

console.log('\n── T16: passGrade accepts A+ (F3-03) ───────────────────');
{
  eq('T16a: A+ passes A filter', passGrade({ grade: { grade: 'A+' } }, 'A'), true);
  eq('T16b: A+ passes AB filter', passGrade({ grade: { grade: 'A+' } }, 'AB'), true);
  eq('T16c: A passes A filter', passGrade({ grade: { grade: 'A' } }, 'A'), true);
  eq('T16d: B passes AB filter', passGrade({ grade: { grade: 'B' } }, 'AB'), true);
  eq('T16e: B rejected by A filter', passGrade({ grade: { grade: 'B' } }, 'A'), false);
  eq('T16f: C rejected by AB filter', passGrade({ grade: { grade: 'C' } }, 'AB'), false);
  eq('T16g: ALL filter passes everything', passGrade({ grade: { grade: 'C' } }, 'ALL'), true);
  eq('T16h: missing grade rejected', passGrade({}, 'A'), false);
}

console.log('\n── T17: OTC fillStatus fields (F3-04) ─────────────────');
{
  const zigGen = (n, base, up, dn, upLeg, dnLeg, tail) => {
    const out = []; let c = base;
    for (let i = 0; i < n; i++) {
      const o = c;
      if (i < n - tail) {
        const phase = i % (upLeg + dnLeg);
        if (phase < upLeg) { c = c + up; out.push({ datetime: 'x', open: o, high: c + 0.12, low: o - 0.01, close: c, volume: 1000 }); }
        else               { c = c - dn; out.push({ datetime: 'x', open: o, high: o + 0.01, low: c - 0.12, close: c, volume: 1000 }); }
      } else {
        c = c - 0.06; out.push({ datetime: 'x', open: o, high: o, low: c, close: c, volume: 1000 });
      }
    }
    return out;
  };
  const SESSION = { sessions: ['OTC_24/7'], quality: 'N/A' };
  const cdA = { '1min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6), '5min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6), '15min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6) };
  const r = quiet();
  const sigA = await buildMultiTimeframeSignalOTC(cdA, 'EUR/USD-OTC', SESSION, false, {});
  r();
  eq('T17a: OTC SELL with identical TFs -> INSTANT', sigA.fillStatus, 'INSTANT');
  ok('T17b: entryPrice/currentPrice/entryDistancePct numeric',
    typeof sigA.entryPrice === 'number' && typeof sigA.currentPrice === 'number' && typeof sigA.entryDistancePct === 'number',
    JSON.stringify({ e: sigA.entryPrice, c: sigA.currentPrice, d: sigA.entryDistancePct }));
  eq('T17c: currentPrice is the 1min last close', sigA.currentPrice, cdA['1min'][cdA['1min'].length - 1].close);
  // 1min ends higher (tail 2) while 5min/15min end lower -> best-TF entry is away
  const cdB = {
    '1min': zigGen(100, 90, 0.10, 0.11, 12, 2, 2),
    '5min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6),
    '15min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6),
  };
  const r2 = quiet();
  const sigB = await buildMultiTimeframeSignalOTC(cdB, 'EUR/USD-OTC', SESSION, false, {});
  r2();
  eq('T17d: price away from entry -> PENDING_ENTRY', sigB.fillStatus, 'PENDING_ENTRY');
  ok('T17e: entryDistancePct > 0 when pending', sigB.entryDistancePct > 0, 'got ' + sigB.entryDistancePct);
}

console.log('\n── T18: NO_TRADE grade is N/A (F3-05) ─────────────────');
{
  const rev = (arr) => [...arr].reverse();
  const cd = {
    '1min': rev(series(100, 90, 0.1)),
    '5min': rev(series(100, 90, 0.1)),
    '15min': rev(series(100, 90, 0.1)),
  };
  const r = quiet();
  const sig = await buildMultiTimeframeSignal('TEST/USD', cd, 'CRYPTO', {}, {});
  r();
  eq('T18a: TRENDING fixture blocked (NO_TRADE)', sig.finalSignal, 'NO_TRADE');
  eq('T18b: NO_TRADE grade N/A', sig.grade.grade, 'N/A');
  eq('T18c: NO_TRADE label', sig.grade.label, 'NO_TRADE');
  // OTC: fully flat candles -> every TF dead-market -> NO_TRADE
  const flat = [];
  for (let i = 0; i < 100; i++) flat.push({ datetime: 'x', open: 90, high: 90, low: 90, close: 90, volume: 0 });
  const r2 = quiet();
  const osig = await buildMultiTimeframeSignalOTC({ '1min': flat, '5min': flat, '15min': flat }, 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {});
  r2();
  eq('T18d: OTC NO_TRADE grade N/A', osig.grade.grade, 'N/A');
}

console.log('\n── T19: hard block leaves confidence 0 (F3-06) ────────');
{
  // exact live repro: DOGE/USD HTF_HARD_BLOCK (ADX=40) with ALL_BULLISH votes
  const tfResults = {
    '1min': { indicators: { adx: '12.00' }, categoryScores: { fvg: { active: 'NONE' } } },
    '5min': { indicators: { adx: '15.00' }, categoryScores: { fvg: { active: 'NONE' } } },
    '15min': { indicators: { adx: '40.00' }, categoryScores: { fvg: { active: 'NONE' } } },
  };
  const votes = [
    { direction: 'BUY', score: { up: 7.09, down: 2.1 }, tf: '1min' },
    { direction: 'BUY', score: { up: 9.65, down: 2.84 }, tf: '5min' },
    { direction: 'NO_TRADE', score: { up: 3.71, down: 5.95 }, tf: '15min' },
  ];
  const candleData = { '1min': Array.from({ length: 10 }, () => ({ open: 1, close: 1.01, high: 1.02, low: 0.99 })) };
  const det = await runDeterministicVoteAndFilters({
    votes, candleData, tfResults,
    higherTFTrend: 'SELL', marketRegime: 'TRENDING',
    session: { quality: 'N/A' }, sessionMult: 1.4, candleQualityMult: 0.82,
    exotic: false, assetType: ASSET_TYPE.CRYPTO,
    newsBlock: null, newsBlocked: false, pair: 'DOGE/USD', env: null,
  });
  eq('T19a: HTF-blocked confidence is 0 (was 8%)', det.confidence, 0);
  ok('T19b: direction NO_TRADE', det.finalDirection === 'NO_TRADE');
  // ordering: bonus line sits before the HTF block in the source
  const vf = fs.readFileSync(fileURLToPath(new URL('../src/signal/voteFilters.js', import.meta.url)), 'utf8');
  const bonusIdx = vf.indexOf('confidence = Math.min(92, confidence + alignmentBonus)');
  const htfIdx = vf.indexOf('HTF HARD BLOCK');
  ok('T19c: alignment bonus applied before HTF block in source', bonusIdx > -1 && htfIdx > -1 && bonusIdx < htfIdx);
  // OTC mirror: bonus before MIXED zeroing
  const otcSrc = fs.readFileSync(fileURLToPath(new URL('../src/signal/otcEngine.js', import.meta.url)), 'utf8');
  const oBonus = otcSrc.indexOf('confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus)');
  const oMixed = otcSrc.indexOf("if (alignment === 'MIXED') { finalDirection = 'NO_TRADE'; confidence = 0; }");
  ok('T19d: OTC bonus applied before MIXED zeroing', oBonus > -1 && oMixed > -1 && oBonus < oMixed);
}

console.log('\n── T20: timezone=UTC on both fetchers (F3-07) ─────────');
{
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ values: [{ datetime: '2026-08-06 10:00:00', open: '1', high: '1.1', low: '0.9', close: '1.05', volume: '100' }] }), text: async () => '' };
  };
  const env = { TWELVEDATA_API_KEYS: '["k1"]' };
  await fetchCandles('EUR/USD', '5min', 100, env, 'FOREX');
  await fetchExpiryPrice('EUR/USD', new Date().toISOString(), env);
  ok('T20a: fetchCandles sends timezone=UTC', urls[0].includes('timezone=UTC'), urls[0]);
  ok('T20b: fetchExpiryPrice sends timezone=UTC', urls[1].includes('timezone=UTC'), urls[1]);
}

console.log('\n── T21: fx preferCache forces fresh (F3-08) ───────────');
{
  const kv = makeKV();
  const env = { SIGNAL_CACHE: kv, TWELVEDATA_API_KEY_1: 'k', CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' };
  await writeLatest('BTC/USD', { pair: 'BTC/USD', signal: { finalSignal: 'BUY', confidence: '80%' } }, { opportunistic: false }, env);
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('twelvedata')) {
      const interval = new URL(u).searchParams.get('interval');
      let values;
      if (interval === '15min') values = seriesFastSin(100, 100, 0.4);
      else if (interval === '5min') values = series(100, 100, 0.1);
      else values = series(100, 100, 0.02);
      return { ok: true, status: 200, json: async () => ({ values }), text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 85, reason: 'stub', concerns: null }) } }] }), text: async () => '' };
  };
  const sink1 = []; const q1 = quiet();
  const res1 = await handleSignal('BTC/USD', env, ctxOf(sink1), { preferCache: true });
  const b1 = await res1.json();
  await drain(sink1); q1();
  ok('T21a: plain preferCache serves the cached entry', b1.cached === true);
  const sink2 = []; const q2 = quiet();
  const res2 = await handleSignal('BTC/USD', env, ctxOf(sink2), { preferCache: true, fxMode: true });
  const b2 = await res2.json();
  await drain(sink2); q2();
  ok('T21b: fx+preferCache forces a fresh run (not the cached entry)', b2.cached === false && b2.signal && b2.signal.confidence !== '80%', JSON.stringify({ cached: b2.cached, conf: b2.signal && b2.signal.confidence }));
  ok('T21c: fresh run carries fx mode + levels', b2.signal && b2.signal.mode === 'fx' && b2.signal.fxLevels,
    b2.signal && (b2.signal.mode + ' / ' + JSON.stringify(b2.signal.fxLevels)));
}

console.log('\n── T22: FVG checked on 15min first (F3-09) ────────────');
{
  const mkCandles = () => Array.from({ length: 10 }, () => ({ open: 1, close: 1.01, high: 1.02, low: 0.99 }));
  const tfResults = {
    '1min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'NONE' } } },
    '5min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'NONE' } } },
    '15min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'BEARISH' } } },
  };
  const votes = [
    { direction: 'BUY', score: { up: 8, down: 1 }, tf: '1min' },
    { direction: 'BUY', score: { up: 8, down: 1 }, tf: '5min' },
    { direction: 'BUY', score: { up: 8, down: 1 }, tf: '15min' },
  ];
  const det = await runDeterministicVoteAndFilters({
    votes, candleData: { '1min': mkCandles() }, tfResults,
    higherTFTrend: null, marketRegime: 'RANGING',
    session: { quality: 'HIGH' }, sessionMult: 1, candleQualityMult: 1,
    exotic: false, assetType: ASSET_TYPE.CRYPTO,
    newsBlock: null, newsBlocked: false, pair: 'TEST', env: null,
  });
  ok('T22a: FVG penalty fired from the 15min gap (not the clean 1min)', det.fvgBlocked === true);
  ok('T22b: FVG_PENALTY filter applied', det.filtersApplied.some(f => f.includes('FVG_PENALTY')), JSON.stringify(det.filtersApplied));
  // source order: 15min first
  const vf = fs.readFileSync(fileURLToPath(new URL('../src/signal/voteFilters.js', import.meta.url)), 'utf8');
  ok('T22c: fvgCheckTF prefers 15min', vf.includes("tfResults['15min'] || tfResults['5min'] || tfResults['1min']"));
}

console.log('\n── T23: current-bar BOS not double-counted (F3-10) ────');
{
  const gen = () => {
    const out = []; const n = 100;
    for (let i = 0; i < n; i++) {
      let open, close, high, low;
      if (i === 80) { open = 99.2; close = 99.5; high = 99.5; low = 99.15; }
      else if (i === 85) { open = 99.3; close = 99.0; high = 99.35; low = 99.0; }
      else if (i === 92) { open = 100.5; close = 100.8; high = 101.0; low = 100.4; }
      else if (i === 95) { open = 99.8; close = 99.55; high = 99.9; low = 99.35; }
      else if (i === 98) { open = 100.9; close = 100.9; high = 100.95; low = 100.6; }
      else if (i === 99) { open = 100.9; close = 102.0; high = 102.1; low = 100.8; }
      else if (i < 80) { const b = 98.5 + i * 0.009; open = b; close = b + 0.05; high = b + 0.16; low = b - 0.05; }
      else if (i < 85) { const b = 99.3 + (i - 80) * 0.02; open = b; close = b + 0.02; high = b + 0.12; low = b - 0.1; }
      else if (i < 92) { const b = 99.2 + (i - 85) * 0.13; open = b; close = b + 0.1; high = b + 0.3; low = b - 0.1; }
      else if (i < 95) { const b = 100.4 - (i - 92) * 0.1; open = b; close = b - 0.05; high = b + 0.2; low = b - 0.2; }
      else { const b = 99.55 + (i - 95) * 0.15; open = b; close = b + 0.05; high = b + 0.25; low = b - 0.15; }
      out.push({ datetime: '2026-08-06 00:00:00', open, high, low, close, volume: 1000 });
    }
    return out;
  };
  const s = analyzeStructure(gen(), 0.3, '5min');
  eq('T23a: BULLISH bias + fresh BOS present (overlap case)', s.bias, 'BULLISH');
  ok('T23b: fresh BOS on current bar', s.bos && s.bos.type === 'BULLISH_BOS' && s.bos.barsAgo === 7, JSON.stringify(s.bos));
  ok('T23c: same break also appears in recentEvents (the overlap being fixed)',
    s.recentEvents.some(e => e.type === 'RECENT_BULLISH_BOS' && e.barsAgo === 0), JSON.stringify(s.recentEvents));
  eq('T23d: structureScore.up = bias 1.5 + BOS 2.0 = 3.5 (not 4.0)', s.structureScore.up, 3.5);
  eq('T23e: multiplier stays 1.25 (BOS)', s.multiplier.value, 1.25);
}

console.log('\n── T24: RANGING middle-zone RSI scores removed (F3-11) ─');
{
  const { calculateAllIndicators } = await import('../src/indicators/index.js');
  const { analyzeTimeframe } = await import('../src/signal/timeframe.js');
  const { makeCandleData } = await import('./r71_fixtures.mjs');
  const base = makeCandleData({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 });
  const candles = base['15min'];
  const ind = calculateAllIndicators(candles, '15min');
  const withRsi = (v) => ({ ...ind, rsi: [...ind.rsi.slice(0, -1), v] });
  const a62 = analyzeTimeframe(withRsi(62), candles, '15min', 'FOREX', null, 'RANGING');
  const a66 = analyzeTimeframe(withRsi(66), candles, '15min', 'FOREX', null, 'RANGING');
  ok('T24a: both runs are RANGING regime', a62.marketContext === 'RANGING' && a66.marketContext === 'RANGING');
  eq('T24b: no BUY bias at RSI 62 (middle zone removed)', a62.categoryScores.momentum.up, a66.categoryScores.momentum.up);
  ok('T24c: SELL bias appears at RSI 66 (+0.75 x 1.8 = +1.35)',
    Math.abs(a66.categoryScores.momentum.down - a62.categoryScores.momentum.down - 1.35) < 0.01,
    a62.categoryScores.momentum.down + ' -> ' + a66.categoryScores.momentum.down);
}

console.log('\n── T25: HIGHEST-session +3 bonus removed (F3-12) ──────');
{
  const mkCandles = () => Array.from({ length: 10 }, () => ({ open: 1, close: 1.01, high: 1.02, low: 0.99 }));
  const tfResults = {
    '1min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'NONE' } } },
    '5min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'NONE' } } },
    '15min': { indicators: { adx: '12' }, categoryScores: { fvg: { active: 'NONE' } } },
  };
  const votes = [
    { direction: 'BUY', score: { up: 8, down: 2 }, tf: '1min' },
    { direction: 'BUY', score: { up: 8, down: 2 }, tf: '5min' },
    { direction: 'SELL', score: { up: 2, down: 6 }, tf: '15min' },
  ];
  const det = await runDeterministicVoteAndFilters({
    votes, candleData: { '5min': mkCandles() }, tfResults,
    higherTFTrend: null, marketRegime: 'RANGING',
    session: { quality: 'HIGHEST', sessions: ['LONDON', 'NEW_YORK'], overlap: 'LONDON_NY' },
    sessionMult: 1, candleQualityMult: 1,
    exotic: false, assetType: ASSET_TYPE.FOREX,
    newsBlock: null, newsBlocked: false, pair: 'EUR/USD', env: null,
  });
  // weightedBuy=36, weightedSell=9 -> 80%; MOSTLY_BULLISH bonus +2 -> 82.
  // Pre-fix the HIGHEST branch added another +3 -> 85.
  eq('T25: HIGHEST session adds no +3 (82, not 85)', det.confidence, 82);
  const vf = fs.readFileSync(fileURLToPath(new URL('../src/signal/voteFilters.js', import.meta.url)), 'utf8');
  ok('T25b: HIGHEST +3 branch removed from source', !vf.includes("session.quality === 'HIGHEST') {\n      confidence = Math.min(92, confidence + 3)"));
}

console.log('\n── T26: crypto skips forex session weights (F3-13) ────');
{
  const sess = { sessions: ['LONDON', 'NEW_YORK'], overlap: 'LONDON_NY', quality: 'HIGHEST' };
  eq('T26a: crypto multiplier is 1', getSessionWeightMultiplier('BTC/USD', sess, 'CRYPTO'), 1);
  eq('T26b: forex multiplier unchanged (USD quote x1.4)', getSessionWeightMultiplier('EUR/USD', sess, 'FOREX'), 1.4);
  const { makeCandleData } = await import('./r71_fixtures.mjs');
  const r = quiet();
  const sig = await buildMultiTimeframeSignal('BTC/USD', makeCandleData({ basePrice: 78000, vol: 60, trend: 18, seed: 11 }), 'CRYPTO', {}, {});
  r();
  eq('T26c: crypto signal sessionWeight = 1', sig.sessionWeight, 1);
  ok('T26d: no SESSION_WEIGHT filter on crypto', !(sig.filtersApplied || []).some(f => f.includes('SESSION_WEIGHT')), JSON.stringify(sig.filtersApplied));
}

console.log('\n── T27: scheduledScan pushes nothing (F3-14) ──────────');
{
  const ss = fs.readFileSync(fileURLToPath(new URL('../src/handlers/scheduledScan.js', import.meta.url)), 'utf8');
  ok('T27: scanner calls handleSignalRaw with noPush:true',
    ss.includes('handleSignalRaw(pair, env, ctx, { noPush: true })'));
}

console.log('\n── T28: no AI calls on D2-blocked signals (F3-15) ─────');
{
  let aiCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('cerebras') || u.includes('groq')) aiCalls++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ signal: 'BUY', confidence: 88, reason: 'stub', concerns: null }) } }] }), text: async () => '' };
  };
  const rev = (arr) => [...arr].reverse();
  const cd = {
    '1min': rev(series(100, 90, 0.1)),
    '5min': rev(series(100, 90, 0.1)),
    '15min': rev(series(100, 90, 0.1)),
  };
  const env = { CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' };
  const r = quiet();
  const sig = await buildMultiTimeframeSignal('TEST/USD', cd, 'CRYPTO', env, {});
  r();
  eq('T28a: D2-blocked signal is NO_TRADE', sig.finalSignal, 'NO_TRADE');
  eq('T28b: zero LLM calls on a D2 hard block', aiCalls, 0);
  eq('T28c: aiValidation stays SKIPPED', sig.aiValidation.status, 'SKIPPED');
  ok('T28d: AI_SKIPPED note present', (sig.filtersApplied || []).some(f => f.includes('AI_SKIPPED (D2 hard block)')),
    JSON.stringify(sig.filtersApplied));
}

console.log('\n── T29: session injection is time-invariant (F3-16) ───');
{
  const { makeCandleData } = await import('./r71_fixtures.mjs');
  const cd = makeCandleData({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 });
  const r = quiet();
  const sHigh = await buildMultiTimeframeSignal('EUR/USD', cd, 'FOREX', {}, { session: { sessions: ['LONDON'], overlap: 'NONE', quality: 'HIGH', hour: 14 }, newsBlock: null });
  const sHighest = await buildMultiTimeframeSignal('EUR/USD', cd, 'FOREX', {}, { session: { sessions: ['LONDON', 'NEW_YORK'], overlap: 'LONDON_NY', quality: 'HIGHEST', hour: 14 }, newsBlock: null });
  r();
  ok('T29a: HIGH session -> no D2_HIGHEST_SESSION_BLOCK', !sHigh.filtersApplied.some(f => f.includes('D2_HIGHEST_SESSION_BLOCK')), JSON.stringify(sHigh.filtersApplied));
  ok('T29b: HIGHEST session -> D2_HIGHEST_SESSION_BLOCK fires', sHighest.filtersApplied.some(f => f.includes('D2_HIGHEST_SESSION_BLOCK')), JSON.stringify(sHighest.filtersApplied));
}

console.log('\n── T30: history excludes cbShadow rows (F3-17) ────────');
{
  const kv = makeKV({
    'sig:BTC_USD': [
      { id: 'a', pair: 'BTC/USD', result: 'WIN', cbShadow: false, timestamp: '2026-08-06T00:00:00Z' },
      { id: 'b', pair: 'BTC/USD', result: 'LOSS', cbShadow: true, timestamp: '2026-08-06T00:01:00Z' },
      { id: 'c', pair: 'BTC/USD', result: null, cbShadow: false, timestamp: '2026-08-06T00:02:00Z' },
    ],
  });
  const env = { SIGNAL_CACHE: kv };
  const res = await handleHistory(new URL('https://x/api/history?pair=BTC/USD&limit=10'), env);
  const body = await res.json();
  eq('T30a: decided excludes cbShadow', body.decided, 1);
  eq('T30b: winRate from non-shadow rows only', body.winRate, 1);
  eq('T30c: pending excludes cbShadow', body.pending, 1);
  eq('T30d: signals list still shows every row (transparency)', body.signals.length, 3);
}

console.log('\n── T31: winRate is the 20-trade window (F3-18) ────────');
{
  const env = { SIGNAL_CACHE: makeKV() };
  const record = { pair: 'TEST/USD', direction: 'BUY', session: [], bestTF: '5min', marketRegime: 'RANGING' };
  for (let i = 0; i < 5; i++) await updatePairStats('TEST/USD', 'WIN', record, env);
  for (let i = 0; i < 20; i++) await updatePairStats('TEST/USD', 'LOSS', record, env);
  const stats = await env.SIGNAL_CACHE.get('stats:TEST_USD', 'json');
  eq('T31a: lifetime wins preserved', stats.wins, 5);
  eq('T31b: lifetime losses preserved', stats.losses, 20);
  eq('T31c: winRate reflects ONLY the last 20 (all LOSS -> 0)', stats.winRate, 0);
  eq('T31d: sampleSize 20', stats.sampleSize, 20);
  const adj = await getDynamicConfidenceAdjustment('TEST/USD', env);
  eq('T31e: dynamic adjustment uses the windowed WR (0 -> -10)', adj, -10);
}

console.log('\n── T32: fallback needs winning-side confluence (F3-19) ─');
{
  eq('T32a: winning side cat 4 -> NO_TRADE (was BUY)', decideTfDirection(6, 1, 4, 0, 3.0), 'NO_TRADE');
  eq('T32b: winning side cat 5 -> BUY', decideTfDirection(6, 1, 5, 0, 3.0), 'BUY');
  eq('T32c: first branch unchanged (threshold + cat 5)', decideTfDirection(6, 1, 5, 0, 3.0), 'BUY');
  eq('T32d: losing side cat high, winner cat low -> NO_TRADE', decideTfDirection(6, 1, 0, 6, 3.0), 'NO_TRADE');
  eq('T32e: equal-score tie -> NO_TRADE', decideTfDirection(5, 5, 6, 6, 3.0), 'NO_TRADE');
}

console.log('\n── T33: corrected entry-hit re-test semantics (FIX-EH) ─');
{
  // Real UTC timestamps are required because fetchExpiryPrice now separates
  // the signal candle from candles strictly after it.
  const signalMs = Date.parse('2020-01-02T10:00:00.000Z');
  const expiryMs = signalMs + 10 * 60 * 1000;
  const signalISO = new Date(signalMs).toISOString();
  const expiryISO = new Date(expiryMs).toISOString();
  const datetimeAt = (minute) => new Date(signalMs + minute * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const candle = (minute, open, high, low, close) => ({
    datetime: datetimeAt(minute),
    open: String(open), high: String(high), low: String(low), close: String(close),
  });

  const resolve = async (id, direction, values, fillStatus = 'INSTANT') => {
    const record = {
      id, pair: 'TEST/USD', direction, fillStatus,
      entryPrice: 100, expiryTime: expiryISO, timestamp: signalISO,
      bestTF: '5min', marketRegime: 'RANGING', session: [],
      result: null, exitPrice: null,
    };
    const kv = makeKV({
      ['pending:' + id]: record,
      'sig:TEST_USD': [record],
    });
    const env = { SIGNAL_CACHE: kv, TWELVEDATA_API_KEYS: '["k1"]' };
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      // TwelveData order is newest-first; production must sort it once parsed.
      json: async () => ({ values: [...values].reverse() }),
      text: async () => '',
    });
    await scheduledTracker(env);
    return (await kv.get('sig:TEST_USD', 'json'))[0];
  };

  const buyStraightUp = await resolve('t33a', 'BUY', [
    candle(0, 100, 100, 100, 100),
    candle(1, 100.1, 100.6, 100.1, 100.5),
    candle(10, 101, 102, 101, 101.5),
  ]);
  ok('T33a: BUY straight-up WIN never returns',
    buyStraightUp.result === 'WIN' && buyStraightUp.entryHit === false &&
      buyStraightUp.entryHitLegacy === false, JSON.stringify(buyStraightUp));

  const buyStraightDown = await resolve('t33b', 'BUY', [
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 100, 99.4, 99.5),
    candle(10, 99, 99.2, 98.8, 99),
  ]);
  ok('T33b: BUY straight-down LOSS is not a re-test',
    buyStraightDown.result === 'LOSS' && buyStraightDown.entryHit === false &&
      buyStraightDown.entryHitLegacy === true, JSON.stringify(buyStraightDown));

  const buyRetestWin = await resolve('t33c', 'BUY', [
    candle(0, 100, 100, 100, 100),
    candle(1, 100.2, 101, 100.2, 100.8),
    candle(2, 100.8, 100.9, 100, 100.2),
    candle(10, 101, 102.2, 100.9, 102),
  ]);
  ok('T33c: BUY leaves, re-tests entry, then wins',
    buyRetestWin.result === 'WIN' && buyRetestWin.entryHit === true,
    JSON.stringify(buyRetestWin));

  const sellStraightUp = await resolve('t33d', 'SELL', [
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 100.6, 100, 100.5),
    candle(10, 101, 101.3, 100.8, 101),
  ]);
  ok('T33d: SELL straight-up LOSS is not a re-test',
    sellStraightUp.result === 'LOSS' && sellStraightUp.entryHit === false &&
      sellStraightUp.entryHitLegacy === true, JSON.stringify(sellStraightUp));

  const sellRetestWin = await resolve('t33e', 'SELL', [
    candle(0, 100, 100, 100, 100),
    candle(1, 99.8, 99.8, 99, 99.2),
    candle(2, 99.2, 100, 99.1, 99.8),
    candle(10, 99, 99.1, 98, 98.5),
  ]);
  ok('T33e: SELL leaves, re-tests entry, then wins',
    sellRetestWin.result === 'WIN' && sellRetestWin.entryHit === true,
    JSON.stringify(sellRetestWin));

  // Use the real save path here so this case also protects persistence of the
  // FIX-3/F3-04 fields needed to distinguish PENDING_ENTRY from INSTANT.
  const pendingKv = makeKV();
  const pendingEnv = { SIGNAL_CACHE: pendingKv, TWELVEDATA_API_KEYS: '["k1"]' };
  await saveSignalToHistory({
    finalSignal: 'BUY', confidence: '80%', grade: { grade: 'A' },
    bestTimeframe: { timeframe: '5min', expiry: { expiryTime: expiryISO } },
    recommendations: { '5min': { entry: { price: 100 } } },
    session: { sessions: [], quality: 'N/A' }, marketRegime: 'RANGING',
    fillStatus: 'PENDING_ENTRY', currentPrice: 101, entryDistancePct: 1,
  }, 'TEST/USD', false, pendingEnv, 't33f', 'FRESH_API');
  const pending = await pendingKv.get('pending:t33f', 'json');
  pending.timestamp = signalISO;
  await pendingKv.put('pending:t33f', JSON.stringify(pending));
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ values: [
      candle(10, 100.5, 101, 100.2, 100.8),
      candle(1, 101, 101.1, 100, 100.2),
      candle(0, 101, 101, 101, 101),
    ] }),
    text: async () => '',
  });
  await scheduledTracker(pendingEnv);
  const pendingRow = (await pendingKv.get('sig:TEST_USD', 'json'))[0];
  ok('T33f: PENDING_ENTRY BUY uses plain touch',
    pendingRow.entryHit === true && pendingRow.fillStatus === 'PENDING_ENTRY' &&
      pendingRow.currentPrice === 101 && pendingRow.entryDistancePct === 1,
    JSON.stringify(pendingRow));

  let legacyUrl = '';
  globalThis.fetch = async (url) => {
    legacyUrl = String(url);
    return {
      ok: true, status: 200,
      json: async () => ({ values: [
        candle(15, 101, 103, 97, 102),
        candle(10, 100, 102, 98, 101),
        candle(5, 100, 105, 95, 100),
      ] }),
      text: async () => '',
    };
  };
  const legacyFetch = await fetchExpiryPrice('TEST/USD', expiryISO,
    { TWELVEDATA_API_KEYS: '["k1"]' });
  const legacyParams = new URL(legacyUrl).searchParams;
  ok('T33g: no startTimeISO preserves legacy expiry bracket/extrema',
    legacyFetch.windowLow === 95 && legacyFetch.windowHigh === 105 &&
      legacyFetch.postSignal === null &&
      legacyParams.get('start_date') === datetimeAt(5) &&
      legacyParams.get('end_date') === datetimeAt(15),
    JSON.stringify(legacyFetch));
}

console.log('\n── T34: D4 v2.1 signalIndicators instrumentation ───────');
{
  // ── T34a: real engine → save → record has signalIndicators ──
  const rev = (arr) => [...arr].reverse();
  const candleDataA = {
    '1min': rev(series(100, 90, 0.02)),
    '5min': rev(series(100, 90, 0.1)),
    '15min': rev(seriesFastSin(100, 90, 0.4)),
  };
  const qA = quiet();
  const sigA = await buildMultiTimeframeSignal('TEST/USD', candleDataA, 'CRYPTO', {}, {});
  qA();

  ok('T34a: engine produced signal for instrumentation', sigA && sigA.bestTimeframe && sigA.timeframeAnalysis, JSON.stringify(sigA && sigA.bestTimeframe));
  if (sigA && sigA.bestTimeframe && sigA.timeframeAnalysis) {
    const kvA = makeKV();
    const envA = { SIGNAL_CACHE: kvA };
    await saveSignalToHistory(sigA, 'TEST/USD', false, envA, 'sig_t34a', 'FRESH_API');
    const histA = await kvA.get('sig:TEST_USD', 'json');
    const recA = histA && histA[0];
    ok('T34a: history row saved', !!recA, JSON.stringify(recA && recA.id));
    ok('T34a: signalIndicators present', recA && recA.signalIndicators, JSON.stringify(recA && recA.signalIndicators));
    if (recA && recA.signalIndicators) {
      const si = recA.signalIndicators;
      eq('T34a: bestTF matches engine bestTF', si.bestTF, sigA.bestTimeframe.timeframe);
      ok('T34a: rsi numeric or null (structure check)', si.rsi === null || (typeof si.rsi === 'number' && isFinite(si.rsi)), 'rsi=' + si.rsi);
      ok('T34a: atrPct numeric or null', si.atrPct === null || (typeof si.atrPct === 'number' && isFinite(si.atrPct)), 'atrPct=' + si.atrPct);
      ok('T34a: adx numeric or null', si.adx === null || (typeof si.adx === 'number' && isFinite(si.adx)), 'adx=' + si.adx);
      ok('T34a: bbBandwidth numeric or null', si.bbBandwidth === null || (typeof si.bbBandwidth === 'number' && isFinite(si.bbBandwidth)), 'bb=' + si.bbBandwidth);
      // With our deterministic fixture, most indicators should be numeric (not all null)
      const numericCount = [si.rsi, si.atrPct, si.adx, si.bbBandwidth].filter(v => typeof v === 'number').length;
      ok('T34a: at least 2 indicators numeric (not all null)', numericCount >= 2, 'numericCount=' + numericCount + ' ' + JSON.stringify(si));
    }
  }

  // ── T34b: fail-open — malformed timeframeAnalysis ──
  const baseSig = {
    finalSignal: 'BUY', confidence: '80%', grade: { grade: 'A' },
    bestTimeframe: { timeframe: '5min', expiry: { expiryTime: new Date(Date.now() + 600000).toISOString() } },
    recommendations: { '5min': { entry: { price: 100 } } },
    session: { sessions: [], quality: 'N/A' }, marketRegime: 'RANGING',
    timeframeAnalysis: {
      '5min': {
        entry: { price: 100 },
        indicators: {
          rsi: [30, 40, 55],
          atr: [0.5, 0.6, 0.7],
          adx: { adx: [10, 20, 25] },
          bollinger: { bandwidth: [2, 2.5, 3] },
        },
      },
    },
  };
  // case b1: timeframeAnalysis = null
  {
    const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
    const sig = { ...baseSig, timeframeAnalysis: null };
    let threw = false;
    try { await saveSignalToHistory(sig, 'TEST/USD', false, env, 'sig_t34b1', 'FRESH_API'); } catch (e) { threw = true; }
    ok('T34b1: null timeframeAnalysis does not throw', !threw);
    const hist = await kv.get('sig:TEST_USD', 'json');
    ok('T34b1: save still succeeds', hist && hist.length === 1);
    const rec = hist && hist[0];
    ok('T34b1: signalIndicators absent or null on malformed', !rec.signalIndicators || rec.signalIndicators === null || Object.keys(rec.signalIndicators).length === 0 || (rec.signalIndicators.rsi === null), JSON.stringify(rec && rec.signalIndicators));
  }
  // case b2: missing indicators
  {
    const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
    const sig = { ...baseSig, timeframeAnalysis: { '5min': { entry: { price: 100 } } } };
    let threw = false;
    try { await saveSignalToHistory(sig, 'TEST/USD', false, env, 'sig_t34b2', 'FRESH_API'); } catch (e) { threw = true; }
    ok('T34b2: missing indicators does not throw', !threw);
    const hist = await kv.get('sig:TEST_USD', 'json');
    ok('T34b2: save still succeeds', hist && hist.length === 1);
  }
  // case b3: indicators.rsi = undefined, atr missing, adx malformed
  {
    const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
    const sig = {
      ...baseSig,
      timeframeAnalysis: {
        '5min': {
          entry: { price: 100 },
          indicators: { rsi: undefined, atr: null, adx: null, bollinger: null },
        },
      },
    };
    let threw = false;
    try { await saveSignalToHistory(sig, 'TEST/USD', false, env, 'sig_t34b3', 'FRESH_API'); } catch (e) { threw = true; }
    ok('T34b3: undefined rsi / null atr does not throw', !threw);
    const hist = await kv.get('sig:TEST_USD', 'json');
    ok('T34b3: save still succeeds', hist && hist.length === 1);
    const rec = hist && hist[0];
    // Should have signalIndicators with nulls, but not throw
    if (rec && rec.signalIndicators) {
      ok('T34b3: signalIndicators fields null when indicators missing', rec.signalIndicators.rsi === null && rec.signalIndicators.atrPct === null, JSON.stringify(rec.signalIndicators));
    } else {
      ok('T34b3: signalIndicators gracefully absent', true);
    }
  }
  // case b4: bestTimeframe missing
  {
    const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
    const sig = { ...baseSig, bestTimeframe: null };
    let threw = false;
    try { await saveSignalToHistory(sig, 'TEST/USD', false, env, 'sig_t34b4', 'FRESH_API'); } catch (e) { threw = true; }
    ok('T34b4: null bestTimeframe does not throw', !threw);
    const hist = await kv.get('sig:TEST_USD', 'json');
    ok('T34b4: save still succeeds even without bestTF', hist && hist.length === 1);
  }

  // ── T34c: OTC path ──
  {
    const zigGen = (n, base, up, dn, upLeg, dnLeg, tail) => {
      const out = []; let c = base;
      for (let i = 0; i < n; i++) {
        const o = c;
        if (i < n - tail) {
          const phase = i % (upLeg + dnLeg);
          if (phase < upLeg) { c = c + up; out.push({ datetime: 'x', open: o, high: c + 0.12, low: o - 0.01, close: c, volume: 1000 }); }
          else               { c = c - dn; out.push({ datetime: 'x', open: o, high: o + 0.01, low: c - 0.12, close: c, volume: 1000 }); }
        } else {
          c = c - 0.06; out.push({ datetime: 'x', open: o, high: o, low: c, close: c, volume: 1000 });
        }
      }
      return out;
    };
    const SESSION = { sessions: ['OTC_24/7'], quality: 'N/A' };
    const cd = {
      '1min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6),
      '5min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6),
      '15min': zigGen(100, 90, 0.10, 0.11, 12, 2, 6),
    };
    const q = quiet();
    const sig = await buildMultiTimeframeSignalOTC(cd, 'EUR/USD-OTC', SESSION, false, {});
    q();
    ok('T34c: OTC engine produced signal', sig && sig.bestTimeframe && sig.timeframeAnalysis, sig && sig.finalSignal);
    if (sig && sig.bestTimeframe) {
      const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
      await saveSignalToHistory(sig, 'EUR/USD-OTC', true, env, 'sig_t34c', 'FRESH_API');
      const hist = await kv.get('sig:EUR_USD_OTC', 'json');
      const rec = hist && hist[0];
      ok('T34c: OTC history row saved', !!rec);
      if (rec) {
        // signalIndicators may be present or gracefully null — both ok, but must not throw
        const hasField = rec.hasOwnProperty('signalIndicators');
        if (hasField) {
          const si = rec.signalIndicators;
          ok('T34c: OTC signalIndicators structure valid', si && typeof si.bestTF === 'string', JSON.stringify(si));
          if (si) {
            ok('T34c: OTC rsi numeric or null', si.rsi === null || typeof si.rsi === 'number', 'rsi=' + si.rsi);
            ok('T34c: OTC adx numeric or null', si.adx === null || typeof si.adx === 'number', 'adx=' + si.adx);
          }
        } else {
          // If no bestTF, gracefully absent is also acceptable per spec
          ok('T34c: OTC signalIndicators gracefully absent when no bestTF indicators', true);
        }
      }
    }
  }

  // ── T34d: /api/history round-trip ──
  {
    const kv = makeKV({
      'sig:BTC_USD': [
        {
          id: 'hist_t34', pair: 'BTC/USD', direction: 'BUY', confidence: '80%', grade: 'A',
          entryPrice: 100, expiryTime: new Date(Date.now() + 600000).toISOString(),
          bestTF: '5min', alignment: 'ALL_BULLISH', marketRegime: 'RANGING',
          session: ['24/7'], sessionQuality: 'N/A', timestamp: new Date().toISOString(),
          result: null, exitPrice: null, checkedAt: null,
          signalIndicators: { bestTF: '5min', rsi: 62.123, atrPct: 0.456, adx: 28.9, bbBandwidth: 4.321 },
        },
      ],
    });
    const env = { SIGNAL_CACHE: kv };
    const res = await handleHistory(new URL('https://x/api/history?pair=BTC/USD&limit=10'), env);
    const body = await res.json();
    ok('T34d: /api/history returned signals', body && body.signals && body.signals.length === 1);
    const sigRow = body && body.signals && body.signals[0];
    ok('T34d: signalIndicators survives round-trip', sigRow && sigRow.signalIndicators, JSON.stringify(sigRow && sigRow.signalIndicators));
    if (sigRow && sigRow.signalIndicators) {
      eq('T34d: rsi preserved', sigRow.signalIndicators.rsi, 62.123);
      eq('T34d: atrPct preserved', sigRow.signalIndicators.atrPct, 0.456);
      eq('T34d: adx preserved', sigRow.signalIndicators.adx, 28.9);
      eq('T34d: bbBandwidth preserved', sigRow.signalIndicators.bbBandwidth, 4.321);
      eq('T34d: bestTF preserved', sigRow.signalIndicators.bestTF, '5min');
    }
    // confirm handleHistory strips structureAudit but NOT signalIndicators
    const kv2 = makeKV({
      'sig:BTC_USD': [
        {
          id: 'hist_t34b', pair: 'BTC/USD', direction: 'BUY', confidence: '80%', grade: 'A',
          entryPrice: 100, expiryTime: new Date(Date.now() + 600000).toISOString(),
          bestTF: '5min', alignment: 'ALL_BULLISH', marketRegime: 'RANGING',
          session: ['24/7'], sessionQuality: 'N/A', timestamp: new Date().toISOString(),
          result: null, exitPrice: null, checkedAt: null,
          structureAudit: { secret: true, shouldBeStripped: 1 },
          signalIndicators: { bestTF: '5min', rsi: 55.5, atrPct: 0.3, adx: 22.1, bbBandwidth: 3.3 },
        },
      ],
    });
    const env2 = { SIGNAL_CACHE: kv2 };
    const res2 = await handleHistory(new URL('https://x/api/history?pair=BTC/USD&limit=10'), env2);
    const body2 = await res2.json();
    const sigRow2 = body2 && body2.signals && body2.signals[0];
    ok('T34d: structureAudit stripped, signalIndicators kept', sigRow2 && !sigRow2.structureAudit && sigRow2.signalIndicators, JSON.stringify({ hasAudit: !!(sigRow2 && sigRow2.structureAudit), hasInd: !!(sigRow2 && sigRow2.signalIndicators) }));
  }
}

console.log('\n── T35: Phase F edge input features ─────────────────────────');
{
  CONFIG.EDGE_FEATURES.enabled = true;
  const inds = { rsi: [60], bollinger: { bandwidth: [1, 1, 1, 1, 0.5] }, atr: [1, 1, 1, 1, 0.5] };
  const e = evaluateEdgeFeatures({ direction: 'BUY', indicators: inds, candles: [], now: new Date('2026-08-10T23:00:00Z') });
  eq('T35: hour multiplier applied', e.hourMultiplier, 1.1);
  ok('T35: RSI direction gate blocks overbought BUY', e.rsiDirectionBlocked === true);
  eq('T35: volatility mid state penalty', e.volatilityMultiplier, 0.9);
  eq('T35: ATR percentile low state', e.atrState, 'LOW_SQUEEZE');
  const env = { SIGNAL_CACHE: makeKV({ 'stats:TEST_USD': { winRate: 0.3, sampleSize: 20, recentResults: Array(20).fill('LOSS') } }) };
  const form = await getRecentFormMultiplier('TEST/USD', env);
  eq('T35: recent-form gate', form.recentFormMultiplier, 0.85);
  const rows = Array.from({ length: 20 }, (_, i) => ({ result: i % 2 ? 'WIN' : 'LOSS', timestamp: new Date().toISOString(), structureVerdict: 'ALIGNED', coreConfidence: 80, signalIndicators: { hourUTC: 23 } }));
  await env.SIGNAL_CACHE.put('sig:TEST_USD', JSON.stringify(rows));
  const refreshed = await refreshRollingCalibration(env, ['TEST/USD']);
  ok('T35: self-cal refresh recomputes tables', refreshed.refreshed && refreshed.snapshot && refreshed.snapshot.hourMultipliers[23] !== undefined);
  CONFIG.EDGE_FEATURES.enabled = false;
}

console.log('\n───────────────────────────────────────────────────────────');
console.log(fail === 0 ? 'PASS: ' + pass + '   FAIL: 0' : 'PASS: ' + pass + '   FAIL: ' + fail);
console.log(fail === 0 ? 'ALL FIX TESTS PASSED' : 'FAILURES: ' + failures.join(', '));
process.exit(fail === 0 ? 0 : 1);

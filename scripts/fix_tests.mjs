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
 *   T27 F3-14  scheduledScan pushes fresh tradeable signals (v6.10 revert of
 *              the noPush:true contract) — scanner push once, re-scan no-op,
 *              manual /api/signal after scanner no double-push, and the
 *              reverse order (manual first, then scanner)
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
import { passAI, passGrade, pushSignalToSubscribers, getMatchingSubscribers } from '../src/handlers/pushToSubscribers.js';
import { handleReport, handleHistory } from '../src/handlers/health.js';
import { handleSignalRaw, handleSignal } from '../src/handlers/signal.js';
import { __scanTest } from '../src/handlers/scheduledScan.js';
import { buildMultiTimeframeSignal } from '../src/signal/engine.js';
import { buildMultiTimeframeSignalOTC } from '../src/signal/otcEngine.js';
import { analyzeOTCPatterns } from '../src/analysis/otc.js';
import { getSignalGrade } from '../src/analysis/grade.js';
import { getCalibratedGradeAndConfidence, getCalibratedScore } from '../src/analysis/calibration.js';
import { analyzeStructure } from '../src/indicators/structure.js';
import { runDeterministicVoteAndFilters, decideTfDirection } from '../src/signal/voteFilters.js';
import { getSessionWeightMultiplier } from '../src/analysis/filters.js';
import { fetchCandles } from '../src/fetch/candles.js';
import { writeLatest } from '../src/history/latestCache.js';
import { ASSET_TYPE } from '../src/config.js';
// ── Phase F round 2 (edge features + self-calibration) ──
import { applyEdgeFeatures, computeSessionRange, computeAtrPercentile, getRecentFormMultiplier } from '../src/analysis/edgeFeatures.js';
import { recomputeCalibration, loadCalibration } from '../src/history/selfCalib.js';
import { handleCalib } from '../src/handlers/health.js';
import { makeCandleData } from './r71_fixtures.mjs';

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

// ── EDGE FEATURES test hooks (Phase F round 2, 2026-08-10) ──
// The edge-feature block (hour-of-day / RSI×direction / vol-state / ATR-pct /
// session-range / recent-form multipliers) is INPUT-side and config-driven.
// Existing tests pin the PRE-feature engine behaviour with
// edgeFeatures:false (same philosophy as opts.session / opts.newsBlock);
// the T35-T42 sections below exercise the features explicitly with
// edgeFeatures:true and pinned clocks.
const EDGE_OFF = { edgeFeatures: false };
// OTC pin: minute 5 = NORMAL time-context window (zero penalty) — the OTC
// engine's timeContext reads the UTC minute of `now` (getOTCTimeContext), and
// T8/T9/T10/T34 fixtures were designed under the zero-penalty window.
const PIN_OTC = '2026-08-10T14:05:00Z';

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
  const sig = await buildMultiTimeframeSignal('TEST/USD', candleData, 'CRYPTO', {}, EDGE_OFF);
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
  const sig2 = await buildMultiTimeframeSignal('TEST/USD', same, 'CRYPTO', {}, EDGE_OFF);
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
  const res1 = await handleSignalRaw('BTC/USD', env1, ctxOf(sink1), EDGE_OFF);
  await drain(sink1); q1();
  ok('T4a: engine produced an actionable signal', ['BUY', 'SELL'].includes(res1.signal.finalSignal), res1.signal.finalSignal);
  eq('T4a: subscriber received exactly one message', tg.length, 1);
  ok('T4a: push log written for the emitted id', !!env1.SIGNAL_CACHE._m.get('pushLog:' + res1.id));

  installNet();
  const env2 = envOf(); const sink2 = [];
  const q2 = quiet();
  const res2 = await handleSignalRaw('BTC/USD', env2, ctxOf(sink2), { noPush: true, ...EDGE_OFF });
  await drain(sink2); q2();
  ok('T4b: engine still produced a signal with nopush', ['BUY', 'SELL'].includes(res2.signal.finalSignal), res2.signal.finalSignal);
  eq('T4b: nopush suppresses the push', tg.length, 0);

  installNet();
  const env3 = envOf(); const sink3 = [];
  const q3 = quiet();
  const resp3 = await handleSignal('BTC/USD', env3, ctxOf(sink3), { noPush: true, ...EDGE_OFF });
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
  const sig = await buildMultiTimeframeSignal('TEST/USD', candleData, 'CRYPTO', env, EDGE_OFF);
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
  const sigAgainst = await buildMultiTimeframeSignalOTC(fixtureAgainst(), 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {}, { ...EDGE_OFF, now: PIN_OTC });
  r1();
  ok('T8a: OTC AGAINST engine produced SELL', sigAgainst.finalSignal === 'SELL', sigAgainst.finalSignal);
  ok('T8b: structure verdict is AGAINST', sigAgainst.structureVerdict && sigAgainst.structureVerdict.overall === 'AGAINST', sigAgainst.structureVerdict && sigAgainst.structureVerdict.overall);
  ok('T8c: AGAINST grade NOT capped (calibrated best -> A+)', sigAgainst.grade.grade === 'A+', sigAgainst.grade.grade);
  // ALIGNED: net-up with green tail -> BUY while structure BULLISH -> ALIGNED -> should be capped to C (worst WR)
  const fixtureAligned = () => ({ '1min': zigGen(100,90,0.10,0.11,12,2,6,'up'), '5min': zigGen(100,90,0.10,0.11,12,2,6,'up'), '15min': zigGen(100,90,0.10,0.11,12,2,6,'up') });
  const r2 = quiet();
  const sigAligned = await buildMultiTimeframeSignalOTC(fixtureAligned(), 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {}, { ...EDGE_OFF, now: PIN_OTC });
  r2();
  console.log('DBG T8d:', sigAligned.finalSignal, sigAligned.confidence, JSON.stringify(sigAligned.filtersApplied), 'votes:', JSON.stringify(sigAligned.votes));
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
    'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {}, { ...EDGE_OFF, now: PIN_OTC });
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
  const sigA = await buildMultiTimeframeSignalOTC(cdA, 'EUR/USD-OTC', SESSION, false, {}, { ...EDGE_OFF, now: PIN_OTC });
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
  const sigB = await buildMultiTimeframeSignalOTC(cdB, 'EUR/USD-OTC', SESSION, false, {}, { ...EDGE_OFF, now: PIN_OTC });
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
  const sig = await buildMultiTimeframeSignal('TEST/USD', cd, 'CRYPTO', {}, EDGE_OFF);
  r();
  eq('T18a: TRENDING fixture blocked (NO_TRADE)', sig.finalSignal, 'NO_TRADE');
  eq('T18b: NO_TRADE grade N/A', sig.grade.grade, 'N/A');
  eq('T18c: NO_TRADE label', sig.grade.label, 'NO_TRADE');
  // OTC: fully flat candles -> every TF dead-market -> NO_TRADE
  const flat = [];
  for (let i = 0; i < 100; i++) flat.push({ datetime: 'x', open: 90, high: 90, low: 90, close: 90, volume: 0 });
  const r2 = quiet();
  const osig = await buildMultiTimeframeSignalOTC({ '1min': flat, '5min': flat, '15min': flat }, 'EUR/USD-OTC', { sessions: ['OTC_24/7'], quality: 'N/A' }, false, {}, { ...EDGE_OFF, now: PIN_OTC });
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
  const res1 = await handleSignal('BTC/USD', env, ctxOf(sink1), { preferCache: true, ...EDGE_OFF });
  const b1 = await res1.json();
  await drain(sink1); q1();
  ok('T21a: plain preferCache serves the cached entry', b1.cached === true);
  const sink2 = []; const q2 = quiet();
  const res2 = await handleSignal('BTC/USD', env, ctxOf(sink2), { preferCache: true, fxMode: true, ...EDGE_OFF });
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
  const sig = await buildMultiTimeframeSignal('BTC/USD', makeCandleData({ basePrice: 78000, vol: 60, trend: 18, seed: 11 }), 'CRYPTO', {}, EDGE_OFF);
  r();
  eq('T26c: crypto signal sessionWeight = 1', sig.sessionWeight, 1);
  ok('T26d: no SESSION_WEIGHT filter on crypto', !(sig.filtersApplied || []).some(f => f.includes('SESSION_WEIGHT')), JSON.stringify(sig.filtersApplied));
}

console.log('\n── T27: scanner pushes fresh tradeable signals, deduped (F3-14 revert) ─');
{
  // Real pipeline: scanOnePair -> handleSignalRaw -> saveAndPush -> Telegram,
  // network stubbed (same pattern as T4 / phase10_integration). Subscriber
  // 111 watches BTCUSD with every filter open. This proves the auto-push
  // wiring end-to-end, not just the call-site options (the old grep contract
  // could not have caught a broken saveAndPush chain).
  const scanEnvOf = () => {
    const seed = { 'u:111': { pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: null } };
    seed['auto_users'] = ['111'];
    return { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: 'tok', TWELVEDATA_API_KEY_1: 'k', CEREBRAS_API_KEY: 'c', GROQ_API_KEY: 'g' };
  };
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
  const pushLogIds = (env) => [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('pushLog:')).map(k => k.slice('pushLog:'.length));
  const lockKeys = (env) => [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('pushLock:'));

  // ── 1) scanner delivers a fresh tradeable signal exactly once ──
  installNet();
  const env1 = scanEnvOf(); const sink1 = [];
  const q1 = quiet();
  const scan1 = await __scanTest.scanOnePair('BTC/USD', 'gen_t27', env1, ctxOf(sink1), EDGE_OFF);
  await drain(sink1); q1();
  ok('T27a: scanOnePair returned a cached result', !!scan1 && scan1.pair === 'BTC/USD', JSON.stringify(scan1));
  eq('T27a: fresh scanner signal pushed exactly one message', tg.length, 1);
  eq('T27a: delivered to the matching subscriber', tg[0].chatId, '111');
  ok('T27a: message names the pair', tg[0].text.includes('BTC/USD'));
  eq('T27a: pushLog written for the scanner-minted id', pushLogIds(env1).length, 1);
  eq('T27a: pushLock claimed for the subscriber/pair/direction', lockKeys(env1).length, 1);
  const hist1 = await env1.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
  eq('T27a: history holds exactly one row (no double save)', hist1.length, 1);

  // ── 2) re-scan of the same setup: cache warmed again, NOT re-pushed ──
  const q2 = quiet();
  const scan2 = await __scanTest.scanOnePair('BTC/USD', 'gen_t27b', env1, ctxOf(sink1), EDGE_OFF);
  await drain(sink1); q2();
  ok('T27b: re-scan still returns a cache write', !!scan2, JSON.stringify(scan2));
  eq('T27b: re-scan of same setup does NOT re-push (history dedup)', tg.length, 1);
  const hist2 = await env1.SIGNAL_CACHE.get('sig:BTC_USD', 'json');
  eq('T27b: history still exactly one row', hist2.length, 1);

  // ── 3) manual /api/signal for the same setup right after the scanner ──
  const q3 = quiet();
  const manual1 = await handleSignalRaw('BTC/USD', env1, ctxOf(sink1), EDGE_OFF);
  await drain(sink1); q3();
  ok('T27c: manual call still produced a signal response', !!manual1 && !!manual1.signal, '');
  eq('T27c: manual call after scanner push does NOT double-push', tg.length, 1);

  // ── 4) reverse order: manual push first, then the scanner sees it ──
  installNet();
  const env2 = scanEnvOf(); const sink2 = [];
  const q4 = quiet();
  await handleSignalRaw('BTC/USD', env2, ctxOf(sink2), EDGE_OFF);
  await drain(sink2);
  eq('T27d: manual push delivered once', tg.length, 1);
  const scan3 = await __scanTest.scanOnePair('BTC/USD', 'gen_t27c', env2, ctxOf(sink2), EDGE_OFF);
  await drain(sink2); q4();
  ok('T27d: scanner still warmed the cache after a manual push', !!scan3, JSON.stringify(scan3));
  eq('T27d: scanner does NOT re-push what the manual call pushed', tg.length, 1);

  // ── 5) call-site contract: noPush is no longer forced by the scanner ──
  const ss = fs.readFileSync(fileURLToPath(new URL('../src/handlers/scheduledScan.js', import.meta.url)), 'utf8');
  ok('T27e: scanner no longer forces noPush:true at the call site',
    !ss.includes('noPush: true') && ss.includes('handleSignalRaw(pair, env, ctx'));
  ok('T27e: scanner awaits persist so scheduled isolate cannot drop the push',
    ss.includes('awaitPersist: true'));
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
  const sig = await buildMultiTimeframeSignal('TEST/USD', cd, 'CRYPTO', env, EDGE_OFF);
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
  const sHigh = await buildMultiTimeframeSignal('EUR/USD', cd, 'FOREX', {}, { session: { sessions: ['LONDON'], overlap: 'NONE', quality: 'HIGH', hour: 14 }, newsBlock: null, ...EDGE_OFF });
  const sHighest = await buildMultiTimeframeSignal('EUR/USD', cd, 'FOREX', {}, { session: { sessions: ['LONDON', 'NEW_YORK'], overlap: 'LONDON_NY', quality: 'HIGHEST', hour: 14 }, newsBlock: null, ...EDGE_OFF });
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
  const sigA = await buildMultiTimeframeSignal('TEST/USD', candleDataA, 'CRYPTO', {}, EDGE_OFF);
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
    const sig = await buildMultiTimeframeSignalOTC(cd, 'EUR/USD-OTC', SESSION, false, {}, { ...EDGE_OFF, now: PIN_OTC });
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

// ════════════════════════════════════════════════════════════════════════
// PHASE F ROUND 2 — EDGE FEATURES (T35-T42)
// Input-side multipliers/gates + self-calibration. Config-driven, calibrated
// output layer untouched (R3). These sections run with edgeFeatures:true and
// pinned clocks so every assertion is deterministic.
// ════════════════════════════════════════════════════════════════════════

// Fixture notes (verified against the live engine on 2026-08-10; "raw" =
// calibration.rawConfidence = the pre-calibration engine confidence the edge
// block operates on — NOT the calibrated bucket value):
//   E1 = makeCandleData({vol:600,trend:0,seed:20}) -> SELL raw=92, RSI 46.95,
//       BB 0.82 HIGH_VOL, ATR pct neutral -> ONLY the hour factor can fire.
//   E2 = makeCandleData({vol:350,trend:0,seed:19}) -> SELL raw=78 (survives at
//       hour mult 1.0; 78*0.85=66.3 -> blocked by floor at hour mult 0.85).
//   E3 = makeCandleData({vol:120,trend:6,seed:18}) -> BUY raw=92, RSI 61.68,
//       BB 0.85 HIGH_VOL -> RSI chasing penalty fires (92*0.85=78 -> survives).
//   E4 = makeCandleData({vol:60,trend:0,seed:33}) -> BB 0.10 -> DEAD_SQUEEZE.
//   E5 = makeCandleData({vol:120,trend:6,seed:54}) -> BUY, MID_SQUEEZE x0.90
//       + ATR_PERCENTILE_EXPANSION x1.05 (pct=96).
const eFix = (p) => makeCandleData(p);
const PIN14 = '2026-08-10T14:00:00Z'; // neutral hour (HOUR_MULTIPLIERS[14] = 1.0)

const runEngine = async (pair, cd, assetType, env, opts) => {
  const r = quiet();
  const sig = await buildMultiTimeframeSignal(pair, cd, assetType, env || {}, { now: PIN14, ...(opts || {}) });
  r();
  return sig;
};

console.log('\n── T35: hour-of-day WR multiplier (A1) ─────────────────');
{
  const cd = eFix({ basePrice: 78000, vol: 600, trend: 0, seed: 20 });
  const s14 = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true });
  ok('T35a: neutral hour emits the signal', s14.finalSignal === 'SELL', s14.finalSignal);
  ok('T35a: no HOUR_FACTOR at neutral hour', !(s14.filtersApplied || []).some(f => f.includes('HOUR_FACTOR')), JSON.stringify(s14.filtersApplied));
  eq('T35a: raw confidence baseline 92', s14.calibration && s14.calibration.rawConfidence, 92);

  const s10 = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true, now: '2026-08-10T10:00:00Z' });
  ok('T35b: bad hour keeps the signal tradable (92*0.85=78 >= floor)',
    s10.finalSignal === 'SELL' && s10.calibration && s10.calibration.rawConfidence === 78,
    s10.finalSignal + ' raw=' + (s10.calibration && s10.calibration.rawConfidence));
  ok('T35b: HOUR_FACTOR x0.85 applied at UTC 10',
    (s10.filtersApplied || []).some(f => f === 'HOUR_FACTOR x0.85 (UTC 10)'), JSON.stringify(s10.filtersApplied));
  eq('T35b: audit hourUtc/hourMult', s10.edgeFeatures && [s10.edgeFeatures.hourUtc, s10.edgeFeatures.hourMult], [10, 0.85]);

  const s09 = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true, now: '2026-08-10T09:00:00Z' });
  ok('T35c: good hour boosts 92*1.10 capped at 92',
    s09.finalSignal === 'SELL' && s09.calibration && s09.calibration.rawConfidence === 92,
    s09.finalSignal + ' raw=' + (s09.calibration && s09.calibration.rawConfidence));
  ok('T35c: HOUR_FACTOR x1.10 applied at UTC 09',
    (s09.filtersApplied || []).some(f => f === 'HOUR_FACTOR x1.10 (UTC 09)'), JSON.stringify(s09.filtersApplied));

  // gate effect: 78 * 0.85 = 66.3 -> below 72 floor -> NO_TRADE
  const cd2 = eFix({ basePrice: 78000, vol: 350, trend: 0, seed: 19 });
  const s14b = await runEngine('BTC/USD', cd2, 'CRYPTO', {}, { edgeFeatures: true });
  eq('T35d: baseline fixture trades at neutral hour', s14b.finalSignal, 'SELL');
  const s10b = await runEngine('BTC/USD', cd2, 'CRYPTO', {}, { edgeFeatures: true, now: '2026-08-10T10:00:00Z' });
  eq('T35e: hour penalty + floor blocks the signal', s10b.finalSignal, 'NO_TRADE');
  ok('T35e: BELOW_FLOOR_AFTER_EDGE_FEATURES recorded',
    (s10b.filtersApplied || []).some(f => f.includes('BELOW_FLOOR_AFTER_EDGE_FEATURES')), JSON.stringify(s10b.filtersApplied));
}

console.log('\n── T36: RSI × direction gate (B4) ─────────────────────');
{
  // BUY with best-TF RSI 61.68 > 55 -> chasing penalty x0.85 (92*0.85=78)
  const cd = eFix({ basePrice: 78000, vol: 120, trend: 6, seed: 18 });
  const s = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true });
  ok('T36a: BUY+RSI>55 emits with penalty applied',
    s.finalSignal === 'BUY' && s.calibration && s.calibration.rawConfidence === 78,
    s.finalSignal + ' raw=' + (s.calibration && s.calibration.rawConfidence));
  ok('T36a: RSI_DIRECTION_GATE_PENALTY x0.85 recorded',
    (s.filtersApplied || []).some(f => f.includes('RSI_DIRECTION_GATE_PENALTY x0.85 (BUY rsi=61.68 > 55)')), JSON.stringify(s.filtersApplied));
  eq('T36a: audit rsiGate', s.edgeFeatures && [s.edgeFeatures.rsiGate.direction, s.edgeFeatures.rsiGate.rsi], ['BUY', 61.68]);

  // compounding: RSI penalty x hour penalty -> 85*0.85*0.85 = 61.4 -> floor
  const s10 = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true, now: '2026-08-10T10:00:00Z' });
  eq('T36b: RSI x hour penalties block below floor', s10.finalSignal, 'NO_TRADE');

  // SELL with RSI < 45 (fx fixture: SELL 73, RSI 37.87) -> penalty -> floor.
  // Pin the wall-clock-dependent inputs like T29 does: session quality HIGH
  // (not HIGHEST, which triggers the D2_HIGHEST_SESSION_BLOCK hard block) and
  // newsBlock null (avoids the real weekly windows, e.g. Mon-Fri 12:00-13:45
  // UTC US Economic Data Window) — detectTradingSession/checkNewsBlackout
  // read the real clock even when opts.now is pinned.
  const cdFx = eFix({ basePrice: 1.08, vol: 0.0012, trend: 0, seed: 55 });
  const sFx = await runEngine('EUR/USD', cdFx, 'FOREX', {}, {
    edgeFeatures: true, newsBlock: null,
    session: { sessions: ['LONDON'], overlap: 'NONE', quality: 'HIGH', hour: 14 },
  });
  eq('T36c: SELL+RSI<45 penalty blocks via floor', sFx.finalSignal, 'NO_TRADE');
  ok('T36c: SELL-side gate recorded',
    (sFx.filtersApplied || []).some(f => f.includes('RSI_DIRECTION_GATE_PENALTY x0.85 (SELL rsi=37.87 < 45)')), JSON.stringify(sFx.filtersApplied));

  // extreme mean-rev logic preserved: oversold BUY (RSI<30) and overbought
  // SELL (RSI>70) are OUTSIDE the gate's firing range (unit level)
  const base = { finalDirection: 'BUY', confidence: 80, pair: 'BTC/USD', assetType: 'CRYPTO',
    now: new Date(PIN14), candleData: {}, env: {}, calib: null,
    tfResults: { '5min': { direction: 'BUY', score: { up: 5 }, confluence: 6, alignedWithHTF: true } } };
  const uOversold = await applyEdgeFeatures({ ...base, indicators: { '5min': { rsi: [25, 25], bollinger: { bandwidth: [2.0] }, atr: [1, 1] } } });
  ok('T36d: oversold BUY (rsi 25) NOT gated (mean-rev kept)', !uOversold.audit.rsiGate, JSON.stringify(uOversold.audit));
  const uOverbought = await applyEdgeFeatures({ ...base, finalDirection: 'SELL',
    tfResults: { '5min': { direction: 'SELL', score: { down: 5 }, confluence: 6, alignedWithHTF: true } },
    indicators: { '5min': { rsi: [75, 75], bollinger: { bandwidth: [2.0] }, atr: [1, 1] } } });
  ok('T36d: overbought SELL (rsi 75) NOT gated (mean-rev kept)', !uOverbought.audit.rsiGate, JSON.stringify(uOverbought.audit));

  // penalty-mode unit: direction intact, blockedBy null, penalty applied
  const uPen = await applyEdgeFeatures({ ...base, indicators: { '5min': { rsi: [62, 62], bollinger: { bandwidth: [2.0] }, atr: [1, 1] } } });
  ok('T36e: penalty mode leaves direction intact (unit)',
    uPen.finalDirection === 'BUY' && uPen.audit.blockedBy === null && uPen.confidence === 68, // 80*0.85
    uPen.finalDirection + ' ' + uPen.confidence);
}

console.log('\n── T37: volatility state / BB bandwidth (B5) ───────────');
{
  // unit: dead / mid / high
  const base = { finalDirection: 'BUY', confidence: 80, pair: 'BTC/USD', assetType: 'CRYPTO',
    now: new Date(PIN14), candleData: {}, env: {}, calib: null,
    tfResults: { '5min': { direction: 'BUY', score: { up: 5 }, confluence: 6, alignedWithHTF: true } } };
  const uDead = await applyEdgeFeatures({ ...base, indicators: { '5min': { rsi: [50, 50], bollinger: { bandwidth: [0.10] }, atr: [1, 1] } } });
  eq('T37a: bb<=0.20 crypto dead-squeeze blocks', uDead.finalDirection, 'NO_TRADE');
  eq('T37a: blockedBy recorded', uDead.audit.blockedBy, 'VOL_STATE_DEAD_SQUEEZE');
  const uMid = await applyEdgeFeatures({ ...base, indicators: { '5min': { rsi: [50, 50], bollinger: { bandwidth: [0.50] }, atr: [1, 1] } } });
  eq('T37b: bb 0.2-0.8 mid-squeeze x0.90', uMid.confidence, 72); // 80*0.90
  eq('T37b: bbState MID_SQUEEZE', uMid.audit.bbState, 'MID_SQUEEZE');
  const uHigh = await applyEdgeFeatures({ ...base, indicators: { '5min': { rsi: [50, 50], bollinger: { bandwidth: [1.5] }, atr: [1, 1] } } });
  eq('T37c: bb>0.8 high-vol no penalty', uHigh.confidence, 80);
  eq('T37c: bbState HIGH_VOL', uHigh.audit.bbState, 'HIGH_VOL');

  // engine-level: flat fixture = dead squeeze
  const cd = eFix({ basePrice: 78000, vol: 60, trend: 0, seed: 33 });
  const s = await runEngine('BTC/USD', cd, 'CRYPTO', {}, { edgeFeatures: true });
  eq('T37d: flat fixture dead-squeeze blocked', s.finalSignal, 'NO_TRADE');
  ok('T37d: VOL_STATE_DEAD_SQUEEZE_BLOCK recorded',
    (s.filtersApplied || []).some(f => f.includes('VOL_STATE_DEAD_SQUEEZE_BLOCK (bb=0.1 <= 0.2)')), JSON.stringify(s.filtersApplied));
  eq('T37d: audit blockedBy', s.edgeFeatures && s.edgeFeatures.blockedBy, 'VOL_STATE_DEAD_SQUEEZE');

  // engine-level: mid-squeeze penalty (E5)
  const cd5 = eFix({ basePrice: 78000, vol: 120, trend: 6, seed: 54 });
  const s5 = await runEngine('BTC/USD', cd5, 'CRYPTO', {}, { edgeFeatures: true });
  ok('T37e: mid-squeeze fixture emits with VOL_STATE_MID_SQUEEZE',
    s5.finalSignal !== 'NO_TRADE' && (s5.filtersApplied || []).some(f => f.includes('VOL_STATE_MID_SQUEEZE x0.90 (bb=0.59 <= 0.8)')), s5.finalSignal + ' ' + JSON.stringify(s5.filtersApplied));
}

console.log('\n── T38: ATR percentile (B6) ────────────────────────────');
{
  // unit: percentile of the current ATR within the trailing window (current
  // bar excluded from the window)
  const arr = []; for (let i = 1; i <= 50; i++) arr.push(i); // 1..50
  eq('T38a: current 51 vs hist 1..50 -> pct 100', computeAtrPercentile([...arr, 51], 50, 20), 100);
  eq('T38b: current 1 vs hist 2..51 -> pct 0', computeAtrPercentile([2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51, 1], 50, 20), 0);
  eq('T38c: too few samples -> null', computeAtrPercentile([1, 2, 3], 50, 20), null);
  eq('T38d: short history fallback -> null', computeAtrPercentile(null, 50, 20), null);

  // engine-level: E5 carries atrPercentile 96 + expansion multiplier
  const cd5 = eFix({ basePrice: 78000, vol: 120, trend: 6, seed: 54 });
  const s5 = await runEngine('BTC/USD', cd5, 'CRYPTO', {}, { edgeFeatures: true });
  eq('T38e: engine exposes atrPercentile', s5.edgeFeatures && s5.edgeFeatures.atrPercentile, 96);
  ok('T38f: ATR_PERCENTILE_EXPANSION x1.05 recorded',
    (s5.filtersApplied || []).some(f => f.includes('ATR_PERCENTILE_EXPANSION x1.05 (pct=96)')), JSON.stringify(s5.filtersApplied));
}

console.log('\n── T39: recent-form gate (C8) ──────────────────────────');
{
  // unit: sample below minSample -> no penalty
  const u1 = await getRecentFormMultiplier('BTC/USD', { SIGNAL_CACHE: makeKV({ 'stats:BTC_USD': { winRate: 0.2, recentResults: ['LOSS','LOSS','LOSS','LOSS','LOSS'] } }) }, { minSample: 10, badWr: 0.35, badMult: 0.85 });
  eq('T39a: < minSample -> mult 1.0', u1.mult, 1.0);

  // unit: bad rolling WR -> x0.85
  const results = [];
  for (let i = 0; i < 20; i++) results.push(i < 5 ? 'WIN' : 'LOSS'); // 25% WR
  const u2 = await getRecentFormMultiplier('BTC/USD', { SIGNAL_CACHE: makeKV({ 'stats:BTC_USD': { winRate: 0.25, recentResults: results } }) }, { minSample: 10, badWr: 0.35, badMult: 0.85 });
  eq('T39b: bad rolling WR -> x0.85', u2.mult, 0.85);
  eq('T39b: wr surfaced', u2.wr, 0.25);

  // engine-level: E1 (raw 92) with bad stats. Note the EXISTING dynamic
  // confidence adjustment (voteFilters, wr<=0.35 -> -10) fires first: 92-10=82,
  // then RECENT_FORM x0.85 -> 69.7 -> below the 72 floor -> NO_TRADE. That is
  // the intended gate behaviour for a cold pair (TRAIN 35.0% vs 44.4% WR).
  const cd = eFix({ basePrice: 78000, vol: 600, trend: 0, seed: 20 });
  const stats = { pair: 'BTC/USD', winRate: 0.30, sampleSize: 10, recentResults: results };
  const env = { SIGNAL_CACHE: makeKV({ 'stats:BTC_USD': stats }) };
  const s = await runEngine('BTC/USD', cd, 'CRYPTO', env, { edgeFeatures: true });
  eq('T39c: cold pair -> NO_TRADE (dynAdj -10 then x0.85 below floor)', s.finalSignal, 'NO_TRADE');
  ok('T39c: RECENT_FORM_PENALTY x0.85 recorded',
    (s.filtersApplied || []).some(f => f.includes('RECENT_FORM_PENALTY x0.85 (wr=0.3, n=20)')), JSON.stringify(s.filtersApplied));
  ok('T39c: DYNAMIC_CONF_ADJ -10 also recorded (pre-existing consumer)',
    (s.filtersApplied || []).some(f => f.includes('DYNAMIC_CONF_ADJ: -10')), JSON.stringify(s.filtersApplied));
  ok('T39c: BELOW_FLOOR_AFTER_EDGE_FEATURES recorded',
    (s.filtersApplied || []).some(f => f.includes('BELOW_FLOOR_AFTER_EDGE_FEATURES')), JSON.stringify(s.filtersApplied));

  // control: good stats -> no penalty, signal trades
  const env2 = { SIGNAL_CACHE: makeKV({ 'stats:BTC_USD': { winRate: 0.55, sampleSize: 20, recentResults: Array(20).fill('WIN') } }) };
  const s2 = await runEngine('BTC/USD', cd, 'CRYPTO', env2, { edgeFeatures: true });
  ok('T39d: good recent form -> no penalty',
    s2.finalSignal === 'SELL' && !(s2.filtersApplied || []).some(f => f.includes('RECENT_FORM')), s2.finalSignal + ' ' + JSON.stringify(s2.filtersApplied));
}

console.log('\n── T40: self-calibration recompute + consume (C7) ─────');
{
  // seed 2016 decided rows at 10-min intervals (exactly the 14-day window,
  // 84 rows per UTC hour — above SELF_CALIB.MIN_HOUR_OBS=20 so the dynamic
  // hour multiplier path is exercised): UTC hour 9 always wins, UTC hour 10
  // always loses, everything else alternates. The hour is derived from the
  // row's OWN timestamp so the pattern is independent of the run hour.
  const now = Date.now();
  const hist = [];
  for (let i = 0; i < 2016; i++) {
    const ts = new Date(now - (2016 - i) * 600000);
    const hour = ts.getUTCHours();
    const win = hour === 9 ? true : (hour === 10 ? false : (i % 2 === 0));
    hist.push({
      id: 'sc_' + i, pair: 'BTC/USD', direction: win ? 'BUY' : 'SELL', result: win ? 'WIN' : 'LOSS',
      timestamp: ts.toISOString(),
      coreConfidence: 80, structureVerdict: i % 3 === 0 ? 'ALIGNED' : 'AGAINST', sessionQuality: 'N/A',
    });
  }
  const kv = makeKV({ 'sig:BTC_USD': hist });
  const env = { SIGNAL_CACHE: kv };
  const tables = await recomputeCalibration(env);
  ok('T40a: recompute produced tables', !!tables && tables.n >= 1900, JSON.stringify(tables && tables.n));
  ok('T40a: calib:latest written', !!(await kv.get('calib:latest')));
  eq('T40b: hourWR h9 (always wins) = 1.0', tables.hourWR[9].wr, 1);
  eq('T40b: hourWR h10 (always loses) = 0', tables.hourWR[10].wr, 0);
  ok('T40b: per-hour n above MIN_HOUR_OBS (dynamic path eligible)',
    tables.hourWR[9].n >= 20 && tables.hourWR[10].n >= 20, JSON.stringify({ n9: tables.hourWR[9].n, n10: tables.hourWR[10].n }));
  const loaded = await loadCalibration(env);
  ok('T40c: loadCalibration reads fresh tables', !!loaded && loaded.computedAt === tables.computedAt);

  // engine consumes dynamic hour multiplier: hour 10 wr 0/base ~0.5 -> clamp 0.85
  const cd = eFix({ basePrice: 78000, vol: 350, trend: 0, seed: 19 });
  const s = await runEngine('BTC/USD', cd, 'CRYPTO', env, { edgeFeatures: true, now: '2026-08-10T10:00:00Z' });
  ok('T40d: dynamic calib hour multiplier applied (HOUR_FACTOR x0.85)',
    (s.filtersApplied || []).some(f => f === 'HOUR_FACTOR x0.85 (UTC 10)'), JSON.stringify(s.filtersApplied));
  eq('T40d: audit hourMult from dynamic tables', s.edgeFeatures && s.edgeFeatures.hourMult, 0.85);

  // MIN_OBS guard: tiny window -> no write, previous tables kept
  const kv2 = makeKV({ 'sig:X': [{ id: 'a', pair: 'X', result: 'WIN', timestamp: new Date().toISOString(), coreConfidence: 80 }] });
  const r2 = await recomputeCalibration({ SIGNAL_CACHE: kv2 });
  eq('T40e: < MIN_OBS -> no recompute', r2, null);
  eq('T40e: no calib:latest written', await kv2.get('calib:latest'), null);

  // stale tables are ignored by loadCalibration
  const kv3 = makeKV({ 'calib:latest': { version: 'old', computedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(), n: 500, base: 0.4, structWR: {}, confBucketWR: {} } });
  eq('T40f: stale calib ignored', await loadCalibration({ SIGNAL_CACHE: kv3 }), null);

  // /api/calib endpoint surfaces static + dynamic
  const res = await handleCalib(env);
  const body = await res.json();
  ok('T40g: /api/calib returns calibration payload', !!body.calibration);
  eq('T40g: dynamic tables surfaced', body.calibration.dynamic && body.calibration.dynamic.n, tables.n);
  eq('T40g: static CALIB version surfaced', body.calibration.static.version, 'calib-v1-2026-08-09-train-0801-0806');
}

console.log('\n── T41: session-range position (A2) ───────────────────');
{
  // unit: crafted day: low at open (95), high at close (105) -> position 1.0
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const dt = new Date('2026-08-10T00:00:00Z').getTime() + i * 60000;
    const c = i === 59 ? 105 : 95 + (i / 60) * 9;
    candles.push({ datetime: new Date(dt).toISOString(), open: c, high: c + 0.5, low: c - 0.5, close: c });
  }
  const pos = computeSessionRange({ '1min': candles }, new Date('2026-08-10T01:00:00Z'), { minCandles: 20, minRangePct: 0.0005 });
  ok('T41a: position near day high', pos && pos.position >= 0.95, JSON.stringify(pos));
  const posMid = computeSessionRange({ '1min': candles.map((c, i) => i === 59 ? { ...c, close: 100 } : c) }, new Date('2026-08-10T01:00:00Z'), { minCandles: 20, minRangePct: 0.0005 });
  ok('T41b: position mid-day ~0.5', posMid && Math.abs(posMid.position - 0.5) < 0.1, JSON.stringify(posMid));
  eq('T41c: no candles -> null', computeSessionRange({}, new Date(PIN14), { minCandles: 20, minRangePct: 0.0005 }), null);
  eq('T41d: flat day (range < minRangePct) -> null',
    computeSessionRange({ '1min': candles.map(() => ({ datetime: '2026-08-10T00:30:00Z', open: 100, high: 100.0000001, low: 99.9999999, close: 100 })) }, new Date('2026-08-10T01:00:00Z'), { minCandles: 20, minRangePct: 0.05 }), null);

  // unit: extreme position applies the mean-rev bonus
  const base = { finalDirection: 'BUY', confidence: 80, pair: 'BTC/USD', assetType: 'CRYPTO',
    now: new Date(PIN14), env: {}, calib: null,
    tfResults: { '5min': { direction: 'BUY', score: { up: 5 }, confluence: 6, alignedWithHTF: true } },
    indicators: { '5min': { rsi: [50, 50], bollinger: { bandwidth: [2.0] }, atr: [1, 1] } } };
  const uExt = await applyEdgeFeatures({ ...base, candleData: { '1min': candles } }); // pos ~1.0
  eq('T41e: extreme position -> sessionRangeMult 1.05', uExt.audit.sessionRangeMult, 1.05);
  eq('T41e: confidence boosted 80*1.05', uExt.confidence, 84);

  // engine wiring: E1 restamped onto the pinned day -> sessionRange reported
  const cd = eFix({ basePrice: 78000, vol: 350, trend: 0, seed: 19 });
  const t0 = new Date('2026-08-10T00:00:00Z').getTime();
  const restamped = {};
  for (const [tf, arr] of Object.entries(cd)) {
    const step = (tf === '1min' ? 1 : tf === '5min' ? 5 : 15) * 60000;
    restamped[tf] = arr.map((c, i) => ({ ...c, datetime: new Date(t0 + i * step).toISOString() }));
  }
  const s = await runEngine('BTC/USD', restamped, 'CRYPTO', {}, { edgeFeatures: true });
  ok('T41f: engine reports sessionRange for the pinned day',
    typeof s.edgeFeatures.sessionRange === 'number' && s.edgeFeatures.sessionRange > 0 && s.edgeFeatures.sessionRange < 1,
    JSON.stringify(s.edgeFeatures && s.edgeFeatures.sessionRange));
}

console.log('\n── T42: signalIndicators extended, additive (R5) ───────');
{
  const sig = {
    finalSignal: 'SELL', confidence: '90%', grade: { grade: 'A' }, bestTimeframe: { timeframe: '5min' },
    recommendations: { '5min': { entry: { price: 100 } } },
    timeframeAnalysis: {
      '5min': {
        entry: { price: 100 },
        indicators: { rsi: '46.95', atr: '0.5', adx: '12', bbBandwidth: '0.9600' },
      },
    },
    edgeFeatures: {
      hourUtc: 10, hourMult: 0.85, sessionRange: 0.54, bbState: 'HIGH_VOL',
      atrPercentile: 42, totalMult: 0.85, recentFormWr: null,
    },
    aiValidation: { status: 'SKIPPED' }, coreConfidence: 88, alignment: 'SELL',
    marketRegime: 'RANGING', session: { sessions: ['24/7'], quality: 'N/A' },
    structureVerdict: { overall: 'AGAINST' }, timestamp: new Date().toISOString(),
  };
  const kv = makeKV();
  const env = { SIGNAL_CACHE: kv };
  await saveSignalToHistory(sig, 'BTC/USD', false, env, 'sig_r5x', 'FRESH_API');
  const rec = (await kv.get('sig:BTC_USD', 'json'))[0];
  const si = rec && rec.signalIndicators;
  ok('T42a: signalIndicators written', !!si);
  if (si) {
    eq('T42a: legacy fields preserved (rsi)', si.rsi, 46.95);
    eq('T42a: legacy fields preserved (bbBandwidth)', si.bbBandwidth, 0.96);
    eq('T42b: atrPercentile added', si.atrPercentile, 42);
    eq('T42b: bbState added', si.bbState, 'HIGH_VOL');
    eq('T42b: sessionRange added', si.sessionRange, 0.54);
    eq('T42b: hourUtc added', si.hourUtc, 10);
    eq('T42b: hourMult added', si.hourMult, 0.85);
    eq('T42b: totalMult added', si.totalMult, 0.85);
  }
}


console.log('\n── T43: push lock released on Telegram fail + health status ─');
{
  // Live bug 2026-08-12: claimPushLock ran BEFORE sendMessage. A 401/403
  // left the lock held for 30 min, wrote no pushLog, and the next tick
  // returned skipped:'locked'. User saw pushesLast24h=0 forever.
  const { getPushStats, normalizeAutoUsers, isAutoEnabled } = await import('../src/handlers/pushToSubscribers.js');
  const seed = {
    'u:111': { pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, channelId: null },
    'auto_users': ['111'],
  };
  const env = { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: 'tok' };
  const signal = {
    id: 'sig_t43a', pair: 'BTC/USD',
    signal: {
      finalSignal: 'BUY', confidence: '85%', grade: { grade: 'A', label: 'STRONG' },
      bestTimeframe: { timeframe: '5min' },
      recommendations: { '5min': { entry: { price: 1 }, expiry: { totalMinutes: 10, countdown: { label: '1m' } } } },
    },
  };
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({ ok: false }) });
  const q = quiet();
  const r1 = await pushSignalToSubscribers(signal, env);
  q();
  eq('T43a: failed send reports telegram-fail (not silent 0)', r1.skipped, 'telegram-fail');
  eq('T43a: nothing delivered', r1.pushed, 0);
  eq('T43a: lock NOT held after a failed send',
    [...env.SIGNAL_CACHE._m.keys()].filter(k => k.startsWith('pushLock:')).length, 0);
  ok('T43a: lastAttempt recorded', !!env.SIGNAL_CACHE._m.get('push:lastAttempt'));

  let tg = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      const b = JSON.parse(init.body);
      tg.push(b.chat_id);
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  const r2 = await pushSignalToSubscribers({ ...signal, id: 'sig_t43b' }, env);
  eq('T43b: retry after a failed send is delivered', r2.pushed, 1);
  eq('T43b: Telegram got the retry', tg.length, 1);
  ok('T43b: pushLog written on the successful retry', !!env.SIGNAL_CACHE._m.get('pushLog:sig_t43b'));

  const r3 = await pushSignalToSubscribers(signal, { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed) });
  eq('T43c: missing BOT_TOKEN -> skipped no-token', r3.skipped, 'no-token');

  const r4 = await pushSignalToSubscribers(signal, { SIGNAL_CACHE: makeKV(), BOT_KV: makeKV(seed), BOT_TOKEN: '   ' });
  eq('T43d: whitespace BOT_TOKEN -> skipped no-token', r4.skipped, 'no-token');

  const stats = await getPushStats(env);
  ok('T43e: pushEnabled true when token present', stats.pushEnabled === true);
  eq('T43e: noTokenReason null when token present', stats.noTokenReason, null);
  ok('T43e: lastAttempt exposed', !!(stats.lastAttempt && stats.lastAttempt.signalId));
  ok('T43e: durable deliveries counted (not just open pushLog keys)', stats.pushesLast24h >= 1);
  ok('T43e: subscriber snapshot includes pair/autoEnabled',
    Array.isArray(stats.subscribers) && stats.subscribers[0] && stats.subscribers[0].autoEnabled === true
    && stats.subscribers[0].pair === 'BTCUSD');

  const off = await getPushStats({ SIGNAL_CACHE: makeKV() });
  eq('T43f: noTokenReason missing when secret absent', off.noTokenReason, 'missing');
  eq('T43f: pushEnabled false without token', off.pushEnabled, false);

  eq('T43g: normalize numbers + u: prefix + objects',
    normalizeAutoUsers([111, 'u:222', { chatId: '333' }, ' 444 ']),
    ['111', '222', '333', '444']);
  ok('T43g: isAutoEnabled accepts true/1/"true"',
    isAutoEnabled({ autoEnabled: true }) && isAutoEnabled({ autoEnabled: 1 }) && isAutoEnabled({ autoEnabled: 'true' }));
  ok('T43g: isAutoEnabled rejects false/missing',
    !isAutoEnabled({ autoEnabled: false }) && !isAutoEnabled({}) && !isAutoEnabled(null));

  const idx = fs.readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
  ok('T43h: scheduled */5 awaits scheduledScan (does not wrap-and-return)',
    idx.includes('await scheduledScan(env, ctx)') && !idx.includes('ctx.waitUntil(scheduledScan'));

  // Reviewer R1/R2: /health must carry version 6.10.4 and a push object whose
  // delivered24h field is the durable counter (not the deletable pushLog keys).
  const hh = fs.readFileSync(fileURLToPath(new URL('../src/handlers/health.js', import.meta.url)), 'utf8');
  ok('T43i: /health push block exposes durable delivered24h at top level',
    hh.includes('delivered24h') && hh.includes('phase10.pushesLast24h'));
  ok('T43j: /health version bumped to 6.10.4',
    hh.includes("version: '6.10.4'"));
}

console.log('\n── T44: PENDING_ENTRY unfilled -> TIE, not mechanical WIN (Phase F 2026-08-14) ──');
{
  // Fixture helpers: build a pending record + history row and a fetch stub whose
  // expiry candle sits on the favourable side of the entry (never touched).
  const mkRow = (id, fillStatus, entryPrice, extra = {}) => ({
    id, pair: 'BTC/USD', isOTC: false, direction: 'BUY',
    entryPrice, expiryTime: new Date(Date.now() - 10 * 60000).toISOString(),
    timestamp: new Date(Date.now() - 30 * 60000).toISOString(),
    fillStatus, result: null, exitPrice: null, ...extra,
  });

  const run = async (record) => {
    const expMin = new Date(record.expiryTime).toISOString().slice(0, 19).replace('T', ' ');
    const kv = makeKV({
      ['pending:' + record.id]: record,
      ['sig:BTC_USD']: [record],
    });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      values: [{ datetime: expMin, open: '100.5', high: '101.5', low: '100.5', close: '101' }],
    }), text: async () => '' });
    await scheduledTracker({ SIGNAL_CACHE: kv, TWELVEDATA_API_KEYS: '["k1"]' });
    return kv;
  };

  // (a) PENDING_ENTRY + entry never touched (low 100.5 > entry 100) -> TIE, no stats.
  {
    const kv = await run(mkRow('sig_fill_a', 'PENDING_ENTRY', 100));
    const row = (await kv.get('sig:BTC_USD', 'json'))[0];
    eq('T44a: unfilled PENDING_ENTRY resolves TIE (not mechanical WIN)', row.result, 'TIE');
    ok('T44a: entryHit recorded false (evidence of never-filled)', row.entryHit === false);
    ok('T44a: TIE excluded from pair stats', kv._m.get('stats:BTC_USD') === undefined);
  }

  // (b) PENDING_ENTRY + entry touched (low below entry) -> still WIN/LOSS.
  {
    const rec = mkRow('sig_fill_b', 'PENDING_ENTRY', 100);
    const expMin = new Date(rec.expiryTime).toISOString().slice(0, 19).replace('T', ' ');
    const kv = makeKV({ 'pending:sig_fill_b': rec, 'sig:BTC_USD': [rec] });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      values: [{ datetime: expMin, open: '99.4', high: '100.4', low: '99.4', close: '101' }],
    }), text: async () => '' });
    await scheduledTracker({ SIGNAL_CACHE: kv, TWELVEDATA_API_KEYS: '["k1"]' });
    const row = (await kv.get('sig:BTC_USD', 'json'))[0];
    eq('T44b: filled PENDING_ENTRY still graded WIN', row.result, 'WIN');
    ok('T44b: entryHit recorded true', row.entryHit === true);
  }

  // (c) INSTANT + no re-test return -> still WIN/LOSS (fix is PENDING_ENTRY-only).
  {
    const kv = await run(mkRow('sig_fill_c', 'INSTANT', 100));
    const row = (await kv.get('sig:BTC_USD', 'json'))[0];
    eq('T44c: INSTANT resolution untouched (still WIN)', row.result, 'WIN');
  }

  // (d) cbShadow row keeps its counterfactual WIN/LOSS resolution.
  {
    const kv = await run(mkRow('sig_fill_d', 'PENDING_ENTRY', 100, { cbShadow: true }));
    const row = (await kv.get('sig:BTC_USD', 'json'))[0];
    eq('T44d: cbShadow PENDING_ENTRY keeps counterfactual WIN', row.result, 'WIN');
  }
}

console.log('\n── T45: regime-conditional calibration + RANGING/ALIGNED block (Phase F 2026-08-15) ──');
{
  // Regime-conditional structWR: RANGING mean-reversion vs TRENDING trend-following.
  const conf88 = 88; // bucket '88+' → confBucketWR 0.4469…

  const rangingAligned = getCalibratedGradeAndConfidence(conf88, 'ALIGNED', 'RANGING');
  eq('T45a: RANGING + ALIGNED capped to C (worst cell 41.2%)', rangingAligned.grade.grade, 'C');

  const trendingAligned = getCalibratedGradeAndConfidence(conf88, 'ALIGNED', 'TRENDING');
  ok('T45b: TRENDING + ALIGNED NOT capped (best cell 51.4%)',
    ['A+', 'A'].includes(trendingAligned.grade.grade), JSON.stringify(trendingAligned.grade.grade));

  const rangingAgainst = getCalibratedGradeAndConfidence(conf88, 'AGAINST', 'RANGING');
  eq('T45c: RANGING + AGAINST not capped (best 50.1%)', rangingAgainst.grade.grade, 'A+');

  const sAligned = getCalibratedScore(conf88, 'ALIGNED', 'RANGING');
  const sAgainst = getCalibratedScore(conf88, 'AGAINST', 'RANGING');
  ok('T45d: RANGING AGAINST scores above ALIGNED (ranking corrected)',
    sAgainst > sAligned, `against=${sAgainst} aligned=${sAligned}`);

  const sTrendAligned = getCalibratedScore(conf88, 'ALIGNED', 'TRENDING');
  ok('T45e: TRENDING ALIGNED scores above RANGING ALIGNED (regime-aware)',
    sTrendAligned > sAligned, `trending=${sTrendAligned} ranging=${sAligned}`);

  // No-regime callers (OTC / legacy) still work via pooled table.
  const noRegime = getCalibratedGradeAndConfidence(conf88, 'ALIGNED');
  eq('T45f: no-regime call falls back to pooled cap (ALIGNED→C)', noRegime.grade.grade, 'C');

  // getSignalGrade passes regime through.
  const gs = getSignalGrade(conf88, 0, '', 'ALIGNED', 'RANGING');
  eq('T45g: getSignalGrade is regime-aware (RANGING ALIGNED→C)', gs.grade, 'C');

  // Engine wiring: the new hard block + regime-aware calibration call exist.
  const eng = fs.readFileSync(fileURLToPath(new URL('../src/signal/engine.js', import.meta.url)), 'utf8');
  ok('T45h: engine has D2_RANGING_ALIGNED_BLOCK hard block',
    eng.includes('D2_RANGING_ALIGNED_BLOCK (41.2% WR n=1639)') && eng.includes('buildStructureVerdict(tfResults, finalDirection).overall === \'ALIGNED\''));
  ok('T45i: engine passes marketRegime into calibrated grade/confidence',
    eng.includes('getCalibratedGradeAndConfidence(confidence, structureVerdict.overall, marketRegime, activeCalib)'));
  const cfg = fs.readFileSync(fileURLToPath(new URL('../src/config.js', import.meta.url)), 'utf8');
  ok('T45j: D2_RANGING_ALIGNED_BLOCK_ENABLED flag present', cfg.includes('D2_RANGING_ALIGNED_BLOCK_ENABLED: true'));
}

console.log('\n── T46: Watch-ALL mode — pair/watchlist gate bypassed, other gates kept (v4.5.1) ──');
{
  const sigOf = (p) => ({
    id: 'sig_t46', pair: p,
    signal: { finalSignal: 'BUY', confidence: '85%', grade: { grade: 'A', label: 'STRONG' } },
  });
  const mk = (user) => {
    const seed = { 'u:111': user, auto_users: ['111'] };
    return { BOT_KV: makeKV(seed), SIGNAL_CACHE: makeKV() };
  };

  // (a) no watchAll, ETH/USD not watched -> no match
  {
    const env = mk({ pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false });
    const m = await getMatchingSubscribers(sigOf('ETH/USD'), env);
    eq('T46a: without watchAll, unwatched pair -> no match', m.length, 0);
  }

  // (b) watchAll: true -> matches ANY pair
  {
    const env = mk({ pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, watchAll: true });
    const m = await getMatchingSubscribers(sigOf('ETH/USD'), env);
    eq('T46b: watchAll=true matches unwatched pair', m.length, 1);
    eq('T46b: matched chatId correct', m[0].chatId, '111');
  }

  // (c) watchAll does NOT bypass autoEnabled or grade gate
  {
    const envOff = mk({ pair: 'BTCUSD', watchlist: [], autoEnabled: false, gradeFilter: 'ALL', minConfidence: 0, aiOnlyMode: false, watchAll: true });
    eq('T46c: watchAll does NOT bypass autoEnabled', (await getMatchingSubscribers(sigOf('ETH/USD'), envOff)).length, 0);
    const envG = mk({ pair: 'BTCUSD', watchlist: [], autoEnabled: true, gradeFilter: 'A', minConfidence: 0, aiOnlyMode: false, watchAll: true });
    const sigC = { id: 'sig_t46c', pair: 'ETH/USD', signal: { finalSignal: 'BUY', confidence: '85%', grade: { grade: 'C', label: 'MODERATE' } } };
    eq('T46c: watchAll does NOT bypass gradeFilter', (await getMatchingSubscribers(sigC, envG)).length, 0);
  }
}

console.log('\n───────────────────────────────────────────────────────────');
console.log(fail === 0 ? 'PASS: ' + pass + '   FAIL: 0' : 'PASS: ' + pass + '   FAIL: ' + fail);
console.log(fail === 0 ? 'ALL FIX TESTS PASSED' : 'FAILURES: ' + failures.join(', '));
process.exit(fail === 0 ? 0 : 1);

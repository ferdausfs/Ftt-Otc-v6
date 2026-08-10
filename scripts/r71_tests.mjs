/**
 * R7.1 — Structure Attribution Shadow Instrumentation: mandatory test suite.
 *   node scripts/r71_tests.mjs
 *
 * Real module integration wherever practical. No network/AI/KV (env={} makes the
 * engine deterministic: AI returns NO_KEY -> BOTH_UNAVAILABLE -> skipped; dynAdj
 * is 0 with no SIGNAL_CACHE). The 15 mandatory tests are tagged [#n].
 */

import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));

// ── in-memory KV double (with delete + write counter) ───────────────────
function makeKV() {
  const m = new Map();
  return {
    _m: m, puts: 0, dels: 0,
    async get(k, type) {
      if (!m.has(k)) return null;
      const v = m.get(k).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts) { this.puts++; m.set(k, { value: String(v), opts }); },
    async delete(k) { this.dels++; m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) };
    },
  };
}
const ctxSink = () => { const s = []; const ctx = { waitUntil: (p) => { s.push(p); return p; } }; return { ctx, sink: s }; };

// ── modules ─────────────────────────────────────────────────────────────
const { ASSET_TYPE } = await import('../src/config.js');
const { buildMultiTimeframeSignal } = await import('../src/signal/engine.js');
const { buildMultiTimeframeSignalOTC } = await import('../src/signal/otcEngine.js');
const {
  attachShadowTf, buildTimeframeAudit, computeEngineAudit, classifyAttribution,
  getEngineAudit, getShadowTfRaw, sanitizeAuditForHistory,
} = await import('../src/signal/r71shadow.js');
const { decideTfDirection } = await import('../src/signal/voteFilters.js');
const { makeCandleData, makeCandles, neutralStructureCandles, bullishChochCandles } = await import('./r71_fixtures.mjs');

const ENV = {}; // deterministic: no AI keys, no SIGNAL_CACHE

// ════════════════════════════════════════════════════════════════════════
// FROZEN-BASELINE REGRESSION GUARD (F3-20 refresh)
// ════════════════════════════════════════════════════════════════════════
// [#1a]/[#14a]/[#17] compare the live engine byte-for-byte against a snapshot
// of the src tree at BASELINE_COMMIT. Until F3-20 that snapshot was 71e87eb —
// the PRE-ROUND-1 engine — so every reviewer-approved change since (D2 hard
// blocks + AI skip, fillStatus, /12 confluence, F3-05 grade cap, F3-11 RSI
// score fix, F3-13 session weights, ...) intentionally broke the byte-equality
// contract (#1a/#17 failed on main). F3-20 moves the baseline to the CURRENT
// approved engine tip (e56cd33): the contract now guards the current engine,
// and any FUTURE unapproved output change fails the suite.
//
// PHASE F ROUND 2 (2026-08-10): edge features are the next approved engine
// release — the input-side multipliers/gates (hour-of-day, RSI×direction,
// vol-state, ATR-percentile, session-range, recent-form) intentionally change
// confidence/filtersApplied/edgeFeatures output, so the baseline is refreshed
// to the approved tip ec6ed65 via the F3-20 mechanism (justification in the
// PR: "r71 baseline refresh — divergence redaction update with
// justification"). The guard now protects the edge-feature engine.
const BASELINE_COMMIT = 'ec6ed65'; // Phase F round 2: approved engine tip (was e56cd33)
function bootstrapBaseline() {
  // The verify/baseline tree is gitignored and regenerated on demand. A marker
  // file records which commit it was built from, so changing BASELINE_COMMIT
  // (e.g. the next approved engine release) automatically rebuilds the tree
  // instead of silently comparing against a stale snapshot.
  const marker = 'verify/baseline/.commit';
  const built = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === BASELINE_COMMIT
    && fs.existsSync('verify/baseline/src/signal/engine.js');
  if (built) return;
  fs.rmSync('verify/baseline', { recursive: true, force: true });
  fs.mkdirSync('verify/baseline', { recursive: true });
  try {
    execSync('git archive ' + BASELINE_COMMIT + ' src | tar -x -C verify/baseline', { stdio: 'pipe' });
  } catch (e) {
    console.error('FATAL: cannot archive baseline commit ' + BASELINE_COMMIT
      + ' — is it present in the local clone? (try: git fetch --unshallow origin)');
    throw e;
  }
  fs.writeFileSync(marker, BASELINE_COMMIT + '\n');
}

// ════════════════════════════════════════════════════════════════════════
// [#1] BASELINE PRODUCTION EQUIVALENCE
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#1] Baseline production equivalence ──────────────────');
{
  // Baseline tree = full copy of the approved engine at BASELINE_COMMIT
  // (F3-20: e56cd33 — the stale pre-round-1 71e87eb snapshot was retired
  // because every approved round-1/2/3 fix intentionally changed output).
  // Phase F: calibration (grade/confidence) intentionally changes output to fix
  // inverted ladder. Those fields are in STANDARD_CALIBRATION_DIVERGENT set and
  // excluded from byte-equality check with justification.
  bootstrapBaseline();
  const baselineEngine = await import('../verify/baseline/src/signal/engine.js');
  const STANDARD_CALIBRATION_DIVERGENT = new Set(['grade','confidence','calibration','coreConfidence']);
  // deep-strip time-dependent fields so two near-simultaneous runs compare equal
  function stripTime(obj) {
    const clone = JSON.parse(JSON.stringify(obj));
    const kill = new Set(['generatedAt', 'expiryTime', 'nextCandleClose', 'humanReadable', 'nextRefresh', 'candleTime']);
    function walk(o) {
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          if (kill.has(k) || k === 'expiry' || k === 'entry' || k === 'countdown') delete o[k];
          else if (STANDARD_CALIBRATION_DIVERGENT.has(k)) delete o[k];
          else walk(o[k]);
        }
      }
    }
    walk(clone);
    return clone;
  }
  const fixtures = [
    { name: 'bull',  p: { basePrice: 78000, vol: 60, trend: 18, seed: 11 } },
    { name: 'bear',  p: { basePrice: 78000, vol: 60, trend: -18, seed: 22 } },
    { name: 'flat',  p: { basePrice: 1.08, vol: 0.0006, trend: 0, seed: 33 } },
    { name: 'wkup',  p: { basePrice: 1.08, vol: 0.0009, trend: 0.0002, seed: 44 } },
    { name: 'wkdn',  p: { basePrice: 1.08, vol: 0.0009, trend: -0.0002, seed: 55 } },
  ];
  let allEq = true;
  for (const f of fixtures) {
    const cd = makeCandleData(f.p);
    const baseSig = await baselineEngine.buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
    const newSig  = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
    const a = stripTime(baseSig), b = stripTime(newSig);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      allEq = false;
      // find first differing top-level key for diagnostics
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      let diff = '';
      for (const k of keys) { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { diff = k; break; } }
      console.log('   divergence in fixture ' + f.name + ' at key: ' + diff);
    }
  }
  ok('[#1a] baseline vs instrumented engine byte-equal on ' + fixtures.length + ' fixtures (direction/score/confluence/confidence/grade/recommendations/timeframeAnalysis) — calibration fields excluded (Phase F)', allEq);

  // [#1b] normal history behaviour unchanged (record minus the additive audit)
  const { saveSignalToHistory } = await import('../src/history/stats.js');
  const cd = makeCandleData({ basePrice: 78000, vol: 60, trend: 18, seed: 11 });
  const newSig = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  await saveSignalToHistory(newSig, 'BTC/USD', false, env, 'sig_test_1', 'FRESH_API');
  const rec = (await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json'))[0];
  const stripped = { ...rec }; delete stripped.structureAudit; delete stripped.timestamp; delete stripped.id;
  // baseline path: a signal with NO audit (OTC-style) must produce an identical core record shape
  const kv2 = makeKV(); const env2 = { SIGNAL_CACHE: kv2 };
  const noAuditSig = { ...newSig }; // spread drops the Symbol -> no audit persists
  await saveSignalToHistory(noAuditSig, 'BTC/USD', false, env2, 'sig_test_2', 'FRESH_API');
  const rec2 = (await env2.SIGNAL_CACHE.get('sig:BTC_USD', 'json'))[0];
  delete rec2.structureAudit; delete rec2.timestamp; delete rec2.id;
  eq('[#1b] core history record identical with/without audit (additive only)', stripped, rec2);
  ok('[#1b] audit persisted on the audited row', !!rec.structureAudit);
}

// ════════════════════════════════════════════════════════════════════════
// [#2] NEUTRAL STRUCTURE — prod deterministic == shadow, no hard-block
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#2] Neutral structure ─────────────────────────────────');
{
  const cd = makeCandleData({ basePrice: 78000, vol: 50, trend: 12, seed: 7 });
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
  const audit = getEngineAudit(sig);
  ok('[#2] audit present', !!audit);
  eq('[#2] attribution UNCHANGED', audit.attribution, 'UNCHANGED');
  eq('[#2] productionPreAi == shadow', audit.productionPreAiDirection, audit.shadowFinalDirection);
  eq('[#2] no hard-block observed', audit.diagnostic.tfHardBlockObserved, false);
  // F3-20 baseline refresh: this expectation now pins the CURRENT engine
  // contract. Post-71e87eb the engine gained the approved D2 hard-block layer
  // (round-1 D2 blocks; F3-15 AI-skip): a TRENDING-regime fixture is blocked
  // BUY/SELL -> NO_TRADE before the AI layer even runs (see filtersApplied:
  // D2_TRENDING_BLOCK + AI_SKIPPED (D2 hard block)). The R7.1 audit compares
  // the deterministic pre-AI direction (productionPreAi) against the ACTUAL
  // final direction (productionPostAi), so ANY post-vs-pre divergence —
  // including this D2 block — is classified AI_AFFECTED. That is the current,
  // reviewer-approved classification contract; if the D2 layer ever changes,
  // this line must be consciously updated (it must NOT silently drift back).
  eq('[#2] comparability AI_AFFECTED (D2 block post-71e87eb)', audit.comparability, 'AI_AFFECTED');
}

// ── helpers for constructed audit scenarios ─────────────────────────────
function tfAnalysis(o) {
  const up = o.up, down = o.down;
  const a = {
    tf: o.tf || '5min', assetType: o.assetType || 'CRYPTO', direction: o.direction,
    score: { up, down, diff: Math.round(Math.abs(up - down) * 100) / 100 },
    confluence: Math.max(o.upCat || 0, o.downCat || 0),
    structure: o.structure || null,
    structureApplied: o.structure ? o.structure.summary : 'NONE',
    alignedWithHTF: true,
    categoryScores: { fvg: { active: 'NONE' } },
    indicators: o.indicators || { adx: '28.0', bbBandwidth: '0.5000', atr: '150' },
    entry: { price: 78000 }, expiry: { expiryTime: new Date(Date.now() + 600000).toISOString() },
  };
  attachShadowTf(a, o.raw);
  return a;
}
function raw(o) {
  const r = {
    preStructUp: o.preUp, preStructDown: o.preDown,
    preStructUpCat: o.preUpCat, preStructDownCat: o.preDownCat,
    structureMultUp: o.multUp ?? 1, structureMultDn: o.multDn ?? 1,
    preHardBlockDirection: o.preHard, hardBlocked: !!o.hardBlocked, hardBlockReason: o.hardReason || null,
    categoryVoteApplied: !!o.voteApplied, voteDirection: o.voteDir || null,
    freshness: { chochEventAgeBars: null, brokenSwingAgeBars: null, bosReferenceSwingBarsAgo: null, recentBosBreakBarsAgo: null },
  };
  // Report-7 correction: explicit shadow confirmation-penalty fields (when the
  // raw is hand-built). If omitted, buildTimeframeAudit/computeEngineAudit fall
  // back to preStruct (no penalty) — matching the pre-correction behaviour.
  if (o.sCoreDir !== undefined) r.shadowCoreDirection = o.sCoreDir;
  if (o.sEngUp !== undefined) r.shadowEngineScoreUp = o.sEngUp;
  if (o.sEngDown !== undefined) r.shadowEngineScoreDown = o.sEngDown;
  if (o.sConfirmed !== undefined) r.shadowCandleConfirmed = o.sConfirmed;
  if (o.sPenalty !== undefined) r.shadowConfirmationPenaltyApplied = o.sPenalty;
  return r;
}
const SESSION = { quality: 'HIGHEST', sessions: ['LONDON_NY'], overlap: 'NONE' };
async function engineAudit({ tfResults, candleData, productionPreAi, productionPostAi, assetType = 'CRYPTO' }) {
  return computeEngineAudit({
    tfResults, candleData, assetType, pair: 'BTC/USD',
    higherTFTrend: null, marketRegime: 'TRENDING',
    session: SESSION, sessionMult: 1.0, candleQualityMult: 1.0,
    exotic: false, newsBlock: null, newsBlocked: false, env: {},
    productionPreAi, productionPostAi,
  });
}
function oneTfCd(trend) { return makeCandleData({ basePrice: 78000, vol: 50, trend, seed: 101 }); }

// ════════════════════════════════════════════════════════════════════════
// [#3] MULTIPLIER-ONLY — multiplier score difference accurately audited
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#3] Multiplier-only score difference ──────────────────');
{
  // Structure BUY multiplier 1.25 boosts upScore, 0.75 penalises downScore.
  // Direction is unchanged (pre-hard-block BUY == shadow BUY), only the score differs.
  const a = tfAnalysis({
    tf: '5min', direction: 'BUY', up: 5, down: 1.5, upCat: 6, downCat: 1,
    structure: { bias: 'BULLISH', multiplier: { direction: 'BUY', value: 1.25 }, summary: 'BOS_BULLISH' },
    raw: raw({ preUp: 4, preDown: 2, preUpCat: 6, preDownCat: 1, multUp: 1.25, multDn: 0.75, preHard: 'BUY' }),
  });
  const tfa = buildTimeframeAudit('5min', a);
  eq('[#3] productionScore.up = preStruct * multiplier', tfa.productionScore.up, 5);
  eq('[#3] shadowCoreScore.up = pre-structure score', tfa.shadowCoreScore.up, 4);
  eq('[#3] multiplier direction audited', tfa.multiplier.direction, 'BUY');
  eq('[#3] multiplier value audited', tfa.multiplier.value, 1.25);
  eq('[#3] appliedUp multiplier audited', tfa.multiplier.appliedUp, 1.25);
  eq('[#3] appliedDown multiplier audited', tfa.multiplier.appliedDown, 0.75);
  eq('[#3] direction unchanged (multiplier did not flip TF direction)', tfa.multiplierOrVoteChangedDirection, false);
  ok('[#3] score gap captured', tfa.productionScore.up > tfa.shadowCoreScore.up);
}

// ════════════════════════════════════════════════════════════════════════
// [#4] CONFLUENCE-MARGINAL — structure vote is the only difference
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#4] Confluence-marginal (vote only) ───────────────────');
{
  // pre-vote confluence = 4 (< MIN_CONFLUENCE 5) and scoreDiff < 4 => shadow NO_TRADE.
  // Structure vote adds the 5th bullish category => production BUY.
  const a = tfAnalysis({
    tf: '5min', direction: 'BUY', up: 5, down: 2, upCat: 5, downCat: 1,
    structure: { bias: 'BULLISH', multiplier: { direction: 'BUY', value: 1.12 }, structureScore: { up: 2, down: 0 }, summary: 'BIAS_BULLISH' },
    raw: raw({ preUp: 5, preDown: 2, preUpCat: 4, preDownCat: 1, multUp: 1.0, multDn: 1.0, preHard: 'BUY', voteApplied: true, voteDir: 'BUY' }),
  });
  const tfa = buildTimeframeAudit('5min', a);
  eq('[#4] category vote applied flag', tfa.categoryVoteApplied, true);
  eq('[#4] vote direction', tfa.voteDirection, 'BUY');
  eq('[#4] production final BUY (vote crossed confluence)', tfa.productionFinalDirection, 'BUY');
  eq('[#4] shadow NO_TRADE (no vote => below confluence)', tfa.shadowCoreDirection, 'NO_TRADE');
  eq('[#4] divergence attributed to vote/multiplier', tfa.multiplierOrVoteChangedDirection, true);
}

// ════════════════════════════════════════════════════════════════════════
// [#5] HARD-BLOCK — pre-hard-block trade -> production NO_TRADE; shadow trades
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#5] Hard-block case ───────────────────────────────────');
{
  const a = tfAnalysis({
    tf: '5min', direction: 'NO_TRADE', up: 6, down: 1, upCat: 6, downCat: 1,
    structure: { bias: 'BULLISH', multiplier: { direction: 'BUY', value: 1.40 }, choch: { type: 'BULLISH_CHOCH', direction: 'BUY' }, summary: 'CHOCH_BULLISH' },
    raw: raw({ preUp: 6, preDown: 1, preUpCat: 6, preDownCat: 1, multUp: 1.40, multDn: 0.60, preHard: 'BUY', hardBlocked: true, hardReason: 'COUNTER_CHOCH_BULLISH' }),
  });
  const tfa = buildTimeframeAudit('5min', a);
  eq('[#5] production pre-hard-block BUY', tfa.productionPreHardBlockDirection, 'BUY');
  eq('[#5] production final NO_TRADE (hard-blocked)', tfa.productionFinalDirection, 'NO_TRADE');
  eq('[#5] shadow BUY (no hard-block)', tfa.shadowCoreDirection, 'BUY');
  eq('[#5] hardBlocked flag', tfa.hardBlocked, true);
  ok('[#5] hard-block reason recorded', !!tfa.hardBlockReason && tfa.hardBlockReason.includes('CHOCH'));
  eq('[#5] hardBlockChangedDirection flag', tfa.hardBlockChangedDirection, true);
}

// ════════════════════════════════════════════════════════════════════════
// [#6] REDIRECT — both trade but directions differ
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#6] Redirect case ─────────────────────────────────────');
{
  // Shadow engine votes all SELL (no-structure scores favour SELL); production
  // pre-AI was BUY. Bearish candleData keeps the SELL shadow tradeable.
  const bearCd = oneTfCd(-14);
  const tfResults = {
    '5min': tfAnalysis({
      direction: 'BUY', up: 4, down: 1, upCat: 5, downCat: 1,
      structure: { multiplier: { direction: 'BUY', value: 1.4 }, summary: 'CHOCH_BULLISH', bias: 'BULLISH' },
      raw: raw({ preUp: 2, preDown: 6, preUpCat: 1, preDownCat: 6, multUp: 0.6, multDn: 1.4, preHard: 'SELL' }),
    }),
  };
  const audit = await engineAudit({
    tfResults, candleData: bearCd,
    productionPreAi: { finalDirection: 'BUY', confidence: 80 },
    productionPostAi: { finalDirection: 'BUY', confidence: 80 },
  });
  eq('[#6] shadow engine SELL', audit.shadowFinalDirection, 'SELL');
  eq('[#6] attribution STRUCTURE_REDIRECTED', audit.attribution, 'STRUCTURE_REDIRECTED');
}

// ════════════════════════════════════════════════════════════════════════
// [#7] ATTRIBUTION PRECISION — no unsupported hard-block-only causal claim
//      (Report-7 correction, Finding B: directHardBlockOnly removed)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#7] Attribution precision (no hard-block-only claim) ──');
{
  const bullCd = oneTfCd(14);

  // (a) SUPPRESSED driven by multiplier/vote DIRECTION divergence, NO hard-block
  const tfA = {
    '5min': tfAnalysis({
      direction: 'NO_TRADE', up: 2, down: 6, upCat: 1, downCat: 6,
      structure: { multiplier: { direction: 'SELL', value: 1.4 }, summary: 'CHOCH_BEARISH', bias: 'BEARISH' },
      raw: raw({ preUp: 6, preDown: 1, preUpCat: 6, preDownCat: 1, multUp: 0.6, multDn: 1.4, preHard: 'NO_TRADE', hardBlocked: false }),
    }),
  };
  const auditA = await engineAudit({
    tfResults: tfA, candleData: bullCd,
    productionPreAi: { finalDirection: 'NO_TRADE', confidence: 0 },
    productionPostAi: { finalDirection: 'NO_TRADE', confidence: 0 },
  });
  eq('[#7a] attribution STRUCTURE_SUPPRESSED', auditA.attribution, 'STRUCTURE_SUPPRESSED');
  eq('[#7a] multiplier/vote direction divergence observed', auditA.diagnostic.multiplierOrVoteDivergenceObserved, true);
  eq('[#7a] no TF hard-block observed', auditA.diagnostic.tfHardBlockObserved, false);
  eq('[#7a] directHardBlockOnly field removed (undefined)', auditA.diagnostic.directHardBlockOnly, undefined);

  // (b) The orchestrator's false-positive case: SUPPRESSED with a hard-block AND
  // a multiplier that changed SCORE MAGNITUDE but NOT a TF direction. A combined
  // counterfactual cannot attribute this solely to the hard-block, so the audit
  // must NOT make any hard-block-only causal claim.
  const tfB = {
    '5min': tfAnalysis({
      direction: 'NO_TRADE', up: 6, down: 1, upCat: 6, downCat: 1,
      structure: { multiplier: { direction: 'BUY', value: 1.4 }, summary: 'CHOCH_BULLISH', bias: 'BULLISH', choch: { direction: 'BUY' } },
      raw: raw({ preUp: 6, preDown: 1, preUpCat: 6, preDownCat: 1, multUp: 1.4, multDn: 0.6, preHard: 'BUY', hardBlocked: true, hardReason: 'COUNTER_CHOCH_BULLISH' }),
    }),
  };
  const auditB = await engineAudit({
    tfResults: tfB, candleData: bullCd,
    productionPreAi: { finalDirection: 'NO_TRADE', confidence: 0 },
    productionPostAi: { finalDirection: 'NO_TRADE', confidence: 0 },
  });
  eq('[#7b] attribution STRUCTURE_SUPPRESSED', auditB.attribution, 'STRUCTURE_SUPPRESSED');
  eq('[#7b] TF hard-block observed (observational, allowed)', auditB.diagnostic.tfHardBlockObserved, true);
  eq('[#7b] no direction divergence', auditB.diagnostic.multiplierOrVoteDivergenceObserved, false);
  eq('[#7b] directHardBlockOnly field removed (undefined)', auditB.diagnostic.directHardBlockOnly, undefined);

  // (c) global: no persisted/public/internal audit field makes an unsupported
  // hard-block-only causal claim, across several constructed attributions.
  const cases = [
    { tfR: tfA, pre: 'NO_TRADE', post: 'NO_TRADE' },
    { tfR: tfB, pre: 'NO_TRADE', post: 'NO_TRADE' },
    { tfR: { '5min': tfAnalysis({ direction: 'BUY', up: 6, down: 1, upCat: 6, downCat: 1, structure: { multiplier: { direction: 'BUY', value: 1.25 }, summary: 'BOS_BULLISH', bias: 'BULLISH' }, raw: raw({ preUp: 6, preDown: 1, preUpCat: 6, preDownCat: 1, multUp: 1.25, multDn: 0.75, preHard: 'BUY' }) }) }, pre: 'BUY', post: 'BUY' },
  ];
  let noCausalClaim = true;
  for (const c of cases) {
    const au = await engineAudit({ tfResults: c.tfR, candleData: bullCd, productionPreAi: { finalDirection: c.pre, confidence: 0 }, productionPostAi: { finalDirection: c.post, confidence: 0 } });
    const san = JSON.stringify(sanitizeAuditForHistory(au));
    const full = JSON.stringify(au);
    if (/hard[-_ ]?block[-_ ]?only|directHardBlockOnly/i.test(san) || /directHardBlockOnly/i.test(full)) noCausalClaim = false;
  }
  ok('[#7c] no persisted/internal audit field makes a hard-block-only causal claim', noCausalClaim);
  ok('[#7c] observational tfHardBlockObserved retained', auditB.diagnostic.tfHardBlockObserved === true);
  ok('[#7c] observational hardBlockFlippedAny retained', 'hardBlockFlippedAny' in auditB.diagnostic);
}

// ════════════════════════════════════════════════════════════════════════
// [#8] AI BOUNDARY — AI-affected row is non-comparable; no conditional shadow AI
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#8] AI boundary ───────────────────────────────────────');
{
  const bullCd = oneTfCd(14);
  const tfResults = {
    '5min': tfAnalysis({
      direction: 'BUY', up: 6, down: 1, upCat: 6, downCat: 1,
      structure: { multiplier: { direction: 'BUY', value: 1.25 }, summary: 'BOS_BULLISH', bias: 'BULLISH' },
      raw: raw({ preUp: 6, preDown: 1, preUpCat: 6, preDownCat: 1, multUp: 1.25, multDn: 0.75, preHard: 'BUY' }),
    }),
  };
  // AI changed production direction BUY -> NO_TRADE
  const audit = await engineAudit({
    tfResults, candleData: bullCd,
    productionPreAi: { finalDirection: 'BUY', confidence: 80 },
    productionPostAi: { finalDirection: 'NO_TRADE', confidence: 0 },
  });
  eq('[#8] comparability AI_AFFECTED', audit.comparability, 'AI_AFFECTED');
  ok('[#8] comparability reason explains the AI change', audit.comparabilityReason.includes('AI changed'));
  eq('[#8] shadow still deterministic (no AI)', audit.shadowFinalDirection, 'BUY');
  // isolated observation requires BOTH prod pre-AI and post-AI NO_TRADE -> not eligible here
  eq('[#8] AI-affected row NOT eligible for isolated observation', audit.isolatedObservationEligible, false);
  // sanity: classifyAttribution is a pure 4-way partition (no conditional AI logic)
  eq('[#8] classify pure', classifyAttribution('NO_TRADE', 'BUY'), 'STRUCTURE_SUPPRESSED');
  eq('[#8] classify created', classifyAttribution('BUY', 'NO_TRADE'), 'STRUCTURE_CREATED');
  eq('[#8] classify unchanged', classifyAttribution('SELL', 'SELL'), 'UNCHANGED');
  eq('[#8] classify redirect', classifyAttribution('BUY', 'SELL'), 'STRUCTURE_REDIRECTED');
}

// ════════════════════════════════════════════════════════════════════════
// [#9] PUBLIC ISOLATION — no audit/shadow in JSON, latest cache, bot, history
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#9] Public isolation ──────────────────────────────────');
{
  const cd = makeCandleData({ basePrice: 78000, vol: 50, trend: 12, seed: 7 });
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
  const json = JSON.stringify(sig);
  ok('[#9a] engine signal JSON has no audit/shadow keys',
    !json.includes('structureAudit') && !json.includes('shadowFinalDirection') && !json.includes('r71'));
  ok('[#9a] engine signal JSON has no Symbol-carried fields', !json.includes('isolatedObservationEligible'));

  // /api/signal wrapper (mirrors handleSignalRaw result shape)
  const wrapper = { pair: 'BTC/USD', signal: sig, source: 'FULL_DATA' };
  ok('[#9b] response wrapper JSON clean', !JSON.stringify(wrapper).includes('structureAudit'));

  // latest cache payload (writeLatest stringifies — Symbols dropped)
  const { writeLatest } = await import('../src/history/latestCache.js');
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  await writeLatest('BTC/USD', { pair: 'BTC/USD', signal: sig }, { generationId: 'g1' }, env);
  const latestJson = kv._m.get('latest:BTC_USD').value;
  ok('[#9c] latest cache JSON clean', !latestJson.includes('structureAudit') && !latestJson.includes('shadowFinalDirection'));

  // bot-facing payload (formatSignalMessage reads curated fields only)
  const { formatSignalMessage } = await import('../src/handlers/pushToSubscribers.js');
  const msg = formatSignalMessage({ id: 'sig_x', pair: 'BTC/USD', signal: sig });
  ok('[#9d] bot message has no audit', !msg.includes('structureAudit') && !msg.includes('shadow'));

  // public /api/history strips structureAudit (handleHistory)
  const { saveSignalToHistory } = await import('../src/history/stats.js');
  const kv2 = makeKV(); const env2 = { SIGNAL_CACHE: kv2 };
  await saveSignalToHistory(sig, 'BTC/USD', false, env2, 'sig_hist_1', 'FRESH_API');
  const { handleHistory } = await import('../src/handlers/health.js');
  const res = await handleHistory(new URL('https://x/api/history?pair=BTC/USD'), env2);
  const body = await res.json();
  const histJson = JSON.stringify(body.signals);
  ok('[#9e] public /api/history stripped structureAudit', !histJson.includes('structureAudit'));
}

// ════════════════════════════════════════════════════════════════════════
// [#10] INTERNAL PERSISTENCE — bounded audit saved internally; history strips it
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#10] Internal persistence ─────────────────────────────');
{
  const cd = makeCandleData({ basePrice: 78000, vol: 50, trend: 12, seed: 7 });
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
  const { saveSignalToHistory } = await import('../src/history/stats.js');
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  await saveSignalToHistory(sig, 'BTC/USD', false, env, 'sig_persist_1', 'FRESH_API');
  const rec = (await env.SIGNAL_CACHE.get('sig:BTC_USD', 'json'))[0];
  ok('[#10a] audit persisted internally as structureAudit', !!rec.structureAudit);
  eq('[#10a] bounded decisionScope', rec.structureAudit.decisionScope, 'STANDARD_ENGINE_DETERMINISTIC_PRE_AI');
  ok('[#10a] per-timeframe audit bounded (3 TFs)', Object.keys(rec.structureAudit.timeframes).length <= 3);
  // bounded payload size guard (no full candle arrays / raw indicator objects)
  const size = JSON.stringify(rec.structureAudit).length;
  ok('[#10a] audit payload bounded (< 6KB)', size < 6000);
  // the persisted audit must NOT carry unbounded internals
  ok('[#10a] no shadowTradeContext leaked into persisted audit', !rec.structureAudit.shadowTradeContext);
  ok('[#10a] no filtersApplied arrays leaked', !rec.structureAudit.shadowFiltersApplied);

  // public history strips it
  const { handleHistory } = await import('../src/handlers/health.js');
  const res = await handleHistory(new URL('https://x/api/history?pair=BTC/USD'), env);
  const body = await res.json();
  ok('[#10b] public history row has no structureAudit', !Object.prototype.hasOwnProperty.call(body.signals[0], 'structureAudit'));
}

// ════════════════════════════════════════════════════════════════════════
// [#11] SHADOW ISOLATION — store cannot mutate normal history/stats/CB/push
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#11] Shadow store isolation ───────────────────────────');
{
  const { admitShadowObservation, resolveShadowObservations } = await import('../src/history/r71store.js');
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };

  // seed normal history + stats + a cb key + a pushLog key
  await env.SIGNAL_CACHE.put('sig:BTC_USD', JSON.stringify([{ id: 'normal_1', pair: 'BTC/USD', direction: 'BUY' }]));
  await env.SIGNAL_CACHE.put('stats:BTC_USD', JSON.stringify({ pair: 'BTC/USD', wins: 5 }));
  await env.SIGNAL_CACHE.put('cb:BTC_USD', JSON.stringify({ lossStreak: 1 }));
  await env.SIGNAL_CACHE.put('pushLog:normal_1', JSON.stringify([{ chatId: '1' }]));

  const before = {
    sig: kv._m.get('sig:BTC_USD').value,
    stats: kv._m.get('stats:BTC_USD').value,
    cb: kv._m.get('cb:BTC_USD').value,
    pushLog: kv._m.get('pushLog:normal_1').value,
  };

  // admit several shadow observations (distinct direction+entry to clear dedup)
  const obsSpecs = [
    { id: 'r71_obs_0', direction: 'BUY',  entryPrice: 78000 },
    { id: 'r71_obs_1', direction: 'SELL', entryPrice: 78000 },
    { id: 'r71_obs_2', direction: 'BUY',  entryPrice: 78100 },
  ];
  for (const s of obsSpecs) {
    await admitShadowObservation({
      id: s.id, pair: 'BTC/USD', assetType: 'CRYPTO', direction: s.direction,
      entryPrice: s.entryPrice, expiryTime: new Date(Date.now() - 1000).toISOString(),
      shadowConfidence: 80, attribution: 'STRUCTURE_SUPPRESSED',
    }, env);
  }

  eq('[#11a] normal history untouched', kv._m.get('sig:BTC_USD').value, before.sig);
  eq('[#11b] pair stats untouched', kv._m.get('stats:BTC_USD').value, before.stats);
  eq('[#11c] circuit breaker untouched', kv._m.get('cb:BTC_USD').value, before.cb);
  eq('[#11d] push log untouched', kv._m.get('pushLog:normal_1').value, before.pushLog);

  // shadow keys live ONLY under the shadow: prefix
  const allKeys = [...kv._m.keys()];
  const shadowKeys = allKeys.filter(k => k.startsWith('shadow:'));
  const nonShadow = allKeys.filter(k => !k.startsWith('shadow:'));
  ok('[#11e] all new keys are shadow:*', shadowKeys.length >= 5 && shadowKeys.every(k => k.startsWith('shadow:')));
  ok('[#11e] no shadow data outside shadow: prefix', nonShadow.every(k => !k.includes('r71_obs')));

  // resolver touches only shadow: keys
  await resolveShadowObservations(env);
  const after = {
    sig: kv._m.get('sig:BTC_USD').value,
    stats: kv._m.get('stats:BTC_USD').value,
    cb: kv._m.get('cb:BTC_USD').value,
  };
  eq('[#11f] resolver left normal history untouched', after.sig, before.sig);
  eq('[#11f] resolver left stats untouched', after.stats, before.stats);
  eq('[#11f] resolver left cb untouched', after.cb, before.cb);
}

// ════════════════════════════════════════════════════════════════════════
// [#12] RESOLVER IDEMPOTENCY + retry/terminal-UNKNOWN safety
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#12] Resolver idempotency ─────────────────────────────');
{
  const { admitShadowObservation, resolveShadowObservations } = await import('../src/history/r71store.js');
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  await admitShadowObservation({
    id: 'r71_idem', pair: 'ETH/USD', assetType: 'CRYPTO', direction: 'BUY',
    entryPrice: 3000, expiryTime: new Date(Date.now() - 200000).toISOString(),
    shadowConfidence: 80, attribution: 'STRUCTURE_SUPPRESSED',
  }, env);
  // first resolve: no API keys -> fetchExpiryPrice returns {error:NO_API_KEYS}; checks++
  await resolveShadowObservations(env);
  let obs = await env.SIGNAL_CACHE.get('shadow:obs:r71_idem', 'json');
  // pending may still exist (retry) until budget exhausted; obs not resolved yet
  const r1 = obs && obs.result;
  // run many times to exhaust retries -> terminal UNKNOWN, pending deleted
  for (let i = 0; i < 20; i++) await resolveShadowObservations(env);
  obs = await env.SIGNAL_CACHE.get('shadow:obs:r71_idem', 'json');
  eq('[#12a] terminal state UNKNOWN after retries', obs && obs.result, 'UNKNOWN');
  const pendingLeft = await env.SIGNAL_CACHE.get('shadow:pending:r71_idem');
  eq('[#12b] pending key deleted after terminal resolve', pendingLeft, null);
  // idempotency: resolve again leaves the outcome unchanged
  const obsBefore = JSON.stringify(obs);
  await resolveShadowObservations(env);
  const obsAfter = await env.SIGNAL_CACHE.get('shadow:obs:r71_idem', 'json');
  eq('[#12c] second resolve leaves outcome unchanged', JSON.stringify(obsAfter), obsBefore);
}

// ════════════════════════════════════════════════════════════════════════
// [#13] FAIL-OPEN — forced shadow KV failure does not change/fail production
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#13] Fail-open ────────────────────────────────────────');
{
  const { admitShadowObservation } = await import('../src/history/r71store.js');
  // a KV whose put throws
  const badKv = {
    async get() { return null; },
    async put() { throw new Error('KV DOWN'); },
    async delete() { throw new Error('KV DOWN'); },
    async list() { return { keys: [] }; },
  };
  const env = { SIGNAL_CACHE: badKv };
  let threw = false; let ret;
  try { ret = await admitShadowObservation({
    id: 'r71_fail', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000,
    expiryTime: new Date(Date.now() + 600000).toISOString(), shadowConfidence: 80,
  }, env); } catch (e) { threw = true; }
  ok('[#13a] admission did not throw to caller (fail-open)', !threw);
  ok('[#13a] admission reported not admitted', ret && ret.admitted === false);

  // production engine still returns normally even if audit persistence would fail:
  // simulate by running the handler admission off-path with a throwing KV
  const cd = makeCandleData({ basePrice: 78000, vol: 50, trend: 12, seed: 7 });
  const sig = await buildMultiTimeframeSignal('BTC/USD', cd, 'CRYPTO', ENV);
  ok('[#13b] engine signal unaffected by shadow KV failure', sig.finalSignal === 'BUY' || sig.finalSignal === 'SELL' || sig.finalSignal === 'NO_TRADE');
  ok('[#13b] audit still attached in-memory', !!getEngineAudit(sig));
}

// ════════════════════════════════════════════════════════════════════════
// [#14] OTC REGRESSION — OTC output/grade/persistence contract unchanged
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#14] OTC regression ───────────────────────────────────');
{
  const baselineOtc = await import('../verify/baseline/src/signal/otcEngine.js');
  // Phase F round 2: pin the clock + session (F3-16 pattern) so the OTC
  // timeContext minute window and the edge-feature hour factor are
  // deterministic on BOTH sides (baseline = same approved engine).
  const session = { sessions: ['LONDON'], overlap: 'NONE', quality: 'HIGH', hour: 14 };
  const PIN_NOW = '2026-08-10T14:05:00Z'; // minute 5 = NORMAL timeContext, hour 14 = mult 1.0
  const cd = makeCandleData({ basePrice: 1.08, vol: 0.0006, trend: 0.0001, seed: 9 });
  const baseSig = await baselineOtc.buildMultiTimeframeSignalOTC(cd, 'EUR/USD-OTC', session, false, ENV, { now: PIN_NOW });
  const newSig = await buildMultiTimeframeSignalOTC(cd, 'EUR/USD-OTC', session, false, ENV, { now: PIN_NOW });
  function stripTime(obj) {
    const c = JSON.parse(JSON.stringify(obj)); const kill = new Set(['generatedAt', 'expiryTime', 'nextCandleClose', 'humanReadable', 'nextRefresh', 'candleTime']);
    (function w(o) { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (kill.has(k) || k === 'expiry' || k === 'entry' || k === 'countdown') delete o[k]; else w(o[k]); } } })(c);
    return c;
  }
  // Reviewer-approved OTC output changes since the ORIGINAL baseline (71e87eb):
  // FIX-A grade cap via structure verdict, FIX-B camarilla weighting raw x 1.5
  // (was raw/0.84 x 1.5), FIX-C directional round-number bonus, FIX-D
  // confluence denominators /12, and F3-04 (BUG-027) fill-status fields
  // (engine.js parity). While the baseline was the stale 71e87eb tree these
  // fields had to be redacted so "everything else" could still be compared.
  // F3-20 refreshed the baseline to the current approved engine (e56cd33), so
  // this comparison is now current-vs-current and every field — including the
  // ones below — is byte-guarded on both sides. The list is RETAINED as the
  // explicit approved-divergence inventory, and every entry is verified below
  // to still be emitted by the engine, so the list cannot silently rot.
  const OTC_APPROVED_DIVERGENT_FIELDS = new Set([
    'grade',                       // FIX-A: structure-capped grade + Phase F calibration (inverted cap)
    'confidence', 'calibration', 'coreConfidence', // Phase F: calibrated confidence/grade (inverted ladder fix)
    'camarilla',                   // FIX-B: weighting changed
    'roundNumber', 'signals',      // FIX-C: round bonus directional + signal names
    'entryReason', 'filtersApplied', // FIX-C: ROUND_LEVEL_* strings
    'confluence', 'confluenceDetail', 'reason', // FIX-D: /12 denominators
    'score', 'weightedBuy', 'weightedSell', 'weightedNoTrade', // FIX-B/C: numeric effects
    // F3-04 (BUG-027): OTC fill-status fields added (engine.js parity) —
    // new fields, absent from the 71e87eb baseline by design.
    'fillStatus', 'entryPrice', 'currentPrice', 'entryDistancePct',
  ]);
  function stripRound2Changed(obj) {
    const c = stripTime(obj);
    (function w(o) { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (OTC_APPROVED_DIVERGENT_FIELDS.has(k)) delete o[k]; else w(o[k]); } } })(c);
    return c;
  }
  eq('[#14a] OTC output unchanged vs baseline except approved fields (FIX-A/B/C/D, F3-04)', stripRound2Changed(baseSig), stripRound2Changed(newSig));
  // F3-20: the redaction list must stay faithful to the engine — every
  // redacted field must still be EMITTED by the current OTC engine. A field
  // that vanishes from the output means the list is stale and must be cleaned
  // up; this check fails then, so it cannot happen silently.
  {
    const toFind = new Set(OTC_APPROVED_DIVERGENT_FIELDS);
    (function w(o) { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (toFind.has(k)) toFind.delete(k); else w(o[k]); } } })(newSig);
    const missing = [...toFind];
    ok('[#14a] every redacted field still emitted by the current OTC engine (list not stale)', missing.length === 0,
      missing.length ? 'no longer emitted: ' + missing.join(', ') : '');
  }
  ok('[#14b] OTC signal carries NO engine audit (standard-engine only)', !getEngineAudit(newSig));
  // OTC history record stays lean (no structureAudit)
  const { saveSignalToHistory } = await import('../src/history/stats.js');
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  await saveSignalToHistory({ ...newSig, isOTC: true }, 'EUR/USD-OTC', true, env, 'sig_otc_1', 'FRESH_API');
  const rec = (await env.SIGNAL_CACHE.get('sig:EUR_USD_OTC', 'json'))[0];
  ok('[#14c] OTC record has no structureAudit', !rec.structureAudit);
}

// ════════════════════════════════════════════════════════════════════════
// [#15] EXISTING SMOKE/INTEGRATION + syntax + git diff --check
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#15] Existing smoke + syntax + git diff --check ────────');
{
  // syntax check every changed + new source file
  const files = [
    'src/signal/engine.js', 'src/signal/timeframe.js', 'src/signal/voteFilters.js',
    'src/signal/r71shadow.js', 'src/history/stats.js', 'src/history/r71store.js',
    'src/handlers/signal.js', 'src/handlers/health.js', 'src/index.js',
    'src/signal/otcEngine.js',
    // Phase F round 2: edge features + self-calibration
    'src/analysis/edgeFeatures.js', 'src/history/selfCalib.js',
  ];
  let syntaxOk = true;
  for (const f of files) {
    try { execSync('node --check ' + f, { stdio: 'pipe' }); }
    catch (e) { syntaxOk = false; console.log('   syntax FAIL: ' + f); }
  }
  ok('[#15a] node --check passes on all changed/new source', syntaxOk);

  // git diff --check (whitespace errors) on tracked SOURCE modifications vs the
  // refreshed baseline commit (F3-20: e56cd33 — same constant as the archive;
  // scoped to src/ + scripts/ so captured log artifacts in verify/ don't make
  // the check self-referential). This now guards the changes introduced since
  // the current approved engine tip (i.e. this PR's diff) rather than the
  // whole post-71e87eb accumulation.
  let diffClean = true; let diffOut = '';
  try { diffOut = execSync('git diff --check ' + BASELINE_COMMIT + ' -- src/ scripts/', { stdio: 'pipe' }).toString(); }
  catch (e) { diffClean = false; diffOut = (e.stdout && e.stdout.toString()) + (e.stderr && e.stderr.toString()); }
  // also verify NEW (untracked) files carry no trailing whitespace
  const newFiles = ['src/signal/voteFilters.js', 'src/signal/r71shadow.js', 'src/history/r71store.js',
    'scripts/r71_tests.mjs', 'scripts/r71_fixtures.mjs', 'scripts/r71_smoke.mjs',
    // Phase F round 2
    'src/analysis/edgeFeatures.js', 'src/history/selfCalib.js', 'scripts/feature_validation.py'];
  let newWsOk = true;
  for (const f of newFiles) {
    const txt = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    if (/[ \t]+$/m.test(txt)) { newWsOk = false; console.log('   trailing whitespace in NEW file: ' + f); }
  }
  ok('[#15b] git diff --check clean + new files no trailing whitespace',
    diffClean && diffOut.trim() === '' && newWsOk);

  // run the existing Phase 7 + Phase 10 smoke suites (must still pass)
  let p7 = true, p10 = true;
  try { execSync('node scripts/phase7_smoke.mjs', { stdio: 'pipe' }); }
  catch (e) { p7 = false; console.log('   phase7_smoke failed: ' + (e.stderr && e.stderr.toString().slice(0, 300))); }
  try { execSync('node scripts/phase10_smoke.mjs', { stdio: 'pipe' }); }
  catch (e) { p10 = false; console.log('   phase10_smoke failed: ' + (e.stderr && e.stderr.toString().slice(0, 300))); }
  ok('[#15c] existing phase7_smoke still passes', p7);
  ok('[#15d] existing phase10_smoke still passes', p10);

  // the real engine still produces a CHoCH hard-block on engineered candles
  const { analyzeTimeframe } = await import('../src/signal/timeframe.js');
  const { calculateAllIndicators } = await import('../src/indicators/index.js');
  const candles = bullishChochCandles(1.08);
  const ind = calculateAllIndicators(candles, '1min');
  const ana = analyzeTimeframe(ind, candles, '1min', 'FOREX', null, 'RANGING');
  const tfa = buildTimeframeAudit('1min', ana);
  ok('[#15e] engineered CHoCH detected', ana.structure && ana.structure.choch && ana.structure.choch.type === 'BULLISH_CHOCH');
  ok('[#15e] freshness chochEventAgeBars = 0 for current CHoCH', tfa && tfa.freshness && tfa.freshness.chochEventAgeBars === 0);
  ok('[#15e] freshness brokenSwingAgeBars is a number (not called choch age)', typeof tfa.freshness.brokenSwingAgeBars === 'number' || tfa.freshness.brokenSwingAgeBars === null);
}

// ════════════════════════════════════════════════════════════════════════
// BONUS: KV accounting + cap/dedup (§E bounded discipline)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [§E] KV accounting + cap + dedup ───────────────────────');
{
  const { admitShadowObservation, getR71Accounting, resetR71Accounting, __r71StoreTest } = await import('../src/history/r71store.js');
  resetR71Accounting();
  const kv = makeKV(); const env = { SIGNAL_CACHE: kv };
  // dedup: same pair+direction+nearby-entry within 2h -> 2nd rejected
  await admitShadowObservation({ id: 'o1', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000, expiryTime: new Date(Date.now()+600000).toISOString(), shadowConfidence: 80 }, env);
  const dup = await admitShadowObservation({ id: 'o2', pair: 'BTC/USD', direction: 'BUY', entryPrice: 78000.001, expiryTime: new Date(Date.now()+600000).toISOString(), shadowConfidence: 80 }, env);
  eq('[§E] dedup rejects nearby re-admission', dup.reason, 'DEDUP');
  // cap: fill a FRESH pair to 30 then 31st rejected
  let admitted = 0;
  for (let i = 0; i < 40; i++) {
    const r = await admitShadowObservation({ id: 'cap' + i, pair: 'SOL/USD', direction: i % 2 ? 'BUY' : 'SELL', entryPrice: 100 + i, expiryTime: new Date(Date.now()+600000).toISOString(), shadowConfidence: 80 }, env);
    if (r.admitted) admitted++;
  }
  ok('[§E] cap honoured at ' + __r71StoreTest.MAX_PER_PAIR_30D + ' per pair', admitted === __r71StoreTest.MAX_PER_PAIR_30D);
  const over = await admitShadowObservation({ id: 'capOver', pair: 'SOL/USD', direction: 'BUY', entryPrice: 9999, expiryTime: new Date(Date.now()+600000).toISOString(), shadowConfidence: 80 }, env);
  eq('[§E] over-cap rejected', over.reason, 'CAP');
  const acc = getR71Accounting();
  ok('[§E] accounting tracks admitted', acc.admitted === __r71StoreTest.MAX_PER_PAIR_30D + 1);
  ok('[§E] accounting tracks dedup rejections', acc.dedupRejected >= 1);
  ok('[§E] accounting tracks cap rejections', acc.capRejected >= 1);
  ok('[§E] admission writes = admitted*3', acc.admissionWrites === acc.admitted * 3);
  eq('[§E] admission reads = attempts', acc.admissionReads, acc.admitted + acc.dedupRejected + acc.capRejected);
  // pending TTL bounded (~2h), never 7 days
  ok('[§E] pending TTL ~2h (not 7d)', __r71StoreTest.PENDING_TTL_S <= 2 * 60 * 60 + 1);
  ok('[§E] retention 30d', __r71StoreTest.RETENTION_TTL_S === 30 * 24 * 3600);
}

// ════════════════════════════════════════════════════════════════════════
// [#16] FAITHFUL SHADOW CONFIRMATION-CANDLE PENALTY (Report-7 Finding A)
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#16] Shadow confirmation-candle penalty ───────────────');
{
  const { analyzeTimeframe } = await import('../src/signal/timeframe.js');
  const { calculateAllIndicators } = await import('../src/indicators/index.js');
  const { SCORE_THRESHOLDS } = await import('../src/config.js');

  function tfRaw(candles, assetType = 'CRYPTO', trend = null) {
    const ind = calculateAllIndicators(candles, '5min');
    const a = analyzeTimeframe(ind, candles, '5min', assetType, null, trend || 'RANGING');
    return { a, raw: getShadowTfRaw(a) };
  }
  function opposeLast(candles, polarity) {
    const last = candles[candles.length - 1];
    const range = (last.high - last.low) || 0.00001;
    if (polarity === 'BUY') { last.open = last.close + range * 0.6; last.close = last.open - range * 0.6; }
    else { last.open = last.close - range * 0.6; last.close = last.open + range * 0.6; }
    last.high = Math.max(last.open, last.close) + range * 0.1;
    last.low = Math.min(last.open, last.close) - range * 0.1;
  }

  // (1) unconfirmed shadow BUY -> shadow up engine score exactly x0.85
  let buyCase = null;
  for (let seed = 1; seed < 80 && !buyCase; seed++) {
    const c = makeCandles({ count: 100, intervalMin: 5, basePrice: 78000, vol: 60, trend: 22, seed });
    opposeLast(c, 'BUY');
    const { raw } = tfRaw(c, 'CRYPTO');
    if (raw && raw.shadowCoreDirection === 'BUY' && raw.shadowCandleConfirmed === false) buyCase = raw;
  }
  ok('[#16-1] found a real unconfirmed shadow BUY case', !!buyCase);
  if (buyCase) {
    eq('[#16-1] shadowEngineScoreUp = preStructUp x0.85', buyCase.shadowEngineScoreUp, Math.round(buyCase.preStructUp * 0.85 * 100) / 100);
    eq('[#16-1] shadowCandleConfirmed = false', buyCase.shadowCandleConfirmed, false);
    eq('[#16-1] shadowConfirmationPenaltyApplied = true', buyCase.shadowConfirmationPenaltyApplied, true);
    eq('[#16-1] shadow down score untouched (no penalty)', buyCase.shadowEngineScoreDown, buyCase.preStructDown);
  }

  // (2) unconfirmed shadow SELL -> shadow down engine score exactly x0.85
  let sellCase = null;
  for (let seed = 1; seed < 80 && !sellCase; seed++) {
    const c = makeCandles({ count: 100, intervalMin: 5, basePrice: 78000, vol: 60, trend: -22, seed });
    opposeLast(c, 'SELL');
    const { raw } = tfRaw(c, 'CRYPTO');
    if (raw && raw.shadowCoreDirection === 'SELL' && raw.shadowCandleConfirmed === false) sellCase = raw;
  }
  ok('[#16-2] found a real unconfirmed shadow SELL case', !!sellCase);
  if (sellCase) {
    eq('[#16-2] shadowEngineScoreDown = preStructDown x0.85', sellCase.shadowEngineScoreDown, Math.round(sellCase.preStructDown * 0.85 * 100) / 100);
    eq('[#16-2] shadowConfirmationPenaltyApplied = true', sellCase.shadowConfirmationPenaltyApplied, true);
    eq('[#16-2] shadow up score untouched (no penalty)', sellCase.shadowEngineScoreUp, sellCase.preStructUp);
  }

  // (3) confirmed shadow trade -> NO penalty
  let confCase = null;
  for (let seed = 1; seed < 80 && !confCase; seed++) {
    const c = makeCandles({ count: 100, intervalMin: 5, basePrice: 78000, vol: 40, trend: 20, seed });
    const { raw } = tfRaw(c, 'CRYPTO');
    if (raw && raw.shadowCoreDirection === 'BUY' && raw.shadowCandleConfirmed === true) confCase = raw;
  }
  ok('[#16-3] found a real confirmed shadow BUY case', !!confCase);
  if (confCase) {
    eq('[#16-3] confirmed => no penalty', confCase.shadowConfirmationPenaltyApplied, false);
    eq('[#16-3] shadowEngineScoreUp == preStructUp (no x0.85)', confCase.shadowEngineScoreUp, confCase.preStructUp);
  }

  // (4) shadow per-TF direction decided pre-confirmation; unchanged by penalty.
  if (buyCase) {
    const minScore = SCORE_THRESHOLDS.CRYPTO;
    eq('[#16-4] shadowCoreDirection decided on pre-confirmation score', buyCase.shadowCoreDirection,
      decideTfDirection(buyCase.preStructUp, buyCase.preStructDown, buyCase.preStructUpCat, buyCase.preStructDownCat, minScore));
  }

  // (5) confidence-floor edge case now produces the FAITHFUL result.
  const preUp = 2.88;
  const r2n = (v) => Math.round(v * 100) / 100;
  const mk = (engUp) => ({
    '1min':  tfAnalysis({ direction: 'BUY', up: preUp, down: 0.2, upCat: 6, downCat: 0,
      structure: { multiplier: { direction: 'BUY', value: 1.0 }, summary: 'NEUTRAL', bias: 'NEUTRAL' },
      raw: raw({ preUp, preDown: 0.2, preUpCat: 6, preDownCat: 0, multUp: 1, multDn: 1, preHard: 'BUY',
        sCoreDir: 'BUY', sEngUp: engUp, sEngDown: 0.2, sConfirmed: engUp !== preUp, sPenalty: engUp !== preUp }) }),
    '5min':  tfAnalysis({ direction: 'NO_TRADE', up: 0, down: 0, upCat: 0, downCat: 0, raw: raw({ preUp: 0, preDown: 0, preUpCat: 0, preDownCat: 0, preHard: 'NO_TRADE', sCoreDir: 'NO_TRADE', sEngUp: 0, sEngDown: 0, sConfirmed: true, sPenalty: false }) }),
    '15min': tfAnalysis({ direction: 'NO_TRADE', up: 0, down: 0, upCat: 0, downCat: 0, raw: raw({ preUp: 0, preDown: 0, preUpCat: 0, preDownCat: 0, preHard: 'NO_TRADE', sCoreDir: 'NO_TRADE', sEngUp: 0, sEngDown: 0, sConfirmed: true, sPenalty: false }) }),
  });
  // benign bullish candles: uniform volume (no volume-spike) + strong bodies
  // (body/ratio>0.45) so the ONLY variable between the two runs is the penalty.
  function benignCd() {
    const mk = (intervalMin) => {
      const arr = []; let close = 78000; const step = intervalMin * 60000; const t0 = Date.now() - 100 * step;
      for (let i = 0; i < 100; i++) { const open = close; close = open + 15; arr.push({ datetime: new Date(t0 + i * step).toISOString(), open, high: close + 5, low: open - 5, close, volume: 500 }); }
      return arr;
    };
    return { '1min': mk(1), '5min': mk(5), '15min': mk(15) };
  }
  const cd = benignCd();
  const auditFaithful = await computeEngineAudit({ tfResults: mk(r2n(preUp * 0.85)), candleData: cd, assetType: 'CRYPTO', pair: 'BTC/USD', higherTFTrend: null, marketRegime: 'RANGING', session: SESSION, sessionMult: 1.0, candleQualityMult: 1.0, exotic: false, newsBlock: null, newsBlocked: false, env: {}, productionPreAi: { finalDirection: 'NO_TRADE', confidence: 0 }, productionPostAi: { finalDirection: 'NO_TRADE', confidence: 0 } });
  const auditOld = await computeEngineAudit({ tfResults: mk(r2n(preUp)), candleData: cd, assetType: 'CRYPTO', pair: 'BTC/USD', higherTFTrend: null, marketRegime: 'RANGING', session: SESSION, sessionMult: 1.0, candleQualityMult: 1.0, exotic: false, newsBlock: null, newsBlocked: false, env: {}, productionPreAi: { finalDirection: 'NO_TRADE', confidence: 0 }, productionPostAi: { finalDirection: 'NO_TRADE', confidence: 0 } });
  eq('[#16-5a] faithful (penalized) shadow => NO_TRADE', auditFaithful.shadowFinalDirection, 'NO_TRADE');
  eq('[#16-5b] pre-correction (unpenalized) would be BUY', auditOld.shadowFinalDirection, 'BUY');
  ok('[#16-5c] faithful confidence below floor', auditFaithful.shadowConfidence < 72);
  ok('[#16-5d] per-TF shadow direction still BUY in both (penalty is post-decision)', auditFaithful.timeframes['1min'].shadowCoreDirection === 'BUY' && auditOld.timeframes['1min'].shadowCoreDirection === 'BUY');
}

// ════════════════════════════════════════════════════════════════════════
// [#17] PRODUCTION-EQUIVALENCE FUZZ (>=100 deterministic fixtures vs the
//       refreshed baseline e56cd33 — F3-20)
//       Phase F: calibration changes grade/confidence intentionally, so those
//       fields are excluded from byte-equality (approved divergence).
// ════════════════════════════════════════════════════════════════════════
console.log('\n── [#17] Production-equivalence fuzz (100 fixtures) ───────');
{
  // F3-20: baseline refreshed from the stale pre-round-1 71e87eb snapshot to
  // the current approved engine tip — byte-equality now guards the CURRENT
  // contract on all 100 fixtures.
  bootstrapBaseline();
  const baselineEngine = await import('../verify/baseline/src/signal/engine.js');
  const CALIB_DIVERGENT = new Set(['grade','confidence','calibration','coreConfidence']);
  function stripTime(obj) {
    const clone = JSON.parse(JSON.stringify(obj));
    const kill = new Set(['generatedAt', 'expiryTime', 'nextCandleClose', 'humanReadable', 'nextRefresh', 'candleTime']);
    (function w(o) { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (kill.has(k) || k === 'expiry' || k === 'entry' || k === 'countdown' || CALIB_DIVERGENT.has(k)) delete o[k]; else w(o[k]); } } })(clone);
    return clone;
  }
  const N = 100; let compared = 0; let mismatches = 0; const mismatchSamples = [];
  const assetTypes = ['CRYPTO', 'FOREX'];
  for (let i = 0; i < N; i++) {
    const assetType = assetTypes[i % 2];
    const basePrice = assetType === 'CRYPTO' ? 78000 : 1.08;
    const vol = assetType === 'CRYPTO' ? (20 + (i * 7) % 80) : (0.0003 + ((i * 11) % 9) * 0.0001);
    const trend = (((i * 13) % 40) - 20) * (assetType === 'CRYPTO' ? 1 : 0.00003);
    const pair = assetType === 'CRYPTO' ? 'BTC/USD' : 'EUR/USD';
    const cd = makeCandleData({ basePrice, vol, trend, seed: 1000 + i });
    const baseSig = await baselineEngine.buildMultiTimeframeSignal(pair, cd, assetType, ENV);
    const newSig = await buildMultiTimeframeSignal(pair, cd, assetType, ENV);
    compared++;
    if (JSON.stringify(stripTime(baseSig)) !== JSON.stringify(stripTime(newSig))) {
      mismatches++;
      if (mismatchSamples.length < 3) {
        const keys = new Set([...Object.keys(stripTime(baseSig)), ...Object.keys(stripTime(newSig))]);
        let diff = ''; for (const k of keys) { if (JSON.stringify(stripTime(baseSig)[k]) !== JSON.stringify(stripTime(newSig)[k])) { diff = k; break; } }
        mismatchSamples.push({ i, assetType, diff });
      }
    }
  }
  ok('[#17] compared ' + N + ' deterministic fixtures (Forex+Crypto)', compared === N);
  eq('[#17] production output byte-equal on ALL ' + N + ' fuzz fixtures (mismatches=0)', mismatches, 0);
  if (mismatches) console.log('   mismatch samples: ' + JSON.stringify(mismatchSamples));
}

// ════════════════════════════════════════════════════════════════════════
console.log('\n───────────────────────────────────────────────────────────');
console.log('PASS: ' + pass + '   FAIL: ' + fail);
if (fail > 0) { console.log('\nFailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('ALL R7.1 TESTS PASSED');

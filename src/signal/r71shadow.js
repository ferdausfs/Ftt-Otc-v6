/**
 * R7.1 — Structure Attribution Shadow Instrumentation (standard engine only).
 *
 * Single source of truth for the structure-excluded ("shadow") counterfactual.
 *
 * What this module does NOT do:
 *   - It never calls an AI. The shadow is deterministic pre-AI only.
 *   - It never mutates production state, history, stats, CB, or push paths.
 *   - It is standard (Forex/Crypto) engine only. OTC is untouched.
 *
 * Private transport: every audit is carried on a non-enumerable Symbol
 * property so JSON.stringify() / public API responses cannot leak it. The only
 * way to read it back is the explicit getter in this module.
 */

import { CONFIG, SCORE_THRESHOLDS } from '../config.js';
import { runDeterministicVoteAndFilters, decideTfDirection } from './voteFilters.js';

// ── Private, non-enumerable transport symbols ──────────────────────────
// Symbols are ignored by JSON.stringify() and for...in, so anything attached
// under them is invisible to /api/signal, /api/batch, latest cache, bot push,
// and public /api/history unless an explicit getter reads it back.
export const SHADOW_TF   = Symbol('r71.shadowTf');   // per-timeframe raw capture
export const ENGINE_AUDIT = Symbol('r71.engineAudit'); // engine-level audit on the signal

/** Attach raw shadow capture to a TF analysis (non-enumerable). */
export function attachShadowTf(analysis, raw) {
  if (!analysis || typeof analysis !== 'object') return;
  Object.defineProperty(analysis, SHADOW_TF, { value: raw, enumerable: false, configurable: true, writable: true });
}
/** Read raw shadow capture from a TF analysis. */
export function getShadowTfRaw(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;
  const v = analysis[SHADOW_TF];
  return v && typeof v === 'object' ? v : null;
}
/** Read the engine-level audit from a signal object. */
export function getEngineAudit(signal) {
  if (!signal || typeof signal !== 'object') return null;
  const v = signal[ENGINE_AUDIT];
  return v && typeof v === 'object' ? v : null;
}
/** Attach the engine-level audit to a signal (non-enumerable). */
export function attachEngineAudit(signal, audit) {
  if (!signal || typeof signal !== 'object') return;
  Object.defineProperty(signal, ENGINE_AUDIT, { value: audit, enumerable: false, configurable: true, writable: true });
}

// ── Attribution classes (R7.1 design §D) ───────────────────────────────
// Computed on the DETERMINISTIC PRE-AI production direction vs the
// deterministic shadow direction. Neither side has seen an AI.
export function classifyAttribution(prodDir, shadowDir) {
  const p = prodDir === 'BUY' || prodDir === 'SELL' ? prodDir : 'NO_TRADE';
  const s = shadowDir === 'BUY' || shadowDir === 'SELL' ? shadowDir : 'NO_TRADE';
  if (p === s) return 'UNCHANGED';                       // same direction & eligibility
  if (p !== 'NO_TRADE' && s === 'NO_TRADE') return 'STRUCTURE_CREATED'; // prod trades, shadow would not
  if (p === 'NO_TRADE' && s !== 'NO_TRADE') return 'STRUCTURE_SUPPRESSED'; // prod no-trade, shadow trades
  return 'STRUCTURE_REDIRECTED';                         // both trade, different directions
}

/**
 * Build the bounded per-timeframe audit from a TF analysis + its raw capture.
 * Pure: reads only its arguments.
 */
export function buildTimeframeAudit(tf, analysis) {
  const raw = getShadowTfRaw(analysis);
  if (!raw) return null;
  const structure = analysis.structure || null;
  const minScoreThreshold = SCORE_THRESHOLDS[analysis.assetType] || 3.0;

  // shadowCoreDirection is decided in timeframe.js (single source, on the
  // pre-structure/pre-confirmation score). Recompute defensively only if absent.
  const shadowCoreDirection = raw.shadowCoreDirection
    || decideTfDirection(raw.preStructUp, raw.preStructDown, raw.preStructUpCat, raw.preStructDownCat, minScoreThreshold);
  const shadowCoreConfluence = Math.max(raw.preStructUpCat, raw.preStructDownCat);

  // shadowEngineScore = no-structure score AFTER the faithful confirmation-candle
  // adjustment (Report-7 correction). Distinct from shadowCoreScore, which is the
  // pre-confirmation score used to DECIDE shadowCoreDirection.
  const shadowEngineScore = {
    up:   (raw.shadowEngineScoreUp   !== undefined) ? raw.shadowEngineScoreUp   : raw.preStructUp,
    down: (raw.shadowEngineScoreDown !== undefined) ? raw.shadowEngineScoreDown : raw.preStructDown,
  };

  const mult = structure && structure.multiplier ? structure.multiplier : { direction: null, value: 1.0 };

  return {
    tf,
    productionPreHardBlockDirection: raw.preHardBlockDirection,
    productionFinalDirection: analysis.direction,
    shadowCoreDirection,
    productionScore: analysis.score,                 // { up, down, diff }
    productionConfluence: analysis.confluence,
    shadowCoreScore: { up: raw.preStructUp, down: raw.preStructDown },
    shadowCoreConfluence,
    shadowEngineScore,
    shadowCandleConfirmed: (raw.shadowCandleConfirmed !== undefined) ? raw.shadowCandleConfirmed : true,
    shadowConfirmationPenaltyApplied: !!raw.shadowConfirmationPenaltyApplied,
    multiplier: {
      direction: mult.direction,
      value: mult.value,
      appliedUp: raw.structureMultUp,
      appliedDown: raw.structureMultDn,
    },
    structureBias: structure ? structure.bias : null,
    bos: structure && structure.bos ? structure.bos.type : 'NONE',
    choch: structure && structure.choch ? structure.choch.type : 'NONE',
    sweep: structure && structure.sweep ? structure.sweep.type : 'NONE',
    structureSummary: structure ? structure.summary : null,
    categoryVoteApplied: raw.categoryVoteApplied,
    voteDirection: raw.voteDirection,
    hardBlocked: raw.hardBlocked,
    hardBlockReason: raw.hardBlockReason,
    // ── divergence association at TF level (§D honesty flags) ──
    multiplierOrVoteChangedDirection: raw.preHardBlockDirection !== shadowCoreDirection,
    hardBlockChangedDirection: !!(raw.hardBlocked && raw.preHardBlockDirection !== analysis.direction),
    freshness: raw.freshness || null,
  };
}

/**
 * Compute the engine-level structure-excluded shadow + attribution.
 *
 * Never throws on the happy path; the caller wraps this in try/catch so a
 * shadow failure cannot break a live signal.
 *
 * inputs:
 *   tfResults, candleData, assetType, pair, higherTFTrend, marketRegime,
 *   session, sessionMult, candleQualityMult, exotic, newsBlock, newsBlocked,
 *   env,
 *   productionPreAi : { finalDirection, confidence, filtersApplied }
 *   productionPostAi: { finalDirection, confidence }   (actual live result)
 */
export async function computeEngineAudit(inputs) {
  const {
    tfResults, candleData, assetType, pair, higherTFTrend, marketRegime,
    session, sessionMult, candleQualityMult, exotic, newsBlock, newsBlocked, env,
    indicatorCache = {}, now = null, adaptiveSnapshot = null,
    productionPreAi, productionPostAi,
  } = inputs;

  // ── 1. per-timeframe audits ──
  const timeframeAudits = {};
  for (const tf of Object.keys(tfResults)) {
    const a = buildTimeframeAudit(tf, tfResults[tf]);
    if (a) timeframeAudits[tf] = a;
  }

  // ── 2. shadow votes: no-structure per-TF direction (shadowCoreDirection) +
  //    the no-structure engine score AFTER the faithful confirmation-candle
  //    adjustment (Report-7 correction). Direction is decided pre-confirmation;
  //    only the score fed to the engine is confirmation-adjusted.
  const shadowVotes = [];
  for (const tf of Object.keys(tfResults)) {
    const analysis = tfResults[tf];
    const raw = getShadowTfRaw(analysis);
    const alignedWithHTF = analysis.alignedWithHTF;
    if (!raw) {
      // Early-return TF (insufficient data / dead market). Those are
      // non-structure causes, so the no-structure counterfactual is also
      // NO_TRADE — include it so weightedNoTrade stays comparable to production.
      shadowVotes.push({ direction: 'NO_TRADE', score: { up: 0, down: 0 }, confluence: 0, tf, alignedWithHTF });
      continue;
    }
    const minScoreThreshold = SCORE_THRESHOLDS[analysis.assetType] || 3.0;
    const shadowDir = raw.shadowCoreDirection
      || decideTfDirection(raw.preStructUp, raw.preStructDown, raw.preStructUpCat, raw.preStructDownCat, minScoreThreshold);
    const engUp   = (raw.shadowEngineScoreUp   !== undefined) ? raw.shadowEngineScoreUp   : raw.preStructUp;
    const engDown = (raw.shadowEngineScoreDown !== undefined) ? raw.shadowEngineScoreDown : raw.preStructDown;
    shadowVotes.push({
      direction: shadowDir,
      score: { up: engUp, down: engDown },
      confluence: Math.max(raw.preStructUpCat, raw.preStructDownCat),
      tf, alignedWithHTF,
    });
  }

  // ── 3. run the SAME deterministic pipeline on shadow votes (no AI) ──
  // Edge gates need the best TF for the SHADOW direction, not production's
  // structure-influenced direction. Keep raw indicators/entries from the real
  // TF analysis, but substitute the no-structure vote direction/score.
  const edgeTfResults = {};
  for (const vote of shadowVotes) {
    edgeTfResults[vote.tf] = {
      ...(tfResults[vote.tf] || {}),
      direction: vote.direction,
      score: vote.score,
      confluence: vote.confluence,
    };
  }
  const shadowCtx = {
    votes: shadowVotes, candleData, tfResults, edgeTfResults, higherTFTrend, marketRegime,
    session, sessionMult, candleQualityMult, exotic, assetType,
    newsBlock, newsBlocked, pair, env,
    indicatorCache, now, adaptiveSnapshot,
  };
  const shadowDet = await runDeterministicVoteAndFilters(shadowCtx);

  // ── 4. attribution (deterministic pre-AI vs deterministic shadow) ──
  const attribution = classifyAttribution(productionPreAi.finalDirection, shadowDet.finalDirection);

  // ── 5. AI comparability boundary ──
  // productionPostAi is the ACTUAL live decision (post-AI). If AI altered the
  // direction, the row is not clean structure-only evidence.
  const aiAlteredDirection =
    productionPostAi.finalDirection !== productionPreAi.finalDirection;
  let comparability = 'COMPARABLE_PRE_AI';
  let comparabilityReason = 'production AI did not change the final direction (or AI was skipped/unavailable)';
  if (aiAlteredDirection) {
    comparability = 'AI_AFFECTED';
    comparabilityReason = 'production AI changed the final direction ('
      + productionPreAi.finalDirection + ' -> ' + productionPostAi.finalDirection
      + '); not clean structure-only evidence';
  }

  // ── 6. engine-level diagnostic flags (§D — observational only, do NOT
  //    over-attribute). Report-7 correction: the previous `directHardBlockOnly`
  //    causal flag was removed. R7.1 is a combined structure-stack counterfactual;
  //    a multiplier can change score magnitude / weighted confidence / floor
  //    outcome without changing any TF direction, so "no direction divergence" can
  //    never prove a hard-block-only cause. Only observational fields remain.
  let tfHardBlockObserved = false;
  let multiplierOrVoteDivergenceObserved = false;
  let hardBlockFlippedAny = false;
  let shadowTradeTfs = 0;
  let prodTradeTfs = 0;
  for (const tf of Object.keys(timeframeAudits)) {
    const tfa = timeframeAudits[tf];
    if (tfa.hardBlocked) tfHardBlockObserved = true;
    if (tfa.multiplierOrVoteChangedDirection) multiplierOrVoteDivergenceObserved = true;
    if (tfa.hardBlockChangedDirection) hardBlockFlippedAny = true;
    if (tfa.shadowCoreDirection === 'BUY' || tfa.shadowCoreDirection === 'SELL') shadowTradeTfs++;
    if (tfa.productionFinalDirection === 'BUY' || tfa.productionFinalDirection === 'SELL') prodTradeTfs++;
  }

  // ── 7. isolated suppressed-observation eligibility (§E) ──
  // Requires production ACTUAL final AND pre-AI direction both NO_TRADE.
  const isolatedObservationEligible =
    productionPostAi.finalDirection === 'NO_TRADE' &&
    productionPreAi.finalDirection === 'NO_TRADE' &&
    (shadowDet.finalDirection === 'BUY' || shadowDet.finalDirection === 'SELL') &&
    attribution === 'STRUCTURE_SUPPRESSED';

  const audit = {
    decisionScope: 'STANDARD_ENGINE_DETERMINISTIC_PRE_AI',
    attribution,
    comparability,
    comparabilityReason,
    productionPreAiDirection: productionPreAi.finalDirection,
    productionPreAiConfidence: productionPreAi.confidence,
    productionFinalDirection: productionPostAi.finalDirection,
    productionFinalConfidence: productionPostAi.confidence,
    shadowFinalDirection: shadowDet.finalDirection,
    shadowConfidence: shadowDet.confidence,
    shadowRawDirection: shadowDet.rawDirection,
    shadowFiltersApplied: shadowDet.filtersApplied,
    diagnostic: {
      tfHardBlockObserved,
      multiplierOrVoteDivergenceObserved,
      hardBlockFlippedAny,
      prodTradeTfs,
      shadowTradeTfs,
    },
    timeframes: timeframeAudits,
    isolatedObservationEligible,
    // Deterministically-derivable shadow trade context (only meaningful when
    // the shadow actually produces a BUY/SELL). Entry/expiry are candle/timeframe
    // properties (non-structure), so the producing TF's values are valid for the
    // shadow trade too. Best TF = the TF whose shadowCoreDirection matches the
    // shadow engine direction with the highest no-structure score.
    shadowTradeContext: null,
    generatedAt: new Date().toISOString(),
  };

  if (audit.shadowFinalDirection === 'BUY' || audit.shadowFinalDirection === 'SELL') {
    let shadowBestTF = null;
    let shadowBestScore = -Infinity;
    for (const tf of Object.keys(timeframeAudits)) {
      const tfa = timeframeAudits[tf];
      if (tfa.shadowCoreDirection !== audit.shadowFinalDirection) continue;
      const sc = audit.shadowFinalDirection === 'BUY' ? tfa.shadowCoreScore.up : tfa.shadowCoreScore.down;
      if (sc > shadowBestScore) { shadowBestScore = sc; shadowBestTF = tf; }
    }
    let entryPrice = null; let expiryTime = null;
    if (shadowBestTF && tfResults[shadowBestTF]) {
      const tfr = tfResults[shadowBestTF];
      if (tfr.entry) entryPrice = tfr.entry.price;
      if (tfr.expiry) expiryTime = tfr.expiry.expiryTime;
    }
    audit.shadowTradeContext = {
      direction: audit.shadowFinalDirection,
      confidence: audit.shadowConfidence,
      alignment: shadowDet.alignment,
      bestTF: shadowBestTF,
      entryPrice,
      expiryTime,
    };
  }

  return audit;
}

/**
 * Produce the bounded, sanitized record persisted INSIDE a normal history row.
 * This is the only enumerable audit surface; /api/history strips it (health.js).
 */
export function sanitizeAuditForHistory(audit) {
  if (!audit || typeof audit !== 'object') return null;
  const tfs = {};
  for (const tf of Object.keys(audit.timeframes || {})) {
    const t = audit.timeframes[tf];
    tfs[tf] = {
      productionPreHardBlockDirection: t.productionPreHardBlockDirection,
      productionFinalDirection: t.productionFinalDirection,
      shadowCoreDirection: t.shadowCoreDirection,
      productionScore: t.productionScore,
      productionConfluence: t.productionConfluence,
      shadowCoreScore: t.shadowCoreScore,
      shadowCoreConfluence: t.shadowCoreConfluence,
      shadowEngineScore: t.shadowEngineScore,
      shadowCandleConfirmed: t.shadowCandleConfirmed,
      shadowConfirmationPenaltyApplied: t.shadowConfirmationPenaltyApplied,
      multiplier: t.multiplier,
      structureBias: t.structureBias,
      bos: t.bos, choch: t.choch, sweep: t.sweep, structureSummary: t.structureSummary,
      categoryVoteApplied: t.categoryVoteApplied,
      voteDirection: t.voteDirection,
      hardBlocked: t.hardBlocked,
      hardBlockReason: t.hardBlockReason,
      multiplierOrVoteChangedDirection: t.multiplierOrVoteChangedDirection,
      hardBlockChangedDirection: t.hardBlockChangedDirection,
      freshness: t.freshness,
    };
  }
  return {
    decisionScope: audit.decisionScope,
    attribution: audit.attribution,
    comparability: audit.comparability,
    comparabilityReason: audit.comparabilityReason,
    productionPreAiDirection: audit.productionPreAiDirection,
    productionFinalDirection: audit.productionFinalDirection,
    shadowFinalDirection: audit.shadowFinalDirection,
    shadowConfidence: audit.shadowConfidence,
    diagnostic: audit.diagnostic,
    timeframes: tfs,
  };
}

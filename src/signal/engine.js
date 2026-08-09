import {
  CONFIG, ASSET_TYPE, CANDLE_MINUTES,
} from '../config.js';
import { safeLastValue, r2, formatDuration, getCandleCountdown, getNextCandleClose } from '../utils/helpers.js';
import { detectTradingSession, checkNewsBlackout } from '../utils/session.js';
import { isExoticPair } from '../utils/pairs.js';
import { calculateAllIndicators } from '../indicators/index.js';
import { detectMarketRegime, getRegimeAdvice } from '../indicators/regime.js';
import { analyzeTimeframe } from './timeframe.js';
import { calculateCandleDuration } from '../analysis/duration.js';
import { generateEntryReason, getSessionWeightMultiplier, getCandleQualityMultiplier, computeFxLevels } from '../analysis/filters.js';
import { getSignalGrade } from '../analysis/grade.js';
import { getCalibratedGradeAndConfidence } from '../analysis/calibration.js';
import { callCerebrasValidation } from '../ai/cerebras.js';
import { callGroqValidation } from '../ai/groq.js';
import { combineDualAIResults, buildIndicatorSnapshot } from '../ai/combine.js';
// R7.1: shared deterministic pipeline + shadow attribution (standard engine only).
import { runDeterministicVoteAndFilters } from './voteFilters.js';
import { computeEngineAudit, attachEngineAudit } from './r71shadow.js';
// D2 Shadow: private would-be-signal counterfactual for Phase-D2 filters.
import { attachD2Audit } from './d2shadow.js';
// Forex SELL Probe: forward-evidence context collector (instrumentation only).
import { attachProbeAudit } from './probeShadow.js';

export async function buildMultiTimeframeSignal(pair, candleData, assetType, env, opts = {}) {
  const fxMode = !!opts.fxMode;
  // F3-16 (BUG-022/CLOCK-001): optional injection so tests (and any caller)
  // can pin the wall clock / trading session instead of inheriting the
  // current time — the D2 HIGHEST-session block made fixture tests
  // time-of-day dependent. Production callers omit both and keep live values.
  const now     = opts && opts.now ? new Date(opts.now) : new Date();
  const session = (opts && opts.session) || detectTradingSession();
  const exotic  = isExoticPair(pair);

  // newsBlock is also injectable (null = no blackout) so fixture tests are
  // invariant to the weekly news windows too (e.g. Thu 17:30-19:45 UTC).
  const newsBlock   = (opts && Object.prototype.hasOwnProperty.call(opts, 'newsBlock'))
    ? opts.newsBlock : checkNewsBlackout(assetType);
  const newsBlocked = !!(newsBlock && newsBlock.blocked);

  // ── FIX: Calculate indicators ONCE per TF, cache results ──
  // Previously: 15min was calculated 3x (HTF trend + regime + per-TF loop)
  const indicatorCache = {};
  for (const tf of Object.keys(candleData)) {
    if (candleData[tf] && candleData[tf].length > 0) {
      indicatorCache[tf] = calculateAllIndicators(candleData[tf], tf);
    }
  }

  // ── HTF TREND (use cached 15min indicators) ──
  let higherTFTrend = null;
  if (indicatorCache['15min']) {
    const htfInd   = indicatorCache['15min'];
    const htfEma5  = safeLastValue(htfInd.ema5);
    const htfEma13 = safeLastValue(htfInd.ema13);
    const htfEma55 = safeLastValue(htfInd.ema55);
    const htfAdx   = htfInd.adx ? safeLastValue(htfInd.adx.adx)    : null;
    const htfPDI   = htfInd.adx ? safeLastValue(htfInd.adx.plusDI)  : null;
    const htfMDI   = htfInd.adx ? safeLastValue(htfInd.adx.minusDI) : null;
    // Fix: ADX threshold raised to 25 (was 20 — too loose)
    if (htfEma5 !== null && htfEma55 !== null && htfAdx !== null && htfAdx >= 25) {
      if (htfEma5 > htfEma55 && htfPDI !== null && htfMDI !== null && htfPDI > htfMDI) higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma55 && htfPDI !== null && htfMDI !== null && htfMDI > htfPDI) higherTFTrend = 'SELL';
    }
    // Also check EMA 5/13/55 full stack for HTF (stronger signal)
    if (higherTFTrend === null && htfEma5 !== null && htfEma13 !== null && htfEma55 !== null) {
      if (htfEma5 > htfEma13 && htfEma13 > htfEma55) higherTFTrend = 'BUY';
      else if (htfEma5 < htfEma13 && htfEma13 < htfEma55) higherTFTrend = 'SELL';
    }
  }

  // ── MARKET REGIME (use cached 15min indicators) ──
  let marketRegime = 'RANGING';
  const regimeTF = indicatorCache['15min'] || indicatorCache['5min'] || indicatorCache['1min'];
  const regimeCandles = candleData['15min'] || candleData['5min'] || candleData['1min'];
  if (regimeTF && regimeCandles) {
    const rAdx  = safeLastValue(regimeTF.adx.adx);
    const rBbArr = regimeTF.bollinger.bandwidth;
    const bwVals = [];
    if (rBbArr) {
      for (let bi = rBbArr.length - 1; bi >= 0 && bwVals.length < 2; bi--) {
        if (rBbArr[bi] !== null && !isNaN(rBbArr[bi])) bwVals.push(rBbArr[bi]);
      }
    }
    const rBbBW     = bwVals[0] || null;
    const rBbBWPrev = bwVals[1] || null;
    const rAtr = safeLastValue(regimeTF.atr);
    const rLC  = regimeCandles[regimeCandles.length - 1].close;
    marketRegime = detectMarketRegime(rAdx, rBbBW, rAtr, rLC, assetType, rBbBWPrev);
  }

  // ── PER-TIMEFRAME ANALYSIS (use cached indicators) ──
  const tfResults = {};
  const votes     = [];
  for (const tf of Object.keys(candleData)) {
    const candles    = candleData[tf];
    if (!candles || candles.length === 0) continue;
    const indicators = indicatorCache[tf];
    if (!indicators) continue;

    const analysis = analyzeTimeframe(indicators, candles, tf, assetType, higherTFTrend, marketRegime);

    const durCandles = calculateCandleDuration(indicators, analysis.direction, candles, tf, assetType);
    const candleMin  = CANDLE_MINUTES[tf] || 1;
    const durMinutes = durCandles * candleMin;
    const expiryTime = new Date(now.getTime() + durMinutes * 60000);
    const nextClose  = getNextCandleClose(now, candleMin);
    const countdown  = getCandleCountdown(candleMin);

    analysis.expiry = {
      candles: durCandles, candleSize: candleMin + 'min', totalMinutes: durMinutes,
      expiryTime: expiryTime.toISOString(), humanReadable: formatDuration(durMinutes),
      nextCandleClose: nextClose.toISOString(), countdown,
    };
    analysis.entry = {
      price: candles[candles.length - 1].close,
      candleTime: candles[candles.length - 1].datetime,
      candleDirection: candles[candles.length - 1].close >= candles[candles.length - 1].open ? 'BULLISH' : 'BEARISH',
    };
    analysis.higherTFTrend  = higherTFTrend;
    analysis.alignedWithHTF = (higherTFTrend === null || analysis.direction === 'NO_TRADE' || analysis.direction === higherTFTrend);

    tfResults[tf] = analysis;
    votes.push({ direction: analysis.direction, score: analysis.score, confluence: analysis.confluence, tf, alignedWithHTF: analysis.alignedWithHTF });
  }

  // ── SESSION + CANDLE QUALITY MULTIPLIERS ──
  // F3-13 (BUG-025): crypto pairs skip forex session weights (24/7 market —
  // confidence must not be inflated x1.4 by the USD quote's London/NY map).
  const sessionMult = getSessionWeightMultiplier(pair, session, assetType);
  let qualityCandles = [];
  if (candleData['1min']  && tfResults['1min']  && !tfResults['1min'].deadMarket)  qualityCandles = candleData['1min'];
  else if (candleData['5min']  && tfResults['5min']  && !tfResults['5min'].deadMarket)  qualityCandles = candleData['5min'];
  else if (candleData['15min'] && tfResults['15min'] && !tfResults['15min'].deadMarket) qualityCandles = candleData['15min'];
  else qualityCandles = candleData['1min'] || candleData['5min'] || candleData['15min'] || [];
  const candleQualityMult = getCandleQualityMultiplier(qualityCandles);

  // ── R7.1: deterministic pre-AI pipeline (shared with the shadow path) ──
  // This block was lifted VERBATIM from 71e87eb into runDeterministicVoteAndFilters
  // (voteFilters.js). Production and the structure-excluded shadow now share one
  // implementation. Baseline equivalence is asserted in scripts/r71_tests.mjs (#1).
  const det = await runDeterministicVoteAndFilters({
    votes, candleData, tfResults, higherTFTrend, marketRegime,
    session, sessionMult, candleQualityMult, exotic, assetType,
    newsBlock, newsBlocked, pair, env,
  });
  let finalDirection    = det.finalDirection;
  let confidence        = det.confidence;
  const rawDirection    = det.rawDirection;
  const rawConfidence   = det.rawConfidence;
  let belowFloor        = det.belowFloor;
  const filtersApplied  = det.filtersApplied;
  const alignment       = det.alignment;
  const marketCondition = det.marketCondition;
  const marketContext   = det.marketContext;
  const isDeadMarket    = det.isDeadMarket;
  const weightedBuy     = det.weightedBuy;
  const weightedSell    = det.weightedSell;
  const weightedNoTrade = det.weightedNoTrade;

  // ── Phase D2: verified-bad-slice negative quality filters ──
  // Source: Phase C verified analysis (n=1460 public + n=490 audit).
  // These slices lose consistently; blocking them raises pooled WR.
  // D2 Shadow: whenever a D2 branch fires, the would-be signal is captured
  // under a private Symbol (d2shadow.js) and — if the block holds post-AI —
  // tracked as a counterfactual observation (d2store.js). Blocked slices keep
  // producing forward evidence for Phase F instead of silently disappearing.
  // Phase F (2026-08-02): BAD_PAIR block SUSPENDED behind
  // CONFIG.D2_BAD_PAIR_BLOCK_ENABLED=false so USD/JPY, AUD/USD, DOT/USD can
  // generate the forward signals needed to validate (or reject) those blocks.
  let d2Audit = null;
  if (finalDirection !== 'NO_TRADE') {
    const d2PreDir = finalDirection;
    const d2PreConf = confidence;
    if (marketRegime === 'TRENDING') {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('D2_TRENDING_BLOCK (29.5% WR n=356)');
      d2Audit = { attribution: 'D2_TRENDING_BLOCKED' };
    } else if (CONFIG.D2_BAD_PAIR_BLOCK_ENABLED && ['USD/JPY', 'AUD/USD', 'DOT/USD'].includes(pair)) {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('D2_BAD_PAIR_BLOCK (' + pair + ' <20% WR)');
      d2Audit = { attribution: 'D2_BAD_PAIR_BLOCKED' };
    } else if (assetType === ASSET_TYPE.FOREX && session.quality === 'HIGHEST') {
      finalDirection = 'NO_TRADE'; confidence = 0;
      filtersApplied.push('D2_HIGHEST_SESSION_BLOCK (6.1% WR n=66)');
      d2Audit = { attribution: 'D2_HIGHEST_SESSION_BLOCKED' };
    }
    if (d2Audit) {
      // capture the would-be signal (best TF for the pre-D2 direction)
      try {
        const best = findBestTimeframe(tfResults, d2PreDir);
        const bestTFAnalysis = (best && best.timeframe && best.timeframe !== 'N/A') ? tfResults[best.timeframe] : null;
        d2Audit = {
          ...d2Audit,
          wouldBeDirection: d2PreDir,
          wouldBeConfidence: d2PreConf,
          bestTF: bestTFAnalysis ? best.timeframe : null,
          entryPrice: bestTFAnalysis && bestTFAnalysis.entry ? bestTFAnalysis.entry.price : null,
          expiryTime: best && best.expiry ? best.expiry.expiryTime : null,
          marketRegime, sessionQuality: session ? session.quality : null,
          filtersApplied: filtersApplied.slice(),
          pair,
        };
      } catch (e) {
        console.warn('D2 shadow capture failed (fail-open): ' + e.message);
        d2Audit = null;
      }
    }
  }

  // ── AI VALIDATION ──
  // Runs on valid signal OR raw direction (when borderline filters blocked it)
  // F3-15 (BUG-017): a D2 hard block is a data-backed verdict (6-30% WR
  // slices) — the AI can never override it, so don't spend 2 LLM calls (and
  // ~8s of latency) validating a trade that is already decided NO_TRADE.
  const aiTargetDir = d2Audit
    ? null
    : (finalDirection !== 'NO_TRADE'
      ? finalDirection
      : (rawDirection !== 'NO_TRADE' && rawConfidence >= 60 ? rawDirection : null));

  let aiValidation = { status: 'SKIPPED' }; let aiAgreed = null;

  if (d2Audit && aiTargetDir === null) {
    // F3-15: replaces the old 'AI_RESCUE_SKIPPED' note (which implied the AI
    // had run) — now the AI never runs on D2-blocked signals at all. The
    // specific D2_* filter name is already public in filtersApplied, so the
    // private audit attribution token must NOT be echoed here (JSON-leak
    // surface — asserted by d2_tests #9h).
    filtersApplied.push('AI_SKIPPED (D2 hard block)');
  }

  if (aiTargetDir) {
    const aiUseConf  = finalDirection !== 'NO_TRADE' ? confidence : rawConfidence;
    const bestSnap   = findBestTimeframe(tfResults, aiTargetDir);
    const snapshot   = buildIndicatorSnapshot(tfResults, candleData, aiTargetDir, bestSnap.timeframe);
    const engineSig  = {
      direction: aiTargetDir, confidence: aiUseConf + '%', alignment,
      higherTFTrend: higherTFTrend || 'NEUTRAL', marketCondition, bestTF: bestSnap.timeframe,
    };

    const [cerebrasResult, groqResult] = await Promise.all([
      callCerebrasValidation(pair, assetType, engineSig, snapshot, env),
      callGroqValidation(pair, assetType, engineSig, snapshot, env),
    ]);
    const dualResult = combineDualAIResults(cerebrasResult, groqResult, aiTargetDir);
    aiValidation = dualResult;
    const combinedAI = dualResult.combined;

    if (combinedAI && combinedAI.status === 'OK') {
      aiAgreed = combinedAI.signal === aiTargetDir;
      aiValidation.agrees = aiAgreed;

      // ── FIX: Separate rescue path vs normal path (no double-boost) ──
      if (finalDirection === 'NO_TRADE' && aiTargetDir !== 'NO_TRADE') {
        // Bugfix round 1 (BUG-002): D2 negative filters (TRENDING / BAD_PAIR /
        // HIGHEST_SESSION) are HARD, data-backed blocks (6-30% WR slices). The
        // AI rescue path is only meant for SOFT filters (confidence floor,
        // dead-market, etc). If a D2 branch fired, never let the AI revive the
        // trade — the would-be signal is captured by the D2 shadow instead.
        // (F3-15: with d2Audit set, aiTargetDir is null so the AI never even
        // runs — this branch is soft-filter rescue only now.)
        if (aiAgreed && (combinedAI.confidence || 0) >= 70 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(92, Math.round((rawConfidence + (combinedAI.confidence || 0)) / 2));
          belowFloor = false;
          filtersApplied.push('AI_RESCUE: ' + aiTargetDir + ' raw=' + rawConfidence + '% AI=' + (combinedAI.confidence || 0) + '% → ' + confidence + '%');
        } else if (aiAgreed && (combinedAI.confidence || 0) >= 60 && !combinedAI.concerns) {
          finalDirection = aiTargetDir;
          confidence = Math.min(85, rawConfidence + 5);
          belowFloor = false;
          filtersApplied.push('AI_SOFT_RESCUE: ' + aiTargetDir + ' @ ' + confidence + '%');
        } else {
          filtersApplied.push('AI_RESCUE_FAILED: conf=' + (combinedAI.confidence || 0) + '% concerns=' + (combinedAI.concerns || 'none'));
        }
      } else if (finalDirection !== 'NO_TRADE') {
        // NORMAL PATH — signal was already valid, AI confirms or blocks
        if (aiAgreed) {
          if (!combinedAI.concerns) {
            const boost = combinedAI.agreement === 'BOTH_AGREE' ? 8 : 5;
            confidence = Math.min(92, confidence + boost);
            filtersApplied.push('DUAL_AI_BOOST: ' + (combinedAI.agreement || 'AGREE') + ' +' + boost);
          } else {
            confidence = Math.max(0, confidence - 5);
            filtersApplied.push('DUAL_AI_AGREE_WITH_CONCERNS: ' + combinedAI.concerns);
          }
        } else {
          finalDirection = 'NO_TRADE'; confidence = 0;
          filtersApplied.push('DUAL_AI_DISAGREE_BLOCK (AI=' + combinedAI.signal + ')');
        }
      }
    }
  }

  // ── POST-AI CONFIDENCE FLOOR (Bugfix round 1 / BUG-007) ──
  // The pre-AI floor (voteFilters.js) only runs BEFORE the AI layer. AI boost /
  // agree-with-concerns / rescue can then land the final confidence BELOW the
  // advertised MIN_CONFIDENCE_FLOOR (e.g. 74 - 5 = 69 on agree-with-concerns).
  // Re-apply the floor on the FINAL output so no signal leaves at < 72%.
  if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    finalDirection = 'NO_TRADE'; confidence = 0;
    filtersApplied.push('BELOW_FLOOR_AFTER_AI (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
  }

  // ── BUILD OUTPUTS ──
  const best    = findBestTimeframe(tfResults, finalDirection);
  const avgConf = votes.reduce((s, v) => s + (v.confluence || 0), 0) / Math.max(votes.length, 1);

  const recommendations = {};
  for (const [rtf, rec] of Object.entries(tfResults)) {
    recommendations[rtf] = {
      direction: rec.direction, score: rec.score,
      confluence: rec.confluence + '/12 categories', alignedWithHTF: rec.alignedWithHTF,
      expiry: rec.expiry, entry: rec.entry,
      candleConfirmed: rec.candleConfirmed,
      patterns:   (rec.categoryScores?.patterns?.detected)    || [],
      divergence: { rsi: rec.categoryScores?.divergence?.rsi || 'NONE', macd: rec.categoryScores?.divergence?.macd || 'NONE' },
      diCrossover: rec.categoryScores?.adx?.diCross || 'NONE',
    };
  }

  const bestTFAnalysis = tfResults[best.timeframe] || null;
  const entryReason    = generateEntryReason(finalDirection, bestTFAnalysis?.categoryScores || {}, bestTFAnalysis?.indicators || {}, alignment, higherTFTrend, marketContext);

  if (sessionMult !== 1.0)      filtersApplied.push('SESSION_WEIGHT x' + sessionMult.toFixed(2));
  if (candleQualityMult !== 1.0) filtersApplied.push('CANDLE_QUALITY x' + candleQualityMult.toFixed(2));
  if (isDeadMarket && finalDirection !== 'NO_TRADE') filtersApplied.push('DEAD_MARKET_WARN (AI rescued)');

  const structureVerdict = buildStructureVerdict(tfResults, finalDirection);
  // ── CALIBRATION: overwrite confidence & grade with calibrated versions
  // Raw confidence (vote-share) is kept for filtering (floor etc.) but
  // reported confidence is calibrated to empirical WR (TRAIN 08-01..06).
  // This fixes inverted ladder: A+ was worst 37.8% WR, now A+ best.
  let calibratedConfForReport = confidence;
  let calibratedScoreForTrace = null;
  if (finalDirection !== 'NO_TRADE') {
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall);
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }

  // F3-05 (BUG-013): a blocked signal must never carry a tradable grade
  // (previously a NO_TRADE could still score "B — GOOD, suitable for trading"
  // from alignment + confluence at confidence 0).
  let finalGrade;
  if (finalDirection === 'NO_TRADE') {
    finalGrade = { grade: 'N/A', label: 'NO_TRADE', description: 'Engine blocked — no trade.' };
  } else {
    // getSignalGrade now itself uses calibrated scoring, but we also have calibrated
    // confidence from above. Use the calibrated grade directly to ensure consistency.
    const cal = getCalibratedGradeAndConfidence(confidence, structureVerdict.overall);
    finalGrade = cal.grade;
    calibratedConfForReport = cal.calibratedConfidence;
    calibratedScoreForTrace = cal.score;
  }

  // Use calibrated confidence for reporting, rawConfidence kept in coreConfidence
  const reportConfidence = finalDirection === 'NO_TRADE' ? 0 : calibratedConfForReport;

  const __signal = {
    finalSignal: finalDirection, confidence: reportConfidence + '%', grade: finalGrade,
    // B5: pre-filter engine confidence (captured at line ~164, before HTF block,
    // alignment bonus, session/exotic penalties, AI rescue etc). Lets us later
    // separate "engine was weak" from "filters ate it".
    coreConfidence: rawConfidence,
    // Calibration trace (Phase F fix)
    calibration: finalDirection === 'NO_TRADE' ? null : {
      rawConfidence: confidence,
      calibratedConfidence: calibratedConfForReport,
      calibratedScore: calibratedScoreForTrace,
      version: 'calib-v1-2026-08-09',
    },
    assetType, marketRegime, regimeAdvice: getRegimeAdvice(marketRegime, finalDirection),
    marketCondition, alignment, higherTFTrend: higherTFTrend || 'NEUTRAL',
    entryReason, filtersApplied, newsBlackout: newsBlock || null, aiValidation,
    session: assetType === ASSET_TYPE.FOREX ? session : { sessions: ['24/7'], quality: 'N/A' },
    recommendations, bestTimeframe: best,
    votes: {
      BUY: votes.filter(v => v.direction === 'BUY').length,
      SELL: votes.filter(v => v.direction === 'SELL').length,
      NO_TRADE: votes.filter(v => v.direction === 'NO_TRADE').length,
      total: votes.length,
      weightedBuy: r2(weightedBuy), weightedSell: r2(weightedSell), weightedNoTrade: r2(weightedNoTrade),
    },
    averageConfluence: Math.round(avgConf * 10) / 10,
    timeframeAnalysis: tfResults,
    // Structure summary across all TFs
    structureSummary: Object.fromEntries(
      Object.entries(tfResults)
        .filter(([, r]) => r.structure)
        .map(([tf, r]) => [tf, {
          bias:    r.structure.bias,
          bos:     r.structure.bos     ? r.structure.bos.type     : 'NONE',
          choch:   r.structure.choch   ? r.structure.choch.type   : 'NONE',
          sweep:   r.structure.sweep   ? r.structure.sweep.type   : 'NONE',
          applied: r.structureApplied  || 'NONE',
          multiplier: r.structure.multiplier ? r.structure.multiplier.value : 1.0,
        }])
    ),
    // Quick verdict: does market structure support the final signal? Use this
    // to decide whether to take the trade when structure disagrees.
    structureVerdict,
    sessionWeight: sessionMult, candleQuality: candleQualityMult,
    method: 'WEIGHTED_MULTI_TF_v6.9.2_EMA5-13-55+STRUCTURE', generatedAt: now.toISOString(),
  };

  // ── R7.1 shadow structure-attribution audit (standard engine only) ──
  // productionPostAi.finalDirection below is the ACTUAL live decision (post-AI).
  // The shadow is deterministic PRE-AI and never calls an AI. Wrapped so any
  // shadow failure leaves the production signal byte-identical (fail-open).
  try {
    const r71Audit = await computeEngineAudit({
      tfResults, candleData, assetType, pair, higherTFTrend, marketRegime,
      session, sessionMult, candleQualityMult, exotic, newsBlock, newsBlocked, env,
      productionPreAi:  { finalDirection: det.finalDirection, confidence: det.confidence },
      productionPostAi: { finalDirection, confidence },
    });
    attachEngineAudit(__signal, r71Audit);
  } catch (e) {
    console.warn('R7.1 shadow audit failed (production unaffected): ' + e.message);
  }

  // ── D2 Shadow: attach the would-be-signal counterfactual (private Symbol,
  // non-enumerable — public responses and history never see it). ──
  if (d2Audit) {
    try { attachD2Audit(__signal, d2Audit); }
    catch (e) { console.warn('D2 shadow attach failed (production unaffected): ' + e.message); }
  }

  // ── FX Mode: attach ATR-based SL/TP levels + mode tag (phase F addition).
  // Output-only enrichment — direction/confidence logic untouched. ──
  if (fxMode && (finalDirection === 'BUY' || finalDirection === 'SELL')) {
    try {
      const atrTF = tfResults['15min'] || tfResults['5min'] || tfResults['1min'];
      const atrArr = atrTF && atrTF.indicators ? atrTF.indicators.atr : null;
      let atr = null;
      if (typeof atrArr === 'number') atr = atrArr;
      else if (typeof atrArr === 'string') atr = parseFloat(atrArr);
      else if (Array.isArray(atrArr)) { const v = atrArr[atrArr.length - 1]; atr = typeof v === 'number' ? v : parseFloat(v); }
      if (atr !== null && isNaN(atr)) atr = null;
      const best = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = (best && best.timeframe && best.timeframe !== 'N/A') ? tfResults[best.timeframe] : null;
      const entry = bestTFA && bestTFA.entry ? bestTFA.entry.price : null;
      const levels = computeFxLevels({ entry, atr, direction: finalDirection });
      __signal.mode = 'fx';
      __signal.fxLevels = levels;
    } catch (e) {
      console.warn('FX mode attach failed (production unaffected): ' + e.message);
      __signal.mode = 'fx';
      __signal.fxLevels = null;
    }
  }

  // ── Fill status (2026-08-05): is the entry actionable RIGHT NOW, or is
  // price away from entry (wait/pending)? Based on best-TF entry price vs the
  // current (last close) price — tells the app/bot whether this signal can be
  // taken instantly or needs the price to come to the entry first.
  if (finalDirection === 'BUY' || finalDirection === 'SELL') {
    try {
      const best = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = (best && best.timeframe && best.timeframe !== 'N/A') ? tfResults[best.timeframe] : null;
      const entryPx = bestTFA && bestTFA.entry ? bestTFA.entry.price : null;
      // Bugfix round 1 (BUG-003): "current price" must be INDEPENDENT of the
      // entry reference. The entry is the best TF's last close; the current
      // price is the freshest candle we have — the lowest timeframe's last
      // close (1min < 5min < 15min). Previously both values came from the SAME
      // array element, so fillStatus was always 'INSTANT' and distance always 0.
      const currentCandles = candleData['1min'] || candleData['5min'] || candleData['15min'];
      const lastClose = currentCandles && currentCandles.length
        ? currentCandles[currentCandles.length - 1].close : null;
      if (entryPx != null && lastClose != null) {
        const dist = Math.abs(lastClose - entryPx);
        const rel = entryPx !== 0 ? dist / entryPx : 0;
        // actionable if within ~0.05% (5 pips-ish for forex, scaled for crypto)
        const actionable = rel <= 0.0005;
        __signal.fillStatus = actionable ? 'INSTANT' : 'PENDING_ENTRY';
        __signal.entryPrice = entryPx;
        __signal.currentPrice = lastClose;
        __signal.entryDistancePct = Number((rel * 100).toFixed(4));
      }
    } catch (e) {
      console.warn('fill status failed (production unaffected): ' + e.message);
    }
  }

  // ── Forex SELL Probe: capture signal-time context when engine outputs a
  // FOREX SELL (instrumentation only — production unchanged). ──
  if (CONFIG.FOREX_SELL_PROBE_ENABLED && assetType === ASSET_TYPE.FOREX && finalDirection === 'SELL') {
    try {
      const best = findBestTimeframe(tfResults, finalDirection);
      const bestTFA = (best && best.timeframe && best.timeframe !== 'N/A') ? tfResults[best.timeframe] : null;
      const rsiArr = bestTFA && bestTFA.indicators ? bestTFA.indicators.rsi : null;
      let rsi = null;
      if (typeof rsiArr === 'number') rsi = rsiArr;
      else if (typeof rsiArr === 'string') rsi = parseFloat(rsiArr);
      else if (Array.isArray(rsiArr)) { const v = rsiArr[rsiArr.length - 1]; rsi = typeof v === 'number' ? v : parseFloat(v); }
      if (rsi === null || isNaN(rsi)) rsi = null;
      attachProbeAudit(__signal, {
        attribution: 'FOREX_SELL_PROBE',
        direction: 'SELL',
        confidence,
        bestTF: bestTFA ? best.timeframe : null,
        entryPrice: bestTFA && bestTFA.entry ? bestTFA.entry.price : null,
        expiryTime: best && best.expiry ? best.expiry.expiryTime : null,
        regime: marketRegime,
        sessionQuality: session ? session.quality : null,
        higherTFTrend,
        alignment: det.alignment,
        rsi: (rsi !== null && isFinite(rsi)) ? Math.round(rsi * 100) / 100 : null,
      });
    } catch (e) {
      console.warn('probe attach failed (production unaffected): ' + e.message);
    }
  }

  return __signal;
}

export function findBestTimeframe(tfResults, finalDirection) {
  let bestTF = null; let bestScore = -1; let bestConf = -1;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (r.direction === finalDirection || finalDirection === 'NO_TRADE') {
      const score = r.direction === 'BUY' ? r.score.up : r.direction === 'SELL' ? r.score.down : 0;
      const ec    = r.confluence + (r.alignedWithHTF ? 1 : 0);
      if (ec > bestConf || (ec === bestConf && score > bestScore)) { bestTF = tf; bestScore = score; bestConf = ec; }
    }
  }
  if (!bestTF) {
    for (const [tf, r] of Object.entries(tfResults)) {
      const score = Math.max(r.score.up, r.score.down);
      if (score > bestScore) { bestTF = tf; bestScore = score; bestConf = r.confluence; }
    }
  }
  if (!bestTF) return { timeframe: 'N/A', reason: 'No analyzable timeframe' };
  const best = tfResults[bestTF];
  return {
    timeframe: bestTF, direction: best.direction, score: bestScore,
    confluence: best.confluence, alignedWithHTF: best.alignedWithHTF, expiry: best.expiry,
    reason: 'Strongest ' + best.direction + ' signal with ' + best.confluence + '/12 confluence',
  };
}

// ── STRUCTURE VERDICT ─────────────────────────────────────
// Per timeframe: does market structure (BOS/CHoCH/bias) AGREE, DISAGREE,
// or stay NEUTRAL relative to the engine's finalDirection?
// Plus an `overall` summary so the user can quickly decide whether to
// take the trade when structure conflicts with the signal.
export function buildStructureVerdict(tfResults, finalDirection) {
  const perTF = {};
  let agree = 0, disagree = 0, neutral = 0;

  for (const [tf, r] of Object.entries(tfResults)) {
    if (!r.structure) continue;
    const dir = r.structure.multiplier ? r.structure.multiplier.direction : null;

    let verdict;
    if (finalDirection === 'NO_TRADE' || !dir) {
      verdict = 'NEUTRAL';
    } else if (dir === finalDirection) {
      verdict = 'AGREE';
    } else {
      verdict = 'DISAGREE';
    }

    if (verdict === 'AGREE') agree++;
    else if (verdict === 'DISAGREE') disagree++;
    else neutral++;

    perTF[tf] = {
      verdict,
      bias: r.structure.bias,
      structureDirection: dir || 'NONE',
      multiplier: r.structure.multiplier ? r.structure.multiplier.value : 1.0,
      detail: r.structure.summary,
    };
  }

  let overall;
  if (finalDirection === 'NO_TRADE') {
    overall = 'N/A';
  } else if (disagree > agree) {
    overall = 'AGAINST';
  } else if (agree > 0 && disagree === 0) {
    overall = 'ALIGNED';
  } else if (agree > 0 && disagree > 0) {
    overall = 'MIXED';
  } else {
    overall = 'NEUTRAL';
  }

  // Independent structure direction — what does structure itself say,
  // regardless of the engine's finalDirection?
  let buyVotes = 0, sellVotes = 0, structNeutral = 0;
  let buyMultSum = 0, sellMultSum = 0;
  for (const tf of Object.values(perTF)) {
    if (tf.structureDirection === 'BUY') { buyVotes++; buyMultSum += tf.multiplier; }
    else if (tf.structureDirection === 'SELL') { sellVotes++; sellMultSum += tf.multiplier; }
    else structNeutral++;
  }

  let direction, strength;
  if (buyVotes > sellVotes) {
    direction = 'BUY';
    strength = (buyMultSum / buyVotes) >= 1.15 ? 'STRONG' : 'WEAK';
  } else if (sellVotes > buyVotes) {
    direction = 'SELL';
    strength = (sellMultSum / sellVotes) >= 1.15 ? 'STRONG' : 'WEAK';
  } else if (buyVotes > 0 && buyVotes === sellVotes) {
    direction = 'MIXED';
    strength = 'NEUTRAL';
  } else {
    direction = 'NEUTRAL';
    strength = 'NEUTRAL';
  }

  return { direction, strength, overall, perTimeframe: perTF };
}
import { CONFIG } from '../config.js';
import { getCalibratedGradeAndConfidence, CALIB_GRADE_DEFS } from './calibration.js';

// GRADE_DEFS kept for cap helper and backward compat
const GRADE_DEFS = CALIB_GRADE_DEFS;

/**
 * Calibrated grade — replaces inverted sc = conf*0.4 + avgConf*5 + alignmentBonus
 * Now uses empirical calibration table derived from TRAIN 08-01..06.
 * avgConf and alignment are kept in signature for compat but not used for scoring
 * (they were found to be non-predictive / inverted vs WR). StructureOverall is used.
 */
export function getSignalGrade(confidence, avgConf, alignment, structureOverall, regime) {
  // Use calibrated scoring (regime-conditional when the caller provides regime)
  const cal = getCalibratedGradeAndConfidence(confidence, structureOverall, regime);
  return cal.grade;
}

// Expose helper for engine to get both calibrated confidence and grade in one call
export function getCalibratedGradeAndConfidenceWrapper(confidence, structureOverall, regime) {
  return getCalibratedGradeAndConfidence(confidence, structureOverall, regime);
}

export function resolveTieWithTolerance(details) {
  let tU = 0; let tD = 0; let cU = 0; let cD = 0;
  for (const tf of Object.keys(details)) {
    const s = details[tf]; const w = CONFIG.TF_WEIGHTS[tf] || 1.0;
    tU += s.score.up * w;   tD += s.score.down * w;
    cU += ((s.confluenceDetail && s.confluenceDetail.bullish) || 0) * w;
    cD += ((s.confluenceDetail && s.confluenceDetail.bearish) || 0) * w;
  }
  const total = tU + tD;
  if (tU > tD && cU >= cD) return { direction:'BUY',      confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU && cD >= cU) return { direction:'SELL',     confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  if (tU > tD)             return { direction:'BUY',      confidence: total > 0 ? Math.round((tU / total) * 100) : 50 };
  if (tD > tU)             return { direction:'SELL',     confidence: total > 0 ? Math.round((tD / total) * 100) : 50 };
  return                          { direction:'NO_TRADE', confidence: 50 };
}

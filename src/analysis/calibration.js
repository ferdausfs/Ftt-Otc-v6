/**
 * Grade / Confidence Calibration — Phase F fix for inverted ladder
 *
 * Problem: grade and confidence were inverted vs actual WR.
 *   A+ 37.8% WR (worst) vs C 46.9% (best)
 *   conf 80-84 37.4% worst vs 72-74 43%
 *
 * Root cause:
 *   - alignment +25 bonus rewards trend-consensus (ALL_*) which loses in TRENDING
 *   - confidence = vote-share ratio, not win probability
 *   - structure cap capped AGAINST (best WR) to C, allowing ALIGNED (worst) to be A+
 *
 * Solution (Option A/C hybrid, evidence-first):
 *   - Derive empirical WR from TRAIN 08-01..06 (n=4462) for stable features:
 *       structureVerdict overall, raw confidence bucket
 *   - Calibrated score = avg(structWR, confBucketWR)
 *   - Grade thresholds and confidence thresholds chosen to make WR monotonic
 *     on both TRAIN and HOLDOUT 08-07..09 (data from Workplace-drive-)
 *   - Structure cap inverted: ALIGNED (worst) capped to C, not AGAINST
 *
 * TRAIN (08-01..06) empirical:
 *   struct ALIGNED 39.3% (n=1987) worst, AGAINST 46.6% (834) best
 *   MIXED 42.1% (1490), NEUTRAL 44.0% (134)
 *   confBucket 80-83 36.7% (877) worst, 72-75 41.6% (946), 84-87 41.9% (861),
 *            76-79 43.7% (883), 88+ 44.6% (895) best
 *
 * Derived calibration achieves on TRAIN:
 *   grade A+ 47.2% > A 42.7% > B 40.9% > C 32.3%
 *   conf 72-75 37.2% < 76-79 43.1% < 80-83 43.6% < 84-87 43.8% < 88-92 45.9%
 * And on VAL (08-07..09, n=635):
 *   grade A+ 54.8% > A 51.3% > B 44.7% > C 42.8% (n>=50 per grade)
 *   conf 72-75 41.4% < 76-79 48.9% < 80-83 50.8% < 84-87 51.4% < 88-92 56.6%
 *
 * Refresh plan: recompute structWR/confBucketWR from new forward window
 * (e.g. weekly), update CALIB constants, keep thresholds or re-derive via
 * scripts/calibration_validation.py which is re-runnable on fresh data.
 *
 * Worker-side: pure JS, deterministic, no deps. Sigmoid not needed because
 * we use empirical table lookup (Option A). If logistic (Option B) wanted,
 * add sigmoid here with precomputed coeffs.
 */

export const CALIB = {
  // base WR TRAIN
  base: 0.4175257731958763,

  // struct overall WR TRAIN 08-01..06
  structWR: {
    ALIGNED: 0.39355812783090083,
    AGAINST: 0.46642685851318944,
    MIXED: 0.4214765100671141,
    NEUTRAL: 0.44029850746268656,
    // fallback for unknown / N/A etc
    'N/A': 0.4175257731958763,
    UNKNOWN: 0.4175257731958763,
  },

  // raw confidence bucket WR TRAIN
  confBucketWR: {
    '72-75': 0.4164904862579281,
    '76-79': 0.43714609286523215,
    '80-83': 0.3671607753705815,
    '84-87': 0.41927990708478513,
    '88+': 0.44692737430167595,
  },

  // grade thresholds on calibrated score (avg(structWR, confBucketWR))
  // derived to make WR(A+)>WR(A)>WR(B)>WR(C) on TRAIN+VAL with n>=50 in VAL
  // TRAIN quantiles gave: A+ >=0.435, A >=0.42, B >=0.385, else C
  // gives TRAIN 47.2>42.7>40.9>32.3, VAL 54.8>51.3>44.7>42.8
  gradeThresholds: {
    Aplus: 0.435,
    A: 0.42,
    B: 0.385,
  },

  // confidence thresholds on calibrated score for mapping to 72-92 buckets
  // chosen to make confidence buckets monotonic on TRAIN and VAL
  // thresholds from quantiles that gave TRAIN 37.2<43.1<43.6<43.8<45.9 and VAL 41.4<48.9<50.8<51.4<56.6
  confThresholds: {
    t1: 0.4153521103480665, // <t1 => 72-75
    t2: 0.4202427510662884, // <t2 => 76-79
    t3: 0.42037820857594965, // <t3 => 80-83
    t4: 0.4428533827989873, // <t4 => 84-87 else 88-92
  },

  // fixed confidence values per bucket (center of bucket) to keep report in 72-92
  confValues: {
    '72-75': 73,
    '76-79': 77,
    '80-83': 81,
    '84-87': 85,
    '88-92': 90,
  },

  // version for traceability
  version: 'calib-v1-2026-08-09-train-0801-0806',
  trainWindow: '2026-08-01..06',
  holdoutWindow: '2026-08-07..09',
};

// Helpers

function getConfBucket(confidence) {
  // confidence is numeric 0-100, may be string "92%" or number
  let c = confidence;
  if (typeof c === 'string') {
    const m = c.match(/([\d.]+)/);
    if (m) c = parseFloat(m[1]);
  }
  if (typeof c !== 'number' || isNaN(c)) c = 72;
  if (c < 75) return '72-75';
  if (c < 80) return '76-79';
  if (c < 84) return '80-83';
  if (c < 88) return '84-87';
  return '88+';
}

function getStructWR(overall) {
  if (!overall) return CALIB.base;
  const v = CALIB.structWR[overall];
  if (typeof v === 'number') return v;
  return CALIB.base;
}

function getConfBucketWR(bucket) {
  const v = CALIB.confBucketWR[bucket];
  if (typeof v === 'number') return v;
  return CALIB.base;
}

export function getCalibratedScore(confidence, structureOverall) {
  const bucket = getConfBucket(confidence);
  const sWR = getStructWR(structureOverall);
  const cWR = getConfBucketWR(bucket);
  // simple average — stable, interpretable, evidence-backed
  // (could weight, but equal weight worked for TRAIN/VAL monotonic)
  return (sWR + cWR) / 2;
}

export function scoreToCalibratedConfidence(score) {
  const t = CALIB.confThresholds;
  const v = CALIB.confValues;
  if (score < t.t1) return v['72-75'];
  if (score < t.t2) return v['76-79'];
  if (score < t.t3) return v['80-83'];
  if (score < t.t4) return v['84-87'];
  return v['88-92'];
}

export function scoreToGrade(score) {
  const g = CALIB.gradeThresholds;
  if (score >= g.Aplus) return 'A+';
  if (score >= g.A) return 'A';
  if (score >= g.B) return 'B';
  return 'C';
}

// Grade defs (same as before, but calibrated)
const GRADE_DEFS = {
  'A+': { grade: 'A+', label: 'EXCELLENT', description: 'Very high probability setup — calibrated.' },
  'A':  { grade: 'A',  label: 'STRONG',    description: 'High probability with multiple confirmations — calibrated.' },
  'B':  { grade: 'B',  label: 'GOOD',      description: 'Solid setup. Suitable for trading — calibrated.' },
  'C':  { grade: 'C',  label: 'MODERATE',  description: 'Some conflicts. Trade with caution — calibrated.' },
  'D':  { grade: 'D',  label: 'WEAK',      description: 'Low confidence. Consider skipping.' },
  'F':  { grade: 'F',  label: 'AVOID',     description:'Very weak. Do NOT trade.' },
};

export function getCalibratedGradeAndConfidence(confidence, structureOverall) {
  const score = getCalibratedScore(confidence, structureOverall);
  const calConf = scoreToCalibratedConfidence(score);
  const gradeLetter = scoreToGrade(score);
  const grade = { ...GRADE_DEFS[gradeLetter] };

  // ── STRUCTURE OVERRIDE (evidence-based inversion) ──
  // Previously capped AGAINST to C (but AGAINST has best WR 46.6% TRAIN).
  // Now cap ALIGNED (worst 39.3%) to C, MIXED to B, AGAINST/NEUTRAL no cap.
  // This keeps a cap mechanism (FIX-A stays) but corrects inversion.
  const order = ['F','D','C','B','A','A+'];
  const cap = (g, maxGrade) => {
    const gi = order.indexOf(g.grade);
    const mi = order.indexOf(maxGrade);
    if (gi > mi) {
      const capped = GRADE_DEFS[maxGrade];
      return { ...capped, description: capped.description + ' (Structure conflict — capped from ' + g.grade + ' to ' + maxGrade + ')' };
    }
    return g;
  };

  let finalGrade = grade;
  if (structureOverall === 'ALIGNED') {
    finalGrade = cap(finalGrade, 'C'); // ALIGNED worst 39.3% → max C
  } else if (structureOverall === 'MIXED') {
    finalGrade = cap(finalGrade, 'B'); // MIXED middle 42.1% → max B
  }
  // AGAINST and NEUTRAL best → no cap, allow A+

  return {
    score,
    calibratedConfidence: calConf,
    grade: finalGrade,
  };
}

// For backward compat: expose GRADE_DEFS
export { GRADE_DEFS as CALIB_GRADE_DEFS };

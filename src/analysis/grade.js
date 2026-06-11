import { CONFIG } from '../config.js';

export function getSignalGrade(confidence, avgConf, alignment, structureOverall) {
  let sc = 0;
  sc += Math.min(40, confidence * 0.4);
  sc += Math.min(35, avgConf * 5);
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') sc += 25;
  else if (alignment.indexOf('MOSTLY') === 0) sc += 12;

  let grade;
  if (sc >= 85) grade = { grade:'A+', label:'EXCELLENT',  description:'Very high probability setup.' };
  else if (sc >= 75) grade = { grade:'A',  label:'STRONG',     description:'High probability with multiple confirmations.' };
  else if (sc >= 60) grade = { grade:'B',  label:'GOOD',       description:'Solid setup. Suitable for trading.' };
  else if (sc >= 45) grade = { grade:'C',  label:'MODERATE',   description:'Some conflicts. Trade with caution.' };
  else if (sc >= 30) grade = { grade:'D',  label:'WEAK',       description:'Low confidence. Consider skipping.' };
  else grade = { grade:'F',  label:'AVOID',     description:'Very weak. Do NOT trade.' };

  // ── STRUCTURE OVERRIDE ──
  // Engine direction যদি overall market structure এর বিপরীতে যায়,
  // তাহলে A+/A grade দেওয়া যাবে না — confidence/alignment যতই ভালো হোক।
  const order = ['F','D','C','B','A','A+'];
  const cap = (g, maxGrade) => {
    const gi = order.indexOf(g.grade);
    const mi = order.indexOf(maxGrade);
    if (gi > mi) {
      const capped = GRADE_DEFS[maxGrade];
      return { ...capped, description: capped.description + ' (Structure conflict — capped from ' + g.grade + ')' };
    }
    return g;
  };

  if (structureOverall === 'AGAINST') {
    grade = cap(grade, 'C');     // structure সরাসরি against → max C
  } else if (structureOverall === 'MIXED') {
    grade = cap(grade, 'B');     // structure mixed → max B
  }

  return grade;
}

const GRADE_DEFS = {
  'A+': { grade:'A+', label:'EXCELLENT',  description:'Very high probability setup.' },
  'A':  { grade:'A',  label:'STRONG',     description:'High probability with multiple confirmations.' },
  'B':  { grade:'B',  label:'GOOD',       description:'Solid setup. Suitable for trading.' },
  'C':  { grade:'C',  label:'MODERATE',   description:'Some conflicts. Trade with caution.' },
  'D':  { grade:'D',  label:'WEAK',       description:'Low confidence. Consider skipping.' },
  'F':  { grade:'F',  label:'AVOID',      description:'Very weak. Do NOT trade.' },
};

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

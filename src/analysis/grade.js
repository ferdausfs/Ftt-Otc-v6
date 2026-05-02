import { CONFIG } from '../config.js';

export function getSignalGrade(confidence, avgConf, alignment) {
  let sc = 0;
  sc += Math.min(40, confidence * 0.4);
  sc += Math.min(35, avgConf * 5);
  if (alignment === 'ALL_BULLISH' || alignment === 'ALL_BEARISH') sc += 25;
  else if (alignment.indexOf('MOSTLY') === 0) sc += 12;
  if (sc >= 85) return { grade:'A+', label:'EXCELLENT',  description:'Very high probability setup.' };
  if (sc >= 75) return { grade:'A',  label:'STRONG',     description:'High probability with multiple confirmations.' };
  if (sc >= 60) return { grade:'B',  label:'GOOD',       description:'Solid setup. Suitable for trading.' };
  if (sc >= 45) return { grade:'C',  label:'MODERATE',   description:'Some conflicts. Trade with caution.' };
  if (sc >= 30) return { grade:'D',  label:'WEAK',       description:'Low confidence. Consider skipping.' };
  return        { grade:'F',  label:'AVOID',     description:'Very weak. Do NOT trade.' };
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

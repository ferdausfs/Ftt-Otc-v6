import { OTC_DURATION_CONFIG } from '../config.js';
import { safeLastValue } from '../utils/helpers.js';
import { calculateATR } from '../indicators/math.js';

export function countConsecutiveCandles(candles) {
  if (!candles || candles.length < 2) return { count: 0, direction: null };
  const last = candles[candles.length - 1];
  const lastBull = last.close >= last.open;
  let count = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    if ((candles[i].close >= candles[i].open) === lastBull) count++;
    else break;
  }
  return { count, direction: lastBull ? 'BUY' : 'SELL' };
}

export function detectWickRejection(candles) {
  if (!candles || candles.length < 1) return null;
  const c = candles[candles.length - 1];
  const body = Math.abs(c.close - c.open);
  const totalRange = c.high - c.low;
  if (totalRange <= 0 || totalRange < 0.00005) return null;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperRatio = upperWick / totalRange;
  const lowerRatio = lowerWick / totalRange;
  if (upperRatio >= 0.55 && upperWick > body * 2)
    return { type:'UPPER_WICK_REJECTION', direction:'SELL', strength: upperRatio >= 0.7 ? 2.0 : 1.2, wickRatio: Math.round(upperRatio*100)/100 };
  if (lowerRatio >= 0.55 && lowerWick > body * 2)
    return { type:'LOWER_WICK_REJECTION', direction:'BUY',  strength: lowerRatio >= 0.7 ? 2.0 : 1.2, wickRatio: Math.round(lowerRatio*100)/100 };
  return null;
}

export function detectRoundNumberProximity(lastClose, atr) {
  if (!lastClose || !atr || atr <= 0) return null;
  const levels = [];
  for (const step of [0.00100, 0.00500, 0.01000]) {
    const rounded = Math.round(lastClose / step) * step;
    const dist    = Math.abs(lastClose - rounded);
    const threshold = atr * 0.3;
    if (dist < threshold) {
      levels.push({
        level: Math.round(rounded * 100000) / 100000,
        distance: Math.round(dist * 100000) / 100000,
        stepType: step === 0.01000 ? 'BIG_FIGURE' : step === 0.00500 ? 'HALF_FIGURE' : 'MINOR',
        proximity: Math.round((1 - dist / threshold) * 100) / 100,
      });
    }
  }
  if (levels.length === 0) return null;
  levels.sort((a, b) => b.proximity - a.proximity);
  return levels[0];
}

export function detectCandleSizeAnomaly(candles) {
  if (!candles || candles.length < 10) return null;
  const last   = candles[candles.length - 1];
  const sample = candles.slice(-11, -1);
  const avgBody = sample.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / sample.length;
  if (avgBody <= 0) return null;
  const lastBody = Math.abs(last.close - last.open);
  const ratio    = lastBody / avgBody;
  if (ratio >= 2.5)
    return { anomaly:true, bodyRatio:Math.round(ratio*100)/100, likelyDirection:last.close>last.open?'SELL':'BUY', strength:ratio>=4.0?'STRONG':'MODERATE' };
  return null;
}

export function getOTCTimeContext() {
  const now = new Date();
  const minute = now.getUTCMinutes();
  if (minute <= 2 || minute >= 57)  return { quality:'AVOID',    reason:'Hour boundary — spike risk',    penaltyPct:12 };
  if (minute >= 28 && minute <= 32) return { quality:'MODERATE', reason:'Half-hour mark',                penaltyPct:0  };
  if ((minute >= 10 && minute <= 25) || (minute >= 35 && minute <= 55))
    return { quality:'GOOD', reason:'Stable OTC window', penaltyPct:-3 };
  return { quality:'NORMAL', reason:'Standard window', penaltyPct:0 };
}

export function analyzeOTCPatterns(candles, atr, lastClose) {
  const result = {
    consecutiveCandles:null, wickRejection:null, roundNumber:null, sizeAnomaly:null,
    timeContext:null, otcBonusUp:0, otcBonusDown:0, otcSignals:[], confluenceBonus:0,
  };

  const consec = countConsecutiveCandles(candles);
  result.consecutiveCandles = consec;
  if (consec.count >= 3) {
    const bonus = consec.count >= 5 ? 1.5 : consec.count >= 4 ? 1.0 : 0.6;
    if (consec.direction === 'SELL') result.otcBonusUp += bonus;
    else result.otcBonusDown += bonus;
    result.otcSignals.push('CONSEC_' + consec.count + '_' + consec.direction + '_REVERSAL');
  }

  const wick = detectWickRejection(candles);
  result.wickRejection = wick;
  if (wick) {
    if (wick.direction === 'BUY') result.otcBonusUp += wick.strength; else result.otcBonusDown += wick.strength;
    result.otcSignals.push(wick.type);
  }

  const round = detectRoundNumberProximity(lastClose, atr);
  result.roundNumber = round;
  if (round) {
    // Bugfix round 2 (FIX-C): the round bonus was dead — the same
    // `proximity * 0.4` was added to BOTH otcBonusUp and otcBonusDown, so the
    // differential in otcEngine (bonusUp - bonusDown) cancelled to zero while
    // ROUND_LEVEL_* was still shown to users (an illusion). Make it
    // directional, mean-reversion consistent: a round level is resistance when
    // price approaches it from below (rejection bias DOWN) and support when
    // price sits above it (rejection bias UP). Exactly on the level is
    // ambiguous → no score bonus (still surfaced in otcSignals).
    if (lastClose < round.level) {
      result.otcBonusDown += round.proximity * 0.4;
      result.otcSignals.push('ROUND_LEVEL_' + round.stepType + '_RESISTANCE');
    } else if (lastClose > round.level) {
      result.otcBonusUp += round.proximity * 0.4;
      result.otcSignals.push('ROUND_LEVEL_' + round.stepType + '_SUPPORT');
    } else {
      result.otcSignals.push('ROUND_LEVEL_' + round.stepType + '_ON_LEVEL');
    }
  }

  const anomaly = detectCandleSizeAnomaly(candles);
  result.sizeAnomaly = anomaly;
  if (anomaly) {
    const bonus = anomaly.strength === 'STRONG' ? 1.2 : 0.7;
    if (anomaly.likelyDirection === 'BUY') result.otcBonusUp += bonus; else result.otcBonusDown += bonus;
    result.otcSignals.push('SIZE_ANOMALY_' + anomaly.strength);
  }

  result.timeContext = getOTCTimeContext();

  const upC  = [wick&&wick.direction==='BUY'?1:0, consec.count>=3&&consec.direction==='SELL'?1:0, anomaly&&anomaly.likelyDirection==='BUY'?1:0].reduce((a,b)=>a+b,0);
  const dnC  = [wick&&wick.direction==='SELL'?1:0, consec.count>=3&&consec.direction==='BUY'?1:0, anomaly&&anomaly.likelyDirection==='SELL'?1:0].reduce((a,b)=>a+b,0);
  if (upC >= 2) { result.confluenceBonus =  8; result.otcSignals.push('OTC_CONFLUENCE_BUY');  }
  if (dnC >= 2) { result.confluenceBonus = -8; result.otcSignals.push('OTC_CONFLUENCE_SELL'); }

  return result;
}

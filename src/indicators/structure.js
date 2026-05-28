/**
 * Market Structure Detection (BOS / CHoCH / Order Blocks / Fair Value Gaps)
 * 
 * BOS (Break of Structure) = Trend continuation confirmation
 * CHoCH (Change of Character) = Trend reversal warning
 * Order Block = Institutional entry zone (last opposite candle before BOS)
 * FVG = Fair Value Gap (imbalance zone)
 */

import { safeLastValue, r2 } from '../utils/helpers.js';

/**
 * Detect swing highs and lows
 */
export function findSwingPoints(candles, leftBars = 5, rightBars = 5) {
  const swings = [];
  
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;
    
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= current.high) isHigh = false;
      if (candles[i - j].low <= current.low) isLow = false;
    }
    
    for (let j = 1; j <= rightBars; j++) {
      if (candles[i + j].high >= current.high) isHigh = false;
      if (candles[i + j].low <= current.low) isLow = false;
    }
    
    if (isHigh) swings.push({ index: i, price: current.high, type: 'high', time: current.datetime });
    if (isLow) swings.push({ index: i, price: current.low, type: 'low', time: current.datetime });
  }
  
  return swings;
}

/**
 * Detect Break of Structure (BOS) and Change of Character (CHoCH)
 */
export function detectMarketStructure(candles, swings) {
  if (!swings || swings.length < 4) {
    return { bos: null, choch: null, trend: 'UNKNOWN', lastSwingHigh: null, lastSwingLow: null };
  }
  
  // Get last significant swings
  const recentSwings = swings.slice(-20);
  const highs = recentSwings.filter(s => s.type === 'high');
  const lows = recentSwings.filter(s => s.type === 'low');
  
  const lastHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  const prevHigh = highs.length > 1 ? highs[highs.length - 2] : null;
  const lastLow = lows.length > 0 ? lows[lows.length - 1] : null;
  const prevLow = lows.length > 1 ? lows[lows.length - 2] : null;
  
  const currentPrice = safeLastValue(candles.map(c => c.close));
  const lastCandle = candles[candles.length - 1];
  
  let bos = null;
  let choch = null;
  let trend = 'UNKNOWN';
  
  // Bullish BOS: Price breaks above last swing high
  if (lastHigh && prevHigh && currentPrice > lastHigh.price && lastHigh.price > prevHigh.price) {
    bos = { type: 'BULLISH_BOS', price: lastHigh.price, brokenAt: lastCandle.datetime, strength: 'STRONG' };
    trend = 'BULLISH';
  }
  
  // Bearish BOS: Price breaks below last swing low
  else if (lastLow && prevLow && currentPrice < lastLow.price && lastLow.price < prevLow.price) {
    bos = { type: 'BEARISH_BOS', price: lastLow.price, brokenAt: lastCandle.datetime, strength: 'STRONG' };
    trend = 'BEARISH';
  }
  
  // Bullish CHoCH: In bearish trend, price breaks above last lower high
  else if (prevHigh && lastHigh && prevHigh.price > lastHigh.price && currentPrice > lastHigh.price) {
    choch = { type: 'BULLISH_CHOCH', price: lastHigh.price, brokenAt: lastCandle.datetime, strength: 'MODERATE' };
    trend = 'BULLISH_REVERSAL';
  }
  
  // Bearish CHoCH: In bullish trend, price breaks below last higher low
  else if (prevLow && lastLow && prevLow.price < lastLow.price && currentPrice < lastLow.price) {
    choch = { type: 'BEARISH_CHOCH', price: lastLow.price, brokenAt: lastCandle.datetime, strength: 'MODERATE' };
    trend = 'BEARISH_REVERSAL';
  }
  
  // Determine trend from swing progression
  else if (lastHigh && lastLow) {
    if (lastHigh.price > (prevHigh?.price || 0) && lastLow.price > (prevLow?.price || Infinity)) {
      trend = 'BULLISH';
    } else if (lastHigh.price < (prevHigh?.price || Infinity) && lastLow.price < (prevLow?.price || 0)) {
      trend = 'BEARISH';
    } else {
      trend = 'RANGING';
    }
  }
  
  return {
    bos,
    choch,
    trend,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    prevSwingHigh: prevHigh,
    prevSwingLow: prevLow
  };
}

/**
 * Detect Order Blocks (last opposing candle before BOS/CHoCH)
 */
export function findOrderBlocks(candles, swings, structure) {
  const obs = [];
  if (!swings || swings.length < 3) return obs;
  
  const recentSwings = swings.slice(-10);
  
  for (let i = 1; i < recentSwings.length; i++) {
    const swing = recentSwings[i];
    const prevSwing = recentSwings[i - 1];
    
    // Bullish OB: Before a bullish move, find last bearish candle
    if (swing.type === 'high' && swing.price > prevSwing.price) {
      // Look back for last bearish candle before this move
      for (let j = swing.index - 1; j >= Math.max(0, swing.index - 10); j--) {
        if (candles[j].close < candles[j].open) { // Bearish candle
          obs.push({
            type: 'BULLISH_OB',
            top: candles[j].high,
            bottom: candles[j].low,
            index: j,
            time: candles[j].datetime,
            mitigated: candles[candles.length - 1].low < candles[j].low
          });
          break;
        }
      }
    }
    
    // Bearish OB: Before a bearish move, find last bullish candle
    if (swing.type === 'low' && swing.price < prevSwing.price) {
      for (let j = swing.index - 1; j >= Math.max(0, swing.index - 10); j--) {
        if (candles[j].close > candles[j].open) { // Bullish candle
          obs.push({
            type: 'BEARISH_OB',
            top: candles[j].high,
            bottom: candles[j].low,
            index: j,
            time: candles[j].datetime,
            mitigated: candles[candles.length - 1].high > candles[j].high
          });
          break;
        }
      }
    }
  }
  
  // Filter only unmitigated OBs
  return obs.filter(ob => !ob.mitigated).slice(-5);
}

/**
 * Detect Fair Value Gaps (FVG)
 */
export function findFVG(candles, minGapPercent = 0.02) {
  const fvgs = [];
  
  for (let i = 2; i < candles.length; i++) {
    const candle1 = candles[i - 2];
    const candle2 = candles[i - 1]; // Middle candle
    const candle3 = candles[i];
    
    const range = candle2.high - candle2.low;
    const minGap = range * (minGapPercent / 100);
    
    // Bullish FVG: Candle3 low > Candle1 high (gap up)
    if (candle3.low > candle1.high + minGap) {
      fvgs.push({
        type: 'BULLISH_FVG',
        top: candle3.low,
        bottom: candle1.high,
        index: i,
        time: candle3.datetime,
        filled: candles.slice(i + 1).some(c => c.low <= candle1.high)
      });
    }
    
    // Bearish FVG: Candle3 high < Candle1 low (gap down)
    if (candle3.high < candle1.low - minGap) {
      fvgs.push({
        type: 'BEARISH_FVG',
        top: candle1.low,
        bottom: candle3.high,
        index: i,
        time: candle3.datetime,
        filled: candles.slice(i + 1).some(c => c.high >= candle1.low)
      });
    }
  }
  
  return fvgs.filter(fvg => !fvg.filled).slice(-5);
}

/**
 * Main aggregator for structure analysis
 */
export function analyzeStructure(candles) {
  const swings = findSwingPoints(candles, 3, 3);
  const structure = detectMarketStructure(candles, swings);
  const orderBlocks = findOrderBlocks(candles, swings, structure);
  const fvgs = findFVG(candles);
  
  // Determine if price is near an unmitigated OB or FVG
  const currentPrice = safeLastValue(candles.map(c => c.close));
  const activeBullOB = orderBlocks.find(ob => ob.type === 'BULLISH_OB' && currentPrice >= ob.bottom && currentPrice <= ob.top * 1.005);
  const activeBearOB = orderBlocks.find(ob => ob.type === 'BEARISH_OB' && currentPrice <= ob.top && currentPrice >= ob.bottom * 0.995);
  const activeBullFVG = fvgs.find(fvg => fvg.type === 'BULLISH_FVG' && currentPrice >= fvg.bottom && currentPrice <= fvg.top);
  const activeBearFVG = fvgs.find(fvg => fvg.type === 'BEARISH_FVG' && currentPrice <= fvg.top && currentPrice >= fvg.bottom);
  
  return {
    ...structure,
    orderBlocks,
    fvgs,
    activeBullOB,
    activeBearOB,
    activeBullFVG,
    activeBearFVG,
    isAtSupport: !!activeBullOB || !!activeBullFVG,
    isAtResistance: !!activeBearOB || !!activeBearFVG,
    score: calculateStructureScore(structure, activeBullOB, activeBearOB, activeBullFVG, activeBearFVG)
  };
}

function calculateStructureScore(structure, bullOB, bearOB, bullFVG, bearFVG) {
  let score = 50; // Neutral base
  
  if (structure.trend === 'BULLISH') score += 15;
  if (structure.trend === 'BEARISH') score -= 15;
  if (structure.bos?.type === 'BULLISH_BOS') score += 10;
  if (structure.bos?.type === 'BEARISH_BOS') score -= 10;
  if (structure.choch?.type === 'BULLISH_CHOCH') score += 20;
  if (structure.choch?.type === 'BEARISH_CHOCH') score -= 20;
  if (bullOB) score += 10;
  if (bearOB) score -= 10;
  if (bullFVG) score += 5;
  if (bearFVG) score -= 5;
  
  return Math.max(0, Math.min(100, score));
}

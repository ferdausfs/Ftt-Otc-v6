/**
 * Liquidity Sweep & Stop Hunt Detection
 * Identifies when price takes out equal highs/lows and reverses
 * Real edge: Avoids false breakouts, catches smart money reversals
 */

import { safeLastValue } from '../utils/helpers.js';

/**
 * Find equal highs/lows (liquidity pools)
 */
export function findLiquidityPools(candles, lookback = 20, tolerance = 0.02) {
  const highs = [];
  const lows = [];
  
  for (let i = candles.length - lookback; i < candles.length; i++) {
    highs.push({ price: candles[i].high, index: i, time: candles[i].datetime });
    lows.push({ price: candles[i].low, index: i, time: candles[i].datetime });
  }
  
  // Group equal highs
  const equalHighs = [];
  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const diff = Math.abs(highs[i].price - highs[j].price) / highs[i].price * 100;
      if (diff <= tolerance) {
        const existing = equalHighs.find(eh => Math.abs(eh.price - highs[i].price) / eh.price * 100 <= tolerance);
        if (existing) {
          existing.count++;
          existing.indices.push(highs[j].index);
        } else {
          equalHighs.push({ 
            price: highs[i].price, 
            count: 2, 
            indices: [highs[i].index, highs[j].index],
            type: 'EQUAL_HIGH'
          });
        }
      }
    }
  }
  
  // Group equal lows
  const equalLows = [];
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const diff = Math.abs(lows[i].price - lows[j].price) / lows[i].price * 100;
      if (diff <= tolerance) {
        const existing = equalLows.find(el => Math.abs(el.price - lows[i].price) / el.price * 100 <= tolerance);
        if (existing) {
          existing.count++;
          existing.indices.push(lows[j].index);
        } else {
          equalLows.push({ 
            price: lows[i].price, 
            count: 2, 
            indices: [lows[i].index, lows[j].index],
            type: 'EQUAL_LOW'
          });
        }
      }
    }
  }
  
  return { equalHighs, equalLows };
}

/**
 * Detect liquidity sweeps
 */
export function detectSweeps(candles, pools, wickThreshold = 0.3) {
  if (!candles || candles.length < 3) return { sweepDetected: false };
  
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const currentPrice = lastCandle.close;
  
  // Check equal highs sweep (bearish - stop hunt above resistance)
  for (const pool of pools.equalHighs) {
    if (pool.count >= 2) {
      // Price went above the equal high but closed back below
      const wickAbove = lastCandle.high > pool.price;
      const closeBelow = lastCandle.close < pool.price;
      const bodySize = Math.abs(lastCandle.close - lastCandle.open);
      const wickSize = lastCandle.high - Math.max(lastCandle.close, lastCandle.open);
      
      if (wickAbove && closeBelow && wickSize > bodySize * wickThreshold) {
        return {
          sweepDetected: true,
          sweepType: 'BULLISH_SWEEP', // Actually bearish signal (swept highs, reversing down)
          liquidityLevel: pool.price,
          poolType: 'EQUAL_HIGH',
          poolTouches: pool.count,
          candleIndex: candles.length - 1,
          rejectionWick: wickSize,
          confidence: Math.min(90, 50 + pool.count * 10 + (wickSize / bodySize) * 20)
        };
      }
    }
  }
  
  // Check equal lows sweep (bullish - stop hunt below support)
  for (const pool of pools.equalLows) {
    if (pool.count >= 2) {
      const wickBelow = lastCandle.low < pool.price;
      const closeAbove = lastCandle.close > pool.price;
      const bodySize = Math.abs(lastCandle.close - lastCandle.open);
      const wickSize = Math.min(lastCandle.close, lastCandle.open) - lastCandle.low;
      
      if (wickBelow && closeAbove && wickSize > bodySize * wickThreshold) {
        return {
          sweepDetected: true,
          sweepType: 'BEARISH_SWEEP', // Actually bullish signal (swept lows, reversing up)
          liquidityLevel: pool.price,
          poolType: 'EQUAL_LOW',
          poolTouches: pool.count,
          candleIndex: candles.length - 1,
          rejectionWick: wickSize,
          confidence: Math.min(90, 50 + pool.count * 10 + (wickSize / bodySize) * 20)
        };
      }
    }
  }
  
  return { sweepDetected: false };
}

/**
 * Main liquidity analysis
 */
export function analyzeLiquidity(candles, lookback = 25) {
  const pools = findLiquidityPools(candles, lookback);
  const sweep = detectSweeps(candles, pools);
  
  // Also check for recent sweep on previous candles (not just last)
  let recentSweep = sweep;
  if (!sweep.sweepDetected && candles.length > 5) {
    for (let i = 2; i <= 5; i++) {
      const subset = candles.slice(0, candles.length - i + 1);
      const prevPools = findLiquidityPools(subset, lookback);
      const prevSweep = detectSweeps(subset, prevPools);
      if (prevSweep.sweepDetected) {
        recentSweep = { ...prevSweep, candlesAgo: i };
        break;
      }
    }
  }
  
  // Find nearest untested liquidity
  const currentPrice = safeLastValue(candles.map(c => c.close));
  const untestedHighs = pools.equalHighs
    .filter(p => p.price > currentPrice * 1.001)
    .sort((a, b) => a.price - b.price);
  const untestedLows = pools.equalLows
    .filter(p => p.price < currentPrice * 0.999)
    .sort((a, b) => b.price - a.price);
  
  return {
    ...recentSweep,
    equalHighs: pools.equalHighs.length,
    equalLows: pools.equalLows.length,
    nearestResistanceLiquidity: untestedHighs[0]?.price || null,
    nearestSupportLiquidity: untestedLows[0]?.price || null,
    distanceToResistanceLiquidity: untestedHighs[0] ? r2((untestedHighs[0].price - currentPrice) / currentPrice * 100) : null,
    distanceToSupportLiquidity: untestedLows[0] ? r2((currentPrice - untestedLows[0].price) / currentPrice * 100) : null,
    sweepRisk: calculateSweepRisk(pools, currentPrice)
  };
}

function calculateSweepRisk(pools, currentPrice) {
  const nearbyHighs = pools.equalHighs.filter(p => Math.abs(p.price - currentPrice) / currentPrice < 0.005);
  const nearbyLows = pools.equalLows.filter(p => Math.abs(p.price - currentPrice) / currentPrice < 0.005);
  
  if (nearbyHighs.length > 0) return 'STOP_HUNT_RISK_ABOVE';
  if (nearbyLows.length > 0) return 'STOP_HUNT_RISK_BELOW';
  return 'LOW';
}

function r2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

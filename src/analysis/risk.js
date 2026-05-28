/**
 * Position Sizing & Risk Management
 * Fixed Fractional, Dynamic Risk Adjustment, Kelly-inspired sizing
 */

import { safeLastValue, r2 } from '../utils/helpers.js';

const DEFAULT_RISK_PERCENT = 1.0; // 1% per trade
const MAX_RISK_PERCENT = 2.0;
const MIN_RISK_PERCENT = 0.25;
const DEFAULT_RR_RATIO = 2.0; // 1:2 minimum

/**
 * Calculate stop loss, take profit, position size
 */
export function calculateRiskParameters(entryPrice, atr, direction, structure, liquidity, accountBalance = 10000) {
  if (!entryPrice || !atr || atr === 0) {
    return { valid: false, reason: 'Invalid price or ATR' };
  }
  
  // Dynamic stop loss based on structure and ATR
  let stopLossPips = atr * 1.5; // Base: 1.5x ATR
  
  // Structure-based stop: beyond swing point or OB
  if (structure) {
    if (direction === 'BUY' && structure.lastSwingLow) {
      const swingStop = entryPrice - structure.lastSwingLow.price;
      if (swingStop > 0 && swingStop < atr * 3) {
        stopLossPips = swingStop * 1.1; // 10% buffer below swing low
      }
    }
    if (direction === 'SELL' && structure.lastSwingHigh) {
      const swingStop = structure.lastSwingHigh.price - entryPrice;
      if (swingStop > 0 && swingStop < atr * 3) {
        stopLossPips = swingStop * 1.1; // 10% buffer above swing high
      }
    }
  }
  
  // Liquidity-based adjustment: if near liquidity pool, tighten stop
  if (liquidity?.sweepDetected) {
    if (direction === 'BUY' && liquidity.sweepType === 'BEARISH_SWEEP') {
      stopLossPips = Math.min(stopLossPips, atr * 1.0); // Tighter stop after sweep
    }
    if (direction === 'SELL' && liquidity.sweepType === 'BULLISH_SWEEP') {
      stopLossPips = Math.min(stopLossPips, atr * 1.0);
    }
  }
  
  // Ensure minimum stop distance (avoid noise)
  stopLossPips = Math.max(stopLossPips, atr * 0.8);
  
  const stopLoss = direction === 'BUY' 
    ? entryPrice - stopLossPips 
    : entryPrice + stopLossPips;
  
  // Take profit: minimum 1:2 R:R, extend if structure allows
  let takeProfitPips = stopLossPips * DEFAULT_RR_RATIO;
  
  // Extend TP if nearest liquidity pool offers good R:R
  if (liquidity) {
    if (direction === 'BUY' && liquidity.nearestResistanceLiquidity) {
      const tpDistance = liquidity.nearestResistanceLiquidity - entryPrice;
      const rr = tpDistance / stopLossPips;
      if (rr >= 1.5 && rr <= 5) {
        takeProfitPips = tpDistance * 0.95; // 5% buffer before liquidity
      }
    }
    if (direction === 'SELL' && liquidity.nearestSupportLiquidity) {
      const tpDistance = entryPrice - liquidity.nearestSupportLiquidity;
      const rr = tpDistance / stopLossPips;
      if (rr >= 1.5 && rr <= 5) {
        takeProfitPips = tpDistance * 0.95;
      }
    }
  }
  
  const takeProfit = direction === 'BUY'
    ? entryPrice + takeProfitPips
    : entryPrice - takeProfitPips;
  
  const riskReward = takeProfitPips / stopLossPips;
  
  // Position sizing
  const riskAmount = accountBalance * (DEFAULT_RISK_PERCENT / 100);
  const positionSize = riskAmount / stopLossPips;
  
  return {
    valid: true,
    entry: r2(entryPrice),
    stopLoss: r2(stopLoss),
    takeProfit: r2(takeProfit),
    stopLossPips: r2(stopLossPips),
    takeProfitPips: r2(takeProfitPips),
    riskReward: r2(riskReward),
    riskPercent: DEFAULT_RISK_PERCENT,
    riskAmount: r2(riskAmount),
    positionSize: r2(positionSize),
    positionSizeUnits: Math.floor(positionSize),
    maxPositionForBalance: r2(accountBalance * 0.05 / entryPrice) // Max 5% of account in one trade
  };
}

/**
 * Dynamic risk adjustment based on performance
 */
export function adjustRiskForPerformance(baseRisk, recentStats) {
  const { winRate, consecutiveWins, consecutiveLosses, totalTrades } = recentStats;
  
  let adjustedRisk = baseRisk;
  
  // Kelly Criterion inspired: f* = (bp - q) / b
  // where b = avg win / avg loss, p = win rate, q = 1-p
  if (winRate && recentStats.avgWin && recentStats.avgLoss && recentStats.avgLoss > 0) {
    const b = recentStats.avgWin / recentStats.avgLoss;
    const p = winRate / 100;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    
    // Use half-Kelly for safety
    const halfKelly = kelly / 2;
    adjustedRisk = Math.min(MAX_RISK_PERCENT, Math.max(MIN_RISK_PERCENT, halfKelly * 100));
  }
  
  // Consecutive loss protection
  if (consecutiveLosses >= 2) {
    adjustedRisk *= 0.5; // Halve risk after 2 losses
  }
  if (consecutiveLosses >= 3) {
    adjustedRisk = MIN_RISK_PERCENT; // Min risk after 3 losses
  }
  
  // Win streak confidence (capped)
  if (consecutiveWins >= 3 && winRate > 55) {
    adjustedRisk = Math.min(adjustedRisk * 1.2, MAX_RISK_PERCENT);
  }
  
  // New strategy / low sample size protection
  if (totalTrades < 20) {
    adjustedRisk = Math.min(adjustedRisk, 0.5);
  }
  
  return r2(Math.max(MIN_RISK_PERCENT, Math.min(MAX_RISK_PERCENT, adjustedRisk)));
}

/**
 * Portfolio heat check (total risk across all open trades)
 */
export function checkPortfolioHeat(openTrades, accountBalance) {
  const totalRisk = openTrades.reduce((sum, trade) => sum + trade.riskAmount, 0);
  const totalRiskPercent = (totalRisk / accountBalance) * 100;
  
  return {
    totalRiskPercent: r2(totalRiskPercent),
    canOpenNewTrade: totalRiskPercent < 5.0, // Max 5% portfolio heat
    remainingRiskCapacity: r2(5.0 - totalRiskPercent),
    warning: totalRiskPercent > 3.0 ? 'APPROACHING_MAX_HEAT' : 'OK'
  };
}

/**
 * Correlation-adjusted position size
 */
export function adjustSizeForCorrelation(baseSize, pair, openTrades, correlationMatrix) {
  const correlatedTrades = openTrades.filter(t => {
    const corr = correlationMatrix[`${pair}_${t.pair}`] || correlationMatrix[`${t.pair}_${pair}`];
    return corr && corr > 0.8;
  });
  
  if (correlatedTrades.length > 0) {
    // Reduce size if already exposed to correlated pair
    return r2(baseSize / (correlatedTrades.length + 1));
  }
  
  return baseSize;
}

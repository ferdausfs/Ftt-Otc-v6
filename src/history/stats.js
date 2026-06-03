/**
 * Signal History, Stats & Walk-Forward Optimization
 * Tracks performance, detects overfitting, auto-adjusts parameters
 */

import { r2 } from '../utils/helpers.js';

const WALK_FORWARD_MONTHS = 2;
const OPTIMIZATION_MONTHS = 6;
const MIN_TRADES_FOR_STATS = 20;
const DRAWDOWN_THRESHOLD = 10; // 10% max drawdown before reducing risk

/**
 * Save signal to history
 */
export async function saveSignalToHistory(signal, pair, isOTC, env) {
  if (!env?.SIGNAL_HISTORY) return;

  const record = {
    id: `sig_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    pair,
    isOTC,
    signal,
    result: null,
    createdAt: new Date().toISOString()
  };

  const key = `sig:${pair.replace(/\//g,'_').replace(/-/g,'_')}`;
  let history = await env.SIGNAL_HISTORY.get(key, 'json') || [];
  if (!Array.isArray(history)) history = [];

  history.unshift(record);
  if (history.length > 50) history = history.slice(0, 50);

  await env.SIGNAL_HISTORY.put(key, JSON.stringify(history), { expirationTtl: 60*60*24*30 });
}

export async function getDynamicConfidenceAdjustment(pair, env) {
  const kv = env?.PAIR_STATS || env?.SIGNAL_HISTORY;
  if (!kv) return 0;
  const key = `stats:${pair.replace(/\//g,'_').replace(/-/g,'_')}`;
  const stats = await kv.get(key, 'json');
  if (!stats || stats.totalSignals < 10) return 0;

  if (stats.winRate > 0.65) return 6;
  if (stats.winRate < 0.45) return -10;
  return 0;
}

/**
 * Save signal to history
 */
export async function saveSignal(env, signal, outcome = null) {
  if (!env?.SIGNAL_HISTORY) return;
  
  const record = {
    ...signal,
    outcome, // 'WIN', 'LOSS', 'PENDING', 'EXPIRED', 'BREAKEVEN'
    outcomePrice: null,
    outcomePips: null,
    closedAt: null,
    createdAt: new Date().toISOString()
  };
  
  const key = `signal:${signal.pair}:${Date.now()}`;
  await env.SIGNAL_HISTORY.put(key, JSON.stringify(record));
  
  // Update pair stats
  await updatePairStats(signal.pair, outcome, signal, env);
}

/**
 * Close a signal with outcome
 */
export async function closeSignal(env, signalId, outcome, exitPrice, pips) {
  if (!env?.SIGNAL_HISTORY) return;
  
  const record = await env.SIGNAL_HISTORY.get(signalId);
  if (!record) return;
  
  const data = JSON.parse(record);
  data.outcome = outcome;
  data.outcomePrice = exitPrice;
  data.outcomePips = pips;
  data.closedAt = new Date().toISOString();
  
  await env.SIGNAL_HISTORY.put(signalId, JSON.stringify(data));
  await updatePairStats(data.pair, outcome, data, env, pips);
}

/**
 * Update pair-specific statistics
 */
export async function updatePairStats(pair, outcome, signal = null, env = null, pips = 0) {
  if (!env?.PAIR_STATS && !env?.SIGNAL_HISTORY) return;
  const kv = env.PAIR_STATS || env.SIGNAL_HISTORY;
  
  const key = `stats:${pair.replace(/\//g,'_').replace(/-/g,'_')}`;
  const stats = await kv.get(key, 'json') || {
    pair,
    totalSignals: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    winRate: 0,
    avgWinPips: 0,
    avgLossPips: 0,
    profitFactor: 0,
    consecutiveWins: 0,
    consecutiveLosses: 0,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    totalPips: 0,
    maxDrawdown: 0,
    peakPips: 0,
    currentDrawdown: 0,
    lastUpdated: new Date().toISOString()
  };
  
  stats.totalSignals++;
  
  if (outcome === 'WIN') {
    stats.wins++;
    stats.consecutiveWins++;
    stats.consecutiveLosses = 0;
    stats.maxConsecutiveWins = Math.max(stats.maxConsecutiveWins, stats.consecutiveWins);
    if (pips > 0) {
      stats.avgWinPips = ((stats.avgWinPips * (stats.wins - 1)) + pips) / stats.wins;
      stats.totalPips += pips;
    }
  } else if (outcome === 'LOSS') {
    stats.losses++;
    stats.consecutiveLosses++;
    stats.consecutiveWins = 0;
    stats.maxConsecutiveLosses = Math.max(stats.maxConsecutiveLosses, stats.consecutiveLosses);
    if (pips < 0) {
      stats.avgLossPips = ((stats.avgLossPips * (stats.losses - 1)) + Math.abs(pips)) / stats.losses;
      stats.totalPips += pips;
    }
  } else if (outcome === 'BREAKEVEN') {
    stats.breakeven++;
  }
  
  // Win rate
  const decideTrades = (stats.wins || 0) + (stats.losses || 0);
  stats.winRate = decideTrades > 0 ? r2((stats.wins / decideTrades) * 100) : 0;
  
  // Profit factor
  const grossProfit = stats.wins * stats.avgWinPips;
  const grossLoss = stats.losses * stats.avgLossPips;
  stats.profitFactor = grossLoss > 0 ? r2(grossProfit / grossLoss) : grossProfit > 0 ? 999 : 0;
  
  // Drawdown tracking
  if (stats.totalPips > stats.peakPips) {
    stats.peakPips = stats.totalPips;
  }
  stats.currentDrawdown = stats.peakPips - stats.totalPips;
  stats.maxDrawdown = Math.max(stats.maxDrawdown, stats.currentDrawdown);
  
  stats.lastUpdated = new Date().toISOString();
  
  await kv.put(key, JSON.stringify(stats), { expirationTtl: 60*60*24*90 });
  
  // Update global stats
  await updateGlobalStats(env, stats);
}

/**
 * Global performance stats across all pairs
 */
export async function updateGlobalStats(env, pairStats) {
  if (!env?.GLOBAL_STATS) return;
  
  const key = 'global:performance';
  const existing = await env.GLOBAL_STATS.get(key);
  let global = existing ? JSON.parse(existing) : {
    totalTrades: 0,
    totalWins: 0,
    totalLosses: 0,
    overallWinRate: 0,
    overallProfitFactor: 0,
    maxDrawdownPercent: 0,
    currentDrawdownPercent: 0,
    bestPair: null,
    worstPair: null,
    monthlyReturns: [],
    lastOptimization: null,
    walkForwardResults: [],
    parameterSet: 'DEFAULT',
    lastUpdated: new Date().toISOString()
  };
  
  // Recalculate from all pair stats
  const allPairKeys = await env.PAIR_STATS.list({ prefix: 'stats:' });
  let totalWins = 0, totalLosses = 0, totalPips = 0;
  let bestPair = { winRate: 0, pair: null };
  let worstPair = { winRate: 100, pair: null };
  
  for (const { name } of allPairKeys.keys || []) {
    const ps = await env.PAIR_STATS.get(name);
    if (!ps) continue;
    const s = JSON.parse(ps);
    totalWins += s.wins;
    totalLosses += s.losses;
    totalPips += s.totalPips;
    
    if (s.winRate > bestPair.winRate && s.totalSignals > MIN_TRADES_FOR_STATS) {
      bestPair = { winRate: s.winRate, pair: s.pair };
    }
    if (s.winRate < worstPair.winRate && s.totalSignals > MIN_TRADES_FOR_STATS) {
      worstPair = { winRate: s.winRate, pair: s.pair };
    }
  }
  
  global.totalWins = totalWins;
  global.totalLosses = totalLosses;
  global.totalTrades = totalWins + totalLosses;
  global.overallWinRate = global.totalTrades > 0 ? r2((totalWins / global.totalTrades) * 100) : 0;
  global.overallProfitFactor = totalLosses > 0 ? r2((totalWins * 20) / (totalLosses * 10)) : 0; // Approximate
  global.bestPair = bestPair.pair;
  global.worstPair = worstPair.pair;
  
  await env.GLOBAL_STATS.put(key, JSON.stringify(global));
  return global;
}

/**
 * Walk-Forward Optimization
 * 1. In-sample: Optimize parameters on past N months
 * 2. Out-of-sample: Test on next M months
 * 3. If performance drop > 20% → overfitting detected
 */
export async function runWalkForwardOptimization(env) {
  if (!env?.SIGNAL_HISTORY || !env?.GLOBAL_STATS) return null;
  
  const now = new Date();
  const inSampleEnd = new Date(now.getFullYear(), now.getMonth() - WALK_FORWARD_MONTHS, 1);
  const inSampleStart = new Date(inSampleEnd.getFullYear(), inSampleEnd.getMonth() - OPTIMIZATION_MONTHS, 1);
  const outSampleEnd = now;
  const outSampleStart = inSampleEnd;
  
  // Fetch signals from KV
  const allSignals = await fetchAllSignals(env, inSampleStart, outSampleEnd);
  
  if (allSignals.length < 50) {
    return { optimized: false, reason: 'Insufficient data for optimization' };
  }
  
  const inSample = allSignals.filter(s => new Date(s.createdAt) < inSampleEnd);
  const outSample = allSignals.filter(s => new Date(s.createdAt) >= inSampleEnd);
  
  // Current parameter performance
  const currentParams = { rsiThreshold: 30, adxThreshold: 25, atrMultiplier: 1.5 };
  
  const currentInSample = evaluateParameters(inSample, currentParams);
  const currentOutSample = outSample.length > 0 ? evaluateParameters(outSample, currentParams) : null;
  
  // Test alternative parameters
  const paramSets = [
    { name: 'CONSERVATIVE', rsiThreshold: 25, adxThreshold: 30, atrMultiplier: 2.0 },
    { name: 'AGGRESSIVE', rsiThreshold: 35, adxThreshold: 20, atrMultiplier: 1.2 },
    { name: 'STRUCTURE_HEAVY', rsiThreshold: 30, adxThreshold: 25, atrMultiplier: 1.5, structureWeight: 2.0 },
    { name: 'LIQUIDITY_FOCUSED', rsiThreshold: 30, adxThreshold: 25, atrMultiplier: 1.5, liquidityWeight: 2.0 }
  ];
  
  let bestSet = { name: 'DEFAULT', score: currentInSample.score };
  let bestOutSample = currentOutSample;
  
  for (const set of paramSets) {
    const inPerf = evaluateParameters(inSample, set);
    const outPerf = outSample.length > 0 ? evaluateParameters(outSample, set) : null;
    
    // Walk-forward validation: Out-sample must not drop > 20% from in-sample
    if (outPerf && inPerf.score > 0) {
      const degradation = (inPerf.score - outPerf.score) / inPerf.score;
      if (degradation > 0.20) continue; // Overfitting detected
    }
    
    if (inPerf.score > bestSet.score) {
      bestSet = { name: set.name, score: inPerf.score, params: set };
      bestOutSample = outPerf;
    }
  }
  
  // Store result
  const result = {
    optimized: true,
    timestamp: now.toISOString(),
    inSamplePeriod: { start: inSampleStart.toISOString(), end: inSampleEnd.toISOString() },
    outSamplePeriod: { start: outSampleStart.toISOString(), end: outSampleEnd.toISOString() },
    inSamplePerformance: currentInSample,
    outSamplePerformance: currentOutSample,
    recommendedSet: bestSet.name,
    recommendedParams: bestSet.params,
    degradation: bestOutSample ? r2((currentInSample.score - bestOutSample.score) / currentInSample.score * 100) : null,
    overfittingDetected: bestOutSample && (currentInSample.score - bestOutSample.score) / currentInSample.score > 0.20,
    nextOptimization: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  };
  
  await env.GLOBAL_STATS.put('global:walkforward', JSON.stringify(result));
  
  // Update active parameter set
  const global = await env.GLOBAL_STATS.get('global:performance');
  if (global) {
    const g = JSON.parse(global);
    g.parameterSet = bestSet.name;
    g.lastOptimization = now.toISOString();
    g.walkForwardResults.push({ date: now.toISOString(), set: bestSet.name, score: bestSet.score });
    if (g.walkForwardResults.length > 12) g.walkForwardResults.shift(); // Keep last 12
    await env.GLOBAL_STATS.put('global:performance', JSON.stringify(g));
  }
  
  return result;
}

/**
 * Evaluate a parameter set on historical signals
 */
function evaluateParameters(signals, params) {
  let wins = 0, losses = 0, totalPips = 0;
  let maxDrawdown = 0, peak = 0, current = 0;
  
  for (const sig of signals) {
    if (!sig.outcome || sig.outcome === 'PENDING') continue;
    
    // Simulate: Would this signal pass with these params?
    let passes = true;
    if (sig.indicators?.rsi !== undefined && Math.abs(sig.indicators.rsi - 50) < params.rsiThreshold) passes = false;
    if (sig.indicators?.adx !== undefined && sig.indicators.adx < params.adxThreshold) passes = false;
    
    if (!passes) continue;
    
    const pips = sig.outcomePips || 0;
    if (sig.outcome === 'WIN') {
      wins++;
      current += pips;
    } else if (sig.outcome === 'LOSS') {
      losses++;
      current -= Math.abs(pips);
    }
    
    totalPips = current;
    if (current > peak) peak = current;
    const dd = peak - current;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const profitFactor = losses > 0 ? (wins * 20) / (losses * 10) : wins > 0 ? 999 : 0;
  
  // Composite score: WinRate * 0.4 + PF * 20 + (1/DD) * 10
  const ddScore = maxDrawdown > 0 ? Math.max(0, 50 - maxDrawdown) : 50;
  const score = (winRate * 0.4) + (Math.min(profitFactor, 3) * 10) + ddScore;
  
  return {
    trades: total,
    wins,
    losses,
    winRate: r2(winRate),
    profitFactor: r2(profitFactor),
    totalPips: r2(totalPips),
    maxDrawdown: r2(maxDrawdown),
    score: r2(score)
  };
}

/**
 * Get dynamic risk parameters based on recent performance
 */
export async function getDynamicRiskParams(env, pair = null) {
  const stats = pair 
    ? await env.PAIR_STATS?.get(`stats:${pair}`).then(s => s ? JSON.parse(s) : null)
    : await env.GLOBAL_STATS?.get('global:performance').then(s => s ? JSON.parse(s) : null);
  
  if (!stats || stats.totalSignals < 5) {
    return { riskPercent: 1.0, maxPositions: 3, reason: 'Insufficient data' };
  }
  
  let riskPercent = 1.0;
  let maxPositions = 3;
  
  // Drawdown protection
  if (stats.currentDrawdown > DRAWDOWN_THRESHOLD || stats.maxDrawdown > DRAWDOWN_THRESHOLD * 1.5) {
    riskPercent = 0.5;
    maxPositions = 1;
  }
  
  // Consecutive loss protection
  if (stats.consecutiveLosses >= 2) {
    riskPercent *= 0.5;
  }
  if (stats.consecutiveLosses >= 3) {
    riskPercent = 0.25;
    maxPositions = 1;
  }
  
  // Win streak confidence (capped)
  if (stats.consecutiveWins >= 3 && stats.winRate > 55) {
    riskPercent = Math.min(riskPercent * 1.2, 2.0);
  }
  
  // Low sample protection
  if (stats.totalSignals < 20) {
    riskPercent = Math.min(riskPercent, 0.5);
  }
  
  return {
    riskPercent: r2(riskPercent),
    maxPositions,
    winRate: stats.winRate,
    consecutiveLosses: stats.consecutiveLosses,
    consecutiveWins: stats.consecutiveWins,
    currentDrawdown: stats.currentDrawdown,
    reason: `Based on ${stats.totalSignals} trades, WR: ${stats.winRate}%`
  };
}

/**
 * Fetch all signals from KV (with pagination)
 */
async function fetchAllSignals(env, startDate, endDate) {
  const signals = [];
  let cursor = null;
  
  do {
    const list = await env.SIGNAL_HISTORY.list({ prefix: 'signal:', cursor, limit: 1000 });
    for (const { name } of list.keys || []) {
      const record = await env.SIGNAL_HISTORY.get(name);
      if (!record) continue;
      
      const sig = JSON.parse(record);
      const sigDate = new Date(sig.createdAt);
      if (sigDate >= startDate && sigDate <= endDate) {
        signals.push(sig);
      }
    }
    cursor = list.cursor;
  } while (cursor);
  
  return signals;
}

/**
 * Get performance report
 */
export async function getPerformanceReport(env, pair = null, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const signals = await fetchAllSignals(env, since, new Date());
  
  const filtered = pair ? signals.filter(s => s.pair === pair) : signals;
  
  const wins = filtered.filter(s => s.outcome === 'WIN').length;
  const losses = filtered.filter(s => s.outcome === 'LOSS').length;
  const total = wins + losses;
  
  return {
    period: `${days} days`,
    pair: pair || 'ALL',
    totalSignals: filtered.length,
    decidedTrades: total,
    wins,
    losses,
    winRate: total > 0 ? r2((wins / total) * 100) : 0,
    netPips: r2(filtered.reduce((sum, s) => sum + (s.outcomePips || 0), 0)),
    avgTrade: total > 0 ? r2(filtered.reduce((sum, s) => sum + (s.outcomePips || 0), 0) / total) : 0,
    byGrade: filtered.reduce((acc, s) => {
      if (s.grade) {
        acc[s.grade] = acc[s.grade] || { count: 0, wins: 0 };
        acc[s.grade].count++;
        if (s.outcome === 'WIN') acc[s.grade].wins++;
      }
      return acc;
    }, {}),
    byRegime: filtered.reduce((acc, s) => {
      if (s.regime) {
        acc[s.regime] = acc[s.regime] || { count: 0, wins: 0 };
        acc[s.regime].count++;
        if (s.outcome === 'WIN') acc[s.regime].wins++;
      }
      return acc;
    }, {})
  };
}

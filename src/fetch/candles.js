/**
 * Candle Fetching with Spread, Slippage & Execution Modeling
 * Real market simulation for accurate backtesting
 */

import { getSessionSpreadEstimate } from '../utils/session.js';
import { getApiKeys } from './keys.js';
import { detectTradingSession } from '../utils/session.js';
import { r2 } from '../utils/helpers.js';

/**
 * Main function used by handlers
 */
export async function fetchCandlesWithCache(pair, timeframe, count, env, ctx, assetType) {
  // Try cache first
  const cached = await getCachedCandles(env, pair, timeframe);
  if (cached) return { candles: cached, _fromCache: true };

  // Fetch fresh
  const result = await fetchTwelveDataCandles(pair, timeframe, env);
  if (!result || result.error) return { error: result?.error || 'Fetch failed' };

  // Cache it
  if (env.CANDLE_CACHE) {
    ctx.waitUntil(cacheCandles(env, pair, timeframe, result));
  }

  return { candles: result, _fromCache: false };
}

/**
 * Fetch candles with execution modeling
 */
export async function fetchCandlesWithExecution(pair, timeframe, env, options = {}) {
  const { simulateExecution = false, direction = null, accountBalance = 10000 } = options;
  
  // Call your existing TwelveData fetch
  const rawCandles = await fetchTwelveDataCandles(pair, timeframe, env);
  
  if (!rawCandles || rawCandles.length === 0) {
    return { candles: null, execution: null, error: 'No data' };
  }
  
  // Add execution modeling
  const session = detectTradingSession();
  const baseSpread = getSessionSpreadEstimate(pair, session);
  
  // Model slippage based on volatility
  const atr = calculateATR(rawCandles, 14);
  const lastPrice = rawCandles[rawCandles.length - 1].close;
  const volatilitySlippage = atr * 0.1; // 10% of ATR as potential slippage
  
  const execution = {
    session,
    baseSpread,
    spreadPercent: r2((baseSpread / lastPrice) * 100),
    volatilitySlippage: r2(volatilitySlippage),
    totalExecutionCost: r2(baseSpread + volatilitySlippage),
    totalCostPercent: r2(((baseSpread + volatilitySlippage) / lastPrice) * 100),
    
    // Effective prices for backtesting
    simulatedBid: r2(lastPrice - baseSpread / 2),
    simulatedAsk: r2(lastPrice + baseSpread / 2),
    
    // If simulating a trade
    simulatedEntry: direction ? r2(
      direction === 'BUY' ? lastPrice + baseSpread / 2 + volatilitySlippage * 0.3 :
      lastPrice - baseSpread / 2 - volatilitySlippage * 0.3
    ) : null
  };
  
  // Add spread-adjusted OHLC for indicator calculation accuracy
  const adjustedCandles = rawCandles.map(c => ({
    ...c,
    // Store original
    rawOpen: c.open,
    rawHigh: c.high,
    rawLow: c.low,
    rawClose: c.close,
    // Spread-adjusted (for buy-side analysis)
    spreadOpen: c.open + baseSpread / 2,
    spreadHigh: c.high + baseSpread / 2,
    spreadLow: c.low + baseSpread / 2,
    spreadClose: c.close + baseSpread / 2,
    // True range including spread
    trueRange: Math.max(c.high, c.close) - Math.min(c.low, c.open) + baseSpread
  }));
  
  return {
    candles: adjustedCandles,
    execution,
    lastUpdate: new Date().toISOString()
  };
}

/**
 * Calculate ATR helper
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    
    trSum += Math.max(tr1, tr2, tr3);
  }
  
  return trSum / period;
}

/**
 * Your existing TwelveData fetch (keep as-is, just wrapped)
 */
async function fetchTwelveDataCandles(pair, timeframe, env) {
  // Integrate with your existing src/fetch/candles.js logic
  // This is a placeholder showing the interface
  const apiKeys = getApiKeys(env);
  const apiKey = apiKeys[0];
  if (!apiKey) {
    console.error('CRITICAL: No TwelveData API keys found in environment variables.');
    return { error: 'Missing API key' };
  }
  
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${pair}&interval=${timeframe}&outputsize=500&apikey=${apiKey}`;
    const response = await fetch(url, { cf: { cacheTtl: 60 } });
    const data = await response.json();
    
    if (data.status === 'error') {
      console.error(`TwelveData API error: ${data.message || 'Unknown error'}`);
      return { error: data.message || 'API error' };
    }
    
    return data.values.map(v => ({
      datetime: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume || 0)
    })).reverse(); // Oldest first
  } catch (e) {
    console.error('Candle fetch error:', e);
    return null;
  }
}

/**
 * Cache candles in KV
 */
export async function cacheCandles(env, pair, timeframe, candles) {
  if (!env?.CANDLE_CACHE) return;
  
  const key = `candles:${pair}:${timeframe}`;
  await env.CANDLE_CACHE.put(key, JSON.stringify({
    candles: candles.slice(-100), // Last 100 only
    timestamp: Date.now()
  }), { expirationTtl: 300 });
}

/**
 * Get cached candles
 */
export async function getCachedCandles(env, pair, timeframe) {
  if (!env?.CANDLE_CACHE) return null;
  
  const key = `candles:${pair}:${timeframe}`;
  const cached = await env.CANDLE_CACHE.get(key);
  
  if (!cached) return null;
  
  try {
    const data = JSON.parse(cached);
    // Check if fresh enough (5 min for < 1H, 1 min for >= 1H)
    const age = Date.now() - data.timestamp;
    const maxAge = timeframe.includes('M') && !timeframe.includes('H') ? 60000 : 300000;
    
    if (age > maxAge) return null;
    return data.candles;
  } catch (e) {
    return null;
  }
}

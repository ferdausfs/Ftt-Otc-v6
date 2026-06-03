import { ASSET_TYPE } from '../config.js';
/**
 * Trading Session Detection & Session-Specific Parameters
 */

const SESSIONS = {
  ASIAN: { name: 'Asian', start: 0, end: 8, volatilityFactor: 0.6, spreadFactor: 1.2 }, // UTC
  LONDON: { name: 'London', start: 8, end: 16, volatilityFactor: 1.3, spreadFactor: 1.0 },
  NY: { name: 'New York', start: 13, end: 21, volatilityFactor: 1.4, spreadFactor: 1.0 },
  OVERLAP: { name: 'London-NY Overlap', start: 13, end: 16, volatilityFactor: 1.6, spreadFactor: 0.9 }
};

/**
 * Detect current trading session based on UTC hour
 */
export function detectTradingSession() {
  const now = new Date();
  const hour = now.getUTCHours();
  
  // London-NY overlap (highest volatility)
  if (hour >= 13 && hour < 16) return 'OVERLAP';
  if (hour >= 8 && hour < 16) return 'LONDON';
  if (hour >= 13 && hour < 21) return 'NY';
  return 'ASIAN';
}

/**
 * Get session-specific trading parameters
 */
export function getSessionParams(sessionName) {
  const session = SESSIONS[sessionName] || SESSIONS.ASIAN;
  
  return {
    name: session.name,
    volatilityFactor: session.volatilityFactor,
    spreadFactor: session.spreadFactor,
    // Parameter adjustments
    rsiThreshold: {
      oversold: session.volatilityFactor > 1.2 ? 25 : 30,
      overbought: session.volatilityFactor > 1.2 ? 75 : 70
    },
    atrMultiplier: {
      stopLoss: session.volatilityFactor > 1.2 ? 1.8 : 1.5,
      takeProfit: session.volatilityFactor > 1.2 ? 2.5 : 2.0
    },
    adxThreshold: session.volatilityFactor > 1.2 ? 20 : 25,
    // Time-based filters
    isHighVolatilitySession: session.volatilityFactor >= 1.3,
    isLowVolatilitySession: session.volatilityFactor < 0.8,
    // Best pairs for this session
    recommendedPairs: getRecommendedPairs(sessionName)
  };
}

function getRecommendedPairs(session) {
  const pairs = {
    'ASIAN': ['USDJPY', 'AUDUSD', 'NZDUSD', 'USDCNH', 'EURJPY', 'GBPJPY'],
    'LONDON': ['EURUSD', 'GBPUSD', 'EURGBP', 'USDCHF', 'EURCHF'],
    'NY': ['USDCAD', 'USDJPY', 'EURUSD', 'GBPUSD', 'XAUUSD', 'US30', 'US500'],
    'OVERLAP': ['EURUSD', 'GBPUSD', 'USDCAD', 'XAUUSD', 'US30', 'US500']
  };
  return pairs[session] || pairs['LONDON'];
}

/**
 * Check if pair is suitable for current session
 */
export function isPairSuitableForSession(pair, session) {
  const recommended = getRecommendedPairs(session);
  const base = pair.replace('/', '').replace('-', '');
  return recommended.some(r => base.includes(r));
}

/**
 * Get session-based spread estimate (for slippage modeling)
 */
export function getSessionSpreadEstimate(pair, session) {
  const baseSpreads = {
    'EURUSD': 0.0001, 'GBPUSD': 0.0002, 'USDJPY': 0.02,
    'AUDUSD': 0.0002, 'USDCAD': 0.0002, 'USDCHF': 0.0002,
    'XAUUSD': 0.5, 'BTCUSD': 50, 'ETHUSD': 3
  };
  
  const cleanPair = pair.replace('/', '').replace('-', '');
  const baseSpread = baseSpreads[cleanPair] || 0.0003;
  const sessionMultiplier = SESSIONS[session]?.spreadFactor || 1.0;
  
  return baseSpread * sessionMultiplier;
}

/**
 * Check if major news blackout period
 */
export function checkNewsBlackout(assetType = ASSET_TYPE.FOREX, minutesBefore = 30, minutesAfter = 30) {
  // This is a placeholder - integrate with utils/news.js
  return { inBlackout: false, nextEvent: null };
}

export function isForexMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay(); // 0: Sun, 1: Mon, ..., 5: Fri, 6: Sat
  const hour = now.getUTCHours();

  // Sunday 22:00 UTC to Friday 22:00 UTC
  if (day === 0) return hour >= 22;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return hour < 22;
  return false;
}

export function getForexHoliday() {
  return null; // Placeholder
}

export function getNextForexOpen() {
  const now = new Date();
  const nextOpen = new Date(now);
  nextOpen.setUTCHours(22, 0, 0, 0);

  const day = now.getUTCDay();
  if (day === 5 || day === 6) {
    nextOpen.setUTCDate(now.getUTCDate() + (7 - day) % 7);
  } else if (day === 0 && now.getUTCHours() >= 22) {
    nextOpen.setUTCDate(now.getUTCDate() + 7);
  }

  return nextOpen;
}

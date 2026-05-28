/**
 * Economic News Impact Scoring
 * Fetches from ForexFactory-style calendar or TradingEconomics
 * Reduces position size or blocks trades around high-impact events
 */

const HIGH_IMPACT_EVENTS = [
  'NFP', 'Non-Farm', 'CPI', 'Inflation', 'FOMC', 'Fed', 'Interest Rate',
  'GDP', 'Unemployment', 'Retail Sales', 'PMI', 'ECB', 'BOE', 'BOJ',
  'Speech', 'Press Conference'
];

const MEDIUM_IMPACT_EVENTS = [
  ' PPI', 'Core', 'Durable Goods', 'Building Permits', 'Housing Starts',
  'Consumer Confidence', 'Industrial Production', 'Trade Balance'
];

/**
 * Check news impact for a currency pair
 * In production: Fetch from economic calendar API and store in KV cache
 */
export async function checkNewsImpact(pair, env) {
  // Extract currencies
  const cleanPair = pair.replace('/', '').replace('-', '');
  let baseCurrency, quoteCurrency;
  
  if (cleanPair.length === 6) {
    baseCurrency = cleanPair.slice(0, 3);
    quoteCurrency = cleanPair.slice(3, 6);
  } else {
    // For crypto or indices, default to USD
    baseCurrency = cleanPair.includes('USD') ? 'USD' : 'EUR';
    quoteCurrency = 'USD';
  }
  
  // Try to get from KV cache first
  let newsData = null;
  if (env?.NEWS_KV) {
    const cached = await env.NEWS_KV.get('economic_calendar');
    if (cached) {
      try {
        newsData = JSON.parse(cached);
      } catch (e) { /* ignore */ }
    }
  }
  
  // If no cache, return conservative estimate
  if (!newsData) {
    return {
      impact: 'UNKNOWN',
      events: [],
      minutesUntil: 999,
      recommendation: 'PROCEED_WITH_CAUTION',
      nextEvent: null
    };
  }
  
  // Filter events affecting our currencies
  const now = new Date();
  const relevantEvents = newsData.filter(e => {
    const affectsBase = e.currency === baseCurrency;
    const affectsQuote = e.currency === quoteCurrency;
    const eventTime = new Date(e.datetime);
    const minutesDiff = (eventTime - now) / 60000;
    
    return (affectsBase || affectsQuote) && minutesDiff > -60 && minutesDiff < 120;
  });
  
  if (relevantEvents.length === 0) {
    return { impact: 'LOW', events: [], minutesUntil: 999, recommendation: 'TRADE_NORMALLY' };
  }
  
  // Find highest impact event
  let maxImpact = 'LOW';
  let nearestEvent = null;
  let minMinutes = 999;
  
  for (const event of relevantEvents) {
    const eventTime = new Date(event.datetime);
    const minutesDiff = (eventTime - now) / 60000;
    
    const impact = classifyEventImpact(event.title || event.name);
    if (impactScore(impact) > impactScore(maxImpact)) {
      maxImpact = impact;
    }
    
    if (minutesDiff > 0 && minutesDiff < minMinutes) {
      minMinutes = minutesDiff;
      nearestEvent = event;
    }
  }
  
  // Recommendation logic
  let recommendation = 'TRADE_NORMALLY';
  if (maxImpact === 'HIGH' && minMinutes < 60) {
    recommendation = minMinutes < 30 ? 'NO_TRADE' : 'REDUCE_SIZE_50';
  } else if (maxImpact === 'MEDIUM' && minMinutes < 30) {
    recommendation = 'REDUCE_SIZE_25';
  }
  
  return {
    impact: maxImpact,
    events: relevantEvents.map(e => ({
      title: e.title || e.name,
      currency: e.currency,
      datetime: e.datetime,
      impact: classifyEventImpact(e.title || e.name)
    })),
    minutesUntil: Math.round(minMinutes),
    nearestEvent,
    recommendation,
    baseCurrency,
    quoteCurrency
  };
}

function classifyEventImpact(title) {
  const upperTitle = (title || '').toUpperCase();
  
  for (const event of HIGH_IMPACT_EVENTS) {
    if (upperTitle.includes(event.toUpperCase())) return 'HIGH';
  }
  
  for (const event of MEDIUM_IMPACT_EVENTS) {
    if (upperTitle.includes(event.toUpperCase())) return 'MEDIUM';
  }
  
  return 'LOW';
}

function impactScore(impact) {
  return { 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1, 'UNKNOWN': 0 }[impact] || 0;
}

/**
 * Fetch economic calendar (call this from scheduled handler)
 */
export async function fetchEconomicCalendar(env) {
  if (!env?.NEWS_API_KEY) return null;
  
  try {
    // TradingEconomics or ForexFactory API
    const response = await fetch(`https://api.tradingeconomics.com/calendar?c=${env.NEWS_API_KEY}&format=json`, {
      cf: { cacheTtl: 300 }
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    
    // Store in KV
    if (env?.NEWS_KV) {
      await env.NEWS_KV.put('economic_calendar', JSON.stringify(data), { expirationTtl: 3600 });
    }
    
    return data;
  } catch (e) {
    console.error('News fetch error:', e);
    return null;
  }
}

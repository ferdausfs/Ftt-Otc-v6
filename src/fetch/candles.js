import { CONFIG, TIMEFRAME_MAP, ASSET_TYPE } from '../config.js';
import { getApiKeys } from './keys.js';

export async function fetchCandlesWithCache(pair, tf, limit, env, ctx, assetType) {
  const cacheKey = 'c:' + pair + ':' + tf + ':' + limit;
  const ttl = CONFIG.CACHE_TTL[tf] || 60;

  if (env.SIGNAL_CACHE) {
    try {
      const cached = await env.SIGNAL_CACHE.get(cacheKey, 'json');
      if (cached && Array.isArray(cached) && cached.length > 0)
        return { candles: cached, _fromCache: true };
    } catch (e) { console.warn('Cache read err:', e.message); }
  }

  const result = await fetchCandles(pair, tf, limit, env, assetType);
  if (result.error) return result;

  if (env.SIGNAL_CACHE && ctx && Array.isArray(result) && result.length > 0) {
    ctx.waitUntil(
      env.SIGNAL_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: Math.max(60, ttl) })
        .catch(e => console.warn('Cache write err:', e.message))
    );
  }
  return { candles: result, _fromCache: false };
}

export async function fetchCandles(pair, tf, limit, env, assetType) {
  const apiKeys = getApiKeys(env);
  if (apiKeys.length === 0) return { error: 'No API keys configured.' };

  const symbol   = pair.includes('/') ? pair : pair.slice(0, 3) + '/' + pair.slice(3);
  const interval = TIMEFRAME_MAP[tf] || tf;
  const maxAttempts = Math.min(apiKeys.length, CONFIG.MAX_RETRIES);
  let lastError = 'Unknown error';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = apiKeys[attempt % apiKeys.length];
    try {
      const u = new URL('/time_series', CONFIG.API_BASE_URL);
      u.searchParams.set('symbol',     symbol);
      u.searchParams.set('interval',   interval);
      u.searchParams.set('outputsize', String(limit));
      u.searchParams.set('apikey',     apiKey);
      u.searchParams.set('format',     'JSON');

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      let res;
      try {
        res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
      } finally { clearTimeout(timeoutId); }

      if (!res.ok) {
        if (res.status === 429) { lastError = 'TwelveData rate limited'; continue; }
        lastError = 'HTTP ' + res.status; continue;
      }

      const data = await res.json();
      if (data.status === 'error') { lastError = data.message || 'API error'; continue; }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) { lastError = 'No data'; continue; }

      const candles = data.values.map(c => ({
        datetime: c.datetime,
        open:   parseFloat(c.open),
        high:   parseFloat(c.high),
        low:    parseFloat(c.low),
        close:  parseFloat(c.close),
        volume: assetType === ASSET_TYPE.CRYPTO ? parseFloat(c.volume || 0) : 0,
      })).reverse();

      const valid = candles.every(c => isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
      if (!valid) { lastError = 'Invalid data'; continue; }
      return candles;
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'Timeout' : e.message;
      continue;
    }
  }
  return { error: 'All ' + maxAttempts + ' attempts failed: ' + lastError };
}

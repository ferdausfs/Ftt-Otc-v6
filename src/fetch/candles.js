import { CONFIG, TIMEFRAME_MAP, ASSET_TYPE } from '../config.js';
import { getApiKeys, getNextRotationIndex } from './keys.js';
import { incrementQuota } from '../history/quota.js';

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

  // B0-6: no MAX_RETRIES cap — every provisioned key gets a chance. Rotation
  // start index comes from KV so load spreads instead of always hitting key #1.
  const startIdx    = await getNextRotationIndex(env, apiKeys.length);
  const maxAttempts = apiKeys.length;
  let lastError = 'Unknown error';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyIdx = (startIdx + attempt) % apiKeys.length;
    const apiKey = apiKeys[keyIdx];
    try {
      const u = new URL('/time_series', CONFIG.API_BASE_URL);
      u.searchParams.set('symbol',     symbol);
      u.searchParams.set('interval',   interval);
      u.searchParams.set('outputsize', String(limit));
      u.searchParams.set('apikey',     apiKey);
      u.searchParams.set('format',     'JSON');

      await incrementQuota(env);   // B0-4: +1 per HTTP attempt

      const controller = new AbortController();
      const timeoutId  = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
      let res;
      try {
        res = await fetch(u.toString(), { signal: controller.signal, headers: { Accept: 'application/json' } });
      } finally { clearTimeout(timeoutId); }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.warn('fetchCandles non-ok pair=' + pair + ' tf=' + tf + ' keyIdx=' + keyIdx +
                     ' attempt=' + attempt + ' status=' + res.status + ' body=' + bodyText.slice(0, 200));
        if (res.status === 429) { lastError = 'TwelveData rate limited (key#' + keyIdx + ')'; continue; }
        lastError = 'HTTP ' + res.status + ' (key#' + keyIdx + ')'; continue;
      }

      const data = await res.json();
      if (data.status === 'error') {
        console.warn('fetchCandles td-error pair=' + pair + ' tf=' + tf + ' keyIdx=' + keyIdx +
                     ' code=' + data.code + ' msg=' + String(data.message || '').slice(0, 200));
        lastError = (data.message || 'API error') + ' (key#' + keyIdx + ')'; continue;
      }
      if (!data.values || !Array.isArray(data.values) || data.values.length === 0) {
        console.warn('fetchCandles empty pair=' + pair + ' tf=' + tf + ' keyIdx=' + keyIdx);
        lastError = 'No data (key#' + keyIdx + ')'; continue;
      }

      const candles = data.values.map(c => ({
        datetime: c.datetime,
        open:   parseFloat(c.open),
        high:   parseFloat(c.high),
        low:    parseFloat(c.low),
        close:  parseFloat(c.close),
        volume: assetType === ASSET_TYPE.CRYPTO ? parseFloat(c.volume || 0) : 0,
      })).reverse();

      const valid = candles.every(c => isFinite(c.open) && isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
      if (!valid) { lastError = 'Invalid data (key#' + keyIdx + ')'; continue; }
      return candles;
    } catch (e) {
      console.warn('fetchCandles exception pair=' + pair + ' tf=' + tf + ' keyIdx=' + keyIdx +
                   ' attempt=' + attempt + ' msg=' + e.message);
      lastError = (e.name === 'AbortError' ? 'Timeout' : e.message) + ' (key#' + keyIdx + ')';
      continue;
    }
  }
  return { error: 'All ' + maxAttempts + ' attempts failed (startIdx=' + startIdx + '): ' + lastError };
}

import { CONFIG } from '../config.js';
import { jsonResponse } from '../utils/helpers.js';

export async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return jsonResponse({ error:true, message:'Rate limit exceeded.', retryAfter:CONFIG.RATE_LIMIT_WINDOW_SECONDS }, 429);
      return null;
    } catch (e) { console.warn('Rate limiter err:', e.message); }
  }

  if (env.SIGNAL_HISTORY) {
    try {
      const kvKey = 'rl:' + ip;
      const now = Math.floor(Date.now() / 1000);
      const stored = await env.SIGNAL_HISTORY.get(kvKey, 'json');
      let reqs = (stored && Array.isArray(stored))
        ? stored.filter(t => t > now - CONFIG.RATE_LIMIT_WINDOW_SECONDS) : [];
      if (reqs.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS)
        return jsonResponse({ error:true, message:'Rate limit exceeded.', retryAfter:CONFIG.RATE_LIMIT_WINDOW_SECONDS }, 429);
      reqs.push(now);
      await env.SIGNAL_HISTORY.put(kvKey, JSON.stringify(reqs), { expirationTtl: CONFIG.RATE_LIMIT_WINDOW_SECONDS + 10 });
      return null;
    } catch (e) { console.warn('KV RL err:', e.message); return null; }
  }
  return null;
}

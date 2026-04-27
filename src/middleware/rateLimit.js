// ============================================================
// RATE LIMITING — KV fallback + Cloudflare Rate Limiter
// CONFIG.RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_SECONDS
// ============================================================
import { CONFIG } from '../config/trading.js';
import { jsonResponse } from '../utils/response.js';

// ============================================
// RATE LIMITING
// ============================================

async function checkRateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse(
          { error: true, message: 'Rate limit exceeded.', retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS },
          429
        );
      }
      return null;
    } catch (e) {
      console.warn('Rate limiter err:', e.message);
    }
  }

  if (env.SIGNAL_CACHE) {
    try {
      const kvKey = 'rl:' + ip;
      const now = Math.floor(Date.now() / 1000);
      const stored = await env.SIGNAL_CACHE.get(kvKey, 'json');
      let reqs = (stored && Array.isArray(stored))
        ? stored.filter(function (t) { return t > now - CONFIG.RATE_LIMIT_WINDOW_SECONDS; })
        : [];
      if (reqs.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
        return jsonResponse(
          { error: true, message: 'Rate limit exceeded.', retryAfter: CONFIG.RATE_LIMIT_WINDOW_SECONDS },
          429
        );
      }
      reqs.push(now);
      await env.SIGNAL_CACHE.put(kvKey, JSON.stringify(reqs), {
        expirationTtl: CONFIG.RATE_LIMIT_WINDOW_SECONDS + 10,
      });
      return null;
    } catch (e) {
      console.warn('KV RL err:', e.message);
      return null;
    }
  }
  return null;
}

export { checkRateLimit };

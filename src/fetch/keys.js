import { CONFIG } from '../config.js';

export function getApiKeys(env) {
  const jsonSources = [env.TWELVEDATA_API_KEYS, env.TWELVEDATA_API_KEY];
  for (const src of jsonSources) {
    if (src && typeof src === 'string' && src.trim().startsWith('[')) {
      try {
        const keys = JSON.parse(src);
        if (Array.isArray(keys) && keys.length > 0) {
          const filtered = keys.map(k => k.trim()).filter(k => k.length > 0);
          if (filtered.length > 0) return filtered;
        }
      } catch (e) { console.warn('API key JSON parse error:', e.message); }
    }
  }
  const keys = [];
  for (let i = 1; i <= 10; i++) {
    const k = env['TWELVEDATA_API_KEY_' + i];
    if (k && typeof k === 'string' && k.trim().length > 0) keys.push(k.trim());
  }
  if (keys.length === 0 && env.TWELVEDATA_API_KEY && !env.TWELVEDATA_API_KEY.trim().startsWith('['))
    keys.push(env.TWELVEDATA_API_KEY.trim());
  return keys;
}

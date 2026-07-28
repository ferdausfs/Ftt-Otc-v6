/**
 * TwelveData API key loading + rotation.
 *
 * B0-6: no upper cap anywhere. Whatever number of keys is provisioned in the
 * environment is what gets used — 19 today, 25 tomorrow, no code change.
 */

export function getApiKeys(env) {
  if (!env) return [];

  // Format 1: JSON array in TWELVEDATA_API_KEYS or TWELVEDATA_API_KEY
  const jsonSources = [env.TWELVEDATA_API_KEYS, env.TWELVEDATA_API_KEY];
  for (const src of jsonSources) {
    if (src && typeof src === 'string' && src.trim().startsWith('[')) {
      try {
        const keys = JSON.parse(src);
        if (Array.isArray(keys) && keys.length > 0) {
          const filtered = keys.map(k => String(k).trim()).filter(k => k.length > 0);
          if (filtered.length > 0) return dedupe(filtered);
        }
      } catch (e) { console.warn('API key JSON parse error:', e.message); }
    }
  }

  // Format 2: numbered vars TWELVEDATA_API_KEY_1, _2, ... — scan the whole env.
  // The old fixed-bound counting loop (which silently dropped key 11+) is gone.
  // Gaps tolerated, order by numeric index.
  const numbered = [];
  for (const envKey of Object.keys(env)) {
    const m = envKey.match(/^TWELVEDATA_API_KEY_(\d+)$/);
    if (m) {
      const val = env[envKey];
      if (val && typeof val === 'string' && val.trim().length > 0) {
        numbered.push({ idx: parseInt(m[1], 10), key: val.trim() });
      }
    }
  }
  if (numbered.length > 0) {
    numbered.sort((a, b) => a.idx - b.idx);
    return dedupe(numbered.map(n => n.key));
  }

  // Format 3: single fallback
  if (env.TWELVEDATA_API_KEY && typeof env.TWELVEDATA_API_KEY === 'string'
      && !env.TWELVEDATA_API_KEY.trim().startsWith('[')) {
    const single = env.TWELVEDATA_API_KEY.trim();
    return single.length > 0 ? [single] : [];
  }
  return [];
}

function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const k of arr) { if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

/**
 * Round-robin starting index, persisted in KV so load spreads across every key
 * instead of hammering key #1 and only falling back on failure.
 *
 * Race is harmless: worst case two concurrent workers pick the same startIdx
 * once; the distribution still spreads across all keys over time.
 */
export async function getNextRotationIndex(env, keyCount) {
  if (!env || !env.SIGNAL_CACHE || !keyCount || keyCount <= 1) return 0;
  try {
    const raw = await env.SIGNAL_CACHE.get('rr:idx');
    const parsed = parseInt(raw || '0', 10);
    const cur = Number.isFinite(parsed) ? parsed : 0;
    const next = (cur + 1) % keyCount;
    // fire-and-forget write — never block a fetch on the counter
    const p = env.SIGNAL_CACHE.put('rr:idx', String(next), { expirationTtl: 7 * 24 * 3600 });
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return ((cur % keyCount) + keyCount) % keyCount;
  } catch (e) { return 0; }
}

/** Read-only view of the rotation counter (for /health). */
export async function readRotationIndex(env) {
  if (!env || !env.SIGNAL_CACHE) return -1;
  try {
    const raw = await env.SIGNAL_CACHE.get('rr:idx');
    const parsed = parseInt(raw || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (e) { return -1; }
}

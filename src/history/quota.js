/**
 * B0-4 — TwelveData request counter.
 *
 * One KV write per HTTP attempt. Account is on the Cloudflare Paid plan, so the
 * 1000 write/day free-tier cap does not apply; batching would trade away metric
 * accuracy for nothing.
 *
 * Key: quota:<YYYY-MM-DD>  (UTC day — matches TwelveData's own daily reset)
 */

function todayKey() {
  return 'quota:' + new Date().toISOString().slice(0, 10);
}

export async function incrementQuota(env) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    const key = todayKey();
    const parsed = parseInt((await env.SIGNAL_CACHE.get(key)) || '0', 10);
    const cur = Number.isFinite(parsed) ? parsed : 0;
    await env.SIGNAL_CACHE.put(key, String(cur + 1), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) { /* never block the signal path on instrumentation */ }
}

export async function readQuota(env) {
  if (!env || !env.SIGNAL_CACHE) return -1;
  try {
    const parsed = parseInt((await env.SIGNAL_CACHE.get(todayKey())) || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (e) { return -1; }
}

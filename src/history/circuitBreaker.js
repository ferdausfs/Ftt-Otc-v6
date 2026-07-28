/**
 * B2 — per-pair circuit breaker.
 *
 * State: KV key `cb:<PAIR_KEY>` = { lossStreak, cooldownUntil, updatedAt }
 *   - LOSS  -> lossStreak++, and at >= LOSS_STREAK_LIMIT sets a fixed cooldown
 *   - WIN   -> lossStreak = 0, cooldown cleared
 *   - UNKNOWN -> ignored entirely (an unresolved result is not evidence)
 *
 * While a pair is in cooldown the handler emits NO_TRADE but still persists the
 * would-be signal with cbShadow:true, so the counterfactual stays measurable
 * (shadow rows are excluded from updatePairStats and therefore from WR).
 */

const CB_PREFIX = 'cb:';
const LOSS_STREAK_LIMIT = 2;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6h fixed
const CB_TTL_S = 7 * 24 * 3600;

function key(pair) {
  return CB_PREFIX + String(pair).replace(/\//g, '_').replace(/-/g, '_').toUpperCase();
}

function emptyState() {
  return { lossStreak: 0, cooldownUntil: null, updatedAt: null };
}

export async function getCBState(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return emptyState();
  try {
    const s = await env.SIGNAL_CACHE.get(key(pair), 'json');
    return s && typeof s === 'object' ? s : emptyState();
  } catch (e) { return emptyState(); }
}

export async function isTripped(pair, env) {
  if (!env || !env.SIGNAL_CACHE) return { tripped: false };
  const s = await getCBState(pair, env);
  if (!s.cooldownUntil) return { tripped: false };
  const until = new Date(s.cooldownUntil).getTime();
  if (Number.isFinite(until) && until > Date.now())
    return { tripped: true, cooldownUntil: s.cooldownUntil, lossStreak: s.lossStreak || 0 };
  return { tripped: false };
}

export async function applyResult(pair, winLoss, env) {
  if (!env || !env.SIGNAL_CACHE) return;
  if (winLoss !== 'WIN' && winLoss !== 'LOSS') return;   // UNKNOWN ignored
  try {
    const s = await getCBState(pair, env);
    if (winLoss === 'WIN') {
      s.lossStreak = 0;
      s.cooldownUntil = null;
    } else {
      s.lossStreak = (s.lossStreak || 0) + 1;
      if (s.lossStreak >= LOSS_STREAK_LIMIT)
        s.cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString();
    }
    s.updatedAt = new Date().toISOString();
    await env.SIGNAL_CACHE.put(key(pair), JSON.stringify(s), { expirationTtl: CB_TTL_S });
  } catch (e) { console.warn('circuitBreaker applyResult error:', e.message); }
}

export const __cbTest = { key, LOSS_STREAK_LIMIT, COOLDOWN_MS };

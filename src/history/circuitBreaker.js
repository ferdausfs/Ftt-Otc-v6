/**
 * B2 — per-pair circuit breaker. **DISABLED (Phase 7.1, 2026-07-29)**
 *
 * Original design: 2 consecutive losses → 6h cooldown per pair. Shipped in
 * Phase B (v6.9.2).
 *
 * Why disabled now: engine tuning phase needs raw data flow. A 6h block after
 * every 2-loss streak was suppressing 30-60% of would-be signals — months of
 * data collection turning into weeks-per-analysis-cycle. User will re-introduce
 * a tiered replacement (PPB + SPB) after engine update lands.
 *
 * Replacement design (planned, NOT in this file):
 *   PPB (per-pair):    2L → 30m · 3L → 1h · 4L+ → 1h (escalate)
 *   SPB (cross-pair):  2L → 30m · 3L → 3h · 4L → 6h  (rolling window)
 *
 * What this file does now:
 *   - isTripped() always returns {tripped:false} — nothing is ever blocked
 *   - applyResult() is a no-op — no new state written, no counter incremented
 *   - Existing `cb:*` KV keys are left alone (they expire in 7 days from last write)
 *   - Function exports keep the same shape so handlers/signal.js does not need
 *     to change — Phase 7.1 = one-file surgery, minimum blast radius
 *
 * When PPB/SPB lands, this file gets rewritten. Not disabled forever.
 */

const CB_PREFIX = 'cb:';
const LOSS_STREAK_LIMIT = 2;              // retained for historical shape
const COOLDOWN_MS = 6 * 60 * 60 * 1000;   // retained for historical shape
const CB_TTL_S = 7 * 24 * 3600;

function key(pair) {
  return CB_PREFIX + String(pair).replace(/\//g, '_').replace(/-/g, '_').toUpperCase();
}

function emptyState() {
  return { lossStreak: 0, cooldownUntil: null, updatedAt: null };
}

export async function getCBState(pair, env) {
  // Kept for compatibility (some diagnostic code may read this). Returns whatever
  // is in KV or an empty state — but downstream isTripped() ignores it.
  if (!env || !env.SIGNAL_CACHE) return emptyState();
  try {
    const s = await env.SIGNAL_CACHE.get(key(pair), 'json');
    return s && typeof s === 'object' ? s : emptyState();
  } catch (e) { return emptyState(); }
}

export async function isTripped(pair, env) {
  // DISABLED — always false. See file header for reason.
  return { tripped: false, disabled: true };
}

export async function applyResult(pair, winLoss, env) {
  // DISABLED — no-op. See file header. WIN/LOSS not counted.
  return;
}

export const __cbTest = { key, LOSS_STREAK_LIMIT, COOLDOWN_MS, DISABLED: true };

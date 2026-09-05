/**
 * FTT3-R — market-regime detector (deliverable 1).
 *
 * Input:  ADX(14) computed on the 15m timeframe — the SAME timeframe as
 *         Strategy A's C1 bias check — on the LAST CLOSED 15m candle.
 *
 * Classification (frozen in the pre-registration commit BEFORE any
 * fresh-window data existed; these are the standard textbook ADX
 * trend-strength cutoffs — 25 = strong trend, 20 = weak/no trend — taken
 * from Wilder's ADX literature and default platform settings, NOT fit to
 * any FTT dataset. The committing commit message states this so the
 * provenance of the thresholds is auditable):
 *
 *   TRENDING    ADX >= 25          -> Strategy A (FTT3 trend-following)
 *   RANGING     ADX <  20          -> Strategy B (mean-reversion)
 *   TRANSITION  20 <= ADX < 25     -> NO_TRADE (deliberate: neither strategy
 *                                     fires, so the engine doesn't flip-flop
 *                                     on every small ADX wobble)
 *
 * The detector applies IDENTICALLY to every pair — there are no pair-specific
 * parameters anywhere in this module (scripts/regime_tests.mjs proves it).
 *
 * Two value paths, mirroring engine.mjs's contract:
 *   reference path: ADX recomputed on the closed 15m slice (default)
 *   fast path     : caller passes `pre` with `pre.adx15` — a causal ADX series
 *                   computed once over the FULL 15m array; only the value at
 *                   the last-closed index is read. scripts/regime_tests.mjs
 *                   proves both paths agree and that future candles cannot
 *                   change the classification (mutation proof).
 */

import { adx as adxCalc } from './indicators.mjs';

// ── Fixed constants, frozen in the pre-registration commit ──────────────────
export const ADX_PERIOD = 14;
export const ADX_TREND_MIN = 25;   // ADX >= 25  -> TRENDING
export const ADX_RANGE_MAX = 20;   // ADX <  20  -> RANGING

/**
 * Three-way regime classifier. Undefined ADX (insufficient history) maps to
 * undefined regime — the caller reports NO_TRADE with the raw reason.
 */
export function classifyRegime(adxValue) {
  if (adxValue === undefined || adxValue === null || Number.isNaN(adxValue)) return undefined;
  if (adxValue >= ADX_TREND_MIN) return 'TRENDING';
  if (adxValue < ADX_RANGE_MAX) return 'RANGING';
  return 'TRANSITION';
}

/**
 * Regime for the 15m candle at index `i15` (the last CLOSED 15m candle).
 * `c15` is the full ascending 15m array (may include not-yet-closed candles —
 * the reference path slices to closed-only itself); `pre.adx15` is the
 * optional causal fast-path series.
 *
 * @returns {{ adx: number|undefined, regime: string|undefined }}
 */
export function computeRegime(c15, i15, pre) {
  let v;
  if (pre && pre.adx15) {
    v = pre.adx15[i15];
  } else {
    const closed = c15.slice(0, i15 + 1);
    const a = adxCalc(closed, ADX_PERIOD);
    v = a.adx[a.adx.length - 1];
  }
  return { adx: v, regime: classifyRegime(v) };
}

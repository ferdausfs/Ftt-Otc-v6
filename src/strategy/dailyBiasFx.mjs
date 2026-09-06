/**
 * Daily Liquidity-Sweep Bias (FX) — STANDALONE strategy module.
 *
 * Imports NOTHING from any prior strategy file (no FTT3, no v6 engine).
 * This is a different category of reasoning than lagging indicator
 * crossovers: it reads once-daily liquidity-sweep structure (price wicking
 * past yesterday's high/low) straight off raw daily candles.
 *
 * SPEC (frozen, mechanical — there is no parameter to tune):
 *
 *   Computed once per day, on the just-closed daily candle D-1 compared
 *   against the daily candle before it, D-2. D-1/D-2 are consecutive
 *   AVAILABLE daily candles (weekends/holidays simply do not exist in the
 *   sequence — no calendar arithmetic, no interpolation).
 *
 *   Evaluation order is EXACTLY as given (order is part of the spec):
 *
 *     1. AVOID sweep-both:   d1.h > d2.h  AND  d1.l < d2.l
 *        (checked FIRST — a candle that swept both sides must not also
 *         match the single-sweep directional cases)
 *     2. VERY_BEARISH (PUT): d1.h > d2.h  AND  d1.c < d2.l
 *     3. BEARISH      (PUT): d1.h > d2.h  AND  d1.c < d2.h
 *     4. BULLISH      (CALL):d1.l < d2.l  AND  d1.c > d2.h
 *     5. AVOID consolidation: d1.h <= d2.h AND d1.l >= d2.l
 *     6. AVOID UNCLASSIFIED:  anything else — logged with reason
 *        "UNCLASSIFIED", never guessed into a direction.
 *
 *   Entry:  at the open of day D (the next available daily candle after
 *           D-1). Direction: CALL for BULLISH, PUT for BEARISH/VERY_BEARISH.
 *           AVOID -> NO_TRADE, no entry that day.
 *   Expiry: day D's close (24h after entry).
 *   Result: WIN if D's close moved in the entered direction from D's open,
 *           LOSS otherwise, TIE if exactly flat.
 *
 * NO-LOOKAHEAD CONTRACT: classifyDailyBias() reads ONLY d1 and d2 fields.
 * evaluateDailyBiasDay() additionally reads d.o and d.c — and nothing else —
 * to resolve the result AFTER the decision is already fixed. Mutating d.h,
 * d.l, or any later candle can never change a decision. scripts/
 * daily_bias_tests.mjs proves this by mutation.
 *
 * Known structural consequence (documented, NOT patched — the order is the
 * spec): VERY_BEARISH requires d1.h > d2.h AND d1.c < d2.l; since
 * d1.l <= d1.c < d2.l implies d1.l < d2.l, every VERY_BEARISH-shaped day is
 * captured by the sweep-both check that runs first, so VERY_BEARISH is
 * unreachable under the mandated order. The branch is still implemented and
 * tested so the module matches the spec literally; the harness reports its
 * count as 0 rather than pretending otherwise.
 */

export const CLASSIFICATIONS = Object.freeze([
  'SWEEP_BOTH',      // AVOID — both D-2 extremes swept by D-1
  'VERY_BEARISH',    // PUT   — high swept, close below D-2 low (unreachable under spec order, see above)
  'BEARISH',         // PUT   — high swept, close back below D-2 high
  'BULLISH',         // CALL  — low swept, close above D-2 high
  'CONSOLIDATION',   // AVOID — D-1 entirely inside D-2's range
  'UNCLASSIFIED',    // AVOID — none of the above matched; logged, never guessed
]);

const AVOID = new Set(['SWEEP_BOTH', 'CONSOLIDATION', 'UNCLASSIFIED']);

/**
 * Classify one day from the two preceding daily candles.
 * @param {{h:number,l:number,c:number}} d2 - daily candle two days before entry
 * @param {{h:number,l:number,c:number}} d1 - just-closed daily candle
 * @returns {{classification:string, decision:'CALL'|'PUT'|'NO_TRADE', reason:string|null}}
 */
export function classifyDailyBias(d2, d1) {
  // 1. sweep-both — checked before every single-sweep case, per spec
  if (d1.h > d2.h && d1.l < d2.l) {
    return { classification: 'SWEEP_BOTH', decision: 'NO_TRADE', reason: 'SWEEP_BOTH' };
  }
  // 2. very-bearish
  if (d1.h > d2.h && d1.c < d2.l) {
    return { classification: 'VERY_BEARISH', decision: 'PUT', reason: null };
  }
  // 3. bearish
  if (d1.h > d2.h && d1.c < d2.h) {
    return { classification: 'BEARISH', decision: 'PUT', reason: null };
  }
  // 4. bullish
  if (d1.l < d2.l && d1.c > d2.h) {
    return { classification: 'BULLISH', decision: 'CALL', reason: null };
  }
  // 5. consolidation
  if (d1.h <= d2.h && d1.l >= d2.l) {
    return { classification: 'CONSOLIDATION', decision: 'NO_TRADE', reason: 'CONSOLIDATION' };
  }
  // 6. anything else — logged, never guessed
  return { classification: 'UNCLASSIFIED', decision: 'NO_TRADE', reason: 'UNCLASSIFIED' };
}

/**
 * Full single-day evaluation: classification + entry/expiry resolution.
 *
 * @param {{h:number,l:number,c:number}} d2
 * @param {{h:number,l:number,c:number}} d1
 * @param {{o:number,c:number}} d  - day D candle: open = entry, close = exit.
 *                                   ONLY o and c are read, and only AFTER the
 *                                   decision is fixed (see contract above).
 * @returns {{classification:string, decision:string, reason:string|null,
 *            entry:number|null, exit:number|null, result:'WIN'|'LOSS'|'TIE'|null}}
 */
export function evaluateDailyBiasDay(d2, d1, d) {
  const { classification, decision, reason } = classifyDailyBias(d2, d1);

  if (decision === 'NO_TRADE') {
    // AVOID day: no entry exists, so no result exists either
    return { classification, decision, reason, entry: null, exit: null, result: null };
  }

  const entry = d.o;
  const exit = d.c;
  let result;
  if (exit === entry) result = 'TIE';
  else if (decision === 'CALL') result = exit > entry ? 'WIN' : 'LOSS';
  else result = exit < entry ? 'WIN' : 'LOSS';           // PUT

  return { classification, decision, reason, entry, exit, result };
}

/**
 * Convenience: is this classification an AVOID (no-trade) class?
 */
export function isAvoidClassification(classification) {
  return AVOID.has(classification);
}

/**
 * Display-only local trading date for a Yahoo FX daily-bar timestamp.
 * Yahoo stamps completed daily bars at LONDON midnight (00:00Z in winter,
 * 23:00Z of the previous UTC day in British Summer Time), so a +1h shift
 * maps both stamp styles onto the actual session date (a "Sunday 23:00Z"
 * bar is the Monday session). Purely cosmetic labeling for audits/reports:
 * the strategy itself only ever consumes the SEQUENCE of available candles.
 */
export function dayLabel(tMs) {
  return new Date(tMs + 3600000).toISOString().slice(0, 10);
}

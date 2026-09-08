/**
 * Triple-barrier resolution engine — STANDALONE, REUSABLE, strategy-agnostic.
 *
 * This replaces the fixed-time win/loss resolution every prior binary test in
 * this project used. A position entered at `entry` carries:
 *   - a STOP-LOSS barrier (mandatory) — the invalidation price,
 *   - a TAKE-PROFIT barrier (optional; null = no profit barrier),
 *   - a time barrier (max holding period).
 * The engine walks forward candle by candle and resolves the FIRST barrier
 * touched. It knows nothing about volume profiles, ATR, or any strategy —
 * callers hand it raw candles and barrier prices, so any future R:R-based
 * strategy can reuse it unchanged.
 *
 * ── FROZEN RESOLUTION CONTRACT (committed before the first run) ─────────────
 *  1. Candles are { t, o, h, l, c, ... } with t = OPEN time (ms UTC); a bar's
 *     CLOSE time is t + msPerBar. The caller passes firstIdx = entryIdx + 1:
 *     the entry candle itself is NEVER walked (entry fills at its close, so
 *     nothing inside it can resolve the trade).
 *  2. Walk window: candles whose CLOSE time is <= entryTime + maxHoldMs,
 *     where entryTime = close time of the entry candle. Candles closing
 *     after the time barrier are not looked at.
 *  3. Touch is INCLUSIVE: a candle touches a barrier when its high/low
 *     reaches the exact price (high >= level / low <= level, per side).
 *  4. SAME-CANDLE DOUBLE TOUCH: if one candle touches BOTH TP and SL, the
 *     trade resolves as SL — conservative worst case; 1m bars do not reveal
 *     intra-candle path, so no favorable ordering is ever assumed.
 *  5. Fill assumption: barriers fill AT the barrier price (touch fill, mid,
 *     no slippage). Because real gaps exist, the result also reports
 *     slGapFill + openPrice + rOpen: when the exit candle OPENED already
 *     beyond the SL, a live stop would have filled at the (worse) open —
 *     callers must report that sensitivity, not hide it.
 *  6. TIME BARRIER: if no price barrier is touched inside the walk window,
 *     the trade exits at the CLOSE of the last candle in the window
 *     (the "120-minute candle's close"), type TIMEOUT.
 *  7. DATA END: if the candle array ends before both the walk window and any
 *     price barrier, the trade is CENSORED (unresolvable in the fetched
 *     data) — never interpolated, never silently counted as a win/loss.
 *
 * Pure function: no I/O, no clock, no randomness — same inputs, same output.
 */

export const TB_MS_1M = 60_000;
export const TB_MAX_HOLD_MIN = 120;

export function resolveTripleBarrier(candles, firstIdx, opts) {
  const {
    direction,           // 'LONG' | 'SHORT'
    entry,               // entry price
    slPrice,             // stop-loss price (mandatory)
    tpPrice = null,      // take-profit price, or null = no profit barrier
    maxHoldMs = TB_MAX_HOLD_MIN * TB_MS_1M,
    msPerBar = TB_MS_1M,
    entryTime = null,    // close time of the entry candle; derived if omitted
    rAbs = null,         // |entry - slPrice|; when given, result.r is realized R
  } = opts;

  if (direction !== 'LONG' && direction !== 'SHORT') {
    throw new Error(`tripleBarrier: bad direction ${direction}`);
  }
  if (!(rAbs > 0)) {
    throw new Error('tripleBarrier: rAbs must be > 0 (zero-R trades must be rejected upstream)');
  }
  // derived entry time: caller may pass it explicitly; default = close of candles[firstIdx-1]
  const entryT = entryTime != null
    ? entryTime
    : (firstIdx > 0 && candles[firstIdx - 1] ? candles[firstIdx - 1].t + msPerBar : null);
  if (entryT == null) throw new Error('tripleBarrier: cannot derive entryTime');
  const holdEnd = entryT + maxHoldMs;

  const isLong = direction === 'LONG';
  let lastIdx = null;         // last candle walked (inside the hold window)
  let resolved = null;

  for (let i = firstIdx; i < candles.length; i++) {
    const c = candles[i];
    const closeT = c.t + msPerBar;
    if (closeT > holdEnd) break;         // time barrier reached — outside walk window
    lastIdx = i;

    const slTouched = isLong ? (c.l <= slPrice) : (c.h >= slPrice);
    const tpTouched = tpPrice != null && (isLong ? (c.h >= tpPrice) : (c.l <= tpPrice));

    if (slTouched || tpTouched) {
      // both touched in the same candle -> SL (frozen conservative rule)
      const type = slTouched ? 'SL' : 'TP';
      const exitPrice = slTouched ? slPrice : tpPrice;
      const gapFill = slTouched && (isLong ? (c.o <= slPrice) : (c.o >= slPrice));
      resolved = {
        type, exitIdx: i, exitT: closeT, exitPrice,
        openPrice: c.o,
        slGapFill: gapFill,
        bothTouched: slTouched && tpTouched,
      };
      break;
    }
  }

  if (resolved == null) {
    if (lastIdx == null) {
      // no candle at all inside the walk window (data ended immediately)
      return {
        type: 'CENSORED', exitIdx: null, exitT: null, exitPrice: null,
        openPrice: null, slGapFill: false, bothTouched: false,
        minutesHeld: 0, barsHeld: 0, r: null, rOpen: null,
      };
    }
    const lastCloseT = candles[lastIdx].t + msPerBar;
    const exactTimeout = lastCloseT === holdEnd;
    resolved = {
      type: exactTimeout ? 'TIMEOUT' : 'CENSORED',
      exitIdx: lastIdx,
      exitT: lastCloseT,
      exitPrice: candles[lastIdx].c,
      openPrice: candles[lastIdx].o,
      slGapFill: false,
      bothTouched: false,
    };
  }

  const signed = (px) => (isLong ? (px - entry) : (entry - px)) / rAbs;
  const r = resolved.exitPrice != null ? signed(resolved.exitPrice) : null;
  // realized R if the SL had filled at the exit candle's open (gap sensitivity)
  const rOpen = resolved.type === 'SL' && resolved.slGapFill ? signed(resolved.openPrice) : null;

  return {
    ...resolved,
    minutesHeld: resolved.exitT != null ? Math.round((resolved.exitT - entryT) / msPerBar) : 0,
    barsHeld: resolved.exitIdx != null ? resolved.exitIdx - firstIdx + 1 : 0,
    r: r != null ? +r.toFixed(8) : null,
    rOpen: rOpen != null ? +rOpen.toFixed(8) : null,
  };
}

/**
 * UT Bot Alerts — exact port of the TradingView Pine v4 indicator.
 *
 * Reference (frozen; the ONLY source of truth for this module):
 *
 *   //@version=4
 *   study(title="UT Bot Alerts", overlay = true)
 *   a = input(1,  title = "Key Vaule")      // sensitivity multiplier
 *   c = input(10, title = "ATR Period")
 *   h = input(false, title = "Heikin Ashi") // OUT OF SCOPE — see below
 *
 *   xATR  = atr(c)
 *   nLoss = a * xATR
 *   src   = close
 *
 *   xATRTrailingStop := iff(src > nz(xATRTrailingStop[1], 0) and src[1] > nz(xATRTrailingStop[1], 0),
 *                            max(nz(xATRTrailingStop[1]), src - nLoss),
 *                        iff(src < nz(xATRTrailingStop[1], 0) and src[1] < nz(xATRTrailingStop[1], 0),
 *                            min(nz(xATRTrailingStop[1]), src + nLoss),
 *                        iff(src > nz(xATRTrailingStop[1], 0), src - nLoss, src + nLoss)))
 *
 *   pos := iff(src[1] < nz(xATRTrailingStop[1], 0) and src > nz(xATRTrailingStop[1], 0), 1,
 *           iff(src[1] > nz(xATRTrailingStop[1], 0) and src < nz(xATRTrailingStop[1], 0), -1,
 *               nz(pos[1], 0)))
 *
 *   ema   = ema(src, 1)          // EMA(x,1) === x — algebraically trivial
 *   above = crossover(ema, xATRTrailingStop)
 *   below = crossover(xATRTrailingStop, ema)
 *
 *   buy  = src > xATRTrailingStop and above
 *   sell = src < xATRTrailingStop and below
 *
 * Pine semantics reproduced deliberately (each maps to a test in
 * scripts/utbot_tests.mjs — do not "simplify" any of them):
 *
 *   P1  ta.crossover(x, y) = x > y on the current bar AND x[1] <= y[1] on the
 *       prior bar (strictly greater NOW, less-or-equal BEFORE). Equality on
 *       the current bar is NOT a cross; equality on the prior bar IS.
 *   P2  nz(x[1], 0): on the first bars xATRTrailingStop[1] is na and becomes
 *       0 — NOT carried as undefined. Trace: on bar 0 cond1 = (src > 0) and
 *       (na > 0 → na) → not true → ... → cond3 = src > 0 → stop = src - nLoss;
 *       nLoss is na until the ATR warms up, so stop is na until bar c-1, and
 *       on bar c-1 stop = max(0, src - nLoss) = src - nLoss. pos[1] na → 0.
 *   P3  ta.atr(c) = rma(tr(true), c): first-bar TR = high - low (na close
 *       handled), seeded with the SMA of the first `c` TRs at bar c-1, then
 *       Wilder recursion rma = (prev*(c-1) + tr) / c. The existing
 *       indicators.mjs atr() implements exactly this — REUSED here, not
 *       reimplemented (a second ATR would risk divergence; the test suite
 *       proves the seeding convention against hand-computed values).
 *   P4  iff() is a FUNCTION: the nested conditional structure is preserved
 *       verbatim. The reset branches (3rd iff) matter: after a cross from
 *       below, stop = src - nLoss UNCONDITIONALLY (not max(prev, ...)); a
 *       "simplified" max/min refactoring diverges exactly there.
 *   P5  Heikin Ashi (h=true) is OUT OF SCOPE: src = raw close only. The
 *       TradingView default for this input is false, which is what this port
 *       reproduces. Documented limitation (README).
 *   P6  Defaults a = 1, c = 10 (TradingView defaults). Per-pair overrides are
 *       a config concern (KV), never baked into this module.
 *
 * na handling: JS undefined plays the role of Pine na. Comparisons with na
 * yield na (three-valued `and`: false dominates, otherwise na propagates).
 * iff(na, a, b) = b. max/min with an na operand = na. All of this is only
 * observable on the warmup bars; the tests pin every warmup value.
 *
 * Timing contract (no-lookahead): value at bar i depends ONLY on candles
 * with index <= i. Single left-to-right pass; proven by the truncation +
 * future-mutation tests. Signal timing = candle CLOSE confirmation: the
 * marker a TradingView user sees once the bar closes (intrabar flicker of
 * the live bar is deliberately not reproduced).
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 */

import { atr as pineAtr } from './indicators.mjs';

/** TradingView indicator defaults (P6). */
export const UT_A_DEFAULT = 1;
export const UT_C_DEFAULT = 10;

export const MS_1M = 60_000;
export const TF_MS = { '1min': MS_1M, '5min': 300_000, '15min': 900_000 };

// ── Pine primitive helpers (na = undefined) ─────────────────────────────────

/** nz(x, y): na (undefined/null/NaN) → replacement value. */
function nz(x, y = 0) {
  return (x === undefined || x === null || Number.isNaN(x)) ? y : x;
}

/** Pine comparison: any na operand → na. */
function gt(a, b) { return (a === undefined || b === undefined) ? undefined : a > b; }
function lt(a, b) { return (a === undefined || b === undefined) ? undefined : a < b; }

/** Pine three-valued `and`: false dominates; na propagates otherwise. */
function pineAnd(x, y) {
  if (x === false || y === false) return false;
  if (x === undefined || y === undefined) return undefined;
  return true;
}

/** iff(condition, then, else): na/false condition → else (Pine v4 iff). */
function iff(cond, thenVal, elseVal) {
  return cond === true ? thenVal : elseVal;
}

/** Pine max/min: any na operand → na. */
function pmax(a, b) { return (a === undefined || b === undefined) ? undefined : Math.max(a, b); }
function pmin(a, b) { return (a === undefined || b === undefined) ? undefined : Math.min(a, b); }

/** Pine arithmetic `-`/`+` with na propagation (src ± nLoss). */
function psub(a, b) { return (a === undefined || b === undefined) ? undefined : a - b; }
function padd(a, b) { return (a === undefined || b === undefined) ? undefined : a + b; }

/**
 * ta.crossover(x, y) on bar i given explicit current/prior values
 * (P1): x[i] > y[i] AND x[i-1] <= y[i-1]. Any na involved → false
 * (an na crossover can never satisfy `buy`/`sell`, which require a
 * strict price comparison anyway).
 */
export function pineCrossover(xNow, xPrev, yNow, yPrev) {
  if (xNow === undefined || yNow === undefined || xPrev === undefined || yPrev === undefined) return false;
  return xNow > yNow && xPrev <= yPrev;
}

// ── The indicator ────────────────────────────────────────────────────────────

/**
 * Compute the full UT Bot Alerts series over an ascending candle array.
 *
 * @param {Array} candles ascending { t,o,h,l,c }
 * @param {object} [opts] { a, c } — TradingView defaults when omitted
 * @param {object} [meta] { tfMs } — candle period in ms (event close-time
 *   stamping); inferred from the first two candles when omitted.
 * @returns {{ stop:number[], pos:number[], buy:boolean[], sell:boolean[],
 *             events:Array, atr:number[], params:{a,c} }}
 *   stop/pos/atr are index-aligned, undefined (na) where Pine would be na.
 *   events: [{ i, t, closeT, type:'buy'|'sell', price, stop, atr, nLoss, pos }]
 */
export function computeUtBot(candles, opts = {}, meta = {}) {
  const a = opts.a === undefined ? UT_A_DEFAULT : Number(opts.a);
  const c = opts.c === undefined ? UT_C_DEFAULT : Math.trunc(Number(opts.c));
  const n = candles.length;

  const atr = pineAtr(candles, c);            // P3 — reused Pine-compatible ATR
  const stop = new Array(n).fill(undefined);  // xATRTrailingStop
  const pos = new Array(n).fill(undefined);
  const buy = new Array(n).fill(false);
  const sell = new Array(n).fill(false);
  const events = [];

  let tfMs = meta.tfMs;
  if (!tfMs && n >= 2) tfMs = Math.max(1, candles[1].t - candles[0].t);

  for (let i = 0; i < n; i++) {
    const src = candles[i].c;                                   // src = close
    const prevSrc = i > 0 ? candles[i - 1].c : undefined;       // src[1]
    const prevStop = i > 0 ? stop[i - 1] : undefined;           // xATRTrailingStop[1]
    const ps = nz(prevStop, 0);                                 // nz(xATRTrailingStop[1], 0)

    // nLoss = a * xATR — na before the ATR warms up (P2/P3).
    const nLoss = atr[i] === undefined ? undefined : a * atr[i];

    // xATRTrailingStop := iff(... nested, verbatim structure (P4)) ──────────
    stop[i] = iff(
      pineAnd(gt(src, ps), gt(prevSrc, ps)),
      pmax(ps, psub(src, nLoss)),
      iff(
        pineAnd(lt(src, ps), lt(prevSrc, ps)),
        pmin(ps, padd(src, nLoss)),
        iff(
          gt(src, ps),
          psub(src, nLoss),
          padd(src, nLoss),
        ),
      ),
    );

    // pos := iff(... nested, verbatim) ───────────────────────────────────────
    pos[i] = iff(
      pineAnd(lt(prevSrc, ps), gt(src, ps)),
      1,
      iff(
        pineAnd(gt(prevSrc, ps), lt(src, ps)),
        -1,
        nz(i > 0 ? pos[i - 1] : undefined, 0),                  // nz(pos[1], 0) (P2)
      ),
    );

    // ema(src, 1) === src exactly (alpha = 1 → ema = src on every bar,
    // including the SMA-seeded first bar where sma(src,1) = src).
    const emaNow = src;
    const emaPrev = prevSrc;

    // above = crossover(ema, stop); below = crossover(stop, ema) (P1)
    const above = pineCrossover(emaNow, emaPrev, stop[i], prevStop);
    const below = pineCrossover(stop[i], prevStop, emaNow, emaPrev);

    // buy/sell verbatim (the src comparison is redundant with the crossover's
    // strict leg but kept for fidelity — it is in the frozen reference).
    buy[i] = gt(src, stop[i]) === true && above;
    sell[i] = lt(src, stop[i]) === true && below;

    if (buy[i] || sell[i]) {
      events.push({
        i,
        t: candles[i].t,
        closeT: tfMs ? candles[i].t + tfMs : undefined,
        type: buy[i] ? 'buy' : 'sell',
        price: src,
        stop: stop[i],
        stopPrev: i > 0 ? stop[i - 1] : undefined,
        atr: atr[i],
        nLoss,
        pos: pos[i],
        posPrev: i > 0 ? pos[i - 1] : undefined,
      });
    }
  }

  return { stop, pos, buy, sell, atr, events, params: { a, c } };
}

// ── Live-worker helpers ──────────────────────────────────────────────────────

/** Index of the last CLOSED candle of period tfMs given "now" (ms). -1 none. */
export function lastClosedIndexTf(candles, nowMs, tfMs) {
  for (let k = candles.length - 1; k >= 0; k--) {
    if (candles[k].t + tfMs <= nowMs) return k;
  }
  return -1;
}

/**
 * Map an event to the binary-options vocabulary used by the worker's history
 * and result pipeline (buy → CALL, sell → PUT). The indicator's own
 * vocabulary (buy/sell, stop, atr, nLoss, pos) rides in `audit` untouched.
 */
export function eventToSignal(event, pair, extra = {}) {
  return {
    engine: 'UT-BOT',
    finalSignal: event.type === 'buy' ? 'CALL' : 'PUT',
    reason: event.type === 'buy' ? 'UT_BOT_BUY_CROSS' : 'UT_BOT_SELL_CROSS',
    pair,
    market: extra.market || 'FOREX',
    timeframe: extra.timeframe,
    timestamp: extra.timestamp,
    currentPrice: event.price,
    audit: {
      event: event.type,
      key: extra.a,
      atrPeriod: extra.c,
      atr: event.atr,
      nLoss: event.nLoss,
      stop: event.stop,
      stopPrev: event.stopPrev,
      pos: event.pos,
      posPrev: event.posPrev,
      crossover: event.type === 'buy' ? 'above' : 'below',
      timeframe: extra.timeframe,
      eventCandle: { t: event.t, closeT: event.closeT },
      barIndex: event.i,
    },
    entryPrice: event.price,
    entryTime: extra.timestamp,
    expiryMinutes: extra.expiryMinutes,
    expiryTime: extra.expiryTime,
    atrPercentile: null,
  };
}

/**
 * Market Structure (BOS/CHoCH) — STANDALONE strategy module.
 *
 * Imports NOTHING from any prior strategy file (no FTT3, no FTT3-R, no
 * daily-bias). This is a different category of reasoning than lagging
 * indicator crossovers: it reads swing structure (swing high/low, Break of
 * Structure = trend continuation, Change of Character = trend flip) straight
 * off raw candles, implemented independently from the public *concept* —
 * no published Pine Script was copied, transcribed, or closely paraphrased.
 *
 * ── FROZEN SPEC (fixed textbook defaults, committed before the first run) ──
 *
 * Pivot definition (length L = 5, both timeframes):
 *   Bar i is a swing high iff high[i] is the maximum of high[i-L .. i+L]
 *   (equality with the max counts — ties stay pivots). Symmetric for swing
 *   lows with the minimum of low[i-L .. i+L].
 *   CONFIRMATION LAG: the pivot at i is only KNOWABLE once bar i+L has
 *   closed — a naive backtest that marks bar i as a pivot when bar i itself
 *   closes leaks L bars of future information. In this module a pivot at i
 *   is registered exclusively inside the step that processes bar i+L, and
 *   scripts/market_structure_tests.mjs proves the lag by mutation.
 *
 * Structure state machine (per timeframe, single forward pass — the ONLY
 * place pivots are confirmed and breaks fire):
 *   state = { trend: UNKNOWN|UP|DOWN, sh: last confirmed swing high, sl:
 *   last confirmed swing low }; each reference carries a `broken` flag.
 *   Processing bar t (after its close), in this fixed order:
 *     1. CONFIRM pivots: candidate i = t - L (needs i-L >= 0). If bar i is a
 *        swing high it becomes the new `sh` (most-recent-wins); swing low
 *        becomes the new `sl`. Both can confirm on the same bar.
 *     2. BREAKS, using bar t's close only (strict inequalities; a close
 *        exactly AT a level is not a break):
 *          bull break: sh exists, not yet broken, close > sh.v
 *          bear break: sl exists, not yet broken, close < sl.v
 *        - bull only  -> trend UP   ; event = BOS_BULL   if trend was UP,
 *          else CHoCH_BULL (DOWN or UNKNOWN flips to UP).
 *        - bear only  -> trend DOWN ; event = BOS_BEAR   if trend was DOWN,
 *          else CHoCH_BEAR (UP or UNKNOWN flips to DOWN).
 *        - both       -> event BOTH: applied bull-first then bear in the
 *          fixed order above (rare: needs sh.v < close < sl.v); the trend
 *          after the bar is the sequential end state.
 *        Each swing reference can fire AT MOST ONCE (`broken` flag): after a
 *        level breaks, no further event can come from it until a NEW swing
 *        point confirms (>= L bars later by construction). This is the
 *        standard market-structure rhythm and keeps one event per swing.
 *   Note a structural safety property: a freshly confirmed swing high can
 *   never be broken by its own confirmation bar (close[t] > high[i] would
 *   force high[t] > high[i], disqualifying i as a pivot), so step order is
 *   deterministic under all valid OHLC inputs.
 *
 * C1  Bias (15m): trend state of the 15m machine as of the last CLOSED 15m
 *     candle (close time <= the trigger bar's close time; a 15m bar closing
 *     exactly at the trigger close is already knowable and counts).
 *     UNKNOWN -> NO_TRADE.
 * C2  Trigger (1m): the 1m machine's event at the just-closed 1m bar.
 *       BOS_BULL or CHoCH_BULL with bias UP   -> CALL
 *       BOS_BEAR or CHoCH_BEAR with bias DOWN -> PUT
 *       event opposite the bias  -> NO_TRADE (OPPOSITE_BREAK)
 *       event with bias UNKNOWN  -> NO_TRADE (BIAS_UNKNOWN)
 *       BOTH on one candle       -> NO_TRADE (AMBIGUOUS — no single direction)
 *       no event                 -> NO_TRADE (NO_BREAK)
 *     A 1m CHoCH in the same direction as the 15m bias counts too (spec:
 *     "BOS or CHoCH, either counts").
 *
 * Expiry — the SAME dynamic ladder every prior strategy used, not
 * reinvented: ATR(14) on 1m (Wilder), trailing window of the last 100 ATR
 * values ending at the trigger bar inclusive; percentile rank = share of
 * window values <= current ATR; tiers (frozen, first match wins):
 *     pct >= 75 -> 5 minutes;  25 <= pct < 75 -> 7 minutes;  pct < 25 -> 10
 *     minutes. A full 100-value window is REQUIRED (else NO_TRADE
 *     EXPIRY_INSUFFICIENT). NOTE: unlike FTT3 there is NO ATR-vs-median
 *     entry gate — this spec has exactly two conditions (C1, C2); the
 *     trailing median is logged for audit continuity but never gates.
 *
 * Result: entry = trigger bar's close; exit = the close of the bar exactly
 * `minutes` later (timestamp-checked; a missing exit candle is EXPIRY_GAP,
 * never interpolated). WIN/LOSS against entry, TIE if exactly equal.
 *
 * ── No-lookahead contract ──────────────────────────────────────────────────
 * The decision for 1m index i reads only: 1m bars at index <= i (via the
 * causal single-pass machine + causal ATR) and 15m bars whose close time is
 * <= c1[i].t + 60_000. Mutating ANY bar after index i (1m or 15m) cannot
 * change the decision for i — scripts/market_structure_tests.mjs proves this
 * by mutation, together with the pivot confirmation-lag proof.
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 */

export const MS_1M = 60_000;
export const MS_15M = 900_000;

// ── Fixed constants, committed before the first backtest run ────────────────
export const PIVOT_L = 5;
export const ATR_PERIOD = 14;
export const ATR_WINDOW = 100;   // trailing ATR values for the percentile rank

// Expiry tiers by ATR percentile rank (top-down, first match wins).
export const EXPIRY_TIERS = [
  { minPct: 75, minutes: 5 },
  { minPct: 25, minutes: 7 },
  { minPct: 0, minutes: 10 },
];

/** Expiry minutes for an ATR percentile rank (0..100). */
export function expiryForPercentile(pct) {
  for (const tier of EXPIRY_TIERS) if (pct >= tier.minPct) return tier.minutes;
  return 10;
}

// Event / trend codes (typed arrays in buildStructure; strings at the edges)
export const EVENT = Object.freeze({ NONE: 0, BOS_BULL: 1, CHoCH_BULL: 2, BOS_BEAR: 3, CHoCH_BEAR: 4, BOTH: 5 });
export const EVENT_NAME = Object.freeze(['NONE', 'BOS_BULL', 'CHoCH_BULL', 'BOS_BEAR', 'CHoCH_BEAR', 'BOTH']);
export const TREND = Object.freeze({ UNKNOWN: 0, UP: 1, DOWN: 2 });
export const TREND_NAME = Object.freeze(['UNKNOWN', 'UP', 'DOWN']);

// ── Pivot detection (confirmation lag lives in stepStructure, not here) ─────

/** Bar i is a swing high iff high[i] is the max of high[i-L .. i+L]. */
export function isSwingHigh(candles, i, L = PIVOT_L) {
  if (i - L < 0 || i + L >= candles.length) return false;
  const h = candles[i].h;
  for (let k = i - L; k <= i + L; k++) {
    if (k !== i && candles[k].h > h) return false;
  }
  return true;
}

/** Bar i is a swing low iff low[i] is the min of low[i-L .. i+L]. */
export function isSwingLow(candles, i, L = PIVOT_L) {
  if (i - L < 0 || i + L >= candles.length) return false;
  const l = candles[i].l;
  for (let k = i - L; k <= i + L; k++) {
    if (k !== i && candles[k].l < l) return false;
  }
  return true;
}

// ── Structure state machine ─────────────────────────────────────────────────

export function createStructureState() {
  return { trend: 'UNKNOWN', sh: null, sl: null };
}

/**
 * Advance the machine by one bar: process index t of `candles` (bar t must
 * be CLOSED — callers only ever step over closed bars). Mutates `state`.
 *
 * Step 1 confirms the pivot candidate i = t - L (the confirmation lag: a
 * pivot becomes visible EXACTLY here, never earlier). Step 2 checks breaks
 * of the current references with bar t's close.
 *
 * @returns {{ confirmedHigh: {v,t,i}|null, confirmedLow: {v,t,i}|null,
 *             event: string, bullBreak: boolean, bearBreak: boolean }}
 */
export function stepStructure(state, candles, t, L = PIVOT_L) {
  // Step 1 — confirm the pivot whose L-bars-right window just completed.
  let confirmedHigh = null, confirmedLow = null;
  const i = t - L;
  if (i >= L) {                       // i - L >= 0  <=>  t >= 2L
    if (isSwingHigh(candles, i, L)) {
      confirmedHigh = { v: candles[i].h, t: candles[i].t, i };
      state.sh = { ...confirmedHigh, broken: false };
    }
    if (isSwingLow(candles, i, L)) {
      confirmedLow = { v: candles[i].l, t: candles[i].t, i };
      state.sl = { ...confirmedLow, broken: false };
    }
  }

  // Step 2 — breaks on this bar's close (strict; equality is not a break).
  const c = candles[t].c;
  const bull = state.sh !== null && !state.sh.broken && c > state.sh.v;
  const bear = state.sl !== null && !state.sl.broken && c < state.sl.v;

  let event = 'NONE';
  if (bull && bear) {
    // Fixed order: bull leg first, then bear leg. The bar's event is BOTH —
    // no single direction exists, so the BOS/CHoCH character of the legs is
    // not labeled; the trend ends in the sequential end state.
    state.sh.broken = true;
    state.trend = 'UP';
    state.sl.broken = true;
    state.trend = 'DOWN';
    event = 'BOTH';
  } else if (bull) {
    state.sh.broken = true;
    event = state.trend === 'UP' ? 'BOS_BULL' : 'CHoCH_BULL';
    state.trend = 'UP';
  } else if (bear) {
    state.sl.broken = true;
    event = state.trend === 'DOWN' ? 'BOS_BEAR' : 'CHoCH_BEAR';
    state.trend = 'DOWN';
  }
  return { confirmedHigh, confirmedLow, event, bullBreak: bull, bearBreak: bear };
}

/**
 * Single causal pass over a full candle array. Returns typed arrays aligned
 * with the input; value at index t uses ONLY bars <= t.
 *   eventAt[t]   : EVENT code of the break event at t (0 = NONE)
 *   trendAfter[t]: TREND code after processing t (this IS the C1 bias source)
 *   shV/shT/shB  : swing-high reference in play after t (value, pivot open
 *                  time, broken flag) — NaN/0 when none exists yet
 *   slV/slT/slB  : swing-low reference, same shape
 *   chV/chT, clV/clT: pivot confirmed AT t (NaN when none)
 */
export function buildStructure(candles, L = PIVOT_L) {
  const n = candles.length;
  const eventAt = new Uint8Array(n);
  const trendAfter = new Uint8Array(n);
  const shV = new Float64Array(n).fill(NaN), shT = new Float64Array(n).fill(NaN), shB = new Uint8Array(n);
  const slV = new Float64Array(n).fill(NaN), slT = new Float64Array(n).fill(NaN), slB = new Uint8Array(n);
  const chV = new Float64Array(n).fill(NaN), chT = new Float64Array(n).fill(NaN);
  const clV = new Float64Array(n).fill(NaN), clT = new Float64Array(n).fill(NaN);
  const state = createStructureState();
  for (let t = 0; t < n; t++) {
    const step = stepStructure(state, candles, t, L);
    eventAt[t] = EVENT[step.event];
    trendAfter[t] = TREND[state.trend];
    if (state.sh) { shV[t] = state.sh.v; shT[t] = state.sh.t; shB[t] = state.sh.broken ? 1 : 0; }
    if (state.sl) { slV[t] = state.sl.v; slT[t] = state.sl.t; slB[t] = state.sl.broken ? 1 : 0; }
    if (step.confirmedHigh) { chV[t] = step.confirmedHigh.v; chT[t] = step.confirmedHigh.t; }
    if (step.confirmedLow) { clV[t] = step.confirmedLow.v; clT[t] = step.confirmedLow.t; }
  }
  return { eventAt, trendAfter, shV, shT, shB, slV, slT, slB, chV, chT, clV, clT };
}

// ── 15m alignment (C1) ──────────────────────────────────────────────────────

/**
 * Index of the last 15m bar CLOSED at or before `entryCloseT` (backward scan;
 * -1 when none). A 15m bar closing exactly at entryCloseT counts — it is
 * knowable at the decision moment. Reference implementation: O(n) per call.
 */
export function lastClosed15Index(c15, entryCloseT) {
  for (let k = c15.length - 1; k >= 0; k--) {
    if (c15[k].t + MS_15M <= entryCloseT) return k;
  }
  return -1;
}

/**
 * Monotonic forward pointer over c15 for ascending entryCloseT queries —
 * mathematically identical to lastClosed15Index, O(1) amortized. Falls back
 * to a fresh scan if a caller ever queries backwards (correctness first).
 */
export function makeBiasPointer(c15) {
  let ptr = -1;
  let lastQuery = -Infinity;
  return function idxFor(entryCloseT) {
    if (entryCloseT < lastQuery) { ptr = -1; }        // backwards query: reset
    lastQuery = entryCloseT;
    while (ptr + 1 < c15.length && c15[ptr + 1].t + MS_15M <= entryCloseT) ptr++;
    return ptr;
  };
}

// ── ATR + expiry ladder (fresh, textbook — no imports from prior files) ─────

/** True range; the first bar's TR is simply high - low. */
function trueRange(candles) {
  const out = new Array(candles.length);
  for (let i = 0; i < candles.length; i++) {
    out[i] = i === 0
      ? candles[i].h - candles[i].l
      : Math.max(candles[i].h - candles[i].l,
                 Math.abs(candles[i].h - candles[i - 1].c),
                 Math.abs(candles[i].l - candles[i - 1].c));
  }
  return out;
}

/** Wilder ATR (RMA of true range). Undefined before the first full period. */
export function atrWilder(candles, period = ATR_PERIOD) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(undefined);
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Percent (0..100) of window values <= v. Undefined for empty window. */
export function percentileRank(window, v) {
  if (!window || window.length === 0) return undefined;
  let le = 0;
  for (const x of window) if (x <= v) le++;
  return (le / window.length) * 100;
}

/** Median of a numeric array (undefined for empty input). Diagnostic only. */
export function median(values) {
  if (!values || values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── C2 dispatch (pure; unit-tested against the spec truth table) ────────────

/**
 * Decide a trigger from the 1m event at the just-closed bar and the C1 bias.
 * @param {string} event    EVENT_NAME entry for the trigger bar
 * @param {string} bias     'UP' | 'DOWN' | 'UNKNOWN' (15m trend state)
 * @param {number} atrWindowLen  length of the defined trailing ATR window
 */
export function decideTrigger({ event, bias, atrWindowLen }) {
  if (atrWindowLen == null || atrWindowLen < ATR_WINDOW)
    return { decision: 'NO_TRADE', reason: 'EXPIRY_INSUFFICIENT' };
  if (event === 'NONE') return { decision: 'NO_TRADE', reason: 'NO_BREAK' };
  if (event === 'BOTH') return { decision: 'NO_TRADE', reason: 'AMBIGUOUS' };
  if (bias === 'UNKNOWN') return { decision: 'NO_TRADE', reason: 'BIAS_UNKNOWN' };
  const bull = event === 'BOS_BULL' || event === 'CHoCH_BULL';
  const bear = event === 'BOS_BEAR' || event === 'CHoCH_BEAR';
  if (bull && bias === 'UP') return { decision: 'CALL', reason: null };
  if (bear && bias === 'DOWN') return { decision: 'PUT', reason: null };
  return { decision: 'NO_TRADE', reason: 'OPPOSITE_BREAK' };
}

// ── Runner: the whole strategy composed once, one causal pass per TF ───────

/**
 * Composes C1 (15m bias) + C2 (1m trigger) + expiry ladder over full candle
 * arrays. `bar(i)` returns the FULL decision snapshot for the just-closed 1m
 * bar at index i — the only composition path used by the harness AND the
 * tests (no drift between a "test copy" and the real thing).
 */
export class MarketStructureRunner {
  constructor({ c15, c1 }) {
    this.c15 = c15;
    this.c1 = c1;
    this.s15 = buildStructure(c15);
    this.s1 = buildStructure(c1);
    this.atr1 = atrWilder(c1, ATR_PERIOD);
    this._ptr = makeBiasPointer(c15);
  }

  /** C1 bias for a trigger bar (by index): 15m trend as of its close time. */
  biasIndexFor(entryCloseT) {
    return this._ptr(entryCloseT);
  }

  /**
   * Full decision snapshot for trigger bar i. Reads ONLY bars <= i (1m) and
   * 15m bars closed at or before c1[i].t + MS_1M.
   */
  bar(i) {
    const c1 = this.c1;
    const entryCloseT = c1[i].t + MS_1M;
    const i15 = this.biasIndexFor(entryCloseT);
    const bias = i15 >= 0 ? TREND_NAME[this.s15.trendAfter[i15]] : 'UNKNOWN';
    const event = EVENT_NAME[this.s1.eventAt[i]];

    // Trailing ATR window: last ATR_WINDOW values ending at i inclusive.
    // ATR is defined from index ATR_PERIOD-1, so the first possible full
    // window ends at index ATR_PERIOD-1 + ATR_WINDOW-1.
    let atrWindowLen = 0;
    if (i >= ATR_PERIOD - 1 + ATR_WINDOW - 1) {
      atrWindowLen = ATR_WINDOW;
    } else {
      for (let k = i; k >= 0 && k > i - ATR_WINDOW; k--) {
        if (this.atr1[k] === undefined) break;
        atrWindowLen++;
      }
    }
    let atrPct = null, atrMedian = null, minutes = null;
    if (atrWindowLen === ATR_WINDOW) {
      const w = new Array(ATR_WINDOW);
      for (let k = i - ATR_WINDOW + 1, wK = 0; k <= i; k++, wK++) w[wK] = this.atr1[k];
      atrPct = percentileRank(w, this.atr1[i]);
      atrMedian = median(w);
      minutes = expiryForPercentile(atrPct);
    }

    const { decision, reason } = decideTrigger({ event, bias, atrWindowLen });

    return {
      entryCloseT, i15, i15OpenT: i15 >= 0 ? c15OpenT(this.c15, i15) : null,
      bias, event,
      atr: this.atr1[i], atrPct, atrMedian, atrWindowLen,
      minutes: decision === 'NO_TRADE' ? null : minutes,
      sh: snapshot(this.s1.shV, this.s1.shT, this.s1.shB, i),
      sl: snapshot(this.s1.slV, this.s1.slT, this.s1.slB, i),
      confHigh: snapPivot(this.s1.chV, this.s1.chT, i),
      confLow: snapPivot(this.s1.clV, this.s1.clT, i),
      decision, reason,
    };
  }
}

function c15OpenT(c15, i) { return c15[i].t; }
function snapshot(vA, tA, bA, i) {
  return Number.isNaN(vA[i]) ? null : { v: vA[i], t: tA[i], broken: bA[i] === 1 };
}
function snapPivot(vA, tA, i) {
  return Number.isNaN(vA[i]) ? null : { v: vA[i], t: tA[i] };
}

// ── Result resolution (shared by harness + verify script) ───────────────────

/** WIN/LOSS/TIE from a fixed decision, entry and exit price. */
export function resolveResult(decision, entry, exit) {
  if (exit === entry) return 'TIE';
  if (decision === 'CALL') return exit > entry ? 'WIN' : 'LOSS';
  return exit < entry ? 'WIN' : 'LOSS';               // PUT
}

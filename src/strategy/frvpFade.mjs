/**
 * Fixed Range Volume Profile (FRVP) fade — STANDALONE strategy module.
 *
 * Imports NOTHING from any prior strategy file. New category of test for this
 * project: the ENTRY is a value-area fade, and the EXIT is not a fixed binary
 * expiry but a triple-barrier TP/SL with R-multiple targets (see
 * backtest/tripleBarrier.mjs). With asymmetric R:R, win rate alone does not
 * decide profitability — expectancy (average R per trade) does.
 *
 * ── FROZEN SPEC (all parameters committed before the first backtest run) ────
 *
 * Profile context (recomputed for every evaluated 1m candle):
 *   WINDOW = the trailing 1440 closed 1m candles whose CLOSE time is strictly
 *   before the evaluated candle's close time. The evaluated (trigger) candle
 *   itself is EXCLUDED from its own profile — the strictest no-lookahead
 *   reading: every input to the decision closes strictly before the decision
 *   moment. 24h of 1m bars must be available or the bar is NO_TRADE
 *   (WARMUP_INSUFFICIENT / PROFILE_DEGENERATE); no decision is ever evaluated
 *   before the backtest window opens.
 *   BINS = 50 equal-width bins spanning [24h min low, 24h max high].
 *   Volume bucketing = UNIFORM SPREAD: a candle's volume is distributed
 *   across the bins its [low, high] span overlaps, proportional to overlap
 *   length (a one-price candle h==l assigns all volume to its containing
 *   bin). POC = the bin with maximum volume (ties -> lowest-priced bin);
 *   POC price = bin midpoint. Value Area expands outward from the POC bin,
 *   at each step adding the neighboring bin (upper or lower) with MORE
 *   volume (exact tie -> expand UP first), until cumulative volume >= 70% of
 *   the window total. VAH = top EDGE of the accumulated range, VAL = bottom
 *   edge.
 *
 * Trigger (evaluated on the just-CLOSED 1m candle, strict inequalities):
 *   PUT : high > VAH  AND  close < VAH   (pierced the top of value, closed
 *                                         back inside — rejection)
 *   CALL: low  < VAL  AND  close > VAL   (mirror at the bottom)
 *   A candle that pierces BOTH VAH and VAL is noise, not a fade signal ->
 *   NO_TRADE (BOTH_PIERCED, frozen rule; counted in the funnel).
 *   A zero-range trigger candle (high == low) cannot size a stop ->
 *   NO_TRADE (ZERO_RANGE).
 *
 * Exit (triple-barrier, resolved by backtest/tripleBarrier.mjs):
 *   Entry = the trigger candle's close.
 *   SL    = trigger high + 0.1 x trigger range (PUT)
 *           trigger low  - 0.1 x trigger range (CALL)   [the invalidation
 *           wick plus a small buffer against exact-wick noise]
 *   R     = |entry - SL|
 *   TP variants (three, reported side by side, never cherry-picked):
 *     (a) 1.5 R   (b) 3 R   (c) the POC price frozen at decision time
 *         ("classic" VP fade target — reversion toward the point of
 *         control; its realized R varies trade to trade). If the POC is NOT
 *         strictly on the profitable side of entry (POC >= entry for PUT /
 *         POC <= entry for CALL) the classic target is degenerate — that
 *         trade runs with NO profit barrier (SL/time-barrier only) and is
 *         flagged pocDegenerate. Never re-centered mid-trade.
 *   Max hold 120 minutes -> TIMEOUT exit at that candle's close (own bucket,
 *   own realized R, excluded from the headline win rate). Data-end before
 *   resolution -> CENSORED (reported separately).
 *
 * ── No-lookahead contract ───────────────────────────────────────────────────
 * The decision for 1m index i reads ONLY candles[0..i-1] (the 1440 most
 * recent of them form the profile) plus candle i's own OHLC (the candle being
 * judged, which is fully closed at the decision moment). Mutating ANY candle
 * after index i cannot change the decision for i — proven by mutation in
 * scripts/frvp_tests.mjs. Mutating candle i changes the trigger judgment but
 * NOT the profile (the trigger candle is excluded from its own profile).
 *
 * Candle shape everywhere: { t, o, h, l, c, v } — t = OPEN time in ms UTC.
 */

export const FRVP_MS_1M = 60_000;

// ── Frozen constants, committed before the first backtest run ───────────────
export const FRVP_BINS = 50;            // price bins over the 24h range
export const FRVP_VA_PCT = 0.70;        // value area = 70% of window volume
export const FRVP_BUFFER_X = 0.1;       // SL buffer = 0.1 x trigger candle range
export const FRVP_MAX_HOLD_MIN = 120;   // time barrier (minutes)
export const FRVP_WINDOW_BARS = 1440;   // trailing 24h of 1m candles
export const FRVP_TP_R1 = 1.5;          // TP variant (a), in R
export const FRVP_TP_R2 = 3.0;          // TP variant (b), in R

// ── Volume allocation (single shared code path: reference builder, the
//    incremental state, tests and the verifier all call THIS function, so
//    binning is identical everywhere by construction) ────────────────────────
/**
 * Split candle c's volume across bins over [lo, lo + width*bins].
 * Returns an array of [binIndex, volume] pairs (1..bins entries, usually 1-3
 * for 1m candles). Deterministic; contributions sum to c.v (within FP).
 * A single-price candle (h === l) puts all volume in its containing bin.
 */
export function allocCandleVolume(c, lo, width, bins) {
  const l = c.l, h = c.h, v = c.v;
  if (!(v > 0)) return [];
  if (!(width > 0)) return [];
  if (h === l) {
    // one-price candle: containing bin, clamped into [0, bins-1]
    let k = Math.floor((l - lo) / width);
    if (!(k >= 0)) k = 0;
    if (k > bins - 1) k = bins - 1;
    return [[k, v]];
  }
  // fractional positions of [l, h] inside the bin grid
  const fLo = Math.max(0, (l - lo) / width);
  const fHi = Math.min(bins, (h - lo) / width);
  const kStart = Math.min(bins - 1, Math.floor(fLo));
  const kEnd = Math.min(bins - 1, Math.floor(Math.max(fHi - 1e-12, fLo)));
  const span = fHi - fLo;
  if (!(span > 0)) return allocCandleVolume({ ...c, h: l }, lo, width, bins); // degenerate guard
  const out = [];
  for (let k = kStart; k <= kEnd; k++) {
    // overlap of [l,h] with bin k = [k, k+1] in fractional space
    const oLo = Math.max(fLo, k);
    const oHi = Math.min(fHi, k + 1);
    const len = oHi - oLo;
    if (len > 0) out.push([k, v * (len / span)]);
  }
  if (out.length === 0) out.push([kStart, v]); // FP corner: never drop volume
  return out;
}

// ── Reference profile builder (full recompute over an explicit window) ──────
/**
 * buildProfile(candles, opts) — candles = the EXACT window (already sliced by
 * the caller; for production that is 1440 closed 1m candles strictly before
 * the decision). Returns null-safe result object; `degenerate` marks windows
 * that cannot produce a tradable profile (flat range or zero volume).
 */
export function buildProfile(candles, opts = {}) {
  const bins = opts.bins ?? FRVP_BINS;
  const vaPct = opts.vaPct ?? FRVP_VA_PCT;
  const n = candles.length;
  if (n === 0) return { degenerate: true, reason: 'EMPTY_WINDOW' };

  let lo = Infinity, hi = -Infinity, totalVol = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
    totalVol += c.v;
  }
  if (!(hi > lo)) return { degenerate: true, reason: 'FLAT_WINDOW', lo, hi, totalVol };
  if (!(totalVol > 0)) return { degenerate: true, reason: 'ZERO_VOLUME', lo, hi, totalVol };

  const width = (hi - lo) / bins;
  const binsVol = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    for (const [k, vol] of allocCandleVolume(candles[i], lo, width, bins)) {
      binsVol[k] += vol;
    }
  }

  // POC: argmax, ties -> lowest-priced (lowest index) bin
  let pocIdx = 0;
  for (let k = 1; k < bins; k++) if (binsVol[k] > binsVol[pocIdx]) pocIdx = k;
  const pocPrice = lo + (pocIdx + 0.5) * width;

  // Value area: expand from POC, greedier neighbor first (tie -> UP), until
  // cumulative >= vaPct * total. VAH/VAL are EDGES of the accumulated range.
  let vaLoIdx = pocIdx, vaHiIdx = pocIdx, cum = binsVol[pocIdx];
  const target = vaPct * totalVol;
  let kLo = pocIdx - 1, kHi = pocIdx + 1;
  while (cum < target && (kLo >= 0 || kHi <= bins - 1)) {
    let k;
    if (kLo < 0) k = kHi++;
    else if (kHi > bins - 1) k = kLo--;
    else k = (binsVol[kHi] >= binsVol[kLo]) ? kHi++ : kLo--;
    cum += binsVol[k];
    if (k < vaLoIdx) vaLoIdx = k;
    if (k > vaHiIdx) vaHiIdx = k;
  }
  const vah = lo + (vaHiIdx + 1) * width;
  const val = lo + vaLoIdx * width;

  return {
    degenerate: false, reason: null,
    lo, hi, width, bins: binsVol, binsCount: bins,
    totalVol, pocIdx, pocPrice, vaLoIdx, vaHiIdx, vah, val,
    n,
  };
}

// ── Incremental sliding-window state (O(1) slide, O(n) rebuild on edge
//    change, periodic re-anchor to bound FP drift) ───────────────────────────
/**
 * Maintains EXACTLY the profile of the last `windowBars` pushed candles.
 * push(c) appends; once full, each push evicts the oldest. profile() returns
 * the same fields as buildProfile over the current window. Guarantees:
 *   - the binning itself always runs through allocCandleVolume (shared code);
 *   - bin edges (lo/hi) are recomputed on ANY window-extreme change and the
 *     bins fully rebuilt then (a candle can only map to a bin via the CURRENT
 *     edges — caching allocations across edge changes is forbidden);
 *   - a full rebuild re-anchors accumulated FP drift every reanchorEvery
 *     pushes.
 */
export class FrvpProfileState {
  constructor(opts = {}) {
    this.windowBars = opts.windowBars ?? FRVP_WINDOW_BARS;
    this.binsCount = opts.bins ?? FRVP_BINS;
    this.vaPct = opts.vaPct ?? FRVP_VA_PCT;
    this.reanchorEvery = opts.reanchorEvery ?? 10_000;
    this.buf = new Array(this.windowBars);
    this.count = 0;         // candles currently in window
    this.head = 0;          // next write position (ring)
    this.lo = null; this.hi = null;
    this.binsVol = new Float64Array(this.binsCount);
    this.totalVol = 0;
    this.pushes = 0;
  }

  get size() { return this.count; }
  get ready() { return this.count === this.windowBars; }

  _fullRebuild() {
    const n = this.count;
    // ring order -> chronological order
    const start = (this.head - n + this.windowBars) % this.windowBars;
    let lo = Infinity, hi = -Infinity, tv = 0;
    for (let j = 0; j < n; j++) {
      const c = this.buf[(start + j) % this.windowBars];
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
      tv += c.v;
    }
    this.lo = lo; this.hi = hi; this.totalVol = tv;
    this.binsVol = new Float64Array(this.binsCount);
    if (!(hi > lo) || !(tv > 0)) return;
    const width = (hi - lo) / this.binsCount;
    for (let j = 0; j < n; j++) {
      const c = this.buf[(start + j) % this.windowBars];
      for (const [k, vol] of allocCandleVolume(c, lo, width, this.binsCount)) {
        this.binsVol[k] += vol;
      }
    }
  }

  push(c) {
    this.pushes++;
    if (this.count < this.windowBars) {
      this.buf[this.head] = c;
      this.head = (this.head + 1) % this.windowBars;
      this.count++;
      if (this.count === this.windowBars) this._fullRebuild();
      else {
        // still warming: keep totals cheap; bins unused until ready
        if (c.l < (this.lo ?? Infinity)) this.lo = c.l;
        if (c.h > (this.hi ?? -Infinity)) this.hi = c.h;
        this.totalVol += c.v;
      }
      if (this.pushes % this.reanchorEvery === 0 && this.ready) this._fullRebuild();
      return;
    }
    const evict = this.buf[this.head];
    const prevLo = this.lo, prevHi = this.hi;
    // slide: write incoming at the evicted slot
    this.buf[this.head] = c;
    this.head = (this.head + 1) % this.windowBars;

    // update extremes: rescan only if the evicted candle held one
    if (evict.l === prevLo || evict.h === prevHi) {
      let lo = Infinity, hi = -Infinity;
      const start = (this.head - this.windowBars + this.windowBars) % this.windowBars;
      for (let j = 0; j < this.windowBars; j++) {
        const w = this.buf[(start + j) % this.windowBars];
        if (w.l < lo) lo = w.l;
        if (w.h > hi) hi = w.h;
      }
      this.lo = lo; this.hi = hi;
    } else {
      if (c.l < this.lo) this.lo = c.l;
      if (c.h > this.hi) this.hi = c.h;
    }
    this.totalVol = this.totalVol - evict.v + c.v;

    if (this.lo !== prevLo || this.hi !== prevHi) {
      this._fullRebuild();               // edges moved -> re-bin everything
    } else {
      const width = (this.hi - this.lo) / this.binsCount;
      for (const [k, vol] of allocCandleVolume(evict, this.lo, width, this.binsCount)) {
        this.binsVol[k] -= vol;
      }
      for (const [k, vol] of allocCandleVolume(c, this.lo, width, this.binsCount)) {
        this.binsVol[k] += vol;
      }
    }
    if (this.pushes % this.reanchorEvery === 0) this._fullRebuild();
  }

  /** Profile snapshot for the current window — same fields as buildProfile. */
  profile() {
    if (!this.ready) return { degenerate: true, reason: 'WARMUP_INSUFFICIENT', n: this.count };
    const { lo, hi, totalVol, binsCount } = this;
    if (!(hi > lo)) return { degenerate: true, reason: 'FLAT_WINDOW', lo, hi, totalVol, n: this.count };
    if (!(totalVol > 0)) return { degenerate: true, reason: 'ZERO_VOLUME', lo, hi, totalVol, n: this.count };
    const width = (hi - lo) / binsCount;
    const binsVol = this.binsVol;
    let pocIdx = 0;
    for (let k = 1; k < binsCount; k++) if (binsVol[k] > binsVol[pocIdx]) pocIdx = k;
    const pocPrice = lo + (pocIdx + 0.5) * width;
    let vaLoIdx = pocIdx, vaHiIdx = pocIdx, cum = binsVol[pocIdx];
    const target = this.vaPct * totalVol;
    let kLo = pocIdx - 1, kHi = pocIdx + 1;
    while (cum < target && (kLo >= 0 || kHi <= binsCount - 1)) {
      let k;
      if (kLo < 0) k = kHi++;
      else if (kHi > binsCount - 1) k = kLo--;
      else k = (binsVol[kHi] >= binsVol[kLo]) ? kHi++ : kLo--;
      cum += binsVol[k];
      if (k < vaLoIdx) vaLoIdx = k;
      if (k > vaHiIdx) vaHiIdx = k;
    }
    return {
      degenerate: false, reason: null,
      lo, hi, width, bins: binsVol, binsCount,
      totalVol, pocIdx, pocPrice, vaLoIdx, vaHiIdx,
      vah: lo + (vaHiIdx + 1) * width,
      val: lo + vaLoIdx * width,
      n: this.count,
    };
  }
}

// ── Trigger + barrier construction (pure) ───────────────────────────────────
/**
 * decideFromProfile(profile, trig, opts) — the frozen trigger + barrier logic
 * given an ALREADY-BUILT profile of the decision window. Both the reference
 * path (evaluateFrvpBar) and the harness (FrvpProfileState.profile()) feed
 * THIS function, so trigger semantics are identical everywhere.
 */
export function decideFromProfile(p, trig, opts = {}) {
  const bufferX = opts.bufferX ?? FRVP_BUFFER_X;
  const tpR1 = opts.tpR1 ?? FRVP_TP_R1;
  const tpR2 = opts.tpR2 ?? FRVP_TP_R2;

  const base = {
    trigT: trig.t, trigO: trig.o, trigH: trig.h, trigL: trig.l, trigC: trig.c,
  };
  if (!p || p.degenerate) {
    return { ...base, decision: 'NO_TRADE', reason: p ? p.reason : 'NO_PROFILE', profile: p };
  }

  const { vah, val, pocPrice } = p;
  const piercedTop = trig.h > vah;       // strict
  const piercedBot = trig.l < val;       // strict
  if (piercedTop && piercedBot) {
    return { ...base, decision: 'NO_TRADE', reason: 'BOTH_PIERCED', profile: p };
  }

  let decision = null;
  if (piercedTop && trig.c < vah) decision = 'PUT';
  else if (piercedBot && trig.c > val) decision = 'CALL';
  if (decision == null) {
    return {
      ...base, decision: 'NO_TRADE',
      reason: piercedTop ? 'PIERCE_NO_REJECT' : piercedBot ? 'PIERCE_NO_REJECT' : 'NO_TRIGGER',
      profile: p,
    };
  }

  const range = trig.h - trig.l;
  if (!(range > 0)) {
    return { ...base, decision: 'NO_TRADE', reason: 'ZERO_RANGE', profile: p };
  }

  const buffer = bufferX * range;
  const entry = trig.c;
  const sl = decision === 'PUT' ? trig.h + buffer : trig.l - buffer;
  const rAbs = decision === 'PUT' ? sl - entry : entry - sl;   // > 0 by construction
  const rFrac = rAbs / entry;
  const sign = decision === 'PUT' ? -1 : 1;
  const tp15 = entry + sign * tpR1 * rAbs;
  const tp3 = entry + sign * tpR2 * rAbs;
  // classic POC target: valid only strictly on the profitable side
  const pocDegenerate = decision === 'PUT' ? !(pocPrice < entry) : !(pocPrice > entry);
  const tpPoc = pocDegenerate ? null : pocPrice;

  return {
    ...base, decision, reason: 'TRIGGER', profile: p,
    entry, sl, buffer, rAbs, rFrac,
    tp15, tp3, tpPoc, pocDegenerate,
  };
}

/**
 * evaluateFrvpBar(windowCandles, trig, opts) — REFERENCE path: builds the
 * profile from the last FRVP_WINDOW_BARS candles of windowCandles (the frozen
 * rule: these must be the closed candles strictly before trig's close — the
 * caller slices; slice(-windowBars) enforces the cap) and then applies
 * decideFromProfile. Tests and the verifier use this path on sampled rows.
 */
export function evaluateFrvpBar(windowCandles, trig, opts = {}) {
  const windowBars = opts.windowBars ?? FRVP_WINDOW_BARS;
  if (windowCandles.length < windowBars) {
    return {
      trigT: trig.t, trigO: trig.o, trigH: trig.h, trigL: trig.l, trigC: trig.c,
      decision: 'NO_TRADE', reason: 'WARMUP_INSUFFICIENT', profile: null,
    };
  }
  const p = buildProfile(windowCandles.slice(-windowBars), {
    bins: opts.bins, vaPct: opts.vaPct,
  });
  return decideFromProfile(p, trig, opts);
}

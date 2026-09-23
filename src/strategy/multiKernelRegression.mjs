/**
 * Multi Kernel Regression [ChartPrime] — port of the TradingView Pine v5
 * indicator, BOTH branches, each byte-matched to the official source
 * (frozen copy: src/strategy/reference/multi-kernel-regression-chartprime.pine,
 * fetched from tradingview.com/script/o4YRa7e8 2026-09-21):
 *
 *   repaint     = input.bool(true, "Repaint")            // DEFAULT true, HIDDEN input
 *   kernel      = input.string("Laplace", "Kernel Select", [...17 kernels])
 *   bandwidth   = input.int(14, 'Bandwidth', 1)
 *   source      = input.source(close, 'Source')
 *   deviations  = input.float(2.0, 'Deviation', 0, 100, 0.25)
 *
 * ── MODE 'tv' (repaint=true — what the user's chart SHOWS) ──────────────────
 * computeMkrTv(). The script precalculates w(d) = kernel(d, bandwidth) for
 * bar distances d = -499..499, then on every barstate.islast re-fits the
 * whole visible curve: estimate at offset i (0 = newest bar) is
 *   M(i) = sum_j source[j] * w(i-j) / sum_j w(i-j),   j = 0..min(bar_index,499)
 * a TWO-SIDED kernel smoother (for Laplace, w decays as exp(-|d|/B)), which
 * is why the chart line is far smoother than any 14-bar causal average.
 * Labels — the indicator's ONLY trading output — come from consecutive
 * curve deltas (loop runs newest -> oldest, delta(i) = M(i) - M(i-1)):
 *   delta(i) > 0 and delta(i-1) < 0  ->  "Up"   at offset i-1 (local MIN)
 *   delta(i) < 0 and delta(i-1) > 0  ->  "Down" at offset i-1 (local MAX)
 * An extremum is only knowable once TWO curve points exist to its right, so
 * a label at bar b appears when bar b+1 closes — the bot's detection bar.
 * Because the curve re-fits every bar, TV redraws its whole label set each
 * bar (the script erases labels on barstate.isconfirmed and re-adds them on
 * the next islast). The bot mirrors the chart's LIVE behavior: on every
 * normal tick ONLY the newest knowable label (offset 1 — knowable at the
 * very next candle close) is emitted; history dedup (same engine +
 * direction + entry candle) makes re-detections idempotent, so a label is
 * delivered exactly once, at the first tick it exists — never twice, never
 * before TV could show it, and never resurfaced from older offsets as a
 * fake "fresh" alert. Older offsets pass ONLY through the small downtime
 * catch-up window (see MKR_TV_EMIT_WINDOW below).
 *
 * Timing contract: events are computed from CLOSED candles only (meta
 * .lastClosed = last closed index; the forming candle never enters the
 * curve). Each event carries:
 *   closeT  close of the LABEL candle (what TV anchors the label to; used
 *           for grouping, history and the message's candle line)
 *   gateT   close of the DETECTION candle (when the label became knowable;
 *           used by the scanner's pending-event gate)
 * Caveat inherited from the indicator itself: a very fresh label can still
 * shift/vanish on TV as the next bar re-fits the curve; the bot does not
 * unsend (CFD lifecycle needs immutable flips).
 *
 * ── CLASSIFICATION (standing rule — README "Repainting vs causal") ─────────
 * MKR 'tv' is REPAINTING: the two-sided fit re-shapes older offsets every
 * bar, so an extremum can "newly" satisfy the sign-flip condition many
 * hours after its bar — and every label TV anchors at bar b only appears
 * when bar b+1 closes (so the chart shows it before the bot may emit it).
 * The owner experienced exactly this as "the bot delivers the sell the
 * chart gave long ago, whenever UT Bot fires" (2026-09-23) and ruled:
 * MKR must analyze chart data like UT Bot does. PRODUCTION DEFAULT is
 * therefore mode 'nrp' since v1.9.0 (registry defaultCfg + live KV): a
 * CAUSAL / non-repainting engine whose value at bar N depends only on
 * bars <= N, flips fire at the flip bar's own close, and no emit-window
 * question arises at all. 'tv' remains ported and selectable per pair
 * (bot panel Mode enum) for chart-parity comparison: in 'tv', normal
 * operation only emits offset-1 labels; a backfill window (hard cap
 * MKR_TV_EMIT_WINDOW = 4 candles) opens exclusively for PROVEN scanner
 * downtime, detected by comparing meta.lastScanT to meta.now — never on
 * a routine tick.
 *
 * ── MODE 'nrp' (repaint=false — the script's own stable mode, and the
 *    PRODUCTION DEFAULT since v1.9.0) ──────────────────────────────────────
 * computeMultiKernelRegression(). One-sided kernel-weighted MA of the last
 * `bandwidth` closes with precalculated weights
 *   weight(i) = kernel((i/B)^2, 1)
 * and labels on ta.crossover/crossunder(nrp_sum, nrp_sum[1]) — flips fire at
 * the flip bar's own close (no detection delay, no gateT, deterministic
 * history). Kept byte-compatible with the previous port (mkr_tests);
 * selectable via config indicators.mkr.mode ('tv' = opt-in repaint branch).
 *
 * Shared Pine semantics (both modes):
 *   K1  the 17 kernel functions are verbatim (see kernelFn)
 *   K2  nz() zero-fill for pre-window bars — nrp only; irrelevant in
 *       production (full windows) but kept for exactness
 *   K5  defaults = TradingView defaults: kernel Laplace, bandwidth 14,
 *       source close, deviations 2.0
 *
 * Candle shape everywhere: { t, o, h, l, c } — t = OPEN time in ms UTC.
 */

export const MKR_KERNELS = [
  'Triangular', 'Gaussian', 'Epanechnikov', 'Logistic', 'Log Logistic',
  'Cosine', 'Sinc', 'Laplace', 'Quartic', 'Parabolic', 'Exponential',
  'Silverman', 'Cauchy', 'Tent', 'Wave', 'Power', 'Morters',
];

/** TradingView indicator defaults (K5). */
export const MKR_KERNEL_DEFAULT = 'Laplace';
export const MKR_BANDWIDTH_DEFAULT = 14;
export const MKR_DEVIATIONS_DEFAULT = 2.0;

export const MS_1M = 60_000;
export const TF_MS = { '1min': MS_1M, '5min': 300_000, '15min': 900_000 };

// ── The 17 kernel functions, verbatim from the script (u = u(x, bw)) ────────

/** sq(source) => math.pow(source, 2) — used inside several kernels. */
function sq(x) { return x * x; }

export function kernelFn(name) {
  switch (name) {
    case 'Triangular':
    case 'Tent':           // identical formulas in the script itself
      return (x, bw) => (Math.abs(x / bw) <= 1 ? 1 - Math.abs(x / bw) : 0.0);
    case 'Gaussian':
      return (x, bw) => Math.exp(-sq(x / bw) / 2) / Math.sqrt(2 * Math.PI);
    case 'Epanechnikov':
      return (x, bw) => (Math.abs(x / bw) <= 1 ? (3 / 4) * (1 - sq(x / bw)) : 0.0);
    case 'Logistic':
      return (x, bw) => 1 / (Math.exp(x / bw) + 2 + Math.exp(-x / bw));
    case 'Log Logistic':
      return (x, bw) => 1 / Math.pow(1 + Math.abs(x / bw), 2);
    case 'Cosine':
      return (x, bw) => (Math.abs(x / bw) <= 1
        ? (Math.PI / 4) * Math.cos((Math.PI / 2) * (x / bw)) : 0.0);
    case 'Sinc':
      return (x, bw) => (x === 0 ? 1
        : Math.sin(Math.PI * x / bw) / (Math.PI * x / bw));
    case 'Laplace':
      return (x, bw) => (1 / (2 * bw)) * Math.exp(-Math.abs(x / bw));
    case 'Quartic':
      return (x, bw) => (Math.abs(x / bw) <= 1
        ? (15 / 16) * Math.pow(1 - sq(x / bw), 2) : 0.0);
    case 'Parabolic':
      return (x, bw) => (Math.abs(x / bw) <= 1 ? 1 - sq(x / bw) : 0.0);
    case 'Exponential':
      return (x, bw) => (1 / bw) * Math.exp(-Math.abs(x / bw));
    case 'Silverman':
      return (x, bw) => (Math.abs(x / bw) <= 0.5
        ? 0.5 * Math.exp(-(x / bw) / 2) * Math.sin((x / bw) / 2 + Math.PI / 4)
        : 0.0);
    case 'Cauchy':
      return (x, bw) => 1 / (Math.PI * bw * (1 + sq(x / bw)));
    case 'Wave':
      return (x, bw) => (Math.abs(x / bw) <= 1
        ? (1 - Math.abs(x / bw)) * Math.cos((Math.PI * x) / bw) : 0.0);
    case 'Power':
      return (x, bw) => (Math.abs(x / bw) <= 1
        ? Math.pow(1 - Math.pow(Math.abs(x / bw), 3), 3) : 0.0);
    case 'Morters':
      return (x, bw) => (Math.abs(x / bw) <= Math.PI
        ? (1 + Math.cos(x / bw)) / (2 * Math.PI * bw) : 0.0);
    default:
      throw new Error('multiKernelRegression: unknown kernel "' + name + '"');
  }
}

// ── Weight precalculation (precalculate_nrp, K1) ────────────────────────────

const weightCache = new Map();   // "kernel|bw" -> { weights, sumw }

/**
 * Weights for the non-repaint estimator: w[i] = kernel((i/B)^2, 1),
 * i = 0..B-1 (K1). Cached — the array is deterministic per (kernel, B).
 */
export function kernelWeights(bandwidth, kernelName) {
  const key = kernelName + '|' + bandwidth;
  const hit = weightCache.get(key);
  if (hit) return hit;
  const f = kernelFn(kernelName);
  const weights = new Array(bandwidth);
  let sumw = 0;
  for (let i = 0; i < bandwidth; i++) {
    const j = (i * i) / (bandwidth * bandwidth);   // math.pow(i,2)/math.pow(bw,2)
    const w = f(j, 1);                             // kernel(j, 1) — bw = 1 (K1)
    weights[i] = w;
    sumw += w;
  }
  const out = { weights, sumw };
  weightCache.set(key, out);
  return out;
}

// ── The indicator ────────────────────────────────────────────────────────────

/**
 * Compute the full non-repaint Multi Kernel Regression series over an
 * ascending candle array.
 *
 * @param {Array} candles ascending { t,o,h,l,c }
 * @param {object} [opts] { kernel, bandwidth, deviations }
 * @param {object} [meta] { tfMs } — candle period in ms (event close-time
 *   stamping); inferred from the first two candles when omitted.
 * @returns {{ value:number[], stdev:(number|undefined)[], dirUp:boolean[],
 *             up:boolean[], down:boolean[], events:Array, params:{kernel, bandwidth, deviations} }}
 *   value[i]  = nrp_sum  (kernel-weighted MA of the last B closes)
 *   stdev[i]  = nrp_stdev (deviation-scaled band width; undefined when the
 *               full window is not yet available or B < 2)
 *   dirUp[i]  = slope > 0 (the indicator's color boolean)
 *   events: [{ i, t, closeT, type:'up'|'down', price, value, valuePrev, stdev }]
 */
export function computeMultiKernelRegression(candles, opts = {}, meta = {}) {
  const kernel = opts.kernel === undefined ? MKR_KERNEL_DEFAULT : String(opts.kernel);
  const bandwidth = opts.bandwidth === undefined ? MKR_BANDWIDTH_DEFAULT
    : Math.trunc(Number(opts.bandwidth));
  if (!Number.isFinite(bandwidth) || bandwidth < 1) {
    throw new Error('multiKernelRegression: bandwidth must be >= 1');
  }
  const deviations = opts.deviations === undefined ? MKR_DEVIATIONS_DEFAULT : Number(opts.deviations);
  const n = candles.length;
  const B = bandwidth;

  const { weights, sumw } = kernelWeights(B, kernel);

  const value = new Array(n);
  const stdev = new Array(n).fill(undefined);
  const dirUp = new Array(n).fill(false);
  const up = new Array(n).fill(false);
  const down = new Array(n).fill(false);
  const events = [];

  let tfMs = meta.tfMs;
  if (!tfMs && n >= 2) tfMs = Math.max(1, candles[1].t - candles[0].t);

  // nrp_sum — kernel-weighted MA of the last B closes (K2: missing -> 0).
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < B; k++) {
      const idx = i - k;
      sum += weights[k] * (idx >= 0 ? candles[idx].c : 0);   // nz(source[k], 0)
    }
    value[i] = sum / sumw;
  }

  // nrp_stdev — deviation band width (display-only; K4 full-window guard).
  for (let i = 0; i < n; i++) {
    if (B < 2 || i < B - 1) continue;      // (B-1) denominator + full window
    let sumsq = 0;
    for (let k = 0; k < B; k++) {
      const idx = i - k;                    // i >= B-1  =>  idx >= 0
      const d = candles[idx].c - value[idx];
      sumsq += d * d;
    }
    stdev[i] = Math.sqrt(sumsq / (B - 1)) * deviations;
  }

  // Direction + crossover/crossunder labels (K3), full-window guard (K4).
  for (let i = 0; i < n; i++) {
    const v0 = value[i];
    const v1 = i >= 1 ? value[i - 1] : undefined;
    const v2 = i >= 2 ? value[i - 2] : undefined;
    dirUp[i] = i >= 1 ? v0 - v1 > 0 : false;   // Pine: nrp_sum - nrp_sum[1] > 0
    if (i < 2 || i < B - 1) continue;      // K4: full kernel window + 2 lookback
    const crossUp = v0 > v1 && v1 <= v2;   // ta.crossover(nrp_sum, nrp_sum[1])
    const crossDown = v0 < v1 && v1 >= v2; // ta.crossunder(nrp_sum, nrp_sum[1])
    up[i] = crossUp;
    down[i] = crossDown;
    if (crossUp || crossDown) {
      events.push({
        i,
        t: candles[i].t,
        closeT: tfMs ? candles[i].t + tfMs : undefined,
        type: crossUp ? 'up' : 'down',
        price: candles[i].c,
        value: v0,
        valuePrev: v1,
        stdev: stdev[i],
      });
    }
  }

  return { value, stdev, dirUp, up, down, events, params: { kernel, bandwidth: B, deviations } };
}

// ── MODE 'tv' — the chart's default repaint branch, ported exactly ─────────

export const MKR_MODE_TV = 'tv';
export const MKR_MODE_NRP = 'nrp';
export const MKR_MODES = [MKR_MODE_TV, MKR_MODE_NRP];
const MKR_TV_MAX_WINDOW = 500;   // script: max_bars_back = 500, loops cap at 499
// Downtime catch-up cap, in candles — the ONLY backfill tolerance this
// repainting branch is allowed. The two-sided fit re-shapes older offsets
// every bar, so an extremum that "newly" satisfies the sign-flip condition
// at an old offset is chart history, not a live event; normal operation
// must never emit it (only offset 1 — knowable at the very next candle
// close — is a live signal). When the scanner PROVABLY missed ticks (deploy,
// outage, platform cron silence — detected by comparing the stored lastScanT
// cursor to now, never on a routine tick), the window widens to 1 + missed
// candles, hard-capped here: at most a 1-hour backfill on a 15min pair.
// Beyond that an extremum is frozen chart history and must never fire as a
// bot message hours later (the 120-candle window this constant once had
// produced exactly that: an 18h45m "fresh" alert on a 15min pair).
const MKR_TV_EMIT_WINDOW = 4;

/**
 * Emission window for this tick, in label-bar offsets from the newest
 * closed candle.
 *
 * Standing rule (timeliness beats chart parity — README "Repainting vs
 * causal indicators"): a repainting label is only a LIVE signal while it is
 * the newest knowable detection — offset 1, knowable at the very next
 * candle close. Older offsets are emitted ONLY when the caller proves
 * genuine scanner downtime: more than one scan interval elapsed between the
 * stored lastScanT cursor and now. No proof (meta missing either field), a
 * fresh deploy, or a routine/manual tick keeps the window at 1. Proven
 * downtime widens it to 1 + missed candles, hard-capped at
 * MKR_TV_EMIT_WINDOW.
 *
 * @param {object} meta { fresh, now, lastScanT, tfMs }
 * @param {number} tfMs resolved candle period in ms
 * @returns {number} maximum emittable label offset (always >= 1)
 */
function mkrTvMaxOff(meta, tfMs) {
  if (meta.fresh) return 1;   // fresh deploy: newest knowable label only
  const now = Number(meta.now);
  const lastScanT = Number(meta.lastScanT);
  // No downtime proof -> fail closed: newest label only.
  if (!Number.isFinite(now) || !Number.isFinite(lastScanT)
    || lastScanT <= 0 || !Number.isFinite(tfMs) || tfMs <= 0) return 1;
  // Candle closes elapsed since the last processed close, minus the one this
  // tick processes anyway. A routine tick (or an early/manual poll) gives
  // missed < 1 -> no backfill.
  const missed = Math.floor((now - lastScanT) / tfMs) - 1;
  if (missed < 1) return 1;
  return Math.min(1 + missed, MKR_TV_EMIT_WINDOW);
}

/**
 * The script's repaint estimator (what the user's TradingView chart draws).
 *
 * Port of `precalculate` + the `barstate.islast` block of the official
 * source: w(d) = kernel(d, bandwidth) for signed distances, curve value at
 * offset i = sum_j source[j] * w(i-j) / sum_j w(i-j) over the newest
 * min(bars, 500) CLOSED candles, labels on consecutive-delta sign flips.
 *
 * @param {Array} candles ascending { t,o,h,l,c }
 * @param {object} [opts] { kernel, bandwidth, deviations }
 * @param {object} [meta] { tfMs, lastClosed } — lastClosed = index of the
 *   last CLOSED candle; when omitted every candle is treated as closed.
 * @returns same series shape as computeMultiKernelRegression (value, stdev,
 *   dirUp, up, down, events, params) plus { mode: 'tv' }.
 */
export function computeMkrTv(candles, opts = {}, meta = {}) {
  const kernel = opts.kernel === undefined ? MKR_KERNEL_DEFAULT : String(opts.kernel);
  const bandwidth = opts.bandwidth === undefined ? MKR_BANDWIDTH_DEFAULT
    : Math.trunc(Number(opts.bandwidth));
  if (!Number.isFinite(bandwidth) || bandwidth < 1) {
    throw new Error('multiKernelRegression tv: bandwidth must be >= 1');
  }
  const deviations = opts.deviations === undefined ? MKR_DEVIATIONS_DEFAULT : Number(opts.deviations);
  const f = kernelFn(kernel);

  // Closed-candle discipline: the forming candle never enters the curve.
  const lastClosed = Number.isFinite(meta.lastClosed)
    ? Math.min(Math.trunc(meta.lastClosed), candles.length - 1)
    : candles.length - 1;
  const nWin = lastClosed + 1;                       // candles inside the fit
  const N = Math.min(nWin - 1, MKR_TV_MAX_WINDOW - 1); // max offset (script: min(bar_index, 499))

  // w(d) = kernel(d, bandwidth) for signed d = i - j (script: precalculate).
  const w = new Float64Array(2 * N + 1);
  const wAt = d => w[d + N];
  for (let d = -N; d <= N; d++) w[d + N] = f(d, bandwidth);

  // src[j] = source (close) at offset j; j = 0 is the newest closed candle.
  const src = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) src[j] = candles[lastClosed - j].c;

  // The curve + weighted stdev (script: sum/sumw, sqrt(sumsq/sumw - cur^2)).
  const M = new Float64Array(N + 1);
  const SD = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    let sum = 0, sumsq = 0, sumw = 0;
    for (let j = 0; j <= N; j++) {
      const weight = wAt(i - j);
      sum += src[j] * weight;
      sumsq += src[j] * src[j] * weight;
      sumw += weight;
    }
    M[i] = sum / sumw;
    SD[i] = Math.sqrt(Math.max(sumsq / sumw - M[i] * M[i], 0)) * deviations;
  }

  let tfMs = meta.tfMs;
  if (!tfMs && candles.length >= 2) tfMs = Math.max(1, candles[1].t - candles[0].t);

  // Labels: exact script conditions on consecutive deltas (local min -> Up,
  // local max -> Down, anchored at the extremum bar = offset i-1). The
  // extremum at offset i-1 needs the curve point at offset i, so on the
  // live chart it is knowable at the close of the offset-0 candle -> gateT.
  // Delta comparisons carry a 1e-12-relative epsilon: bit-identical closes
  // (repeated quotes) make the mathematically-flat curve jitter by ~1e-16
  // relative in float64, which must never fabricate a label. Real flips are
  // >= 1e-8 relative — five orders of magnitude above the guard.
  const eps = 1e-12 * Math.max(1, Math.abs(M[0]));
  const gateT = tfMs ? candles[lastClosed].t + tfMs : undefined;
  // Emission window for THIS tick (see mkrTvMaxOff): offset 1 in normal
  // operation; wider only for proven scanner downtime.
  const maxOff = mkrTvMaxOff(meta, tfMs);
  const events = [];
  for (let i = 2; i <= N; i++) {
    const dPrev = M[i - 1] - M[i - 2];   // previous_price_delta (newer pair)
    const dCur = M[i] - M[i - 1];        // delta (older pair)
    if ((dCur > eps && dPrev < -eps) || (dCur < -eps && dPrev > eps)) {
      const off = i - 1;                       // extremum offset (label bar)
      // Emission rule (timeliness beats chart parity): only the newest
      // knowable label is a live signal in normal operation. A repainting
      // curve re-fits every bar, so an extremum "newly" appearing at an old
      // offset is chart history resurfacing — never a fresh event. Older
      // offsets pass only inside the proven-downtime catch-up window.
      if (off > maxOff) continue;
      const barIdx = lastClosed - off;
      events.push({
        i: barIdx,
        t: candles[barIdx].t,
        closeT: tfMs ? candles[barIdx].t + tfMs : undefined,
        gateT,
        type: dCur > 0 ? 'up' : 'down',        // local min -> Up, local max -> Down
        price: candles[barIdx].c,
        value: M[off],
        valuePrev: M[off - 1],
        stdev: SD[off],
        offset: off,
      });
    }
  }
  events.reverse();   // oldest first (pipeline ordering convention)

  // Series arrays in full bar-index space (undefined outside the 500-bar
  // window) so the registry snapshot / API shape matches nrp mode.
  const n = candles.length;
  const value = new Array(n).fill(undefined);
  const stdev = new Array(n).fill(undefined);
  const dirUp = new Array(n).fill(false);
  const up = new Array(n).fill(false);
  const down = new Array(n).fill(false);
  for (let off = 0; off <= N; off++) {
    const idx = lastClosed - off;
    value[idx] = M[off];
    stdev[idx] = SD[off];
    // forward slope into this bar: newer curve point above older one
    dirUp[idx] = off >= 1 ? (M[off - 1] - M[off] > 0) : (N >= 1 ? M[0] - M[1] > 0 : false);
  }
  for (const e of events) {
    if (e.type === 'up') up[e.i] = true;
    else down[e.i] = true;
  }

  return {
    value, stdev, dirUp, up, down, events,
    mode: MKR_MODE_TV,
    params: { kernel, bandwidth, deviations },
    lastValue: M[0],
    lastDelta: N >= 1 ? M[0] - M[1] : undefined,
  };
}

// ── Live-worker helpers ──────────────────────────────────────────────────────

/**
 * Map an MKR event to the CFD vocabulary. The indicator's own words are
 * "Up"/"Down" (its label texts); the CFD ledger direction is Up -> BUY,
 * Down -> SELL. NO expiry — the setup stands until the indicator prints the
 * opposite label (same contract as UT Bot, user requirement 2026-09-19).
 * The indicator's native fields ride in `audit` untouched.
 */
export function mkrEventToSignal(event, pair, extra = {}) {
  return {
    engine: 'MKR',
    finalSignal: event.type === 'up' ? 'BUY' : 'SELL',
    reason: event.type === 'up' ? 'MKR_SLOPE_FLIP_UP' : 'MKR_SLOPE_FLIP_DOWN',
    pair,
    market: extra.market || 'FOREX',
    timeframe: extra.timeframe,
    timestamp: extra.timestamp,
    currentPrice: event.price,
    audit: {
      event: event.type,                    // native: 'up' | 'down'
      label: event.type === 'up' ? 'Up' : 'Down',
      mode: extra.mode,                     // 'nrp' (production default) | 'tv' (opt-in)
      kernel: extra.kernel,
      bandwidth: extra.bandwidth,
      value: event.value,
      valuePrev: event.valuePrev,
      stdev: event.stdev,
      timeframe: extra.timeframe,
      eventCandle: { t: event.t, closeT: event.closeT },
      // tv mode only: the label becomes knowable one candle after the bar
      // TV anchors it to — this is that detection close (ISO). Causal nrp
      // events carry no gateT: the label IS the flip bar's own close.
      confirmedAt: event.gateT != null ? new Date(event.gateT).toISOString() : undefined,
      barIndex: event.i,
    },
    entryPrice: event.price,
    entryTime: extra.timestamp,
    expiryMinutes: null,
    expiryTime: null,
    atrPercentile: null,
  };
}

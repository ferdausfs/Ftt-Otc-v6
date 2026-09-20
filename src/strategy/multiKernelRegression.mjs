/**
 * Multi Kernel Regression [ChartPrime] — port of the TradingView Pine v5
 * indicator, NON-REPAINT path only (the script's Repaint input = false).
 *
 * Reference (frozen; the ONLY source of truth for this module) — the pasted
 * ChartPrime script, non-repaint branch:
 *
 *   repaint     = input.bool(true, "Repaint")            // PORT USES false
 *   kernel      = input.string("Laplace", "Kernel Select", [...17 kernels])
 *   bandwidth   = input.int(14, 'Bandwidth', 1)
 *   source      = input.source(close, 'Source')
 *   deviations  = input.float(2.0, 'Deviation', 0, 100, 0.25)
 *
 *   precalculate_nrp(bandwidth, kernel)=>
 *       for i = 0 to bandwidth - 1
 *           j = math.pow(i, 2) / (math.pow(bandwidth, 2))
 *           weight = kernel(j, 1, kernel)        // NOTE: bandwidth 1 here
 *           weights.push(weight); sumw += weight
 *
 *   (every bar, non-repaint branch)
 *   float sum = 0.0
 *   for i = 0 to bandwidth - 1
 *       weight = weights.get(i)
 *       sum += nz(source[i]) * weight
 *   nrp_sum := sum / sumw
 *   direction = nrp_sum - nrp_sum[1] > 0
 *
 *   // labels (the indicator's ONLY trading output):
 *   if ta.crossover(nrp_sum, nrp_sum[1])  -> label "Up"   (bullish)
 *   if ta.crossunder(nrp_sum, nrp_sum[1]) -> label "Down" (bearish)
 *
 *   // deviation band (display-only; enable input defaults to false):
 *   for i = 0 to bandwidth - 1: sumsq += (source[i] - nrp_sum[i])^2
 *   nrp_stdev := sqrt(sumsq / (bandwidth - 1)) * deviations
 *
 * Why the non-repaint branch (and NOT the script default repaint=true):
 * the repaint branch redraws the whole 500-bar curve from barstate.islast
 * and ERASES every label on barstate.isconfirmed — its labels move/vanish
 * retroactively, so no bot can act on them. The non-repaint branch is the
 * script's own stable mode: nrp_sum is a plain kernel-weighted moving
 * average of the last `bandwidth` closes, labels confirm on candle close
 * and never change. On TradingView, set "Repaint" = false to see exactly
 * what this module computes.
 *
 * Pine semantics reproduced deliberately:
 *   K1  weight argument: x = (i/bandwidth)^2, evaluated at bandwidth = 1
 *       (the script passes kernel(j, 1, kernel) — do NOT "simplify" to
 *       kernel(i, bandwidth): for kernels like Laplace the two differ).
 *   K2  nz(source[i], 0): closes before the start of the fetched window
 *       contribute 0 with the FULL sumw (Pine's literal early-bar
 *       behavior). Irrelevant in production (300-bar window, events only
 *       read at the tail) but kept for exactness.
 *   K3  ta.crossover(a, b) with b = nrp_sum[1]:
 *       a[i] > b[i]  AND  a[i-1] <= b[i-1]
 *       -> v[i] > v[i-1] AND v[i-1] <= v[i-2]. Equality on the middle bar
 *       DOES allow a cross (matches UT Bot's P1 convention).
 *   K4  Events are emitted only for bars with a FULL kernel window
 *       (i >= bandwidth-1): earlier bars depend on the window edge, which
 *       no live chart ever shows. The MA itself is a pure (non-recursive)
 *       weighted average, so once the window is full the values are exact
 *       regardless of history depth — no UT-Bot-style lead-in decay.
 *   K5  Defaults = TradingView defaults: kernel Laplace, bandwidth 14,
 *       source close, deviations 2.0. Overrides are a config concern.
 *
 * Timing contract (no-lookahead): value at bar i depends ONLY on candles
 * with index <= i. Signal timing = candle CLOSE confirmation.
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
      kernel: extra.kernel,
      bandwidth: extra.bandwidth,
      value: event.value,
      valuePrev: event.valuePrev,
      stdev: event.stdev,
      timeframe: extra.timeframe,
      eventCandle: { t: event.t, closeT: event.closeT },
      barIndex: event.i,
    },
    entryPrice: event.price,
    entryTime: extra.timestamp,
    expiryMinutes: null,
    expiryTime: null,
    atrPercentile: null,
  };
}

/**
 * R7.1 test fixtures — deterministic OHLCV candle generators.
 *
 * No network. Used by scripts/r71_tests.mjs to drive the REAL engine modules.
 * A mulberry32 PRNG makes every fixture reproducible from a seed.
 */

// ── deterministic PRNG ──────────────────────────────────────────────────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build `count` candles for one timeframe.
 *   trend   : per-candle drift added to the close (+bullish / -bearish / ~0 neutral)
 *   vol     : per-candle volatility (price units) for the body/wicks
 *   basePrice: starting close
 *   intervalMin : candle size (1/5/15)
 *   seed    : PRNG seed
 */
export function makeCandles(opts) {
  const {
    count = 100, intervalMin = 5, basePrice = 1.08, vol = 0.0008,
    trend = 0, seed = 1, startISO = '2026-07-20T00:00:00Z',
  } = opts || {};
  const rnd = mulberry32(seed);
  const candles = [];
  let close = basePrice;
  const stepMs = intervalMin * 60 * 1000;
  const startMs = new Date(startISO).getTime();
  for (let i = 0; i < count; i++) {
    const datetime = new Date(startMs + i * stepMs).toISOString();
    const drift = trend + (rnd() - 0.5) * vol;
    const open = close;
    close = Math.max(0.0001, open + drift);
    const wick = vol * (0.4 + rnd());
    const high = Math.max(open, close) + wick * rnd();
    const low  = Math.min(open, close) - wick * rnd();
    const volume = Math.round(100 + rnd() * 900);
    candles.push({ datetime, open, high, low, close, volume });
  }
  return candles;
}

/** Build a full candleData map {1min,5min,15min} for the engine. */
export function makeCandleData(profile) {
  // profile: { basePrice, vol, trend, seed } shared; intervals scaled.
  const { basePrice = 78000, vol = 60, trend = 0, seed = 1 } = profile || {};
  return {
    '1min':  makeCandles({ count: 100, intervalMin: 1,  basePrice, vol: vol * 0.4, trend: trend * 0.4, seed: seed + 1 }),
    '5min':  makeCandles({ count: 100, intervalMin: 5,  basePrice, vol,            trend,            seed: seed + 2 }),
    '15min': makeCandles({ count: 100, intervalMin: 15, basePrice, vol: vol * 2,   trend: trend * 2,  seed: seed + 3 }),
  };
}

// ── Engineered structure candles ────────────────────────────────────────
// The audit-precision tests need a TF whose analyzeTimeframe triggers a SPECIFIC
// structure event (CHoCH hard-block / BOS / neutral). Random fixtures cannot
// guarantee that, so these builders hand-craft the tail of the candle array to
// force a known swing structure. They still flow through the REAL
// analyzeTimeframe + indicator pipeline.

/**
 * Neutral-structure candles: a tight, symmetric oscillation with no close
 * beyond the recent swing high/low on the last candle -> NEUTRAL bias, no BOS,
 * no CHoCH, no hard-block.
 */
export function neutralStructureCandles(basePrice = 1.08, n = 100) {
  const candles = [];
  const stepMs = 5 * 60 * 1000;
  const startMs = new Date('2026-07-20T00:00:00Z').getTime();
  const amp = basePrice * 0.0006;
  for (let i = 0; i < n; i++) {
    const datetime = new Date(startMs + i * stepMs).toISOString();
    const mid = basePrice + amp * Math.sin(i / 3);
    const open = mid - amp * 0.2;
    const close = mid + amp * 0.2;
    candles.push({
      datetime, open, high: mid + amp * 0.4, low: mid - amp * 0.4, close,
      volume: 200,
    });
  }
  return candles;
}

/**
 * Bearish-CHoCH-to-bullish candles: a slow downtrend with planted lower swing
 * highs (idx 30/50/70) and lower swing lows (idx 40/60/78) => BEARISH bias, then
 * a flat plateau (no new swing lows) and a final candle that closes ABOVE the
 * most recent lower-high -> BULLISH_CHoCH (multiplier direction BUY, value 1.40).
 * n=90 so EMA55 has enough data for a real analyzeTimeframe pass.
 */
export function bullishChochCandles(basePrice = 1.08) {
  const base = basePrice;
  const n = 90;
  const stepMs = 1 * 60 * 1000;
  const startMs = new Date('2026-07-20T00:00:00Z').getTime();
  const candles = [];
  for (let i = 0; i < n; i++) {
    const datetime = new Date(startMs + i * stepMs).toISOString();
    const close = base * 1.02 - i * base * 0.00006;        // very slow decline
    const open = close + base * 0.00005;
    candles.push({
      datetime, open,
      high: Math.max(open, close) + base * 0.0001,
      low: Math.min(open, close) - base * 0.0001,
      close, volume: 200,
    });
  }
  // plant 3 lower swing highs
  const peaks = { 30: base * 1.021, 50: base * 1.019, 70: base * 1.017 };
  for (const k in peaks) candles[+k].high = peaks[k];
  // plant 3 lower swing lows (last one lowest)
  const troughs = { 40: base * 1.000, 60: base * 0.998, 78: base * 0.996 };
  for (const k in troughs) candles[+k].low = troughs[k];
  // flat plateau 80..87 -> constant low, so no new swing low forms
  const platLow = candles[79].low;
  for (let i = 80; i < 88; i++) {
    candles[i].open = platLow + base * 0.0001;
    candles[i].close = platLow + base * 0.0001;
    candles[i].high = platLow + base * 0.0002;
    candles[i].low = platLow;
  }
  // bullish break above the most recent lower-high (idx 70)
  const lastPeak = peaks[70];
  const lm1 = 88, lm0 = 89;
  candles[lm1].close = lastPeak - base * 0.0008;
  candles[lm1].open = candles[lm1].close + base * 0.0001;
  candles[lm1].high = Math.max(candles[lm1].open, candles[lm1].close) + base * 0.0002;
  candles[lm1].low = Math.min(candles[lm1].open, candles[lm1].close) - base * 0.0002;
  candles[lm0].close = lastPeak + base * 0.0020;
  candles[lm0].open = lastPeak - base * 0.0004;
  candles[lm0].high = candles[lm0].close + base * 0.0004;
  candles[lm0].low = Math.min(candles[lm0].open, candles[lm0].close) - base * 0.0002;
  return candles;
}

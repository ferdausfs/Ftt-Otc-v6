/**
 * SIG-V1 — strategy-playbook engine (2026-09-03, user directive).
 *
 * VERSIONING: this is the NEW engine line ("Sig-v1.0.0"); the 6.x numbering
 * ends here. The old v6 vote engine still runs for history/API/research, but
 * when CONFIG.SIG_V1.enabled the TELEGRAM PUSH layer belongs to this engine:
 * the ROUTER picks ONE strategy per market state and only that strategy's
 * output is pushed. NO voting, NO averaging — a strategy that is right for
 * the current market state speaks, even if every indicator "disagrees".
 *
 * Playbook (v1.0.0):
 *   Router states: RANGING | TRENDING_UP | TRENDING_DOWN |
 *                  SQUEEZE_COILING | EXPANSION_SHOCK | DEAD | UNCERTAIN
 *   S1 RANGE-FADE      (RANGING)         — v0.1 mean-reversion core (measured)
 *   S2 TREND-PULLBACK  (TRENDING_*)      — with-trend entries on 38–61% pullback
 *                                          to EMA/swing zone; chase-veto RSI
 *   S3 BREAKOUT-RETEST (SQUEEZE_COILING) — fresh range break + retest hold only
 *   Uncertain / shock / dead             — silence (NO_TRADE)
 *
 * Measurement: every emitted would-signal is stored via the shared v7obs:
 * counterfactual store (strategy-tagged) and forward-resolved with the
 * production price path, so per-strategy × per-market WR is known before any
 * scale-up decision (RULE-6 gates: per-strategy WR>=55.6% n>=50 for voice;
 * engine flip WR>=60% n>=100 CI-lo>50%).
 *
 * Markets: all scanned pairs — CRYPTO, FOREX, FOREX_OTC (user opened all).
 * Pure + deterministic: no wall clock beyond `now`, no network, no KV.
 */

import { CONFIG } from '../config.js';
import { calculateRSI, calculateBollingerBands, calculateADX, calculateATR, calculateEMA } from '../indicators/math.js';
import { admitV7Observation } from '../history/v7store.js';

const lastNum = (a) => {
  if (!Array.isArray(a) || a.length === 0) return null;
  const v = a[a.length - 1];
  return typeof v === 'number' && isFinite(v) ? v : null;
};

function pickCandles(candleData, tf) {
  const d = candleData && candleData[tf];
  if (Array.isArray(d) && d.length) return d;
  return null;
}

/** Closed candles only (drop a still-forming last bar). */
function closedCandles(candleData, cfg, nowMs) {
  const candles = pickCandles(candleData, cfg.TF) || pickCandles(candleData, '1min');
  if (!candles || candles.length < cfg.MIN_CANDLES) return null;
  const tfMs = cfg.TF === '5min' ? 300000 : 60000;
  let lastIdx = candles.length - 1;
  const lastBar = candles[lastIdx];
  if (lastBar && lastBar.timestamp && (nowMs - lastBar.timestamp) < tfMs) lastIdx -= 1;
  if (lastIdx < cfg.MIN_CANDLES - 1) return null;
  return candles.slice(0, lastIdx + 1);
}

/** ATR percentile: rank of last ATR within the last `window` ATR values (0..100). */
function atrPercentile(atrArr, window) {
  if (!Array.isArray(atrArr) || atrArr.length < 30) return null;
  const tail = atrArr.slice(-window).filter((v) => typeof v === 'number' && isFinite(v));
  const last = tail[tail.length - 1];
  if (last == null || tail.length < 30) return null;
  const below = tail.filter((v) => v <= last).length;
  return Math.round((100 * below) / tail.length);
}

/** BB-bandwidth percentile of the LAST bandwidth vs its own recent window (0..100). */
function bandwidthPercentile(bwArr, window = 100) {
  if (!Array.isArray(bwArr)) return null;
  const tail = bwArr.slice(-window).filter((v) => typeof v === 'number' && isFinite(v));
  const last = tail[tail.length - 1];
  if (last == null || tail.length < 30) return null;
  const below = tail.filter((v) => v <= last).length;
  return Math.round((100 * below) / tail.length);
}

/**
 * Swing structure: two most-recent confirmed swing highs + lows (span=2,
 * i.e. strictly above/below two neighbours on each side) within `lookback`.
 * HH+HL = up-structure, LH+LL = down-structure.
 */
function swingStructure(candles, lookback = 60) {
  const s = candles.slice(-lookback);
  const highs = [], lows = [];
  for (let i = 2; i < s.length - 2; i++) {
    const h = s[i].high, l = s[i].low;
    if (h > s[i - 1].high && h > s[i - 2].high && h > s[i + 1].high && h > s[i + 2].high) highs.push({ i, v: h });
    if (l < s[i - 1].low && l < s[i - 2].low && l < s[i + 1].low && l < s[i + 2].low) lows.push({ i, v: l });
  }
  const sh = highs.slice(-2).map((x) => x.v);
  const sl = lows.slice(-2).map((x) => x.v);
  const up = sh.length === 2 && sl.length === 2 && sh[1] > sh[0] && sl[1] > sl[0];
  const down = sh.length === 2 && sl.length === 2 && sh[1] < sh[0] && sl[1] < sl[0];
  return {
    up, down,
    lastSwingHigh: sh.length ? sh[sh.length - 1] : null,
    lastSwingLow: sl.length ? sl[sl.length - 1] : null,
  };
}

/** Candle range position of close (0=at low, 1=at high). */
function closePos(c) {
  const rng = c.high - c.low;
  return rng > 0 ? (c.close - c.low) / rng : 0.5;
}

/* ── Router ──────────────────────────────────────────────────────────── */

function computeRouter(f, cfg) {
  const r = cfg.ROUTER;
  // hard state first: dead market
  if (f.bbWidth != null && f.bbWidth < cfg.MIN_BB_WIDTH)
    return { state: 'DEAD', direction: null, conf: 0, why: 'bb-width-min' };
  // coil-broke detection BEFORE the ATR-shock veto: S3's whole job is to
  // catch the first candles of a squeeze expansion, and that first candle IS
  // an ATR spike by nature (flat squeeze series -> any rise tops the
  // percentile). With a confirmed prior coil, the tick belongs to S3 alone.
  const squeezeWas = (f.bwArr && f.bwArr.length >= 30)
    ? Math.min(...f.bwArr.slice(-30, -2).filter((v) => typeof v === 'number' && isFinite(v)))
    : null;
  if (squeezeWas != null && f.bbWidth != null && squeezeWas > 0
      && f.bbWidth >= squeezeWas * 1.4)
    return { state: 'SQUEEZE_COILING', direction: null, conf: 0.6, why: 'coil-broke-min' + squeezeWas.toFixed(3) };
  if (f.atrPctile != null && f.atrPctile > cfg.MAX_ATR_PCTILE)
    return { state: 'EXPANSION_SHOCK', direction: null, conf: 0, why: 'atr-pctile-' + f.atrPctile };

  const trendVotesUp = (f.struct && f.struct.up ? 1 : 0) + (f.emaFast != null && f.emaSlow != null && f.emaFast > f.emaSlow ? 1 : 0) + (f.adx != null && f.adx >= r.ADX_TREND ? 1 : 0);
  const trendVotesDown = (f.struct && f.struct.down ? 1 : 0) + (f.emaFast != null && f.emaSlow != null && f.emaFast < f.emaSlow ? 1 : 0) + (f.adx != null && f.adx >= r.ADX_TREND ? 1 : 0);

  if (trendVotesUp === 3) return { state: 'TRENDING_UP', direction: 'BUY', conf: 0.9, why: 'struct+ema+adx' };
  if (trendVotesDown === 3) return { state: 'TRENDING_DOWN', direction: 'SELL', conf: 0.9, why: 'struct+ema+adx' };
  if (trendVotesUp >= 2) return { state: 'TRENDING_UP', direction: 'BUY', conf: 0.7, why: '2of3-up' };
  if (trendVotesDown >= 2) return { state: 'TRENDING_DOWN', direction: 'SELL', conf: 0.7, why: '2of3-down' };
  // coiling NOW (narrow bandwidth)
  if (f.bwPctile != null && f.bwPctile <= r.SQUEEZE_PCTILE)
    return { state: 'SQUEEZE_COILING', direction: null, conf: 0.6, why: 'bw-pctile-' + f.bwPctile };
  if (f.adx != null && f.adx < r.ADX_TREND && !(f.struct && (f.struct.up || f.struct.down)))
    return { state: 'RANGING', direction: null, conf: 0.7, why: 'adx-flat' };
  return { state: 'UNCERTAIN', direction: null, conf: 0.5, why: 'no-quorum' };
}

/* ── S1 RANGE-FADE (RANGING) — v0.1 measured core ───────────────────── */

function s1RangeFade(f, cfg, want) {
  const s = cfg.S1_RANGE_FADE;
  if (want === 'BUY' && !(f.pctB <= s.BUY_MAX_PCTB && f.rsi <= s.BUY_MAX_RSI)) return 'no-extreme-buy';
  if (want === 'SELL' && !(f.pctB >= s.SELL_MIN_PCTB && f.rsi >= s.SELL_MIN_RSI)) return 'no-extreme-sell';
  const cp = f.closePos;
  if (want === 'BUY' && !(f.last.close > f.last.open && cp >= s.MIN_CLOSE_POS)) return 'no-trigger';
  if (want === 'SELL' && !(f.last.close < f.last.open && (1 - cp) >= s.MIN_CLOSE_POS)) return 'no-trigger';
  return null;
}

/* ── S2 TREND-PULLBACK (TRENDING_UP/DOWN) — with-trend only ─────────── */

function s2TrendPullback(f, cfg, want) {
  const s = cfg.S2_TREND_PULLBACK;
  // chase veto: never pay an extended price to join the trend
  if (want === 'BUY' && f.rsi > s.CHASE_RSI_BUY) return 'chase-veto-buy';
  if (want === 'SELL' && f.rsi < s.CHASE_RSI_SELL) return 'chase-veto-sell';

  const win = f.candles.slice(-s.SWING_LOOKBACK);
  const H = Math.max(...win.map((c) => c.high));
  const L = Math.min(...win.map((c) => c.low));
  const rng = H - L;
  if (!(rng > 0)) return 'flat-swing';
  if (want === 'BUY') {
    // pullback zone = 38–61% retrace of the last swing up (low L -> high H)
    const zoneTop = H - s.RETRACE_MIN * rng;   // shallower (38%)
    const zoneBot = H - s.RETRACE_MAX * rng;   // deeper (61%)
    // recent touch: one of the last N candles dipped into/below the zone
    const recent = f.candles.slice(-s.PULLBACK_LOOKBACK - 1, -1);
    const touched = recent.some((c) => c.low <= zoneTop && c.low >= zoneBot - 0.15 * rng) || recent.some((c) => c.low <= zoneBot);
    if (!touched) return 'no-pullback';
    // resumption trigger: bullish rejection candle closing back above 38% line
    const cp = f.closePos;
    if (!(f.last.close > f.last.open && cp >= s.MIN_CLOSE_POS && f.last.close > zoneTop)) return 'no-trigger';
  } else {
    const zoneBot = L + s.RETRACE_MIN * rng;
    const zoneTop = L + s.RETRACE_MAX * rng;
    const recent = f.candles.slice(-s.PULLBACK_LOOKBACK - 1, -1);
    const touched = recent.some((c) => c.high >= zoneBot && c.high <= zoneTop + 0.15 * rng) || recent.some((c) => c.high >= zoneTop);
    if (!touched) return 'no-pullback';
    const cp = f.closePos;
    if (!(f.last.close < f.last.open && (1 - cp) >= s.MIN_CLOSE_POS && f.last.close < zoneBot)) return 'no-trigger';
  }
  return null;
}

/* ── S3 BREAKOUT-RETEST (SQUEEZE_COILING) ───────────────────────────── */

function s3BreakoutRetest(f, cfg) {
  const s = cfg.S3_BREAKOUT_RETEST;
  const n = f.candles.length;
  if (n < s.RANGE_LOOKBACK + 5) return 'insufficient-history';
  // prior range EXCLUDES the last 3 candles (break + dip + hold sequence),
  // otherwise the break candle's own high pollutes the level it must break.
  const prior = f.candles.slice(n - 3 - s.RANGE_LOOKBACK, n - 3);
  const hi = Math.max(...prior.map((c) => c.high));
  const lo = Math.min(...prior.map((c) => c.low));
  // squeeze must have been real: min bandwidth inside that window vs now
  const priorBw = f.bwArr.slice(-s.RANGE_LOOKBACK - 3, -3).filter((v) => typeof v === 'number' && isFinite(v));
  const minBw = priorBw.length ? Math.min(...priorBw) : null;
  if (minBw == null || f.bbWidth == null || f.bbWidth < minBw * 1.4) return 'no-expansion';
  const tol = s.RETEST_TOL;
  const cp = f.closePos;
  if (f.last.close > hi) {
    // retest: the hold candle (or the dip before it) touched the broken edge
    const retested = f.last.low <= hi * (1 + tol) || f.candles[n - 2].low <= hi * (1 + tol);
    if (!(retested && f.last.close > f.last.open && cp >= 0.5)) return 'no-retest-hold';
    return null; // BUY
  }
  if (f.last.close < lo) {
    const retested = f.last.high >= lo * (1 - tol) || f.candles[n - 2].high >= lo * (1 - tol);
    if (!(retested && f.last.close < f.last.open && (1 - cp) >= 0.5)) return 'no-retest-hold';
    return null; // SELL
  }
  return 'no-break';
}

/* ── Public evaluator ────────────────────────────────────────────────── */

export function evaluateSigV1(candleData, now, assetType = 'CRYPTO') {
  const cfg = CONFIG.SIG_V1;
  const out = {
    want: null, strategy: null, skip: null,
    router: { state: null, direction: null, conf: 0 },
    features: {}, entry: null, assetType,
  };
  if (!cfg || !cfg.enabled) { out.skip = 'sigv1-disabled'; return out; }
  const mkt = (assetType === 'CRYPTO') ? 'CRYPTO' : (assetType === 'FOREX' ? 'FOREX' : 'FOREX_OTC');
  if (!cfg.MARKETS[mkt]) { out.skip = 'market-closed-for-sigv1'; return out; }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const candles = closedCandles(candleData, cfg, nowMs);
  if (!candles) { out.skip = 'insufficient-candles'; return out; }

  const closes = candles.map((c) => c.close);
  const rsiArr = calculateRSI(closes, 14);
  const rsi = lastNum(rsiArr);
  const bb = calculateBollingerBands(closes, 20, 2);
  const pctB = lastNum(bb.percentB);
  const bwArr = Array.isArray(bb.bandwidth) ? bb.bandwidth : null;
  const bw = lastNum(bwArr);
  const ema20Arr = calculateEMA(closes, cfg.ROUTER.EMA_FAST);
  const ema50Arr = calculateEMA(closes, cfg.ROUTER.EMA_SLOW);
  const emaFast = lastNum(ema20Arr);
  const emaSlow = lastNum(ema50Arr);
  const adxArr = calculateADX(candles, 14);
  const adx = lastNum(adxArr.adx);
  const atrArr = calculateATR(candles, 14);
  const atrPct = atrPercentile(atrArr, cfg.ATR_WINDOW);
  const last = candles[candles.length - 1];

  Object.assign(out.features, {
    rsi, pctB, bbWidth: bw, bwPctile: bandwidthPercentile(bwArr), atrPctile: atrPct,
    adx, emaFast, emaSlow, hourUtc: new Date(nowMs).getUTCHours(),
  });
  if (rsi == null || pctB == null || bw == null || adx == null || emaFast == null || emaSlow == null) {
    out.skip = 'indicators-incomplete'; return out;
  }

  const f = {
    ...out.features, candles, last,
    closePos: closePos(last),
    struct: swingStructure(candles, 60),
    bwArr: bwArr || [],
  };

  // shared veto: measured bad hours
  if (cfg.VETO_HOURS.includes(f.hourUtc)) { out.router.state = 'VETO_HOUR'; out.skip = 'veto-hour'; return out; }

  const router = computeRouter(f, cfg);
  out.router = { state: router.state, direction: router.direction, conf: router.conf, why: router.why };

  let want = null, skip = null, strategy = null;
  if (router.state === 'TRENDING_UP' || router.state === 'TRENDING_DOWN') {
    strategy = 'SIGV1_S2_TRENDPULLBACK';
    want = router.direction;
    if (router.conf < cfg.ROUTER.CONF_MIN) skip = 'router-low-conf';
    else skip = s2TrendPullback(f, cfg, want);
  } else if (router.state === 'SQUEEZE_COILING') {
    strategy = 'SIGV1_S3_BREAKOUTRETEST';
    skip = s3BreakoutRetest(f, cfg);
    if (skip == null) want = f.last.close > f.candles[f.candles.length - 2].close ? 'BUY' : 'SELL';
  } else if (router.state === 'RANGING') {
    strategy = 'SIGV1_S1_RANGEFADE';
    want = (pctB <= cfg.S1_RANGE_FADE.BUY_MAX_PCTB && rsi <= cfg.S1_RANGE_FADE.BUY_MAX_RSI) ? 'BUY'
      : (pctB >= cfg.S1_RANGE_FADE.SELL_MIN_PCTB && rsi >= cfg.S1_RANGE_FADE.SELL_MIN_RSI) ? 'SELL' : null;
    skip = want ? s1RangeFade(f, cfg, want) : 'no-extreme';
  } else {
    skip = 'state:' + router.state;   // DEAD / EXPANSION_SHOCK / UNCERTAIN
  }

  if (want == null || skip != null) { out.skip = skip || 'no-setup'; out.want = null; return out; }

  out.want = want;
  out.strategy = strategy;
  out.entry = {
    side: want,
    price: last.close,
    expiryMin: cfg.EXPIRY_MIN,
    entryTime: new Date(nowMs).toISOString(),
    expiryTime: new Date(nowMs + cfg.EXPIRY_MIN * 60000).toISOString(),
  };
  return out;
}

/**
 * Handler hook (fail-soft): store a would-signal observation for EVERY
 * market the playbook serves, strategy-tagged, forward-resolved via the
 * shared v7obs: store. Runs inside ctx.waitUntil — zero effect on output.
 */
export async function maybeAdmitSigV1Observation(signal, pair, assetType, candleData, env) {
  try {
    const cfg = CONFIG.SIG_V1;
    if (!cfg || !cfg.enabled || !env || !env.SIGNAL_CACHE) return null;
    const now = new Date();
    const res = evaluateSigV1(candleData, now, assetType);
    if (!res || !res.want) return null;
    return await admitV7Observation(env, {
      pair,
      want: res.want,
      strategy: res.strategy,
      features: res.features,
      trigger: { router: res.router, assetType },
      entry: res.entry,
      obsTime: now.toISOString(),
    });
  } catch (e) {
    console.warn('sigv1 admission failed (production unaffected): ' + e.message);
    return null;
  }
}

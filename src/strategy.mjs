/**
 * FTT Signal Engine v2 — THE core decision module.
 *
 * Paradigm: FOUR conditions, ALL must align, binary pass/fail, no scores,
 * no grades, no AI layer. One readable function outputs CALL / PUT /
 * NO_TRADE with the specific blocking reason.
 *
 *   C1  Trend (higher timeframe):     EMA(50) vs EMA(200) on 1h candles.
 *                                     Only trade WITH that trend.
 *   C2  Pullback (entry timeframe):   RSI(14) on 5m inside the pullback
 *                                     zone [25,45] for CALL, [55,75] for PUT.
 *   C3  Rejection candle (entry TF):  the last CLOSED 5m candle is a pin bar
 *                                     against the pullback: wick >= 1.5x body
 *                                     AND wick >= 40% of range AND close in
 *                                     the far 40% of the range.
 *   C4  Session / liquidity / news:   London or New York hours only
 *                                     (quality HIGH/HIGHEST), forex market
 *                                     must be open, forex blocks inside the
 *                                     static high-impact news windows.
 *
 * Every threshold lives in PARAMS below — nothing is hidden in helper logic.
 * No-lookahead contract: signal at 5m index i uses 5m data ≤ i and the last
 * 1h candle CLOSED by candle i's close time (caller supplies that index j).
 * tests/strategy.test.mjs proves the contract by mutating future candles.
 *
 * Core decision path (PARAMS + evaluateSignal + decideSignal) is < 300 lines
 * by design — a human verifies it in one sitting.
 */

import { detectTradingSession, isForexMarketOpen, checkNewsBlackout } from './session.mjs';

export const PARAMS = {
  // C1 — higher-timeframe trend (1h)
  EMA_FAST: 50,
  EMA_SLOW: 200,

  // C2 — RSI pullback zone (5m) — fixed a priori, standard zones, NOT tuned
  RSI_PERIOD: 14,
  RSI_CALL_MIN: 25,   // dip toward oversold in an uptrend
  RSI_CALL_MAX: 45,   // midline: below this zone = falling knife
  RSI_PUT_MIN: 55,    // mirror in a downtrend
  RSI_PUT_MAX: 75,

  // C3 — pin-bar rejection candle (5m, the just-closed candle)
  WICK_TO_BODY_MIN: 1.5,     // rejection wick >= 1.5x the body
  WICK_TO_RANGE_MIN: 0.40,   // rejection wick >= 40% of the candle range
  CLOSE_POS_MIN: 0.60,       // close in the far 40% of the range (CALL side;
                             // PUT mirrors at 1 - 0.60)

  // C4 — session / liquidity / news
  SESSION_MIN_QUALITY: 2,    // 0=LOW 1=MEDIUM 2=HIGH 3=HIGHEST -> HIGH+ only
  NEWS_BLACKOUT: true,       // static windows apply to forex only (as in v6)

  // Execution semantics (binary option, matches v6 production: 5-min expiry)
  ENTRY_TF_MINUTES: 5,
  EXPIRY_CANDLES: 1,         // resolve at the close of the NEXT 5m candle
};

const QUALITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, HIGHEST: 3 };

/**
 * One-shot indicator precompute (call once per pair over the full arrays —
 * both indicators are causal, so index i below is safe to read directly).
 */
export function computeIndicators(closes5m, closes1h) {
  return {
    emaFast1h: ema(closes1h, PARAMS.EMA_FAST),
    emaSlow1h: ema(closes1h, PARAMS.EMA_SLOW),
    rsi5m:     rsi(closes5m, PARAMS.RSI_PERIOD),
  };
}

function ema(data, period) {
  if (!data || data.length < period) return new Array(data ? data.length : 0).fill(null);
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let s = 0;
  for (let i = 0; i < period; i++) s += data[i];
  let e = s / period;
  out.push(e);
  for (let i = period; i < data.length; i++) { e = data[i] * k + e * (1 - k); out.push(e); }
  return out;
}

function rsi(data, period) {
  if (!data || data.length < period + 1) return new Array(data ? data.length : 0).fill(null);
  const ch = [];
  for (let i = 1; i < data.length; i++) ch.push(data[i] - data[i - 1]);
  let ag = 0; let al = 0;
  for (let i = 0; i < period; i++) { if (ch[i] > 0) ag += ch[i]; else al += Math.abs(ch[i]); }
  ag /= period; al /= period;
  const out = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period; i < ch.length; i++) {
    ag = (ag * (period - 1) + (ch[i] > 0 ? ch[i] : 0)) / period;
    al = (al * (period - 1) + (ch[i] < 0 ? Math.abs(ch[i]) : 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return new Array(data.length - out.length).fill(null).concat(out);
}

/** Candle anatomy for the rejection check (C3). */
export function candleAnatomy(c) {
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  return {
    range, body, lowerWick, upperWick,
    closePos: range > 0 ? (c.c - c.l) / range : 0.5,
  };
}

/**
 * THE decision function. All four conditions, binary, in C1->C4 order.
 *
 * @param {Array}  c5m   5m candles [{t,o,h,l,c}], index i = signal candle
 * @param {Object} ind   precomputed indicator arrays (computeIndicators)
 * @param {number} i     index of the just-CLOSED 5m candle
 * @param {number} j     index of the last 1h candle CLOSED by candle i's close
 * @param {Object} opts  { market: 'forex'|'crypto', dropC: null|'C1'..'C4' }
 */
export function evaluateSignal(c5m, ind, i, j, opts = {}) {
  const market = opts.market || 'crypto';
  const dropC = opts.dropC || null;
  const c = c5m[i];
  const ts = c.t + PARAMS.ENTRY_TF_MINUTES * 60000;   // candle close time
  const a = candleAnatomy(c);
  const rsiVal = ind.rsi5m[i];
  const emaF = j >= 0 ? ind.emaFast1h[j] : null;
  const emaS = j >= 0 ? ind.emaSlow1h[j] : null;

  // ---- C1: higher-timeframe trend direction -------------------------------
  let trendDir = 0;                                    // 1 up, -1 down, 0 flat
  if (emaF !== null && emaS !== null && emaF > emaS) trendDir = 1;
  if (emaF !== null && emaS !== null && emaF < emaS) trendDir = -1;
  const wantDir = trendDir === 1 ? 'CALL' : trendDir === -1 ? 'PUT' : null;
  const c1 = dropC === 'C1' ? { passed: true } :
    (wantDir ? { passed: true } : { passed: false, why: 'C1_NO_HTF_TREND' });

  // ---- C2: RSI inside the pullback zone for that direction ----------------
  const rsiCall = rsiVal >= PARAMS.RSI_CALL_MIN && rsiVal <= PARAMS.RSI_CALL_MAX;
  const rsiPut  = rsiVal >= PARAMS.RSI_PUT_MIN  && rsiVal <= PARAMS.RSI_PUT_MAX;
  const rsiOk = wantDir === 'CALL' ? rsiCall : rsiPut;   // zone follows the TREND side
  const c2 = dropC === 'C2' ? { passed: true } :
    { passed: rsiOk, why: 'C2_RSI_OUT_OF_ZONE' };

  // ---- C3: pin-bar rejection candle in the trend direction ----------------
  let c3ok = false;
  if (a.range > 0) {
    if (wantDir === 'CALL') {
      c3ok = a.lowerWick >= PARAMS.WICK_TO_BODY_MIN * a.body
          && a.lowerWick >= PARAMS.WICK_TO_RANGE_MIN * a.range
          && a.closePos >= PARAMS.CLOSE_POS_MIN;
    } else {
      c3ok = a.upperWick >= PARAMS.WICK_TO_BODY_MIN * a.body
          && a.upperWick >= PARAMS.WICK_TO_RANGE_MIN * a.range
          && a.closePos <= 1 - PARAMS.CLOSE_POS_MIN;
    }
  }
  const c3 = dropC === 'C3' ? { passed: true } :
    { passed: c3ok, why: 'C3_NO_REJECTION_CANDLE' };

  // ---- C4: session quality + market open + news blackout ------------------
  let c4ok = true; let c4why = null;
  const sess = detectTradingSession(ts);
  if (dropC !== 'C4') {
    if (market === 'forex' && !isForexMarketOpen(ts)) { c4ok = false; c4why = 'C4_MARKET_CLOSED'; }
    else if (QUALITY_ORDER[sess.quality] < PARAMS.SESSION_MIN_QUALITY) { c4ok = false; c4why = 'C4_LOW_LIQUIDITY'; }
    else if (market === 'forex' && PARAMS.NEWS_BLACKOUT && checkNewsBlackout(ts)) { c4ok = false; c4why = 'C4_NEWS_BLACKOUT'; }
  }
  const c4 = { passed: c4ok, why: c4why };

  const conditions = { C1: c1.passed, C2: c2.passed, C3: c3.passed, C4: c4.passed };

  // ---- verdict: ALL must align --------------------------------------------
  let decision = wantDir || 'NO_TRADE';
  let reason = wantDir
    ? (wantDir === 'CALL' ? 'C1 up-trend + C2 pullback zone + C3 bullish rejection + C4 session ok'
                          : 'C1 down-trend + C2 pullback zone + C3 bearish rejection + C4 session ok')
    : 'C1_NO_HTF_TREND';
  if (wantDir) {
    for (const [k, v] of [['C2', c2], ['C3', c3], ['C4', c4]]) {
      if (!v.passed) { decision = 'NO_TRADE'; reason = v.why; break; }
    }
  }

  return {
    decision, reason, conditions, trendDir,
    audit: {
      ts, market, session: sess.quality, sessions: sess.sessions,
      emaFast1h: emaF, emaSlow1h: emaS, rsi14_5m: rsiVal,
      candle: { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c,
                body: +a.body.toFixed(8), lowerWick: +a.lowerWick.toFixed(8),
                upperWick: +a.upperWick.toFixed(8), closePos: +a.closePos.toFixed(4) },
    },
  };
}

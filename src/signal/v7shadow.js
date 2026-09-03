/**
 * V7 SHADOW — next-generation engine prototype (2026-09-03).
 *
 * WHY: the v6 paradigm (many indicators vote, highest vote wins) is measured
 * dead — 4-day forward pool: 37.3% WR (n=630), score-vs-win correlation
 * NEGATIVE (-0.063), best slice (RANGING non-CHASE) only 52.3% (n=44).
 * The audit (D1-D5) showed vote-share consensus has no predictive variance.
 * V7 inverts the paradigm: NO votes. Hard exclusion + entry trigger:
 *   1. Regime router    — trade RANGING mean-reversion only (TRENDING 35.4%,
 *                         counter-trend BUY 20.5% are proven poison)
 *   2. Extremes         — only at the outer band (%B <=0.15 / >=0.85),
 *                         RSI in the non-chase zone (dip-buy / rip-sell)
 *   3. Trigger (H1)     — a closing rejection candle IN trade direction
 *                         (enter on confirmation, not while falling)
 *   4. Veto stack       — dead squeeze, ATR explosion, re-measured bad hours
 *   5. Daily budget     — decision-mode only (not in shadow v0.1)
 *
 * Independence rule: v7 computes its OWN indicators from candleData. It must
 * NOT read signal.edgeFeatures — edgeFeatures is null on NO_TRADE ticks and
 * reusing it would bias the sample to v6-eligible moments. The counterfactual
 * store (v7store.js) records WOULD-mint observations on every crypto tick and
 * resolves them forward, so v7's real WR is known BEFORE it ever touches a
 * subscriber. Same discipline that stopped the broken EC ladder (flip was
 * cancelled on 2026-09-03).
 *
 * Pure + deterministic: no wall clock beyond `now`, no network, no KV.
 * Fail-soft: the handler wraps admission in waitUntil + try/catch.
 */

import { CONFIG } from '../config.js';
import { calculateRSI, calculateBollingerBands, calculateADX, calculateATR } from '../indicators/math.js';
import { detectMarketRegime } from '../indicators/regime.js';
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

/** ATR percentile: rank of last ATR within the last `window` ATR values (0..100). */
function atrPercentile(atrArr, window = 100) {
  if (!Array.isArray(atrArr) || atrArr.length < 30) return null;
  const tail = atrArr.slice(-window).filter((v) => typeof v === 'number' && isFinite(v));
  const last = tail[tail.length - 1];
  if (last == null || tail.length < 30) return null;
  const below = tail.filter((v) => v <= last).length;
  return Math.round((100 * below) / tail.length);
}

/**
 * Evaluate the v7 setup on one pair tick.
 * @param {object} candleData  { '1min': [...], '5min': [...], '15min': [...] }
 * @param {Date|number} now    evaluation instant
 * @param {string} assetType   'CRYPTO' | 'FOREX' | 'OTC'
 * @returns {{want: 'BUY'|'SELL'|null, strategy: string, skip: string|null,
 *           features: object, trigger: object, entry: object|null}}
 */
export function evaluateV7Setup(candleData, now, assetType = 'CRYPTO') {
  const cfg = CONFIG.V7_SHADOW;
  const out = { want: null, strategy: 'V7_MR_RANGING', skip: null, features: {}, trigger: {}, entry: null };
  if (!cfg || !cfg.enabled) { out.skip = 'disabled'; return out; }

  const candles = pickCandles(candleData, cfg.TF) || pickCandles(candleData, '1min');
  if (!candles || candles.length < cfg.MIN_CANDLES) { out.skip = 'insufficient-candles'; return out; }
  // Use CLOSED candles only: drop a possibly still-forming last bar when its
  // open time + TF extends past `now` (cron ticks can land mid-bar).
  const tfMs = cfg.TF === '5min' ? 300000 : 60000;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let lastIdx = candles.length - 1;
  const lastBar = candles[lastIdx];
  if (lastBar && lastBar.timestamp && (nowMs - lastBar.timestamp) < tfMs) lastIdx -= 1;
  if (lastIdx < cfg.MIN_CANDLES - 1) { out.skip = 'insufficient-closed'; return out; }
  const closed = candles.slice(0, lastIdx + 1);

  const closes = closed.map((c) => c.close);
  const rsiArr = calculateRSI(closes, 14);
  const rsi = lastNum(rsiArr);
  const bb = calculateBollingerBands(closes, 20, 2);
  const pctB = lastNum(bb.percentB);
  const bw = lastNum(bb.bandwidth);
  const atrArr = calculateATR(closed, 14);
  const atrPct = atrPercentile(atrArr, cfg.ATR_WINDOW);
  const adxArr = calculateADX(closed, 14);
  const adx = lastNum(adxArr.adx);
  const last = closed[closed.length - 1];

  Object.assign(out.features, { rsi, pctB, bbWidth: bw, atrPctile: atrPct, adx, hourUtc: new Date(nowMs).getUTCHours() });
  if (rsi == null || pctB == null || bw == null || adx == null) { out.skip = 'indicators-incomplete'; return out; }

  // ── veto stack (hard, any hit = SKIP) ────────────────────────────────
  const regime = detectMarketRegime(adx, bw, atrArr ? atrArr[atrArr.length - 1] : null, last.close, assetType, null);
  out.features.regime = regime;
  if (regime !== 'RANGING') { out.skip = 'regime:' + regime; return out; }
  if (bw < cfg.MIN_BB_WIDTH) { out.skip = 'dead-squeeze'; return out; }
  if (atrPct != null && atrPct > cfg.MAX_ATR_PCTILE) { out.skip = 'atr-explosion'; return out; }
  const hourUtc = out.features.hourUtc;
  if (cfg.VETO_HOURS.includes(hourUtc)) { out.skip = 'veto-hour'; return out; }

  // ── extremes + non-chase zone (both must hold) ───────────────────────
  let want = null;
  if (pctB <= cfg.BUY_MAX_PCTB && rsi <= cfg.BUY_MAX_RSI) want = 'BUY';
  else if (pctB >= cfg.SELL_MIN_PCTB && rsi >= cfg.SELL_MIN_RSI) want = 'SELL';
  if (!want) { out.skip = 'no-extreme'; return out; }

  // ── H1 trigger: closing rejection candle in trade direction ──────────
  const rng = last.high - last.low;
  const closePos = rng > 0 ? (last.close - last.low) / rng : 0.5;
  out.trigger = { closePos: Math.round(closePos * 100) / 100, bullish: last.close > last.open };
  if (want === 'BUY' && !(last.close > last.open && closePos >= cfg.MIN_CLOSE_POS)) { out.skip = 'no-trigger'; return out; }
  if (want === 'SELL' && !(last.close < last.open && (1 - closePos) >= cfg.MIN_CLOSE_POS)) { out.skip = 'no-trigger'; return out; }

  out.want = want;
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
 * Handler hook (fail-open): evaluate + admit a counterfactual observation on
 * every CRYPTO tick, BUY/SELL/NO_TRADE alike. Called inside ctx.waitUntil.
 */
export async function maybeAdmitV7Observation(signal, pair, assetType, candleData, env) {
  try {
    const cfg = CONFIG.V7_SHADOW;
    if (!cfg || !cfg.enabled || !env || !env.SIGNAL_CACHE) return null;
    if (assetType !== 'CRYPTO') return null;
    const now = new Date();
    const evalRes = evaluateV7Setup(candleData, now, assetType);
    if (!evalRes || !evalRes.want) return null;   // SKIP ticks are not stored (features live in logs)
    return await admitV7Observation(env, {
      pair,
      want: evalRes.want,
      strategy: evalRes.strategy,
      features: evalRes.features,
      trigger: evalRes.trigger,
      entry: evalRes.entry,
      obsTime: now.toISOString(),
    });
  } catch (e) {
    console.warn('v7shadow admission failed (production unaffected): ' + e.message);
    return null;
  }
}

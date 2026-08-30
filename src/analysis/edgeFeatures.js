/**
 * EDGE FEATURES — input-side confidence multipliers & gates (Phase F round 2).
 *
 * The missing-edge features from the 2026-08-10 review:
 *   A1  hour-of-day WR multiplier        (UTC hour → confidence ×)
 *   A2  session-range position           (near day extremes → mean-rev bonus)
 *   B4  RSI × direction gate             (BUY>55 / SELL<45 chasing penalty)
 *   B5  volatility state (BB bandwidth)  (dead-squeeze block / mid ×0.9)
 *   B6  ATR percentile                   (squeeze ×0.95 / expansion ×1.05)
 *   C8  recent-form gate                 (pair rolling-20 WR < 35% → ×0.85)
 *
 * Design rules (see config.js EDGE_FEATURES block for the evidence):
 *   - INPUT-side only: this module adjusts the ENGINE confidence BEFORE the
 *     calibrated output layer (calibration.js) maps it to grade/confidence.
 *     It never recomputes grades/confidence from outcomes (R3).
 *   - Every threshold/multiplier comes from CONFIG.EDGE_FEATURES (R4) so the
 *     weekly self-calibration refresh is a data change, not a code change.
 *   - Deterministic + pure: no wall clock, no network, no KV — except the
 *     optional recent-form lookup (env.SIGNAL_CACHE stats), which is fail-open
 *     and returns 1.0 on any error.
 *   - The engine passes `indicators` = the per-TF RAW indicator cache
 *     (calculateAllIndicators output) so ATR percentile / BB bandwidth / RSI
 *     are read from the same arrays the engine computed for the signal.
 *
 * Order of application is fixed and documented (same for standard + OTC):
 *   1. RSI×direction gate     (penalty or hard block)
 *   2. Volatility state       (dead-squeeze hard block / mid penalty)
 *   3. ATR percentile         (multiplier)
 *   4. Hour of day            (multiplier)
 *   5. Session range position (multiplier)
 *   6. Recent form            (multiplier)
 *   totalMult = product, clamped to [MIN_TOTAL_MULT, MAX_TOTAL_MULT]
 *   confidence = round(confidence × totalMult)
 * The caller then re-applies its confidence floor, so heavy penalties can
 * turn a borderline signal into NO_TRADE (that is the intended gate effect).
 */

import { CONFIG, ASSET_TYPE, ASSET_TYPE_OTC } from '../config.js';

// ── small numeric helpers ────────────────────────────────────────────────

function toNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

/** Last finite value of an array / string / number (raw + formatted shapes). */
function lastNum(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = toNum(v[i]);
      if (n !== null) return n;
    }
    return null;
  }
  return toNum(v);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

/** stats.js-compatible pair key (stats: prefix), fail-open. */
function pairKey(pair) {
  try { return String(pair).replace(/\//g, '_').replace(/-/g, '_'); }
  catch (e) { return String(pair || ''); }
}

/**
 * Pick the best timeframe for `direction` — same tie-break philosophy as
 * engine.js findBestTimeframe but self-contained (no circular import):
 * highest confluence among TFs voting `direction`, then highest score.
 * Falls back to 15min/5min/1min order when no TF votes the direction.
 */
function pickBestTF(tfResults, direction) {
  if (!tfResults) return null;
  let best = null; let bestEc = -1; let bestScore = -1;
  for (const [tf, r] of Object.entries(tfResults)) {
    if (!r) continue;
    if (direction === 'NO_TRADE' || r.direction === direction) {
      const score = r.direction === 'BUY' ? (r.score && r.score.up) || 0
                  : r.direction === 'SELL' ? (r.score && r.score.down) || 0 : 0;
      const ec = (r.confluence || 0) + (r.alignedWithHTF ? 1 : 0);
      if (ec > bestEc || (ec === bestEc && score > bestScore)) {
        best = tf; bestEc = ec; bestScore = score;
      }
    }
  }
  if (!best) {
    for (const tf of ['15min', '5min', '1min']) {
      if (tfResults[tf]) { best = tf; break; }
    }
  }
  return best;
}

/** Raw indicator arrays for a TF from the indicator cache. */
function rawIndicators(indicators, tf) {
  return (indicators && indicators[tf]) || null;
}

// ── A2: session-range position (today's high/low) ────────────────────────
// Position = (lastClose - dayLow) / (dayHigh - dayLow) using every candle
// whose datetime falls on `now`'s UTC day, merged across all TFs (15min gives
// ~24h coverage; 1min gives the freshest close). No-op when there are too few
// candles or the day range is flat (minRangePct of price).
export function computeSessionRange(candleData, now, cfg) {
  if (!candleData || !now) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = start + 24 * 3600 * 1000;
  let dayHigh = -Infinity; let dayLow = Infinity; let count = 0; let lastClose = null;
  for (const candles of Object.values(candleData)) {
    if (!Array.isArray(candles)) continue;
    for (const c of candles) {
      if (!c || !c.datetime) continue;
      let t;
      try {
        const iso = String(c.datetime).includes('T') ? String(c.datetime) : String(c.datetime).replace(' ', 'T');
        t = new Date(iso.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z').getTime();
      } catch (e) { continue; }
      if (!isFinite(t) || t < start || t >= end) continue;
      const h = toNum(c.high); const l = toNum(c.low); const cl = toNum(c.close);
      if (h === null || l === null || cl === null) continue;
      if (h > dayHigh) dayHigh = h;
      if (l < dayLow) dayLow = l;
      lastClose = cl;
      count++;
    }
  }
  if (count < (cfg.minCandles || 20) || !isFinite(dayHigh) || !isFinite(dayLow)) return null;
  const range = dayHigh - dayLow;
  const ref = Math.abs(dayHigh) > 0 ? Math.abs(dayHigh) : 1;
  if (range <= 0 || range / ref < (cfg.minRangePct || 0.0005)) return null;
  const pos = clamp((lastClose - dayLow) / range, 0, 1);
  return { position: round2(pos), count };
}

// ── B6: ATR percentile vs its own history ────────────────────────────────
// Percentile rank of the last ATR value within the trailing `window` values
// (exclusive of the current bar, so it is a genuine "how extreme is now"
// measure). Returns null when the array is too short (minSamples).
export function computeAtrPercentile(atrArr, window, minSamples) {
  if (!Array.isArray(atrArr) || atrArr.length < 2) return null;
  const win = Math.max(2, window || 50);
  const min = Math.max(2, minSamples || 20);
  const hist = atrArr.slice(-(win + 1), -1); // trailing window BEFORE the current bar
  const cur = lastNum(atrArr[atrArr.length - 1]);
  if (cur === null || isNaN(cur)) return null;
  const vals = hist.filter((v) => {
    const n = toNum(v);
    return n !== null && isFinite(n) && n > 0;
  });
  if (vals.length < min) return null;
  let below = 0;
  for (const v of vals) if (v < cur) below++;
  return Math.round((below / vals.length) * 1000) / 10;
}

// ── C8: recent-form multiplier (pair rolling WR from /api/stats KV) ───────
export async function getRecentFormMultiplier(pair, env, cfg) {
  try {
    if (!env || !env.SIGNAL_CACHE) return { mult: 1.0, wr: null, sample: 0 };
    const stats = await env.SIGNAL_CACHE.get('stats:' + pairKey(pair), 'json');
    if (!stats || typeof stats.winRate !== 'number' || !Array.isArray(stats.recentResults)) {
      return { mult: 1.0, wr: null, sample: 0 };
    }
    const sample = stats.recentResults.length;
    if (sample < (cfg.minSample || 10)) return { mult: 1.0, wr: stats.winRate, sample };
    if (stats.winRate < (cfg.badWr || 0.35)) {
      return { mult: cfg.badMult || 0.85, wr: stats.winRate, sample };
    }
    return { mult: 1.0, wr: stats.winRate, sample };
  } catch (e) {
    return { mult: 1.0, wr: null, sample: 0 }; // fail-open
  }
}

/**
 * Apply all edge features. Pure + deterministic (the only async part is the
 * optional recent-form KV lookup, which is fail-open).
 *
 * ctx: {
 *   finalDirection, confidence, pair, assetType, now,
 *   candleData,        // per-TF candle arrays (for session range)
 *   tfResults,         // per-TF analysis (for best-TF selection)
 *   indicators,        // RAW indicator cache from calculateAllIndicators
 *   env,               // optional (recent-form); may be {}
 *   calib,             // optional dynamic calibration tables (selfCalib.js)
 * }
 *
 * Returns { finalDirection, confidence, filtersApplied[], audit|null }.
 */
export async function applyEdgeFeatures(ctx) {
  const cfg = CONFIG.EDGE_FEATURES;
  const {
    finalDirection, confidence, pair, assetType, now,
    candleData, tfResults, indicators, env, calib,
  } = ctx || {};

  const audit = {
    hourUtc: null, hourMult: 1.0,
    sessionRange: null, sessionRangeMult: 1.0,
    rsi: null, rsiGate: null,
    bbBandwidth: null, bbState: null, volMult: 1.0,
    atrPercentile: null, atrMult: 1.0,
    recentFormWr: null, recentFormMult: 1.0,
    totalMult: 1.0, blockedBy: null,
  };
  const applied = [];

  if (!cfg || cfg.enabled === false) return { finalDirection, confidence, filtersApplied: [], audit: null };
  if (finalDirection === 'NO_TRADE' || finalDirection === undefined || finalDirection === null) {
    return { finalDirection, confidence, filtersApplied: [], audit: null };
  }

  let dir = finalDirection;
  let conf = confidence;
  let totalMult = 1.0;

  // Vol-state thresholds are per-asset; OTC uses the FOREX table (its candles
  // are the base pair's real forex candles).
  const volCfg = cfg.VOL_STATE || {};
  const volKey = assetType === ASSET_TYPE.CRYPTO ? 'CRYPTO' : 'FOREX';
  const deadBlock = (volCfg.deadSqueezeBlock && volCfg.deadSqueezeBlock[volKey]) != null
    ? volCfg.deadSqueezeBlock[volKey] : null;
  const squeezeMax = (volCfg.squeezeMax && volCfg.squeezeMax[volKey]) != null
    ? volCfg.squeezeMax[volKey] : null;

  // Best-TF raw indicators (same TF the engine reports as best).
  const bestTF = pickBestTF(tfResults, dir);
  const raw = bestTF ? rawIndicators(indicators, bestTF) : null;
  const rsi = raw ? lastNum(raw.rsi) : null;
  let bb = null;
  if (raw) {
    bb = lastNum(raw.bollinger && raw.bollinger.bandwidth);
    if (bb === null && raw.bbBandwidth !== undefined) bb = lastNum(raw.bbBandwidth);
  }
  const atrArr = raw ? raw.atr : null;

  if (rsi !== null) audit.rsi = round2(rsi);
  if (bb !== null) audit.bbBandwidth = round2(bb);

  // ── 1. RSI × direction gate ────────────────────────────────────────────
  // FIX-2 (2026-08-30): the SELL-side leg is gated behind
  // sellPenaltyEnabled (measured non-discriminating — see config comment);
  // the BUY-side chase leg is forward-validated and stays always-on.
  const rsiCfg = cfg.RSI_DIRECTION_GATE || {};
  if (rsiCfg.enabled !== false && rsi !== null) {
    const chasing =
      (dir === 'BUY'  && rsi > (rsiCfg.buyMaxRsi  || 55)) ||
      (dir === 'SELL' && rsiCfg.sellPenaltyEnabled !== false && rsi < (rsiCfg.sellMinRsi || 45));
    if (chasing) {
      const mode = rsiCfg.mode === 'block' ? 'block' : 'penalty';
      const gateDir = dir; // keep the pre-block direction for the message
      const threshold = gateDir === 'BUY' ? (rsiCfg.buyMaxRsi || 55) : (rsiCfg.sellMinRsi || 45);
      audit.rsiGate = {
        direction: gateDir, rsi: round2(rsi),
        threshold, mode, mult: mode === 'penalty' ? (rsiCfg.penaltyMult || 0.85) : null,
      };
      if (mode === 'block') {
        dir = 'NO_TRADE'; conf = 0;
        applied.push('RSI_DIRECTION_GATE_BLOCK (' + gateDir + ' rsi=' + round2(rsi) + ' > ' + threshold + ')');
        audit.blockedBy = 'RSI_DIRECTION_GATE';
        return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
      }
      totalMult *= (rsiCfg.penaltyMult || 0.85);
      applied.push('RSI_DIRECTION_GATE_PENALTY x' + (rsiCfg.penaltyMult || 0.85).toFixed(2) +
        ' (' + gateDir + ' rsi=' + round2(rsi) + ' ' + (gateDir === 'BUY' ? '>' : '<') + ' ' + threshold + ')');
    }
  }

  // ── 2. Volatility state (BB bandwidth %) ───────────────────────────────
  const volCfg2 = cfg.VOL_STATE || {};
  if (volCfg2.enabled !== false && bb !== null) {
    if (deadBlock !== null && bb <= deadBlock) {
      dir = 'NO_TRADE'; conf = 0;
      applied.push('VOL_STATE_DEAD_SQUEEZE_BLOCK (bb=' + round2(bb) + ' <= ' + deadBlock + ')');
      audit.bbState = 'DEAD_SQUEEZE';
      audit.blockedBy = 'VOL_STATE_DEAD_SQUEEZE';
      return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
    }
    if (squeezeMax !== null && bb <= squeezeMax) {
      totalMult *= (volCfg2.squeezeMult || 0.90);
      audit.bbState = 'MID_SQUEEZE';
      applied.push('VOL_STATE_MID_SQUEEZE x' + (volCfg2.squeezeMult || 0.90).toFixed(2) +
        ' (bb=' + round2(bb) + ' <= ' + squeezeMax + ')');
    } else {
      audit.bbState = 'HIGH_VOL';
    }
  }

  // ── 3. ATR percentile ──────────────────────────────────────────────────
  const atrCfg = cfg.ATR_PERCENTILE || {};
  if (atrCfg.enabled !== false && Array.isArray(atrArr)) {
    const pct = computeAtrPercentile(atrArr, atrCfg.window, atrCfg.minSamples);
    if (pct !== null) {
      audit.atrPercentile = pct;
      if (pct < (atrCfg.squeezePct || 30)) {
        totalMult *= (atrCfg.squeezeMult || 0.95);
        applied.push('ATR_PERCENTILE_SQUEEZE x' + (atrCfg.squeezeMult || 0.95).toFixed(2) + ' (pct=' + pct + ')');
      } else if (pct > (atrCfg.expansionPct || 80)) {
        totalMult *= (atrCfg.expansionMult || 1.05);
        applied.push('ATR_PERCENTILE_EXPANSION x' + (atrCfg.expansionMult || 1.05).toFixed(2) + ' (pct=' + pct + ')');
      }
    }
  }

  // ── 4. Hour of day (dynamic calib overrides the static map when fresh) ─
  const hour = now instanceof Date ? now.getUTCHours() : new Date().getUTCHours();
  audit.hourUtc = hour;
  let hourMult = 1.0;
  if (calib && calib.hourWR && calib.hourWR[hour] &&
      calib.hourWR[hour].n >= (CONFIG.SELF_CALIB.MIN_HOUR_OBS || 20) &&
      typeof calib.hourWR[hour].wr === 'number' && typeof calib.base === 'number') {
    const wr = calib.hourWR[hour].wr;
    hourMult = clamp(wr / calib.base, CONFIG.SELF_CALIB.HOUR_MULT_MIN || 0.85, CONFIG.SELF_CALIB.HOUR_MULT_MAX || 1.10);
  } else {
    hourMult = (cfg.HOUR_MULTIPLIERS && cfg.HOUR_MULTIPLIERS[hour]) || 1.0;
  }
  if (hourMult !== 1.0) {
    totalMult *= hourMult;
    applied.push('HOUR_FACTOR x' + hourMult.toFixed(2) + ' (UTC ' + String(hour).padStart(2, '0') + ')');
  }
  audit.hourMult = round4(hourMult);

  // ── 5. Session-range position ──────────────────────────────────────────
  const srCfg = cfg.SESSION_RANGE || {};
  if (srCfg.enabled !== false) {
    const sr = computeSessionRange(candleData, now, srCfg);
    if (sr) {
      audit.sessionRange = sr.position;
      if (sr.position <= (srCfg.extremeLow || 0.15) || sr.position >= (srCfg.extremeHigh || 0.85)) {
        totalMult *= (srCfg.extremeMult || 1.05);
        audit.sessionRangeMult = srCfg.extremeMult || 1.05;
        applied.push('SESSION_RANGE_EXTREME x' + (srCfg.extremeMult || 1.05).toFixed(2) + ' (pos=' + sr.position + ')');
      }
    }
  }

  // ── 6. Recent-form gate ────────────────────────────────────────────────
  const rfCfg = cfg.RECENT_FORM || {};
  if (rfCfg.enabled !== false) {
    const rf = await getRecentFormMultiplier(pair, env, rfCfg);
    if (rf.mult !== 1.0) {
      totalMult *= rf.mult;
      audit.recentFormWr = round2(rf.wr);
      audit.recentFormMult = rf.mult;
      applied.push('RECENT_FORM_PENALTY x' + rf.mult.toFixed(2) + ' (wr=' + round2(rf.wr) + ', n=' + rf.sample + ')');
    } else if (rf.wr !== null) {
      audit.recentFormWr = round2(rf.wr);
    }
  }

  // ── Combine ────────────────────────────────────────────────────────────
  totalMult = clamp(totalMult, cfg.MIN_TOTAL_MULT || 0.55, cfg.MAX_TOTAL_MULT || 1.12);
  audit.totalMult = round4(totalMult);
  if (totalMult !== 1.0 && dir !== 'NO_TRADE') {
    // 92 cap mirrors the engine's existing confidence cap (voteFilters/AI).
    conf = Math.min(92, Math.round(conf * totalMult));
  }

  return { finalDirection: dir, confidence: conf, filtersApplied: applied, audit };
}

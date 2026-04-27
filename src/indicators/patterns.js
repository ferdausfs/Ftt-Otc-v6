// ============================================================
// PRICE STRUCTURE DETECTION
// S/R Levels (swing clustering), Fair Value Gaps, Candlestick Patterns
// ============================================================
// ============================================
// [v6.3] SUPPORT & RESISTANCE LEVELS
// Swing high/low detection with ATR clustering
// ============================================

function detectSRLevels(candles, atr) {
  if (!candles || candles.length < 10) return { supports: [], resistances: [] };
  const n = candles.length;
  const lookback = 3; // bars each side to confirm swing
  const clusterDist = atr !== null ? atr * 0.6 : candles[n - 1].close * 0.002;
  const lastClose = candles[n - 1].close;

  const rawHighs = [];
  const rawLows  = [];

  // Find swing highs and lows
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true; let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) rawHighs.push(candles[i].high);
    if (isLow)  rawLows.push(candles[i].low);
  }

  // Cluster nearby levels
  function cluster(levels) {
    if (!levels.length) return [];
    levels.sort(function (a, b) { return a - b; });
    const groups = [[levels[0]]];
    for (let i = 1; i < levels.length; i++) {
      const last = groups[groups.length - 1];
      const avg  = last.reduce(function (s, v) { return s + v; }, 0) / last.length;
      if (Math.abs(levels[i] - avg) <= clusterDist) last.push(levels[i]);
      else groups.push([levels[i]]);
    }
    return groups.map(function (g) {
      return {
        price: g.reduce(function (s, v) { return s + v; }, 0) / g.length,
        strength: g.length, // how many swing points cluster here
      };
    }).sort(function (a, b) { return b.strength - a.strength; }).slice(0, 5);
  }

  const resistances = cluster(rawHighs).filter(function (r) { return r.price > lastClose; });
  const supports    = cluster(rawLows).filter(function (s)  { return s.price < lastClose; });

  return { supports: supports, resistances: resistances, clusterDist: clusterDist };
}

// ============================================
// [v6.3] FAIR VALUE GAP (FVG) DETECTION
// 3-candle imbalance — price leaves a gap the market tends to fill
// Bullish FVG: candle[i].low > candle[i-2].high
// Bearish FVG: candle[i].high < candle[i-2].low
// ============================================

function detectFVG(candles) {
  if (!candles || candles.length < 3) return { bullish: [], bearish: [], active: null };
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  const scanBack  = Math.min(30, n - 1);
  const bullishFVGs = [];
  const bearishFVGs = [];

  // FIX: iterate from end backwards — i is index of 3rd candle in triplet
  // c0=candles[i-2], c1=candles[i-1] (impulse body), c2=candles[i]
  for (let i = n - 1; i >= 2 && i >= n - 1 - scanBack; i--) {
    const c0  = candles[i - 2];
    const c2  = candles[i];
    const age = n - 1 - i; // 0 = most recent

    // Bullish FVG: bottom of c2 is above top of c0 → upward gap
    if (c2.low > c0.high) {
      const top      = c2.low;
      const bottom   = c0.high;
      const midpoint = (top + bottom) / 2;
      const filled   = lastClose < bottom; // fully below gap = mitigated
      if (!filled) {
        bullishFVGs.push({ top, bottom, midpoint, age });
      }
    }

    // Bearish FVG: top of c2 is below bottom of c0 → downward gap
    if (c2.high < c0.low) {
      const top      = c0.low;
      const bottom   = c2.high;
      const midpoint = (top + bottom) / 2;
      const filled   = lastClose > top; // fully above gap = mitigated
      if (!filled) {
        bearishFVGs.push({ top, bottom, midpoint, age });
      }
    }
  }

  // Sort: most recent first (lowest age)
  bullishFVGs.sort((a, b) => a.age - b.age);
  bearishFVGs.sort((a, b) => a.age - b.age);

  // Determine if current price is INSIDE an active FVG
  var active = null;

  // Bullish FVG: demand imbalance — supports BUY
  for (var bi = 0; bi < bullishFVGs.length; bi++) {
    var bf = bullishFVGs[bi];
    if (lastClose >= bf.bottom && lastClose <= bf.top) {
      active = { type: 'BULLISH', fvg: bf };
      break;
    }
  }

  // Bearish FVG: supply imbalance — supports SELL
  if (!active) {
    for (var si = 0; si < bearishFVGs.length; si++) {
      var sf = bearishFVGs[si];
      if (lastClose >= sf.bottom && lastClose <= sf.top) {
        active = { type: 'BEARISH', fvg: sf };
        break;
      }
    }
  }

  // Nearest unmitigated FVGs (most recent = index 0 after sort)
  var nearestBullish = bullishFVGs.length ? bullishFVGs[0] : null;
  var nearestBearish = bearishFVGs.length ? bearishFVGs[0] : null;

  return {
    bullish: bullishFVGs,
    bearish: bearishFVGs,
    active: active,
    nearestBullish: nearestBullish,
    nearestBearish: nearestBearish,
  };
}

// ============================================
// CANDLESTICK PATTERNS
// ============================================

function detectCandlestickPatterns(candles) {
  const patterns = [];
  if (!candles || candles.length < 3) return patterns;
  const n = candles.length;
  const c0 = candles[n - 1]; const c1 = candles[n - 2]; const c2 = candles[n - 3];
  const b0 = c0.close - c0.open; const b1 = c1.close - c1.open; const b2 = c2.close - c2.open;
  const ab0 = Math.abs(b0); const ab1 = Math.abs(b1);
  const r0 = (c0.high - c0.low) || 0.00001; const r1 = (c1.high - c1.low) || 0.00001;
  const bp0 = ab0 / r0; const bp1 = ab1 / r1;
  const uw0 = c0.high - Math.max(c0.open, c0.close);
  const lw0 = Math.min(c0.open, c0.close) - c0.low;

  if (b1 < 0 && b0 > 0 && c0.open <= c1.close && c0.close >= c1.open && ab0 > ab1)
    patterns.push({ name: 'BULLISH_ENGULFING', direction: 'BUY', strength: 2.0 });
  if (b1 > 0 && b0 < 0 && c0.open >= c1.close && c0.close <= c1.open && ab0 > ab1)
    patterns.push({ name: 'BEARISH_ENGULFING', direction: 'SELL', strength: 2.0 });
  if (bp0 < 0.35 && lw0 > ab0 * 2 && uw0 < ab0 * 0.5)
    patterns.push({ name: 'HAMMER', direction: 'BUY', strength: 1.5 });
  if (bp0 < 0.35 && uw0 > ab0 * 2 && lw0 < ab0 * 0.5)
    patterns.push({ name: 'SHOOTING_STAR', direction: 'SELL', strength: 1.5 });
  if (bp0 < 0.1)
    patterns.push({ name: 'DOJI', direction: 'NEUTRAL', strength: 0.5 });
  if (lw0 > r0 * 0.6 && uw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: 'PIN_BAR_BULLISH', direction: 'BUY', strength: 1.8 });
  if (uw0 > r0 * 0.6 && lw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name: 'PIN_BAR_BEARISH', direction: 'SELL', strength: 1.8 });

  const r2v = (c2.high - c2.low) || 0.00001;
  if (b2 < 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 > 0 && bp0 > 0.5 && c0.close > (c2.open + c2.close) / 2)
    patterns.push({ name: 'MORNING_STAR', direction: 'BUY', strength: 2.5 });
  if (b2 > 0 && Math.abs(b2) / r2v > 0.5 && bp1 < 0.2 && b0 < 0 && bp0 > 0.5 && c0.close < (c2.open + c2.close) / 2)
    patterns.push({ name: 'EVENING_STAR', direction: 'SELL', strength: 2.5 });
  if (b2 > 0 && b1 > 0 && b0 > 0 && c1.close > c2.close && c0.close > c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: 'THREE_WHITE_SOLDIERS', direction: 'BUY', strength: 2.0 });
  if (b2 < 0 && b1 < 0 && b0 < 0 && c1.close < c2.close && c0.close < c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name: 'THREE_BLACK_CROWS', direction: 'SELL', strength: 2.0 });

  return patterns;
}

export { detectSRLevels, detectFVG, detectCandlestickPatterns };

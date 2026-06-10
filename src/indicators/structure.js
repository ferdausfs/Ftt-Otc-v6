/**
 * Market Structure Analysis
 * BOS (Break of Structure) + CHoCH (Change of Character) + Liquidity Sweeps
 *
 * Logic:
 * - Swing points থেকে market structure বোঝা
 * - BOS = trend continuation (আগের swing high/low break)
 * - CHoCH = trend reversal (structure shift)
 * - Liquidity Sweep = stop hunt → reversal setup
 */

// ── SWING POINT DETECTION ─────────────────────────────────
function findSwingPoints(candles, lookback) {
  const swingHighs = [];
  const swingLows  = [];
  const n = candles.length;

  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow  = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: candles[i].high, time: candles[i].datetime });
    if (isLow)  swingLows.push ({ idx: i, price: candles[i].low,  time: candles[i].datetime });
  }

  return {
    swingHighs: swingHighs.slice(-8),  // শেষ ৮টা রাখো
    swingLows:  swingLows.slice(-8),
  };
}

// ── STRUCTURE BIAS ────────────────────────────────────────
// শেষ কয়েকটা swing দেখে market কোন direction এ আছে
function determineStructureBias(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return 'NEUTRAL';

  const recentHighs = swingHighs.slice(-3);
  const recentLows  = swingLows.slice(-3);

  const higherHighs = recentHighs.length >= 2 &&
    recentHighs[recentHighs.length - 1].price > recentHighs[recentHighs.length - 2].price;
  const higherLows = recentLows.length >= 2 &&
    recentLows[recentLows.length - 1].price  > recentLows[recentLows.length - 2].price;
  const lowerHighs = recentHighs.length >= 2 &&
    recentHighs[recentHighs.length - 1].price < recentHighs[recentHighs.length - 2].price;
  const lowerLows  = recentLows.length >= 2 &&
    recentLows[recentLows.length - 1].price   < recentLows[recentLows.length - 2].price;

  if (higherHighs && higherLows)  return 'BULLISH';       // HH + HL = strong bull
  if (lowerHighs  && lowerLows)   return 'BEARISH';       // LH + LL = strong bear
  if (higherHighs && !higherLows) return 'WEAK_BULLISH';  // HH কিন্তু HL নেই
  if (lowerLows   && !lowerHighs) return 'WEAK_BEARISH';  // LL কিন্তু LH নেই
  return 'NEUTRAL';
}

// ── BOS DETECTION ─────────────────────────────────────────
// Break of Structure = trend continuation signal
// Close beyond previous swing = confirmed BOS
function detectBOS(candles, swingHighs, swingLows, structureBias) {
  if (!candles || candles.length < 5) return null;
  if (swingHighs.length === 0 || swingLows.length === 0) return null;

  const lastClose  = candles[candles.length - 1].close;
  const prevClose  = candles[candles.length - 2].close;
  const n          = candles.length;

  // BULLISH BOS: current close > last swing high (must be recent — last 10 bars)
  const lastSH = swingHighs[swingHighs.length - 1];
  if (lastSH && (n - 1 - lastSH.idx) <= 15 && lastClose > lastSH.price && prevClose <= lastSH.price) {
    return {
      type:       'BULLISH_BOS',
      direction:  'BUY',
      level:      lastSH.price,
      breakAmount: lastClose - lastSH.price,
      barsAgo:    n - 1 - lastSH.idx,
      confirmed:  true,   // Close confirmation (not just wick)
      strength:   (lastClose - lastSH.price) > 0 ? 'CONFIRMED' : 'WEAK',
    };
  }

  // BEARISH BOS: current close < last swing low
  const lastSL = swingLows[swingLows.length - 1];
  if (lastSL && (n - 1 - lastSL.idx) <= 15 && lastClose < lastSL.price && prevClose >= lastSL.price) {
    return {
      type:       'BEARISH_BOS',
      direction:  'SELL',
      level:      lastSL.price,
      breakAmount: lastSL.price - lastClose,
      barsAgo:    n - 1 - lastSL.idx,
      confirmed:  true,
      strength:   'CONFIRMED',
    };
  }

  return null;
}

// ── CHoCH DETECTION ───────────────────────────────────────
// Change of Character = first sign of trend REVERSAL
// Bears break a bearish swing high → structure shifting bullish
function detectCHoCH(candles, swingHighs, swingLows, structureBias) {
  if (!candles || candles.length < 10) return null;

  const lastClose = candles[candles.length - 1].close;
  const prevClose = candles[candles.length - 2].close;
  const n         = candles.length;

  // BULLISH CHoCH: Market was BEARISH, price now closes above last Lower High
  if (structureBias === 'BEARISH' || structureBias === 'WEAK_BEARISH') {
    if (swingHighs.length >= 2) {
      // Last Lower High (most recent swing high in downtrend)
      const lastLH = swingHighs[swingHighs.length - 1];
      if (lastLH && (n - 1 - lastLH.idx) <= 20 && lastClose > lastLH.price && prevClose <= lastLH.price) {
        return {
          type:      'BULLISH_CHOCH',
          direction: 'BUY',
          level:     lastLH.price,
          prevBias:  structureBias,
          confirmed: true,
          // CHoCH is stronger than BOS — এটা reversal এর প্রথম confirmation
          strength:  'REVERSAL',
          note:      'Structure shifting BEARISH → BULLISH',
        };
      }
    }
  }

  // BEARISH CHoCH: Market was BULLISH, price now closes below last Higher Low
  if (structureBias === 'BULLISH' || structureBias === 'WEAK_BULLISH') {
    if (swingLows.length >= 2) {
      // Last Higher Low (most recent swing low in uptrend)
      const lastHL = swingLows[swingLows.length - 1];
      if (lastHL && (n - 1 - lastHL.idx) <= 20 && lastClose < lastHL.price && prevClose >= lastHL.price) {
        return {
          type:      'BEARISH_CHOCH',
          direction: 'SELL',
          level:     lastHL.price,
          prevBias:  structureBias,
          confirmed: true,
          strength:  'REVERSAL',
          note:      'Structure shifting BULLISH → BEARISH',
        };
      }
    }
  }

  return null;
}

// ── LIQUIDITY SWEEP DETECTION ─────────────────────────────
// Equal highs/lows = clustered stop losses = institutional target
// Sweep = wick beyond level + close back inside = stop hunt → reversal
function detectLiquiditySweep(candles, swingHighs, swingLows, atr) {
  if (!candles || candles.length < 5 || !atr || atr <= 0) return null;

  const last  = candles[candles.length - 1];
  const prev1 = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  const totalRange = (last.high - last.low) || 0.00001;

  // Equal level threshold: ATR এর ৩০% এর মধ্যে = "equal"
  const eqThreshold = atr * 0.3;

  // ── Check SELL-SIDE SWEEP (equal highs swept → expect SELL) ──
  const recentSH = swingHighs.slice(-6);
  for (let i = 0; i < recentSH.length - 1; i++) {
    for (let j = i + 1; j < recentSH.length; j++) {
      if (Math.abs(recentSH[i].price - recentSH[j].price) < eqThreshold) {
        const liquidityLevel = Math.max(recentSH[i].price, recentSH[j].price);
        // Sweep condition: wick above, close below
        if (last.high > liquidityLevel && last.close < liquidityLevel) {
          const wickAbove  = last.high - Math.max(last.open, last.close);
          const wickRatio  = wickAbove / totalRange;
          if (wickRatio >= 0.35) {
            return {
              type:           'SELL_SWEEP',   // Buy-side liquidity swept → SELL
              direction:      'SELL',
              liquidityLevel,
              wickSize:       wickAbove,
              wickRatio:      Math.round(wickRatio * 100) / 100,
              confirmed:      last.close < liquidityLevel,
              strength:       wickRatio >= 0.55 ? 'STRONG' : 'MODERATE',
              equalHighCount: 2,
              note:           'Stop hunt above equal highs → reversal SELL',
            };
          }
        }
      }
    }
  }

  // ── Check BUY-SIDE SWEEP (equal lows swept → expect BUY) ──
  const recentSL = swingLows.slice(-6);
  for (let i = 0; i < recentSL.length - 1; i++) {
    for (let j = i + 1; j < recentSL.length; j++) {
      if (Math.abs(recentSL[i].price - recentSL[j].price) < eqThreshold) {
        const liquidityLevel = Math.min(recentSL[i].price, recentSL[j].price);
        // Sweep condition: wick below, close above
        if (last.low < liquidityLevel && last.close > liquidityLevel) {
          const wickBelow = Math.min(last.open, last.close) - last.low;
          const wickRatio = wickBelow / totalRange;
          if (wickRatio >= 0.35) {
            return {
              type:           'BUY_SWEEP',    // Sell-side liquidity swept → BUY
              direction:      'BUY',
              liquidityLevel,
              wickSize:       wickBelow,
              wickRatio:      Math.round(wickRatio * 100) / 100,
              confirmed:      last.close > liquidityLevel,
              strength:       wickRatio >= 0.55 ? 'STRONG' : 'MODERATE',
              equalLowCount:  2,
              note:           'Stop hunt below equal lows → reversal BUY',
            };
          }
        }
      }
    }
  }

  return null;
}

// ── RECENT STRUCTURE CHECK (last N bars) ─────────────────
// Recent BOS/CHoCH within last few candles? এটা fresh signal
function checkRecentStructureEvent(candles, swingHighs, swingLows, structureBias, barsAgoMax) {
  const n = candles.length;
  const events = [];

  // Recent bullish BOS (last barsAgoMax candles)
  for (const sh of swingHighs.slice(-3)) {
    if ((n - 1 - sh.idx) <= barsAgoMax) {
      // Check if any candle after this swing high closed above it
      for (let i = sh.idx + 1; i < n; i++) {
        if (candles[i].close > sh.price) {
          events.push({ type: 'RECENT_BULLISH_BOS', barsAgo: n - 1 - i, level: sh.price });
          break;
        }
      }
    }
  }

  // Recent bearish BOS
  for (const sl of swingLows.slice(-3)) {
    if ((n - 1 - sl.idx) <= barsAgoMax) {
      for (let i = sl.idx + 1; i < n; i++) {
        if (candles[i].close < sl.price) {
          events.push({ type: 'RECENT_BEARISH_BOS', barsAgo: n - 1 - i, level: sl.price });
          break;
        }
      }
    }
  }

  return events;
}

// ── MAIN: ANALYZE STRUCTURE ───────────────────────────────
export function analyzeStructure(candles, atr, timeframe) {
  if (!candles || candles.length < 20) {
    return {
      bias: 'NEUTRAL', bos: null, choch: null, sweep: null,
      swingHighs: [], swingLows: [], recentEvents: [],
      structureScore: { up: 0, down: 0 },
      multiplier: { direction: null, value: 1.0 },
      summary: 'INSUFFICIENT_DATA',
    };
  }

  // Lookback depends on timeframe
  // 15min: more reliable with bigger lookback
  // 1min: noisy, smaller lookback
  const lookback = timeframe === '15min' ? 4 : timeframe === '5min' ? 3 : 2;
  const barsAgoMax = timeframe === '15min' ? 10 : timeframe === '5min' ? 8 : 5;

  const { swingHighs, swingLows } = findSwingPoints(candles, lookback);
  const structureBias = determineStructureBias(swingHighs, swingLows);
  const bos   = detectBOS(candles, swingHighs, swingLows, structureBias);
  const choch = detectCHoCH(candles, swingHighs, swingLows, structureBias);
  const sweep = detectLiquiditySweep(candles, swingHighs, swingLows, atr);
  const recentEvents = checkRecentStructureEvent(candles, swingHighs, swingLows, structureBias, barsAgoMax);

  // ── STRUCTURE SCORE for category system ──
  let sUp = 0; let sDown = 0;

  // Bias score (background context)
  if (structureBias === 'BULLISH')      { sUp += 1.5; }
  else if (structureBias === 'BEARISH') { sDown += 1.5; }
  else if (structureBias === 'WEAK_BULLISH') { sUp += 0.8; }
  else if (structureBias === 'WEAK_BEARISH') { sDown += 0.8; }

  // BOS score (trend continuation)
  if (bos) {
    if (bos.direction === 'BUY')  sUp   += 2.0;
    else                          sDown += 2.0;
  }

  // CHoCH score (reversal — highest value)
  if (choch) {
    if (choch.direction === 'BUY')  sUp   += 2.5;
    else                            sDown += 2.5;
  }

  // Sweep score (stop hunt reversal)
  if (sweep) {
    const sweepBonus = sweep.strength === 'STRONG' ? 1.8 : 1.2;
    if (sweep.direction === 'BUY')  sUp   += sweepBonus;
    else                            sDown += sweepBonus;
  }

  // Recent events
  for (const ev of recentEvents) {
    if (ev.type === 'RECENT_BULLISH_BOS') sUp   += 0.5;
    if (ev.type === 'RECENT_BEARISH_BOS') sDown += 0.5;
  }

  // ── MULTIPLIER for engine confidence ──
  // এটাই সবচেয়ে গুরুত্বপূর্ণ — aligned signal কে boost, counter signal কে penalize
  let multiplierDir   = null;
  let multiplierValue = 1.0;
  let summary         = 'NEUTRAL';

  if (choch) {
    // CHoCH = strongest reversal signal = highest multiplier
    multiplierDir   = choch.direction;
    multiplierValue = 1.40;
    summary = 'CHOCH_' + (choch.direction === 'BUY' ? 'BULLISH' : 'BEARISH');
  } else if (bos) {
    multiplierDir   = bos.direction;
    multiplierValue = 1.25;
    summary = 'BOS_' + (bos.direction === 'BUY' ? 'BULLISH' : 'BEARISH');
  } else if (structureBias === 'BULLISH') {
    multiplierDir   = 'BUY';
    multiplierValue = 1.12;
    summary = 'BIAS_BULLISH';
  } else if (structureBias === 'BEARISH') {
    multiplierDir   = 'SELL';
    multiplierValue = 1.12;
    summary = 'BIAS_BEARISH';
  } else if (structureBias === 'WEAK_BULLISH') {
    multiplierDir   = 'BUY';
    multiplierValue = 1.06;
    summary = 'WEAK_BULLISH';
  } else if (structureBias === 'WEAK_BEARISH') {
    multiplierDir   = 'SELL';
    multiplierValue = 1.06;
    summary = 'WEAK_BEARISH';
  }

  // Sweep adds to multiplier if same direction
  if (sweep && multiplierDir === sweep.direction) {
    multiplierValue += sweep.strength === 'STRONG' ? 0.15 : 0.08;
    summary += '+SWEEP';
  } else if (sweep && multiplierDir !== sweep.direction && multiplierDir !== null) {
    // Sweep against our direction = reduce multiplier slightly
    multiplierValue -= 0.05;
  }

  // Recent BOS event (already faded from current `bos`) aligned with bias =
  // breakout momentum still fresh → small extra boost
  if (multiplierDir && !bos) {
    const alignedRecentBOS = recentEvents.some(ev =>
      (ev.type === 'RECENT_BULLISH_BOS' && multiplierDir === 'BUY') ||
      (ev.type === 'RECENT_BEARISH_BOS' && multiplierDir === 'SELL')
    );
    if (alignedRecentBOS) {
      multiplierValue += 0.06;
      summary += '+RECENT_BOS';
    }
  }

  // Cap multiplier
  multiplierValue = Math.min(multiplierValue, 1.65);

  return {
    bias: structureBias,
    bos,
    choch,
    sweep,
    swingHighs: swingHighs.slice(-5),
    swingLows:  swingLows.slice(-5),
    recentEvents,
    structureScore: { up: Math.round(sUp * 100) / 100, down: Math.round(sDown * 100) / 100 },
    multiplier: { direction: multiplierDir, value: Math.round(multiplierValue * 1000) / 1000 },
    summary,
  };
}

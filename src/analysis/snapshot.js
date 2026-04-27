// ============================================================
// INDICATOR SNAPSHOT BUILDER
// Builds compact 20-candle snapshot for AI prompt (v6.6.1)
// ============================================================
// ============================================
// [v6.5.0] BUILD INDICATOR SNAPSHOT for Cerebras
// Pulls best-TF indicators into a flat object
// ============================================

function buildIndicatorSnapshot(tfResults, candleData, finalDirection, bestTF) {
  var best = tfResults[bestTF] || tfResults['5min'] || tfResults['1min'] || tfResults['15min'];
  if (!best) return null;

  var ind = best.indicators || {};
  var catScores = best.categoryScores || {};

  // [v6.6.1] Build compact 20-candle string per TF
  // Format: "U/B:O/H/L/C" — U=bullish, B=bearish, prices 5 decimal
  function compactCandles(candles, count) {
    if (!candles || candles.length === 0) return 'N/A';
    var recent = candles.slice(-count);
    return recent.map(function(c) {
      var dir = c.close >= c.open ? 'U' : 'B';
      var o = c.open.toFixed(5);
      var h = c.high.toFixed(5);
      var l = c.low.toFixed(5);
      var cl = c.close.toFixed(5);
      return dir + ':' + o + '/' + h + '/' + l + '/' + cl;
    }).join(' ');
  }

  // [v6.6.1] Price structure from last 20 candles
  function priceStructure(candles) {
    if (!candles || candles.length < 6) return 'UNKNOWN';
    var recent = candles.slice(-20);
    var highs = recent.map(function(c) { return c.high; });
    var lows  = recent.map(function(c) { return c.low;  });
    var n = recent.length;
    // Compare first half vs second half
    var midH1 = Math.max.apply(null, highs.slice(0, Math.floor(n/2)));
    var midH2 = Math.max.apply(null, highs.slice(Math.floor(n/2)));
    var midL1 = Math.min.apply(null, lows.slice(0, Math.floor(n/2)));
    var midL2 = Math.min.apply(null, lows.slice(Math.floor(n/2)));
    var higherHigh = midH2 > midH1;
    var higherLow  = midL2 > midL1;
    var lowerHigh  = midH2 < midH1;
    var lowerLow   = midL2 < midL1;
    if (higherHigh && higherLow)  return 'HH-HL (Bullish structure)';
    if (lowerHigh  && lowerLow)   return 'LH-LL (Bearish structure)';
    if (higherHigh && lowerLow)   return 'Expanding (Volatile)';
    if (lowerHigh  && higherLow)  return 'Contracting (Consolidation)';
    return 'Mixed structure';
  }

  // [v6.6.1] Nearest S/R distance in pips
  function srDistance(catSc, atr) {
    var ctx = catSc.sr && catSc.sr.context ? catSc.sr.context : 'NO_LEVEL';
    if (!atr || atr === 'N/A') return ctx;
    return ctx;
  }

  var candles1  = candleData['1min']  || [];
  var candles5  = candleData['5min']  || [];
  var candles15 = candleData['15min'] || [];

  return {
    emaAlignment:  ind.emaAlignment  || 'UNKNOWN',
    ema5:          ind.ema5          || 'N/A',
    ema10:         ind.ema10         || 'N/A',
    ema20:         ind.ema20         || 'N/A',
    rsi:           ind.rsi           || 'N/A',
    macdHist:      ind.macdHist      || 'N/A',
    adx:           ind.adx           || 'N/A',
    plusDI:        ind.plusDI        || 'N/A',
    minusDI:       ind.minusDI       || 'N/A',
    stochK:        ind.stochK        || 'N/A',
    stochD:        ind.stochD        || 'N/A',
    williamsR:     ind.williamsR     || 'N/A',
    cci:           ind.cci           || 'N/A',
    bbPercentB:    ind.bbPercentB    || 'N/A',
    bbBandwidth:   ind.bbBandwidth   || 'N/A',
    atr:           ind.atr           || 'N/A',
    pivot:         ind.pivot         || 'N/A',
    r1:            ind.r1            || 'N/A',
    s1:            ind.s1            || 'N/A',
    srContext:     (catScores.sr && catScores.sr.context)             || 'NO_LEVEL',
    fvgActive:     (catScores.fvg && catScores.fvg.active)            || 'NONE',
    patterns:      (catScores.patterns && catScores.patterns.detected) || [],
    rsiDiv:        (catScores.divergence && catScores.divergence.rsi)  || 'NONE',
    macdDiv:       (catScores.divergence && catScores.divergence.macd) || 'NONE',
    // [v6.6.1] 20 candle compact + structure
    candles1min:   compactCandles(candles1,  20),
    candles5min:   compactCandles(candles5,  20),
    candles15min:  compactCandles(candles15, 20),
    structure1min:  priceStructure(candles1),
    structure5min:  priceStructure(candles5),
    structure15min: priceStructure(candles15),
  };
}

// ============================================
// BUILD MULTI-TIMEFRAME SIGNAL (v6.5.0)
// ============================================

export { buildIndicatorSnapshot };

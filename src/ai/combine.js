export function combineDualAIResults(cerebras, groq, engineDirection) {
  const result = { cerebras, groq, combined: null, combinedAgreed: null };
  const cOk = cerebras && cerebras.status === 'OK';
  const gOk = groq     && groq.status     === 'OK';

  if (!cOk && !gOk) {
    result.combined = { status: 'BOTH_UNAVAILABLE', signal: 'NO_TRADE', confidence: 0 };
    return result;
  }
  if (cOk && !gOk) {
    result.combined = cerebras;
    result.combinedAgreed = cerebras.signal === engineDirection;
    return result;
  }
  if (!cOk && gOk) {
    result.combined = groq;
    result.combinedAgreed = groq.signal === engineDirection;
    return result;
  }

  if (cerebras.signal === groq.signal) {
    result.combined = {
      status: 'OK', signal: cerebras.signal,
      confidence: Math.round((cerebras.confidence + groq.confidence) / 2),
      reason: cerebras.reason || groq.reason,
      concerns: cerebras.concerns || groq.concerns,
      agreement: 'BOTH_AGREE', model: 'dual (Cerebras + Groq)',
    };
  } else {
    result.combined = {
      status: 'OK', signal: 'NO_TRADE',
      confidence: Math.min(cerebras.confidence, groq.confidence),
      reason: 'Cerebras=' + cerebras.signal + ' vs Groq=' + groq.signal + ' — AIs disagree',
      concerns: 'Conflicting AI signals — skip trade',
      agreement: 'AIs_DISAGREE', model: 'dual (Cerebras + Groq)',
    };
  }
  result.combinedAgreed = result.combined.signal === engineDirection;
  return result;
}

export function buildIndicatorSnapshot(tfResults, candleData, finalDirection, bestTF) {
  const best = tfResults[bestTF] || tfResults['5min'] || tfResults['1min'] || tfResults['15min'];
  if (!best) return null;
  const ind = best.indicators || {};
  const catScores = best.categoryScores || {};

  function compactCandles(candles, count) {
    if (!candles || candles.length === 0) return 'N/A';
    return candles.slice(-count).map(c => {
      const dir = c.close >= c.open ? 'U' : 'B';
      return dir + ':' + c.open.toFixed(5) + '/' + c.high.toFixed(5) + '/' + c.low.toFixed(5) + '/' + c.close.toFixed(5);
    }).join(' ');
  }

  function priceStructure(candles) {
    if (!candles || candles.length < 6) return 'UNKNOWN';
    const recent = candles.slice(-20);
    const n = recent.length;
    const highs = recent.map(c => c.high); const lows = recent.map(c => c.low);
    const midH1 = Math.max(...highs.slice(0, Math.floor(n/2))); const midH2 = Math.max(...highs.slice(Math.floor(n/2)));
    const midL1 = Math.min(...lows.slice(0, Math.floor(n/2)));  const midL2 = Math.min(...lows.slice(Math.floor(n/2)));
    if (midH2 > midH1 && midL2 > midL1) return 'HH-HL (Bullish)';
    if (midH2 < midH1 && midL2 < midL1) return 'LH-LL (Bearish)';
    if (midH2 > midH1 && midL2 < midL1) return 'Expanding (Volatile)';
    if (midH2 < midH1 && midL2 > midL1) return 'Contracting (Consolidation)';
    return 'Mixed structure';
  }

  const c1 = candleData['1min'] || []; const c5 = candleData['5min'] || []; const c15 = candleData['15min'] || [];
  return {
    // EMA 5/13/55 (Fibonacci set)
    emaAlignment: ind.emaAlignment || 'UNKNOWN',
    ema5:  ind.ema5  || 'N/A',
    ema13: ind.ema13 || 'N/A',
    ema55: ind.ema55 || 'N/A',
    rsi: ind.rsi || 'N/A', macdHist: ind.macdHist || 'N/A',
    adx: ind.adx || 'N/A', plusDI: ind.plusDI || 'N/A', minusDI: ind.minusDI || 'N/A',
    stochK: ind.stochK || 'N/A', stochD: ind.stochD || 'N/A',
    williamsR: ind.williamsR || 'N/A', cci: ind.cci || 'N/A',
    bbPercentB: ind.bbPercentB || 'N/A', bbBandwidth: ind.bbBandwidth || 'N/A',
    atr: ind.atr || 'N/A', pivot: ind.pivot || 'N/A', r1: ind.r1 || 'N/A', s1: ind.s1 || 'N/A',
    srContext:  (catScores.sr        && catScores.sr.context)        || 'NO_LEVEL',
    fvgActive:  (catScores.fvg       && catScores.fvg.active)        || 'NONE',
    patterns:   (catScores.patterns  && catScores.patterns.detected) || [],
    rsiDiv:     (catScores.divergence && catScores.divergence.rsi)   || 'NONE',
    macdDiv:    (catScores.divergence && catScores.divergence.macd)  || 'NONE',
    candles1min:  compactCandles(c1, 20),
    candles5min:  compactCandles(c5, 20),
    candles15min: compactCandles(c15, 20),
    structure1min:  priceStructure(c1),
    structure5min:  priceStructure(c5),
    structure15min: priceStructure(c15),
  };
}

// ============================================================
// CEREBRAS AI VALIDATION (v6.5.0)
// 20-candle context sent to Llama-3.1-70b for signal validation
// Set CEREBRAS_API_KEY secret in Cloudflare dashboard
// ============================================================
// ============================================

async function callCerebrasValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };

  // Build a compact but information-rich prompt
  var prompt = [
    'You are an expert binary options trading analyst. Analyze the following technical indicator snapshot for ' + pair + ' (' + assetType + ').',
    '',
    '=== ENGINE SIGNAL ===',
    'Direction: ' + engineSignal.direction,
    'Confidence: ' + engineSignal.confidence,
    'Alignment: ' + engineSignal.alignment,
    'HTF Trend (15min): ' + engineSignal.higherTFTrend,
    'Market condition: ' + (engineSignal.marketCondition || []).join(', '),
    '',
    '=== INDICATOR SNAPSHOT (best timeframe: ' + engineSignal.bestTF + ') ===',
    'EMA alignment: ' + indicatorSnapshot.emaAlignment,
    'EMA5/10/20: ' + indicatorSnapshot.ema5 + ' / ' + indicatorSnapshot.ema10 + ' / ' + indicatorSnapshot.ema20,
    'RSI(14): ' + indicatorSnapshot.rsi,
    'MACD histogram: ' + indicatorSnapshot.macdHist,
    'ADX: ' + indicatorSnapshot.adx + '  (+DI ' + indicatorSnapshot.plusDI + '  -DI ' + indicatorSnapshot.minusDI + ')',
    'Stochastic K/D: ' + indicatorSnapshot.stochK + ' / ' + indicatorSnapshot.stochD,
    'Williams %R: ' + indicatorSnapshot.williamsR,
    'CCI: ' + indicatorSnapshot.cci,
    'BB %B: ' + indicatorSnapshot.bbPercentB + '  Bandwidth: ' + indicatorSnapshot.bbBandwidth,
    'ATR: ' + indicatorSnapshot.atr,
    'S/R context: ' + indicatorSnapshot.srContext,
    'FVG active: ' + indicatorSnapshot.fvgActive,
    'Candlestick patterns: ' + (indicatorSnapshot.patterns.length ? indicatorSnapshot.patterns.join(', ') : 'NONE'),
    'RSI divergence: ' + indicatorSnapshot.rsiDiv,
    'MACD divergence: ' + indicatorSnapshot.macdDiv,
    'Pivot: ' + indicatorSnapshot.pivot + '  R1: ' + indicatorSnapshot.r1 + '  S1: ' + indicatorSnapshot.s1,
    '',
    '=== PRICE STRUCTURE (last 20 candles) ===',
    '1min  structure: ' + indicatorSnapshot.structure1min,
    '5min  structure: ' + indicatorSnapshot.structure5min,
    '15min structure: ' + indicatorSnapshot.structure15min,
    '',
    '=== RAW CANDLES — compact format (U=bullish B=bearish O/H/L/C, newest last) ===',
    '1min  (20): ' + indicatorSnapshot.candles1min,
    '5min  (20): ' + indicatorSnapshot.candles5min,
    '15min (20): ' + indicatorSnapshot.candles15min,
    '',
    '=== YOUR TASK ===',
    'Based ONLY on these indicators, give your independent analysis.',
    'Consider: Are the indicators consistent? Any contradictions? Is this a high-probability setup?',
    'Respond in STRICT JSON only — no markdown, no extra text:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, 8000); // 8s timeout

    var res;
    try {
      res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY,
        },
        body: JSON.stringify({
          model: 'llama3.1-8b',
          max_tokens: 120,
          temperature: 0.05, // near-deterministic for trading decisions
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      return { status: 'API_ERROR', httpStatus: res.status };
    }

    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content.trim()
      : null;

    if (!text) return { status: 'EMPTY_RESPONSE' };

    // Strip any accidental markdown fences
    text = text.replace(/```json|```/g, '').trim();

    // Find JSON object in response
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'PARSE_ERROR', raw: text.slice(0, 100) };

    var parsed = JSON.parse(jsonMatch[0]);

    // Validate fields
    var validSignals = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSignal = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!validSignals.includes(aiSignal)) aiSignal = 'NO_TRADE';
    var aiConf = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
      : 50;

    return {
      status: 'OK',
      signal: aiSignal,
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: 'cerebras/llama3.1-8b',
    };

  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

// ============================================

export { callCerebrasValidation };

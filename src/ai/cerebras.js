export async function callCerebrasValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };

  const snap = indicatorSnapshot;
  const prompt = [
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
    'EMA alignment: ' + snap.emaAlignment,
    'EMA5/13/55: ' + snap.ema5 + ' / ' + snap.ema13 + ' / ' + snap.ema55,
    'RSI(14): ' + snap.rsi,
    'MACD histogram: ' + snap.macdHist,
    'ADX: ' + snap.adx + '  (+DI ' + snap.plusDI + '  -DI ' + snap.minusDI + ')',
    'Stochastic K/D: ' + snap.stochK + ' / ' + snap.stochD,
    'Williams %R: ' + snap.williamsR,
    'CCI: ' + snap.cci,
    'BB %B: ' + snap.bbPercentB + '  Bandwidth: ' + snap.bbBandwidth,
    'ATR: ' + snap.atr,
    'S/R context: ' + snap.srContext,
    'FVG active: ' + snap.fvgActive,
    'Candlestick patterns: ' + (snap.patterns.length ? snap.patterns.join(', ') : 'NONE'),
    'RSI divergence: ' + snap.rsiDiv,
    'MACD divergence: ' + snap.macdDiv,
    'Pivot: ' + snap.pivot + '  R1: ' + snap.r1 + '  S1: ' + snap.s1,
    '',
    '=== PRICE STRUCTURE (last 20 candles) ===',
    '1min  structure: ' + snap.structure1min,
    '5min  structure: ' + snap.structure5min,
    '15min structure: ' + snap.structure15min,
    '',
    '=== RAW CANDLES (U=bullish B=bearish, newest last) ===',
    '1min  (20): ' + snap.candles1min,
    '5min  (20): ' + snap.candles5min,
    '15min (20): ' + snap.candles15min,
    '',
    '=== YOUR TASK ===',
    'Respond in STRICT JSON only — no markdown:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  return _callCerebrasAPI(prompt, env);
}

export async function callCerebrasValidationOTC(pair, engineSignal, snapshot, otcPatterns, env) {
  if (!env || !env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };
  const snap = snapshot;
  const otcSummary = [
    '=== OTC CONTEXT ===',
    'Consecutive candles: ' + (otcPatterns.consecutiveCandles ? otcPatterns.consecutiveCandles.count + ' × ' + otcPatterns.consecutiveCandles.direction : 'N/A'),
    'Wick rejection: '  + (otcPatterns.wickRejection  ? otcPatterns.wickRejection.type  + ' (ratio=' + otcPatterns.wickRejection.wickRatio  + ')' : 'NONE'),
    'Round number: '    + (otcPatterns.roundNumber    ? otcPatterns.roundNumber.stepType + ' (proximity=' + otcPatterns.roundNumber.proximity + ')' : 'NONE'),
    'Size anomaly: '    + (otcPatterns.sizeAnomaly    ? 'YES expect ' + otcPatterns.sizeAnomaly.likelyDirection + ' (' + otcPatterns.sizeAnomaly.strength + ')' : 'NONE'),
    'Time quality: '    + (otcPatterns.timeContext    ? otcPatterns.timeContext.quality + ' — ' + otcPatterns.timeContext.reason : 'N/A'),
    'OTC signals: '     + (otcPatterns.otcSignals.length ? otcPatterns.otcSignals.join(', ') : 'NONE'),
  ].join('\n');

  const prompt = [
    '=== OTC BINARY TRADING ANALYSIS ===',
    'Pair: ' + pair + ' (OTC — Olymp Trade synthetic)',
    'Engine signal: ' + engineSignal.direction + ' @ ' + engineSignal.confidence,
    '',
    '=== IMPORTANT OTC RULES ===',
    '1. SYNTHETIC price — broker controls it. Trend-following is UNRELIABLE.',
    '2. Mean reversion is primary.',
    '3. Focus on: patterns, RSI/Stoch extremes, BB touches, S/R bounces.',
    '4. 3+ consecutive same-direction candles = high reversal probability.',
    '5. Long wicks = reversal signal.',
    '',
    '=== INDICATORS ===',
    'EMA alignment: ' + snap.emaAlignment,
    'RSI(14): ' + snap.rsi,
    'Stoch K/D: ' + snap.stochK + ' / ' + snap.stochD,
    'Williams %R: ' + snap.williamsR,
    'CCI: ' + snap.cci,
    'BB %B: ' + snap.bbPercentB + '  BW: ' + snap.bbBandwidth,
    'MACD hist: ' + snap.macdHist,
    'Patterns: ' + (snap.patterns.length ? snap.patterns.join(', ') : 'NONE'),
    'RSI div: ' + snap.rsiDiv + '  S/R: ' + snap.srContext,
    '',
    '=== PRICE STRUCTURE ===',
    '1min: ' + snap.structure1min,
    '5min: ' + snap.structure5min,
    '',
    otcSummary,
    '',
    '=== RAW CANDLES ===',
    '1min (20): ' + snap.candles1min,
    '5min (20): ' + snap.candles5min,
    '',
    'Respond in STRICT JSON only:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  const result = await _callCerebrasAPI(prompt, env);
  if (result.status === 'OK') result.mode = 'OTC';
  return result;
}

async function _callCerebrasAPI(prompt, env) {
  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY },
        body: JSON.stringify({ model: 'gpt-oss-120b', max_completion_tokens: 500, temperature: 0.05, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }] }),
      });
    } finally { clearTimeout(timeoutId); }

    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };

    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    let text = msg ? (msg.content || msg.reasoning_content || '') : '';
    text = (text || '').trim();
    if (!text) return { status: 'EMPTY_RESPONSE', raw: JSON.stringify(data).slice(0, 200) };

    text = text.replace(/```json|```/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'PARSE_ERROR', raw: text.slice(0, 100) };

    const parsed = JSON.parse(jsonMatch[0]);
    const valid  = ['BUY', 'SELL', 'NO_TRADE'];
    const aiSig  = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    const aiConf = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;

    return {
      status: 'OK',
      signal: valid.includes(aiSig) ? aiSig : 'NO_TRADE',
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: 'cerebras/gpt-oss-120b',
    };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

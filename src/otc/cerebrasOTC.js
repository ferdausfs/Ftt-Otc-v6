// ============================================================
// CEREBRAS AI — OTC VARIANT (v6.7.0)
// Mean-reversion focused prompt for synthetic OTC prices
// ============================================================
async function callCerebrasValidationOTC(pair, engineSignal, snapshot, otcPatterns, env) {
  if (!env || !env.CEREBRAS_API_KEY) return { status: 'NO_KEY' };
  var basePair = getOTCBasePair(pair);
  var otcSummary = [
    '=== OTC CONTEXT ===',
    'Consecutive candles: ' + (otcPatterns.consecutiveCandles ? otcPatterns.consecutiveCandles.count + ' × ' + otcPatterns.consecutiveCandles.direction : 'N/A'),
    'Wick rejection: '  + (otcPatterns.wickRejection  ? otcPatterns.wickRejection.type  + ' (ratio=' + otcPatterns.wickRejection.wickRatio  + ')' : 'NONE'),
    'Round number: '    + (otcPatterns.roundNumber    ? otcPatterns.roundNumber.stepType + ' (proximity=' + otcPatterns.roundNumber.proximity + ')' : 'NONE'),
    'Size anomaly: '    + (otcPatterns.sizeAnomaly    ? 'YES expect ' + otcPatterns.sizeAnomaly.likelyDirection + ' (' + otcPatterns.sizeAnomaly.strength + ')' : 'NONE'),
    'Time quality: '    + (otcPatterns.timeContext     ? otcPatterns.timeContext.quality  + ' — ' + otcPatterns.timeContext.reason : 'N/A'),
    'OTC signals: '     + (otcPatterns.otcSignals.length ? otcPatterns.otcSignals.join(', ') : 'NONE'),
  ].join('\n');

  var prompt = [
    '=== OTC BINARY TRADING ANALYSIS ===',
    'Pair: ' + basePair + ' (OTC — Olymp Trade synthetic)',
    'Engine signal: ' + engineSignal.direction + ' @ ' + engineSignal.confidence,
    '',
    '=== IMPORTANT OTC RULES ===',
    '1. SYNTHETIC price — broker controls it. Trend-following is UNRELIABLE.',
    '2. Mean reversion is primary — price returns to mean after extremes.',
    '3. Focus on: patterns, RSI/Stoch extremes, BB touches, S/R bounces.',
    '4. 3+ consecutive same-direction candles = high reversal probability.',
    '5. Long wicks = broker pushed price and pulled back = reversal signal.',
    '',
    '=== INDICATORS ===',
    'EMA alignment: ' + snapshot.emaAlignment,
    'RSI(14): ' + snapshot.rsi,
    'Stoch K/D: ' + snapshot.stochK + ' / ' + snapshot.stochD,
    'Williams %R: ' + snapshot.williamsR,
    'CCI: ' + snapshot.cci,
    'BB %B: ' + snapshot.bbPercentB + '  BW: ' + snapshot.bbBandwidth,
    'MACD hist: ' + snapshot.macdHist,
    'ATR: ' + snapshot.atr,
    'Patterns: ' + (snapshot.patterns.length ? snapshot.patterns.join(', ') : 'NONE'),
    'RSI div: ' + snapshot.rsiDiv + '  MACD div: ' + snapshot.macdDiv,
    'S/R: ' + snapshot.srContext,
    '',
    '=== PRICE STRUCTURE ===',
    '1min: '  + snapshot.structure1min,
    '5min: '  + snapshot.structure5min,
    '15min: ' + snapshot.structure15min,
    '',
    otcSummary,
    '',
    '=== RAW CANDLES ===',
    '1min (20): '  + snapshot.candles1min,
    '5min (20): '  + snapshot.candles5min,
    '',
    'Respond in STRICT JSON only:',
    '{"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 20 words","concerns":"max 15 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var timeoutId  = setTimeout(function() { controller.abort(); }, 8000);
    var res;
    try {
      res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.CEREBRAS_API_KEY },
        body: JSON.stringify({ model: 'llama3.1-8b', max_tokens: 120, temperature: 0.05, messages: [{ role: 'user', content: prompt }] }),
      });
    } finally { clearTimeout(timeoutId); }
    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };
    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: 'EMPTY_RESPONSE' };
    text = text.replace(/```json|```/g, '').trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: 'PARSE_ERROR', raw: text.slice(0, 100) };
    var parsed   = JSON.parse(jsonMatch[0]);
    var validSig = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSig    = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!validSig.includes(aiSig)) aiSig = 'NO_TRADE';
    var aiConf   = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return { status: 'OK', signal: aiSig, confidence: aiConf, reason: parsed.reason || null, concerns: parsed.concerns || null, model: 'cerebras/llama3.1-8b', mode: 'OTC' };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

async function buildMultiTimeframeSignalOTC(candleData, pair, session, exotic, env) {

export { callCerebrasValidationOTC };

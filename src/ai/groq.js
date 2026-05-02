export async function callGroqValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.GROQ_API_KEY) return { status: 'NO_KEY' };

  const snap = indicatorSnapshot;
  const prompt = [
    'Expert binary options analyst. Analyze ' + pair + ' (' + assetType + ').',
    'Engine says: ' + engineSignal.direction + ' @ ' + engineSignal.confidence + ' confidence.',
    'Alignment: ' + engineSignal.alignment + ' | HTF: ' + (engineSignal.higherTFTrend || 'N/A'),
    '',
    'Indicators:',
    'EMA: ' + snap.emaAlignment + ' | RSI: ' + snap.rsi,
    'MACD hist: ' + snap.macdHist + ' | ADX: ' + snap.adx,
    'Stoch K/D: ' + snap.stochK + '/' + snap.stochD,
    'BB %B: ' + snap.bbPercentB + ' BW: ' + snap.bbBandwidth,
    'Williams: ' + snap.williamsR + ' | CCI: ' + snap.cci,
    'Patterns: ' + (snap.patterns.length ? snap.patterns.join(',') : 'NONE'),
    'RSI div: ' + snap.rsiDiv + ' | S/R: ' + snap.srContext,
    'Structure 1min: ' + snap.structure1min,
    'Structure 5min: ' + snap.structure5min,
    '',
    'Candles 1min: ' + snap.candles1min,
    'Candles 5min: ' + snap.candles5min,
    '',
    'Respond ONLY in JSON: {"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 15 words","concerns":"max 10 words or null"}',
  ].join('\n');

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 6000);
    let res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.GROQ_API_KEY },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 100, temperature: 0.05, messages: [{ role: 'user', content: prompt }] }),
      });
    } finally { clearTimeout(tid); }

    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };

    const data = await res.json();
    let text = (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: 'EMPTY_RESPONSE' };
    text = text.replace(/```json|```/g, '').trim();
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return { status: 'PARSE_ERROR' };

    const parsed = JSON.parse(jm[0]);
    const valid  = ['BUY', 'SELL', 'NO_TRADE'];
    const aiSig  = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    const aiConf = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;

    return {
      status: 'OK',
      signal: valid.includes(aiSig) ? aiSig : 'NO_TRADE',
      confidence: aiConf,
      reason: parsed.reason || null,
      concerns: parsed.concerns || null,
      model: 'groq/llama-3.1-8b-instant',
    };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

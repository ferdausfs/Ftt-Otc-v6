// ============================================================
// GROQ AI VALIDATION (v6.8.0 — Dual AI)
// Runs in parallel with Cerebras — both must agree for +8 boost
// Set GROQ_API_KEY secret in Cloudflare dashboard
// ============================================================
// Second AI validator — parallel with Cerebras
// Model: llama-3.1-8b-instant (fast, free tier available)
// ============================================

async function callGroqValidation(pair, assetType, engineSignal, indicatorSnapshot, env) {
  if (!env.GROQ_API_KEY) return { status: 'NO_KEY' };

  var prompt = [
    'Expert binary options analyst. Analyze ' + pair + ' (' + assetType + ').',
    'Engine says: ' + engineSignal.direction + ' @ ' + engineSignal.confidence + ' confidence.',
    'Alignment: ' + engineSignal.alignment + ' | HTF: ' + (engineSignal.higherTFTrend || 'N/A'),
    '',
    'Indicators:',
    'EMA: ' + indicatorSnapshot.emaAlignment + ' | RSI: ' + indicatorSnapshot.rsi,
    'MACD hist: ' + indicatorSnapshot.macdHist + ' | ADX: ' + indicatorSnapshot.adx,
    'Stoch K/D: ' + indicatorSnapshot.stochK + '/' + indicatorSnapshot.stochD,
    'BB %B: ' + indicatorSnapshot.bbPercentB + ' BW: ' + indicatorSnapshot.bbBandwidth,
    'Williams: ' + indicatorSnapshot.williamsR + ' | CCI: ' + indicatorSnapshot.cci,
    'Patterns: ' + (indicatorSnapshot.patterns.length ? indicatorSnapshot.patterns.join(',') : 'NONE'),
    'RSI div: ' + indicatorSnapshot.rsiDiv + ' | S/R: ' + indicatorSnapshot.srContext,
    'Structure 1min: ' + indicatorSnapshot.structure1min,
    'Structure 5min: ' + indicatorSnapshot.structure5min,
    '',
    'Candles 1min: ' + indicatorSnapshot.candles1min,
    'Candles 5min: ' + indicatorSnapshot.candles5min,
    '',
    'Respond ONLY in JSON: {"signal":"BUY"|"SELL"|"NO_TRADE","confidence":0-100,"reason":"max 15 words","concerns":"max 10 words or null"}',
  ].join('\n');

  try {
    var controller = new AbortController();
    var tid = setTimeout(function() { controller.abort(); }, 6000);
    var res;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + env.GROQ_API_KEY,
        },
        body: JSON.stringify({
          model:       'llama-3.1-8b-instant',
          max_tokens:  100,
          temperature: 0.05,
          messages:    [{ role: 'user', content: prompt }],
        }),
      });
    } finally { clearTimeout(tid); }

    if (!res.ok) return { status: 'API_ERROR', httpStatus: res.status };

    var data = await res.json();
    var text = (data.choices && data.choices[0] && data.choices[0].message)
      ? data.choices[0].message.content.trim() : null;
    if (!text) return { status: 'EMPTY_RESPONSE' };
    text = text.replace(/```json|```/g, '').trim();
    var jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return { status: 'PARSE_ERROR' };
    var parsed  = JSON.parse(jm[0]);
    var valid   = ['BUY', 'SELL', 'NO_TRADE'];
    var aiSig   = typeof parsed.signal === 'string' ? parsed.signal.toUpperCase() : 'NO_TRADE';
    if (!valid.includes(aiSig)) aiSig = 'NO_TRADE';
    var aiConf  = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(parsed.confidence))) : 50;
    return { status: 'OK', signal: aiSig, confidence: aiConf, reason: parsed.reason || null, concerns: parsed.concerns || null, model: 'groq/llama-3.1-8b-instant' };
  } catch(e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT' };
    return { status: 'ERROR', message: e.message };
  }
}

// Dual AI result combiner
// Cerebras + Groq দুটোর result মিলিয়ে final AI verdict দেয়
function combineDualAIResults(cerebras, groq, engineDirection) {
  var result = { cerebras: cerebras, groq: groq, combined: null, combinedAgreed: null };

  var cOk = cerebras && cerebras.status === 'OK';
  var gOk = groq     && groq.status     === 'OK';

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

  // Both OK — combine
  if (cerebras.signal === groq.signal) {
    // Both agree — average confidence, stronger signal
    var avgConf = Math.round((cerebras.confidence + groq.confidence) / 2);
    result.combined = {
      status:     'OK',
      signal:     cerebras.signal,
      confidence: avgConf,
      reason:     cerebras.reason || groq.reason,
      concerns:   cerebras.concerns || groq.concerns,
      agreement:  'BOTH_AGREE',
      model:      'dual (Cerebras + Groq)',
    };
  } else {
    // Disagree — conservative: use NO_TRADE or lower confidence one
    var lowerConf = Math.min(cerebras.confidence, groq.confidence);
    result.combined = {
      status:     'OK',
      signal:     'NO_TRADE',
      confidence: lowerConf,
      reason:     'Cerebras=' + cerebras.signal + ' vs Groq=' + groq.signal + ' — AIs disagree',
      concerns:   'Conflicting AI signals — skip trade',
      agreement:  'AIs_DISAGREE',
      model:      'dual (Cerebras + Groq)',
    };
  }

  result.combinedAgreed = result.combined.signal === engineDirection;
  return result;
}

// ============================================
// [v6.8.0] P5 — CAMARILLA PIVOT POINTS
// Regular pivot এর পাশাপাশি Camarilla levels

export { callGroqValidation, combineDualAIResults };

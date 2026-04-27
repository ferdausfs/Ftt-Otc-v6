// ============================================================
// OTC TIMEFRAME ANALYSIS & SIGNAL BUILDER
// Mean-reversion focused — HTF block disabled for OTC
// Confidence cap 88%, floor 60%
// ============================================================
import { OTC_CATEGORY_WEIGHTS, OTC_SCORE_THRESHOLD, OTC_MIN_CONFLUENCE, OTC_CONFIDENCE_FLOOR, OTC_CONFIDENCE_CAP, OTC_DURATION_CONFIG } from '../config/trading.js';
import { analyzeOTCPatterns } from './patterns.js';
import { calculateCamarillaPivots, scoreCamarillaLevels } from '../analysis/camarilla.js';

function analyzeTimeframeOTC(indicators, candles, timeframe) {
  var result = analyzeTimeframe(indicators, candles, timeframe, ASSET_TYPE.FOREX, null, 'RANGING');
  // rangingWeights = base weights used in analyzeTimeframe('RANGING') — used to reverse-scale scores
  var rangingWeights = { trend: 0.8, momentum: 1.8, macd: 0.8, stochastic: 1.8, bands: 1.4, adx: 0.8, patterns: 1.3, divergence: 1.8, pivots: 1.2, volume: 0.5, sr: 2.2, camarilla: 0.84 };
  // camarilla base = sr_weight(2.2) * 0.6 * volMult(~0.64 avg) ≈ 0.84
  var otcW = OTC_CATEGORY_WEIGHTS;
  var newUpScore = 0; var newDownScore = 0;
  // [v6.8.0] camarilla included — OTC respects round S/R levels strongly
  var cats = ['trend','momentum','macd','stochastic','bands','adx','patterns','divergence','pivots','volume','sr','camarilla'];

  for (var ci = 0; ci < cats.length; ci++) {
    var cat = cats[ci];
    var catData = result.categoryScores[cat];
    if (!catData) continue;
    var rW  = rangingWeights[cat] || 1.0;
    var otW = otcW[cat] !== undefined ? otcW[cat] : 0;
    if (rW > 0) {
      var rawUp   = (catData.up   || 0) / rW;
      var rawDown = (catData.down || 0) / rW;
      newUpScore   += rawUp   * otW;
      newDownScore += rawDown * otW;
      result.categoryScores[cat] = Object.assign({}, catData, { up: r2(rawUp * otW), down: r2(rawDown * otW), otcWeight: otW });
    }
  }

  var scoreDiff  = Math.abs(newUpScore - newDownScore);
  var upCatCount = 0; var downCatCount = 0;
  for (var ci2 = 0; ci2 < cats.length; ci2++) {
    var catD = result.categoryScores[cats[ci2]];
    if (!catD) continue;
    if ((catD.up || 0) > (catD.down || 0) && Math.abs((catD.up || 0) - (catD.down || 0)) >= CONFIG.MIN_CATEGORY_SCORE) upCatCount++;
    else if ((catD.down || 0) > (catD.up || 0) && Math.abs((catD.down || 0) - (catD.up || 0)) >= CONFIG.MIN_CATEGORY_SCORE) downCatCount++;
  }

  var confluence = Math.max(upCatCount, downCatCount);
  var direction;
  if (newUpScore >= OTC_SCORE_THRESHOLD && newUpScore > newDownScore && upCatCount >= OTC_MIN_CONFLUENCE) direction = 'BUY';
  else if (newDownScore >= OTC_SCORE_THRESHOLD && newDownScore > newUpScore && downCatCount >= OTC_MIN_CONFLUENCE) direction = 'SELL';
  else if (scoreDiff >= 3.0 && confluence >= 3) direction = newUpScore > newDownScore ? 'BUY' : 'SELL';
  else direction = 'NO_TRADE';

  result.direction  = direction;
  result.score      = { up: r2(newUpScore), down: r2(newDownScore), diff: r2(scoreDiff) };
  result.confluence = confluence;
  result.confluenceDetail = { bullish: upCatCount, bearish: downCatCount, total: 11 };
  result.otcWeighted = true;
  return result;
}

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
  const now       = new Date();

export { calculateOTCCandleDuration, analyzeTimeframeOTC };

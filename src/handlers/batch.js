// ============================================================
// BATCH SIGNAL ENDPOINT (v6.2)
// GET /api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD
// Max BATCH_MAX_PAIRS pairs per request (parallel fetch, see config/trading.js)
// ============================================================
import { CONFIG } from '../config/trading.js';
import { sanitizePair } from '../utils/pair.js';
import { jsonResponse } from '../utils/response.js';
import { detectCorrelationConflicts } from '../analysis/quality.js';

// ============================================
// [v6.2] BATCH HANDLER
// /api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD
// Runs up to BATCH_MAX_PAIRS in parallel
// ============================================

async function handleBatch(url, env, ctx) {
  const rawPairs = url.searchParams.get('pairs') || '';
  const pairList = rawPairs
    .split(',')
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0 });

  if (pairList.length === 0) {
    return jsonResponse({
      error: true,
      message: 'No pairs provided. Use ?pairs=EUR/USD,GBP/JPY,BTC/USD',
      example: '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD',
    }, 400);
  }

  const validPairs = [];
  const invalidPairs = [];
  for (var i = 0; i < pairList.length; i++) {
    var clean = sanitizePair(pairList[i]);
    if (clean) validPairs.push(clean);
    else invalidPairs.push(pairList[i]);
  }

  const capped = validPairs.slice(0, CONFIG.BATCH_MAX_PAIRS);

  // Run all signals in parallel
  const promises = capped.map(function (pair) {
    return handleSignalRaw(pair, env, ctx).then(function (signal) {
      return { pair: pair, signal: signal };
    }).catch(function (e) {
      return { pair: pair, error: e.message };
    });
  });

  const results = await Promise.all(promises);

  const summary = {};
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    summary[r.pair] = r.signal || { error: r.error };
  }

  // [v6.8.0] P3: Correlation analysis across batch results
  var pairDirections = {};
  for (var cr = 0; cr < results.length; cr++) {
    var rr = results[cr];
    if (rr.signal && rr.signal.signal) {
      pairDirections[rr.pair] = rr.signal.signal.finalSignal || 'NO_TRADE';
    }
  }
  var correlationAnalysis = detectCorrelationConflicts(pairDirections);

  return jsonResponse({
    batch: true,
    requestedPairs: pairList.length,
    processedPairs: capped.length,
    cappedAt: CONFIG.BATCH_MAX_PAIRS,
    invalidPairs: invalidPairs,
    skippedPairs: validPairs.slice(CONFIG.BATCH_MAX_PAIRS),
    correlationAnalysis: correlationAnalysis,
    results: summary,
    timestamp: new Date().toISOString(),
  });
}

// ============================================
// SIGNAL HANDLER
// ============================================

export { handleBatch };

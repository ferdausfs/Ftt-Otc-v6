// ============================================================
// SIGNAL QUALITY FILTERS (v6.8.0)
// Candle quality multiplier, session weights, correlation filter
// ============================================================
import { SESSION_PAIR_WEIGHTS, CORRELATION_GROUPS, NEGATIVE_CORRELATIONS } from '../config/trading.js';

// ============================================
// [v6.8.0] P1 — CANDLE QUALITY FILTER
// Body strength বিশ্লেষণ করে signal weight adjust করে
// Strong body = বেশি weight, Doji/wick heavy = কম weight
// ============================================

function getCandleQualityMultiplier(candles) {
  if (!candles || candles.length < 3) return 1.0;

  var last  = candles[candles.length - 1];
  var prev1 = candles[candles.length - 2];
  var prev2 = candles[candles.length - 3];

  function bodyRatio(c) {
    var body  = Math.abs(c.close - c.open);
    var range = (c.high - c.low) || 0.00001;
    return body / range;
  }

  function wickRatio(c) {
    var body      = Math.abs(c.close - c.open);
    var range     = (c.high - c.low) || 0.00001;
    var upperWick = c.high - Math.max(c.open, c.close);
    var lowerWick = Math.min(c.open, c.close) - c.low;
    var totalWick = upperWick + lowerWick;
    return range > 0 ? totalWick / range : 0;
  }

  var br0 = bodyRatio(last);
  var br1 = bodyRatio(prev1);
  var wr0 = wickRatio(last);

  // Strong body last 2 candles — high quality
  if (br0 >= 0.65 && br1 >= 0.55) return 1.15;

  // Good body, low wick
  if (br0 >= 0.55 && wr0 <= 0.35) return 1.08;

  // Moderate
  if (br0 >= 0.40) return 1.0;

  // Doji or wick-heavy — reduce quality
  if (br0 < 0.15) return 0.75; // Doji
  if (wr0 >= 0.70) return 0.82; // Wick dominant

  return 0.92;
}

// ============================================
// [v6.8.0] P2 — SESSION-SPECIFIC WEIGHT MULTIPLIER
// Pair এর currency আর current session দেখে weight adjust করে
// ============================================

function getSessionWeightMultiplier(pair, session) {
  if (!pair || !session) return 1.0;

  var parts = pair.replace('-OTC', '').split('/');
  var base  = parts[0] || '';
  var quote = parts[1] || '';

  // Active session — single or overlap
  var activeSession = session.overlap !== 'NONE' ? session.overlap : (session.sessions[0] || 'UNKNOWN');

  // Check base currency weight
  var baseWeights  = SESSION_PAIR_WEIGHTS[base]  || {};
  var quoteWeights = SESSION_PAIR_WEIGHTS[quote] || {};

  var baseW  = baseWeights[activeSession]  || 1.0;
  var quoteW = quoteWeights[activeSession] || 1.0;

  // Average of both currencies — if either is active, boost
  var mult = Math.max(baseW, quoteW);

  // Cap between 0.7 and 1.4
  return Math.max(0.7, Math.min(1.4, mult));
}

// ============================================
// [v6.8.0] P3 — CORRELATION FILTER
// Batch signal এ correlated pairs detect করে
// Same direction correlated = ok
// Opposite direction correlated = warning + confidence penalty
// ============================================

function detectCorrelationConflicts(pairSignals) {
  // pairSignals = { 'EUR/USD': 'BUY', 'GBP/USD': 'SELL', ... }
  var conflicts = [];
  var warnings  = [];

  // Check positive correlation groups
  for (var gi = 0; gi < CORRELATION_GROUPS.length; gi++) {
    var group = CORRELATION_GROUPS[gi];
    var groupSignals = [];
    for (var pi = 0; pi < group.length; pi++) {
      var p = group[pi];
      if (pairSignals[p] && pairSignals[p] !== 'NO_TRADE') {
        groupSignals.push({ pair: p, dir: pairSignals[p] });
      }
    }
    if (groupSignals.length >= 2) {
      var dirs = groupSignals.map(function(s) { return s.dir; });
      var hasBuy  = dirs.indexOf('BUY')  !== -1;
      var hasSell = dirs.indexOf('SELL') !== -1;
      if (hasBuy && hasSell) {
        conflicts.push({
          type:    'POSITIVE_CORRELATION_CONFLICT',
          group:   group,
          signals: groupSignals,
          message: 'Correlated pairs disagree — signal reliability reduced',
        });
      }
    }
  }

  // Check negative correlations — here opposite is EXPECTED, same is warning
  for (var ni = 0; ni < NEGATIVE_CORRELATIONS.length; ni++) {
    var negPair = NEGATIVE_CORRELATIONS[ni];
    var s1 = pairSignals[negPair[0]];
    var s2 = pairSignals[negPair[1]];
    if (s1 && s2 && s1 !== 'NO_TRADE' && s2 !== 'NO_TRADE') {
      if (s1 === s2) {
        warnings.push({
          type:    'NEGATIVE_CORRELATION_SAME_DIR',
          pairs:   negPair,
          signals: [s1, s2],
          message: negPair[0] + ' and ' + negPair[1] + ' both ' + s1 + ' — unusual (negative correlation)',
        });
      }
    }
  }

  return { conflicts: conflicts, warnings: warnings, hasConflict: conflicts.length > 0 };
}

// ============================================
// [v6.8.0] P4 — GROQ AI VALIDATION

export { getCandleQualityMultiplier, getSessionWeightMultiplier, detectCorrelationConflicts };

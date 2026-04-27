// ============================================================
// CAMARILLA PIVOT POINTS (v6.8.0)
// H1-H4 / L1-L4 levels — OTC weight 1.5
// ============================================================
function calculateCamarillaPivots(candles) {
  if (!candles || candles.length < 2) return null;

  var lb  = Math.min(20, candles.length - 1);
  var sc  = candles.slice(-lb - 1, -1);
  var sh  = -Infinity; var sl = Infinity; var scl = sc[sc.length - 1].close;

  for (var i = 0; i < sc.length; i++) {
    if (sc[i].high > sh) sh = sc[i].high;
    if (sc[i].low  < sl) sl = sc[i].low;
  }

  var rng = sh - sl;

  return {
    h4: scl + rng * 1.1 / 2,
    h3: scl + rng * 1.1 / 4,
    h2: scl + rng * 1.1 / 6,
    h1: scl + rng * 1.1 / 12,
    l1: scl - rng * 1.1 / 12,
    l2: scl - rng * 1.1 / 6,
    l3: scl - rng * 1.1 / 4,
    l4: scl - rng * 1.1 / 2,
    close: scl,
  };
}

// Camarilla level থেকে signal score দেয়
function scoreCamarillaLevels(camPivots, lastClose, atr) {
  if (!camPivots || !lastClose || !atr || atr <= 0) return { up: 0, down: 0, level: 'NONE' };

  var thresh = atr * 0.4;
  var up = 0; var down = 0; var level = 'NONE';

  // Near L3/L4 = strong BUY (support bounce)
  if (Math.abs(lastClose - camPivots.l4) < thresh) { up += 1.8; level = 'L4_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l3) < thresh) { up += 1.3; level = 'L3_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l2) < thresh) { up += 0.7; level = 'L2_SUPPORT'; }
  else if (Math.abs(lastClose - camPivots.l1) < thresh) { up += 0.4; level = 'L1_SUPPORT'; }

  // Near H3/H4 = strong SELL (resistance bounce)
  if (Math.abs(lastClose - camPivots.h4) < thresh) { down += 1.8; level = 'H4_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h3) < thresh) { down += 1.3; level = 'H3_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h2) < thresh) { down += 0.7; level = 'H2_RESISTANCE'; }
  else if (Math.abs(lastClose - camPivots.h1) < thresh) { down += 0.4; level = 'H1_RESISTANCE'; }

  return { up: up, down: down, level: level };
}

// ============================================
// OTC FUNCTIONS (v6.7.0)

export { calculateCamarillaPivots, scoreCamarillaLevels };

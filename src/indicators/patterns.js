export function detectCandlestickPatterns(candles) {
  const patterns = [];
  if (!candles || candles.length < 3) return patterns;
  const n = candles.length;
  const c0 = candles[n-1]; const c1 = candles[n-2]; const c2 = candles[n-3];
  const b0 = c0.close - c0.open; const b1 = c1.close - c1.open; const b2 = c2.close - c2.open;
  const ab0 = Math.abs(b0); const ab1 = Math.abs(b1);
  const r0 = (c0.high - c0.low) || 0.00001; const r1 = (c1.high - c1.low) || 0.00001;
  const bp0 = ab0 / r0; const bp1 = ab1 / r1;
  const uw0 = c0.high - Math.max(c0.open, c0.close);
  const lw0 = Math.min(c0.open, c0.close) - c0.low;

  if (b1 < 0 && b0 > 0 && c0.open <= c1.close && c0.close >= c1.open && ab0 > ab1)
    patterns.push({ name:'BULLISH_ENGULFING', direction:'BUY', strength:2.0 });
  if (b1 > 0 && b0 < 0 && c0.open >= c1.close && c0.close <= c1.open && ab0 > ab1)
    patterns.push({ name:'BEARISH_ENGULFING', direction:'SELL', strength:2.0 });
  if (bp0 < 0.35 && lw0 > ab0 * 2 && uw0 < ab0 * 0.5)
    patterns.push({ name:'HAMMER', direction:'BUY', strength:1.5 });
  if (bp0 < 0.35 && uw0 > ab0 * 2 && lw0 < ab0 * 0.5)
    patterns.push({ name:'SHOOTING_STAR', direction:'SELL', strength:1.5 });
  if (bp0 < 0.1)
    patterns.push({ name:'DOJI', direction:'NEUTRAL', strength:0.5 });
  if (lw0 > r0 * 0.6 && uw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name:'PIN_BAR_BULLISH', direction:'BUY', strength:1.8 });
  if (uw0 > r0 * 0.6 && lw0 < r0 * 0.15 && bp0 < 0.3)
    patterns.push({ name:'PIN_BAR_BEARISH', direction:'SELL', strength:1.8 });

  const r2v = (c2.high - c2.low) || 0.00001;
  if (b2 < 0 && Math.abs(b2)/r2v > 0.5 && bp1 < 0.2 && b0 > 0 && bp0 > 0.5 && c0.close > (c2.open+c2.close)/2)
    patterns.push({ name:'MORNING_STAR', direction:'BUY', strength:2.5 });
  if (b2 > 0 && Math.abs(b2)/r2v > 0.5 && bp1 < 0.2 && b0 < 0 && bp0 > 0.5 && c0.close < (c2.open+c2.close)/2)
    patterns.push({ name:'EVENING_STAR', direction:'SELL', strength:2.5 });
  if (b2 > 0 && b1 > 0 && b0 > 0 && c1.close > c2.close && c0.close > c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name:'THREE_WHITE_SOLDIERS', direction:'BUY', strength:2.0 });
  if (b2 < 0 && b1 < 0 && b0 < 0 && c1.close < c2.close && c0.close < c1.close && bp0 > 0.5 && bp1 > 0.5)
    patterns.push({ name:'THREE_BLACK_CROWS', direction:'SELL', strength:2.0 });

  return patterns;
}

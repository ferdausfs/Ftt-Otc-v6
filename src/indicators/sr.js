export function detectSRLevels(candles, atr) {
  if (!candles || candles.length < 10) return { supports: [], resistances: [] };
  const n = candles.length;
  const lookback = 3;
  const clusterDist = atr !== null ? atr * 0.6 : candles[n - 1].close * 0.002;
  const lastClose = candles[n - 1].close;
  const rawHighs = []; const rawLows = [];

  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true; let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) rawHighs.push(candles[i].high);
    if (isLow)  rawLows.push(candles[i].low);
  }

  function cluster(levels) {
    if (!levels.length) return [];
    levels.sort((a, b) => a - b);
    const groups = [[levels[0]]];
    for (let i = 1; i < levels.length; i++) {
      const last = groups[groups.length - 1];
      const avg  = last.reduce((s, v) => s + v, 0) / last.length;
      if (Math.abs(levels[i] - avg) <= clusterDist) last.push(levels[i]);
      else groups.push([levels[i]]);
    }
    return groups
      .map(g => ({ price: g.reduce((s, v) => s + v, 0) / g.length, strength: g.length }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);
  }

  const resistances = cluster(rawHighs).filter(r => r.price > lastClose);
  const supports    = cluster(rawLows).filter(s  => s.price < lastClose);
  return { supports, resistances, clusterDist };
}

export function detectFVG(candles) {
  if (!candles || candles.length < 3) return { bullish:[], bearish:[], active:null };
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  const scanBack  = Math.min(30, n - 1);
  const bullishFVGs = []; const bearishFVGs = [];

  for (let i = n - 1; i >= 2 && i >= n - 1 - scanBack; i--) {
    const c0 = candles[i - 2]; const c2 = candles[i];
    const age = n - 1 - i;
    if (c2.low > c0.high) {
      const top = c2.low; const bottom = c0.high;
      const midpoint = (top + bottom) / 2;
      if (!(lastClose < bottom)) bullishFVGs.push({ top, bottom, midpoint, age });
    }
    if (c2.high < c0.low) {
      const top = c0.low; const bottom = c2.high;
      const midpoint = (top + bottom) / 2;
      if (!(lastClose > top)) bearishFVGs.push({ top, bottom, midpoint, age });
    }
  }

  bullishFVGs.sort((a, b) => a.age - b.age);
  bearishFVGs.sort((a, b) => a.age - b.age);

  let active = null;
  for (const bf of bullishFVGs) {
    if (lastClose >= bf.bottom && lastClose <= bf.top) { active = { type:'BULLISH', fvg:bf }; break; }
  }
  if (!active) {
    for (const sf of bearishFVGs) {
      if (lastClose >= sf.bottom && lastClose <= sf.top) { active = { type:'BEARISH', fvg:sf }; break; }
    }
  }

  return {
    bullish: bullishFVGs, bearish: bearishFVGs, active,
    nearestBullish: bullishFVGs.length ? bullishFVGs[0] : null,
    nearestBearish: bearishFVGs.length ? bearishFVGs[0] : null,
  };
}

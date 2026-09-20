#!/usr/bin/env node
/** Debug probe #2: inspect events around the stale cursor in the mocked series. */
const TF_MS = 15 * 60 * 1000;
const BOUNDARY = Math.floor(Date.now() / TF_MS) * TF_MS - TF_MS;

function genCandles(symbol, n) {
  let s = 17;
  for (const ch of symbol) s = (s * 131 + ch.charCodeAt(0)) & 0x7fffffff;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const rows = [];
  let price = symbol.includes('BTC') ? 80000 : symbol.includes('ETH') ? 2500 : 100;
  for (let i = 0; i < n; i++) {
    const t = BOUNDARY - (n - 1 - i) * TF_MS;
    // deterministic flip inside the last 4 bars: 2-bar rise (pins pos=+1)
    // then 2-bar crash (SELL cross on a close newer than any stale cursor)
    const force = i === n - 4 || i === n - 3 ? 0.006 : i >= n - 2 ? -0.006 : 0;
    const drift = (rnd() - 0.5) * 0.004 + force;
    const o = price;
    price = price * (1 + drift);
    rows.push({
      datetime: new Date(t).toISOString().slice(0, 19).replace('T', ' '),
      open: o, high: Math.max(o, price) * 1.001, low: Math.min(o, price) * 0.999, close: price, volume: 123,
    });
  }
  return rows.reverse();   // newest first (TwelveData order)
}

const raw = genCandles('BTC/USD', 300);
// engine order = oldest first (fetchCandles reverses the TD response)
const candles = raw.slice().reverse().map(c => ({
  t: new Date(String(c.datetime).replace(' ', 'T') + 'Z').getTime(),
  o: c.open, h: c.high, l: c.low, c: c.close,
}));
console.log('engine candles:', candles.length, 'first:', new Date(candles[0].t).toISOString(), 'last:', new Date(candles[candles.length - 1].t).toISOString());

const { INDICATORS } = await import('../src/strategy/registry.mjs');
const stale = Date.now() - 40 * 60 * 1000;
console.log('cursor(40min stale):', new Date(stale).toISOString(), '-> pending window = closeT > cursor');
for (const indr of INDICATORS) {
  const series = indr.compute(candles, { enabled: true, kernel: 'Laplace', bandwidth: 14, a: 1, c: 10 }, { tfMs: TF_MS });
  const evs = (series.events || []).slice(-8);
  console.log(indr.id, 'last events:');
  for (const e of evs) {
    const pend = e.closeT > stale ? 'PENDING' : 'old';
    console.log('   ', e.type, new Date(e.closeT).toISOString(), pend);
  }
}

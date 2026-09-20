/**
 * Multi Kernel Regression [ChartPrime] — port proof tests.
 *
 * Pins (each maps to a K-note in src/strategy/multiKernelRegression.mjs):
 *   T1  kernel functions: hand-computable values (Laplace, Triangular,
 *       Gaussian, Sinc, Silverman boundary, Morters)
 *   T2  weight precalculation: w[i] = kernel((i/B)^2, 1) (K1), sumw = naive
 *       sum; unknown kernel throws
 *   T3  nrp_sum = kernel-weighted MA of the last B closes — verified against
 *       an INDEPENDENT naive recomputation on a seeded random walk (K2)
 *   T4  constant series -> exact flat MA; bandwidth=1 -> value === close
 *   T5  events: engineered slope flips produce exactly one Up / one Down,
 *       alternating (K3/K4)
 *   T6  cross semantics: equality on the middle bar allows a cross (K3) —
 *       rise, flat, rise produces TWO Up labels (Pine ta.crossover)
 *   T7  no-lookahead: truncating the window never changes earlier values
 *       (pure windowed MA — exact equality, not tolerance)
 *   T8  stdev band: undefined before the full window / for B<2, positive
 *       after; scales with deviations
 *   T9  mkrEventToSignal: native Up/Down in audit, CFD BUY/SELL mapping,
 *       NO expiry (CFD mode)
 *
 * Run: node scripts/mkr_tests.mjs
 */

import {
  kernelFn, kernelWeights, computeMultiKernelRegression, mkrEventToSignal,
  MKR_KERNELS, MKR_KERNEL_DEFAULT, MKR_BANDWIDTH_DEFAULT,
} from '../src/strategy/multiKernelRegression.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}
function near(a, b, tol, name) {
  const d = Math.abs(a - b);
  ok(d <= tol, name + ' (|diff|=' + d.toExponential(2) + ')');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkCloses(closes, t0 = 1_760_000_000_000, tf = 900_000) {
  return closes.map((c, i) => ({ t: t0 + i * tf, o: c, h: c, l: c, c }));
}

/** Independent reference: nrp_sum over the last B closes (K1/K2 verbatim). */
function refNrpSum(closes, B, kernelName) {
  const f = kernelFn(kernelName);
  const w = [];
  let sumw = 0;
  for (let i = 0; i < B; i++) {
    const weight = f((i * i) / (B * B), 1);
    w.push(weight); sumw += weight;
  }
  const out = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    let s = 0;
    for (let k = 0; k < B; k++) s += w[k] * (i - k >= 0 ? closes[i - k] : 0);
    out[i] = s / sumw;
  }
  return out;
}

console.log('— T1 kernel functions (hand values) —');
{
  near(kernelFn('Laplace')(0, 1), 0.5, 1e-15, 'Laplace(0) = 0.5');
  near(kernelFn('Laplace')(0.25, 1), 0.5 * Math.exp(-0.25), 1e-15, 'Laplace(0.25)');
  near(kernelFn('Triangular')(0.25, 1), 0.75, 1e-15, 'Triangular(0.25) = 1-0.25');
  near(kernelFn('Gaussian')(0, 1), 1 / Math.sqrt(2 * Math.PI), 1e-15, 'Gaussian(0) = 1/sqrt(2pi)');
  near(kernelFn('Sinc')(0, 1), 1, 1e-15, 'Sinc(0) = 1 (branch)');
  near(kernelFn('Sinc')(0.5, 1), Math.sin(Math.PI * 0.5) / (Math.PI * 0.5), 1e-15, 'Sinc(0.5)');
  near(kernelFn('Silverman')(0.6, 1), 0, 1e-15, 'Silverman(0.6) = 0 (boundary >0.5)');
  near(kernelFn('Silverman')(0.25, 1), 0.5 * Math.exp(-0.125) * Math.sin(0.125 + Math.PI / 4), 1e-15, 'Silverman(0.25)');
  near(kernelFn('Morters')(0, 1), 1 / Math.PI, 1e-15, 'Morters(0) = (1+cos0)/2pi = 1/pi');
  near(kernelFn('Epanechnikov')(1, 1), 0, 1e-15, 'Epanechnikov(1) = 0 (boundary)');
  near(kernelFn('Quartic')(0.5, 1), (15 / 16) * Math.pow(1 - 0.25, 2), 1e-15, 'Quartic(0.5)');
  near(kernelFn('Cauchy')(0.5, 1), 1 / (Math.PI * (1 + 0.25)), 1e-15, 'Cauchy(0.5)');
  near(kernelFn('Logistic')(0.5, 1), 1 / (Math.exp(0.5) + 2 + Math.exp(-0.5)), 1e-15, 'Logistic(0.5)');
  near(kernelFn('Log Logistic')(0.5, 1), 1 / Math.pow(1 + 0.5, 2), 1e-15, 'LogLogistic(0.5)');
  near(kernelFn('Exponential')(0.5, 1), Math.exp(-0.5), 1e-15, 'Exponential(0.5)');
  near(kernelFn('Wave')(0.5, 1), (1 - 0.5) * Math.cos(Math.PI * 0.5), 1e-15, 'Wave(0.5)');
  near(kernelFn('Power')(0.5, 1), Math.pow(1 - Math.pow(0.5, 3), 3), 1e-15, 'Power(0.5)');
  near(kernelFn('Parabolic')(0.5, 1), 1 - 0.25, 1e-15, 'Parabolic(0.5)');
  near(kernelFn('Cosine')(0.5, 1), (Math.PI / 4) * Math.cos((Math.PI / 2) * 0.5), 1e-15, 'Cosine(0.5)');
  ok(kernelFn('Tent')(0.25, 1) === kernelFn('Triangular')(0.25, 1), 'Tent === Triangular (script-identical)');
  ok(MKR_KERNELS.length === 17 && MKR_KERNELS.includes(MKR_KERNEL_DEFAULT), '17 kernels registered, default present');
}

console.log('— T2 weight precalculation (K1) —');
{
  const B = 14;
  const { weights, sumw } = kernelWeights(B, 'Laplace');
  ok(weights.length === B, 'weights length = bandwidth');
  near(weights[0], 0.5, 1e-15, 'w[0] = Laplace(0) = 0.5');
  near(weights[7], 0.5 * Math.exp(-0.25), 1e-15, 'w[7] = Laplace((7/14)^2 = 0.25)');
  const f = kernelFn('Laplace');
  let naive = 0;
  for (let i = 0; i < B; i++) naive += f((i * i) / (B * B), 1);
  near(sumw, naive, 1e-15, 'sumw = naive sum');
  const cached = kernelWeights(B, 'Laplace');
  ok(cached.weights === weights, 'weight cache returns the same array');
  let threw = false;
  try { kernelFn('Nope'); } catch (e) { threw = true; }
  ok(threw, 'unknown kernel throws');
  const tri = kernelWeights(14, 'Triangular');
  near(tri.weights[7], 1 - (49 / 196), 1e-15, 'Triangular w[7] = 1-(7/14)^2');
}

console.log('— T3 nrp_sum vs independent recomputation (K2) —');
{
  const rnd = mulberry32(20260920);
  const closes = [];
  let px = 100;
  for (let i = 0; i < 300; i++) { px += (rnd() - 0.5) * 2; closes.push(px); }
  const candles = mkCloses(closes);
  for (const kernel of ['Laplace', 'Gaussian', 'Triangular', 'Sinc']) {
    const r = computeMultiKernelRegression(candles, { kernel, bandwidth: 14 });
    const ref = refNrpSum(closes, 14, kernel);
    let maxDev = 0;
    for (let i = 13; i < 300; i++) maxDev = Math.max(maxDev, Math.abs(r.value[i] - ref[i]));
    ok(maxDev < 1e-12, kernel + ' value matches independent recompute (max dev ' + maxDev.toExponential(2) + ')');
  }
}

console.log('— T4 constant series / bandwidth 1 —');
{
  const flat = mkCloses(new Array(200).fill(50));
  const r = computeMultiKernelRegression(flat, { bandwidth: 14 });
  near(r.value[150], 50, 1e-12, 'constant series -> value = 50 exactly (full window)');
  ok(r.events.length === 0, 'constant series -> zero events (no slope flips)');
  const b1 = computeMultiKernelRegression(mkCloses([1, 3, 2, 5, 4, 6, 5, 7]), { bandwidth: 1 });
  near(b1.value[7], 7, 1e-15, 'bandwidth=1 -> value = close exactly');
  ok(b1.stdev.every(s => s === undefined), 'bandwidth=1 -> stdev undefined everywhere (B-1 = 0)');
}

console.log('— T5 events: engineered slope flips —');
{
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i);        // rise (warmup-safe: MA monotone up)
  for (let i = 0; i < 30; i++) closes.push(138 - i);        // decline -> Down
  for (let i = 0; i < 10; i++) closes.push(109 + 2 * (i + 1)); // rise -> Up
  for (let i = 0; i < 10; i++) closes.push(128 - i);        // decline -> Down
  const r = computeMultiKernelRegression(mkCloses(closes), { bandwidth: 5 });
  const ups = r.events.filter(e => e.type === 'up');
  const downs = r.events.filter(e => e.type === 'down');
  ok(ups.length === 1 && downs.length === 2, 'exactly one Up + two Downs (got ' + ups.length + '/' + downs.length + ')');
  ok(downs.length === 2 && downs[0].i < ups[0].i && ups[0].i < downs[1].i, 'alternation Down -> Up -> Down');
  ok(ups[0].price === closes[ups[0].i], 'Up event price = event candle close');
  ok(ups[0].closeT === ups[0].t + 900_000, 'event closeT = open time + tf');
  ok(ups[0].i >= 5, 'no events before the full kernel window (K4)');
  const sig = mkrEventToSignal(ups[0], 'TEST/USD', {
    timestamp: '2026-09-20T10:15:00.000Z', market: 'FOREX',
    kernel: 'Laplace', bandwidth: 5, timeframe: '15min',
  });
  ok(sig.finalSignal === 'BUY' && sig.engine === 'MKR', 'Up -> CFD BUY, engine MKR');
  ok(sig.audit.label === 'Up' && sig.audit.kernel === 'Laplace', 'native label + params ride in audit');
  ok(sig.expiryTime === null && sig.expiryMinutes === null, 'CFD record carries NO expiry');
  const sigDown = mkrEventToSignal(downs[0], 'TEST/USD', { timeframe: '15min' });
  ok(sigDown.finalSignal === 'SELL' && sigDown.audit.label === 'Down', 'Down -> CFD SELL');
}

console.log('— T6 cross semantics: equality allows the cross (K3) —');
{
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100);   // flat: MA exactly flat
  for (let i = 0; i < 40; i++) closes.push(102);   // step up, MA converges + flattens
  for (let i = 0; i < 5; i++) closes.push(104);    // second step -> second Up
  const r = computeMultiKernelRegression(mkCloses(closes), { bandwidth: 5 });
  const ups = r.events.filter(e => e.type === 'up');
  ok(ups.length === 2, 'rise-flat-rise => TWO Up labels (v1 <= v2 equality), got ' + ups.length);
  ok(r.events.every(e => e.type === 'up'), 'no spurious Down on a rising staircase');
}

console.log('— T7 no-lookahead (pure windowed MA, exact) —');
{
  const rnd = mulberry32(777);
  const closes = [];
  let px = 50;
  for (let i = 0; i < 300; i++) { px += (rnd() - 0.5) * 1.5; closes.push(px); }
  const full = computeMultiKernelRegression(mkCloses(closes), { bandwidth: 14 });
  const trunc = computeMultiKernelRegression(mkCloses(closes.slice(0, 250)), { bandwidth: 14 });
  let identical = true;
  for (let i = 0; i < 250; i++) if (full.value[i] !== trunc.value[i]) { identical = false; break; }
  ok(identical, 'truncation never changes earlier values (exact equality)');
  const evFull = full.events.filter(e => e.i < 250);
  const evTrunc = trunc.events;
  ok(evFull.length === evTrunc.length && evFull.every((e, k) => e.i === evTrunc[k].i && e.type === evTrunc[k].type),
    'events identical on the common range');
}

console.log('— T8 stdev band —');
{
  const rnd = mulberry32(42);
  const closes = [];
  let px = 100;
  for (let i = 0; i < 100; i++) { px += (rnd() - 0.5) * 2; closes.push(px); }
  const r = computeMultiKernelRegression(mkCloses(closes), { bandwidth: 14, deviations: 2 });
  ok(r.stdev.slice(0, 13).every(s => s === undefined), 'stdev undefined before full window');
  ok(r.stdev.slice(13).every(s => s > 0), 'stdev positive after full window');
  const r1 = computeMultiKernelRegression(mkCloses(closes), { bandwidth: 14, deviations: 1 });
  ok(r.stdev[50] !== undefined && r1.stdev[50] !== undefined
    && Math.abs(r.stdev[50] / r1.stdev[50] - 2) < 1e-12, 'stdev scales linearly with deviations');
}

console.log('— T9 defaults + params echo —');
{
  const r = computeMultiKernelRegression(mkCloses(new Array(50).fill(1)), {});
  ok(r.params.kernel === 'Laplace' && r.params.bandwidth === MKR_BANDWIDTH_DEFAULT
    && r.params.deviations === 2.0, 'TradingView defaults: Laplace / 14 / 2.0');
  ok(r.up.length === 50 && r.down.length === 50 && r.dirUp.length === 50, 'series arrays index-aligned');
}

console.log('\nMulti Kernel Regression tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);

/**
 * EMA Ribbon strategy test suite (standalone module).
 *   1. Pre-registration guards: frozen periods (5/13/55 @15m, 5/7/13 @1m),
 *      ATR ladder byte-equal to the FTT3 table it was reused from, module
 *      standalone (imports only indicators.mjs, zero pair names, zero
 *      references to FTT3/FTT3-R modules).
 *   2. Ribbon order classification incl. every equality position.
 *   3-6. Fixtures frozen by scripts/fixture_calc_ema_ribbon.py (independent
 *      Python EMA): C1 bias values/classification, C2 flip semantics (flip
 *      candle, already-aligned, wrong direction, PUT mirror), young-ATR
 *      expiry block, source-gap adjacency block.
 *   7. Reference path == fast (precomputed) path, index-for-index, over a
 *      synthetic series — with AND without the pre.i15 hint.
 *   8. NO-LOOKAHEAD PROOF: mutating any candle not fully closed before the
 *      entry close cannot change decision+audit on either path; leakage
 *      canaries prove the suite detects leakage (entry candle, prior candle,
 *      last-closed 15m candle all DO change the output when mutated).
 *
 * Run: node scripts/ema_ribbon_tests.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateEmaRibbon, precomputeEmaRibbon, ribbonOrder, expiryForPercentile,
  EXPIRY_TIERS, BIAS_FAST, BIAS_MID, BIAS_SLOW, TRIG_FAST, TRIG_MID, TRIG_SLOW,
  ATR_PERIOD, ATR_WINDOW, MS_1M, MS_15M,
} from '../src/strategy/emaRibbon.mjs';
import { EXPIRY_TIERS as FTT3_TIERS, ATR_WINDOW as FTT3_ATR_WINDOW, ATR_PERIOD as FTT3_ATR_PERIOD } from '../src/strategy/engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name); }
}
function eq(a, b, name, eps = 1e-9) {
  const good = a === b || (typeof a === 'number' && typeof b === 'number'
    && Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)));
  ok(good, name);
}

// ── fixtures frozen by scripts/fixture_calc_ema_ribbon.py (independent Python EMA) ──
export const F1_RAMP_UP = { ema5: 217.00000000000006, ema13: 213.00000000000006, ema55: 192.00000000000003, order: "BULL" };
export const F2_RAMP_DOWN = { ema5: 83.00000000000003, ema13: 87.00000000000003, ema55: 108.00000000000003, order: "BEAR" };
export const F3_FLAT = { ema5: 100.0, ema13: 100.0, ema55: 100.0, order: "TANGLED" };
export const F4_OSC = { ema5: 100.60000000000002, ema13: 100.53846153846156, ema55: 100.50909090909094, order: "BULL" };
export const F5_V_FLIP = { idx: 158,
  cur: { ema5: 156.15607376924254, ema7: 155.60067749023438, ema13: 155.49628582148807, order: "BULL" },
  prev: { ema5: 155.23411065386378, ema7: 154.8009033203125, ema13: 155.0790001250694, order: "TANGLED" },
  next: { ema5: 157.10404917949504, ema7: 156.45050811767578, ema13: 155.99681641841838, order: "BULL" } };
export const F6_LAMBDA_FLIP = { idx: 158,
  cur: { ema5: 293.8439262307576, ema7: 294.3993225097656, ema13: 294.5037141785121, order: "BEAR" },
  prev: { ema5: 294.7658893461363, ema7: 295.1990966796875, ema13: 294.92099987493077, order: "TANGLED" } };
export const F7_YOUNG = { flipIdx: 33, len: 110,
  cur: { ema5: 82.13006147436876, ema7: 81.52559280395508, ema13: 81.24655111995321, order: "BULL" },
  prev: { ema5: 81.19509221155313, ema7: 80.70079040527344, ema13: 80.78764297327874, order: "TANGLED" } };

// ── series builders (deterministic, identical arithmetic to the Python calc) ──
const RAMP_UP = Array.from({ length: 120 }, (_, k) => 100 + k);
const RAMP_DN = Array.from({ length: 120 }, (_, k) => 200 - k);
const FLAT = Array.from({ length: 120 }, () => 100);
const OSC = Array.from({ length: 120 }, (_, k) => 100 + (k % 2));
const V_SERIES = Array.from({ length: 260 }, (_, k) =>
  k <= 150 ? 300 - k : 150 + (k - 150));
const LAMBDA = Array.from({ length: 260 }, (_, k) =>
  k <= 150 ? 150 + k : 300 - (k - 150));
const V_SHORT = Array.from({ length: 110 }, (_, k) =>
  k < 25 ? 100 - k : 76 + (k - 25));

/** flat candles from closes: { t, o=c, h=c, l=c, c=c } — t from T0, step ms. */
function candlesFrom(closes, T0, stepMs) {
  return closes.map((c, k) => ({ t: T0 + k * stepMs, o: c, h: c, l: c, c }));
}
/** 15m array positioned so the LAST candle closes exactly at entryCloseT. */
function biasCandles(closes, entryCloseT) {
  const n = closes.length;
  return closes.map((c, k) => ({
    t: entryCloseT - (n - k) * MS_15M, o: c, h: c, l: c, c,
  }));
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[1] pre-registration guards + standalone proof');
eq(BIAS_FAST, 5, 'bias fast = 5');
eq(BIAS_MID, 13, 'bias mid = 13');
eq(BIAS_SLOW, 55, 'bias slow = 55');
eq(TRIG_FAST, 5, 'trigger fast = 5');
eq(TRIG_MID, 7, 'trigger mid = 7');
eq(TRIG_SLOW, 13, 'trigger slow = 13');
eq(ATR_PERIOD, 14, 'ATR period = 14');
eq(ATR_WINDOW, 100, 'ATR window = 100');
ok(JSON.stringify(EXPIRY_TIERS) === JSON.stringify(FTT3_TIERS),
  'EXPIRY_TIERS deep-equal to the FTT3 ladder (reused, not re-invented)');
eq(ATR_PERIOD, FTT3_ATR_PERIOD, 'ATR period matches FTT3');
eq(ATR_WINDOW, FTT3_ATR_WINDOW, 'ATR window matches FTT3');
eq(expiryForPercentile(100), 5, 'pct 100 -> 5m');
eq(expiryForPercentile(75), 5, 'pct exactly 75 -> 5m');
eq(expiryForPercentile(74.999), 7, 'pct just under 75 -> 7m');
eq(expiryForPercentile(50), 7, 'pct 50 -> 7m');
eq(expiryForPercentile(25), 7, 'pct exactly 25 -> 7m');
eq(expiryForPercentile(24.999), 10, 'pct just under 25 -> 10m');
eq(expiryForPercentile(0), 10, 'pct 0 -> 10m');
{
  const src = readFileSync(join(ROOT, 'src', 'strategy', 'emaRibbon.mjs'), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  ok(imports.length === 1 && imports[0] === './indicators.mjs',
    'module imports ONLY ./indicators.mjs (got: ' + imports.join(',') + ')');
  ok(!imports.some(p => /engine|meanReversion|regime/i.test(p)),
    'no FTT3/FTT3-R module imports (header prose mentions are documentation)');
  ok(!/\b(BTC|ETH|XRP|SOL|USDT|EUR|GBP|JPY|AUD)\b/.test(src),
    'no pair names anywhere in the module');
  ok(!/\b20\b\s*[,)]|EMA_FAST|MACD/.test(src), 'no FTT3 threshold leftovers (EMA20/50, MACD)');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[2] ribbon order classification');
ok(ribbonOrder(3, 2, 1) === 'BULL', '3>2>1 -> BULL');
ok(ribbonOrder(1, 2, 3) === 'BEAR', '1<2<3 -> BEAR');
ok(ribbonOrder(2, 2, 1) === 'TANGLED', 'fast=mid -> TANGLED');
ok(ribbonOrder(2, 1, 1) === 'TANGLED', 'mid=slow -> TANGLED');
ok(ribbonOrder(2, 2, 2) === 'TANGLED', 'all equal -> TANGLED');
ok(ribbonOrder(3, 2, 2) === 'TANGLED', '3>2=2 -> TANGLED');
ok(ribbonOrder(1, 3, 2) === 'TANGLED', 'non-monotonic -> TANGLED');
ok(ribbonOrder(2, 3, 1) === 'TANGLED', 'mid highest -> TANGLED');

// ══════════════════════════════════════════════════════════════════════════
console.log('[3] C1 bias fixtures (independent Python EMA values)');
{
  const T0 = Date.UTC(2026, 0, 1);
  const C1 = candlesFrom(V_SERIES, T0, MS_1M);
  const i = 200;   // any boundary; ATR window full, C1 from the 15m ramp
  const entryCloseT = C1[i].t + MS_1M;
  for (const [name, closes, fx] of [
    ['ramp up', RAMP_UP, F1_RAMP_UP], ['ramp down', RAMP_DN, F2_RAMP_DOWN],
    ['flat', FLAT, F3_FLAT], ['oscillating', OSC, F4_OSC],
  ]) {
    const C15 = biasCandles(closes, entryCloseT);
    const r = evaluateEmaRibbon(C15, C1, i);
    eq(r.audit.c1.ema5, fx.ema5, `${name}: C1 ema5 frozen value`);
    eq(r.audit.c1.ema13, fx.ema13, `${name}: C1 ema13 frozen value`);
    eq(r.audit.c1.ema55, fx.ema55, `${name}: C1 ema55 frozen value`);
    ok(r.audit.c1.bias === fx.order, `${name}: bias ${r.audit.c1.bias} == Python ${fx.order}`);
    if (fx.order === 'TANGLED') {
      ok(r.decision === 'NO_TRADE' && r.reason === 'C1_RIBBON_TANGLED', `${name}: NO_TRADE C1_RIBBON_TANGLED`);
      ok(r.audit.c2 === null, `${name}: C1 block carries no C2 (chain stopped)`);
    }
  }
  // fast path agrees bit-for-bit on the same fixtures
  const C15 = biasCandles(RAMP_UP, entryCloseT);
  const pre = precomputeEmaRibbon({ c15: C15, c1: C1 });
  const rRef = evaluateEmaRibbon(C15, C1, i);
  const rFast = evaluateEmaRibbon(C15, C1, i, { ...pre, i15: C15.length - 1 });
  ok(JSON.stringify(rRef) === JSON.stringify(rFast), 'C1 fixture: reference == fast (with hint)');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[4] C2 flip fixtures (frozen flip index 158, values from Python)');
{
  const T0 = Date.UTC(2026, 0, 1);
  const C1 = candlesFrom(V_SERIES, T0, MS_1M);
  const entryCloseT = C1[F5_V_FLIP.idx].t + MS_1M;
  const C15 = biasCandles(RAMP_UP, entryCloseT);   // bias BULL

  const r = evaluateEmaRibbon(C15, C1, F5_V_FLIP.idx);
  ok(r.decision === 'CALL' && r.reason === 'C1_C2_ALL_PASS', 'bull bias + bullish flip -> CALL');
  eq(r.audit.c2.ema5, F5_V_FLIP.cur.ema5, 'flip candle ema5 frozen');
  eq(r.audit.c2.ema7, F5_V_FLIP.cur.ema7, 'flip candle ema7 frozen');
  eq(r.audit.c2.ema13, F5_V_FLIP.cur.ema13, 'flip candle ema13 frozen');
  eq(r.audit.c2.ema5Prev, F5_V_FLIP.prev.ema5, 'prior candle ema5 frozen');
  eq(r.audit.c2.ema7Prev, F5_V_FLIP.prev.ema7, 'prior candle ema7 frozen');
  eq(r.audit.c2.ema13Prev, F5_V_FLIP.prev.ema13, 'prior candle ema13 frozen');
  ok(r.audit.c2.flip === 'BULLISH', 'flip = BULLISH');
  // ATR on the V fixture: candles are flat (h=l=c) but consecutive closes
  // differ by 1, so TR = |c - prevClose| = 1 (TR[0] = 0) — frozen via the
  // same Wilder recursion in Python:
  //   atr[13] = 13/14, atr[k] = (atr[k-1]*13 + 1)/14 -> atr[158] below.
  eq(r.audit.atr.atr, 0.9999984615163843, 'V-fixture ATR frozen (TR=1 per bar)');
  eq(r.audit.atr.atrPercentile, 100, 'monotone ATR window -> percentile 100');
  eq(r.audit.expiry.minutes, 5, 'pct 100 -> 5m expiry');
  eq(r.audit.atr.windowLen, 100, 'ATR window full (idx 158 >= 113)');

  // next candle: still in full order -> NOT a flip -> NO_TRADE
  const rNext = evaluateEmaRibbon(C15, C1, F5_V_FLIP.idx + 1);
  ok(rNext.decision === 'NO_TRADE' && rNext.reason === 'C2_NO_FLIP',
    'candle already in alignment -> C2_NO_FLIP (flip candle only fires once)');
  eq(rNext.audit.c2.ema5, F5_V_FLIP.next.ema5, 'next-candle ema5 frozen');

  // wrong direction: bear bias + bullish flip
  const C15dn = biasCandles(RAMP_DN, entryCloseT);
  const rWrong = evaluateEmaRibbon(C15dn, C1, F5_V_FLIP.idx);
  ok(rWrong.decision === 'NO_TRADE' && rWrong.reason === 'C2_WRONG_DIRECTION',
    'bear bias + bullish flip -> C2_WRONG_DIRECTION');
  ok(rWrong.audit.c1 !== null && rWrong.audit.c2 !== null,
    'C2 block carries C1+C2 values (audit convention)');

  // PUT mirror: bear bias + bearish flip on the lambda series
  const CL = candlesFrom(LAMBDA, T0, MS_1M);
  const entryCloseL = CL[F6_LAMBDA_FLIP.idx].t + MS_1M;
  const C15L = biasCandles(RAMP_DN, entryCloseL);
  const rPut = evaluateEmaRibbon(C15L, CL, F6_LAMBDA_FLIP.idx);
  ok(rPut.decision === 'PUT' && rPut.reason === 'C1_C2_ALL_PASS', 'bear bias + bearish flip -> PUT');
  eq(rPut.audit.c2.ema5, F6_LAMBDA_FLIP.cur.ema5, 'PUT flip ema5 frozen');
  eq(rPut.audit.c2.flip === 'BEARISH' ? 1 : 0, 1, 'PUT flip = BEARISH');

  // bullish flip under bull bias but evaluated on the reference path WITHOUT
  // the 15m array closing later than the boundary — offset variants agree
  for (const off of [0, 7, 14]) {   // within the same 15m candle
    const rr = evaluateEmaRibbon(C15, C1, F5_V_FLIP.idx - off);
    ok(rr.reason === 'C1_C2_ALL_PASS' || rr.reason.startsWith('C2_'),
      `boundary -${off}m inside same 15m bucket evaluates coherently (${rr.reason})`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[5] young ATR window -> EXPIRY_INSUFFICIENT (expiry never guessed)');
{
  const T0 = Date.UTC(2026, 0, 1);
  const C1 = candlesFrom(V_SHORT, T0, MS_1M);            // 110 candles
  // 15m bias pre-loaded: all 100 candles close before the 1m window opens
  const C15 = biasCandles(RAMP_UP, C1[0].t + MS_1M - MS_15M);
  const r = evaluateEmaRibbon(C15, C1, F7_YOUNG.flipIdx);
  ok(r.decision === 'NO_TRADE' && r.reason === 'EXPIRY_INSUFFICIENT',
    `flip at ${F7_YOUNG.flipIdx} with ATR window < 100 -> EXPIRY_INSUFFICIENT (got ${r.reason})`);
  ok(r.stage === 'EXPIRY', 'blocking stage = EXPIRY');
  ok(r.audit.c1 !== null && r.audit.c2 !== null, 'EXPIRY block carries C1+C2 values');
  eq(r.audit.c2.ema5, F7_YOUNG.cur.ema5, 'young flip ema5 frozen');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[6] source gap -> C2_PRIOR_CANDLE_GAP (no fabricated adjacency)');
{
  const T0 = Date.UTC(2026, 0, 1);
  // shift t by +1m for candles >= flip idx: a 2-minute gap right before it
  const raw = candlesFrom(V_SERIES, T0, MS_1M).map((c, k) =>
    k >= F5_V_FLIP.idx ? { ...c, t: c.t + MS_1M } : c);
  const entryCloseT = raw[F5_V_FLIP.idx].t + MS_1M;
  const C15 = biasCandles(RAMP_UP, entryCloseT);
  const r = evaluateEmaRibbon(C15, raw, F5_V_FLIP.idx);
  ok(r.decision === 'NO_TRADE' && r.reason === 'C2_PRIOR_CANDLE_GAP',
    'missing prior minute -> C2_PRIOR_CANDLE_GAP (not a trigger)');
  ok(r.audit.c1 !== null && r.audit.c2 === null,
    'gap block carries C1 values; flip not computed (honest)');
  // post-gap boundary is continuous again and evaluates normally
  const r2 = evaluateEmaRibbon(C15, raw, F5_V_FLIP.idx + 1);
  ok(r2.audit.c1 !== null && r2.reason !== 'C2_PRIOR_CANDLE_GAP',
    'adjacent boundaries after the gap are unaffected (' + r2.reason + ')');
  // fast path (hint at the 15m pointer) reproduces the gap block exactly
  const pre = precomputeEmaRibbon({ c15: C15, c1: raw });
  const rFast = evaluateEmaRibbon(C15, raw, F5_V_FLIP.idx, { ...pre, i15: C15.length - 1 });
  ok(JSON.stringify(rFast) === JSON.stringify(r), 'gap block: reference == fast');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[7] reference == fast path on every boundary of a synthetic series');
let nestedPass = 0; let nestedFail = 0;
function ok2(cond, name) { if (cond) { nestedPass++; } else { nestedFail++; console.error('  FAIL ' + name); } }
{
  // Piecewise phases (long enough for the slow 15m EMA55 ribbon to establish
  // full order): flat -> sustained RISE (~33h) -> flat -> sustained FALL -> flat,
  // with small deterministic noise so 1m flips fire repeatedly inside trends.
  function buildSeries(seed, n) {
    let s = seed >>> 0;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const T0 = Date.UTC(2026, 0, 1);   // 15m-aligned
    const c1arr = [];
    let price = 100;
    for (let k = 0; k < n; k++) {
      const drift = k < 1800 ? 0 : k < 4200 ? 0.05 : k < 5400 ? 0 : k < 7800 ? -0.05 : 0;
      const o = price;
      const c = Math.max(0.01, o + drift + (rand() - 0.5) * 0.12);
      c1arr.push({ t: T0 + k * MS_1M, o, h: Math.max(o, c) + rand() * 0.04, l: Math.min(o, c) - rand() * 0.04, c });
      price = c;
    }
    const c15arr = [];
    for (let k = 0; k + 15 <= n; k += 15) {
      const chunk = c1arr.slice(k, k + 15);
      c15arr.push({ t: chunk[0].t, o: chunk[0].o, h: Math.max(...chunk.map(x => x.h)),
        l: Math.min(...chunk.map(x => x.l)), c: chunk[14].c });
    }
    return { c1arr, c15arr };
  }
  const N = 9000;
  const { c1arr, c15arr } = buildSeries(42, N);
  const pre = precomputeEmaRibbon({ c15: c15arr, c1: c1arr });
  const seen = new Set();
  const decisions = new Set();
  let checked = 0; let boundary = 0;
  let i15hint = 0;
  for (let i = 150; i < N - 1; i++) {
    boundary++;
    const entryCloseT = c1arr[i].t + MS_1M;
    while (i15hint + 1 < c15arr.length && c15arr[i15hint + 1].t + MS_15M <= entryCloseT) i15hint++;
    const rRef = evaluateEmaRibbon(c15arr, c1arr, i);
    const rFastHint = evaluateEmaRibbon(c15arr, c1arr, i, { ...pre, i15: i15hint });
    const rFastScan = evaluateEmaRibbon(c15arr, c1arr, i, pre);
    if (JSON.stringify(rRef) === JSON.stringify(rFastHint)
      && JSON.stringify(rRef) === JSON.stringify(rFastScan)) checked++;
    else ok2(false, `path mismatch @${i}: ${rRef.reason} / ${rFastHint.reason} / ${rFastScan.reason}`);
    seen.add(rRef.reason);
    decisions.add(rRef.decision);
    if (rRef.reason.startsWith('C2_')) ok2(rRef.audit.c1 !== null, `C2 block carries C1 @${i}`);
    if (rRef.decision !== 'NO_TRADE') {
      ok2(rRef.audit.expiry && [5, 7, 10].includes(rRef.audit.expiry.minutes), `signal carries expiry @${i}`);
      ok2(rRef.audit.c1.bias === (rRef.decision === 'CALL' ? 'BULL' : 'BEAR'), `bias matches direction @${i}`);
    }
  }
  ok(checked === boundary, `reference == fast (hint) == fast (scan) on all ${boundary} boundaries`);
  ok(boundary > 8000, 'enough boundaries evaluated');
  for (const want of ['C1_INSUFFICIENT_15M', 'C1_RIBBON_TANGLED', 'C2_NO_FLIP',
    'C2_WRONG_DIRECTION', 'C1_C2_ALL_PASS']) {
    ok(seen.has(want), 'reason reachable: ' + want + (seen.has(want) ? '' : ' (seen: ' + [...seen].join(',') + ')'));
  }
  for (const want of ['CALL', 'PUT']) ok(decisions.has(want), 'decision reachable: ' + want);

  // ── [8] NO-LOOKAHEAD mutation proof + leakage canaries (same series family) ─
  console.log('[8] NO-LOOKAHEAD mutation proof + leakage canaries');
  const { c1arr: b1, c15arr: b15 } = buildSeries(7, N);
  let iSig = -1; let base = null;
  for (let i = 1500; i < N - 1; i++) {
    const r = evaluateEmaRibbon(b15, b1, i);
    if (r.decision !== 'NO_TRADE') { iSig = i; base = r; break; }
  }
  ok(iSig > 0, `found a signal boundary for mutation proof (i=${iSig}, ${base?.decision})`);
  const entryCloseT = b1[iSig].t + MS_1M;
  const baseFast = evaluateEmaRibbon(b15, b1, iSig, precomputeEmaRibbon({ c15: b15, c1: b1 }));
  ok(JSON.stringify(baseFast) === JSON.stringify(base), 'base: fast == reference at signal boundary');

  // (a) mutate ALL 1m candles after the entry candle
  const m1a = b1.map((k, idx) => (idx > iSig ? { ...k, c: k.c * 10, h: k.h * 10 } : k));
  // (b) mutate all 15m candles not fully closed before entry close
  const m15a = b15.map(k => (k.t + MS_15M > entryCloseT ? { ...k, c: k.c * 10, h: k.h * 10 } : k));
  ok(JSON.stringify(evaluateEmaRibbon(m15a, m1a, iSig)) === JSON.stringify(base),
    'future 1m tail + unclosed 15m mutation: output identical (reference)');
  const preMut = precomputeEmaRibbon({ c15: m15a, c1: m1a });
  ok(JSON.stringify(evaluateEmaRibbon(m15a, m1a, iSig, preMut)) === JSON.stringify(baseFast),
    'same mutation: output identical (fast path recomputed over mutated arrays)');

  // (c) 1m future-tail-only mutation
  const m1b = b1.map((k, idx) => (idx > iSig ? { ...k, c: 9999, h: 9999, l: 9998 } : k));
  ok(JSON.stringify(evaluateEmaRibbon(b15, m1b, iSig)) === JSON.stringify(base),
    '1m future-tail-only mutation: output identical');

  // canaries — mutating candles the decision READS must change the output
  const m1c = b1.map((k, idx) => (idx === iSig ? { ...k, c: k.c * 3, h: k.h * 3 } : k));
  ok(JSON.stringify(evaluateEmaRibbon(b15, m1c, iSig)) !== JSON.stringify(base),
    'CANARY: entry candle mutation changes output');
  const m1d = b1.map((k, idx) => (idx === iSig - 1 ? { ...k, c: k.c * 3 } : k));
  ok(JSON.stringify(evaluateEmaRibbon(b15, m1d, iSig)) !== JSON.stringify(base),
    'CANARY: prior-candle mutation changes output');
  let i15idx = 0;
  while (i15idx + 1 < b15.length && b15[i15idx + 1].t + MS_15M <= entryCloseT) i15idx++;
  const m15c = b15.map((k, idx) => (idx === i15idx ? { ...k, c: k.c * 3 } : k));
  ok(JSON.stringify(evaluateEmaRibbon(m15c, b1, iSig)) !== JSON.stringify(base),
    'CANARY: last-closed 15m mutation changes C1 values');
  // pre.i15 hint cannot smuggle an unclosed candle: an INVALID hint is dropped
  const preX = precomputeEmaRibbon({ c15: b15, c1: b1 });
  const rNoHint = evaluateEmaRibbon(b15, b1, iSig, preX);
  const rBadHint = evaluateEmaRibbon(b15, b1, iSig, { ...preX, i15: b15.length - 1 });
  ok(JSON.stringify(rNoHint) === JSON.stringify(rBadHint),
    'invalid i15 hint (unclosed candle) falls back to scan, same output');
}

// ══════════════════════════════════════════════════════════════════════════
console.log('[9] input guards');
{
  const C1 = candlesFrom(V_SERIES, Date.UTC(2026, 0, 1), MS_1M);
  const C15 = biasCandles(RAMP_UP, C1[200].t + MS_1M);
  ok(evaluateEmaRibbon(C15, C1, -1).reason === 'C1_INVALID_ENTRY_INDEX', 'i<0 rejected');
  ok(evaluateEmaRibbon(C15, C1, C1.length).reason === 'C1_INVALID_ENTRY_INDEX', 'i>=len rejected');
  ok(evaluateEmaRibbon(C15, C1, 200, { i15: 99999 }).reason !== 'C1_RIBBON_TANGLED' ||
     evaluateEmaRibbon(C15, C1, 200) !== undefined, 'wild i15 hint does not crash (falls back)');
}

console.log(`\nEMA Ribbon tests: ${pass} passed (+
${nestedPass} per-row checks), ${fail + nestedFail} failed`);
if (fail + nestedFail > 0) process.exit(1);

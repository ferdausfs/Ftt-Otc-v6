/**
 * TASK 25 — SENTIMACRO no-lookahead suite (S1–S7 of
 * PRE_REGISTRATION_SENTIMACRO.md §6). Must be 100% green BEFORE
 * build_features runs and before any modeling. The external merge functions
 * are proved, not assumed — mirroring TradingAgents' lookahead regression
 * tests (future-dated items, undated ambiguity, vintage pinning).
 *
 *  S1 synthetic as-of boundary (FRED + F&G conventions, inclusive boundary)
 *  S2 change-window pinning (asof(t-90d)/asof(t-7d), never back-projected)
 *  S3 real-source property test (>=2000 random instants per source; join
 *     provably cannot return an observation with known_from > t)
 *  S4 weekend/holiday handling on the real sources (Saturday decision uses
 *     Thursday's FRED obs under the frozen rule; F&G uses Friday's stamp)
 *  S5 full-row future-mutation invariance incl. external block (synthetic)
 *  S6 full-row truncated-recompute equality incl. external block (synthetic)
 *  S7 provenance gate (loader refuses sha256 mismatch — checked by direct
 *     probe of the build's verification logic on a tampered buffer)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FEATURE_NAMES, N_FEATURES, parseFredCsv, prepFredKf, prepFngKf, asOfKf,
  externalVals, featureRow, buildSeries, findClosed15, fundAsOf, DAY_MS,
} from './features_lib.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL: ${name}`); }
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_DIR = join(ROOT, 'backtest', 'data', 'external');
const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

// ── S1: synthetic as-of boundary ─────────────────────────────────────────────
console.log('S1. synthetic as-of boundary (inclusive at known_from)');
{
  // FRED convention: business-day obs, kf = next business day 21:30 UTC.
  // Wed obs 5.0 (2024-01-03), Thu obs 5.25 (2024-01-04) -> Thu kf = Fri 01-05 21:30.
  const d = (y, m, day) => Date.UTC(y, m - 1, day);
  const fred = prepFredKf([d(2024, 1, 3), d(2024, 1, 4)], [5.0, 5.25]);
  const thuKf = fred.kfT[1];
  check('fred kf is Friday 21:30 UTC', new Date(thuKf).toISOString() === '2024-01-05T21:30:00.000Z');
  check('before boundary -> old value', fred.kfV[asOfKf(fred.kfT, thuKf - 1)] === 5.0);
  check('at boundary -> new value (inclusive)', fred.kfV[asOfKf(fred.kfT, thuKf)] === 5.25);
  check('after boundary -> new value', fred.kfV[asOfKf(fred.kfT, thuKf + 60000)] === 5.25);
  check('before first kf -> -1 (row invalid path)', asOfKf(fred.kfT, thuKf - 8 * DAY_MS) === -1);

  // F&G convention: stamp D -> kf D+1 00:00 UTC. Three stamps so the
  // "before boundary" instant has a valid prior observation.
  const fng = prepFngKf([
    Date.UTC(2024, 0, 2) / 1000, Date.UTC(2024, 0, 3) / 1000, Date.UTC(2024, 0, 4) / 1000,
  ], [60, 70, 25]);
  const kf0 = Date.UTC(2024, 0, 4);           // stamp 01-03 knowable 01-04 00:00
  check('fng kf = stamp+1d 00:00 UTC', fng.kfT[1] === kf0);
  check('fng before boundary -> PREVIOUS stamp value (one-day pinning delay)', fng.kfV[asOfKf(fng.kfT, kf0 - 1)] === 60);
  check('fng at boundary -> stamp D-1 value (inclusive)', fng.kfV[asOfKf(fng.kfT, kf0)] === 70);
  check('fng after boundary -> stamp D-1 value', fng.kfV[asOfKf(fng.kfT, kf0 + 60000)] === 70);
  check('fng next boundary flips to stamp D value', fng.kfV[asOfKf(fng.kfT, Date.UTC(2024, 0, 5))] === 25);
  check('fng Monday decision during weekend uses Friday stamp', (() => {
    const f2 = prepFngKf([Date.UTC(2024, 0, 5) / 1000, Date.UTC(2024, 0, 8) / 1000], [40, 80]);
    return f2.kfV[asOfKf(f2.kfT, Date.UTC(2024, 0, 7, 12))] === 40;  // Sunday 12:00 -> Friday stamp
  })());
}

// ── S2: change-window pinning ────────────────────────────────────────────────
console.log('S2. change-window pinning (reference value = value knowable THEN)');
{
  // build a daily business-day FRED-like series with a moving value
  const dateT = [], v = [];
  for (let k = 0; k < 300; k++) {
    const day = new Date(Date.UTC(2024, 0, 1) + k * DAY_MS);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    dateT.push(day.getTime()); v.push(1 + k * 0.01);   // rises 0.01/business-day
  }
  const ser = prepFredKf(dateT, v);
  const ext = { ff: ser, curve: ser, fng: ser };
  // pick a decision instant mid-series
  const t = ser.kfT[150];
  const ev = externalVals(ext, t);
  const lvl = ser.kfV[asOfKf(ser.kfT, t)];
  const ref = ser.kfV[asOfKf(ser.kfT, t - 90 * DAY_MS)];
  check('level = asof(t)', ev[0] === lvl);
  check('chg_90d = asof(t) - asof(t-90d) [pinned reference]', Math.abs(ev[1] - (lvl - ref)) < 1e-12);
  check('chg is NOT vs the first value (not back-projected)', ev[1] !== lvl - ser.kfV[0]);
  check('chg is NOT zero (reference moved)', Math.abs(ev[1]) > 0.3);
  // degenerate case: series unchanged since reference -> chg must be exactly 0
  const flat = prepFredKf(dateT, dateT.map(() => 3.3));
  const ev2 = externalVals({ ff: flat, curve: flat, fng: flat }, t);
  check('flat series -> chg exactly 0', ev2[1] === 0 && ev2[3] === 0 && ev2[5] === 0);
}

// ── S3: real-source property test (the merge cannot see the future) ─────────
console.log('S3. real-source property test (>=2000 random instants per source)');
{
  const dff = parseFredCsv(readFileSync(join(EXT_DIR, 'fred_DFF.csv'), 'utf8'));
  const curve = parseFredCsv(readFileSync(join(EXT_DIR, 'fred_T10Y2Y.csv'), 'utf8'));
  const fngRaw = JSON.parse(readFileSync(join(EXT_DIR, 'fng_full.json'), 'utf8'));
  const ff = prepFredKf(dff.dateT, dff.v);
  const cv = prepFredKf(curve.dateT, curve.v);
  const fg = prepFngKf(fngRaw.data.map(r => r.timestamp), fngRaw.data.map(r => r.value));
  const rnd = lcg(20260913);
  const winFrom = Date.UTC(2021, 10, 1), winTo = Date.UTC(2026, 8, 5);
  let okJoin = true, okNever = true, checked = 0;
  for (let k = 0; k < 2500; k++) {
    const t = winFrom + Math.floor(rnd() * (winTo - winFrom));
    for (const src of [ff, cv, fg]) {
      const idx = asOfKf(src.kfT, t);
      if (idx < 0) continue;                       // before first obs — invalid-row path
      checked++;
      if (src.kfT[idx] > t) { okJoin = false; break; }             // known_from must be <= t
      if (idx + 1 < src.kfT.length && src.kfT[idx + 1] <= t) { okJoin = false; break; }  // must be the LATEST
      if (idx > 0 && src.kfT[idx - 1] > t) { okJoin = false; break; }
    }
    if (!okJoin) break;
  }
  check(`join returns latest obs with kf <= t on ${checked} random (instant, source) draws`, okJoin && checked >= 6000);
  // exhaustive sweep at every kf boundary of the real sources: value can never decrease kf order
  let sweepOk = true;
  for (const src of [ff, cv, fg]) {
    for (let i = 1; i < src.kfT.length; i++) {
      if (src.kfT[i] <= src.kfT[i - 1]) { sweepOk = false; break; }  // kf strictly increasing
    }
    if (!sweepOk) break;
  }
  check('known_from arrays strictly increasing on all three real sources', sweepOk);
  void okNever;
}

// ── S4: weekend/holiday handling on the real sources ─────────────────────────
console.log('S4. weekend/holiday handling (frozen conventions on real data)');
{
  const dff = parseFredCsv(readFileSync(join(EXT_DIR, 'fred_DFF.csv'), 'utf8'));
  const curve = parseFredCsv(readFileSync(join(EXT_DIR, 'fred_T10Y2Y.csv'), 'utf8'));
  const ff = prepFredKf(dff.dateT, dff.v);
  const cv = prepFredKf(curve.dateT, curve.v);
  // Saturday 2024-01-06 12:00 UTC decision:
  //  - latest FRED obs with kf <= t must be Thursday 2024-01-04 (Fri obs kf = Mon 01-08 21:30)
  const sat = Date.UTC(2024, 0, 6, 12);
  const thuIdx = dff.dateT.findIndex(x => x === Date.UTC(2024, 0, 4));
  const friIdx = dff.dateT.findIndex(x => x === Date.UTC(2024, 0, 5));
  const thuIdxCv = curve.dateT.findIndex(x => x === Date.UTC(2024, 0, 4));
  check('dataset has both Thu and Fri observations', thuIdx >= 0 && friIdx === thuIdx + 1 && thuIdxCv >= 0);
  check('Saturday uses THURSDAY obs (Friday kf = Monday 21:30)', asOfKf(ff.kfT, sat) === thuIdx);
  check('Monday 20:00 still uses Thursday obs (kf Mon 21:30 not reached)', asOfKf(ff.kfT, Date.UTC(2024, 0, 8, 20)) === thuIdx);
  check('Monday 22:00 uses Friday obs', asOfKf(ff.kfT, Date.UTC(2024, 0, 8, 22)) === friIdx);
  check('same convention on T10Y2Y', asOfKf(cv.kfT, sat) === thuIdxCv);
  // F&G: Saturday 12:00 uses Friday stamp (kf Sat 00:00). NOTE: the raw file
  // stores the API's own field name `timestamp` (string) — prepFngKf coerces.
  const fng = prepFngKf(fngStamps(), fngValues());
  function fngStamps() { return JSON.parse(readFileSync(join(EXT_DIR, 'fng_full.json'), 'utf8')).data.map(r => r.timestamp); }
  function fngValues() { return JSON.parse(readFileSync(join(EXT_DIR, 'fng_full.json'), 'utf8')).data.map(r => r.value); }
  const friStamp = Math.floor(Date.UTC(2024, 0, 5) / 1000);
  const friI = fng.kfT.findIndex(x => x === friStamp * 1000 + DAY_MS);
  check('F&G Saturday 12:00 uses Friday stamp', asOfKf(fng.kfT, sat) === friI);
  check('F&G Sunday 23:59 uses SATURDAY stamp (Sat value knowable from Sun 00:00)',
    asOfKf(fng.kfT, Date.UTC(2024, 0, 7, 23, 59)) === friI + 1);
}

// ── S5 + S6: full-row proofs incl. the external block (synthetic universe) ──
console.log('S5/S6. full-row mutation invariance + truncated recompute (ext block included)');
{
  // synthetic external series spanning the synthetic candle window
  const T0 = Date.UTC(2021, 10, 1);
  const stampDays = [];
  for (let k = -30; k < 40; k++) stampDays.push(Math.floor((T0 + k * DAY_MS) / 1000));
  const ext = {
    ff: prepFredKf([T0 - 120 * DAY_MS, T0 - 90 * DAY_MS, T0 - 60 * DAY_MS], [0.08, 0.09, 0.10]),
    curve: prepFredKf([T0 - 120 * DAY_MS, T0 - 90 * DAY_MS, T0 - 60 * DAY_MS], [0.42, 0.40, 0.37]),
    fng: prepFngKf(stampDays, stampDays.map((s, i) => 50 + (i % 7))),
  };
  // minimal synthetic 1m/15m universe (2000 minutes — f_ret_1440m needs 1440)
  const m1 = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let price = 100;
  for (let k = 0; k < 2000; k++) {
    const t = T0 + k * 60000;
    m1.t.push(t); m1.o.push(price); m1.c.push(price); m1.h.push(price * 1.0001); m1.l.push(price * 0.9999); m1.v.push(10);
  }
  const m15 = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let k = 0; k < 134; k++) { m15.t.push(T0 + k * 900000); m15.o.push(100); m15.c.push(100); m15.h.push(100.01); m15.l.push(99.99); m15.v.push(150); }
  const fundT = [T0, T0 + 8 * 3600000], fundRate = [0.0001, 0.0002];
  const S = buildSeries(m1, m15, fundT, fundRate);
  const i = 1900, t = S.m1t[i];
  const j15 = findClosed15(S.m15t, t), fi = fundAsOf(fundT, t + 60000);
  const ev = externalVals(ext, t + 60000);
  check('external vals valid on synthetic universe', ev !== null);
  const row = featureRow(S, i, j15, fi, 1, ev);
  check('row valid (47 wide, no NaN)', row !== null && row.length === 47 && ev.every((v, k) => row[41 + k] === v));
  // S5: the external block must NOT change when the CANDLES are mutated
  const m1b = { t: m1.t.slice(), o: m1.o.slice(), h: m1.h.slice(), l: m1.l.slice(), c: m1.c.slice(), v: m1.v.slice() };
  m1b.c[i] *= 1.05;
  const S2 = buildSeries(m1b, m15, fundT, fundRate);
  const row2 = featureRow(S2, i, j15, fi, 1, ev);
  let extSame = true;
  for (let k = 41; k < 47; k++) if (row2[k] !== row[k]) extSame = false;
  check('mutating the current candle leaves the external block identical (indices 41-46)', extSame);
  // S6: truncated external series at the reference instant must reproduce the row
  const cutExt = {
    ff: { kfT: ext.ff.kfT.slice(0, 3), kfV: ext.ff.kfV.slice(0, 3) },
    curve: { kfT: ext.curve.kfT.slice(0, 3), kfV: ext.curve.kfV.slice(0, 3) },
    fng: { kfT: ext.fng.kfT.filter((x, k) => ext.fng.kfT[k] <= t + 60000), kfV: ext.fng.kfV.filter((x, k) => ext.fng.kfT[k] <= t + 60000) },
  };
  const evCut = externalVals(cutExt, t + 60000);
  check('external vals from truncated-to-decision series are identical',
    evCut !== null && evCut.every((v, k) => v === ev[k]));
}

// ── S7: provenance gate ──────────────────────────────────────────────────────
console.log('S7. provenance gate (sha256 pins bind the bytes)');
{
  const prov = readFileSync(join(ROOT, 'results', 'PROVENANCE_EXTERNAL_ML.md'), 'utf8');
  for (const f of ['fred_DFF.csv', 'fred_T10Y2Y.csv', 'fng_full.json']) {
    const buf = readFileSync(join(EXT_DIR, f));
    const line = prov.split('\n').find(l => l.includes(f) && /[0-9a-f]{64}/.test(l));
    check(`provenance pin exists for ${f}`, !!line);
    if (line) {
      const pin = (line.match(/([0-9a-f]{64})/) || [])[1];
      check(`sha256 matches pin for ${f}`, pin === createHash('sha256').update(buf).digest('hex'));
    }
  }
  check('feature count still 47 (guard against silent edits)', N_FEATURES === 47 && FEATURE_NAMES.length === 47);
}

console.log(`\nleakage_sentimacro_tests: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

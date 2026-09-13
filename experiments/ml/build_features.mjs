/**
 * TASK 24 + TASK 25 — ML dataset builder.
 * Reads the RAW fetched candles + funding (backtest/data/ml/) and the THREE
 * external regime sources (backtest/data/external/, sha256-verified against
 * results/PROVENANCE_EXTERNAL_ML.md — pre-reg S7), builds the frozen
 * 47-feature rows + 5/7/10m labels on the frozen window
 * [T0=2021-11-01T00:00Z, T1=2026-09-05T00:00Z), streams them to a compact
 * binary file per pair (float32 features, structured rows) + a meta JSON
 * with the full decision funnel. NO Test knowledge beyond timestamps from
 * split_dates.json — rows are just written with their timestamps; split
 * assignment happens at training time.
 *
 * Row layout (232 bytes, packed):
 *   ts:i64(ms) c_t:f64 l5:u8 l7:u8 l10:u8 pad:u8 cH5:f64 cH7:f64 cH10:f64 features:f32 x47
 * Labels: 0=down 1=up 2=tie 255=target candle missing (never fabricated).
 *
 * Fail-loud rules: missing 1m candles counted & reported; 15m context older
 * than 60m (the audited server-side 15m hole) -> row excluded, counted;
 * external as-of lookup missing (level or change reference) -> row excluded,
 * counted in funnel.extExcluded (expected ZERO — sources fetched from
 * 2021-07-01, window opens 2021-11-01); any non-finite feature aborts the
 * build (features_lib throws).
 *
 * Run: node experiments/ml/build_features.mjs --pair BTCUSDT
 */
import { readFileSync, writeFileSync, appendFileSync, rmSync, existsSync, createHash } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FEATURE_NAMES, N_FEATURES, buildSeries, findClosed15, labelAt, fundAsOf, featureRow,
         parseFredCsv, prepFredKf, prepFngKf, externalVals } from './features_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'backtest', 'data', 'ml');
const OUT = join(ROOT, 'backtest', 'data', 'ml_features');
const EXT_DIR = join(ROOT, 'backtest', 'data', 'external');
const PROV = join(ROOT, 'results', 'PROVENANCE_EXTERNAL_ML.md');

const T0 = Date.UTC(2021, 10, 1, 0, 0, 0);
const T1 = Date.UTC(2026, 8, 5, 0, 0, 0);
const GRID_MIN = Math.round((T1 - T0) / 60000);           // 2,547,360
const FRESH_15M_MS = 60 * 60000;                          // context must be <= 60m old
const HORIZONS = [5, 7, 10];

const pairArg = (() => { const i = process.argv.indexOf('--pair'); return i === -1 ? null : process.argv[i + 1]; })();
if (!pairArg) { console.error('usage: node build_features.mjs --pair BTCUSDT'); process.exit(1); }

// ── external regime series (Task 25) — sha256-gated load (pre-reg S7) ────────
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function loadExternal() {
  const prov = readFileSync(PROV, 'utf8');
  const need = (file) => {
    const p = join(EXT_DIR, file);
    const buf = readFileSync(p);
    const sha = sha256(buf);
    // provenance lists one 64-hex pin per file line; find the line mentioning the file
    const line = prov.split('\n').find(l => l.includes(file) && /[0-9a-f]{64}/.test(l));
    if (!line) throw new Error(`provenance: no sha256 pin found for ${file}`);
    const pin = (line.match(/([0-9a-f]{64})/) || [])[1];
    if (pin !== sha) throw new Error(`sha256 mismatch for ${file}: provenance ${pin} != actual ${sha}`);
    return buf;
  };
  const dff = parseFredCsv(need('fred_DFF.csv').toString('utf8'));
  const curve = parseFredCsv(need('fred_T10Y2Y.csv').toString('utf8'));
  const fngRaw = JSON.parse(need('fng_full.json').toString('utf8'));
  // raw file stores the API's own field name `timestamp` (string) — coerced in prepFngKf
  const fng = prepFngKf(fngRaw.data.map(r => r.timestamp), fngRaw.data.map(r => r.value));
  const ext = { ff: prepFredKf(dff.dateT, dff.v), curve: prepFredKf(curve.dateT, curve.v), fng };
  const span = (s) => `${new Date(s.kfT[0]).toISOString()}..${new Date(s.kfT[s.kfT.length - 1]).toISOString()}`;
  console.log(`external series verified+loaded: DFF ${ext.ff.kfT.length} obs (${span(ext.ff)}) | T10Y2Y ${ext.curve.kfT.length} (${span(ext.curve)}) | FNG ${ext.fng.kfT.length} (${span(ext.fng)})`);
  return ext;
}
const EXT = loadExternal();

// ── load + merge chunks (dedupe shared boundary candles by timestamp) ────────
function loadSeries(symbol, tf) {
  const files = ['2021tail', '2022tail', '2023tail', '2024tail', '2025tail', 'end']
    .map(c => join(DATA, `${symbol}_${tf}_${c}.json`));
  const seen = new Map();
  let firstReq = null, lastReq = null;
  for (const f of files) {
    const { meta, candles } = JSON.parse(readFileSync(f, 'utf8'));
    firstReq ??= meta.requestedFrom; lastReq = meta.requestedTo;
    for (const c of candles) if (!seen.has(c.t)) seen.set(c.t, c);
  }
  const arr = [...seen.values()].sort((a, b) => a.t - b.t);
  return {
    t: arr.map(c => c.t), o: arr.map(c => c.o), h: arr.map(c => c.h),
    l: arr.map(c => c.l), c: arr.map(c => c.c), v: arr.map(c => c.v),
    firstReq, lastReq, count: arr.length,
  };
}

console.log(`loading ${pairArg} ...`);
const m1 = loadSeries(pairArg, 'm1');
const m15 = loadSeries(pairArg, 'm15');
const fundRaw = JSON.parse(readFileSync(join(DATA, `${pairArg}_funding.json`), 'utf8'));
const fundT = fundRaw.records.map(r => r.t);
const fundRate = fundRaw.records.map(r => r.rate);
console.log(`  m1: ${m1.count} unique (${m1.firstReq} .. ${m1.lastReq}) | m15: ${m15.count} | funding: ${fundT.length}`);

// grid audit inside the frozen window (fail-loud accounting)
function gridAudit(ser, tf, stepMs) {
  let inWin = 0, holes = 0;
  let k = 0;
  while (k < ser.t.length && ser.t[k] < T0) k++;
  const firstInWin = k;
  for (; k < ser.t.length && ser.t[k] < T1; k++) {
    if (k > firstInWin && ser.t[k] - ser.t[k - 1] !== stepMs) holes += (ser.t[k] - ser.t[k - 1]) / stepMs - 1;
    inWin++;
  }
  return { inWin, holes };
}
const a1 = gridAudit(m1, 'm1', 60000);
const a15 = gridAudit(m15, 'm15', 900000);
console.log(`  grid in window: m1 ${a1.inWin}/${GRID_MIN} (holes ${a1.holes}) | m15 ${a15.inWin} (holes ${a15.holes})`);
if (a1.holes !== 0) console.log(`  WARNING: ${a1.holes} missing 1m candles — rows at those minutes will be absent (honest exclusion)`);

// ── build causal series ──────────────────────────────────────────────────────
console.log('building indicator series ...');
const S = buildSeries(m1, m15, fundT, fundRate);

// ── stream rows ──────────────────────────────────────────────────────────────
rmSync(join(OUT, `${pairArg}.bin`), { force: true });
writeFileSync(join(OUT, `${pairArg}.meta.json`), 'building', 'utf8'); // lock/marker
const ROW_BYTES = 8 + 8 + 3 + 1 + 24 + N_FEATURES * 4;   // 232 (47 features)
const BUF_ROWS = 65536;
const buf = Buffer.allocUnsafe(ROW_BYTES * BUF_ROWS);
let bufN = 0, totalRows = 0;
let flushed = 0;

function flush() {
  if (bufN === 0) return;
  appendFileSync(join(OUT, `${pairArg}.bin`), buf.subarray(0, bufN * ROW_BYTES));
  flushed += bufN; bufN = 0;
}

const funnel = {
  pair: pairArg,
  gridExpected: GRID_MIN, m1Present: a1.inWin, m1Missing: a1.holes,
  m15Present: a15.inWin, m15Missing: a15.holes,
  rowsWritten: 0, stale15m: 0, noClosed15m: 0, extExcluded: 0,
  externalSources: {
    dffObs: EXT.ff.kfT.length, curveObs: EXT.curve.kfT.length, fngObs: EXT.fng.kfT.length,
    pinning: 'FRED obs D -> next business day 21:30 UTC; FNG stamp D -> D+1 00:00 UTC (frozen pre-reg §3)',
  },
  perHorizon: {}, perSplit: {},
};

// split boundaries (timestamps only — no Test content is read)
const split = JSON.parse(readFileSync(join(ROOT, 'experiments', 'ml', 'split_dates.json'), 'utf8'));
const VAL_END = Date.parse(split.validation.end.replace('Z', '+00:00'));
const TRAIN_END = Date.parse(split.train.end.replace('Z', '+00:00'));
for (const H of HORIZONS) {
  funnel.perHorizon[H] = { decided: 0, ties: 0, missingTarget: 0 };
  funnel.perSplit[H] = { train: { decided: 0, ties: 0 }, validation: { decided: 0, ties: 0 }, test: { decided: 0, ties: 0 } };
}

const t0ms = Date.now();
let j15 = 0, fi = -1;
let startIdx = m1.t.findIndex(t => t >= T0);

// monotonic external as-of pointers: level instant (t+60000) and change
// reference instants (t+60000-90d, t+60000-7d) are all strictly increasing
// in t, so six binary searches per row collapse to six pointer advances.
function mkPtr(src) {
  return { kfT: src.kfT, kfV: src.kfV, lvl: -1, ref: -1, refMs: -Infinity };
}
const pFF = mkPtr(EXT.ff), pCV = mkPtr(EXT.curve), pFG = mkPtr(EXT.fng);
function advPtr(p, tLevel, refMs) {
  while (p.lvl + 1 < p.kfT.length && p.kfT[p.lvl + 1] <= tLevel) p.lvl++;
  if (refMs !== p.refMs) { p.refMs = refMs; p.ref = -1; let lo = 0, hi = p.kfT.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (p.kfT[m] <= refMs) { p.ref = m; lo = m + 1; } else hi = m - 1; } }
}
function extValsFor(decMs) {
  advPtr(pFF, decMs, decMs - 90 * 86400000);
  advPtr(pCV, decMs, decMs - 90 * 86400000);
  advPtr(pFG, decMs, decMs - 7 * 86400000);
  if (pFF.lvl < 0 || pFF.ref < 0 || pCV.lvl < 0 || pCV.ref < 0 || pFG.lvl < 0 || pFG.ref < 0) return null;
  return [pFF.kfV[pFF.lvl], pFF.kfV[pFF.lvl] - pFF.kfV[pFF.ref],
          pCV.kfV[pCV.lvl], pCV.kfV[pCV.lvl] - pCV.kfV[pCV.ref],
          pFG.kfV[pFG.lvl], pFG.kfV[pFG.lvl] - pFG.kfV[pFG.ref]];
}

for (let i = startIdx; i < m1.t.length; i++) {
  const t = m1.t[i];
  if (t >= T1) break;
  const decision = t + 60000;
  // monotonic pointers
  while (j15 < m15.t.length - 1 && m15.t[j15 + 1] <= t - 840000) j15++;
  while (fi + 1 < fundT.length && fundT[fi + 1] <= decision) fi++;

  if (m15.t.length === 0 || j15 < 0 || m15.t[j15] > t - 840000) { funnel.noClosed15m++; continue; }
  if (decision - (m15.t[j15] + 900000) > FRESH_15M_MS) { funnel.stale15m++; continue; }   // 15m hole region
  if (fundT.length === 0 || fi < 0) { funnel.noClosed15m++; continue; }                    // no funding as-of (should not happen)

  const decMs = t + 60000;
  const extVals = extValsFor(decMs);
  if (extVals === null) { funnel.extExcluded++; continue; }   // pre-reg §2: invalid row, counted (expected 0)

  const row = featureRow(S, i, j15, fi, /* pairId */ ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT'].indexOf(pairArg), extVals);
  if (row === null) throw new Error(`${pairArg}: invalid feature row at i=${i} (${new Date(t).toISOString()})`);

  const l5 = labelAt(m1.t, m1.c, i, 5), l7 = labelAt(m1.t, m1.c, i, 7), l10 = labelAt(m1.t, m1.c, i, 10);

  // target indices via the same exact-timestamp search labelAt uses
  const tgtIdx = (H) => {
    const want = t + H * 60000;
    let lo = i + 1, hi = m1.t.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (m1.t[mid] === want) return mid; if (m1.t[mid] < want) lo = mid + 1; else hi = mid - 1; }
    return -1;
  };
  const i5 = tgtIdx(5), i7 = tgtIdx(7), i10 = tgtIdx(10);

  const seg = t < TRAIN_END ? 'train' : t < VAL_END ? 'validation' : 'test';
  const labels = { 5: l5, 7: l7, 10: l10 };
  const tgt = { 5: i5, 7: i7, 10: i10 };

  // encode row
  const off = bufN * ROW_BYTES;
  buf.writeBigInt64LE(BigInt(t), off);
  buf.writeDoubleLE(m1.c[i], off + 8);
  buf.writeUInt8(l5 === -1 ? 255 : l5, off + 16);
  buf.writeUInt8(l7 === -1 ? 255 : l7, off + 17);
  buf.writeUInt8(l10 === -1 ? 255 : l10, off + 18);
  buf.writeUInt8(0, off + 19);
  buf.writeDoubleLE(i5 === -1 ? 0 : m1.c[i5], off + 20);
  buf.writeDoubleLE(i7 === -1 ? 0 : m1.c[i7], off + 28);
  buf.writeDoubleLE(i10 === -1 ? 0 : m1.c[i10], off + 36);
  for (let k = 0; k < N_FEATURES; k++) buf.writeFloatLE(row[k], off + 44 + k * 4);
  bufN++; totalRows++; funnel.rowsWritten++;

  for (const H of HORIZONS) {
    const l = labels[H];
    if (l === -1) funnel.perHorizon[H].missingTarget++;
    else if (l === 2) { funnel.perHorizon[H].ties++; funnel.perSplit[H][seg].ties++; }
    else {
      funnel.perHorizon[H].decided++;
      funnel.perSplit[H][seg].decided++;
    }
  }
  if (bufN === BUF_ROWS) flush();
  if (totalRows % 500000 === 0) console.log(`  ... ${totalRows} rows (${((Date.now() - t0ms) / 1000).toFixed(0)}s)`);
}
flush();

funnel.elapsedSeconds = +((Date.now() - t0ms) / 1000).toFixed(1);
funnel.featureNames = FEATURE_NAMES;
funnel.rowBytes = ROW_BYTES;
funnel.window = { T0: new Date(T0).toISOString(), T1: new Date(T1).toISOString() };
funnel.sources = {
  m1: { unique: m1.count, requestedFrom: m1.firstReq, requestedTo: m1.lastReq },
  m15: { unique: m15.count },
  funding: { records: fundT.length },
};
funnel.layout = `ts:i64 c_t:f64 l5:u8 l7:u8 l10:u8 pad:u8 cH5:f64 cH7:f64 cH10:f64 f:f32x${N_FEATURES} (packed, ${ROW_BYTES}B)`;
writeFileSync(join(OUT, `${pairArg}.meta.json`), JSON.stringify(funnel, null, 1));
console.log(`done: ${totalRows} rows -> ${pairArg}.bin (${(totalRows * ROW_BYTES / 1e6).toFixed(0)} MB) in ${funnel.elapsedSeconds}s`);
console.log(`funnel: stale15m=${funnel.stale15m} noClosed15m=${funnel.noClosed15m} extExcluded=${funnel.extExcluded}`);
for (const H of HORIZONS) console.log(`  H=${H}: decided=${funnel.perHorizon[H].decided} ties=${funnel.perHorizon[H].ties} missingTarget=${funnel.perHorizon[H].missingTarget}`);

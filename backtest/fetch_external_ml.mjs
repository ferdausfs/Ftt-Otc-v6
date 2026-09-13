/**
 * TASK 25 — ML SENTIMENT/MACRO: external data fetcher (fetcher-first rule).
 * Fetches the three frozen external sources of
 * experiments/ml/PRE_REGISTRATION_SENTIMACRO.md §4 AFTER the pre-reg commit
 * and BEFORE any feature code runs:
 *
 *   1. FRED DFF    (effective federal funds rate, daily)  2021-07-01 → 2026-09-05
 *   2. FRED T10Y2Y (10Y-2Y Treasury spread, daily)        same span
 *      — public fredgraph.csv endpoint, no key; raw CSV saved verbatim
 *   3. alternative.me Crypto Fear & Greed Index, full history (limit=0)
 *
 * Raw files are NOT committed (project policy, same as candles); the sha256
 * of every file is pinned in the committed provenance note
 * results/PROVENANCE_EXTERNAL_ML.md, which the loaders verify (pre-reg S7).
 *
 * Run: node backtest/fetch_external_ml.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'backtest', 'data', 'external');
const PROV = join(ROOT, 'results', 'PROVENANCE_EXTERNAL_ML.md');

const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const SPAN = { cosd: '2021-07-01', coed: '2026-09-05' };
const SOURCES = [
  { id: 'DFF', url: `${FRED}?id=DFF&cosd=${SPAN.cosd}&coed=${SPAN.coed}`, file: 'fred_DFF.csv', minRows: 800 },
  { id: 'T10Y2Y', url: `${FRED}?id=T10Y2Y&cosd=${SPAN.cosd}&coed=${SPAN.coed}`, file: 'fred_T10Y2Y.csv', minRows: 800 },
  { id: 'FNG', url: 'https://api.alternative.me/fng/?limit=0&format=json', file: 'fng_full.json', minRows: 1000 },
];

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

async function fetchOne(src) {
  const res = await fetch(src.url);
  if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status}`);
  const text = await res.text();
  if (src.id === 'FNG') {
    const j = JSON.parse(text);
    if (!j.data || j.data.length < src.minRows) throw new Error(`${src.id}: only ${j.data?.length} rows`);
    return Buffer.from(JSON.stringify(j));
  }
  const lines = text.trim().split('\n');
  if (lines.length < src.minRows) throw new Error(`${src.id}: only ${lines.length} CSV rows`);
  if (!lines[0].startsWith('observation_date')) throw new Error(`${src.id}: unexpected header`);
  return Buffer.from(text);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const prov = [`# Provenance — External regime sources (Task 25, ML sentiment/macro)`, ``,
    `Pre-registered in experiments/ml/PRE_REGISTRATION_SENTIMACRO.md §4 (commit 4c08e9f).`,
    `Raw files are NOT committed; these sha256 pins bind the bytes the pipeline used.`,
    ``];
  for (const src of SOURCES) {
    const file = join(OUT_DIR, src.file);
    if (existsSync(file)) {
      const buf = readFileSync(file);
      prov.push(`- **${src.id}** (already on disk, not refetched): backtest/data/external/${src.file}, ${buf.length} bytes, sha256 \`${sha256(buf)}\``);
      console.log(`${src.id}: exists (${buf.length}B)`);
      continue;
    }
    process.stdout.write(`fetching ${src.id} ... `);
    const buf = await fetchOne(src);
    writeFileSync(file, buf);
    prov.push(`- **${src.id}**: ${src.url}\n  - fetched ${new Date().toISOString()} · ${buf.length} bytes · sha256 \`${sha256(buf)}\` → backtest/data/external/${src.file}`);
    console.log(`${buf.length} bytes`);
  }
  prov.push(``, `Pinning rules (enforced in features_lib.mjs, tested in leakage_sentimacro_tests.mjs):`,
    `- FRED observation dated business day D → knowable from next business day at 21:30 UTC (DFF weekend calendar-fill rows dropped; '.' rows dropped).`,
    `- F&G value stamped D → knowable from D+1 00:00 UTC.`, ``);
  writeFileSync(PROV, prov.join('\n'));
  console.log(`provenance -> results/PROVENANCE_EXTERNAL_ML.md`);
}

main().catch(e => { console.error('external fetch failed:', e.message); process.exit(1); });

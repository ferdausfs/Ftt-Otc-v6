/**
 * TASK 26 — FRVP REGIME FILTER: Fear & Greed fetcher.
 * Fetches the FULL daily history of the alternative.me Crypto Fear & Greed
 * Index (public API, no key) into backtest/data/external/fng_full.json and
 * writes a provenance note (URL, fetch timestamp, sha256, row count, span).
 *
 * Raw file is NOT committed (same policy as candle data); the provenance
 * note IS committed so the sha256 pins the exact bytes used.
 *
 * Frozen per prereg/PREREG_FRVP_REGIME_FILTER.md §3/§5: the value stamped
 * date D (timestamp = D 00:00 UTC) is treated as knowable from
 * D+1 00:00 UTC — one full day after the source's actual publication.
 * This file only fetches/stores raw data; the known_from rule lives in the
 * analyzer (frvp_regime_filter.mjs).
 *
 * Run: node backtest/fetch_fng.mjs
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'backtest', 'data', 'external');
const OUT_FILE = join(OUT_DIR, 'fng_full.json');
// results/ IS committed on this branch (backtest/data is gitignored) — the
// provenance note pins the raw file's sha256 there.
const PROV_FILE = join(ROOT, 'results', 'PROVENANCE_FNG.md');

const URL = 'https://api.alternative.me/fng/?limit=0&format=json';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (existsSync(OUT_FILE)) {
    console.log(`fng_full.json already exists — refusing to overwrite (delete it to refetch).`);
    const j = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
    console.log(`existing rows: ${j.data.length}, span ${j.data[j.data.length - 1].ts} .. ${j.data[0].ts}`);
    return;
  }
  process.stdout.write('fetching F&G full history ... ');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from alternative.me`);
  const j = await res.json();
  if (!j.data || !Array.isArray(j.data) || j.data.length < 1000) {
    throw new Error(`unexpected payload: ${j.data ? j.data.length : 'no data'} rows (expected full history ~2000+)`);
  }
  // normalize: keep value + ts (sec, day boundary) + classification; sort ascending
  const rows = j.data
    .map(d => ({ ts: +d.timestamp, value: +d.value, cls: d.value_classification }))
    .filter(r => Number.isFinite(r.ts) && Number.isFinite(r.value))
    .sort((a, b) => a.ts - b.ts);
  // sanity: strictly increasing day stamps, 86400s spacing (allow DST-style drift warn only)
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].ts - rows[i - 1].ts;
    if (dt <= 0) throw new Error(`non-increasing timestamps at ${i}: ${rows[i - 1].ts} -> ${rows[i].ts}`);
    if (dt !== 86400) console.log(`note: day spacing ${dt}s at ${new Date(rows[i].ts * 1000).toISOString()} (kept as-is)`);
  }
  const payload = { source: URL, fetchedAt: new Date().toISOString(), count: rows.length, data: rows };
  writeFileSync(OUT_FILE, JSON.stringify(payload));
  const sha = createHash('sha256').update(readFileSync(OUT_FILE)).digest('hex');
  const first = new Date(rows[0].ts * 1000).toISOString();
  const last = new Date(rows[rows.length - 1].ts * 1000).toISOString();
  writeFileSync(PROV_FILE, [
    `# Provenance — Fear & Greed Index (Task 26)`,
    ``,
    `- Source: ${URL}`,
    `- Fetched at: ${payload.fetchedAt}`,
    `- Rows: ${rows.length} (daily, ascending)`,
    `- Span: ${first} .. ${last} (value-stamp dates)`,
    `- sha256(backtest/data/external/fng_full.json): \`${sha}\``,
    `- Raw file policy: NOT committed (same as candle data); this note pins its bytes.`,
    `- Publication pinning (frozen, enforced in frvp_regime_filter.mjs): value stamped D is knowable from D+1 00:00 UTC.`,
    ``,
  ].join('\n'));
  console.log(`${rows.length} rows (${first} .. ${last}) sha256=${sha.slice(0, 16)}...`);
}

main().catch(e => { console.error('FNG fetch failed:', e.message); process.exit(1); });

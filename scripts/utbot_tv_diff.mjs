/**
 * TradingView EXPORT DIFF — the mandatory exact-match verification harness.
 *
 * Input: a TradingView "Export chart data" CSV from a chart with the UT Bot
 * Alerts indicator applied (defaults a=1, c=10, Heikin Ashi OFF). The export
 * contains the chart OHLC rows plus the indicator's plotted columns
 * (xATRTrailingStop and the Buy/Sell marker columns; exact column names vary
 * by export — they are auto-detected).
 *
 * What it does:
 *   1. parses OHLC (+ optional ISO/unix time) from the CSV
 *   2. runs the port over the OHLC rows
 *   3. diffs, bar-by-bar, the exported xATRTrailingStop column against our
 *      stop series, and the exported Buy/Sell columns against our events
 *   4. prints every mismatching bar with both values and the delta
 *
 * Why `--from N` exists: TradingView computes the indicator over the FULL
 * chart history; the export only carries the exported window. The Wilder ATR
 * / stop recursion is path-dependent, so early rows of the export can differ
 * by the seed influence, which decays as (1 - 1/c)^bars  (c=10 -> ~0.5% at
 * 50 bars, < 1e-12 at ~270 bars). Export a window with >=300 bars of
 * lead-in and diff from there; or use --auto-lead, which finds the first
 * bar where the stop agrees within tolerance and diffs from there.
 *
 * Exit code 0 ONLY if, from the diff start bar onward: |stop delta| <=
 * tol (relative) on every bar AND the buy/sell event lists match exactly.
 *
 * Usage:
 *   node scripts/utbot_tv_diff.mjs --csv tv_export.csv [--a 1] [--c 10]
 *        [--from 300] [--auto-lead] [--tol 1e-9]
 *   node scripts/utbot_tv_diff.mjs --selfcheck   (format round-trip test)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { computeUtBot } from '../src/strategy/utBotAlerts.mjs';

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function opt(name, def = undefined) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const hasFlag = name => args.includes('--' + name);

// ── CSV parsing (TradingView export shape) ──────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseNum(s) {
  if (s === undefined || s === null) return undefined;
  const t = String(s).replace(/"/g, '').trim();
  if (t === '' || t.toLowerCase() === 'na' || t.toLowerCase() === 'nan' || t === 'false') return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

function parseTime(s) {
  if (!s) return undefined;
  const t = String(s).replace(/"/g, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const v = Number(t);
    if (v > 1e12) return Math.trunc(v);              // ms
    if (v > 1e9) return Math.trunc(v * 1000);        // s
    if (v > 1e5) return Math.trunc(v * 1000);        // unix seconds small (unlikely)
  }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
}

const BOOL_TRUE = new Set(['true', '1', 'buy', 'yes']);

function loadExport(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV too small');
  const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ''));
  const lower = header.map(h => h.toLowerCase());
  const colIdx = name => lower.findIndex(h => h.includes(name));

  const iT = colIdx('time') >= 0 ? colIdx('time') : colIdx('date');
  const iO = colIdx('open'), iH = colIdx('high'), iL = colIdx('low'), iC = colIdx('close');
  const iStop = colIdx('xatrtrailingstop') >= 0 ? colIdx('xatrtrailingstop')
    : colIdx('trailingstop') >= 0 ? colIdx('trailingstop') : -1;
  // Marker columns: anything named buy/sell (plotshape exports vary: 1/0,
  // true/false, or the price level where the shape prints).
  const iBuy = colIdx('buy'), iSell = colIdx('sell');
  if (Math.min(iO, iH, iL, iC) < 0) {
    throw new Error('OHLC columns not found; header=' + header.join('|'));
  }
  const rows = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    if (cells.length < header.length - 2) continue;   // tolerate ragged rows
    const row = {
      time: iT >= 0 ? parseTime(cells[iT]) : undefined,
      o: parseNum(cells[iO]), h: parseNum(cells[iH]),
      l: parseNum(cells[iL]), c: parseNum(cells[iC]),
      tvStop: iStop >= 0 ? parseNum(cells[iStop]) : undefined,
      tvBuyRaw: iBuy >= 0 ? cells[iBuy] : undefined,
      tvSellRaw: iSell >= 0 ? cells[iSell] : undefined,
    };
    if (row.o !== undefined && row.h !== undefined && row.l !== undefined && row.c !== undefined) {
      rows.push(row);
    }
  }
  return { header, rows, hasStop: iStop >= 0, hasMarkers: iBuy >= 0 || iSell >= 0 };
}

// TV plotshape marker -> boolean. If the column carries prices (shape printed
// at price level), a numeric cell simply means "marker present".
function markerBool(raw) {
  if (raw === undefined) return false;
  const t = String(raw).replace(/"/g, '').trim();
  if (t === '' || t.toLowerCase() === 'na' || t === '0' || t.toLowerCase() === 'false') return false;
  return true;
}

// ── selfcheck: round-trip our own series through the same diff path ─────────
function selfcheck() {
  let s = 424242;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const rows = [];
  let px = 1.2345;
  for (let i = 0; i < 500; i++) {
    const o = px, c = o + (rnd() - 0.5) * 0.004;
    const h = Math.max(o, c) + rnd() * 0.0015, l = Math.min(o, c) - rnd() * 0.0015;
    const t = 1735689600000 + i * 300000;
    rows.push({ time: t, o, h, l, c, tvStop: undefined, tvBuyRaw: '', tvSellRaw: '' });
    px = c;
  }
  const candles = rows.map(r => ({ t: r.time, o: r.o, h: r.h, l: r.l, c: r.c }));
  const ours = computeUtBot(candles, { a: 1, c: 10 }, { tfMs: 300000 });
  // Synthesize the TV columns from OUR output and re-diff through the same
  // comparison machinery (validates parser/diff logic, not the indicator).
  const csvLines = ['time,open,high,low,close,xATRTrailingStop,Buy,Sell'];
  rows.forEach((r, i) => {
    csvLines.push([
      new Date(r.time).toISOString().slice(0, 16).replace('T', ' '),
      r.o, r.h, r.l, r.c,
      ours.stop[i] === undefined ? 'na' : ours.stop[i],
      ours.buy[i] ? '1' : '0', ours.sell[i] ? '1' : '0',
    ].join(','));
  });
  const p = '/tmp/utbot_selfcheck_export.csv';
  writeFileSync(p, csvLines.join('\n'));
  const ex = loadExport(p);
  const r = runDiff(ex, { a: 1, c: 10 }, { tfMs: 300000, from: 0, tol: 1e-9, autoLead: false });
  console.log('selfcheck export written to ' + p);
  console.log('selfcheck result: ' + (r.clean ? 'CLEAN' : 'MISMATCH'));
  if (!r.clean) process.exit(1);
  console.log('SELFCHECK PASS (parser + diff machinery round-trip)');
  process.exit(0);
}

// ── diff core ────────────────────────────────────────────────────────────────
function runDiff(ex, params, opts) {
  const { rows } = ex;
  const candles = rows.map(r => ({ t: r.time, o: r.o, h: r.h, l: r.l, c: r.c }));
  const ours = computeUtBot(candles, params, { tfMs: opts.tfMs });

  const n = rows.length;
  let from = opts.from;
  if (opts.autoLead) {
    from = -1;
    for (let i = 0; i < n; i++) {
      if (rows[i].tvStop === undefined || ours.stop[i] === undefined) continue;
      const scale = Math.max(1, Math.abs(rows[i].tvStop));
      if (Math.abs(ours.stop[i] - rows[i].tvStop) / scale <= opts.tol) { from = i; break; }
      // once we have a defined pair that disagrees, keep searching only a
      // bounded lead-in (otherwise a mid-series equality could fake a start)
      if (i > 5000) break;
    }
    if (from < 0) throw new Error('--auto-lead found no agreeing bar within 5000; check columns/params');
    console.log('auto-lead: diffing from bar ' + from + ' (' + rows[from].time + ')');
  }

  const stopMismatches = [];
  for (let i = Math.max(from, 0); i < n; i++) {
    if (rows[i].tvStop === undefined || ours.stop[i] === undefined) continue; // na==na or TV na row
    const scale = Math.max(1, Math.abs(rows[i].tvStop));
    const d = Math.abs(ours.stop[i] - rows[i].tvStop) / scale;
    if (d > opts.tol) stopMismatches.push({ i, t: rows[i].time, ours: ours.stop[i], tv: rows[i].tvStop, rel: d });
  }

  const ourEvents = ours.events
    .filter(e => e.i >= Math.max(from, 0))
    .map(e => ({ i: e.i, t: rows[e.i].time, type: e.type, price: e.price, stop: e.stop }));
  const tvEvents = [];
  for (let i = Math.max(from, 0); i < n; i++) {
    if (markerBool(rows[i].tvBuyRaw)) tvEvents.push({ i, t: rows[i].time, type: 'buy', price: rows[i].c, stop: rows[i].tvStop });
    if (markerBool(rows[i].tvSellRaw)) tvEvents.push({ i, t: rows[i].time, type: 'sell', price: rows[i].c, stop: rows[i].tvStop });
  }

  const eventMismatches = [];
  const maxLen = Math.max(ourEvents.length, tvEvents.length);
  for (let k = 0; k < maxLen; k++) {
    const a = ourEvents[k], b = tvEvents[k];
    if (!a || !b || a.i !== b.i || a.type !== b.type) eventMismatches.push({ k, ours: a, tv: b });
  }

  return {
    clean: stopMismatches.length === 0 && eventMismatches.length === 0,
    n, from, ourEvents, tvEvents, stopMismatches, eventMismatches, ours, rows,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
if (hasFlag('selfcheck')) { selfcheck(); }

const csvPath = opt('csv');
if (!csvPath || !existsSync(csvPath)) {
  console.error('usage: node scripts/utbot_tv_diff.mjs --csv <tv_export.csv> [--a 1] [--c 10] [--from 300] [--auto-lead] [--tol 1e-9]');
  console.error('       node scripts/utbot_tv_diff.mjs --selfcheck');
  process.exit(2);
}
const params = { a: Number(opt('a', '1')), c: Number(opt('c', '10')) };
const tfMsBySpan = undefined; // inferred from data below
const ex = loadExport(csvPath);
console.log('loaded ' + ex.rows.length + ' rows; columns: ' + ex.header.join(' | '));
if (!ex.hasStop && !ex.hasMarkers) {
  console.error('NOTE: export has neither xATRTrailingStop nor Buy/Sell columns — nothing to diff.');
  process.exit(2);
}
// infer tf from median row spacing (falls back to 5m when times are missing)
const times = ex.rows.map(r => r.time).filter(t => t !== undefined);
let tfMs = 300000;
if (times.length > 2) {
  const gaps = {};
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0) gaps[g] = (gaps[g] || 0) + 1;
  }
  const best = Object.entries(gaps).sort((x, y) => y[1] - x[1])[0];
  if (best) tfMs = Number(best[0]);
}
console.log('inferred timeframe: ' + (tfMs / 60000) + 'm; params a=' + params.a + ' c=' + params.c);

const from = opt('from') !== undefined ? Number(opt('from')) : 0;
const tol = Number(opt('tol', '1e-9'));
const r = runDiff(ex, params, { tfMs, from, tol, autoLead: hasFlag('auto-lead') });

console.log('\n=== STOP series diff (bar ' + r.from + ' .. ' + (r.n - 1) + ') ===');
console.log('mismatching bars: ' + r.stopMismatches.length);
for (const m of r.stopMismatches.slice(0, 20)) {
  console.log('  bar ' + m.i + ' t=' + m.t + '  ours=' + m.ours + '  tv=' + m.tv
    + '  rel_delta=' + m.rel.toExponential(3));
}
console.log('\n=== EVENTS (from bar ' + r.from + ') ===');
console.log('ours: ' + r.ourEvents.map(e => e.i + ':' + e.type + '@' + e.price).join(', '));
console.log('tv:   ' + r.tvEvents.map(e => e.i + ':' + e.type + '@' + e.price).join(', '));
console.log('event mismatches: ' + r.eventMismatches.length);
for (const m of r.eventMismatches.slice(0, 20)) {
  console.log('  #' + m.k + ' ours=' + (m.ours ? m.ours.i + ':' + m.ours.type : '—')
    + '  tv=' + (m.tv ? m.tv.i + ':' + m.tv.type : '—'));
}

if (r.clean) {
  console.log('\nVERIFICATION CLEAN: stop series + events match TradingView export'
    + ' from bar ' + r.from + ' onward (tol=' + tol + ').');
  console.log('Reference window: rows ' + r.from + '..' + (r.n - 1)
    + '  first=' + r.rows[r.from].time + ' last=' + r.rows[r.n - 1].time
    + '  (' + (r.n - r.from) + ' bars, tf=' + (tfMs / 60000) + 'm, a=' + params.a + ', c=' + params.c + ')');
  process.exit(0);
} else {
  console.log('\nVERIFICATION FAILED — see mismatches above. Do NOT merge/deploy.');
  process.exit(1);
}

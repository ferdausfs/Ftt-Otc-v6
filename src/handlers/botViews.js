/**
 * Telegram panel views — the premium TradingView-style screens (mockup
 * "Ftt Panel" redesign, v1.5.0).
 *
 * Pure functions: (config, ...) -> { text, kb } — no Telegram calls, no KV.
 * Rendered from the registry (INDICATORS + params[] descriptors) and the
 * pair catalog, so a future indicator or pair appears here automatically.
 *
 * Screen map (mockup parity):
 *   mainMenuView      "Main Menu (Clean & Premium UI)" — pair grid + add/search
 *   categoriesView    "Select Pair" categories (Active / Majors / Minors / ...)
 *   categoryListView  one category's pairs, ✅ on scanning pairs
 *   searchResultsView "eurusd" -> EUR/USD results
 *   pairPanelView     "Settings View (Dropdown Style)" — EVERY input with
 *                     its current value, tap a line to change it
 *   paramDropdownView "Dropdown Example (Kernel/Bandwidth)" — active option
 *                     marked ✅, Custom value... for numerics
 *   tfDropdownView    "Dropdown Example (Timeframe)"
 *   allSettingsView   "All-pairs settings" — the mockup's global quick
 *                     buttons (UT Bot, Key Value, ATR, Kernel, Bandwidth, TF)
 *   statusView        full live state text
 */

import { CONFIG, ASSET_TYPE } from '../config.js';
import { getAssetType } from '../utils/pairs.js';
import { pairIcon, CATEGORIES, CATEGORY_BY_ID, CATALOG_PAIRS } from '../utils/pairCatalog.js';
import { INDICATORS } from '../strategy/registry.mjs';

// ── glyphs (explicit state — the old bare ●/○ confused) ─────────────────────
const ON = '\u2705';      // ✅ enabled
const OFF = '\u274C';     // ❌ disabled
const CUR = '\u2705';     // ✅ marks the active dropdown option
const DRP = '\u25BE';     // ▾ dropdown marker
const DIV = '--------------------------------';
const MIXED = 'mixed';

function isCrypto(pair) { return getAssetType(pair) === ASSET_TYPE.CRYPTO; }

function fmtVal(v) { return (v === undefined || v === null) ? 'default' : String(v); }

/** Current value of one registry param for one pair (null when unset). */
function paramValue(pairCfg, indId, p) {
  if (!pairCfg) return undefined;
  return p.path === 'ind'
    ? (pairCfg.indicators && pairCfg.indicators[indId] ? pairCfg.indicators[indId][p.key] : undefined)
    : pairCfg[p.key];
}

/** Aggregated display of one param across every pair ('mixed' when differs). */
export function aggParam(cfg, ind, p) {
  const vals = new Set();
  for (const pc of Object.values(cfg.pairs || {})) {
    vals.add(fmtVal(paramValue(pc, ind.id, p)));
    if (vals.size > 1) return { value: MIXED, mixed: true, count: vals.size };
  }
  return { value: [...vals][0] || 'default', mixed: false, count: 1 };
}

/** Global indicator state across all pairs: 'on' | 'off' | 'mixed'. */
export function aggIndicator(cfg, indId) {
  let on = 0, off = 0;
  for (const pc of Object.values(cfg.pairs || {})) {
    const ic = pc.indicators && pc.indicators[indId];
    (ic && ic.enabled ? on++ : off++);
  }
  if (on && !off) return 'on';
  if (off && !on) return 'off';
  return 'mixed';
}

function indStateText(state) {
  return state === 'on' ? 'ON ' + ON : state === 'off' ? 'OFF ' + OFF : 'mixed';
}

function onCount(cfg) {
  return Object.values(cfg.pairs || {}).filter(p => p.enabled === true).length;
}

// ── main menu (mockup screen 1) ──────────────────────────────────────────────

export function mainMenuView(cfg, note) {
  const actives = CATALOG_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled)
    .concat(Object.keys(cfg.pairs).filter(p => !CATALOG_PAIRS.includes(p) && cfg.pairs[p].enabled));
  const text = [
    '\uD83D\uDE80 FTT Panel \u2014 ' + CONFIG.VERSION,
    ON + ' Scanning: ' + actives.length + ' pair' + (actives.length === 1 ? '' : 's') + ' every 15 minutes',
    note || 'Tap a pair below, or \u2795 Add pair for the full universe.',
  ].join('\n');
  const kb = [];
  for (let i = 0; i < actives.length; i += 2) {
    const row = [{ text: pairIcon(actives[i]) + ' ' + DRP, callback_data: 'P:' + actives[i] }];
    if (actives[i + 1]) row.push({ text: pairIcon(actives[i + 1]) + ' ' + DRP, callback_data: 'P:' + actives[i + 1] });
    kb.push(row);
  }
  kb.push([
    { text: '\u2795 Add pair ' + DRP, callback_data: 'cat' },
    { text: '\uD83D\uDD0D Search pair', callback_data: 'srch' },
  ]);
  kb.push([{ text: '\uD83D\uDEE0 All-pairs settings ' + DRP, callback_data: 'as' }]);
  kb.push([
    { text: '\uD83D\uDCCA Status', callback_data: 'm:status' },
    { text: '\uD83D\uDD04 Refresh', callback_data: 'pp' },
  ]);
  return { text, kb };
}

// ── Select Pair (mockup screen 3) ────────────────────────────────────────────

export function categoriesView(cfg, note) {
  const n = onCount(cfg);
  const text = [
    '\uD83D\uDCCB Select Pair \u2014 ' + CATALOG_PAIRS.length + '+ supported',
    ON + ' = scanning now | ' + n + ' active',
    note || 'Tap a category to browse, or Search to type a name.',
  ].join('\n');
  const kb = CATEGORIES.map(c => {
    const count = c.dynamic ? n : c.pairs.length;
    return [{ text: c.label + ' (' + count + ')', callback_data: 'cat:' + c.id }];
  });
  kb.push([{ text: '\uD83D\uDD0D Search by name', callback_data: 'srch' }]);
  kb.push([{ text: '\uD83C\uDFE0 Main', callback_data: 'pp' }]);
  return { text, kb };
}

export function categoryListView(cfg, catId, note) {
  const cat = CATEGORY_BY_ID[catId];
  if (!cat) return categoriesView(cfg, 'Unknown category.');
  const pairs = cat.dynamic
    ? CATALOG_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled)
      .concat(Object.keys(cfg.pairs).filter(p => !CATALOG_PAIRS.includes(p) && cfg.pairs[p].enabled))
    : cat.pairs;
  const text = [
    cat.label + ' \u2014 tap a pair',
    ON + ' = scanning now | every pair opens its full settings panel.',
  ].concat(note ? [note] : []).join('\n');
  const kb = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const mk = p => (cfg.pairs[p] && cfg.pairs[p].enabled ? ON + ' ' : '') + pairIcon(p);
    const row = [{ text: mk(pairs[i]), callback_data: 'P:' + pairs[i] }];
    if (pairs[i + 1]) row.push({ text: mk(pairs[i + 1]), callback_data: 'P:' + pairs[i + 1] });
    kb.push(row);
  }
  kb.push([
    { text: '\uD83D\uDCCB Categories', callback_data: 'cat' },
    { text: '\uD83D\uDD0D Search', callback_data: 'srch' },
  ]);
  kb.push([{ text: '\uD83C\uDFE0 Main', callback_data: 'pp' }]);
  return { text, kb };
}

// ── search (user request: type "eurusd" -> EUR/USD) ─────────────────────────

export function searchPromptView() {
  return {
    text: [
      '\uD83D\uDD0D Search pair',
      'Type a name: eurusd, gbpjpy, btc, xrp, usdinr...',
      'Any supported pair works \u2014 with or without "/".',
      '/reset or \uD83C\uDFE0 Main to cancel.',
    ].join('\n'),
    kb: [
      [{ text: '\uD83D\uDCCB Categories', callback_data: 'cat' }],
      [{ text: '\uD83C\uDFE0 Main', callback_data: 'pp' }],
    ],
  };
}

export function searchResultsView(query, matches, cfg) {
  const text = [
    '\uD83D\uDD0D Search: "' + query + '" \u2014 ' + matches.length + ' match' + (matches.length === 1 ? '' : 'es'),
    matches.length ? 'Tap a pair to open its full settings panel.' : 'Try eurusd / gbpjpy / btc / eth / usdjpy.',
  ].join('\n');
  const kb = matches.map(p => [{
    text: (cfg.pairs[p] && cfg.pairs[p].enabled ? ON + ' ' : '') + pairIcon(p),
    callback_data: 'P:' + p,
  }]);
  kb.push([
    { text: '\uD83D\uDD0D New search', callback_data: 'srch' },
    { text: '\uD83C\uDFE0 Main', callback_data: 'pp' },
  ]);
  return { text, kb };
}

// ── pair settings panel (mockup screen 2) ────────────────────────────────────

export function pairPanelView(cfg, pair, note) {
  const pc = cfg.pairs[pair] || {};
  const scanning = pc.enabled === true;
  const lines = [
    '\u2699\uFE0F SETTINGS - ' + pair + '  [' + (isCrypto(pair) ? 'crypto' : 'forex') + ']',
    'Scanning: ' + (scanning ? 'ON ' + ON : 'OFF ' + OFF) + ' | Timeframe: ' + (pc.timeframe || '?'),
  ];
  if (!scanning) lines.push('This pair is NOT scanned. Tap "Scanning" to enable it.');
  lines.push(DIV);

  const kb = [
    [{ text: (scanning ? ON + ' Scanning: ON' : OFF + ' Scanning: OFF'), callback_data: 'pt:' + pair }],
    [{ text: '\u23F1 Timeframe: ' + (pc.timeframe || '?') + ' ' + DRP, callback_data: 'td:' + pair }],
  ];
  for (const ind of INDICATORS) {
    const ic = pc.indicators && pc.indicators[ind.id];
    const on = !!(ic && ic.enabled);
    const icon = ind.icon || '\uD83D\uDCCA';
    lines.push(icon + ' ' + ind.name + ': ' + (on ? 'ON ' + ON : 'OFF ' + OFF));
    kb.push([{ text: icon + ' ' + ind.name + ': ' + (on ? 'ON ' + ON : 'OFF ' + OFF),
      callback_data: 'tg:' + pair + ':' + ind.id }]);
    for (const p of (ind.params || [])) {
      const v = fmtVal(paramValue(pc, ind.id, p));
      const pIcon = p.icon || '\u2022';
      lines.push('    ' + pIcon + ' ' + p.label + ': ' + v);
      kb.push([{ text: pIcon + ' ' + p.label + ': ' + v + ' ' + DRP,
        callback_data: 'dr:' + pair + ':' + ind.id + ':' + p.key }]);
    }
  }
  lines.push(DIV);
  lines.push('Tap a line to change it.' + (note ? ' ' + note : ''));
  kb.push([
    { text: '\uD83D\uDD01 Change pair', callback_data: 'cat' },
    { text: '\u26A1 Scan now', callback_data: 'sc:' + pair },
  ]);
  kb.push([
    { text: '\uD83D\uDCCA Status', callback_data: 'm:status' },
    { text: '\uD83C\uDFE0 Main', callback_data: 'pp' },
  ]);
  return { text: lines.join('\n'), kb };
}

// ── dropdowns (mockup screens 4/5/6) ─────────────────────────────────────────

/**
 * One input's dropdown. scope: { kind: 'pair', pair } | { kind: 'all' }.
 * backCb is where "Back" returns (the panel or the all-pairs screen).
 */
export function paramDropdownView(cfg, ind, p, scope, backCb) {
  const pairScope = scope.kind === 'pair';
  const cur = pairScope
    ? fmtVal(paramValue(cfg.pairs[scope.pair], ind.id, p))
    : aggParam(cfg, ind, p).value;
  const head = (p.icon || '\u2022') + ' ' + ind.name + ' \u2014 ' + p.label + ' ' + DRP;
  const target = pairScope ? scope.pair : 'ALL pairs';
  const lines = [
    head,
    target + ' current: ' + cur,
  ];
  if (!pairScope && cur === MIXED) lines.push('Values differ per pair \u2014 picking below sets EVERY pair.');
  if (p.kind !== 'enum') {
    lines.push('Allowed range: ' + p.min + ' to ' + p.max + (p.kind === 'int' ? ' (whole number)' : ''));
  }
  const kb = [];
  const options = p.kind === 'enum' ? (p.options || []) : (p.presets || []);
  const perRow = p.perRow || 1;
  for (let i = 0; i < options.length; i += perRow) {
    const row = [];
    for (let j = i; j < Math.min(i + perRow, options.length); j++) {
      const opt = String(options[j]);
      const isCur = cur !== MIXED && (opt === cur || Number(opt) === Number(cur));
      const setCb = (pairScope ? 'dv:' + scope.pair : 'dva') + ':' + ind.id + ':' + p.key + ':' + opt;
      row.push({ text: (isCur ? CUR + ' ' : '') + opt, callback_data: setCb });
    }
    kb.push(row);
  }
  if (p.kind !== 'enum') {
    kb.push([{ text: '\u270F\uFE0F Custom value...', callback_data: (pairScope ? 'dc:' + scope.pair : 'dca') + ':' + ind.id + ':' + p.key }]);
  }
  kb.push([{ text: '\u2B05\uFE0F Back', callback_data: backCb }]);
  return { text: lines.join('\n'), kb };
}

export function tfDropdownView(cfg, scope, backCb) {
  const pairScope = scope.kind === 'pair';
  const cur = pairScope
    ? (cfg.pairs[scope.pair] ? cfg.pairs[scope.pair].timeframe : undefined)
    : aggParam(cfg, { id: 'x' }, { key: 'timeframe', path: 'pair' }).value;
  const target = pairScope ? scope.pair : 'ALL pairs';
  const lines = [
    '\u23F1 Timeframe ' + DRP,
    target + ' current: ' + (cur || '?'),
  ];
  if (!pairScope && cur === MIXED) lines.push('Timeframes differ per pair \u2014 picking below sets EVERY pair.');
  const kb = CONFIG.UTBOT.TIMEFRAMES.map(tf => [{
    text: (tf === cur ? CUR + ' ' : '') + tf,
    callback_data: (pairScope ? 'ts:' + scope.pair : 'tsa') + ':' + tf,
  }]);
  kb.push([{ text: '\u2B05\uFE0F Back', callback_data: backCb }]);
  return { text: lines.join('\n'), kb };
}

// ── all-pairs settings (mockup's global quick buttons) ───────────────────────

export function allSettingsView(cfg, note) {
  const n = Object.keys(cfg.pairs || {}).length;
  const lines = [
    '\uD83D\uDEE0 All-pairs settings',
    'Applies to every known pair (' + n + ').',
    DIV,
  ];
  const kb = [];
  for (const ind of INDICATORS) {
    const state = aggIndicator(cfg, ind.id);
    const icon = ind.icon || '\uD83D\uDCCA';
    lines.push(icon + ' ' + ind.name + ': ' + indStateText(state));
    kb.push([{ text: icon + ' ' + ind.name + ': ' + indStateText(state), callback_data: 'tga:' + ind.id }]);
    for (const p of (ind.params || [])) {
      const agg = aggParam(cfg, ind, p);
      const pIcon = p.icon || '\u2022';
      lines.push('    ' + pIcon + ' ' + p.label + ': ' + agg.value);
      kb.push([{ text: pIcon + ' ' + p.label + ': ' + agg.value + ' ' + DRP, callback_data: 'dra:' + ind.id + ':' + p.key }]);
    }
  }
  const tfs = new Set(Object.values(cfg.pairs || {}).map(p => p.timeframe));
  const tfv = tfs.size === 1 ? [...tfs][0] : MIXED;
  lines.push('\u23F1 Timeframe: ' + tfv);
  kb.push([{ text: '\u23F1 Timeframe: ' + tfv + ' ' + DRP, callback_data: 'tda' }]);
  lines.push(DIV);
  lines.push(note || 'Changed here = changed everywhere. Per-pair settings live on each pair\'s panel.');
  kb.push([{ text: '\uD83C\uDFE0 Main', callback_data: 'pp' }]);
  return { text: lines.join('\n'), kb };
}

// ── status ───────────────────────────────────────────────────────────────────

export function statusView(cfg, hook) {
  const total = Object.keys(cfg.pairs || {}).length;
  const actives = CATALOG_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled)
    .concat(Object.keys(cfg.pairs).filter(p => !CATALOG_PAIRS.includes(p) && cfg.pairs[p].enabled));
  const lines = [
    '\uD83D\uDCCA FTT Signal Worker \u2014 ' + CONFIG.VERSION,
    'Scan cadence: every 15 minutes | Webhook: ' + hook,
    'Universe: ' + total + ' pairs supported | ' + ON + ' Scanning: ' + actives.length,
    '',
  ];
  const MAX = 25;
  for (const p of actives.slice(0, MAX)) {
    const pc = cfg.pairs[p] || {};
    const indBits = INDICATORS.map(ind => {
      const ic = pc.indicators && pc.indicators[ind.id];
      let params = '';
      if (ind.id === 'utbot') params = ' a=' + pc.a + ' c=' + pc.c;
      if (ind.id === 'mkr' && ic) params = ' ' + ic.kernel + ' x' + ic.bandwidth;
      return ind.id + ' ' + (ic && ic.enabled ? ON : OFF) + params;
    }).join(' | ');
    lines.push(ON + ' ' + pairIcon(p) + ' ' + (pc.timeframe || '?')
      + ' [' + (isCrypto(p) ? 'crypto' : 'forex') + ']  ' + indBits);
  }
  if (actives.length > MAX) lines.push('... and ' + (actives.length - MAX) + ' more active pairs');
  if (actives.length === 0) lines.push('No pairs scanning \u2014 \u2795 Add pair to enable some.');
  lines.push('', (total - actives.length) + ' more pairs available \u2014 \u2795 Add pair / \uD83D\uDD0D Search.');
  return {
    text: lines.join('\n'),
    kb: [
      [{ text: '\uD83D\uDD04 Refresh', callback_data: 'm:status' }],
      [{ text: '\uD83C\uDFE0 Main', callback_data: 'pp' }],
    ],
  };
}

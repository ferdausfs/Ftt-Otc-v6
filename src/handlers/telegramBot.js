/**
 * Telegram bot control panel — TradingView-style settings UI over the SAME
 * config store the scanner reads (utbot:config in SIGNAL_CACHE, written
 * through utbotConfig.js mergePairPatch). Single source of truth: a button
 * press changes what the next 15-minute tick actually scans/computes.
 *
 * UI model (user request: "ui ta emon koro TV te jemon — indicator full
 * panel diya, drop down kore" — like the TradingView settings dialog):
 *   Pair picker   one button per scanned pair (scanning state marked) +
 *                 All ON / All OFF
 *   Pair panel    ONE message per pair listing EVERY input with its current
 *                 value, like the TV indicator settings dialog:
 *                   Scanning: ON/OFF            (tap = flip)
 *                   Timeframe: 15min            (tap = dropdown)
 *                   [x] UT Bot Alerts           (tap = checkbox toggle)
 *                       Key Value (a) = 1       (tap = dropdown)
 *                       ATR Period (c) = 10     (tap = dropdown)
 *                   [x] Multi Kernel Regression (tap = checkbox toggle)
 *                       Kernel = Laplace        (tap = 17-option dropdown)
 *                       Bandwidth = 14          (tap = dropdown)
 *   Dropdowns     rendered from the registry's params[] descriptors — a
 *                 future indicator's inputs become panel-editable with
 *                 ZERO bot-side code.
 *   Status        full live config + push state text view.
 *
 * Everything the user changed stays visible in the panel text, so "ki ki
 * set korsi" is always one glance away.
 *
 * Transport:
 *   POST /api/telegram/webhook  — Telegram calls this. Verified by the
 *               X-Telegram-Bot-Api-Secret-Token header against a secret the
 *               worker itself stores in KV (tg:webhookSecret).
 *   ensureTelegramWebhook() — self-registration: on every scan tick (and
 *               via the one-time /api/telegram/setup endpoint) the worker
 *               compares getWebhookInfo with its own WORKER_URL and calls
 *               setWebhook when needed. No manual token handling required.
 *   /api/telegram/setup?key=... — one-shot bootstrap (setup key written to
 *               KV out-of-band); registers the webhook, seeds the panel
 *               owner from the existing push subscribers, then deletes the
 *               key so it can never be replayed.
 *
 * Access model: the FIRST /start claims the panel for that chat (KV
 * tg:owner); /api/telegram/setup pre-claims it for the existing
 * auto-enabled push subscriber. Every other chat is read nothing.
 *
 * Messages stay plain text (NO parse_mode) — same Telegram 400-safety as
 * the signal push path. Button state markers are plain unicode glyphs.
 */

import { CONFIG, SCAN_PAIRS, ASSET_TYPE } from '../config.js';
import { sanitizePair, getAssetType } from '../utils/pairs.js';
import { INDICATORS, INDICATOR_BY_ID } from '../strategy/registry.mjs';
import { getUtBotConfig, mergePairPatch } from './utbotConfig.js';
import { botToken, normalizeAutoUsers, isAutoEnabled } from './push.js';
import { scheduledScan, handleSignal } from './scan.js';
import { jsonResponse } from '../utils/helpers.js';

const TG_API = 'https://api.telegram.org';
const KV_OWNER = 'tg:owner';
const KV_HOOK_SECRET = 'tg:webhookSecret';
const KV_SETUP_KEY = 'tg:setupKey';
const KV_AWAIT_PREFIX = 'tg:await:';

// ── Telegram API plumbing ────────────────────────────────────────────────────

async function tgCall(env, method, body) {
  const token = botToken(env);
  if (!token) return { ok: false, description: 'no bot token' };
  try {
    const res = await fetch(TG_API + '/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await res.json().catch(() => ({ ok: false, description: 'HTTP ' + res.status }));
    return j;
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

async function sendMessage(env, chatId, text, kb) {
  const body = { chat_id: chatId, text };
  if (kb) body.reply_markup = { inline_keyboard: kb };
  return tgCall(env, 'sendMessage', body);
}

async function editMenu(env, chatId, messageId, text, kb) {
  return tgCall(env, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text,
    reply_markup: { inline_keyboard: kb },
  });
}

async function answerCb(env, cbId, text) {
  const body = { callback_query_id: cbId };
  if (text) body.text = String(text).slice(0, 200);
  return tgCall(env, 'answerCallbackQuery', body);
}

// ── access control ───────────────────────────────────────────────────────────

async function getOwner(env) {
  try { return env.SIGNAL_CACHE ? await env.SIGNAL_CACHE.get(KV_OWNER) : null; }
  catch (e) { return null; }
}

async function isOwnerChat(env, chatId) {
  const o = await getOwner(env);
  return !!o && String(o) === String(chatId);
}

// ── small helpers ────────────────────────────────────────────────────────────

const ON = '\u25CF';    // filled circle  — enabled
const OFF = '\u25CB';   // hollow circle  — disabled
const CUR = '\u203A';   // single right-angle quote — current selection
const CHECK_ON = '\u2611';   // ballot box with check — input enabled (TV checkbox)
const CHECK_OFF = '\u2610';  // empty ballot box      — input disabled
const DRP = '\u25BE';        // small down triangle — marks dropdown buttons

function isCrypto(pair) { return getAssetType(pair) === ASSET_TYPE.CRYPTO; }

/** Pairs a scope value covers. Returns null for an unknown scope. */
function scopeTargets(scope) {
  if (scope === 'all') return SCAN_PAIRS.slice();
  const pair = sanitizePair(scope);
  if (!pair || !SCAN_PAIRS.includes(pair)) return null;
  return [pair];
}

function scopeLabel(scope) {
  return scope === 'all' ? 'all pairs' : scope;
}

/** Current value of one registry param for one pair (null when unset). */
function paramValue(pairCfg, indId, p) {
  if (!pairCfg) return undefined;
  return p.path === 'ind'
    ? (pairCfg.indicators && pairCfg.indicators[indId] ? pairCfg.indicators[indId][p.key] : undefined)
    : pairCfg[p.key];
}

// ── TV-style views ──────────────────────────────────────────────────────────
// The panel mimics the TradingView indicator settings dialog: ONE message
// per pair listing EVERY input with its current value; tapping an input
// opens a dropdown (option list, current value marked) in the same message.
// The user always sees the complete state in one screen.

const DIV = '--------------------------------';

/** Pair picker = the menu root. State marker shows scanning on/off. */
function pairPickerView(cfg, note) {
  const nOn = SCAN_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled).length;
  const text = [
    'FTT panel - ' + CONFIG.VERSION,
    'Scanning: ' + nOn + '/' + SCAN_PAIRS.length + ' pairs every 15 minutes',
    note || 'Tap a pair to open its full settings panel.',
  ].join('\n');
  const kb = [];
  for (let i = 0; i < SCAN_PAIRS.length; i += 2) {
    const row = [];
    const mk = p => (cfg.pairs[p] && cfg.pairs[p].enabled ? ON : OFF) + ' ' + p;
    row.push({ text: mk(SCAN_PAIRS[i]), callback_data: 'P:' + SCAN_PAIRS[i] });
    if (SCAN_PAIRS[i + 1]) row.push({ text: mk(SCAN_PAIRS[i + 1]), callback_data: 'P:' + SCAN_PAIRS[i + 1] });
    kb.push(row);
  }
  kb.push([
    { text: 'All ON', callback_data: 'pa:on' },
    { text: 'All OFF', callback_data: 'pa:off' },
  ]);
  kb.push([
    { text: 'Status', callback_data: 'm:status' },
    { text: 'Refresh', callback_data: 'pp' },
  ]);
  return { text, kb };
}

function fmtVal(v) { return (v === undefined || v === null) ? 'default' : String(v); }

/**
 * The full per-pair settings panel — every indicator, every input, current
 * values inline (text) AND as buttons (dropdowns). This is the one screen
 * that answers "ki ki set korsi" at a glance.
 */
function pairPanelView(cfg, pair, note) {
  const pc = cfg.pairs[pair] || {};
  const lines = [
    'SETTINGS - ' + pair + (isCrypto(pair) ? '  [crypto]' : '  [forex]'),
    'Scanning: ' + (pc.enabled ? 'ON' : 'OFF') + ' | Timeframe: ' + (pc.timeframe || '?'),
    DIV,
  ];
  const kb = [
    [{ text: 'Scanning: ' + (pc.enabled ? 'ON' : 'OFF'), callback_data: 'pt:' + pair }],
    [{ text: 'Timeframe: ' + (pc.timeframe || '?') + ' ' + DRP, callback_data: 'td:' + pair }],
  ];
  for (const ind of INDICATORS) {
    const ic = pc.indicators && pc.indicators[ind.id];
    const on = !!(ic && ic.enabled);
    lines.push((on ? CHECK_ON : CHECK_OFF) + ' ' + ind.name);
    kb.push([{ text: (on ? CHECK_ON : CHECK_OFF) + ' ' + ind.name, callback_data: 'tg:' + pair + ':' + ind.id }]);
    for (const p of (ind.params || [])) {
      const v = fmtVal(paramValue(pc, ind.id, p));
      lines.push('    ' + p.label + ' = ' + v);
      kb.push([{ text: '    ' + p.label + ': ' + v + ' ' + DRP, callback_data: 'dr:' + pair + ':' + ind.id + ':' + p.key }]);
    }
  }
  lines.push(DIV);
  lines.push('Tap a line to change it.' + (note ? ' ' + note : ''));
  kb.push([
    { text: 'Change pair', callback_data: 'pp' },
    { text: 'Refresh', callback_data: 'P:' + pair },
  ]);
  kb.push([{ text: 'Status', callback_data: 'm:status' }]);
  return { text: lines.join('\n'), kb };
}

/** Dropdown for one input: every allowed option, current one marked. */
function paramDropdownView(cfg, pair, ind, p) {
  const curStr = fmtVal(paramValue(cfg.pairs[pair], ind.id, p));
  const text = [
    ind.name + ' - ' + p.label + ' ' + DRP,
    pair + ' current: ' + curStr,
  ].concat(p.kind === 'enum' ? [] : ['Allowed range: ' + p.min + ' to ' + p.max
    + (p.kind === 'int' ? ' (whole number)' : '')]).join('\n');
  const kb = [];
  const options = p.kind === 'enum' ? (p.options || []) : (p.presets || []);
  for (const opt of options) {
    const isCur = opt === curStr || Number(opt) === Number(curStr);
    kb.push([{ text: (isCur ? CUR + ' ' : '') + opt, callback_data: 'dv:' + pair + ':' + ind.id + ':' + p.key + ':' + opt }]);
  }
  if (p.kind !== 'enum') {
    kb.push([{ text: 'Custom value...', callback_data: 'dc:' + pair + ':' + ind.id + ':' + p.key }]);
  }
  kb.push([{ text: 'Back to panel', callback_data: 'P:' + pair }]);
  return { text, kb };
}

/** Timeframe dropdown for one pair. */
function tfDropdownView(cfg, pair) {
  const cur = cfg.pairs[pair] && cfg.pairs[pair].timeframe;
  const text = 'Timeframe ' + DRP + '\n' + pair + ' current: ' + (cur || '?');
  const kb = CONFIG.UTBOT.TIMEFRAMES.map(tf => [{
    text: (tf === cur ? CUR + ' ' : '') + tf,
    callback_data: 'ts:' + pair + ':' + tf,
  }]);
  kb.push([{ text: 'Back to panel', callback_data: 'P:' + pair }]);
  return { text, kb };
}

async function statusView(env, cfg) {
  let hook = 'unknown';
  try {
    const info = await tgCall(env, 'getWebhookInfo', {});
    if (info && info.ok) {
      hook = info.result && info.result.url ? 'registered'
        : 'NOT registered (send /menu after the next tick or call setup)';
      if (info.result && info.result.last_error_message) hook += ' | last error: ' + info.result.last_error_message;
    }
  } catch (e) { /* keep unknown */ }
  let subs = 0;
  try {
    if (env.BOT_KV) {
      const ids = normalizeAutoUsers(await env.BOT_KV.get('auto_users', 'json'));
      subs = ids.length;
    }
  } catch (e) { /* keep 0 */ }
  const owner = await getOwner(env);
  const lines = [
    'FTT Signal Worker - ' + CONFIG.VERSION,
    'Scan cadence: every 15 minutes | Webhook: ' + hook,
    'Panel owner: ' + (owner ? owner : 'UNCLAIMED (send /start)'),
    'Signal push subscribers: ' + subs,
    '',
    'Pairs and indicators:',
  ];
  for (const p of SCAN_PAIRS) {
    const pc = cfg.pairs[p] || {};
    const indBits = INDICATORS.map(ind => {
      const ic = pc.indicators && pc.indicators[ind.id];
      const on = ic && ic.enabled ? ON : OFF;
      let params = '';
      if (ind.id === 'utbot') params = ' a=' + pc.a + ' c=' + pc.c;
      if (ind.id === 'mkr' && ic) params = ' ' + ic.kernel + ' x' + ic.bandwidth;
      return ind.id + ' ' + on + params;
    }).join(' | ');
    lines.push((pc.enabled ? ON : OFF) + ' ' + p + ' ' + (pc.timeframe || '?')
      + ' [' + (isCrypto(p) ? 'crypto' : 'forex') + ']  ' + indBits);
  }
  return {
    text: lines.join('\n'),
    kb: [
      [{ text: 'Refresh', callback_data: 'm:status' }],
      [{ text: 'Main', callback_data: 'm:main' }],
    ],
  };
}

// ── config actions (all funnel through mergePairPatch) ──────────────────────

async function togglePairScan(env, pair) {
  const cfg = await getUtBotConfig(env);
  const cur = !!(cfg.pairs[pair] && cfg.pairs[pair].enabled);
  const r = await mergePairPatch(env, { [pair]: { enabled: !cur } });
  return r.ok ? { ok: true, on: !cur, toast: pair + ': scanning ' + (!cur ? 'ON' : 'OFF') } : r;
}

async function setAllPairsScan(env, on) {
  const patch = {};
  for (const p of SCAN_PAIRS) patch[p] = { enabled: on };
  const r = await mergePairPatch(env, patch);
  return r.ok ? { ok: true, toast: 'All pairs: scanning ' + (on ? 'ON' : 'OFF') } : r;
}

async function toggleIndicator(env, scope, indId) {
  const ind = INDICATOR_BY_ID[indId];
  if (!ind) return { ok: false, error: 'unknown indicator' };
  const targets = scopeTargets(scope);
  if (!targets) return { ok: false, error: 'unknown scope' };
  const cfg = await getUtBotConfig(env);
  let next;
  if (scope === 'all') {
    const onCount = SCAN_PAIRS.filter(p => {
      const ic = cfg.pairs[p] && cfg.pairs[p].indicators && cfg.pairs[p].indicators[indId];
      return ic && ic.enabled;
    }).length;
    next = onCount !== SCAN_PAIRS.length;   // any OFF -> turn ALL on; all on -> turn all off
  } else {
    const ic = cfg.pairs[scope] && cfg.pairs[scope].indicators && cfg.pairs[scope].indicators[indId];
    next = !(ic && ic.enabled);
  }
  const patch = {};
  for (const t of targets) patch[t] = { indicators: { [indId]: { enabled: next } } };
  const r = await mergePairPatch(env, patch);
  if (!r.ok) return r;
  const toast = ind.name + ': ' + (next ? 'ON' : 'OFF') + ' - ' + scopeLabel(scope)
    + (scope === 'all' ? ' (' + targets.length + ' pairs)' : '');
  return { ok: true, toast };
}

/** Validate + apply one registry param against a scope. */
async function setParam(env, indId, scope, key, rawValue) {
  const ind = INDICATOR_BY_ID[indId];
  if (!ind) return { ok: false, error: 'unknown indicator' };
  const targets = scopeTargets(scope);
  if (!targets) return { ok: false, error: 'unknown scope' };
  const p = (ind.params || []).find(x => x.key === key);
  if (!p) return { ok: false, error: 'unknown parameter' };

  let value = rawValue;
  if (p.kind === 'enum') {
    if (!p.options || !p.options.includes(rawValue)) {
      return { ok: false, error: p.label + ': "' + rawValue + '" is not one of the ' + p.options.length + ' options' };
    }
  } else {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) return { ok: false, error: p.label + ': "' + rawValue + '" is not a number' };
    if (p.kind === 'int' && !Number.isInteger(n)) return { ok: false, error: p.label + ': must be a whole number' };
    if (n < p.min || n > p.max) return { ok: false, error: p.label + ': must be between ' + p.min + ' and ' + p.max };
    value = n;
  }

  const patch = {};
  for (const t of targets) {
    patch[t] = p.path === 'ind'
      ? { indicators: { [indId]: { [key]: value } } }
      : { [key]: value };
  }
  const r = await mergePairPatch(env, patch);
  if (!r.ok) return r;
  return { ok: true, value, toast: p.label + ' = ' + value + ' - ' + scopeLabel(scope) };
}

async function setTimeframe(env, scope, tf) {
  const targets = scopeTargets(scope);
  if (!targets) return { ok: false, error: 'unknown scope' };
  if (!CONFIG.UTBOT.TIMEFRAMES.includes(tf)) {
    return { ok: false, error: 'timeframe must be one of: ' + CONFIG.UTBOT.TIMEFRAMES.join(', ') };
  }
  const patch = {};
  for (const t of targets) patch[t] = { timeframe: tf };
  const r = await mergePairPatch(env, patch);
  return r.ok ? { ok: true, toast: 'Timeframe = ' + tf + ' - ' + scopeLabel(scope) } : r;
}

// ── custom-value input flow ─────────────────────────────────────────────────

async function requestCustomInput(env, chatId, msgId, pair, indId, key) {
  const ind = INDICATOR_BY_ID[indId];
  const p = ind && (ind.params || []).find(x => x.key === key);
  if (!ind || !p || p.kind === 'enum') return { ok: false, error: 'no numeric parameter' };
  const rec = {
    v: 2, pair, indId, key, label: p.label, kind: p.kind, min: p.min, max: p.max, msgId,
    at: new Date().toISOString(),
  };
  await env.SIGNAL_CACHE.put(KV_AWAIT_PREFIX + chatId, JSON.stringify(rec), { expirationTtl: 600 });
  const text = 'Send a number for ' + p.label + ' - ' + pair
    + '\nAllowed range: ' + p.min + ' to ' + p.max + (p.kind === 'int' ? ' (whole number)' : '')
    + '\n/reset to cancel.';
  const kb = [[{ text: 'Back to panel', callback_data: 'P:' + pair }]];
  return { ok: true, text, kb };
}

async function applyCustomInput(env, chatId, text) {
  const raw = await env.SIGNAL_CACHE.get(KV_AWAIT_PREFIX + chatId).catch(() => null);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) {
    await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
    return null;
  }
  if (!rec || !rec.pair || !rec.indId) {
    // Legacy pre-panel record (scope-based): drop it silently.
    await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
    return null;
  }
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  const r = await setParam(env, rec.indId, rec.pair, rec.key, cleaned);
  if (!r.ok) {
    // Keep the pending record so the owner can just send another number.
    return {
      ok: false, rec,
      message: 'Could not set ' + rec.label + ': ' + r.error
        + '\nSend another number or /reset to cancel.',
    };
  }
  await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
  return { ok: true, rec, toast: r.toast };
}

// ── update handlers ─────────────────────────────────────────────────────────

const HELP_TEXT = [
  'Ftt-Otc-v6 bot - commands:',
  '/menu - open the panel (tap a pair to see its full settings panel)',
  '/panel <PAIR> - open one pair settings panel directly (e.g. /panel EUR/USD)',
  '/status - full config + push state',
  '/pairs - pair list (same as /menu)',
  '/scan - scan all enabled pairs now',
  '/scan <PAIR> - scan one pair now (e.g. /scan EUR/USD)',
  '/reset - cancel a pending value input',
  '/id - show this chat id',
  '/help - this text',
  '',
  'The panel works like the TradingView settings dialog: every input for',
  'every indicator is listed with its current value; tap a line and pick',
  'from the dropdown. Signal messages stay exactly what the indicators',
  'print - UT Bot says BUY/SELL, Multi Kernel Regression says UP/DOWN.',
].join('\n');

async function onMessage(env, ctx, msg) {
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    const sp = text.split(/\s+/);
    const cmd = sp[0].split('@')[0].toLowerCase();
    if (cmd === '/start' || cmd === '/menu') {
      const owner = await getOwner(env);
      if (!owner) {
        await env.SIGNAL_CACHE.put(KV_OWNER, chatId);
        const cfg = await getUtBotConfig(env);
        const v = pairPickerView(cfg, 'Panel claimed for this chat. Tap a pair to open its settings panel.');
        await sendMessage(env, chatId, v.text, v.kb);
        return;
      }
      if (String(owner) !== chatId) {
        await sendMessage(env, chatId, 'This panel is private. Ask the bot owner for access.');
        return;
      }
      const cfg = await getUtBotConfig(env);
      const v = pairPickerView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/id') {
      await sendMessage(env, chatId, 'chat id: ' + chatId);
      return;
    }
    if (cmd === '/help' || cmd === '/start@help') {
      await sendMessage(env, chatId, HELP_TEXT);
      return;
    }
    // Everything below is owner-only.
    if (!(await isOwnerChat(env, chatId))) {
      await sendMessage(env, chatId, 'This panel is private. Ask the bot owner for access.');
      return;
    }
    if (cmd === '/status') {
      const cfg = await getUtBotConfig(env);
      const v = await statusView(env, cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/pairs') {
      const cfg = await getUtBotConfig(env);
      const v = pairPickerView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/panel' || cmd === '/indicators' || cmd === '/params' || cmd === '/timeframe') {
      const cfg = await getUtBotConfig(env);
      const arg = cmd === '/panel' ? sp[1] : null;
      let pair = arg ? sanitizePair(arg) : null;
      if (!pair || !SCAN_PAIRS.includes(pair)) {
        pair = SCAN_PAIRS.find(p => cfg.pairs[p] && cfg.pairs[p].enabled) || SCAN_PAIRS[0];
      }
      const v = pairPanelView(cfg, pair,
        cmd === '/panel' ? null : 'Tip: /panel <PAIR> jumps straight to a pair.');
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/reset') {
      await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
      await sendMessage(env, chatId, 'Pending value input cancelled.');
      return;
    }
    if (cmd === '/scan') {
      const arg = sp[1];
      if (arg) {
        const pair = sanitizePair(arg);
        if (!pair || !SCAN_PAIRS.includes(pair)) {
          await sendMessage(env, chatId, 'Unknown pair "' + arg + '". Scanned universe: ' + SCAN_PAIRS.join(', '));
          return;
        }
        await sendMessage(env, chatId, 'Scanning ' + pair + ' now...');
        const res = await handleSignal(pair, env, ctx, {});
        const j = await res.json().catch(() => null);
        if (!j || j.error) {
          await sendMessage(env, chatId, 'Scan failed: ' + ((j && j.message) || 'unknown error'));
          return;
        }
        const s = j.signal || {};
        const lines = [
          'Scan ' + pair + ' (' + (s.timeframe || '?') + ')',
          'Primary decision: ' + (s.finalSignal || 'NO_TRADE'),
          'New indicator events: ' + (s.audit && s.audit.pendingEventCount != null ? s.audit.pendingEventCount : 0),
        ];
        const ind = s.indicators || {};
        if (ind.utbot) lines.push('UT Bot: pos ' + ind.utbot.pos + ', trailing stop ' + ind.utbot.stop);
        if (ind.mkr) lines.push('MKR: ' + ind.mkr.kernel + ' x' + ind.mkr.bandwidth + ', dirUp ' + ind.mkr.dirUp);
        await sendMessage(env, chatId, lines.join('\n'));
        return;
      }
      await sendMessage(env, chatId, 'Full scan started (all enabled pairs). New events arrive as messages.');
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(Promise.resolve().then(() => scheduledScan(env, ctx)).catch(e => console.error('manual scan failed: ' + e.message)));
      } else {
        await scheduledScan(env, ctx).catch(e => console.error('manual scan failed: ' + e.message));
      }
      return;
    }
    await sendMessage(env, chatId, 'Unknown command. ' + HELP_TEXT);
    return;
  }

  // Plain text: custom value input when one is pending, else a hint.
  const pending = await env.SIGNAL_CACHE.get(KV_AWAIT_PREFIX + chatId).catch(() => null);
  if (pending) {
    const r = await applyCustomInput(env, chatId, text);
    if (r && r.ok) {
      await sendMessage(env, chatId, 'Set ' + r.toast);
      const cfg = await getUtBotConfig(env);
      if (cfg.pairs[r.rec.pair]) {
        const v = pairPanelView(cfg, r.rec.pair);
        await editMenu(env, chatId, r.rec.msgId, v.text, v.kb).catch(() => {});
      }
    } else if (r) {
      await sendMessage(env, chatId, r.message);
    }
    return;
  }
  await sendMessage(env, chatId, 'Send /menu to open the panel.');
}

async function onCallback(env, ctx, cb) {
  const data = String(cb.data || '');
  const chatId = String(cb.message.chat.id);
  const msgId = cb.message.message_id;

  const finish = async (text, view, toast) => {
    if (view) await editMenu(env, chatId, msgId, view.text, view.kb).catch(() => {});
    await answerCb(env, cb.id, toast || '').catch(() => {});
  };

  if (!(await isOwnerChat(env, chatId))) {
    await answerCb(env, cb.id, 'Not allowed - send /start first.').catch(() => {});
    return;
  }

  const cfg = await getUtBotConfig(env);
  const parts = data.split(':');
  const op = parts[0];

  // Router ops (callback_data <= 64 bytes everywhere):
  //   m:main | m:status      nav
  //   pp                     pair picker
  //   P:<pair>               full settings panel for one pair
  //   pt:<pair>              toggle pair scanning
  //   pa:on|off              all pairs scanning
  //   tg:<pair>:<indId>      toggle indicator enabled (panel checkbox)
  //   dr:<pair>:<indId>:<key>   open input dropdown
  //   dv:<pair>:<indId>:<key>:<value>   set input value -> back to panel
  //   dc:<pair>:<indId>:<key>   custom numeric input
  //   td:<pair>              timeframe dropdown
  //   ts:<pair>:<tf>         set timeframe -> back to panel
  const pairArg = (i) => sanitizePair(parts[i] || '');

  if (op === 'm') {
    if (parts[1] === 'status') return finish(null, await statusView(env, cfg));
    return finish(null, pairPickerView(cfg));
  }

  if (op === 'pp') return finish(null, pairPickerView(cfg));

  if (op === 'P') {
    const pair = pairArg(1);
    if (!pair || !SCAN_PAIRS.includes(pair)) return finish(null, pairPickerView(cfg), 'Unknown pair');
    return finish(null, pairPanelView(cfg, pair));
  }

  if (op === 'pt') {
    const pair = pairArg(1);
    if (!pair || !SCAN_PAIRS.includes(pair)) return finish(null, pairPickerView(cfg), 'Unknown pair');
    const r = await togglePairScan(env, pair);
    const fresh = await getUtBotConfig(env);
    return finish(null, pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'pa') {
    const r = await setAllPairsScan(env, parts[1] === 'on');
    const fresh = await getUtBotConfig(env);
    return finish(null, pairPickerView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'tg') {
    const pair = pairArg(1);
    const indId = parts[2];
    if (!pair || !SCAN_PAIRS.includes(pair) || !INDICATOR_BY_ID[indId]) {
      return finish(null, pairPickerView(cfg), 'Unknown target');
    }
    const r = await toggleIndicator(env, pair, indId);
    const fresh = await getUtBotConfig(env);
    return finish(null, pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'dr') {
    const pair = pairArg(1);
    const ind = INDICATOR_BY_ID[parts[2]];
    const p = ind && (ind.params || []).find(x => x.key === parts[3]);
    if (!pair || !SCAN_PAIRS.includes(pair) || !ind || !p) {
      return finish(null, pairPickerView(cfg), 'Unknown input');
    }
    return finish(null, paramDropdownView(cfg, pair, ind, p));
  }

  if (op === 'dv') {
    const pair = pairArg(1);
    const indId = parts[2];
    const key = parts[3];
    const value = parts.slice(4).join(':');
    if (!pair || !SCAN_PAIRS.includes(pair) || !INDICATOR_BY_ID[indId]) {
      return finish(null, pairPickerView(cfg), 'Unknown input');
    }
    const r = await setParam(env, indId, pair, key, value);
    const fresh = await getUtBotConfig(env);
    return finish(null, pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'dc') {
    const pair = pairArg(1);
    const indId = parts[2];
    const key = parts[3];
    if (!pair || !SCAN_PAIRS.includes(pair) || !INDICATOR_BY_ID[indId]) {
      return finish(null, pairPickerView(cfg), 'Unknown input');
    }
    const r = await requestCustomInput(env, chatId, msgId, pair, indId, key);
    if (!r.ok) return finish(null, pairPanelView(cfg, pair), r.error);
    return finish(null, { text: r.text, kb: r.kb });
  }

  if (op === 'td') {
    const pair = pairArg(1);
    if (!pair || !SCAN_PAIRS.includes(pair)) return finish(null, pairPickerView(cfg), 'Unknown pair');
    return finish(null, tfDropdownView(cfg, pair));
  }

  if (op === 'ts') {
    const pair = pairArg(1);
    const tf = parts[2];
    if (!pair || !SCAN_PAIRS.includes(pair)) return finish(null, pairPickerView(cfg), 'Unknown pair');
    const r = await setTimeframe(env, pair, tf);
    const fresh = await getUtBotConfig(env);
    return finish(null, pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  // Anything else (buttons from older panel versions still sitting in the
  // chat): land the user on the current picker instead of erroring.
  return finish(null, pairPickerView(cfg, 'This button is from an older panel - tap a pair below.'), 'Menu updated');
}

// ── webhook receiver + registration ─────────────────────────────────────────

/**
 * POST /api/telegram/webhook — verify the secret header, dispatch the
 * update, ALWAYS answer 200 (non-200 makes Telegram retry -> duplicates).
 */
export async function handleTelegramUpdate(request, env, ctx) {
  let expected = null;
  try { expected = env.SIGNAL_CACHE ? await env.SIGNAL_CACHE.get(KV_HOOK_SECRET) : null; }
  catch (e) { expected = null; }
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!expected || got !== expected) return new Response('forbidden', { status: 403 });

  let update = null;
  try { update = await request.json(); } catch (e) { return new Response('ok'); }

  try {
    if (update && update.callback_query && update.callback_query.message) {
      await onCallback(env, ctx, update.callback_query);
    } else if (update && update.message) {
      await onMessage(env, ctx, update.message);
    }
  } catch (e) {
    console.error('telegram update failed: ' + e.message);
  }
  return new Response('ok');
}

/**
 * Self-healing webhook registration. Called on every scan tick: compares
 * Telegram's getWebhookInfo with the worker's own URL and (re)registers
 * with a KV-stored secret token when needed. Never throws.
 */
export async function ensureTelegramWebhook(env, baseOverride) {
  try {
    if (!botToken(env) || !env.SIGNAL_CACHE) return { ok: false, reason: 'missing bot token or KV' };
    const base = String(baseOverride || env.WORKER_URL || '').replace(/\/+$/, '');
    if (!base) return { ok: false, reason: 'no worker URL (set WORKER_URL)' };
    const desired = base + '/api/telegram/webhook';

    let secret = await env.SIGNAL_CACHE.get(KV_HOOK_SECRET).catch(() => null);
    const info = await tgCall(env, 'getWebhookInfo', {});
    const cur = info && info.ok && info.result ? String(info.result.url || '') : null;
    if (cur === desired && secret) {
      return { ok: true, registered: true, url: desired, pending: info.result.pending_update_count };
    }
    if (!secret) {
      secret = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'wh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      await env.SIGNAL_CACHE.put(KV_HOOK_SECRET, secret);
    }
    const r = await tgCall(env, 'setWebhook', {
      url: desired,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
    });
    return r.ok
      ? { ok: true, registered: true, url: desired }
      : { ok: false, error: r.description || 'setWebhook failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * GET/POST /api/telegram/setup?key=<one-time key> — bootstrap endpoint.
 * The setup key is written to KV out-of-band (wrangler/CF API), consumed
 * here exactly once: registers the webhook, seeds the panel owner from the
 * existing auto-enabled push subscriber, notifies the owner, deletes the key.
 */
export async function handleTelegramSetup(request, env) {
  if (!env || !env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'no KV' }, 503);
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || request.headers.get('x-setup-key') || '';
  let expected = null;
  try { expected = await env.SIGNAL_CACHE.get(KV_SETUP_KEY); } catch (e) { expected = null; }
  if (!expected || !key || key !== expected) {
    return jsonResponse({ error: true, message: 'invalid or consumed setup key' }, 403);
  }

  const base = String(env.WORKER_URL || '').replace(/\/+$/, '') || url.origin;
  const wh = await ensureTelegramWebhook(env, base);

  let owner = await env.SIGNAL_CACHE.get(KV_OWNER).catch(() => null);
  let seeded = null;
  if (!owner && env.BOT_KV) {
    try {
      const ids = normalizeAutoUsers(await env.BOT_KV.get('auto_users', 'json'));
      let fallback = null;
      for (const id of ids) {
        const u = await env.BOT_KV.get('u:' + id, 'json').catch(() => null);
        if (!fallback && u) fallback = id;
        if (isAutoEnabled(u)) { seeded = id; break; }
      }
      if (!seeded) seeded = fallback;
      if (seeded) {
        await env.SIGNAL_CACHE.put(KV_OWNER, String(seeded));
        owner = String(seeded);
      }
    } catch (e) { /* seeding is best-effort */ }
  }

  await env.SIGNAL_CACHE.delete(KV_SETUP_KEY).catch(() => {});

  let notified = false;
  if (owner && wh.ok) {
    const r = await sendMessage(env, owner,
      'Bot control panel is live.\nSend /menu to open it - pairs, indicators,'
      + ' params and timeframe are all editable from there.');
    notified = !!(r && r.ok);
  }
  return jsonResponse({ ok: !!wh.ok, webhook: wh, owner: owner || null, ownerSeeded: seeded || null, notified });
}

/** GET /api/telegram/status — public, minimal diagnostics (no secrets). */
export async function handleTelegramStatus(env) {
  const out = {
    ok: true,
    version: CONFIG.VERSION,
    botConfigured: !!botToken(env),
    webhook: null,
    ownerClaimed: false,
    setupKeyPending: false,
    subscribers: [],
  };
  if (!env || !env.SIGNAL_CACHE) return jsonResponse(out);
  try { out.ownerClaimed = !!(await env.SIGNAL_CACHE.get(KV_OWNER)); } catch (e) { /* skip */ }
  try { out.setupKeyPending = !!(await env.SIGNAL_CACHE.get(KV_SETUP_KEY)); } catch (e) { /* skip */ }
  try {
    if (botToken(env)) {
      const info = await tgCall(env, 'getWebhookInfo', {});
      if (info && info.ok && info.result) {
        out.webhook = {
          registered: !!info.result.url,
          pendingUpdateCount: info.result.pending_update_count || 0,
          lastError: info.result.last_error_message || null,
          lastErrorDate: info.result.last_error_date || null,
        };
      }
    }
  } catch (e) { /* skip */ }
  try {
    if (env.BOT_KV) out.subscribers = normalizeAutoUsers(await env.BOT_KV.get('auto_users', 'json'));
  } catch (e) { /* skip */ }
  return jsonResponse(out);
}

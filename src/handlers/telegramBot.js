/**
 * Telegram bot control panel — inline-keyboard UI over the SAME config
 * store the scanner reads (utbot:config in SIGNAL_CACHE, written through
 * utbotConfig.js mergePairPatch). Single source of truth: a button press
 * changes what the next 15-minute tick actually scans/computes.
 *
 * What the panel covers (user request: pairs, indicators, params — all
 * editable from the bot):
 *   Pairs       every pair the worker knows (SCAN_PAIRS) with a scanning
 *               on/off toggle + "all on / all off"
 *   Indicators  per indicator (registry ids) ON/OFF — scope = one pair or
 *               all pairs at once
 *   Params      registry-driven editors: UT Bot a/c, MKR kernel/bandwidth;
 *               a future registry indicator's params become editable with
 *               ZERO bot-side code (menus render from ind.params[])
 *   Timeframe   1min/5min/15min per pair or all pairs
 *   Status      live text view of the whole config + push state
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
const PART = '\u25D0';  // half circle    — partially enabled (all-pairs scope)
const CUR = '\u203A';   // single right-angle quote — current selection

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

/** Formatted "current value" summary across a scope's pairs. */
function paramSummary(cfg, scope, indId, p) {
  const targets = scopeTargets(scope) || [];
  const vals = new Set();
  for (const t of targets) {
    const v = paramValue(cfg.pairs[t], indId, p);
    if (v !== undefined && v !== null) vals.add(String(v));
  }
  if (vals.size === 0) return 'default';
  if (vals.size === 1) return [...vals][0];
  return 'mixed (' + [...vals].slice(0, 4).join(', ') + (vals.size > 4 ? ', ...' : '') + ')';
}

function backRow(targets) { return targets; }

// ── menus (text + inline keyboards) ─────────────────────────────────────────

function mainMenuView(env, cfg, webhookNote) {
  const nOn = SCAN_PAIRS.filter(p => cfg.pairs[p] && cfg.pairs[p].enabled).length;
  const text = [
    'Ftt-Otc-v6 control panel (' + CONFIG.VERSION + ')',
    'Scanning: ' + nOn + '/' + SCAN_PAIRS.length + ' pairs every 15 minutes',
    'Indicators: ' + INDICATORS.map(i => i.name).join(', '),
    webhookNote ? webhookNote : '',
  ].filter(Boolean).join('\n');
  const kb = [
    [{ text: 'Pairs (' + nOn + '/' + SCAN_PAIRS.length + ' scanning)', callback_data: 'm:pairs' }],
    [
      { text: 'Indicators', callback_data: 'm:ind' },
      { text: 'Params', callback_data: 'm:prm' },
    ],
    [
      { text: 'Timeframe', callback_data: 'm:tf' },
      { text: 'Status', callback_data: 'm:status' },
    ],
  ];
  return { text, kb };
}

function pairsMenuView(cfg) {
  const text = [
    'Pairs - tap to toggle scanning',
    'ON = scanned on every tick, OFF = skipped entirely (no fetch).',
  ].join('\n');
  const kb = SCAN_PAIRS.map(p => {
    const on = !!(cfg.pairs[p] && cfg.pairs[p].enabled);
    return [{
      text: (on ? ON : OFF) + ' ' + p + (isCrypto(p) ? '  [crypto]' : '  [forex]'),
      callback_data: 'pt:' + p,
    }];
  });
  kb.push([
    { text: 'All ON', callback_data: 'pa:on' },
    { text: 'All OFF', callback_data: 'pa:off' },
  ]);
  kb.push(backRow([{ text: 'Back', callback_data: 'm:main' }]));
  return { text, kb };
}

function indScopeMenuView() {
  const text = 'Indicators - pick a scope to toggle them on/off.';
  const kb = [[{ text: 'All pairs', callback_data: 'is:all' }]];
  for (let i = 0; i < SCAN_PAIRS.length; i += 2) {
    const row = [{ text: SCAN_PAIRS[i], callback_data: 'is:' + SCAN_PAIRS[i] }];
    if (SCAN_PAIRS[i + 1]) row.push({ text: SCAN_PAIRS[i + 1], callback_data: 'is:' + SCAN_PAIRS[i + 1] });
    kb.push(row);
  }
  kb.push(backRow([{ text: 'Back', callback_data: 'm:main' }]));
  return { text, kb };
}

function indListMenuView(cfg, scope) {
  const text = 'Indicators - ' + scopeLabel(scope)
    + '\nTap an indicator to switch it ON or OFF.';
  const targets = scopeTargets(scope) || [];
  const kb = [];
  for (const ind of INDICATORS) {
    let onCount = 0;
    for (const t of targets) {
      const ic = cfg.pairs[t] && cfg.pairs[t].indicators && cfg.pairs[t].indicators[ind.id];
      if (ic && ic.enabled) onCount++;
    }
    const mark = onCount === 0 ? OFF : onCount === targets.length ? ON : PART;
    const suffix = scope === 'all' ? ' (' + onCount + '/' + targets.length + ')' : (onCount ? '  ON' : '  OFF');
    kb.push([{ text: mark + ' ' + ind.name + suffix, callback_data: 'ir:' + scope + ':' + ind.id }]);
  }
  kb.push(backRow([
    { text: 'Scope', callback_data: 'm:ind' },
    { text: 'Main', callback_data: 'm:main' },
  ]));
  return { text, kb };
}

function paramsRootMenuView() {
  const text = 'Params - pick an indicator to edit its inputs.';
  const kb = INDICATORS.map(ind => [{ text: ind.name, callback_data: 'ps:' + ind.id }]);
  kb.push(backRow([{ text: 'Back', callback_data: 'm:main' }]));
  return { text, kb };
}

function paramsScopeMenuView(ind) {
  const text = 'Params - ' + ind.name + ' - pick a scope.';
  const kb = [[{ text: 'All pairs', callback_data: 'pe:' + ind.id + ':all' }]];
  for (let i = 0; i < SCAN_PAIRS.length; i += 2) {
    const row = [{ text: SCAN_PAIRS[i], callback_data: 'pe:' + ind.id + ':' + SCAN_PAIRS[i] }];
    if (SCAN_PAIRS[i + 1]) row.push({ text: SCAN_PAIRS[i + 1], callback_data: 'pe:' + ind.id + ':' + SCAN_PAIRS[i + 1] });
    kb.push(row);
  }
  kb.push(backRow([{ text: 'Back', callback_data: 'm:prm' }]));
  return { text, kb };
}

function paramEditorMenuView(cfg, ind, scope) {
  const lines = ['Params - ' + ind.name, 'Scope: ' + scopeLabel(scope)];
  for (const p of (ind.params || [])) {
    lines.push(p.label + ': ' + paramSummary(cfg, scope, ind.id, p));
  }
  const kb = [];
  for (const p of (ind.params || [])) {
    if (p.kind === 'enum') {
      const perRow = p.perRow || 1;
      for (let i = 0; i < (p.options || []).length; i += perRow) {
        const row = [];
        for (const opt of (p.options || []).slice(i, i + perRow)) {
          const cur = paramSummary(cfg, scope, ind.id, p);
          row.push({
            text: (cur === opt ? CUR + ' ' : '') + opt,
            callback_data: 'pv:' + ind.id + ':' + scope + ':' + p.key + ':' + opt,
          });
        }
        kb.push(row);
      }
    } else {
      const cur = paramSummary(cfg, scope, ind.id, p);
      const row = (p.presets || []).map(v => ({
        text: (cur === String(v) ? CUR + ' ' : '') + v,
        callback_data: 'pv:' + ind.id + ':' + scope + ':' + p.key + ':' + v,
      }));
      row.push({ text: 'Custom...', callback_data: 'aw:' + ind.id + ':' + scope + ':' + p.key });
      kb.push(row);
    }
  }
  kb.push(backRow([
    { text: 'Scope', callback_data: 'ps:' + ind.id },
    { text: 'Main', callback_data: 'm:main' },
  ]));
  return { text: lines.join('\n'), kb };
}

function tfScopeMenuView() {
  const text = 'Timeframe - pick a scope, then the candle timeframe.';
  const kb = [[{ text: 'All pairs', callback_data: 'tx:all' }]];
  for (let i = 0; i < SCAN_PAIRS.length; i += 2) {
    const row = [{ text: SCAN_PAIRS[i], callback_data: 'tx:' + SCAN_PAIRS[i] }];
    if (SCAN_PAIRS[i + 1]) row.push({ text: SCAN_PAIRS[i + 1], callback_data: 'tx:' + SCAN_PAIRS[i + 1] });
    kb.push(row);
  }
  kb.push(backRow([{ text: 'Back', callback_data: 'm:main' }]));
  return { text, kb };
}

function tfSetMenuView(cfg, scope) {
  const targets = scopeTargets(scope) || [];
  const vals = new Set(targets.map(t => cfg.pairs[t] && cfg.pairs[t].timeframe));
  const cur = vals.size === 1 ? [...vals][0] : 'mixed';
  const text = 'Timeframe - ' + scopeLabel(scope) + ' (current: ' + cur + ')';
  const kb = [CONFIG.UTBOT.TIMEFRAMES.map(tf => ({
    text: (cur === tf ? CUR + ' ' : '') + tf,
    callback_data: 'tset:' + scope + ':' + tf,
  }))];
  kb.push(backRow([{ text: 'Back', callback_data: 'm:tf' }]));
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

async function requestCustomInput(env, chatId, msgId, indId, scope, key) {
  const ind = INDICATOR_BY_ID[indId];
  const p = ind && (ind.params || []).find(x => x.key === key);
  if (!ind || !p || p.kind === 'enum') return { ok: false, error: 'no numeric parameter' };
  const rec = {
    indId, scope, key, label: p.label, kind: p.kind, min: p.min, max: p.max, msgId,
    at: new Date().toISOString(),
  };
  await env.SIGNAL_CACHE.put(KV_AWAIT_PREFIX + chatId, JSON.stringify(rec), { expirationTtl: 600 });
  const text = 'Send a number for ' + p.label + ' - ' + scopeLabel(scope)
    + '\nAllowed range: ' + p.min + ' to ' + p.max + (p.kind === 'int' ? ' (whole number)' : '')
    + '\n/reset to cancel.';
  const kb = [[
    { text: 'Back', callback_data: 'pe:' + indId + ':' + scope },
    { text: 'Main', callback_data: 'm:main' },
  ]];
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
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  const r = await setParam(env, rec.indId, rec.scope, rec.key, cleaned);
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
  '/menu - open the control panel (pairs, indicators, params, timeframe)',
  '/status - full config + push state',
  '/pairs - pair scanning toggles',
  '/indicators - indicator on/off switches',
  '/params - indicator input editors',
  '/timeframe - candle timeframe per pair',
  '/scan - scan all enabled pairs now',
  '/scan <PAIR> - scan one pair now (e.g. /scan EUR/USD)',
  '/reset - cancel a pending value input',
  '/id - show this chat id',
  '/help - this text',
  '',
  'Signal messages stay exactly what the indicators print - UT Bot says',
  'BUY/SELL, Multi Kernel Regression says UP/DOWN. This panel only',
  'controls what gets scanned and computed.',
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
        const v = mainMenuView(env, cfg, 'Panel claimed for this chat.');
        await sendMessage(env, chatId, v.text, v.kb);
        return;
      }
      if (String(owner) !== chatId) {
        await sendMessage(env, chatId, 'This panel is private. Ask the bot owner for access.');
        return;
      }
      const cfg = await getUtBotConfig(env);
      const v = mainMenuView(env, cfg);
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
      const v = pairsMenuView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/indicators') {
      const v = indScopeMenuView();
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/params') {
      const v = paramsRootMenuView();
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/timeframe') {
      const v = tfScopeMenuView();
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
      const ind = INDICATOR_BY_ID[r.rec.indId];
      if (ind) {
        const v = paramEditorMenuView(cfg, ind, r.rec.scope);
        await editMenu(env, chatId, r.rec.msgId, v.text, v.kb).catch(() => {});
      }
    } else if (r) {
      await sendMessage(env, chatId, r.message);
    }
    return;
  }
  await sendMessage(env, chatId, 'Send /menu to open the control panel.');
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

  if (op === 'm') {
    const which = parts[1];
    if (which === 'main') return finish(null, mainMenuView(env, cfg));
    if (which === 'pairs') return finish(null, pairsMenuView(cfg));
    if (which === 'ind') return finish(null, indScopeMenuView());
    if (which === 'prm') return finish(null, paramsRootMenuView());
    if (which === 'tf') return finish(null, tfScopeMenuView());
    if (which === 'status') return finish(null, await statusView(env, cfg));
    return finish(null, mainMenuView(env, cfg), 'Unknown section');
  }

  if (op === 'pt') {
    const pair = sanitizePair(parts[1] || '');
    if (!pair || !SCAN_PAIRS.includes(pair)) return finish(null, pairsMenuView(cfg), 'Unknown pair');
    const r = await togglePairScan(env, pair);
    const fresh = await getUtBotConfig(env);
    return finish(null, pairsMenuView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'pa') {
    const r = await setAllPairsScan(env, parts[1] === 'on');
    const fresh = await getUtBotConfig(env);
    return finish(null, pairsMenuView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'is') {
    const scope = parts.slice(1).join(':');
    if (!scopeTargets(scope)) return finish(null, indScopeMenuView(), 'Unknown scope');
    return finish(null, indListMenuView(cfg, scope));
  }

  if (op === 'ir') {
    const indId = parts[parts.length - 1];
    const scope = parts.slice(1, parts.length - 1).join(':');
    const r = await toggleIndicator(env, scope, indId);
    const fresh = await getUtBotConfig(env);
    return finish(null, indListMenuView(fresh, scope), r.ok ? r.toast : r.error);
  }

  if (op === 'ps') {
    const ind = INDICATOR_BY_ID[parts[1]];
    if (!ind) return finish(null, paramsRootMenuView(), 'Unknown indicator');
    return finish(null, paramsScopeMenuView(ind));
  }

  if (op === 'pe') {
    const ind = INDICATOR_BY_ID[parts[1]];
    const scope = parts.slice(2).join(':');
    if (!ind || !scopeTargets(scope)) return finish(null, paramsRootMenuView(), 'Unknown editor');
    return finish(null, paramEditorMenuView(cfg, ind, scope));
  }

  if (op === 'pv') {
    const indId = parts[1];
    const scope = parts[2];
    const key = parts[3];
    const value = parts.slice(4).join(':');
    const r = await setParam(env, indId, scope, key, value);
    const fresh = await getUtBotConfig(env);
    const ind = INDICATOR_BY_ID[indId];
    const view = ind && scopeTargets(scope) ? paramEditorMenuView(fresh, ind, scope) : paramsRootMenuView();
    return finish(null, view, r.ok ? r.toast : r.error);
  }

  if (op === 'aw') {
    const indId = parts[1];
    const scope = parts[2];
    const key = parts[3];
    const r = await requestCustomInput(env, chatId, msgId, indId, scope, key);
    if (!r.ok) return finish(null, paramsRootMenuView(), r.error);
    return finish(null, { text: r.text, kb: r.kb });
  }

  if (op === 'tx') {
    const scope = parts.slice(1).join(':');
    if (!scopeTargets(scope)) return finish(null, tfScopeMenuView(), 'Unknown scope');
    return finish(null, tfSetMenuView(cfg, scope));
  }

  if (op === 'tset') {
    const scope = parts[1];
    const tf = parts[2];
    const r = await setTimeframe(env, scope, tf);
    const fresh = await getUtBotConfig(env);
    return finish(null, tfSetMenuView(fresh, scope), r.ok ? r.toast : r.error);
  }

  return finish(null, mainMenuView(env, cfg), 'Unknown action');
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

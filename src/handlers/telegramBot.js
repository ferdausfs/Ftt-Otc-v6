/**
 * Telegram bot control panel — premium TradingView-style UI (v1.5.0 mockup
 * redesign) over the SAME config store the scanner reads (utbot:config in
 * SIGNAL_CACHE, written through utbotConfig.js mergePairPatch). Single
 * source of truth: a button press changes what the next 15-minute tick
 * actually scans/computes.
 *
 * UI model (mockup "Ftt Panel — MULTI-IND"): dropdown-style screens with
 * explicit state everywhere — nothing is ever a bare glyph:
 *   Main menu       active-pair grid + ➕ Add pair + 🔍 Search pair +
 *                   🛠 All-pairs settings + Status/Refresh
 *   Select Pair     categories (Active / Majors / Minors / Exotics / Crypto),
 *                   ✅ marks scanning pairs; tap a pair -> its panel
 *   🔍 Search       type "eurusd" -> EUR/USD surfaces (any supported pair,
 *                   including non-catalog ones like USD/INR)
 *   Pair panel      ⚙️ SETTINGS - <pair>: Scanning toggle, Timeframe ▾, every
 *                   indicator + every input with its CURRENT value on the
 *                   line; tap a line -> dropdown with the active option ✅
 *   All-pairs       the mockup's global quick buttons (UT Bot, Key Value,
 *                   ATR, Kernel, Bandwidth, Timeframe) applied everywhere
 *   ⚡ Scan now      instant per-pair evaluation from the panel
 *
 * Views live in botViews.js, config writes in botActions.js — this file is
 * transport (webhook + self-registration + one-time setup) and routing.
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
 * auto-enabled push subscriber. Every other chat reads nothing.
 *
 * Messages stay plain text (NO parse_mode) — same Telegram 400-safety as
 * the signal push path.
 */

import { CONFIG } from '../config.js';
import { sanitizePair } from '../utils/pairs.js';
import { isKnownPair, searchPairs, CATALOG_PAIRS } from '../utils/pairCatalog.js';
import { INDICATOR_BY_ID } from '../strategy/registry.mjs';
import { getUtBotConfig } from './utbotConfig.js';
import { botToken, normalizeAutoUsers, isAutoEnabled } from './push.js';
import { scheduledScan, scanOnePair } from './scan.js';
import { jsonResponse } from '../utils/helpers.js';
import {
  mainMenuView, categoriesView, categoryListView, searchPromptView, searchResultsView,
  pairPanelView, paramDropdownView, tfDropdownView, allSettingsView, statusView,
} from './botViews.js';
import {
  togglePairScan, setAllPairsScan, toggleIndicator, setParam, setTimeframe,
  requestParamInput, applyParamInput, requestPairSearch, applyPairSearch,
} from './botActions.js';

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

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve a user-typed pair argument: "EUR/USD", "eurusd", "btc"... */
function resolvePairArg(arg) {
  if (!arg) return null;
  const direct = sanitizePair(arg);
  if (direct && isKnownPair(direct)) return direct;
  const matches = searchPairs(arg, 1);
  return matches.length === 1 ? matches[0] : null;
}

/** Webhook state line for the status screen. */
async function webhookState(env) {
  try {
    const info = await tgCall(env, 'getWebhookInfo', {});
    if (info && info.ok) {
      let s = info.result && info.result.url ? 'registered' : 'NOT registered (send /menu after the next tick or call setup)';
      if (info.result && info.result.last_error_message) s += ' | last error: ' + info.result.last_error_message;
      return s;
    }
  } catch (e) { /* keep unknown */ }
  return 'unknown';
}

const HELP_TEXT = [
  'Ftt-Otc-v6 bot - commands:',
  '/menu - open the panel (premium TV-style UI)',
  '/panel <PAIR> - one pair settings panel (e.g. /panel eurusd)',
  '/pairs - Select Pair: all supported pairs by category',
  '/find <name> - search pairs (e.g. /find gbpjpy)',
  '/all - all-pairs settings (apply a value everywhere)',
  '/status - full config + push state',
  '/scan - scan all enabled pairs now',
  '/scan <PAIR> - scan one pair now (preview if disabled)',
  '/reset - cancel a pending input',
  '/id - show this chat id',
  '/help - this text',
  '',
  'Every pair panel lists ALL inputs with their current values; tap a line,',
  'pick from the dropdown, done. Search understands "eurusd" style names.',
].join('\n');

// ── message handler ──────────────────────────────────────────────────────────

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
        const v = mainMenuView(cfg, 'Panel claimed for this chat. \u2795 Add pair shows all ' + CATALOG_PAIRS.length + '+ pairs.');
        await sendMessage(env, chatId, v.text, v.kb);
        return;
      }
      if (String(owner) !== chatId) {
        await sendMessage(env, chatId, 'This panel is private. Ask the bot owner for access.');
        return;
      }
      const cfg = await getUtBotConfig(env);
      const v = mainMenuView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/id') {
      await sendMessage(env, chatId, 'chat id: ' + chatId);
      return;
    }
    if (cmd === '/help') {
      await sendMessage(env, chatId, HELP_TEXT);
      return;
    }
    // Everything below is owner-only.
    if (!(await isOwnerChat(env, chatId))) {
      await sendMessage(env, chatId, 'This panel is private. Ask the bot owner for access.');
      return;
    }
    const cfg = await getUtBotConfig(env);
    if (cmd === '/status') {
      const v = statusView(cfg, await webhookState(env));
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/pairs') {
      const v = categoriesView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/all') {
      const v = allSettingsView(cfg);
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/find') {
      const q = sp.slice(1).join(' ');
      if (!q) {
        const r = await requestPairSearch(env, chatId, null);
        const v = r && r.ok ? searchPromptView() : null;
        if (v) { await sendMessage(env, chatId, v.text, v.kb); return; }
      } else {
        const matches = searchPairs(q, 12);
        const v = searchResultsView(q, matches, cfg);
        await sendMessage(env, chatId, v.text, v.kb);
        return;
      }
    }
    if (cmd === '/panel') {
      let pair = resolvePairArg(sp[1]);
      if (!pair) pair = CATALOG_PAIRS.find(p => cfg.pairs[p] && cfg.pairs[p].enabled) || CATALOG_PAIRS[0];
      const v = pairPanelView(cfg, pair, sp[1] ? null : 'Tip: /panel eurusd jumps straight to a pair.');
      await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
    if (cmd === '/reset') {
      await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
      await sendMessage(env, chatId, 'Pending input cancelled.');
      return;
    }
    if (cmd === '/scan') {
      const arg = sp[1];
      if (arg) {
        const pair = resolvePairArg(arg);
        if (!pair) {
          await sendMessage(env, chatId, 'Unknown pair "' + arg + '". Try /find ' + arg + ' or /pairs.');
          return;
        }
        const pc = cfg.pairs[pair] || {};
        await sendMessage(env, chatId, '\u26A1 Scanning ' + pair + ' now...');
        const result = await scanOnePair(pair, 'bot_' + Date.now().toString(36), env, ctx,
          { force: true, noPush: pc.enabled !== true });
        if (!result) {
          await sendMessage(env, chatId, 'Scan failed for ' + pair + ' (fetch error or market closed).');
          return;
        }
        const s = result.signal || {};
        const lines = [
          '\u26A1 Scan ' + pair + ' (' + (s.timeframe || '?') + ')',
          'Primary decision: ' + (s.finalSignal || 'NO_TRADE'),
          'New indicator events: ' + (s.audit && s.audit.pendingEventCount != null ? s.audit.pendingEventCount : 0),
        ];
        const ind = s.indicators || {};
        if (ind.utbot) lines.push('UT Bot: pos ' + ind.utbot.pos + ', trailing stop ' + ind.utbot.stop);
        if (ind.mkr) lines.push('MKR: ' + ind.mkr.kernel + ' x' + ind.mkr.bandwidth + ', dirUp ' + ind.mkr.dirUp);
        if (pc.enabled !== true) lines.push('(preview only \u2014 pair is not scanning, nothing was pushed)');
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

  // Plain text: pending flows first (search, then custom numeric value).
  let pending = null;
  try { pending = await env.SIGNAL_CACHE.get(KV_AWAIT_PREFIX + chatId); } catch (e) { pending = null; }
  let rec = null;
  if (pending) { try { rec = JSON.parse(pending); } catch (e) { rec = null; } }

  if (rec && rec.t === 'search') {
    const r = await applyPairSearch(env, chatId, text, await getUtBotConfig(env));
    if (r) {
      const cfg = await getUtBotConfig(env);
      const v = searchResultsView(r.query, r.matches, cfg);
      if (rec.msgId) await editMenu(env, chatId, rec.msgId, v.text, v.kb).catch(() => {});
      else await sendMessage(env, chatId, v.text, v.kb);
      return;
    }
  }

  if (pending) {
    const r = await applyParamInput(env, chatId, text);
    if (r && r.ok) {
      await sendMessage(env, chatId, 'Set ' + r.toast);
      const cfg = await getUtBotConfig(env);
      if (cfg.pairs[r.rec.pair]) {
        const v = r.rec.pair === 'all' ? allSettingsView(cfg) : pairPanelView(cfg, r.rec.pair);
        await editMenu(env, chatId, r.rec.msgId, v.text, v.kb).catch(() => {});
      }
      return;
    }
    if (r) {
      await sendMessage(env, chatId, r.message);
      return;
    }
  }
  await sendMessage(env, chatId, 'Send /menu to open the panel.');
}

// ── callback router ──────────────────────────────────────────────────────────

async function onCallback(env, ctx, cb) {
  const data = String(cb.data || '');
  const chatId = String(cb.message.chat.id);
  const msgId = cb.message.message_id;

  const finish = async (view, toast) => {
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
  const pairArg = (i) => sanitizePair(parts[i] || '');

  // Router ops (callback_data <= 64 bytes everywhere):
  //   pp | m:main | m:status          nav (main menu / status)
  //   cat | cat:<id>                  Select Pair categories / one category
  //   srch                            arm pair-search input
  //   as                              all-pairs settings screen
  //   P:<pair>                        full settings panel for one pair
  //   pt:<pair>                       toggle pair scanning
  //   pa:on|off                       all pairs scanning
  //   tg:<pair>:<indId>               toggle indicator (pair checkbox)
  //   dr:/dv:/dc:                     pair dropdown / set value / custom input
  //   td:<pair> / ts:<pair>:<tf>      timeframe dropdown / set
  //   tga:<indId>                     toggle indicator on ALL pairs
  //   dra:/dva:/dca:                  all-pairs dropdown / set / custom input
  //   tda / tsa:<tf>                  all-pairs timeframe dropdown / set
  //   sc:<pair>                       scan this pair right now
  const pairOk = (pair) => pair && isKnownPair(pair);
  const backToPanel = (pair) => 'P:' + pair;

  if (op === 'm') {
    if (parts[1] === 'status') return finish(await statusView(cfg, await webhookState(env)));
    return finish(mainMenuView(cfg));
  }

  if (op === 'pp') return finish(mainMenuView(cfg));

  if (op === 'cat') {
    if (!parts[1]) return finish(categoriesView(cfg));
    return finish(categoryListView(cfg, parts[1]));
  }

  if (op === 'srch') {
    const r = await requestPairSearch(env, chatId, msgId);
    if (!r || !r.ok) return finish(mainMenuView(cfg), 'Search unavailable');
    return finish(searchPromptView());
  }

  if (op === 'as') return finish(allSettingsView(cfg));

  if (op === 'P') {
    const pair = pairArg(1);
    if (!pairOk(pair)) return finish(mainMenuView(cfg), 'Unknown pair');
    return finish(pairPanelView(cfg, pair));
  }

  if (op === 'pt') {
    const pair = pairArg(1);
    if (!pairOk(pair)) return finish(mainMenuView(cfg), 'Unknown pair');
    const r = await togglePairScan(env, pair);
    const fresh = await getUtBotConfig(env);
    return finish(pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'pa') {
    const r = await setAllPairsScan(env, parts[1] === 'on');
    const fresh = await getUtBotConfig(env);
    return finish(mainMenuView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'tg') {
    const pair = pairArg(1);
    const indId = parts[2];
    if (!pairOk(pair) || !INDICATOR_BY_ID[indId]) return finish(mainMenuView(cfg), 'Unknown target');
    const r = await toggleIndicator(env, pair, indId);
    const fresh = await getUtBotConfig(env);
    return finish(pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'dr') {
    const pair = pairArg(1);
    const ind = INDICATOR_BY_ID[parts[2]];
    const p = ind && (ind.params || []).find(x => x.key === parts[3]);
    if (!pairOk(pair) || !ind || !p) return finish(mainMenuView(cfg), 'Unknown input');
    return finish(paramDropdownView(cfg, ind, p, { kind: 'pair', pair }, backToPanel(pair)));
  }

  if (op === 'dv') {
    const pair = pairArg(1);
    const indId = parts[2];
    const key = parts[3];
    const value = parts.slice(4).join(':');
    if (!pairOk(pair) || !INDICATOR_BY_ID[indId]) return finish(mainMenuView(cfg), 'Unknown input');
    const r = await setParam(env, indId, pair, key, value);
    const fresh = await getUtBotConfig(env);
    return finish(pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  if (op === 'dc') {
    const pair = pairArg(1);
    const indId = parts[2];
    const key = parts[3];
    if (!pairOk(pair) || !INDICATOR_BY_ID[indId]) return finish(mainMenuView(cfg), 'Unknown input');
    const r = await requestParamInput(env, chatId, msgId, pair, indId, key);
    if (!r.ok) return finish(pairPanelView(cfg, pair), r.error);
    return finish({ text: r.text, kb: r.kb });
  }

  if (op === 'td') {
    const pair = pairArg(1);
    if (!pairOk(pair)) return finish(mainMenuView(cfg), 'Unknown pair');
    return finish(tfDropdownView(cfg, { kind: 'pair', pair }, backToPanel(pair)));
  }

  if (op === 'ts') {
    const pair = pairArg(1);
    const tf = parts[2];
    if (!pairOk(pair)) return finish(mainMenuView(cfg), 'Unknown pair');
    const r = await setTimeframe(env, pair, tf);
    const fresh = await getUtBotConfig(env);
    return finish(pairPanelView(fresh, pair), r.ok ? r.toast : r.error);
  }

  // ── all-pairs (scope 'all') ops ────────────────────────────────────────────
  if (op === 'tga') {
    const indId = parts[1];
    if (!INDICATOR_BY_ID[indId]) return finish(allSettingsView(cfg), 'Unknown indicator');
    const r = await toggleIndicator(env, 'all', indId);
    const fresh = await getUtBotConfig(env);
    return finish(allSettingsView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'dra') {
    const ind = INDICATOR_BY_ID[parts[1]];
    const p = ind && (ind.params || []).find(x => x.key === parts[2]);
    if (!ind || !p) return finish(allSettingsView(cfg), 'Unknown input');
    return finish(paramDropdownView(cfg, ind, p, { kind: 'all' }, 'as'));
  }

  if (op === 'dva') {
    const indId = parts[1];
    const key = parts[2];
    const value = parts.slice(3).join(':');
    if (!INDICATOR_BY_ID[indId]) return finish(allSettingsView(cfg), 'Unknown input');
    const r = await setParam(env, indId, 'all', key, value);
    const fresh = await getUtBotConfig(env);
    return finish(allSettingsView(fresh), r.ok ? r.toast : r.error);
  }

  if (op === 'dca') {
    const indId = parts[1];
    const key = parts[2];
    if (!INDICATOR_BY_ID[indId]) return finish(allSettingsView(cfg), 'Unknown input');
    const r = await requestParamInput(env, chatId, msgId, 'all', indId, key);
    if (!r.ok) return finish(allSettingsView(cfg), r.error);
    return finish({ text: r.text, kb: r.kb });
  }

  if (op === 'tda') return finish(tfDropdownView(cfg, { kind: 'all' }, 'as'));

  if (op === 'tsa') {
    const r = await setTimeframe(env, 'all', parts[1]);
    const fresh = await getUtBotConfig(env);
    return finish(allSettingsView(fresh), r.ok ? r.toast : r.error);
  }

  // ⚡ Scan now — instant evaluation; disabled pairs preview without push.
  if (op === 'sc') {
    const pair = pairArg(1);
    if (!pairOk(pair)) return finish(mainMenuView(cfg), 'Unknown pair');
    const enabled = !!(cfg.pairs[pair] && cfg.pairs[pair].enabled);
    await sendMessage(env, chatId, '\u26A1 Scanning ' + pair + ' now...');
    const result = await scanOnePair(pair, 'bot_' + Date.now().toString(36), env, ctx,
      { force: true, noPush: !enabled }).catch(() => null);
    if (!result) {
      await sendMessage(env, chatId, 'Scan failed for ' + pair + ' (fetch error or market closed).');
    } else {
      const s = result.signal || {};
      const lines = [
        '\u26A1 Scan ' + pair + ' (' + (s.timeframe || '?') + ')',
        'Primary decision: ' + (s.finalSignal || 'NO_TRADE'),
        'New indicator events: ' + (s.audit && s.audit.pendingEventCount != null ? s.audit.pendingEventCount : 0),
      ];
      const ind = s.indicators || {};
      if (ind.utbot) lines.push('UT Bot: pos ' + ind.utbot.pos + ', trailing stop ' + ind.utbot.stop);
      if (ind.mkr) lines.push('MKR: ' + ind.mkr.kernel + ' x' + ind.mkr.bandwidth + ', dirUp ' + ind.mkr.dirUp);
      if (!enabled) lines.push('(preview only \u2014 pair is not scanning, nothing was pushed)');
      await sendMessage(env, chatId, lines.join('\n'));
    }
    const fresh = await getUtBotConfig(env);
    return finish(pairPanelView(fresh, pair), result ? 'Scan done' : 'Scan failed');
  }

  // Anything else (buttons from older panel versions still sitting in the
  // chat): land the user on the current main menu instead of erroring.
  return finish(mainMenuView(cfg, 'This button is from an older panel - the menu below is current.'), 'Menu updated');
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
      'Bot control panel is live.\nSend /menu to open it - all pairs, indicators,'
      + ' params and timeframe are editable from there. \uD83D\uDD0D Search finds any'
      + ' pair (try "eurusd").');
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

/**
 * UT Bot Alerts — Telegram push (plumbing + premium HTML formatting).
 *
 * Mechanics carried over from the proven production path (unchanged):
 *   - subscribers = the Bot's `auto_users` index in BOT_KV, records at u:<chatId>
 *   - a per-(subscriber, pair, direction) push lock (30 min) makes pushes
 *     idempotent across manual /api/signal calls and cron re-scans
 *   - durable lastAttempt + delivered24h diagnostics for /health
 *
 * Formatting (v1.6.0, user request "premium koro" 2026-09-20): messages are
 * Telegram HTML (parse_mode: 'HTML') with bold indicator names — the #1 user
 * complaint was that the combined "SIGNALS" message printed `undefined: BUY`
 * because the scanner's items carry the registry object (`it.ind.name`),
 * not a `name` string. Rules:
 *   - the indicator name is ALWAYS visible and bold (both single + combined)
 *   - prices are human-formatted by magnitude (80,412.68 / 108.277 /
 *     1.3779) — never raw float dumps like 80412.68099470844
 *   - BUY/SELL/UP/DOWN get their TradingView-ish icons (🟢🔴📈📉)
 *   - deliverability first: if Telegram rejects the HTML (parse error), the
 *     same text is retried once as plain text — a formatting bug can never
 *     silently drop a signal again
 *
 * Live formats (CFD style, each indicator speaks ONLY its own output):
 *   formatUtBotText        UT Bot Alerts  -> "🤖 UT BOT ALERTS ... BUY/SELL"
 *   formatMkrText          Multi Kernel Regression [ChartPrime] -> UP/DOWN
 *   formatCombinedText     several indicators firing on the SAME closed
 *                          candle -> one "⚡ CONFLUENCE SIGNAL" message with
 *                          a bold block per indicator
 * No expiry, no win/loss, no result messages (fixed-time logic is
 * retired); a future indicator adds its own formatter here (or reuses the
 * generic block) and the pipeline picks it up by registry id.
 */

import { CONFIG } from '../config.js';

const PUSH_LOCK_PREFIX = 'pushLock:';
const PUSH_LOCK_TTL_S = 30 * 60;
const LAST_ATTEMPT_KEY = 'push:lastAttempt';
const DELIVERED_24H_KEY = 'push:delivered24h';
const TELEGRAM_API = 'https://api.telegram.org';
const DIVIDER = '━━━━━━━━━━━━━━━━━━';

export function botToken(env) {
  return env && env.BOT_TOKEN ? String(env.BOT_TOKEN).trim() : '';
}

function normPair(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** HTML-escape any interpolated text (Telegram parse_mode: 'HTML'). */
export function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Human price formatting by magnitude (user complaint: raw float dumps).
 *   >= 1000  -> 2 decimals, thousands commas  80412.68099... -> 80,412.68
 *   >= 100   -> 3 decimals                    108.2768607... -> 108.277
 *   >= 1     -> 5 decimals, zeros trimmed     1.3778977...   -> 1.3779
 *   >= 0.01  -> 5 decimals, zeros trimmed     0.163218       -> 0.16322
 *   <  0.01  -> 8 decimals, zeros trimmed     0.0000123      -> 0.000012
 * Non-numeric input passes through untouched; null/undefined -> ''.
 */
export function fmtPrice(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 1 ? 5 : abs >= 0.01 ? 5 : 8;
  let s = n.toFixed(d);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (abs >= 1000) {
    let [int, frac] = s.split('.');
    const neg = int.startsWith('-');
    if (neg) int = int.slice(1);
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    s = (neg ? '-' : '') + int + (frac ? '.' + frac : '');
  }
  return s;
}

/** Direction icon: the indicator's own label gets its chart-flavored glyph. */
function dirIcon(label) {
  switch (String(label || '')) {
    case 'BUY': return '🟢';
    case 'SELL': return '🔴';
    case 'UP': return '📈';
    case 'DOWN': return '📉';
    default: return '•';
  }
}

/** "v1.6.0" style short version for footers. */
function shortVersion() {
  return String(CONFIG.VERSION || '').replace(/^MULTI-IND-/, '');
}

/** "2026-09-20 10:15 UTC" from an ISO string (seconds :00 dropped). */
function closedLine(iso) {
  return String(iso)
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC')
    .replace(/:00 UTC$/, ' UTC');
}

export function normalizeAutoUsers(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const entry of raw) {
    if (entry == null) continue;
    if (typeof entry === 'number' && isFinite(entry)) { ids.push(String(Math.trunc(entry))); continue; }
    if (typeof entry === 'string') {
      const s = entry.trim();
      if (!s) continue;
      ids.push(s.startsWith('u:') ? s.slice(2) : s);
      continue;
    }
    if (typeof entry === 'object') {
      const v = entry.chatId ?? entry.id ?? entry.cid ?? entry.chat_id;
      if (v == null) continue;
      const s = String(v).trim();
      if (s) ids.push(s.startsWith('u:') ? s.slice(2) : s);
    }
  }
  return ids;
}

export function isAutoEnabled(user) {
  if (!user) return false;
  return user.autoEnabled === true || user.autoEnabled === 1 || user.autoEnabled === 'true';
}

async function recordPushAttempt(env, rec) {
  if (!env || !env.SIGNAL_CACHE) return;
  try {
    await env.SIGNAL_CACHE.put(LAST_ATTEMPT_KEY, JSON.stringify({ ...rec, at: new Date().toISOString() }),
      { expirationTtl: 7 * 24 * 3600 });
  } catch (e) { /* diagnostics must never break a push */ }
}

async function recordDelivery(env, signalId, pair, n) {
  if (!env || !env.SIGNAL_CACHE || !n) return;
  try {
    let arr = await env.SIGNAL_CACHE.get(DELIVERED_24H_KEY, 'json');
    if (!Array.isArray(arr)) arr = [];
    const now = Date.now();
    arr = arr.filter(x => x && x.at && (now - new Date(x.at).getTime()) < 24 * 3600 * 1000);
    arr.push({ id: signalId, pair, n, at: new Date().toISOString() });
    if (arr.length > 500) arr = arr.slice(-500);
    await env.SIGNAL_CACHE.put(DELIVERED_24H_KEY, JSON.stringify(arr), { expirationTtl: 48 * 3600 });
  } catch (e) { /* diagnostics only */ }
}

/** Strip Telegram-HTML tags back to plain text (parse-error fallback). */
function htmlToPlain(html) {
  return String(html)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '');
}

async function tgSend(token, chatId, text, parseMode) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (parseMode) body.parse_mode = parseMode;
  const res = await fetch(TELEGRAM_API + '/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (j && j.ok) return { ok: true };
  return { ok: false, error: (j && j.description) || ('HTTP ' + res.status) };
}

/**
 * Deliver one message. HTML first; if Telegram rejects the entities, the
 * exact same signal is retried as plain text — formatting can never drop
 * a delivery (hardened after the 2026-09-20 format rework).
 */
async function sendTelegram(env, chatId, text) {
  const token = botToken(env);
  if (!token) return { ok: false, error: 'no token' };
  try {
    let r = await tgSend(token, chatId, text, 'HTML');
    if (!r.ok && /parse|entity/i.test(r.error || '')) {
      r = await tgSend(token, chatId, htmlToPlain(text), null);
    }
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* Premium per-indicator formatters (Telegram HTML, parse_mode HTML)  */
/* ------------------------------------------------------------------ */

/**
 * UT Bot Alerts event — the indicator's own output, premium layout:
 *
 *   🤖 UT BOT ALERTS · BTC/USD (15min)
 *
 *   🟢 BUY
 *   ⏰ Candle closed: 2026-09-20 10:15 UTC
 *
 *   💰 Entry: 80,411.10
 *   🛑 Trailing Stop: 80,549.65
 *
 *   ⚙️ a=1 · c=10 · FTT v1.6.0
 */
export function formatUtBotText(sig) {
  const a = sig.audit || {};
  const pair = escHtml(sig.pair);
  const tf = a.timeframe ? ' (' + escHtml(a.timeframe) + ')' : '';
  const label = a.event === 'buy' ? 'BUY' : 'SELL';

  const lines = [
    '🤖 <b>UT BOT ALERTS</b> · <b>' + pair + '</b>' + tf,
    '',
    dirIcon(label) + ' <b>' + label + '</b>',
  ];
  const closed = sig.entryTime || sig.timestamp || '';
  if (closed) lines.push('⏰ Candle closed: ' + closedLine(closed));
  lines.push('');
  if (sig.entryPrice != null) lines.push('💰 Entry: <code>' + fmtPrice(sig.entryPrice) + '</code>');
  if (a.stop != null) lines.push('🛑 Trailing Stop: <code>' + fmtPrice(a.stop) + '</code>');

  const foot = [];
  if (a.key != null) foot.push('a=' + a.key);
  if (a.atrPeriod != null) foot.push('c=' + a.atrPeriod);
  foot.push('FTT ' + shortVersion());
  lines.push('', '<i>⚙️ ' + escHtml(foot.join(' · ')) + '</i>');
  return lines.join('\n');
}

/**
 * Multi Kernel Regression event — the indicator's own Up/Down flip:
 *
 *   📊 MULTI KERNEL REGRESSION · ETH/USD (15min)
 *
 *   📈 UP
 *   ⏰ Candle closed: 2026-09-20 08:15 UTC
 *
 *   💰 Close: 2,580.18
 *   🌀 Kernel MA: 2,577.48 (Laplace ×14)
 *
 *   ⚙️ Laplace · bw=14 · FTT v1.6.0
 */
export function formatMkrText(sig) {
  const a = sig.audit || {};
  const pair = escHtml(sig.pair);
  const tf = a.timeframe ? ' (' + escHtml(a.timeframe) + ')' : '';
  const label = a.event === 'up' ? 'UP' : 'DOWN';

  const lines = [
    '📊 <b>MULTI KERNEL REGRESSION</b> · <b>' + pair + '</b>' + tf,
    '',
    dirIcon(label) + ' <b>' + label + '</b>',
  ];
  const closed = sig.entryTime || sig.timestamp || '';
  if (closed) lines.push('⏰ Candle closed: ' + closedLine(closed));
  lines.push('');
  if (sig.entryPrice != null) lines.push('💰 Close: <code>' + fmtPrice(sig.entryPrice) + '</code>');
  if (a.value != null) {
    const tag = a.kernel ? ' (' + escHtml(a.kernel) + ' ×' + escHtml(a.bandwidth) + ')' : '';
    lines.push('🌀 Kernel MA: <code>' + fmtPrice(a.value) + '</code>' + tag);
  }

  const foot = [];
  if (a.kernel) foot.push(String(a.kernel));
  if (a.bandwidth != null) foot.push('bw=' + a.bandwidth);
  foot.push('FTT ' + shortVersion());
  lines.push('', '<i>⚙️ ' + escHtml(foot.join(' · ')) + '</i>');
  return lines.join('\n');
}

/** Per-indicator message formatters, keyed by registry id. */
export const SIGNAL_FORMATTERS = {
  utbot: formatUtBotText,
  mkr: formatMkrText,
};

/**
 * One indicator's block inside a confluence message. Registry-driven:
 * known ids get their curated layout (bold name -> label, detail line with
 * clean numbers); unknown future indicators fall back to the generic
 * "name -> label + scanner detail" shape. `item` is the scanner's shape
 * ({ ind, sig, label, detail }) — `name` is read from the registry object,
 * never from a missing string field (the old `undefined: BUY` bug).
 */
function indBlock(it) {
  const ind = it.ind || {};
  const name = escHtml(ind.name || it.name || ind.id || 'Indicator');
  const label = escHtml(it.label || '');
  const a = (it.sig && it.sig.audit) || {};
  const lines = [escHtml(ind.icon || '•') + ' <b>' + name + '</b> → ' + dirIcon(it.label) + ' <b>' + label + '</b>'];
  if (ind.id === 'utbot') {
    if (a.stop != null) lines.push('🛑 Trailing Stop: <code>' + fmtPrice(a.stop) + '</code>');
  } else if (ind.id === 'mkr') {
    if (a.value != null) {
      const tag = a.kernel ? ' (' + escHtml(a.kernel) + ' ×' + escHtml(a.bandwidth) + ')' : '';
      lines.push('🌀 Kernel MA: <code>' + fmtPrice(a.value) + '</code>' + tag);
    }
  } else if (it.detail) {
    lines.push(escHtml(it.detail));
  }
  return lines.join('\n');
}

/**
 * Combined message for several indicators firing on the SAME closed candle
 * (user requirement: "jodi ekta sathe dey, seta signal e bolbe" — when they
 * fire together, the signal says it). One bold block per indicator:
 *
 *   ⚡ CONFLUENCE SIGNAL · BTC/USD (15min)
 *   ⏰ Candle closed: 2026-09-20 09:45 UTC
 *
 *   📈 UT Bot Alerts → 🟢 BUY
 *   🛑 Trailing Stop: 80,412.68
 *
 *   📊 Multi Kernel Regression → 📈 UP
 *   🌀 Kernel MA: 80,359.35 (Laplace ×14)
 *
 *   ━━━━━━━━━━━━━━━━━━
 *   💰 Entry: 80,552
 *   ✅ Both indicators fired together
 */
export function formatCombinedText(items) {
  // items: [{ ind, sig, label, detail }] — built by the scanner.
  const first = items[0].sig;
  const tf = first.timeframe ? ' (' + escHtml(first.timeframe) + ')' : '';
  const lines = [
    '⚡ <b>CONFLUENCE SIGNAL</b> · <b>' + escHtml(first.pair) + '</b>' + tf,
  ];
  const closed = first.entryTime || first.timestamp || '';
  if (closed) lines.push('⏰ Candle closed: ' + closedLine(closed));
  lines.push('');
  for (const it of items) lines.push(indBlock(it), '');
  if (first.entryPrice != null) lines.push(DIVIDER, '💰 Entry: <code>' + fmtPrice(first.entryPrice) + '</code>');
  const n = items.length;
  lines.push(n === 2 ? '✅ <i>Both indicators fired together</i>'
    : '✅ <i>' + n + ' indicators fired together</i>');
  return lines.join('\n');
}

/** Retired with CFD mode: results are tracked in the ledger only, never messaged. */
export function formatResultText(record) {
  const move = record.exitPrice != null && record.entryPrice != null
    ? ' (entry ' + record.entryPrice + ' -> exit ' + record.exitPrice + ')'
    : '';
  return 'UT BOT result - ' + record.pair + ' ' + record.direction + ': ' + record.result + move + '  id ' + record.id;
}

async function tryPush(signal, chatIds, env, lockSuffix) {
  let sent = 0;
  const errors = [];
  for (const chatId of chatIds) {
    const lockKey = PUSH_LOCK_PREFIX + chatId + ':' + normPair(signal.pair) + ':' + lockSuffix;
    try {
      const existing = await env.SIGNAL_CACHE.get(lockKey);
      if (existing) continue;   // already delivered this setup to this user
      const r = await sendTelegram(env, chatId, signal.text);
      if (r.ok) {
        sent++;
        await env.SIGNAL_CACHE.put(lockKey, signal.signalId, { expirationTtl: PUSH_LOCK_TTL_S });
      } else {
        errors.push(chatId + ': ' + r.error);
      }
    } catch (e) {
      errors.push(chatId + ': ' + e.message);
    }
  }
  return { sent, errors };
}

/**
 * Push one decided signal to every auto-enabled subscriber.
 * @returns {{pushed: boolean, sent: number}}
 */
export async function pushSignalToSubscribers(sig, env) {
  if (!env || !env.BOT_KV || !env.SIGNAL_CACHE) {
    await recordPushAttempt(env, { kind: 'signal', ok: false, error: 'KV/BOT_KV missing' });
    return { pushed: false, sent: 0 };
  }
  try {
    const idx = await env.BOT_KV.get('auto_users', 'json');
    const ids = normalizeAutoUsers(idx);
    if (ids.length === 0) {
      await recordPushAttempt(env, { kind: 'signal', ok: true, note: 'no subscribers', signalId: sig.signalId });
      return { pushed: false, sent: 0 };
    }
    const users = await Promise.all(ids.map(async id => {
      try { return { id, user: await env.BOT_KV.get('u:' + id, 'json') }; }
      catch (e) { return { id, user: null }; }
    }));
    const targets = users.filter(u => isAutoEnabled(u.user)).map(u => u.id);
    const text = sig.text || formatUtBotText(sig);
    const { sent, errors } = await tryPush({ ...sig, text }, targets, env, sig.direction);
    await recordPushAttempt(env, {
      kind: 'signal', ok: true, signalId: sig.signalId, pair: sig.pair, direction: sig.direction,
      subscribers: ids.length, targets: targets.length, sent, errors: errors.slice(0, 3),
    });
    if (sent > 0) await recordDelivery(env, sig.signalId, sig.pair, sent);
    return { pushed: sent > 0, sent };
  } catch (e) {
    await recordPushAttempt(env, { kind: 'signal', ok: false, error: e.message });
    return { pushed: false, sent: 0 };
  }
}

/** Push a resolved outcome (WIN/LOSS/TIE/...) for a previously delivered signal. */
export async function pushResultToSubscribers(record, env) {
  if (!env || !env.BOT_KV || !env.SIGNAL_CACHE) return { pushed: false, sent: 0 };
  try {
    const idx = await env.BOT_KV.get('auto_users', 'json');
    const ids = normalizeAutoUsers(idx);
    if (ids.length === 0) return { pushed: false, sent: 0 };
    const users = await Promise.all(ids.map(async id => {
      try { return { id, user: await env.BOT_KV.get('u:' + id, 'json') }; }
      catch (e) { return { id, user: null }; }
    }));
    const targets = users.filter(u => isAutoEnabled(u.user)).map(u => u.id);
    const { sent } = await tryPush(
      { signalId: record.id, pair: record.pair, direction: record.direction, text: formatResultText(record) },
      targets, env, 'RESULT:' + record.id,
    );
    return { pushed: sent > 0, sent };
  } catch (e) {
    console.warn('pushResult error:', e.message);
    return { pushed: false, sent: 0 };
  }
}

/** Diagnostics for /health. */
export async function getPushStats(env, opts = {}) {
  const out = {
    pushEnabled: !!botToken(env),
    noTokenReason: botToken(env) ? null : 'missing',
    subscribers: [],
    lastAttempt: null,
    pushesLast24h: 0,
  };
  if (!env || !env.SIGNAL_CACHE) return out;
  try {
    const la = await env.SIGNAL_CACHE.get(LAST_ATTEMPT_KEY, 'json');
    out.lastAttempt = la;
  } catch (e) { /* skip */ }
  try {
    const arr = await env.SIGNAL_CACHE.get(DELIVERED_24H_KEY, 'json');
    out.pushesLast24h = Array.isArray(arr)
      ? arr.reduce((n, x) => n + (x && typeof x.n === 'number' ? x.n : 0), 0) : 0;
  } catch (e) { /* skip */ }
  if (env.BOT_KV && opts.validateToken) {
    try {
      const idx = await env.BOT_KV.get('auto_users', 'json');
      out.subscribers = normalizeAutoUsers(idx);
    } catch (e) { /* skip */ }
    if (botToken(env)) {
      try {
        const res = await fetch(TELEGRAM_API + '/bot' + botToken(env) + '/getMe');
        const j = await res.json().catch(() => ({}));
        out.tokenValid = !!j.ok;
        out.tokenUsername = j.result && j.result.username;
      } catch (e) { out.tokenValid = null; }
    }
  }
  return out;
}

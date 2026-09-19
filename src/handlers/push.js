/**
 * UT Bot Alerts — Telegram push (plumbing only).
 *
 * Mechanics carried over from the proven production path (unchanged):
 *   - subscribers = the Bot's `auto_users` index in BOT_KV, records at u:<chatId>
 *   - a per-(subscriber, pair, direction) push lock (30 min) makes pushes
 *     idempotent across manual /api/signal calls and cron re-scans
 *   - plain-text messages, NO parse_mode (Telegram 400s on stray markdown chars)
 *   - durable lastAttempt + delivered24h diagnostics for /health
 *
 * formatSignalText (FTT3) was retired with the FTT3 live path. The live
 * format is formatUtBotText — CFD style (2026-09-19): the message contains
 * ONLY what the indicator itself produces — the BUY/SELL event, the event
 * candle close time, the entry close, and the trailing stop the indicator
 * draws. No expiry, no win/loss, no result messages (fixed-time logic is
 * retired); each added indicator will speak only its own output.
 */

const PUSH_LOCK_PREFIX = 'pushLock:';
const PUSH_LOCK_TTL_S = 30 * 60;
const LAST_ATTEMPT_KEY = 'push:lastAttempt';
const DELIVERED_24H_KEY = 'push:delivered24h';
const TELEGRAM_API = 'https://api.telegram.org';

export function botToken(env) {
  return env && env.BOT_TOKEN ? String(env.BOT_TOKEN).trim() : '';
}

function normPair(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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

async function sendTelegram(env, chatId, text) {
  const token = botToken(env);
  if (!token) return { ok: false, error: 'no token' };
  try {
    const res = await fetch(TELEGRAM_API + '/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const j = await res.json().catch(() => ({}));
    if (j && j.ok) return { ok: true };
    return { ok: false, error: (j && j.description) || ('HTTP ' + res.status) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Human-readable UT Bot event text (plain, no markdown, CFD style).
 *
 * Only the indicator's own output — what a TradingView user sees on the
 * chart: the flip direction, the pair/timeframe, the event candle close
 * time, the entry (candle close) and the trailing stop line:
 *
 *   UT BOT BUY - BTC/USD (15min)
 *   Candle closed: 2026-09-19 07:15 UTC
 *   Entry: 81321.4
 *   Trailing stop: 81339.1
 */
export function formatUtBotText(sig) {
  const a = sig.audit || {};
  const lines = [
    'UT BOT ' + (a.event === 'buy' ? 'BUY' : 'SELL') + ' - ' + sig.pair
      + (a.timeframe ? ' (' + a.timeframe + ')' : ''),
  ];
  const closed = sig.entryTime || sig.timestamp || '';
  if (closed)
    lines.push('Candle closed: ' + String(closed).replace('T', ' ').replace(/\.\d+Z$/, ' UTC'));
  if (sig.entryPrice != null) lines.push('Entry: ' + sig.entryPrice);
  if (a.stop != null) lines.push('Trailing stop: ' + a.stop);
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

/**
 * Telegram panel actions — every write funnels through
 * utbotConfig.mergePairPatch (the SAME store the scanner reads), so a button
 * press changes what the next 15-minute tick actually scans/computes.
 *
 * Scopes: a pair ("EUR/USD") or "all" (every known pair — the mockup's
 * global quick settings). Await-input flows (custom numeric value, pair
 * search) persist a pending record under tg:await:<chatId> with a TTL;
 * records are schema-versioned (v3) and legacy v2 records still apply.
 */

import { CONFIG } from '../config.js';
import { sanitizePair } from '../utils/pairs.js';
import { isKnownPair, orderPairs, searchPairs } from '../utils/pairCatalog.js';
import { INDICATOR_BY_ID } from '../strategy/registry.mjs';
import { getUtBotConfig, mergePairPatch } from './utbotConfig.js';

const KV_AWAIT_PREFIX = 'tg:await:';

/** Pairs a scope covers. Returns null for an unknown scope. */
export function scopeTargets(scope, cfg) {
  if (scope === 'all') return orderPairs(cfg.pairs);
  const pair = sanitizePair(scope);
  if (!pair || !isKnownPair(pair)) return null;
  return [pair];
}

export function scopeLabel(scope) {
  return scope === 'all' ? 'all pairs' : scope;
}

// ── scanning toggles ─────────────────────────────────────────────────────────

export async function togglePairScan(env, pair) {
  const cfg = await getUtBotConfig(env);
  const cur = !!(cfg.pairs[pair] && cfg.pairs[pair].enabled);
  const r = await mergePairPatch(env, { [pair]: { enabled: !cur } });
  return r.ok ? { ok: true, on: !cur, toast: pair + ': scanning ' + (!cur ? 'ON' : 'OFF') } : r;
}

export async function setAllPairsScan(env, on) {
  const cfg = await getUtBotConfig(env);
  const patch = {};
  for (const p of Object.keys(cfg.pairs)) patch[p] = { enabled: on };
  const r = await mergePairPatch(env, patch);
  return r.ok ? { ok: true, toast: 'All ' + Object.keys(patch).length + ' pairs: scanning ' + (on ? 'ON' : 'OFF') } : r;
}

// ── indicator toggles ────────────────────────────────────────────────────────

export async function toggleIndicator(env, scope, indId) {
  const ind = INDICATOR_BY_ID[indId];
  if (!ind) return { ok: false, error: 'unknown indicator' };
  const cfg = await getUtBotConfig(env);
  const targets = scopeTargets(scope, cfg);
  if (!targets) return { ok: false, error: 'unknown scope' };
  let next;
  if (scope === 'all') {
    let on = 0, off = 0;
    for (const p of targets) {
      const ic = cfg.pairs[p] && cfg.pairs[p].indicators && cfg.pairs[p].indicators[indId];
      (ic && ic.enabled ? on++ : off++);
    }
    next = !(on > 0 && off === 0);   // all ON -> all OFF; otherwise all ON
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

// ── parameter + timeframe writes ─────────────────────────────────────────────

/** Validate + apply one registry param against a scope (pair or 'all'). */
export async function setParam(env, indId, scope, key, rawValue) {
  const ind = INDICATOR_BY_ID[indId];
  if (!ind) return { ok: false, error: 'unknown indicator' };
  const cfg = await getUtBotConfig(env);
  const targets = scopeTargets(scope, cfg);
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

export async function setTimeframe(env, scope, tf) {
  const cfg = await getUtBotConfig(env);
  const targets = scopeTargets(scope, cfg);
  if (!targets) return { ok: false, error: 'unknown scope' };
  if (!CONFIG.UTBOT.TIMEFRAMES.includes(tf)) {
    return { ok: false, error: 'timeframe must be one of: ' + CONFIG.UTBOT.TIMEFRAMES.join(', ') };
  }
  const patch = {};
  for (const t of targets) patch[t] = { timeframe: tf };
  const r = await mergePairPatch(env, patch);
  return r.ok ? { ok: true, toast: 'Timeframe = ' + tf + ' - ' + scopeLabel(scope) } : r;
}

// ── await-input flows ────────────────────────────────────────────────────────

/** "Custom value..." for a numeric param (pair string or 'all'). */
export async function requestParamInput(env, chatId, msgId, pair, indId, key) {
  const ind = INDICATOR_BY_ID[indId];
  const p = ind && (ind.params || []).find(x => x.key === key);
  if (!ind || !p || p.kind === 'enum') return { ok: false, error: 'no numeric parameter' };
  const rec = {
    v: 3, t: 'param', pair, indId, key, label: p.label, kind: p.kind, min: p.min, max: p.max, msgId,
    at: new Date().toISOString(),
  };
  await env.SIGNAL_CACHE.put(KV_AWAIT_PREFIX + chatId, JSON.stringify(rec), { expirationTtl: 600 });
  const target = pair === 'all' ? 'ALL pairs' : pair;
  const text = 'Send a number for ' + p.label + ' - ' + target
    + '\nAllowed range: ' + p.min + ' to ' + p.max + (p.kind === 'int' ? ' (whole number)' : '')
    + '\n/reset to cancel.';
  const kb = [[{ text: '\u2B05\uFE0F Back', callback_data: pair === 'all' ? 'as' : 'P:' + pair }]];
  return { ok: true, text, kb };
}

/** Numeric reply while a param record is pending. Returns null if none. */
export async function applyParamInput(env, chatId, text) {
  const raw = await env.SIGNAL_CACHE.get(KV_AWAIT_PREFIX + chatId).catch(() => null);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) {
    await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
    return null;
  }
  if (!rec || !rec.pair || !rec.indId || rec.t === 'search') {
    // Legacy pre-panel records (scope-based) / search records: drop silently.
    if (rec && rec.t !== 'search') {
      await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
    }
    return null;
  }
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  const r = await setParam(env, rec.indId, rec.pair, rec.key, cleaned);
  if (!r.ok) {
    // Keep the pending record so the owner can just send another number.
    return { ok: false, rec, message: 'Could not set ' + rec.label + ': ' + r.error
      + '\nSend another number or /reset to cancel.' };
  }
  await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
  return { ok: true, rec, toast: r.toast };
}

/** 🔍 Search pair — arm the await state. */
export async function requestPairSearch(env, chatId, msgId) {
  const rec = { v: 3, t: 'search', msgId, at: new Date().toISOString() };
  await env.SIGNAL_CACHE.put(KV_AWAIT_PREFIX + chatId, JSON.stringify(rec), { expirationTtl: 600 });
  return { ok: true };
}

/** Text reply while a search record is pending. Returns null if none. */
export async function applyPairSearch(env, chatId, text, cfg) {
  const raw = await env.SIGNAL_CACHE.get(KV_AWAIT_PREFIX + chatId).catch(() => null);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch (e) {
    await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
    return null;
  }
  if (!rec || rec.t !== 'search') return null;
  const query = String(text || '').trim();
  const matches = searchPairs(query, 12);
  // Search is one-shot: the answer view carries "New search" + Categories.
  await env.SIGNAL_CACHE.delete(KV_AWAIT_PREFIX + chatId).catch(() => {});
  return { ok: true, query, matches };
}

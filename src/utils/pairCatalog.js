/**
 * Pair catalog — the full browsable universe for the Telegram panel.
 *
 * The fetch layer (TwelveData) serves far more than the 8 default pairs;
 * the worker's real "supported" definition is the pair sanitizer
 * (src/utils/pairs.js): any forex combination of VALID_FOREX_CURRENCIES plus
 * CRYPTO_BASES x quotes. This module gives that universe a UI shape:
 *
 *   - a curated, categorized catalog (majors / minors / exotics / crypto)
 *     for the "Select Pair" dropdown screens,
 *   - emoji icons per pair (flag / ticker glyphs, mockup-style),
 *   - a search resolver so typing "eurusd" surfaces EUR/USD — including
 *     valid pairs OUTSIDE the curated catalog (e.g. USD/INR),
 *   - deterministic ordering shared by the scanner and the bot (catalog
 *     order first, custom pairs after).
 *
 * Default-enabled pairs stay the audited 8 (DEFAULT_ENABLED_PAIRS in
 * config.js); everything else is seeded enabled:false and turned on from
 * the panel. No OTC anywhere — real markets only, as before.
 */

import { POPULAR_CRYPTO_PAIRS } from '../config.js';
import { sanitizePair } from './pairs.js';

// ── curated catalog ──────────────────────────────────────────────────────────

export const FOREX_MAJORS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD',
];

export const FOREX_MINORS = [
  'EUR/GBP', 'EUR/JPY', 'EUR/CHF', 'EUR/CAD', 'EUR/AUD', 'EUR/NZD',
  'GBP/JPY', 'GBP/CHF', 'GBP/CAD', 'GBP/AUD', 'GBP/NZD',
  'AUD/JPY', 'AUD/CAD', 'AUD/CHF', 'AUD/NZD',
  'NZD/JPY', 'NZD/CAD', 'NZD/CHF',
  'CAD/JPY', 'CAD/CHF', 'CHF/JPY',
];

export const FOREX_EXOTICS = [
  'USD/SGD', 'USD/HKD', 'USD/CNH', 'USD/TRY', 'USD/ZAR', 'USD/MXN',
  'USD/BRL', 'USD/INR', 'USD/THB', 'USD/PLN', 'USD/SEK', 'USD/NOK',
  'USD/DKK', 'EUR/PLN', 'EUR/TRY', 'EUR/SEK', 'EUR/NOK', 'EUR/HUF',
  'EUR/CZK', 'EUR/SGD',
];

export const CRYPTO_CATALOG = POPULAR_CRYPTO_PAIRS.slice();

/** Category descriptors for the Select Pair screens. 'act' is dynamic. */
export const CATEGORIES = [
  { id: 'act', label: '\u2705 Active pairs', dynamic: true },
  { id: 'maj', label: '\uD83D\uDCB1 Forex Majors', pairs: FOREX_MAJORS },
  { id: 'min', label: '\uD83D\uDD04 Forex Minors', pairs: FOREX_MINORS },
  { id: 'exo', label: '\uD83C\uDF0D Forex Exotics', pairs: FOREX_EXOTICS },
  { id: 'cry', label: '\uD83E\uDE99 Crypto', pairs: CRYPTO_CATALOG },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

/** Every curated pair, catalog order (majors -> minors -> exotics -> crypto). */
export const CATALOG_PAIRS = [
  ...FOREX_MAJORS, ...FOREX_MINORS, ...FOREX_EXOTICS, ...CRYPTO_CATALOG,
];

const CATALOG_SET = new Set(CATALOG_PAIRS);

// ── emoji icons ──────────────────────────────────────────────────────────────

const CURRENCY_EMOJI = {
  BTC: '\u20BF', ETH: '\u039E', XRP: '\u2715', SOL: '\u25CE', BNB: '\uD83D\uDFE1',
  ADA: '\u20B3', DOGE: '\u00D0', AVAX: '\uD83D\uDD3A', DOT: '\u2B24', LINK: '\uD83D\uDD17',
  USD: '\uD83C\uDDFA\uD83C\uDDF8', EUR: '\uD83C\uDDEA\uD83C\uDDFA', GBP: '\uD83C\uDDEC\uD83C\uDDE7',
  JPY: '\uD83C\uDDEF\uD83C\uDDF5', CHF: '\uD83C\uDDE8\uD83C\uDDED', CAD: '\uD83C\uDDE8\uD83C\uDDE6',
  AUD: '\uD83C\uDDE6\uD83C\uDDFA', NZD: '\uD83C\uDDF3\uD83C\uDDFF', SGD: '\uD83C\uDDF8\uD83C\uDDEC',
  HKD: '\uD83C\uDDED\uD83C\uDDF0', CNH: '\uD83C\uDDE8\uD83C\uDDF3', CNY: '\uD83C\uDDE8\uD83C\uDDF3',
  TRY: '\uD83C\uDDF9\uD83C\uDDF7', ZAR: '\uD83C\uDDFF\uD83C\uDDE6', MXN: '\uD83C\uDDF2\uD83C\uDDFD',
  BRL: '\uD83C\uDDE7\uD83C\uDDF7', INR: '\uD83C\uDDEE\uD83C\uDDF3', THB: '\uD83C\uDDF9\uD83C\uDDED',
  PLN: '\uD83C\uDDF5\uD83C\uDDF1', SEK: '\uD83C\uDDF8\uD83C\uDDEA', NOK: '\uD83C\uDDF3\uD83C\uDDF4',
  DKK: '\uD83C\uDDE9\uD83C\uDDF0', HUF: '\uD83C\uDDED\uD83C\uDDFA', CZK: '\uD83C\uDDE8\uD83C\uDDFF',
  USDT: '\uD83D\uDCB5', BTC_QUOTE: '\u20BF',
};

/** '<emoji> PAIR' — mockup-style button label (safe for any known pair). */
export function pairIcon(pair) {
  const [base, quote] = String(pair || '').split('/');
  const b = CURRENCY_EMOJI[base];
  if (b) return b + ' ' + pair;
  return (CRYPTO_CATALOG.some(p => p.split('/')[0] === base) ? '\uD83E\uDE99' : '\uD83D\uDCB1')
    + ' ' + pair;
}

// ── support / ordering helpers ───────────────────────────────────────────────

/**
 * A pair the worker can actually scan: the sanitizer accepts it and it is
 * NOT an OTC symbol (real markets only — unchanged worker posture).
 */
export function isKnownPair(pair) {
  const p = sanitizePair(pair);
  return !!p && !p.endsWith('-OTC');
}

/** Catalog-first ordering; custom (search-added) pairs sorted after. */
export function orderPairs(cfgPairs) {
  const keys = Object.keys(cfgPairs || {});
  const head = CATALOG_PAIRS.filter(p => keys.includes(p));
  const tail = keys.filter(p => !CATALOG_SET.has(p)).sort();
  return [...head, ...tail];
}

// ── search resolver ──────────────────────────────────────────────────────────

/**
 * Resolve a free-text query ("eurusd", "gbpjpy", "btc", "usd inr") into
 * known pairs. Order: direct resolution first, then catalog contains/
 * prefix matches in catalog order. Returns at most `limit` pairs.
 */
export function searchPairs(query, limit = 12) {
  const q = String(query || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!q) return [];
  const out = [];
  const seen = new Set();
  const push = (pair) => {
    if (pair && !seen.has(pair) && isKnownPair(pair)) { seen.add(pair); out.push(pair); }
  };

  // 1) direct resolution — the sanitizer already understands "EURUSD",
  //    "BTCUSD", "USDTUSD", "USDINR"... with or without separators.
  push(sanitizePair(q));

  // 2) catalog contains/prefix match ("eur" -> every EUR pair)
  for (const p of CATALOG_PAIRS) {
    if (out.length >= limit) break;
    const norm = p.replace('/', '');
    if (norm.includes(q) || norm.startsWith(q)) push(p);
  }

  // 3) base/quote exact-word match for short queries ("jpy" -> USD/JPY...)
  if (out.length < limit && q.length >= 3) {
    for (const p of CATALOG_PAIRS) {
      if (out.length >= limit) break;
      const [b, qt] = p.split('/');
      if (b === q || qt === q) push(p);
    }
  }
  return out.slice(0, limit);
}

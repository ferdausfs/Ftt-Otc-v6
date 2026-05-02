import {
  ASSET_TYPE, ASSET_TYPE_OTC, OTC_SUFFIXES,
  VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES,
  CONFIG,
} from '../config.js';

export function isOTCInput(input) {
  if (!input || typeof input !== 'string') return false;
  const u = input.toUpperCase();
  return u.endsWith('-OTC') || u.endsWith('OTC');
}

export function stripOTCSuffix(input) {
  if (!input) return input;
  let s = input.toUpperCase().trim();
  if (s.endsWith('-OTC')) return s.slice(0, -4);
  if (s.endsWith('OTC'))  return s.slice(0, -3);
  return s;
}

export function getOTCBasePair(pair) {
  if (!pair) return pair;
  if (pair.endsWith('-OTC')) return pair.slice(0, -4);
  return pair;
}

export function sanitizePair(input) {
  if (!input || typeof input !== 'string') return null;

  const otcFlag   = isOTCInput(input);
  const baseInput = otcFlag ? stripOTCSuffix(input) : input;
  const c = baseInput.replace(/[^A-Za-z/]/g, '').toUpperCase();

  const slashPattern = /^[A-Z]{3,}\/[A-Z]{3,}$/;
  if (slashPattern.test(c)) {
    const [b, q] = c.split('/');
    if (!otcFlag && CRYPTO_BASES.includes(b) &&
        (CRYPTO_QUOTES.includes(q) || VALID_FOREX_CURRENCIES.includes(q)) && b !== q) return c;
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q)
      return otcFlag ? b + '/' + q + '-OTC' : c;
    return null;
  }

  if (!otcFlag) {
    for (const base of CRYPTO_BASES) {
      if (c.startsWith(base) && c.length > base.length) {
        const quote = c.slice(base.length);
        if ((CRYPTO_QUOTES.includes(quote) || VALID_FOREX_CURRENCIES.includes(quote)) && base !== quote)
          return base + '/' + quote;
      }
    }
  }

  const noSlashPattern = /^[A-Z]{6}$/;
  if (noSlashPattern.test(c)) {
    const b = c.slice(0, 3); const q = c.slice(3, 6);
    if (VALID_FOREX_CURRENCIES.includes(b) && VALID_FOREX_CURRENCIES.includes(q) && b !== q)
      return otcFlag ? b + '/' + q + '-OTC' : b + '/' + q;
  }

  return null;
}

export function getAssetType(pair) {
  if (!pair || typeof pair !== 'string') return ASSET_TYPE.FOREX;
  if (pair.endsWith('-OTC')) return ASSET_TYPE_OTC;
  const base = (pair.split('/')[0] || '');
  if (CRYPTO_BASES.includes(base)) return ASSET_TYPE.CRYPTO;
  return ASSET_TYPE.FOREX;
}

export function isExoticPair(pair) {
  if (!pair) return false;
  const [base, quote] = pair.split('/');
  return CONFIG.EXOTIC_CURRENCIES.includes(base || '') || CONFIG.EXOTIC_CURRENCIES.includes(quote || '');
}

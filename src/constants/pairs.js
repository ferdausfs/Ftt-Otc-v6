// ============================================================
// CURRENCY & PAIR CONSTANTS
// Add new currencies here to extend coverage
// ============================================================
// ============================================
// FOREX CURRENCIES
// ============================================

const VALID_FOREX_CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF',
  'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'CZK', 'RON', 'BGN', 'HRK', 'ISK', 'RUB', 'TRY', 'UAH',
  'HKD', 'SGD', 'CNH', 'CNY', 'KRW', 'TWD', 'THB', 'MYR', 'PHP', 'IDR', 'INR', 'VND', 'PKR', 'BDT', 'LKR',
  'MXN', 'BRL', 'CLP', 'COP', 'PEN', 'ARS',
  'AED', 'SAR', 'ILS', 'JOD', 'KWD', 'BHD', 'OMR', 'QAR',
  'ZAR', 'EGP', 'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'MAD',
];

// ============================================
// CRYPTO CONFIG
// ============================================

const CRYPTO_BASES = [
  'BTC', 'ETH', 'BNB', 'XRP', 'SOL',
  'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK',
];

const CRYPTO_QUOTES = ['USD', 'EUR', 'GBP', 'JPY', 'USDT', 'BTC'];

const POPULAR_CRYPTO_PAIRS = [
  'BTC/USD', 'ETH/USD', 'BNB/USD', 'XRP/USD', 'SOL/USD',
  'ADA/USD', 'DOGE/USD', 'AVAX/USD', 'DOT/USD', 'LINK/USD',
  'BTC/EUR', 'ETH/EUR', 'BTC/GBP', 'ETH/GBP',
  'ETH/BTC', 'BNB/BTC', 'XRP/BTC', 'SOL/BTC',
  'ADA/BTC', 'DOGE/BTC', 'AVAX/BTC', 'DOT/BTC', 'LINK/BTC',
];

export {
  VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS,
};

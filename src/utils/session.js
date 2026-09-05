/**
 * Minimal market-hours helper. FTT3 deliberately has NO session/news filter in
 * its decision chain (spec: add only if a backtest shows a time-of-day
 * problem). This file exists purely as scan plumbing: forex candles do not
 * exist on weekends, so scanning forex while the market is shut would spend
 * TwelveData credits on a frozen price.
 */

export function isForexMarketOpen(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;                 // Saturday
  if (day === 5 && hour >= 22) return false;   // Friday >= 22:00 UTC
  if (day === 0 && hour < 22) return false;    // Sunday < 22:00 UTC
  return true;
}

/** Display-only holiday note for /health. */
export function getForexHoliday(now = new Date()) {
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (m === 11 && d === 25) return 'Christmas Day';
  if (m === 0 && d === 1) return "New Year's Day";
  return null;
}

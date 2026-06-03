import { ASSET_TYPE, ASSET_TYPE_OTC, HIGH_IMPACT_NEWS_WINDOWS, CONFIG } from '../config.js';
import { formatTimeUntil } from './helpers.js';

export function detectTradingSession() {
  const now = new Date();
  const hour = now.getUTCHours();
  const sessions = [];

  if (hour >= 0 && hour < 9)   sessions.push('ASIAN');
  if (hour >= 7 && hour < 16)  sessions.push('LONDON');
  if (hour >= 12 && hour < 21) sessions.push('NEW_YORK');
  if (hour >= 21 || hour < 6)  sessions.push('SYDNEY');

  let overlap = 'NONE';
  if (sessions.includes('LONDON') && sessions.includes('NEW_YORK')) overlap = 'LONDON_NY';
  else if (sessions.includes('ASIAN') && sessions.includes('LONDON')) overlap = 'ASIAN_LONDON';

  let quality = 'LOW';
  if (overlap === 'LONDON_NY')           quality = 'HIGHEST';
  else if (sessions.includes('LONDON'))  quality = 'HIGH';
  else if (sessions.includes('NEW_YORK')) quality = 'HIGH';
  else if (overlap === 'ASIAN_LONDON')   quality = 'MEDIUM';
  else if (sessions.includes('ASIAN'))   quality = 'MEDIUM';

  return { sessions, overlap, quality, hour };
}

export function isForexMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22)  return false;
  return true;
}

export function getForexHoliday() {
  const now = new Date();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (m === 11 && d === 25) return 'Christmas Day';
  if (m === 0  && d === 1)  return "New Year's Day";
  return null;
}

export function getNextForexOpen() {
  const now = new Date();
  const next = new Date(now);
  if (now.getUTCDay() === 0 && now.getUTCHours() < 22) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0));
  }
  while (true) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCDay() === 0) break;
  }
  next.setUTCHours(22, 0, 0, 0);
  return next;
}

export function checkNewsBlackout(assetType) {
  if (assetType === ASSET_TYPE.CRYPTO) return null;
  if (assetType === ASSET_TYPE_OTC)    return null;

  const now = new Date();
  const day = now.getUTCDay();
  const nowTotalMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const margin = CONFIG.NEWS_BLACKOUT_MINUTES;

  for (const win of HIGH_IMPACT_NEWS_WINDOWS) {
    if (!win.days.includes(day)) continue;
    const winStart = Math.max(0, win.startHour * 60 + win.startMin - margin);
    const winEnd   = Math.min(1439, win.endHour * 60 + win.endMin + margin);
    if (nowTotalMin >= winStart && nowTotalMin <= winEnd) {
      const clearMin = winEnd - nowTotalMin;
      return {
        blocked: true, label: win.label,
        minutesUntilClear: clearMin,
        message: 'Signal blocked: ' + win.label + '. Clears in ~' + clearMin + ' min.',
      };
    }
  }
  return null;
}

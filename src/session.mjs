/**
 * FTT Engine v2 — session / liquidity / news-blackout filter (condition C4).
 *
 * Ported from Ftt-Otc-v6/src/utils/session.js (detectTradingSession,
 * isForexMarketOpen) and Ftt-Otc-v6/src/config.js (HIGH_IMPACT_NEWS_WINDOWS),
 * reindexed from `new Date()` to an explicit timestamp so the backtest and
 * the live engine evaluate identical logic.
 *
 * Soundness note (why this survived the v2 cut): the session map is a plain,
 * well-known market-structure fact (London 07-16 UTC, New York 12-21 UTC),
 * not a patch tuned against a losing streak.
 */

// Static weekly high-impact windows (UTC). Verbatim from v6 config.js.
// News calendar is not programmatically available in v2 — these fixed
// windows are the v6 production behaviour; crypto is exempt (same as v6).
export const HIGH_IMPACT_NEWS_WINDOWS = [
  { days: [1, 2, 3, 4, 5], startHour: 12, startMin: 15, endHour: 13, endMin: 30, label: 'US Economic Data Window' },
  { days: [2, 3, 4],       startHour: 17, startMin: 45, endHour: 19, endMin: 30, label: 'Central Bank Decision Window' },
  { days: [4],             startHour: 11, startMin: 45, endHour: 12, endMin: 30, label: 'ECB/BOE Rate Window' },
  { days: [0, 1],          startHour: 21, startMin: 45, endHour: 22, endMin: 30, label: 'Week Open Spike Window' },
];

export function detectTradingSession(ts) {
  const d = new Date(ts);
  const hour = d.getUTCHours();
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

export function isForexMarketOpen(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;                 // Saturday
  if (day === 5 && hour >= 22) return false;   // Friday >= 22:00
  if (day === 0 && hour < 22)  return false;   // Sunday < 22:00
  return true;
}

export function checkNewsBlackout(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const totalMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const win of HIGH_IMPACT_NEWS_WINDOWS) {
    if (!win.days.includes(day)) continue;
    const start = win.startHour * 60 + win.startMin;
    const end   = win.endHour * 60 + win.endMin;
    if (totalMin >= start && totalMin <= end) return { blocked: true, label: win.label };
  }
  return null;
}

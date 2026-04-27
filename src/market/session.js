// ============================================================
// SESSION & MARKET HOURS DETECTION
// Detects: ASIAN / LONDON / NEW_YORK / SYDNEY + overlaps
// ============================================================
// ============================================
// SESSION DETECTION
// ============================================

function detectTradingSession() {
  const now = new Date();
  const hour = now.getUTCHours();

  const sessions = [];

  if (hour >= 0 && hour < 9) sessions.push('ASIAN');
  if (hour >= 7 && hour < 16) sessions.push('LONDON');
  if (hour >= 12 && hour < 21) sessions.push('NEW_YORK');
  if (hour >= 21 || hour < 6) sessions.push('SYDNEY');

  let overlap = 'NONE';
  if (sessions.includes('LONDON') && sessions.includes('NEW_YORK')) {
    overlap = 'LONDON_NY';
  } else if (sessions.includes('ASIAN') && sessions.includes('LONDON')) {
    overlap = 'ASIAN_LONDON';
  }

  let quality = 'LOW';
  if (overlap === 'LONDON_NY') quality = 'HIGHEST';
  else if (sessions.includes('LONDON')) quality = 'HIGH';
  else if (sessions.includes('NEW_YORK')) quality = 'HIGH';
  else if (overlap === 'ASIAN_LONDON') quality = 'MEDIUM';
  else if (sessions.includes('ASIAN')) quality = 'MEDIUM';

  return { sessions: sessions, overlap: overlap, quality: quality, hour: hour };
}

// ============================================
// FOREX MARKET HOURS
// ============================================

function isForexMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  if (day === 6) return false;
  if (day === 5 && hour >= 22) return false;
  if (day === 0 && hour < 22) return false;

  return true;
}

function getForexHoliday() {
  const now = new Date();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (m === 11 && d === 25) return 'Christmas Day';
  if (m === 0 && d === 1) return "New Year's Day";
  return null;
}

function getNextForexOpen() {
  const now = new Date();
  const next = new Date(now);

  if (now.getUTCDay() === 0 && now.getUTCHours() < 22) {
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0
    ));
  }

  while (true) {
    next.setUTCDate(next.getUTCDate() + 1);
    if (next.getUTCDay() === 0) break;
  }
  next.setUTCHours(22, 0, 0, 0);

  return next;
}

function formatTimeUntil(target) {
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return 'Opening soon...';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return days + 'd ' + remHours + 'h ' + mins + 'm';
  }
  return hours + 'h ' + mins + 'm';
}

export { detectTradingSession, isForexMarketOpen, getForexHoliday, getNextForexOpen, formatTimeUntil };

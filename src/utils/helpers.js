// ── SAFE VALUE HELPERS ───────────────────────────────────────
export function safeLastValue(arr) {
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return arr[i];
  }
  return null;
}

export function safeLastTwo(arr) {
  if (!arr || arr.length === 0) return { last: null, prev: null };
  let last = null; let prev = null; let foundFirst = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) {
      if (!foundFirst) { last = arr[i]; foundFirst = true; }
      else { prev = arr[i]; break; }
    }
  }
  return { last, prev };
}

export function safeLastN(arr, n) {
  if (!arr || arr.length === 0) return [];
  const result = [];
  for (let i = arr.length - 1; i >= 0 && result.length < n; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) result.unshift(arr[i]);
  }
  return result;
}

// ── FORMAT HELPERS ───────────────────────────────────────────
export function r2(v) { return Math.round(v * 100) / 100; }
export function fmt(v, d = 5) { return v !== null ? v.toFixed(d) : 'N/A'; }

export function formatDuration(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
}

export function formatTimeUntil(target) {
  const now = new Date();
  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return 'Opening soon...';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h ' + mins + 'm';
  }
  return hours + 'h ' + mins + 'm';
}

export function getNextCandleClose(now, candleMinutes) {
  const ms = candleMinutes * 60000;
  const currentSlot = Math.floor(now.getTime() / ms);
  return new Date((currentSlot + 1) * ms);
}

export function getCandleCountdown(candleMinutes) {
  const now = Date.now();
  const ms = candleMinutes * 60000;
  const nextCloseMs = Math.ceil(now / ms) * ms;
  const secondsLeft = Math.max(0, Math.round((nextCloseMs - now) / 1000));
  return {
    secondsLeft,
    minutesLeft: Math.floor(secondsLeft / 60),
    label: secondsLeft >= 60
      ? Math.floor(secondsLeft / 60) + 'm ' + (secondsLeft % 60) + 's'
      : secondsLeft + 's',
    nextCandleClose: new Date(nextCloseMs).toISOString(),
  };
}

// ── JSON RESPONSE ────────────────────────────────────────────
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

// ── DUMMY FALLBACK ───────────────────────────────────────────
export function generateDummySignal(pair) {
  const seed = (new Date().getMinutes() + pair.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 10;
  const dir = seed < 4 ? 'BUY' : seed < 8 ? 'SELL' : 'NO_TRADE';
  return {
    finalSignal: dir, confidence: '0%',
    grade: { grade: 'F', label: 'DUMMY', description: 'Fallback — no real data.' },
    marketCondition: ['UNKNOWN'], alignment: 'NONE', recommendations: {},
    bestTimeframe: { timeframe: 'N/A' },
    votes: { BUY: 0, SELL: 0, NO_TRADE: 0, total: 0 },
    timeframeAnalysis: {}, method: 'DUMMY_FALLBACK',
    warning: 'All API calls failed. Zero reliability.',
  };
}

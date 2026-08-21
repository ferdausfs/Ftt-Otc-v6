import { CONFIG, ASSET_TYPE, VALID_FOREX_CURRENCIES, CRYPTO_BASES, CRYPTO_QUOTES, POPULAR_CRYPTO_PAIRS, HISTORY_CONFIG } from '../config.js';
import { jsonResponse } from '../utils/helpers.js';
import { sanitizePair, isExoticPair } from '../utils/pairs.js';
import { detectTradingSession, isForexMarketOpen, getForexHoliday, checkNewsBlackout } from '../utils/session.js';
import { getApiKeys, readRotationIndex } from '../fetch/keys.js';
import { getDynamicConfidenceAdjustment, updatePairStats } from '../history/stats.js';
import { readQuota } from '../history/quota.js';
import { getScanCacheStats } from './latest.js';
import { getPushStats } from './pushToSubscribers.js';
// Self-calibration (C7): /api/calib shows the ACTIVE calibration tables.
import { loadCalibration } from '../history/selfCalib.js';
import { CALIB } from '../analysis/calibration.js';

// ── HEALTH ──────────────────────────────────
export async function handleHealth(env) {
  const keyCount  = getApiKeys(env).length;
  const keySource = env.TWELVEDATA_API_KEYS ? 'TWELVEDATA_API_KEYS (JSON array)' : 'TWELVEDATA_API_KEY_N (individual vars)';
  const session   = detectTradingSession();
  const newsBlock = checkNewsBlackout(ASSET_TYPE.FOREX);
  const forexOpen = isForexMarketOpen();
  const holiday   = getForexHoliday();

  // B0-4 / B0-6 instrumentation
  const quotaUsedToday = await readQuota(env);
  const rotationIdx    = await readRotationIndex(env);
  const scanCache      = await getScanCacheStats(env);   // Phase 7
  const phase10        = await getPushStats(env, { validateToken: true });        // Phase 10 push

  return jsonResponse({
    status: 'healthy', version: '6.11.0', timestamp: new Date().toISOString(),
    apiKeys: { configured: keyCount, source: keySource, status: keyCount > 0 ? 'ready' : 'NO KEYS' },
    apiKeysLoaded: keyCount,
    quotaUsedToday,
    rotationIdx,
    bindings: {
      kvCache:     env.SIGNAL_CACHE      ? 'ready' : 'NOT CONFIGURED',
      rateLimiter: env.RATE_LIMITER      ? 'ready' : 'KV fallback',
      cerebrasAI:  env.CEREBRAS_API_KEY  ? 'ready' : 'NOT CONFIGURED (add CEREBRAS_API_KEY secret)',
    },
    currentSession: session,
    newsBlackout: newsBlock || { blocked: false, label: 'NONE' },
    markets: {
      forex: { status: forexOpen ? 'OPEN' : 'CLOSED', holiday: holiday || 'NONE', currencies: VALID_FOREX_CURRENCIES.length, hours: 'Mon-Fri 24h (Sun 22:00 UTC to Fri 22:00 UTC)' },
      crypto: { status: 'ALWAYS OPEN (24/7)', bases: CRYPTO_BASES, quotes: CRYPTO_QUOTES, topPairs: POPULAR_CRYPTO_PAIRS.slice(0, 10) },
    },
    filters: { minConfidenceFloor: CONFIG.MIN_CONFIDENCE_FLOOR + '%', volumeSpikeMultiplier: CONFIG.VOLUME_SPIKE_FILTER_MULTIPLIER + 'x', newsBlackoutMargin: CONFIG.NEWS_BLACKOUT_MINUTES + ' min', batchMaxPairs: CONFIG.BATCH_MAX_PAIRS },
    // Phase 7 — cron scanner cache. oldestCachedAge well above scanIntervalSec
    // means the */5 scan is failing or being skipped.
    scanCache,
    // Phase 10 — cross-surface Telegram push.
    // pushEnabled false  → BOT_TOKEN missing/blank on THIS worker (fttotcv6).
    // noTokenReason      → 'missing' | 'empty' | 'invalid' | 'error' | null.
    // lastAttempt        → last pushSignalToSubscribers outcome (even no-match
    //                      / telegram-fail). Survives result-push deleting
    //                      pushLog:* so pushesLast24h=0 is no longer silent.
    phase10,
    push: {
      enabled: !!(phase10 && phase10.pushEnabled),
      noTokenReason: phase10 ? phase10.noTokenReason : 'missing',
      tokenValid: phase10 ? phase10.tokenValid : null,
      tokenUsername: phase10 ? phase10.tokenUsername : null,
      lastAttempt: phase10 ? phase10.lastAttempt : null,
      subscribers: phase10 ? phase10.subscribers : [],
      // Durable 24h delivery counter (KV push:delivered24h). Result-push
      // deletes pushLog:<id>, so this — not pushLogsOpen — is the number that
      // must increment when a Telegram DM actually lands.
      delivered24h: phase10 ? phase10.pushesLast24h : null,
    },
    history: {
      enabled: !!env.SIGNAL_CACHE, maxPerPair: HISTORY_CONFIG.MAX_SIGNALS_PER_PAIR,
      winRateLookback: HISTORY_CONFIG.WIN_RATE_LOOKBACK, resultCheckDelay: HISTORY_CONFIG.RESULT_CHECK_DELAY + 's after expiry',
      endpoints: { history: '/api/history?pair=EUR/USD&limit=20', stats: '/api/stats?pair=EUR/USD', report: '/api/report?id=SIGNAL_ID&result=WIN' },
    },
  });
}

// ── PAIRS ───────────────────────────────────
export function handlePairs() {
  const majorBases = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];
  const majorPairs = [];
  for (const b of majorBases) for (const q of majorBases) if (b !== q) majorPairs.push(b + '/' + q);
  const exoticQ = ['SEK','NOK','DKK','PLN','HUF','CZK','TRY','ZAR','MXN','SGD','HKD','CNH','THB','INR','BRL'];
  const crossPairs = [];
  for (const b of ['EUR','USD','GBP','JPY','AUD','CAD','CHF','NZD']) for (const q of exoticQ) crossPairs.push(b+'/'+q);
  const allCrypto = [];
  for (const b of CRYPTO_BASES) { for (const q of CRYPTO_QUOTES) if (b!==q) allCrypto.push(b+'/'+q); for (const q of ['AUD','CAD','CHF','NZD','HKD','SGD']) allCrypto.push(b+'/'+q); }
  return jsonResponse({
    forex: { currencies: VALID_FOREX_CURRENCIES, currencyCount: VALID_FOREX_CURRENCIES.length, majorPairs: majorPairs.slice(0, 30), crossExoticExamples: crossPairs.slice(0, 30), marketHours: 'Sunday 22:00 UTC to Friday 22:00 UTC' },
    crypto: { bases: CRYPTO_BASES, quotes: CRYPTO_QUOTES, popularPairs: POPULAR_CRYPTO_PAIRS, allPairs: allCrypto, marketHours: '24/7' },
    usage: { forexExample: '/api/signal?pair=EUR/USD', cryptoExample: '/api/signal?pair=BTC/USD', batchExample: '/api/batch?pairs=EUR/USD,GBP/JPY,BTC/USD' },
  });
}

// ── HISTORY ─────────────────────────────────
export async function handleHistory(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const rawPair = url.searchParams.get('pair') || 'EUR/USD';
  const pair    = sanitizePair(rawPair);
  if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 500);   // Phase 11: raised from 50 for slice analysis
  try {
    const histKey = HISTORY_CONFIG.KV_SIGNAL_PREFIX + pair.replace(/\//g,'_').replace(/-/g,'_');
    let history = await env.SIGNAL_CACHE.get(histKey, 'json');
    if (!Array.isArray(history)) history = [];
    const limited = history.slice(0, limit);
    // R7.1: strip the private structure-audit field from every row before it
    // leaves the worker. The audit is internal-only; public /api/history must
    // never expose it (asserted in scripts/r71_tests.mjs #10).
    for (const s of limited) {
      if (s && Object.prototype.hasOwnProperty.call(s, 'structureAudit')) delete s.structureAudit;
    }
    // F3-17 (BUG-018): cbShadow rows are counterfactual (the trade was
    // suppressed by the circuit breaker) — updatePairStats deliberately never
    // counts them, so /api/history must exclude them from decided/pending too
    // or the two public win-rate surfaces diverge. Rows stay visible in
    // `signals` with cbShadow:true for transparency.
    const nonShadow = limited.filter(s => !(s && s.cbShadow === true));
    const decided = nonShadow.filter(s => s.result === 'WIN' || s.result === 'LOSS');
    const wins    = decided.filter(s => s.result === 'WIN').length;
    return jsonResponse({ pair, total: history.length, showing: limited.length, decided: decided.length, pending: nonShadow.filter(s => s.result === null).length, winRate: decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 1000 : null, signals: limited, timestamp: new Date().toISOString() });
  } catch (e) { return jsonResponse({ error: true, message: 'History fetch error: ' + e.message }, 500); }
}

// ── STATS ────────────────────────────────────
export async function handleStats(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const rawPair = url.searchParams.get('pair');
  try {
    if (rawPair) {
      const pair = sanitizePair(rawPair);
      if (!pair) return jsonResponse({ error: true, message: 'Invalid pair: ' + rawPair }, 400);
      const statsKey = HISTORY_CONFIG.KV_STATS_PREFIX + pair.replace(/\//g,'_').replace(/-/g,'_');
      const stats = await env.SIGNAL_CACHE.get(statsKey, 'json');
      if (!stats) return jsonResponse({ pair, message: 'No stats yet.', stats: null, timestamp: new Date().toISOString() });
      stats.dynamicConfidenceAdjustment = await getDynamicConfidenceAdjustment(pair, env);
      return jsonResponse({ pair, stats, timestamp: new Date().toISOString() });
    } else {
      const allStats = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_STATS_PREFIX });
      if (!allStats || !allStats.keys || allStats.keys.length === 0)
        return jsonResponse({ message: 'No stats yet.', pairs: [], timestamp: new Date().toISOString() });
      const summary = [];
      for (const key of allStats.keys) {
        try { const st = await env.SIGNAL_CACHE.get(key.name, 'json'); if (st) summary.push({ pair: st.pair, winRate: st.winRate, totalSignals: st.totalSignals, wins: st.wins, losses: st.losses, lastUpdated: st.lastUpdated }); } catch (e) {}
      }
      summary.sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
      return jsonResponse({ totalPairs: summary.length, pairs: summary, timestamp: new Date().toISOString() });
    }
  } catch (e) { return jsonResponse({ error: true, message: 'Stats error: ' + e.message }, 500); }
}

// ── CALIB (C7) ───────────────────────────────
// Shows the ACTIVE calibration: the static CALIB (initial values) plus the
// dynamic tables from the weekly self-calibration (calib:latest) when fresh.
export async function handleCalib(env) {
  const dynamic = await loadCalibration(env);
  return jsonResponse({
    calibration: {
      static: {
        version: CALIB.version,
        base: CALIB.base,
        structWR: CALIB.structWR,
        confBucketWR: CALIB.confBucketWR,
        gradeThresholds: CALIB.gradeThresholds,
        confThresholds: CALIB.confThresholds,
      },
      dynamic: dynamic ? {
        version: dynamic.version,
        computedAt: dynamic.computedAt,
        windowDays: dynamic.windowDays,
        n: dynamic.n,
        base: dynamic.base,
        structWR: dynamic.structWR,
        confBucketWR: dynamic.confBucketWR,
        hourWR: dynamic.hourWR,
        pairWR: dynamic.pairWR,
        sessionWR: dynamic.sessionWR,
      } : null,
      refresh: {
        cron: CONFIG.SELF_CALIB.CRON,
        windowDays: CONFIG.SELF_CALIB.WINDOW_DAYS,
        minObs: CONFIG.SELF_CALIB.MIN_OBS,
        maxAgeDays: CONFIG.SELF_CALIB.MAX_AGE_DAYS,
      },
      edgeFeatures: {
        enabled: CONFIG.EDGE_FEATURES.enabled,
        hourMultipliers: CONFIG.EDGE_FEATURES.HOUR_MULTIPLIERS,
        rsiDirectionGate: CONFIG.EDGE_FEATURES.RSI_DIRECTION_GATE,
        volState: CONFIG.EDGE_FEATURES.VOL_STATE,
        atrPercentile: CONFIG.EDGE_FEATURES.ATR_PERCENTILE,
        sessionRange: CONFIG.EDGE_FEATURES.SESSION_RANGE,
        recentForm: CONFIG.EDGE_FEATURES.RECENT_FORM,
      },
    },
  });
}

// ── REPORT ───────────────────────────────────
export async function handleReport(url, env) {
  if (!env.SIGNAL_CACHE) return jsonResponse({ error: true, message: 'SIGNAL_CACHE KV not configured.' }, 503);
  const signalId = url.searchParams.get('id');
  const result   = (url.searchParams.get('result') || '').toUpperCase();
  if (!signalId) return jsonResponse({ error: true, message: 'Signal ID required: ?id=SIGNAL_ID' }, 400);
  if (!['WIN','LOSS'].includes(result)) return jsonResponse({ error: true, message: 'result must be WIN or LOSS' }, 400);
  try {
    const allKeys = await env.SIGNAL_CACHE.list({ prefix: HISTORY_CONFIG.KV_SIGNAL_PREFIX });
    if (!allKeys || !allKeys.keys || allKeys.keys.length === 0)
      return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);
    let found = false; let foundRecord = null; let shouldUpdateStats = false;
    for (const kvEntry of allKeys.keys) {
      const histKey = kvEntry.name;
      const history = await env.SIGNAL_CACHE.get(histKey, 'json');
      if (!Array.isArray(history)) continue;
      for (const sig of history) {
        if (sig.id === signalId) {
          foundRecord = sig;
          // Bugfix round 1 (BUG-005): idempotency guard. A second report (or a
          // report AFTER the cron resolved the signal) must NOT re-count stats.
          // Only WIN/LOSS are counted by updatePairStats; UNKNOWN/ties remain
          // re-reportable.
          const alreadyDecided = sig.result === 'WIN' || sig.result === 'LOSS';
          if (!alreadyDecided) {
            sig.result = result; sig.checkedAt = new Date().toISOString(); sig.reportedManually = true;
            await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), { expirationTtl: 60*60*24*30 });
            shouldUpdateStats = true;
          }
          // Drop the pending result-check record so the */2 cron resolver cannot
          // later overwrite this verdict and double-count the outcome.
          await env.SIGNAL_CACHE.delete(HISTORY_CONFIG.KV_PENDING_PREFIX + signalId).catch(() => {});
          found = true; break;
        }
      }
      if (found) break;
    }
    if (!found) return jsonResponse({ error: true, message: 'Signal ID not found: ' + signalId }, 404);
    if (shouldUpdateStats && foundRecord) await updatePairStats(foundRecord.pair, result, foundRecord, env);
    return jsonResponse({
      success: true, signalId, pair: foundRecord?.pair || 'N/A', result,
      alreadyRecorded: !shouldUpdateStats,
      message: shouldUpdateStats ? 'Result recorded. Stats updated.' : 'Result already recorded — stats not double-counted.',
      timestamp: new Date().toISOString(),
    });
  } catch (e) { return jsonResponse({ error: true, message: 'Report error: ' + e.message }, 500); }
}

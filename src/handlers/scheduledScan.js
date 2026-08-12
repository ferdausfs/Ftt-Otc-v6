/**
 * Phase 7 — cron signal scanner (runs every 5 minutes).
 *
 * Keeps `latest:<PAIR>` warm for every pair in SCAN_PAIRS so the App and the
 * Bot can read one shared, already-computed signal instead of each triggering
 * their own engine run.
 *
 * ── Auto-signal delivery (v6.10, F3-14 revert) ───────────────────────────
 * The scanner is ALSO the auto-push path. The worker is the single source of
 * truth (ledger + subscribers) and the bot v4.5.0 removed its own autoScan,
 * so this every-5-minutes cron tick is the ONLY place fresh signals are
 * generated with no human pressing a button — if it does not push, auto
 * signals never reach Telegram subscribers. Push is NOT done here directly:
 * it rides handleSignalRaw -> saveAndPush, which saves the history row first
 * and only pushes when the row is genuinely new (30-min setup dedup), and
 * pushSignalToSubscribers adds the per-(subscriber,pair,direction) pushLock
 * (30-min window). Re-scans and manual /api/signal calls therefore cannot
 * double-deliver. NO_TRADE and circuit-breaker-suppressed signals never mint
 * an id, so they never push. See AGENT_LOG.md (RESTORE AUTO SIGNAL PUSH).
 *
 * ── Engine reuse (spec §5) ──────────────────────────────────────────────────
 * The spec expected to import `generateSignalCore` from signal/engine.js and
 * warned a refactor might be needed. No refactor was required: the request path
 * is already `index.js -> handleSignal() -> handleSignalRaw(pair, env, ctx)`,
 * and handleSignalRaw already returns exactly the response object we want to
 * cache. So the scanner calls that same function — one engine, one code path.
 *
 * ── Why history is NOT saved here ───────────────────────────────────────────
 * The spec's scanOnePair sketch called saveSignalToHistory() itself. That would
 * double-write: handleSignalRaw ALREADY persists BUY/SELL via
 * `ctx.waitUntil(saveSignalToHistory(...))` (signal.js:136 and :217), including
 * the Phase B fields and the circuit-breaker shadow rows. Calling it again here
 * would create two records per signal — the 30-min dedup guard would collapse
 * most, but not all (differing entryPrice on a re-poll slips through), and each
 * one also registers a `pending:` result-check. So we let the existing path own
 * history and only add the KV cache write. See PHASE_7_FIX_REPORT.md §1.3.
 */

import { SCAN_PAIRS, SCAN_CONFIG, ASSET_TYPE } from '../config.js';
import { sanitizePair, getAssetType } from '../utils/pairs.js';
import { isForexMarketOpen } from '../utils/session.js';
import { handleSignalRaw } from './signal.js';
import { writeLatest } from '../history/latestCache.js';

/**
 * Which pairs are worth scanning right now.
 * Crypto is 24/7; forex is skipped while the market is shut so the scan does
 * not spend TwelveData credits on a frozen weekend price.
 *
 * The spec imported `getMarketStatus()` from utils/pairs.js — that function does
 * not exist in this repo. The real market-hours check is isForexMarketOpen()
 * in utils/session.js, which is what /api/signal itself uses.
 */
export function selectActivePairs(pairs = SCAN_PAIRS, forexOpen = isForexMarketOpen()) {
  const active = [];
  for (const raw of pairs) {
    const pair = sanitizePair(raw);
    if (!pair) {
      console.warn('scheduledScan: unsupported pair skipped: ' + raw);
      continue;
    }
    const assetType = getAssetType(pair);
    if (assetType === ASSET_TYPE.FOREX && !forexOpen) continue;   // market closed
    active.push(pair);
  }
  return active;
}

export async function scheduledScan(env, ctx, opts = {}) {
  const startTime = Date.now();
  if (!env || !env.SIGNAL_CACHE) {
    console.warn('scheduledScan: SIGNAL_CACHE not bound, aborting');
    return { ok: 0, failed: 0, skipped: 0, aborted: true };
  }

  const generationId = 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const activePairs = selectActivePairs();
  const skipped = SCAN_PAIRS.length - activePairs.length;
  console.log('scheduledScan start ' + generationId
    + ' active=' + activePairs.length + '/' + SCAN_PAIRS.length
    + (skipped ? ' (skipped ' + skipped + ', market closed/unsupported)' : ''));

  let ok = 0;
  let failed = 0;
  let processed = 0;

  for (let i = 0; i < activePairs.length; i += SCAN_CONFIG.BATCH_SIZE) {
    // Hard cap: a cron invocation must never run away. Partial coverage is
    // fine — the next tick is only 5 minutes out and TTL is 10.
    if (Date.now() - startTime > SCAN_CONFIG.MAX_SCAN_DURATION_MS) {
      console.warn('scheduledScan ' + generationId + ' hit MAX_SCAN_DURATION at '
        + processed + '/' + activePairs.length + ' pairs');
      break;
    }

    const batch = activePairs.slice(i, i + SCAN_CONFIG.BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(pair => scanOnePair(pair, generationId, env, ctx, opts)),
    );
    for (const r of results) {
      processed++;
      if (r.status === 'fulfilled' && r.value) ok++;
      else {
        failed++;
        if (r.status === 'rejected') {
          console.warn('scheduledScan batch rejection: ' + (r.reason && r.reason.message));
        }
      }
    }

    if (i + SCAN_CONFIG.BATCH_SIZE < activePairs.length) {
      await sleep(SCAN_CONFIG.BATCH_DELAY_MS);
    }
  }

  const ms = Date.now() - startTime;
  console.log('scheduledScan done ' + generationId + ': ' + ok + ' ok, ' + failed
    + ' failed, ' + skipped + ' skipped, ' + ms + 'ms');
  return { ok, failed, skipped, generationId, ms };
}

async function scanOnePair(pair, generationId, env, ctx, opts = {}) {
  try {
    // Same entry point /api/signal uses — including circuit-breaker checks and
    // the existing history write via ctx.waitUntil.
    // ── Push contract (v6.10, reverts F3-14/BUG-028) ─────────────────────
    // F3-14 added noPush:true here to stop scanner-push duplication while the
    // BOT still had its own autoScan. Bot v4.5.0 removed autoScan (worker =
    // single source), so noPush would now make auto signals die here: the
    // */5 scanner would save history rows but never deliver them. We therefore
    // do NOT pass noPush — handleSignalRaw's saveAndPush chain pushes exactly
    // when a NEW tradeable row lands in history (30-min setup dedup), and
    // claimPushLock (30-min per subscriber/pair/direction) makes a manual
    // /api/signal call for the same setup a no-op, and vice versa. The scanner
    // itself never double-saves: handleSignalRaw persists, scanOnePair only
    // writes the latest: cache.
    // opts.edgeFeatures / opts.now are test-determinism hooks (production cron
    // omits them → edge features ON, live clock).
    // awaitPersist: the */5 scheduled handler used to wrap this scan in
    // ctx.waitUntil and return immediately; handleSignalRaw then nested
    // another waitUntil(saveAndPush). When the scan promise resolved, the
    // isolate could freeze before Telegram sendMessage finished — history
    // rows landed (fast KV) but pushLog never did. Awaiting the persist
    // here keeps the scan tick alive until the push attempt completes.
    const result = await handleSignalRaw(pair, env, ctx, { ...opts, awaitPersist: true });

    if (!result || result.error) {
      console.warn('scanOnePair ' + pair + ' error: '
        + (result && result.message ? String(result.message).slice(0, 120) : 'unknown'));
      return null;
    }
    // A dummy fallback means every timeframe fetch failed; caching it would
    // serve fabricated prices to both clients for the next 10 minutes.
    if (result.source === 'DUMMY_FALLBACK') {
      console.warn('scanOnePair ' + pair + ' skipped: DUMMY_FALLBACK (all candle fetches failed)');
      return null;
    }
    // Market-closed responses carry no signal; nothing worth caching.
    if (!result.signal) {
      console.warn('scanOnePair ' + pair + ' skipped: no signal in response (marketStatus='
        + result.marketStatus + ')');
      return null;
    }

    const written = await writeLatest(pair, result, {
      generationId,
      generatedAt: new Date().toISOString(),
      opportunistic: false,
    }, env);

    return written ? { pair } : null;
  } catch (e) {
    console.warn('scanOnePair exception ' + pair + ': ' + e.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test-only export (not used at runtime) so fix_tests can drive scanOnePair
// directly on a single pair (repo convention: __dedupTest / __pushTest).
export const __scanTest = { scanOnePair };

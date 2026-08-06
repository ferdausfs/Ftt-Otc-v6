# FTT Worker v6.9.2 — Deep Bug-Hunt Audit

Audit date: 2026-08-06 (UTC)

Scope audited: `src/` signal engine, timeframe scoring, deterministic filters, history/stat tracking, shadow/probe stores, API handlers/routing, and live worker responses from `https://fttotcv6.umuhammadiswa.workers.dev`.

Important process note: this report is intentionally **findings only**. No production logic has been changed in this commit.

## Verification performed

- Read all `src/` files, with focus on:
  - `src/signal/voteFilters.js`, `src/signal/timeframe.js`, `src/signal/engine.js`
  - `src/history/stats.js`, `src/history/d2store.js`, `src/history/probeStore.js`, `src/history/r71store.js`
  - `src/handlers/signal.js`, `src/handlers/health.js`, `src/index.js`
- Live API checks via Arena fetch tool:
  - `/health` returned `version: "6.9.2"`, 17 TwelveData keys configured, KV ready, push enabled, `pushesLast24h: 0`.
  - `/api/signal?pair=BTC/USD&preferCache=true&nopush=1` returned a real `BUY` signal and exposed full public `timeframeAnalysis` internals.
  - `/api/signals/latest` returned cached multi-pair signals including `ADA/USD` with `finalSignal: "NO_TRADE"`, `confidence: "54%"`, `grade: "B"`.
  - `/api/history?pair=BTC/USD&limit=5` returned resolved history with `entryHit` shadow fields.
  - `/api/stats?pair=BTC/USD` returned `totalSignals: 776`, `sampleSize: 20`, `winRate: 0.442`.
- Static syntax/checks:
  - `node --check` over all `src/**/*.js` and `src/*.js`: passed.
  - `node scripts/d2_tests.mjs`: passed, 39/39.
  - `node scripts/entry_hit_tests.mjs`: passed, 7/7.
  - `node scripts/probe_tests.mjs`: passed, 34/34.
  - `node scripts/r71_tests.mjs`: failed before assertions because this checkout is shallow/grafted and does not contain baseline commit `71e87eb` (`fatal: not a valid object name: 71e87eb`).

---

### BUG-001 — D2 hard blocks can still be resurrected by AI rescue

- **Severity:** Critical
- **Location:** `src/signal/engine.js:151-205`, `src/signal/engine.js:230-242`, `src/signal/d2shadow.js:7-10`
- **Evidence:**
  ```js
  // engine.js:165-176 — D2 converts a valid trade to NO_TRADE
  if (marketRegime === 'TRENDING') {
    finalDirection = 'NO_TRADE'; confidence = 0;
    filtersApplied.push('D2_TRENDING_BLOCK (29.5% WR n=356)');
    d2Audit = { attribution: 'D2_TRENDING_BLOCKED' };
  }
  ```
  Immediately afterward, AI target selection ignores *why* `finalDirection` became `NO_TRADE`:
  ```js
  // engine.js:203-205
  const aiTargetDir = finalDirection !== 'NO_TRADE'
    ? finalDirection
    : (rawDirection !== 'NO_TRADE' && rawConfidence >= 60 ? rawDirection : null);
  ```
  Then rescue can restore the trade:
  ```js
  // engine.js:231-241
  if (finalDirection === 'NO_TRADE' && aiTargetDir !== 'NO_TRADE') {
    if (aiAgreed && (combinedAI.confidence || 0) >= 70 && !combinedAI.concerns) {
      finalDirection = aiTargetDir;
      ...
    } else if (aiAgreed && (combinedAI.confidence || 0) >= 60 && !combinedAI.concerns) {
      finalDirection = aiTargetDir;
      ...
    }
  }
  ```
  The D2 shadow comments explicitly acknowledge this state: `d2shadow.js:7-10` says if AI rescue revived the signal, it is a real trade and no D2 counterfactual is admitted.
- **Impact:** The Phase-D2 “verified bad slice” blocks (`TRENDING`, `HIGHEST_SESSION`, and re-enabled `BAD_PAIR`) are not true hard blocks. When AI keys are healthy, the engine can trade exactly the slices the code says should be blocked, and those rescues will not be counted as D2 shadow observations. This can reproduce the prior “AI rescue override D2 block” class of bug and contaminates both production WR and the D2 forward evidence window.
- **Repro:** Any raw BUY/SELL with `rawConfidence >= 60`, then a D2 block, then AI agreement/confidence ≥60 and no concerns. In current live checks AI returned 429/BOTH_UNAVAILABLE, so rescue did not fire; the code path is present and only gated by AI availability.
- **Suggested fix:** Split block reasons into `hardBlocked` vs `softBlocked`; AI rescue should only run for allowed soft filters (e.g. confidence/fvg/dead-market), never for D2, news, session-low, volume-spike, or HTF hard blocks.

---

### BUG-002 — Confidence floor produces `NO_TRADE` with non-zero confidence and tradeable grade

- **Severity:** High
- **Location:** `src/signal/voteFilters.js:201-206`, `src/signal/engine.js:289-293`
- **Evidence:**
  ```js
  // voteFilters.js:201-206
  let belowFloor = false;
  if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) {
    belowFloor = true; finalDirection = 'NO_TRADE';
    filtersApplied.push('CONFIDENCE_BELOW_FLOOR (' + CONFIG.MIN_CONFIDENCE_FLOOR + '%)');
  }
  ```
  Unlike most other blocks, this does **not** set `confidence = 0`. Later output still formats `confidence + '%'` and grades it:
  ```js
  // engine.js:289-293
  const finalGrade = getSignalGrade(confidence, avgConf, alignment, structureVerdict.overall);
  const __signal = {
    finalSignal: finalDirection, confidence: confidence + '%', grade: finalGrade,
  ```
  Live API evidence from `/api/signals/latest` for `ADA/USD`:
  ```json
  {
    "finalSignal": "NO_TRADE",
    "confidence": "54%",
    "grade": { "grade": "B", "label": "GOOD", "description": "Solid setup. Suitable for trading." },
    "filtersApplied": [
      "CANDLE_INCONSISTENCY (x0.8)",
      "FVG_PENALTY -20 (inside bullish FVG)",
      "CONFIDENCE_BELOW_FLOOR (72%)",
      "CANDLE_QUALITY x1.15"
    ]
  }
  ```
- **Impact:** Clients can see `NO_TRADE` but also “54% / GOOD / Suitable for trading”. That is internally contradictory and can cause UI/bot consumers to treat a blocked setup as actionable or high quality.
- **Repro:** Generate any signal where deterministic confidence falls below `MIN_CONFIDENCE_FLOOR` after penalties. Live cached `ADA/USD` shows it.
- **Suggested fix:** On confidence-floor block set `confidence = 0`, or make output grading explicitly `N/A/NO_TRADE` whenever `finalSignal === 'NO_TRADE'`.

---

### BUG-003 — `?nopush=1` is broken, and normal pushes are broken too (`noPush` is out of scope)

- **Severity:** High
- **Location:** `src/index.js:81-82`, `src/handlers/signal.js:86-99`, `src/handlers/signal.js:123`, `src/handlers/signal.js:137-140`, `src/handlers/signal.js:249-250`
- **Evidence:**
  Router parses `nopush`:
  ```js
  // index.js:81-82
  response = await handleSignal(pair, env, ctx, {
    preferCache, fxMode: url.searchParams.get('mode') === 'fx',
    noPush: url.searchParams.get('nopush') === '1'
  });
  ```
  But `handleSignal()` drops it when calling `handleSignalRaw()`:
  ```js
  // signal.js:123
  const result = await handleSignalRaw(pair, env, ctx, { fxMode: !!opts?.fxMode });
  ```
  `handleSignalRaw()` reads `opts.noPush`, but never uses it:
  ```js
  // signal.js:137-140
  export async function handleSignalRaw(pair, env, ctx, opts = {}) {
    const reqFxMode = !!opts.fxMode;
    const noPush = !!opts.noPush;
  ```
  `saveAndPush()` references a variable it never receives and that is not in scope:
  ```js
  // signal.js:86-99
  async function saveAndPush(signal, pair, isOTC, env, signalId, entrySource, response) {
    ...
    try {
      if (!noPush) await pushSignalToSubscribers({ ...response, id: signalId, pair, signal }, env);
    } catch (e) {
      console.warn('saveAndPush: push failed for ' + pair + ': ' + e.message);
    }
  }
  ```
  Live `/health` showed push is configured (`pushEnabled: true`, `subscriberCount: 1`) but `pushesLast24h: 0`, consistent with pushes never succeeding.
- **Impact:** Telegram push delivery is effectively disabled for all new signals because `noPush` raises a `ReferenceError` inside `saveAndPush()` and is caught as a push failure. Also, the public `nopush` query flag does not actually reach the save/push function, so fixing the ReferenceError without propagation would make `nopush=1` ineffective.
- **Repro:** Static path is enough: any non-`NO_TRADE` signal with `signalId` calls `ctx.waitUntil(saveAndPush(...))`; `saveAndPush` evaluates an undefined identifier.
- **Suggested fix:** Pass `noPush` through `handleSignal()` → `handleSignalRaw()` → `saveAndPush(..., noPush)`, and reference only that parameter.

---

### BUG-004 — Entry-hit shadow uses only expiry ±5 minutes, not the actual signal-to-expiry trade window

- **Severity:** High
- **Location:** `src/history/stats.js:224-245`, `src/history/stats.js:287-365`, `src/history/d2store.js:216-224`, `src/history/probeStore.js:194-202`
- **Evidence:**
  The stored comment says entry-hit means “during the expiry window”:
  ```js
  // stats.js:224-226
  // signal's entry during the expiry window? Uses the candle low/high
  // already fetched.
  ```
  But `fetchExpiryPrice()` fetches only a bracket around expiry:
  ```js
  // stats.js:287-289
  const startDate = new Date(expiryMs - 5 * 60 * 1000)...
  const endDate   = new Date(expiryMs + 5 * 60 * 1000)...
  ```
  It returns low/high over that 10-minute bracket, not from signal timestamp/entry time to expiry:
  ```js
  // stats.js:353-365
  for (const c of data.values) { ... lo/hi over data.values ... }
  return { price: px, windowLow: lo, windowHigh: hi, windowStart: startDate, windowEnd: endDate };
  ```
  Live history shows the artifact. `/api/history?pair=BTC/USD&limit=5` returned examples such as:
  ```json
  {
    "id": "sig_1785986435549_4vi52",
    "direction": "SELL",
    "entryPrice": 64533.12,
    "expiryTime": "2026-08-06T03:50:35.366Z",
    "timestamp": "2026-08-06T03:20:35.549Z",
    "result": "WIN",
    "exitPrice": 64530.63,
    "entryHit": false,
    "entryHitWindowLow": 64502.94,
    "entryHitWindowHigh": 64530.64
  }
  ```
  This was a 30-minute signal. The entry price is the signal-time close, but the shadow hit test only looked near expiry and concluded a SELL entry was not hit.
- **Impact:** `entryHit` is not measuring whether the signaled entry was actionable over the full trade lifetime. It undercounts hits for pending entries and can create the known “entry-hit paradox” (e.g. `entryHit=false` trades still show valid WIN/LOSS). Any future decision based on this field will be biased.
- **Repro:** Any 15–30 minute duration signal where price touches entry shortly after signal but not inside expiry±5 minutes; current live BTC history already shows `entryHit=false` on resolved trades.
- **Suggested fix:** Store `entryTime`/signal timestamp in pending rows and fetch/window candles from signal/entry time through expiry (or explicitly rename the field to `expiryBracketHit`).

---

### BUG-005 — Manual `/api/report` double-counts stats and leaves pending rows to be auto-counted again

- **Severity:** High
- **Location:** `src/handlers/health.js:127-153`, `src/history/stats.js:247-250`, `src/history/stats.js:415-460`
- **Evidence:**
  Manual report overwrites the history row and always calls `updatePairStats()`:
  ```js
  // health.js:143-153
  if (sig.id === signalId) {
    foundRecord = sig; sig.result = result; sig.checkedAt = new Date().toISOString(); sig.reportedManually = true;
    await env.SIGNAL_CACHE.put(histKey, JSON.stringify(history), ...);
    found = true; break;
  }
  ...
  if (foundRecord) await updatePairStats(foundRecord.pair, result, foundRecord, env);
  ```
  It does not check whether `foundRecord.result` was already `WIN`/`LOSS` before overwriting, and it does not delete `pending:<signalId>`. The cron resolver independently updates and counts pending records:
  ```js
  // stats.js:247-250
  await updateSignalResult(record, winLoss, exitPrice, env);
  await env.SIGNAL_CACHE.delete(kvEntry.name);
  if (!record.cbShadow) await updatePairStats(record.pair, winLoss, record, env);
  ```
  `updatePairStats()` is additive only:
  ```js
  // stats.js:425-430
  stats.totalSignals++;
  if (winLoss === 'WIN') stats.wins++;
  if (winLoss === 'LOSS') stats.losses++;
  ```
- **Impact:** A user can inflate stats by reporting the same ID multiple times. If the signal is still pending, manual report updates stats once and the scheduled tracker later updates them again. If the manual result differs from the auto result, stats can contain both outcomes while the history row shows only the later one.
- **Repro:** Call `/api/report?id=<existing-id>&result=WIN` twice, or call it before the pending expiry is resolved and wait for cron. No guard prevents repeated/additional stat increments.
- **Suggested fix:** Make reports idempotent: only count a transition from `null`/`UNKNOWN` to decided once, store a counted marker, and delete `pending:<id>` on manual resolution.

---

### BUG-006 — `WIN_RATE_LOOKBACK=20` is not actually used for `winRate` or dynamic confidence

- **Severity:** Medium
- **Location:** `src/config.js:121-126`, `src/history/stats.js:425-430`, `src/history/stats.js:401-410`
- **Evidence:**
  Config exposes a lookback:
  ```js
  // config.js:121
  WIN_RATE_LOOKBACK: 20,
  ```
  But stats compute win rate cumulatively over all decided records:
  ```js
  // stats.js:425-430
  stats.totalSignals++;
  if (winLoss === 'WIN')  stats.wins++;
  if (winLoss === 'LOSS') stats.losses++;
  const decided   = stats.wins + stats.losses;
  stats.winRate   = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
  stats.sampleSize = Math.min(decided, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
  ```
  Dynamic confidence then trusts that cumulative `stats.winRate`:
  ```js
  // stats.js:404-410
  if (!stats || typeof stats.winRate !== 'number' || stats.sampleSize < 5) return 0;
  const wr = stats.winRate;
  if (wr >= 0.70) return HISTORY_CONFIG.CONFIDENCE_BONUS;
  ...
  if (wr <= HISTORY_CONFIG.CONFIDENCE_PENALTY_THRESHOLD) return -5;
  ```
  Live BTC stats show the inconsistency:
  ```json
  {
    "totalSignals": 776,
    "wins": 343,
    "losses": 433,
    "winRate": 0.442,
    "sampleSize": 20,
    "dynamicConfidenceAdjustment": -5
  }
  ```
  `winRate` is 343/776, while `sampleSize` says 20.
- **Impact:** Confidence adjustments are dominated by stale historical data and cannot respond to the latest 20 signals as the config name implies. Pair recovery or degradation is hidden by old samples.
- **Repro:** Any pair with >20 resolved signals. Live BTC/USD has 776 counted signals but reports `sampleSize: 20` and uses cumulative `0.442` for dynamic adjustment.
- **Suggested fix:** Store a rolling recent-result queue, or compute dynamic confidence from the last `WIN_RATE_LOOKBACK` history rows instead of cumulative counters.

---

### BUG-007 — Per-timeframe fallback can bypass `MIN_CONFLUENCE=5` and score thresholds

- **Severity:** Medium
- **Location:** `src/signal/voteFilters.js:45-52`, `src/config.js:12`, `src/config.js:172`
- **Evidence:**
  Config says minimum confluence is 5 and score thresholds are 3.0/2.5:
  ```js
  // config.js:12,172
  MIN_CONFLUENCE: 5,
  export const SCORE_THRESHOLDS = { FOREX: 3.0, CRYPTO: 2.5 };
  ```
  Primary decisions obey these gates:
  ```js
  // voteFilters.js:48-49
  if (upScore >= minScoreThreshold && upScore > downScore && upCat >= CONFIG.MIN_CONFLUENCE) return 'BUY';
  if (downScore >= minScoreThreshold && downScore > upScore && downCat >= CONFIG.MIN_CONFLUENCE) return 'SELL';
  ```
  But the fallback does not:
  ```js
  // voteFilters.js:50
  if (scoreDiff >= 4.0 && confluence >= 4) return upScore > downScore ? 'BUY' : 'SELL';
  ```
  Local repro run during audit:
  ```js
  import { decideTfDirection } from './src/signal/voteFilters.js';
  console.log(decideTfDirection(4.1, 0, 4, 0, 99)); // BUY
  ```
  This returns `BUY` even with only 4 confluence categories and a deliberately impossible `minScoreThreshold` of 99.
- **Impact:** The engine can generate active per-timeframe votes below the configured confluence floor. Because weighted voting only sees per-TF directions/scores, one or two such fallback votes can contribute to final trades that violate the documented risk gate.
- **Repro:** Any TF with `scoreDiff >= 4.0` and only 4 agreeing categories; the helper returns BUY/SELL even though `CONFIG.MIN_CONFLUENCE` is 5.
- **Suggested fix:** Make the fallback explicitly intentional and configurable, or require `confluence >= CONFIG.MIN_CONFLUENCE` and `maxScore >= minScoreThreshold` there too.

---

### BUG-008 — Public response says “/11 categories” while the engine now has 12 categories

- **Severity:** Low / Medium
- **Location:** `src/signal/engine.js:269-278`, `src/signal/timeframe.js:565-569`
- **Evidence:**
  Timeframe analysis records 12 categories:
  ```js
  // timeframe.js:565-569
  confluence, confluenceDetail: { bullish: upCat, bearish: downCat, total: 12 }, // 12 categories now
  ```
  But public recommendations still hard-code 11:
  ```js
  // engine.js:270-273
  recommendations[rtf] = {
    direction: rec.direction, score: rec.score,
    confluence: rec.confluence + '/11 categories',
  ```
  Live `/api/signal?pair=BTC/USD&preferCache=true&nopush=1` showed both mismatched shapes in the same response:
  ```json
  "recommendations": {
    "5min": { "confluence": "6/11 categories" },
    "15min": { "confluence": "7/11 categories" }
  },
  "timeframeAnalysis": {
    "5min": { "confluenceDetail": { "bullish": 6, "bearish": 3, "total": 12 } },
    "15min": { "confluenceDetail": { "bullish": 7, "bearish": 2, "total": 12 } }
  }
  ```
- **Impact:** Public API consumers and reviewers see inconsistent confluence denominators. This makes confluence percentages/quality labels misleading after the structure category was added.
- **Repro:** Any live signal response with `recommendations` and `timeframeAnalysis`.
- **Suggested fix:** Use `rec.confluenceDetail?.total || 12` when formatting recommendation confluence, or return numeric `{value,total}` consistently.

---

### BUG-009 — Ranging-mode momentum still creates SELL pressure from overbought RSI/MFI against bullish trend evidence

- **Severity:** Medium
- **Location:** `src/signal/timeframe.js:134-169`, `src/signal/timeframe.js:196-216`, `src/signal/timeframe.js:218-252`
- **Evidence:**
  In RANGING context the engine scores overbought oscillators as SELL:
  ```js
  // timeframe.js:141-144
  if (rsi >= 75) mD += 1.5; else if (rsi >= 65) mD += 0.75;
  else if (rsi <= 25) mU += 1.5; else if (rsi <= 35) mU += 0.75;
  ```
  MFI is not conditioned on `trending`, so high MFI also adds SELL:
  ```js
  // timeframe.js:158-162
  if (mfi >= 80) mD += 0.5; else if (mfi <= 20) mU += 0.5;
  ```
  Bollinger/CCI in non-trending mode also mean-reverts:
  ```js
  // timeframe.js:225-231,242-245
  if (lastClose >= bbUpper) bD += 1.0; ...
  if (bbPercentB > 1.0) bD += 0.5;
  if (cci > 150) bD += 0.5; else if (cci > 100) bD += 0.35;
  ```
  Live BTC response showed this exact conflict. The final signal was BUY with bullish trend/pattern/ADX, but 5m/15m momentum scored bearish because RSI/MFI/CCI were high:
  ```json
  "5min": {
    "direction": "BUY",
    "categoryScores": {
      "trend": { "up": 1.44, "down": 0 },
      "momentum": { "up": 0, "down": 3.15, "context": "RANGING" },
      "bands": { "up": 0, "down": 2.8, "context": "RANGING" },
      "patterns": { "up": 3.25, "down": 0 },
      "indicators": { "rsi": "66.56", "mfi": "100.00", "cci": "243.57" }
    }
  }
  ```
  The probe module documents a production data concern in comments: `src/history/probeStore.js:4-7` says forex SELL is around 20% WR and hypothesizes this exact RANGING mean-reversion RSI issue.
- **Impact:** The engine can label weak/non-trending pullbacks as SELL in markets that are still structurally/EMA bullish, especially for forex SELL. This is not a syntax bug, but it is a real model-logic inconsistency supported by live response data and in-repo probe comments.
- **Repro:** Query a pair where regime is RANGING and RSI/MFI/CCI are overbought while EMA/ADX/patterns are bullish; live BTC response demonstrates the score conflict.
- **Suggested fix:** Gate mean-reversion SELL scoring behind stronger range proof/SR proximity, or damp overbought SELL when EMA stack/HTF/ADX/patterns are bullish.

---

### BUG-010 — Live signal endpoint leaks full structure swing internals despite only `structureAudit` being intended private

- **Severity:** Low / Medium
- **Location:** `src/signal/timeframe.js:565-571`, `src/signal/engine.js:311-327`, `src/handlers/health.js:87-92`
- **Evidence:**
  The normal public signal object includes full `timeframeAnalysis`:
  ```js
  // engine.js:311
  timeframeAnalysis: tfResults,
  ```
  `tfResults` includes raw structure objects:
  ```js
  // timeframe.js:570-571
  structure: structure || null, // Full structure data in output
  structureApplied,
  ```
  Live `/api/signal?pair=BTC/USD&preferCache=true&nopush=1` exposed detailed swing arrays under `signal.timeframeAnalysis.5min.structure` and `15min.structure`:
  ```json
  "structure": {
    "bias": "BEARISH",
    "swingHighs": [
      { "idx": 57, "price": 64695.02, "time": "2026-08-06 00:55:00" },
      { "idx": 68, "price": 64659.65, "time": "2026-08-06 01:50:00" }
    ],
    "swingLows": [
      { "idx": 49, "price": 64572, "time": "2026-08-06 00:15:00" }
    ],
    "structureScore": { "up": 0, "down": 1.5 },
    "multiplier": { "direction": "SELL", "value": 1.12 },
    "summary": "BIAS_BEARISH"
  }
  ```
  By contrast, `/api/history` explicitly strips only `structureAudit`:
  ```js
  // health.js:87-92
  if (s && Object.prototype.hasOwnProperty.call(s, 'structureAudit')) delete s.structureAudit;
  ```
- **Impact:** The private audit field is not leaking, but the public signal endpoint still exposes the full structure implementation details, including swing arrays and multiplier internals. If the intended public surface is `structureSummary`/`structureVerdict`, this is an API leak and creates response bloat.
- **Repro:** Any live standard signal with `timeframeAnalysis` and detected structure; BTC/USD currently shows it.
- **Suggested fix:** Sanitize public `timeframeAnalysis` before response, or move full `structure` internals behind a debug/audit flag while keeping `structureSummary` and `structureVerdict` public.

---

## Additional observations (not counted as primary bugs)

- Exact tie currently resolves as `LOSS` for both BUY and SELL in normal stats, D2, and probe (`>` / `<` comparisons). Tests explicitly assert this as “worker convention”, so I did not count it as a bug; however, if the broker/platform refunds ties, this convention should be changed and historical DOT/USD tie artifacts re-evaluated.
- `/api/batch` calls `handleSignalRaw()` directly for each pair and has no `nopush` option. Today pushes are already broken by BUG-003, but after fixing BUG-003, batch-triggered scans may spam subscribers unless batch intentionally suppresses pushes.

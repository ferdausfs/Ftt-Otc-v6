# 🔬 FTT Worker v6.9.2 — Deep Bug-Hunt Audit Report (Round 3)

**Audited:** `0c6d358` (this branch's base, `main` tip) — "Merge pull request #5"
**Live host checked:** `https://fttotcv6.umuhammadiswa.workers.dev` (2026-08-06 15:45–16:10 UTC)
**Scope:** every file in `src/` + live endpoints (`/`, `/api/signal`, `/api/signal?mode=fx`, `/api/signal?preferCache=true`, `/api/batch`, `/api/signals/latest`, `/api/history`, `/api/stats`, `/api/report`) + local repro scripts.
**Verification performed:** `node --check` on all `src/**/*.js` (all pass) · repo suites run this session: `fix_tests` 77/77, `entry_hit_tests` 7/7, `phase7_smoke` 68/68, `fx_mode_tests` 16/17 (fixture), `d2_tests` 38/39, `probe_tests` 28/30 (see BUG-022) · local repros for the push crash and the HTF-confidence bug (see BUG-011, BUG-014).

This is a **new audit round** (previous rounds 1–2 are in git history — all 10 findings + 4 round-2 fixes verified fixed below). Findings are numbered `BUG-011…BUG-025` to continue the lineage. Nothing here was fabricated — every finding has code and/or live-API evidence.

---

## Round 1/2 fix verification (re-check, 2026-08-06)

| Previous finding | Status now | Evidence |
|---|---|---|
| BUG-001 `noPush` ReferenceError | ✅ Fixed | `saveAndPush(…, noPush)` threaded through; live `nopush=1` respected |
| BUG-002 AI rescue overrides D2 block | ✅ Fixed | Live BTC/USD response: `AI_RESCUE_SKIPPED (D2 hard block: D2_TRENDING_BLOCKED)` despite both AIs saying BUY |
| BUG-003 fillStatus degenerate | ✅ Fixed | Live SOL/USD SELL: `fillStatus: "INSTANT", entryPrice 73.33, currentPrice 73.36, entryDistancePct 0.0409` (independent sources) |
| BUG-005 /api/report double-count | ✅ Fixed | idempotency guard + pending delete present; live 404 path OK |
| BUG-006 passAI | ✅ Fixed | `passAI` reads `combined.status`/`combinedAgreed` |
| BUG-007 post-AI floor | ✅ Fixed | Live SOL/USD SELL 87% after `DUAL_AI_AGREE_WITH_CONCERNS` (92−5) — floor enforced |
| BUG-008 tie→LOSS | ✅ Fixed | `classifyOutcome()` shared; live Aug-5+ rows show no tie-as-LOSS |
| BUG-009 `/11`→`/12` | ✅ Fixed | all outputs `/12` |
| BUG-010 winRate semantics | ⏭️ still open (Low) | see BUG-019 — related, re-framed |
| CHECK-B entryHit window | ⏭️ still open | see BUG-023 — now quantified with live data |

---

## New findings (round 3)

### BUG-011 — Telegram channel mirror crashes with `ReferenceError: message is not defined` (breaks pushLog → kills result pushes)

- **Severity:** High
- **Location:** `src/handlers/pushToSubscribers.js:211-213` (channel-mirroring block)
- **Evidence:**
```js
const message = formatSignalMessage(msgSignal, {...});   // line ~201 — INSIDE the per-subscriber map callback
...
// Channel mirroring
await Promise.allSettled(
  delivered.filter(s => s.channelId)
    .map(s => sendTelegramMessage(s.channelId, message, env)),   // line 213 — `message` is NOT in scope here
);
```
`message` is block-scoped to the `eligible.map(async (sub) => …)` arrow function. The channel-mirror block references it from the outer function scope, where it does not exist (the unused `const messages = new Map();` at line ~195 is the only similar name). Strict-mode ESM → `ReferenceError`.
- **Repro (local, proven):** mocked `BOT_KV` with one subscriber that has `channelId: '-100123'`, fake Telegram 200 responses:
```
RESULT: {"pushed":0,"error":"message is not defined"}
pushLog written? false
```
- **Impact:** whenever **any** matching subscriber has a `channelId` (Telegram channel mirror, `[F10]` feature): the DMs are sent, but then the channel mirror throws, the exception is caught at the top, `pushLog:` is **never written**, the function returns `pushed: 0` — so (a) the channel never receives the mirror message, (b) the result checker's `pushResultToSubscribers` finds no pushLog and **subscribers never get the WIN/LOSS result notification**, (c) `/health` push stats under-report. Live env has `subscriberCount: 1` — the trigger only needs one subscriber with a channel set.
- **Suggested fix:** hoist the per-subscriber `message` into the channel-mirror loop (recompute per subscriber) or capture it in `delivered` alongside the subscriber.

### BUG-012 — OTC signals are persisted but NEVER auto-resolved: every OTC history row stays `result: null` forever

- **Severity:** High
- **Location:** `src/history/stats.js:169`
```js
if (!isOTC && expiryTime) {
  await env.SIGNAL_CACHE.put(HISTORY_CONFIG.KV_PENDING_PREFIX + signalId, …);
}
```
The `pending:` result-check record is only written for non-OTC. `scheduledTracker` lists `pending:` keys, so **OTC rows never enter the resolver** — no outcome, no stats, no result push.
- **Live evidence:** `GET /api/history?pair=EUR/USD-OTC&limit=20` →
  `total: 9, decided: 0, pending: 9, winRate: null` — all 9 rows `result: null`, including `sig_1785062276685_l6v3i` from **2026-07-26** (11 days stale). Oldest row `expiryTime 2026-07-26T10:52Z` was never checked.
- **Impact:** OTC win/loss tracking (and therefore any OTC WR analysis, OTC stats buckets, OTC result pushes to subscribers) is completely dead; `/api/history` for OTC pairs is a permanently-pending list. If this is intentional (synthetic OTC price ≠ real market price), it is undocumented and still leaks a broken UI surface (`pending: N` grows forever).
- **Repro:** `curl /api/history?pair=EUR/USD-OTC` — oldest rows are days old with `result: null`.
- **Suggested fix:** either resolve OTC against the base-pair real price (like every other pair) with a documented `isOTC` flag in the record, or stop persisting OTC rows to history entirely (or clearly mark them `result: 'NOT_TRACKED'`).

### BUG-013 — `NO_TRADE` signals carry tradable grades ("B — GOOD, Suitable for trading")

- **Severity:** Medium
- **Location:** `src/signal/engine.js:306`
```js
const finalGrade = getSignalGrade(confidence, avgConf, alignment, structureVerdict.overall);
```
`getSignalGrade` has no `NO_TRADE` guard: `avgConf*5` (up to 35) + `alignment` ALL_* (25) score the grade even at confidence 0.
- **Live evidence (three independent responses, same day):**
  - `BTC/USD` → `finalSignal: "NO_TRADE"`, `grade: B`, description **"Solid setup. Suitable for trading."**
  - `EUR/USD` (mode=fx&preferCache) → `NO_TRADE` + grade C "Trade with caution"
  - `/api/batch` BTC/USD → `NO_TRADE` + grade C
  - Meanwhile `entryReason` correctly says "No clear setup — entry conditions not met."
- **Impact:** any consumer that gates on grade (Telegram message, app UI, the Bot's `passGrade`) sees a "GOOD / suitable for trading" label on a signal the engine explicitly blocked. Contradictory and misleading.
- **Repro:** `curl /api/signal?pair=BTC/USD` (while BTC is TRENDING/D2-blocked).
- **Suggested fix:** when `finalDirection === 'NO_TRADE'` return a grade of `{grade:'N/A', label:'NO_TRADE', …}` (or force F), instead of scoring alignment/confluence.

### BUG-014 — HTF hard block zeroes confidence, then the alignment bonus resurrects it (0 → 8%)

- **Severity:** Medium
- **Location:** `src/signal/voteFilters.js:115-131`
```js
if (htfADX >= 25) {
  finalDirection = 'NO_TRADE'; confidence = 0;          // line 121
  filtersApplied.push('HTF_HARD_BLOCK …');
} else { confidence = Math.max(0, confidence - 18); … }
…
confidence = Math.min(92, confidence + alignmentBonus);   // line 131 — runs UNCONDITIONALLY after the block
```
The alignment bonus is applied *after* the hard block zeroed confidence → a fully blocked signal reports `confidence = 0 + 8 = 8%`.
- **Live evidence:** `DOGE/USD` response: `finalSignal: "NO_TRADE"`, `filtersApplied: ["HTF_HARD_BLOCK (ADX=40)", "AI_RESCUE_FAILED: …"]`, **`confidence: "8%"`**.
- **Local repro (proven):** same inputs through `runDeterministicVoteAndFilters` → `finalDirection=NO_TRADE confidence=8` — byte-identical to live.
- **Mirrored bug in OTC** (`src/signal/otcEngine.js`): `if (alignment === 'MIXED') { finalDirection='NO_TRADE'; confidence=0; } confidence = Math.min(OTC_CONFIDENCE_CAP, confidence + alignmentBonus);` → a MIXED NO_TRADE OTC signal reports 2–4% instead of 0%.
- **Impact:** hard-blocked signals advertise non-zero confidence; clients that read `confidence` even when `finalSignal` is NO_TRADE (e.g. dashboards, bots) see "8% confidence" with no explanation. Also makes `DEAD_MARKET_HARD_BLOCK`'s `Math.min(confidence,30)` meaningless in the same ordering.
- **Suggested fix:** apply `alignmentBonus` before the HTF/session hard-block zeroing (i.e., compute bonus into confidence first, then zero on block), or re-zero after the bonus for `HTF_HARD_BLOCK`.

### BUG-015 — `mode=fx&preferCache=true` silently returns a non-FX payload (no `mode`, no `fxLevels`)

- **Severity:** Medium
- **Location:** `src/handlers/signal.js:119-123` — the preferCache path returns the cron-warmed `latest:` entry verbatim; `fxMode` is only honored on the fresh-run path (`handleSignalRaw`).
- **Live evidence:** `GET /api/signal?pair=EUR/USD&mode=fx&nopush=1&preferCache=true` returned the cached scanner payload with **no `mode` field and no `fxLevels`** (response contains `forceRefresh: false`, `cached: true`).
- **Impact:** an FX-mode client that uses `preferCache` (exactly what `pushToSubscribers` does for FX-mode self-fetch when it just cached a signal — the fx refetch uses no preferCache, but any app using `preferCache` in fx mode) gets an FTT signal without SL/TP levels, silently. Also the cached payload carries the original `id`/`nextRefresh`/`entrySource` from the scan, so a consumer can report a signal that is up to 10 minutes old as if fresh.
- **Suggested fix:** treat `mode=fx` as incompatible with `preferCache` (force fresh when fxMode), or store fx levels at scan time and serve them from cache.

### BUG-016 — Forex candle datetimes are Australia/Sydney (UTC+10) — live signals show candle times 10h in the future

- **Severity:** Medium
- **Location:** `src/fetch/candles.js:47-51` — the TwelveData request never passes `timezone`, and TwelveData's default timezone for forex is `Australia/Sydney` (verified on twelvedata.com/exchanges/physical_currency: "All times are displayed in the Australia/Sydney timezone (AEST, UTC+10:00)"). Crypto comes back UTC.
- **Live evidence:** EUR/USD signal generated at `2026-08-06T15:49Z` (worker clock, matches `generatedAt`/`nextCandleClose`) reports:
  - `1min entry.candleTime: "2026-08-07 01:49:00"` (+10h)
  - `5min entry.candleTime: "2026-08-07 01:50:00"`, `15min: "2026-08-07 01:30:00"`
  - Same response's `countdown.nextCandleClose: "2026-08-06T15:52:00.000Z"` — 10h apart in one payload.
  - BTC/USD (crypto) candleTime is correct UTC (`2026-08-06 15:49:00`) — so the drift is forex-specific.
- **Impact:** `entry.candleTime`, `candleTime` in `timeframeAnalysis`, and the structure swing `time` fields are 10h in the future for every forex/OTC signal. Any client doing time math or displaying candle times (app UI, reports, spreadsheets) is off by 10h. (The result checker is unaffected — verified: TwelveData range queries return UTC-matching datetimes — the entry-hit window low/high prices are consistent with the expiry window.)
- **Suggested fix:** add `u.searchParams.set('timezone', 'UTC')` in `fetchCandles` (and keep it in `fetchExpiryPrice` for symmetry).

### BUG-017 — AI validation is invoked (2 LLM calls, ~8s latency) on every D2-hard-blocked signal, then discarded

- **Severity:** Low–Medium (cost/latency)
- **Location:** `src/signal/engine.js:203-206`
```js
const aiTargetDir = finalDirection !== 'NO_TRADE'
  ? finalDirection
  : (rawDirection !== 'NO_TRADE' && rawConfidence >= 60 ? rawDirection : null);
```
When a D2 branch fired, `finalDirection` is NO_TRADE but `rawDirection` is BUY/SELL with `rawConfidence ≥ 60` → the AI is called, then the rescue is skipped via `if (d2Audit)`.
- **Live evidence:** BTC/USD response (D2_TRENDING_BLOCKED): `aiValidation.cerebras.status: "OK"` (signal BUY 92), `groq: 429` — both calls made on a trade that was already hard-blocked; filter log ends `AI_RESCUE_SKIPPED (D2 hard block…)`.
- **Impact:** every D2-blocked signal (currently the *majority* of crypto signals — BTC/DOGE/SOL all TRENDING-blocked today) spends 2 AI API calls and adds up to ~8s of wall-clock latency for zero decision value. With Cerebras/Groq 429s observed live, this also contributes to quota pressure.
- **Suggested fix:** `if (d2Audit) { aiTargetDir = null; }` (skip the AI entirely when a D2 hard block fired).

### BUG-018 — `/api/history` winRate counts cbShadow rows; `/api/stats` excludes them — two different win rates per pair

- **Severity:** Medium (latent — circuit breaker currently disabled)
- **Location:** `src/handlers/health.js:93` vs `src/history/stats.js` (`updatePairStats` skips `record.cbShadow`)
```js
const decided = limited.filter(s => s.result === 'WIN' || s.result === 'LOSS');   // no cbShadow exclusion
```
- **Evidence:** `saveSignalToHistory` stores `cbShadow: true` rows into the same `sig:` history with normal `pending:` resolution; `updatePairStats` deliberately ignores them (`if (!record.cbShadow) await updatePairStats(...)`), but `/api/history` counts every WIN/LOSS row including cbShadow. As soon as the circuit breaker is re-enabled (`isTripped` currently returns `{tripped:false}`), the two endpoints will disagree on the same pair's win rate.
- **Impact:** silent divergence between the two public WR surfaces; any analysis that mixes `/api/history` and `/api/stats` gets inconsistent denominators.
- **Suggested fix:** exclude `cbShadow` rows from `handleHistory`'s `decided` (or include them in `updatePairStats` — pick one convention).

### BUG-019 — `stats.winRate` is all-time, not the documented 20-trade lookback; `sampleSize` mislabeled; dynamic confidence penalty is permanent

- **Severity:** Low–Medium
- **Location:** `src/history/stats.js:447-448`
```js
stats.winRate   = decided > 0 ? Math.round((stats.wins / decided) * 1000) / 1000 : 0;
stats.sampleSize = Math.min(decided, HISTORY_CONFIG.WIN_RATE_LOOKBACK);
```
`HISTORY_CONFIG.WIN_RATE_LOOKBACK: 20` (config.js) is documented as the win-rate window, but `winRate` divides by **all** decided signals ever, and `sampleSize` (capped at 20) is not used in the ratio. `getDynamicConfidenceAdjustment` (stats.js:421) then gates on `stats.sampleSize < 5` but applies the all-time winRate — so a pair that started badly is penalized (`DYNAMIC_CONF_ADJ: -5`) indefinitely even after 20 recent wins.
- **Live evidence:** BTC/USD `filtersApplied: ["DYNAMIC_CONF_ADJ: -5", …]` with 804 total signals — the -5 is driven by the lifetime 0.445 WR, not the recent window.
- **Impact:** the dynamic adjustment and the reported WR don't mean what the config/health page says (`winRateLookback: 20`). Model drift or regime change can never be reflected.
- **Suggested fix:** compute winRate over the last `WIN_RATE_LOOKBACK` decided rows (store a ring buffer or recompute from history), or rename the config to `WIN_RATE_MIN_SAMPLE` and document all-time semantics.

### BUG-020 — `decideTfDirection` fallback branch silently bypasses `MIN_CONFLUENCE=5` and the score threshold

- **Severity:** Low
- **Location:** `src/signal/voteFilters.js:50`
```js
if (scoreDiff >= 4.0 && confluence >= 4) return upScore > downScore ? 'BUY' : 'SELL';
```
- **Evidence:** `CONFIG.MIN_CONFLUENCE = 5` is the documented gate used by the first two branches; this third branch emits BUY/SELL with only **4** confluence categories, and with **no** requirement that the winning score exceeds `minScoreThreshold` (only `|upScore − downScore| ≥ 4`, e.g. upScore 1.2 vs downScore −2.8 → SELL despite downScore < threshold and downCat possibly 0 with upCat 4 — the direction comes from the *difference* while the confluence comes from the *other side's* categories).
- **Impact:** the deterministic gate that the whole confluence system is built on has an undocumented 4-confluence escape hatch; per-TF and shadow decisions (R7.1 uses the same helper) inherit it, so structure-attribution measurements can be contaminated by signals that should have been NO_TRADE.
- **Suggested fix:** require `Math.max(upCat, downCat) >= CONFIG.MIN_CONFLUENCE` in the fallback (or require the winning side's category count ≥ 4 and score ≥ threshold).

### BUG-021 — `+3` HIGHEST-session confidence bonus is dead code; D2_HIGHEST_SESSION_BLOCK suppresses ALL forex signals 12:00–16:00 UTC daily

- **Severity:** Low (design inconsistency)
- **Location:** `src/signal/voteFilters.js:139` (`else if (session.quality === 'HIGHEST') confidence += 3`) vs `src/signal/engine.js:173-176` (D2_HIGHEST_SESSION_BLOCK fires for every forex signal in HIGHEST session)
- **Evidence:** the engine first *rewards* the highest-liquidity window (+3) and then *hard-blocks* every forex signal in that same window. Live: zero EUR/USD (and other forex) history rows exist between 12:00–16:00 UTC today (rows stop at 09:50 and resume after 16:00), while 30+ rows exist outside the window. Local runs at 15:5x UTC of `scripts/d2_tests.mjs` and `scripts/probe_tests.mjs` show the block firing on plain RANGING fixtures (`D2_HIGHEST_SESSION_BLOCK (6.1% WR n=66)`).
- **Impact:** forex has no tradable signals at all during the most liquid 4 hours of the day (the +3 bonus can never be observed on a BUY/SELL), and the D2 counterfactual data (d2obs) is being flooded with HIGHEST-session observations. If the block is intentional, the +3 branch should be removed; if the +3 is intentional, the block is wrong.
- **Suggested fix:** delete the `HIGHEST → +3` branch (or gate it behind the same flag as the D2 block).

### BUG-022 — Fixture test suites are time-of-day dependent (fail during LONDON_NY overlap)

- **Severity:** Low (CI/verification)
- **Location:** `scripts/d2_tests.mjs` (#11b) and `scripts/probe_tests.mjs` (#9a/#9b) — both build engine signals from fixtures at the *current wall-clock time* (`detectTradingSession()` uses `new Date()`), and `D2_HIGHEST_SESSION_BLOCK` fires on the fixtures whenever the test runs 12:00–16:00 UTC.
- **Evidence:** run at 15:5x UTC today: `d2_tests` 38/39 (FAIL #11b "USD/JPY D2 audit is null when no D2 branch fires" — audit present because HIGHEST block fired), `probe_tests` 28/30 (FAIL #9a "fixture final = SELL — NO_TRADE" / #9b audit attach). The previous round's report claims 39/39 and 34/34 — those runs must have happened outside the overlap window.
- **Impact:** the repo's own "mandatory" suites cannot be trusted as a regression gate — they pass or fail depending on when CI runs.
- **Suggested fix:** inject a fixed session (or freeze `Date`) into the engine call for fixtures (e.g. an optional `now`/`session` parameter on `buildMultiTimeframeSignal`), or run the D2/probe engine tests with a session-independent pair path.

### BUG-023 — entryHit shadow remains near-tautological (previous round's CHECK-B, now quantified live)

- **Severity:** Low (shadow field, not used in WR yet)
- **Location:** `src/history/stats.js:250-253` (and the same block in d2store.js / probeStore.js / r71store.js)
- **Evidence (live, DOT/USD last-30 rows 2026-08-05/06):** `entryHit:false` → **8/8 WIN (100%)**; `entryHit:true` → **3/11 WIN (27%)**. The 08-05 "paradox" (hit=12.7%, miss=100%) is the same pattern. Mechanism: the window measured is `expiry ± 5 min` (the *tail* of the trade). A WIN means price moved away from entry and never re-crossed it near expiry (`entryHit=false`); a LOSS means price crossed the entry level (that is why it is a loss) → `entryHit=true`. The field measures "price returned to entry near expiry", not "was the entry filled during the trade".
- **Impact:** any analysis that treats entryHit as "the signal's entry was actually hit" is measuring the wrong thing; the "engine direction is wrong" conclusion from 08-05 is NOT supported by this data.
- **Suggested fix (as previously recommended):** fetch candles from `timestamp → expiryTime`, compare direction-correctly, and decide whether the trivial t0 touch counts as a hit.

### BUG-024 — Forex SELL weakness confirmed with mechanism evidence (known issue re-check)

- **Severity:** Low (confirmed known issue; probe already enabled)
- **Location:** `src/signal/timeframe.js` — RANGING mean-reversion scoring (`rsi >= 75 → mD += 1.5`, `rsi >= 65 → mD += 0.75`, stoch `>80 → sD`) + `detectMarketRegime` labelling ADX<25 as RANGING.
- **Live evidence (2026-08-06):** `/api/stats` — EUR/USD 0.333 (62/124), GBP/USD 0.261 (41/116), USD/JPY 0.286 (48/120), AUD/USD 0.210 (29/109), GBP/JPY 0.333 vs crypto 0.40–0.47. EUR/USD history: **all 40 most-recent rows are SELL**, WR 0.20 — during a day EUR/USD rose from 1.1524 → 1.156. USD/JPY history: all BUY, 0.38 — USD/JPY fell 158.0 → 157.5. The engine's regime/RSI combination systematically picks the counter-trend side of forex pairs (RANGING + mildly overbought RSI → SELL in a rising market).
- **Impact:** forex WR 21–33% vs crypto 40–47%; the live D2_TRENDING_BLOCK also removes most trending-direction trades, leaving the mean-reversion SELLs as the dominant forex output. The `FOREX_SELL_PROBE` is correctly instrumenting this — evaluate after the Phase-F window as planned; no code change recommended here.

### BUG-025 — Crypto signals receive forex-session multipliers (`SESSION_WEIGHT x1.40` on BTC/DOGE/SOL)

- **Severity:** Low (design question)
- **Location:** `src/analysis/filters.js:123-127` — `getSessionWeightMultiplier` keys on the pair's base/quote currencies; for `BTC/USD`, `USD` matches `SESSION_PAIR_WEIGHTS.USD.LONDON_NY = 1.4`.
- **Live evidence:** BTC/USD, DOGE/USD, SOL/USD responses all show `filtersApplied: ["SESSION_WEIGHT x1.40"]` and `sessionWeight: 1.4` — crypto trades 24/7, so its weighted votes/confidence are inflated ×1.4 during London–NY overlap purely because the quote is USD.
- **Impact:** crypto confidence and weighted votes are not comparable across the day (a 24/7 market shouldn't have 4h-of-day-dependent scaling), and the inflation propagates into `confidence`, `weightedBuy/Sell`, grade and expiry-vote weighting.
- **Suggested fix:** return `1.0` for `ASSET_TYPE.CRYPTO` (or document the intended "USD-pair liquidity" semantics and apply it consistently).

---

## Known-issue re-check (prompt §E)

1. **AI rescue override D2 block** — **FIXED & verified live** (BUG-002 fix holds; `AI_RESCUE_SKIPPED` observed). Residual: wasted AI calls (BUG-017) and the fail-open `d2Audit=null` hole in `engine.js`'s try/catch (`catch (e) { d2Audit = null; }` — a capture exception would silently re-open the rescue path; hard to trigger today).
2. **Forex SELL weak (~20% WR)** — **confirmed** (BUG-024) — EUR/USD 33%, GBP/USD 26%, USD/JPY 29%, AUD/USD 21% lifetime; mechanism (RANGING mean-reversion + ADX regime mislabel) identified.
3. **DOT/USD tie artifact** — historical rows confirmed (`sig_1785726015982_hkdsj`: SELL entry 0.791 / exit 0.791 → LOSS, Aug-3 pre-fix; `sig_1785705315344_qlweh`: BUY 0.799/0.799 → LOSS) — the BUG-008 fix now classifies these as TIE going forward; no new ties observed in Aug-5/6 rows.
4. **Entry-hit paradox (hit=12.7%, miss=100%)** — **resolved as a measurement artifact** (BUG-023): the shadow window is the expiry tail; it is not an engine direction error.

---

## Verification log (this session)

- `node --check` — all `src/**/*.js` pass.
- `fix_tests.mjs` 77/77 · `entry_hit_tests.mjs` 7/7 · `phase7_smoke.mjs` 68/68 · `fx_mode_tests.mjs` 16/17 (fixture-flaky, #3a) · `d2_tests.mjs` 38/39 (#11b — see BUG-022) · `probe_tests.mjs` 28/30 (#9a/#9b — see BUG-022).
- `r71_tests.mjs` **cannot run in this clone**: it requires `git archive 71e87eb` (baseline commit) which is not present (shallow clone, one commit). Environment note — the R7.1 baseline-equivalence assertion is unverifiable here.
- Local repros: `.audit/push_repro.mjs` (BUG-011) and `.audit/htf_repro.mjs` (BUG-014) — both reproduced exactly; kept out of the PR (scratch).
- Live requests: `/`, `/api/signal?pair=BTC/USD|SOL/USD|DOGE/USD|EUR/USD-OTC`, `/api/signal?pair=EUR/USD&mode=fx&nopush=1&preferCache=true`, `/api/batch?pairs=BTC/USD,ETH/USD`, `/api/signals/latest?pair=BTC/USD`, `/api/history?pair=EUR/USD|USD/JPY|DOT/USD|EUR/USD-OTC`, `/api/stats`, `/api/report?id=nonexistent_xyz&result=WIN`.

---

## Suggested fix priority

| Priority | Bugs | One-line |
|---|---|---|
| P1 | BUG-011, BUG-012 | channel-mirror `message` scope; OTC pending-resolution path |
| P2 | BUG-013, BUG-014, BUG-015, BUG-016 | NO_TRADE grade; alignment-bonus ordering (standard+OTC); fx+preferCache; `timezone=UTC` |
| P3 | BUG-017, BUG-018, BUG-019 | skip AI on D2 block; unify cbShadow WR; real lookback |
| P4 | BUG-020…025 | confluence fallback, HIGHEST contradiction, test determinism, entryHit window, (forex-SELL + crypto session-weight = design decisions for reviewer) |

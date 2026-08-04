# Ftt-Otc-v6 — Agent Log

## 2026-07-29 — Phase 10: real-time cross-surface push (NOT deployed)

**Base:** `24985da` (Phase 7.1). 7 files: 3 modified + wrangler.toml, 1 new module,
2 test scripts. 955 insertions / 2 deletions. App and Bot repos untouched.

### Five spec assumptions checked against the two repos first — four would have broken silently
- **Bot keeps its own `auto_users` index**, so the spec's `BOT_KV.list({prefix:'u:'})`
  full scan is both wasteful and wrong: it would include auto-disabled users and
  show a different population than the Bot's own cron sees. Used the index.
- **`gradeFilter` is only ever `ALL` | `AB` | `A`** (settings keyboard, line 606).
  The spec's rank table `{A+:5,A:4,B:3...}` has no `AB` entry, so `rank['AB']||0`
  = 0 and the "A+B only" filter would have passed everything. Mirrored the Bot's
  real `passGrade`/`passConf`/`passAI` instead.
- **`parse_mode:'HTML'` would reintroduce the Bot's documented Bug#1.** The Bot
  stripped parse_mode entirely because signal text contains `( ) . ! - _` and `<`,
  which made Telegram answer 400 while the error was only logged — users silently
  got nothing. Sending plain text.
- **No duplicate guard in the spec.** `/api/signal` mints a new signalId on every
  call, and it is called constantly (App auto-refresh 60s, Bot cron 5min, every
  manual view), so "push on every call" meant ~30 Telegram messages for one setup
  inside the 30-minute dedup window. Push is now chained behind
  `saveSignalToHistory()`'s `{deduped}` result, plus a per-(subscriber,pair,
  direction) lock with the same 30-minute TTL.
- Result-push pip precision was hardcoded to 4dp; now chosen from the entry price
  so crypto shows `-50.00` instead of a rounded-away figure and forex keeps 5dp.

### Option B chosen (cross-worker KV), not Option A
Option A needed a new `/api/subscribers` endpoint in the Bot, violating the round's
"Bot changes: ZERO" rule. Option B binds the Bot's namespace id directly in
`wrangler.toml`. Same account, so this is standard — but it could not be verified
without deploying, so it is the first thing to check post-deploy via
`/health` -> `phase10.botKvBound` / `subscriberCount`.

### Changes
- `handlers/pushToSubscribers.js` (new) — enumeration via `auto_users`, Bot-mirrored
  filters, idempotency lock, plain-text formatter, Telegram sender, `/health` stats.
  Refuses to cache anything and never blocks: with no `BOT_TOKEN` the whole feature
  is inert (`{skipped:'no-token'}`).
- `handlers/signal.js` — `saveAndPush()` wraps save-then-push for both the
  forex/crypto and OTC emit paths, inside `ctx.waitUntil`.
- `history/stats.js` — result checker notifies exactly the subscribers recorded in
  `pushLog:<id>`, then consumes the log so a re-resolve cannot double-notify.
- `handlers/health.js` — `phase10` block. `wrangler.toml` — `BOT_KV` binding.
- Engine untouched: `git diff src/signal/ src/fetch/ src/indicators/ src/analysis/`
  is empty.

### Verification — 80 assertions, 0 failures
`node --check` 35/35 · smoke 61/61 · integration 19/19. The integration suite runs
the real `handleSignalRaw` -> engine -> push chain and the real `scheduledTracker`
with only HTTP stubbed: three back-to-back identical calls produce exactly one
Telegram message, an unwatched pair produces none, a totally dead Telegram still
returns a valid signal to the caller, and a resolved trade emits one "Result: WIN".

**The grep assertion caught a real bug:** `saveAndPush` was never inserted, because
my anchor matched `handleSignal(pair, env, ctx)` while Phase 7 had changed the
signature to `(pair, env, ctx, opts)`. The push would never have fired. Two other
failures were faults in my own test harness (a comment-vs-code grep, and a mock
returning the candle at the bracket start so `fetchExpiryPrice` correctly rejected
it as NO_MATCH).

### Open
- The Bot's autoScan still notifies users itself, so a user could receive both the
  Bot's message and the worker's push for the same setup. The two locks live in
  different keyspaces and cannot see each other. Fixing it properly needs a Bot
  change, which this round forbade.
- `BOT_TOKEN` is not set on this worker yet; until it is, nothing is pushed.

---


## 2026-07-29 — Phase 7: unified cron-driven signal cache (NOT deployed)

**Base:** `d80e989`. 10 files: 5 modified, 3 new, 2 test scripts. 968 insertions / 4 deletions.

**Five spec assumptions checked live before coding — three were broken imports:**
- `getMarketStatus` from `utils/pairs.js` (spec §4.2) does not exist anywhere; the real
  market-hours check is `isForexMarketOpen()` in `utils/session.js`.
- `generateSignalCore` from `signal/engine.js` (spec §4.2) does not exist; the engine
  exports `buildMultiTimeframeSignal`.
- `jsonResponse` is in `utils/helpers.js`, not `utils/cors.js` (spec §4.3).
  All three are import statements — copying the spec verbatim would have failed at
  module resolution, not silently.
- **No engine refactor was needed** (spec §5 expected one). The path is already
  `index.js -> handleSignal -> handleSignalRaw(pair, env, ctx)`, which returns exactly
  the object worth caching. `git diff src/signal/engine.js src/signal/otcEngine.js`
  is empty: one engine, one code path, zero fork.
- **The spec's `scanOnePair` would have double-written history.** `handleSignalRaw`
  already persists BUY/SELL via `ctx.waitUntil(saveSignalToHistory(...))`
  (signal.js:136, :217). Calling it again in the scanner would create two records and
  two `pending:` result-checks per scanned signal; the 30-min dedup guard catches most
  but not all (a re-poll with a slightly different entryPrice slips through — the exact
  duplicate inflation Phase A2 had to clean up). The scanner therefore writes only the
  KV cache and leaves history to the existing path.

**Changes**
- `config.js` — `SCAN_PAIRS` (14 pairs, each verified live against /api/signal:
  all return FULL_DATA) and `SCAN_CONFIG` (prefix `latest:`, TTL 600s, batch 3,
  500ms delay, 90s hard cap).
- `history/latestCache.js` (new) — one shared key/TTL/freshness layer for the three
  call sites, so a key-format drift can't turn into a permanent silent cache miss.
  Handles OTC round-trip (`EURUSD-OTC` <-> `latest:EURUSD_OTC`; a naive underscore
  swap would produce `EURUSD/OTC`).
- `handlers/scheduledScan.js` (new) — 5-min scan, forex skipped while the market is
  closed, batches of 3 with a 500ms gap, 90s cap, per-pair failure isolation. Refuses
  to cache `DUMMY_FALLBACK` (all candle fetches failed) or market-closed responses.
- `handlers/latest.js` (new) — `/api/signals/latest` single + all, 404 on miss/stale,
  400 on an invalid pair, plus `getScanCacheStats()` for /health. Never runs the engine.
- `handlers/signal.js` — `handleSignal(pair, env, ctx, {preferCache})`. Default is
  unchanged fresh generation, now labelled `cached:false, forceRefresh:true`;
  `preferCache=true` serves a fresh cache entry or generates and warms it
  (`opportunistic:true`).
- `index.js` — cron split on `event.cron` (`*/5` scan, everything else result checker),
  new route, `preferCache` param. `wrangler.toml` — both crons registered.
- `handlers/health.js` — `scanCache` block (generation id, pair count, oldest/newest
  age, opportunistic count).

**Measured, not estimated**
- Per scan: 42 candle calls, 28 AI calls, 126 KV puts. Per hour: 504 candles, 336 AI.
  The spec's "~1000-1500 credits/hour" was ~2-3x high; an immediate second scan costs
  0 candle calls because the `c:` cache absorbs it.
- **AI is currently exhausted**: Cerebras and Groq both return 429 on every pair,
  sampled twice 20s apart. AI fires on 13/14 pairs, so a scan costs ~26-28 AI calls.
  Caching bounds that (fixed 336/hour regardless of user count) but does not fix it —
  and a cache filled with `BOTH_UNAVAILABLE` signals would serve that for 10 minutes.
  Flagged as blocking in the report's OPEN QUESTIONS; no engine change made (spec §9).

**Verification:** `node --check` 34/34 · smoke 68/68 · integration 36/36 (104 assertions,
0 failures). The integration suite runs the real scan -> real handleSignalRaw -> real
engine with only HTTP stubbed, and asserts history stays at <=1 record per pair per scan,
that a cache hit costs 0 candle and 0 AI calls, and that a force refresh still re-runs the
engine. Three test failures along the way were all faults in my tests, not the code —
including my own wrong assumption that a force refresh must refetch candles (it re-runs
the engine; the `c:` candle cache is a separate pre-existing layer left untouched).

**Not implemented (deliberate, see report §5):** the §3.3 auto-fallback that would make
`/api/signals/latest` run the engine on a cache miss. Kept as 404 because §2.3 defines
that endpoint as cache-read-only and because it is not rate-limited — making it
engine-triggering would open an abuse vector. `?preferCache=true` provides the same
fallback behind the existing rate limit.

---


Changelog-স্টাইল টেকনিক্যাল লগ — commit/date/exact-change ভিত্তিক। Project-এর overall মিশন/context জানতে `FTT-PROJECT-MASTER-PROTOCOL.md` দেখো, এখানে সেটা repeat করা হয় না। নতুন entry সবসময় উপরে যোগ হবে।

---

## 2026-07-28 — Phase B (FIX) — code change only, NOT deployed

**Base:** `93f2de5`। ৯ file modified + ২ new। `src/` diff: 478 insertions / 64 deletions। ZIP deliverable, কোনো push/deploy হয়নি।

**Changes:**
- `fetch/keys.js` — full rewrite। numbered-key scan থেকে fixed upper bound সরানো (আগে key ১১+ silently ignored হতো; env-এ ১৯টা আছে)। dedupe যোগ। নতুন `getNextRotationIndex` (KV `rr:idx`) — round-robin start index, শুধু retry-fallback না
- `fetch/candles.js` — `maxAttempts = apiKeys.length` (আগে `Math.min(len, MAX_RETRIES)` = ৩-এ cap)। rotation start। প্রতি HTTP attempt-এ `incrementQuota`। সব failure branch-এ warn + `body[:200]` + keyIdx
- `history/quota.js` — **new**। `quota:<YYYY-MM-DD UTC>` counter, 3d TTL
- `history/circuitBreaker.js` — **new**। `cb:<PAIR>` state, 2-loss streak → 6h fixed cooldown, WIN resets, UNKNOWN ignored
- `history/stats.js` — `fetchExpiryPrice` rewrite: ±5min `start_date`/`end_date` bracket (আগে `outputsize=5` from now, দেরিতে চললে expiry minute-ই দেখতে পেত না), key rotation (আগে `apiKeys[0]` hardcode), `{price}`/`{error,status,body}` return। `scheduledTracker` retry-cap: fail-এ pending delete **বন্ধ**, `checks` counter, ≥15-এ UNKNOWN (আগে প্রথম miss-এই permanently UNKNOWN হয়ে যেত — এটাই UNKNOWN 56%-এর মূল কারণ)। outer catch আর delete করে না। `updatePairStats` end-এ CB funnel hook। record-এ ৪ field + conditional `cbShadow`
- `handlers/signal.js` — দুই path-এ CB check site। Cooldown-এ `NO_TRADE` কিন্তু shadow row persist (`cbShadow:true`, would-be direction সহ) — counterfactual measurable রাখতে। `entrySource` (cacheHits 0/1-2/3)
- `handlers/health.js` + `index.js` — `handleHealth` async, `quotaUsedToday`/`apiKeysLoaded`/`rotationIdx`
- `signal/engine.js`, `signal/otcEngine.js` — `coreConfidence` (pre-filter anchor)
- `config.js` — `CACHE_TTL['1min']` 60→120, `PENDING_TTL_MS`/`PENDING_MAX_CHECKS`, `MAX_RETRIES` reserved-comment

**Verification:** node --check 31/31 · smoke 93/93 assertions (৩ suite: keys/rotation/CB/quota, scheduledTracker end-to-end, handler CB check sites) · backtest reproduction 7/7।

**Backtest (n=214 raw / 92 decided, live /api/history থেকে re-pull, A2 baseline exact match):**

| Config | signal clock WR / n | result clock WR / n |
|---|---:|---:|
| Baseline | 42.4% / 92 | 42.4% / 92 |
| CB 2h | 42.9% / 49 | 40.6% / 64 |
| CB 6h (shipped) | 46.5% / 43 | **41.1% / 56** |
| CB 12h | 46.5% / 43 | 41.1% / 56 |
| CB 24h | 33.3% / 30 | 36.6% / 41 |

**দুইটা material deviation (report §2-এ full):**
1. A2-এর "streak 11" per-pair না, **cross-pair**। Worst per-pair baseline = 6 (BNB/USD)। CB 6h: cross-pair 11→8, ETH 4→3, BNB 6→5
2. **CB 6h-এর WR gain production clock-এ টেকে না** — 46.5% (signal clock, A2 যেভাবে মেপেছে) vs **41.1%** (result clock = expiry+90s, production যেভাবে চলবে)। −5.4pp, tolerance-এর বাইরে। Ship করা হয়েছে streak containment + shadow instrumentation-এর জন্য, WR gain-এর জন্য না

**নতুন open finding:** result clock-এ shadow WR (44.4%, n=36) > emitted WR (41.1%, n=56) — CB এই sample-এ ভালো trade-ও block করছে। Live shadow data ২-৪ সপ্তাহ দরকার verdict-এর জন্য।

**অমীমাংসিত:** pool-এ EUR/USD-এর ৫০টা row-এর **শূন্যটা** decided (সব UNKNOWN), crypto pair-গুলো ঠিকঠাক resolve হচ্ছে। B0-5 log-line পরের data pull-এ দেখতে হবে — forex-specific TwelveData restriction সন্দেহ।

---

## 2026-07-28 — Catch-up entry (আগের commit + investigation history)

**Commits এই repo-তে:**
- `<earlier>` — `handlers/signal.js`: response-এ signal `id` include করা শুরু (আগে কখনো client পেত না, `/api/report` সবসময় 404 দিত)
- `<earlier>` — `history/stats.js`: caller-provided `signalId` accept করা শুরু (নিজে random generate বন্ধ)
- `9fc5aef` — `history/stats.js`: 30-min dedup guard (`isDuplicateRecord`, same pair+direction+entryPrice tolerance-সহ)। প্রথম submission-এ `const history` bug ছিল (৫০-item-full array trim করার সময় crash করতো, `node --check`-এ ধরা পড়েনি) — v2-তে `let`-এ ফিরিয়ে fix, নতুন test-case (৫০-item full array + fresh unique add) দিয়ে verify করে merge

**Config/infra change (repo-বহির্ভূত, Cloudflare dashboard থেকে):**
- `ftt-telegram-bot`-এর cron `* * * * *` → `*/5 * * * *` (এই worker-এর নিজের cron না, কিন্তু একই Cloudflare account, তাই এখানে note করা)
- Cloudflare account Free → Paid plan upgrade (KV write quota account-wide শেয়ার হওয়ার কারণে, temporary/data-collection উদ্দেশ্যে)

**Data-quality baseline reset:** dedup guard deploy-এর আগের সব history record (২০২৬-০৭-২৬ ০৬:১০Z-এর আগে) duplicate-inflated ধরতে হবে — raw record count আর real trade count এক না ওই window-এ।

---

## Investigation trend log (round-by-round numbers, raw — analysis/interpretation Master Protocol বা individual report file-এ)

| Round | Window ref | Decided WR | n | Max loss streak (cross-pair) |
|---|---|---:|---:|---:|
| 1 | 07-26 ~14:41Z | 37.0% | 27 | 6 |
| 2 | 07-27 ~03:46Z | 32.6% | 46 | 10 |
| 3 (Kimi) | 07-27 ~04:42Z | — | — | 11 |
| All-pairs | 07-27 (00:00Z→run) | 36.2% | 58 | — |
| 4 | 07-28 ~05:30Z | 42.4% | 92 | 11 |

**Retired finding:** BNB/USD "-21.5pp regime change" (round: all-pairs, n=18) — round 4-এ n=22-তে gap -8.0pp-এ নেমে এসেছে, XRP/USD এখন উভয় মেট্রিকে খারাপ। Status: **not distinguishable from noise at this n।**

**Open, active finding:** A+/90%+ confidence bucket decided WR 7.1% (n=14, round 4)। Pair-attribution check করা হয়েছে (round 4, Part C) — BNB-artifact না, ETH/SOL/ADA/XRP জুড়ে ছড়ানো, confirmed system-wide। **Root-cause investigation এখনো শুরু হয়নি — next priority।**

---

*(এর উপরে নতুন entry যোগ করবে। Format: date header → commit hash + one-line change (repo commit হলে) → investigation round হলে trend-table row + এক লাইনে status।)*

## 2026-08-02 — D2 Shadow Collector + BAD_PAIR block suspend (NOT deployed)

**Base:** `3acc465`. Scope: worker engine instrumentation + one filter suspend.
User-approved. 6 files: 4 modified (`config.js`, `signal/engine.js`,
`handlers/signal.js`, `index.js`), 2 new (`signal/d2shadow.js`,
`history/d2store.js`), 1 new test suite (`scripts/d2_tests.mjs`).

### Why
Phase F needs 7–14 fresh forward days, but the Phase-D2 negative filters
(TRENDING / BAD_PAIR / HIGHEST_SESSION) convert would-be BUY/SELL into
NO_TRADE — the exact slices Phase F must study were being starved of data.
Also verified live: the AI rescue path can revive a D2-blocked signal
(DOT/USD 8 fresh trades all conf 79–92, aiAgreed=True), so the block is not
absolute and its real forward value was never measurable.

### What
1. **D2 Shadow Collector** — mirrors R7.1 design in its own KV namespace
   (`d2obs:`, `d2pending:`, `d2idx:`): whenever a D2 branch fires, the
   would-be signal (direction, confidence, entry, expiry, bestTF) is captured
   under a non-enumerable Symbol and — IF the block holds post-AI (final
   NO_TRADE) — admitted as a private counterfactual observation, resolved at
   expiry via `fetchExpiryPrice` (injectable in tests). Max 30/pair/30d,
   2h dedup, capped resolver, fail-open, zero public API / history / push
   contamination. AI-rescued signals are NOT admitted (normal history owns
   them) — no double counting.
2. **D2_BAD_PAIR_BLOCK suspended** behind `CONFIG.D2_BAD_PAIR_BLOCK_ENABLED=false`
   so USD/JPY, AUD/USD, DOT/USD produce forward signals for Phase F
   validation. Branch stays in code for one-line re-enable.
3. TRENDING + HIGHEST_SESSION blocks remain active (Phase C/E/F evidence).

### Verification
- `scripts/d2_tests.mjs`: **39/39 PASS** (isolation, invalid input, dedup,
  cap, resolver WIN/LOSS/tie/cap/retry-UNKNOWN, engine audit attach + zero
  JSON leak, suspend flag, admission gate no-double-count, fail-open).
- Phase 7: 68 smoke + 36 integration = 104 PASS. Phase 10: 61 smoke + 19
  integration = 80 PASS.
- R7.1: 113/116 — the 3 failures (`#1a`, `#2`, `#17`) are PRE-EXISTING at
  HEAD `3acc465` (verified by stash): the D2 commit (`4ea6368`) changed
  TRENDING-fixture behavior vs R7.1's 71e87eb baseline. Not introduced here.
- `node --check` clean on all changed files.

### Counterfactual honesty note
The shadow measures the deterministic PRE-AI would-be signal. AI-layer effects
(rescue/boost/disagree) are outside the counterfactual; AI-rescued rows are
excluded, so D2 shadow data must not be read as "what production would have
done" — it is "what the pre-AI engine slice that D2 blocked did".

### Deploy
NOT deployed. Requires user push (PAT) from Termux. Bundle + runbook provided.

## 2026-08-04 — Forex SELL Probe instrumentation (NOT deployed)

**Base:** `dd0d473`. Phase F forward finding: forex SELL running ~20% WR
(n=60) while same pairs' BUY is 40-60%; 10+ pip moves on forex SELL lost 97%
of the time. Root cause hypothesis (code+data): RANGING mean-reversion RSI
scores "overbought -> SELL" but short expiries keep trending up.

### What
1. **probeStore.js** (new) — private `probe:` KV namespace. Stores ONLY forex
   SELL signals (post-AI final=SELL, actually traded) with signal-time context
   (regime, session quality, higherTF trend, alignment, RSI) + at resolve BOTH
   actual result AND flipped (BUY) counterfactual. Cap 50/pair/30d, 2h dedup,
   capped resolver, fail-open, zero public API/history/push leakage.
2. **probeShadow.js** (new) — non-enumerable Symbol transport + admission gate
   (only FOREX + final SELL).
3. **engine.js** — attach probe audit when CONFIG.FOREX_SELL_PROBE_ENABLED &&
   assetType FOREX && finalDirection SELL (instrumentation only; production
   byte-identical). RSI parsed from formatted indicator string.
4. **signal.js / index.js** — admission off live path + resolver on 2-min cron.

### Verification
- scripts/probe_tests.mjs: 34/34 PASS (isolation, invalid input, dedup, cap,
  resolver WIN/LOSS/tie + flipped correctness, transient->UNKNOWN, engine
  attach + zero JSON leak, non-SELL/non-forex carry none, admission gate).
- d2_tests 39/39, phase7 104, phase10 80 all pass.
- r71_tests 113/116 — same 3 pre-existing failures at HEAD (not introduced).
- node --check clean.

### Decision support this enables (after 7-14 days)
- Which forex-SELL slices (regime/RSI/session) are systematically wrong
- Whether flipped BUY clears breakeven with CI on the same trades
- Conditional fix (restrict/flip specific slices) instead of blanket changes

NOT deployed. Bundle + runbook provided.

## 2026-08-04 — D4 ML prototype v0 (data-driven, NOT deployed)

**What:** d4_prototype.py — gradient-boosted (XGBoost) model that tries to
predict WIN/LOSS from engine signals + context (pair, direction, confidence,
grade, regime, alignment, structure, session, hour, dow). Trains on engine
outputs as features; learns the weak anti-correlation without a hand-coded flip.

**Method (honesty rules baked in):**
- Chronological split ONLY (train = days 1-3, test = last day)
- Wilson CI vs 55.6% breakeven (80% payout)
- Confident-only subset (proba >= .55 / <= .45) reported separately
- Requires >= 50 rows and warns if test n < 30
- Re-runnable: python3 d4_prototype.py --data-dir <snapshots>

**First run (4 days, n=1012):**
- Engine baseline 46.2% (CI 43.2-49.3%)
- Model on 08-04 (n=145): confident-only WR 44.8% (CI 36.1-53.9%) — below
  breakeven, no edge. Expected: 4 clustered days, 1 test day = noise floor.
- Feature importances spread thin; no dominant feature.

**Interpretation:** the pipeline is the deliverable (working, honest, re-runnable
as data accumulates). Results are NOT an edge claim. Re-run after 7-14 days;
only if confident-only CI clears 55.6% on multiple test days does a conditional
strategy get considered. Prototype only — nothing deployed, engine untouched.

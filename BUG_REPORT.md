# 🔬 FTT Worker v6.9.2 — Canonical Bug Audit + Round-3 Fix Report

**Audited commit:** `0c6d358` (main tip, post-PR#5) · **Fix branch:** `arena/019fd7c0-ftt-otc-v6` (PR #7)
**Live host checked:** `https://fttotcv6.umuhammadiswa.workers.dev` (2026-08-06)
**Reviewer verdict:** all 22 audit findings confirmed real (0 fabricated). All 19 approved fixes (F3-01..F3-19) implemented, tested, and pushed in this PR — **report + fixes only, no merge** (reviewer re-verifies).

---

## 0. Numbering reconciliation (the PR#6 / PR#7 collision)

Two parallel audit PRs both used `BUG-011..016` for different bugs. This is the **single canonical report**:

| Canonical ID | PR#6 (report-only) | PR#7 (report-only) | Fix |
|---|---|---|---|
| BUG-011 | — | Channel mirror `message` ReferenceError | **F3-01** |
| BUG-012 | — | OTC rows never auto-resolved | **F3-02** |
| BUG-013 | — | NO_TRADE carries tradable grades | **F3-05** |
| BUG-014 | — | HTF hard block → 0%, then bonus → 8% | **F3-06** |
| BUG-015 | — | `mode=fx&preferCache=true` returns non-FX payload | **F3-08** |
| BUG-016 | — | Forex candleTime is AEST/UTC+10 | **F3-07** |
| BUG-017 | — | AI (2 LLM calls) wasted on D2-blocked signals | **F3-15** |
| BUG-018 | — | /api/history counts cbShadow rows, /api/stats doesn't | **F3-17** |
| BUG-019 | — | winRate all-time, not the documented 20-trade window | **F3-18** |
| BUG-020 | — | `decideTfDirection` fallback bypasses MIN_CONFLUENCE=5 | **F3-19** |
| BUG-021 | — | `+3` HIGHEST bonus dead code vs D2_HIGHEST_SESSION_BLOCK | **F3-12** |
| BUG-022 | — | Fixture tests time-of-day dependent | **F3-16** |
| BUG-023 | — | entryHit shadow near-tautological (analysis only) | ⏭️ out of scope |
| BUG-024 | — | Forex SELL weakness re-check (Phase-F probe) | ⏭️ out of scope |
| BUG-025 | — | Crypto gets forex session weights (USD quote ×1.4) | **F3-13** |
| BUG-026 | passGrade drops A+ for A/AB filters | — | **F3-03** |
| BUG-027 | OTC engine omits fillStatus/entryPrice/currentPrice/entryDistancePct | — | **F3-04** |
| BUG-028 | scheduledScan calls handleSignalRaw without noPush | — | **F3-14** |
| BUG-029 | analyzeStructure double-counts current-bar BOS (2.0+0.5) | — | **F3-10** |
| BUG-030 | RANGING RSI 55-65/35-45 contradictory middle-zone bias | — | **F3-11** |
| BUG-031 | FVG check uses 1min first (noisy gaps penalize HTF signals) | — | **F3-09** |
| CLOCK-001 | d2_tests #11b fails 12–16 UTC (HIGHEST session) | = BUG-022 | **F3-16** |

---

## 1. Round-3 fix status (all 19 implemented + unit-tested)

| Fix | Change (file) | Test proof (fix_tests.mjs) | Design flag |
|---|---|---|---|
| F3-01 | `pushToSubscribers.js` — per-subscriber `message` carried with the delivery record; channel mirror uses it; pushLog always written | T14a–d: 1 subscriber w/ channelId → DM + mirror sent, pushLog exists, no crash | — |
| F3-02 | `stats.js` — OTC rows now register `pending:`; `fetchExpiryPrice` strips `-OTC` and resolves vs base-pair real price (the same data the OTC signal is computed from) | T15a–f: pending created for OTC; symbol sent = base pair; cron tracker resolves row → WIN + stats | ⚠️ **FLAG — option chosen: resolve vs base-pair real price** (per reviewer default recommendation). OTC is a synthetic of the base pair; results are therefore approximate vs the broker's synthetic price. Alternative (`NOT_TRACKED`) rejected because it leaves the history surface permanently pending. If the user prefers NOT_TRACKED, it's a 1-line change. |
| F3-03 | `pushToSubscribers.js` — `passGrade`: A+ satisfies A and AB | T16a–h | — |
| F3-04 | `otcEngine.js` — OTC signal now attaches fillStatus/entryPrice/currentPrice/entryDistancePct (mirrors engine.js, lowest-TF current price) | T17a–e: INSTANT + PENDING_ENTRY cases | — |
| F3-05 | `engine.js` + `otcEngine.js` — `finalDirection==='NO_TRADE'` → grade `{N/A, NO_TRADE}` instead of scored B/C | T18a–d | — |
| F3-06 | `voteFilters.js` — alignment bonus applied BEFORE hard-block zeroing (standard); `otcEngine.js` bonus before MIXED zero (defensive — MIXED bonus is 0) | T19a–d: live DOGE repro now 0% (was 8%) | — |
| F3-07 | `candles.js` + `stats.js` — `timezone=UTC` on both TwelveData calls | T20a–b: URL params asserted | — |
| F3-08 | `signal.js` — `mode=fx` skips the preferCache read (always fresh) | T21a–c: cached served without fx; fresh run with fx when fxMode | — |
| F3-09 | `voteFilters.js` — FVG check order `15min → 5min → 1min` | T22a–c | — |
| F3-10 | `structure.js` — recentEvents BOS score only when `!bos` (no double count) | T23a–e: current-bar BOS = 3.5 (bias 1.5 + BOS 2.0), not 4.0 | — |
| F3-11 | `timeframe.js` — RANGING middle-zone RSI scores (`55–64 → +0.25 BUY`, `36–44 → +0.25 SELL`) removed | T24a–c: RSI 62 vs 66 no BUY flip; 66 adds exactly +1.35 down | ⚠️ **FLAG — behavior change**: RANGING now only rewards mean-reversion extremes (≤35 / ≥65). Rationale: the old middle-zone scores were a trend-following bias inside a mean-reversion regime — RSI 62 said BUY while RSI 66 said SELL (abrupt flip at 65). If the user wants a neutral band *and* trend-following at 55–65, that's a separate scoring decision for Phase F. |
| F3-12 | `voteFilters.js` — `HIGHEST → +3` branch removed | T25: HIGHEST session → 82 (was 85 pre-fix) | ⚠️ **FLAG — dead code removed**: engine.js hard-blocks ALL forex signals in HIGHEST (D2_HIGHEST_SESSION_BLOCK), so the +3 could never reach a trade. If/when that D2 block is lifted, reintroduce the bonus as a deliberate decision. |
| F3-13 | `filters.js` + `engine.js` — crypto pairs get `sessionMult = 1` (forex weights only for FOREX) | T26a–d: BTC sessionWeight 1, no SESSION_WEIGHT filter; EUR unchanged ×1.4 | ⚠️ **FLAG — behavior change**: crypto confidence no longer inflated ×1.4 during London/NY overlap (24/7 market). Confidence ratios are unchanged (weights scale both sides), so emitted signals are effectively the same; only weighted displays differ. |
| F3-14 | `scheduledScan.js` — scanner passes `{ noPush: true }` | T27: source assert | — |
| F3-15 | `engine.js` — `d2Audit` set → `aiTargetDir = null` (AI never runs on D2 blocks); public note `AI_SKIPPED (D2 hard block)` (no private attribution token leaked) | T28a–d: 0 LLM calls, aiValidation SKIPPED | — |
| F3-16 | `engine.js` — optional `opts.session` / `opts.now` / `opts.newsBlock` injection; `d2_tests`/`probe_tests`/`fx_mode_tests` pin NEW_YORK/HIGH + newsBlock null | T29a–b + full suites green outside any time window | — |
| F3-17 | `health.js` — `/api/history` decided/pending/winRate exclude `cbShadow` rows (rows stay visible) | T30a–d | ⚠️ **FLAG — convention choice**: matches `updatePairStats` (stats never counted shadow). Alternative (count shadow in history too) rejected: shadow rows are counterfactuals of suppressed trades. |
| F3-18 | `stats.js` — `winRate` = rolling last-20 window (ring buffer `recentResults`); lifetime totals preserved in wins/losses/totalSignals | T31a–e: 5W+20L → winRate 0, dynAdj −10 | ⚠️ **FLAG — semantics change**: `/api/stats` winRate and the dynamic confidence adjustment now track recent form instead of lifetime. Note: existing KV stats rows without `recentResults` start a fresh window on the next result (one-time discontinuity). `/api/history` winRate remains limit-window based (documented). |
| F3-19 | `voteFilters.js` — fallback branch requires WINNING-side confluence ≥ MIN_CONFLUENCE (5) | T32a–e | ⚠️ **FLAG — behavior change**: per-TF signals that previously passed via the 4-cat fallback now require the winning side to have 5 voting categories (fixtures in fix_tests were strengthened to legitimately reach 5; the fallback's score-threshold exemption is unchanged). |

**Test-matrix updates for intended behavior:** `fix_tests.mjs` T5 now expects `AI_SKIPPED (D2 hard block)` (F3-15 renamed the note — the AI no longer runs, so `AI_RESCUE_SKIPPED` would be a lie); `series()` fixture candles are body-dominated so per-TF confluence legitimately reaches 5 under F3-19; `d2/probe/fx_mode` suites pin session + news (F3-16); `r71_tests` #14 redaction list extended with the new OTC fillStatus fields (F3-04) — the 3 pre-existing baseline fails (#1a/#2/#17) are untouched.

## 2. Out of scope (per reviewer — Phase-F, no code)

- **BUG-023 (entryHit window)** — analysis-only; corrected signal→expiry window metric = separate instrumentation task.
- **BUG-024 (forex SELL)** — `FOREX_SELL_PROBE` already running; do NOT flip SELL logic.

## 3. Verification log (this PR)

| Suite | Result |
|---|---|
| `fix_tests.mjs` (T1–T32 incl. all 19 F3 tests) | **151/151 PASS** |
| `phase10_integration.mjs` | 19/19 |
| `phase7_smoke.mjs` | 68/68 |
| `phase7_integration.mjs` | 36/36 |
| `phase10_smoke.mjs` | 61/61 |
| `d2_tests.mjs` | 39/39 (now time-invariant via F3-16) |
| `probe_tests.mjs` | 34/34 (time-invariant) |
| `fx_mode_tests.mjs` | 20/20 (time-invariant) |
| `entry_hit_tests.mjs` | 7/7 |
| `r71_tests.mjs` | **113 PASS / 3 FAIL — same 3 pre-existing (#1a baseline, #2 comparability, #17 fuzz)** — no new failures |
| `node --check` all `src/**/*.js` + changed scripts | pass |
| `git diff --check` | clean |

**Behavioral spot-checks (local):** HTF-block confidence 0% (live repro was 8%) · passGrade A+→A/AB true · crypto sessionWeight 1 · OTC pending row resolved by the tracker · fallback cat-4 → NO_TRADE.

**Note on `r71_tests`:** runs against baseline commit `71e87eb` (needs a full clone; this sandbox was unshallowed to run it). The 3 failures are the same ones present on `main` before this PR.

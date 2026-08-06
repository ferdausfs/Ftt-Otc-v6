# 🔬 FTT Worker v6.9.2 — Deep Bug-Hunt Audit Report

**Audited:** `055b6f0` (`main`) — "Fill status (INSTANT/PENDING_ENTRY) + entry distance in signal output"
**Live host checked:** `https://fttotcv6.umuhammadiswa.workers.dev` (2026-08-06 04:30–05:00 UTC)
**Scope:** all `src/` + live endpoints (`/`, `/health`, `/api/signal`, `/api/signals/latest`, `/api/history`, `/api/stats`)
**Verification performed:** `node --check` on every `src/**/*.js` (all pass) · repo test suites: `entry_hit_tests` (7/7), `d2_tests` (39/39), `probe_tests` (34/34), `fx_mode_tests` (20/20), `phase7_smoke` (68/68), `phase10_smoke` (61/61), `phase7_integration` (36/36) — **`phase10_integration` FAILS** (see BUG-001).

---

## Fix round 1 — status (reviewer-approved 6 fixes + CHECK-A fix)

| Finding | Verdict | Status |
|---------|---------|--------|
| BUG-001 (push ReferenceError) | FIX-1 ✅ approved | **Fixed** — `noPush` threaded through `saveAndPush` + `handleSignal`→`handleSignalRaw` (+ OTC path). `phase10_integration` now passes 19/19. |
| BUG-002 (AI rescue overrides D2) | FIX-2 ✅ approved | **Fixed** — rescue path skips when `d2Audit` is set (`AI_RESCUE_SKIPPED (D2 hard block…)`). Proven by `fix_tests.mjs` T5: TRENDING + dual-AI-agree → NO_TRADE. |
| BUG-003 (fillStatus degenerate) | FIX-3 ✅ approved | **Fixed** — current price now = lowest-TF (1min) last close, independent of the best-TF entry. Proven by `fix_tests.mjs` T3: `PENDING_ENTRY` / 1.91% distance / `INSTANT` when prices equal. |
| BUG-005 (/api/report double-count) | FIX-4 ✅ approved | **Fixed** — idempotent: already-decided rows don't re-count stats; `pending:<id>` deleted so the cron can't overwrite. Proven by `fix_tests.mjs` T2. |
| BUG-007 (floor not enforced post-AI) | FIX-5 ✅ approved | **Fixed** — `BELOW_FLOOR_AFTER_AI` re-check on the final output (no BUY/SELL < 72%). |
| BUG-008 (tie → LOSS) | FIX-6 ✅ approved | **Fixed** — shared `classifyOutcome()` (stats.js) returns `TIE`; used by all 4 resolvers; TIE excluded from stats/pushes. Unit + resolver tests updated. |
| BUG-006 (passAI never true) | CHECK-A 🔍 | **Confirmed broken + fixed** per the reviewer's conditional ("না হলে — logic ঠিক করো"): `passAI` now reads `combined.status`/`combinedAgreed` (standard engine shape) and `status`/`agrees` (OTC shape). Proven by `fix_tests.mjs` T7. |
| BUG-004 (entryHit wrong window) | CHECK-B 🔍 | **Analysis only — no code change** (reviewer decides). See section below. |
| BUG-009 / BUG-010 | ⏭️ skip | Not changed (as instructed). |

**Test matrix after fix round 1 (all green):** `fix_tests` 42/42 · `phase10_integration` 19/19 (was failing) · `phase7_integration` 36/36 · `d2_tests` 39/39 · `probe_tests` 34/34 · `entry_hit_tests` 7/7 · `fx_mode_tests` 20/20 · `phase10_smoke` 61/61 · `phase7_smoke` 68/68 · `r71_smoke` exit 0. Note: `d2_tests`/`probe_tests` tie assertions and the phase10/phase7 integration fixtures were updated for the approved convention/fix (their fixtures previously encoded the old tie→LOSS behavior and used a steady-uptrend candle stub that the D2 block now correctly suppresses).

---

## Fix round 2 — status (reviewer-approved 4 fixes + hardening)

| Fix | Finding | Change | Proof (fix_tests.mjs) |
|-----|---------|--------|------------------------|
| FIX-A | Sonnet #4 — OTC grade missing structure cap (HIGH) | `otcEngine.js`: `structureVerdict` computed BEFORE `getSignalGrade`, passed as 4th arg; return object reuses the variable (mirrors engine.js) | T8: OTC SELL 88% + structure AGAINST(BUY) → grade **C** (was A+); T8f proves same inputs without the arg grade A+ |
| FIX-B | Sonnet #5 — camarilla double-weight in OTC (MED-HIGH) | `otcEngine.js` unweight loop skips `÷rW` for `camarilla` (it is stored RAW in timeframe.js; option (a) chosen — standard engine storage/display untouched) | T9: OTC camarilla == `r2(raw × 1.5)` ≠ `r2(raw/0.84 × 1.5)` (1.786×); T9d asserts timeframe.js storage unchanged |
| FIX-C | Sonnet #7 — round-number bonus dead (MED) | `otc.js`: bonus now directional — price below level → resistance → `otcBonusDown`; above → support → `otcBonusUp`; exactly on level → no bonus (still surfaced) | T10: below→down>0/up=0, above→up>0/down=0, on→neither; T11: confidence delta `round(prox·0.4·3)` = 1 (was 0) |
| FIX-D | Sonnet #2 — confluence denominator 11→12 (LOW-MED display) | `/11` → `/12` in engine.js (×2), otcEngine.js (×2), timeframe.js early-returns (×2) | T12: grep — no `/11` or `total: 11` remains in `src/`; `/12` present in all 3 files |
| HARDEN-1 | Sonnet #1 — multiplier null crash (LOW, defensive) | `timeframe.js`: `structure.multiplier?.value` optional chaining | T13: source assert; all suites green |

**FIX-C direction-rule justification (as requested):** the round bonus models OTC mean-reversion rejection at a psychological level. Price approaching a round level from **below** treats it as **resistance** (sellers defend the level → rejection bias DOWN → `otcBonusDown`); price **above** a level treats it as **support** (buyers defend → rejection bias UP → `otcBonusUp`); exactly **on** the level is ambiguous (both sides defended) → no score bonus, still surfaced in `otcSignals` (`ROUND_LEVEL_*_RESISTANCE/_SUPPORT/_ON_LEVEL`). This matches the existing directional convention of `consecutiveCandles` (reversal away from the run direction) and `wickRejection`.

**r71_tests note:** `#14a` (OTC byte-equal vs pre-R7.1 baseline) is now updated to redact the approved round-2 fields (grade/camarilla/round signals/`/12` strings/affected scores) — the old byte-equality contract was intentionally broken by FIX-A/B/C/D. Result: **r71_tests stays 113 PASS / 3 FAIL — identical to main's pre-existing fails (#1a, #2, #17), which were NOT touched.** (Running r71_tests locally requires git object `71e87eb`; this clone needed `git fetch --unshallow` to obtain it.)

**Test matrix after fix round 2 (all green):** `fix_tests` **77/77** · `phase10_integration` 19/19 · `phase7_integration` 36/36 · `d2_tests` 39/39 · `probe_tests` 34/34 · `entry_hit_tests` 7/7 · `fx_mode_tests` 20/20 · `phase10_smoke` 61/61 · `phase7_smoke` 68/68 · `r71_tests` 113P/3F (== main) · `node --check` all src OK · `git diff --check` clean.

**NOT in scope (per reviewer):** Finding #3 (D2_TRENDING_BLOCK vs BAD_PAIR suspension) — no engine change; Phase-F decision needed from the user (D2 shadow observations already capture the counterfactual pair/regime/session context).

### CHECK-B analysis — entryHit window (no change made)

The `entryHit` shadow (stats.js) still measures over **expiry ± 5 min** (`fetchExpiryPrice` bracket), which is the *tail* of the trade, not the full signal→expiry holding window — and since `entry == last close` at signal time, the metric as computed is almost a mirror of `result==LOSS`. Recommendation if the metric is to mean anything: fetch candles from `timestamp → expiryTime` (window start = signal time), compare direction-correctly (BUY: window low ≤ entry; SELL: window high ≥ entry), and decide explicitly whether the trivial t0 touch (entry == current price) counts as a hit. This is a data-semantics decision the reviewer should approve before any code change.

---

## Findings summary

| ID | Severity | Title |
|----|----------|-------|
| BUG-001 | **Critical** | Telegram push never fires — `noPush` ReferenceError in `saveAndPush` (repo's own integration test fails) |
| BUG-002 | **High** | AI rescue overrides D2 hard blocks (TRENDING / HIGHEST-session) — proven on live records |
| BUG-003 | **High** | `fillStatus` is degenerate — always `INSTANT`, `entryDistancePct` always `0` |
| BUG-004 | **Medium-High** | `entryHit` shadow is a mirror of the result + measures the wrong window (paradox explained) |
| BUG-005 | **Medium** | `/api/report` double-counts results & gets overwritten by the cron resolver |
| BUG-006 | **Medium** | `passAI` can never be true after the AI runs → `aiOnly` subscribers can never match |
| BUG-007 | **Medium** | `MIN_CONFIDENCE_FLOOR` (72%) is not enforced on final output — live signals at 69% / 70% |
| BUG-008 | **Low-Medium** | Tie convention: `exit == entry` is counted as LOSS for both directions (live ties found) |
| BUG-009 | **Low** | Confluence denominator inconsistent: `/11` vs `total: 12` vs `total: 11` in one response |
| BUG-010 | **Low** | `winRate` semantics differ between `/api/stats` (lifetime) and `/api/history` (window) |

---

## BUG-001 — Telegram push never fires (`noPush` is undefined → ReferenceError)

- **Severity:** Critical
- **Location:** `src/handlers/signal.js:96` (used), `:140` (defined), `:250` / `:331` (call sites); `nopush` also dropped at `src/handlers/signal.js:158`
- **Evidence:**

```js
// signal.js:86-98 — saveAndPush() has NO `noPush` parameter and no closure over it
async function saveAndPush(signal, pair, isOTC, env, signalId, entrySource, response) {
  ...
  try {
    if (!noPush) await pushSignalToSubscribers({ ...response, id: signalId, pair, signal }, env);
  } catch (e) {
    console.warn('saveAndPush: push failed for ' + pair + ': ' + e.message);
  }
}
```
`noPush` is only declared inside `handleSignalRaw` (`const noPush = !!opts.noPush;` at line 140) — a different function. In strict-mode ESM, `!noPush` throws `ReferenceError: noPush is not defined`, which is swallowed by the `catch` on every signal. Additionally, `handleSignal()` drops the option before calling `handleSignalRaw`: `{ fxMode: !!opts?.fxMode }` (line 158), so `nopush=1` can never reach the engine either.

- **Repo's own test proves it** — `node scripts/phase10_integration.mjs`:
  ```
  PASS  engine produced an actionable signal
  FAIL  subscriber received exactly one message — expected 1, got 0
  TypeError: Cannot read properties of undefined (reading 'chatId')  // tg[0] — nothing was ever sent
  ```
- **Live evidence:** `/health` reports `phase10.pushEnabled: true`, `botKvBound: true`, `subscriberCount: 1` while `pushesLast24h: 0` — despite 500+ signals/day being generated and persisted (see `/api/stats` totals), a matching subscriber exists (`auto_users` has 1 entry), and `pushLog:` keys are only written after a successful delivery.
- **Impact:** Phase 10 (Telegram signal push + result push) is completely dead in this build; subscribers silently receive nothing. `nopush=1` (used by the FX-mode self-fetch in `pushToSubscribers.js` to avoid push loops) is also inert — a latent push-loop bug if BUG-001 is fixed by simply deleting the guard.
- **Repro:** `node scripts/phase10_integration.mjs` — first block fails.
- **Suggested fix:** Pass `noPush` explicitly into `saveAndPush` (and forward `opts.noPush` in `handleSignal` → `handleSignalRaw`), or gate the push at the `handleSignalRaw` call site before `saveAndPush`.

---

## BUG-002 — AI rescue overrides D2 hard blocks (TRENDING / HIGHEST / BAD_PAIR)

- **Severity:** High
- **Location:** `src/signal/engine.js:164-177` (D2 block) vs `:203-246` (AI rescue path)
- **Evidence (code):** When a D2 branch fires it sets `finalDirection = 'NO_TRADE'` (engine.js:166-174). Then:
  ```js
  const aiTargetDir = finalDirection !== 'NO_TRADE'
    ? finalDirection
    : (rawDirection !== 'NO_TRADE' && rawConfidence >= 60 ? rawDirection : null);  // engine.js:203-205
  ...
  if (finalDirection === 'NO_TRADE' && aiTargetDir !== 'NO_TRADE') {
    // RESCUE PATH — signal was blocked by soft filter
    if (aiAgreed && (combinedAI.confidence || 0) >= 70 && !combinedAI.concerns) { finalDirection = aiTargetDir; ... }
  ```
  There is **no check that the block was a D2 hard block** (`d2Audit` is never consulted). Any D2-blocked signal whose raw confidence ≥ 60 and whose AI agrees (≥60) is re-issued as a live trade.
- **Evidence (live):**
  - `SOL/USD` `sig_1785988810342_x6mu6` — `marketRegime: "TRENDING"`, `direction: "SELL"`, `aiStatus: "OK"`, `aiAgreed: true`, **result LOSS** (73.48 → 73.83). The `D2_TRENDING_BLOCK (29.5% WR n=356)` should have killed this pre-AI.
  - `DOT/USD` `sig_1785874527957_n2oq7` & `sig_1785874218800_xgsoj` — `marketRegime: "TRENDING"`, BUY, `aiAgreed: true` — both emitted despite the TRENDING block.
  - `EUR/USD` `sig_1785936673946_z64dp` — `sessionQuality: "HIGHEST"`, BUY, `aiAgreed: true`, **result LOSS** — the `D2_HIGHEST_SESSION_BLOCK (6.1% WR n=66)` was bypassed by the rescue path.
- **Impact:** The three D2 negative filters (which Phase C/D proved lose at 6-30% WR) are effectively dead whenever the AI agrees — the exact "242 rescued trades" regression from the previous audit, now reproduced on live records dated 2026-08-04/05/06.
- **Repro:** Any TRENDING-regime or HIGHEST-session signal with rawConfidence ≥ 60 that the dual AI agrees with.
- **Suggested fix:** In the rescue path, skip rescue when `d2Audit` is set (D2 blocks are hard, data-backed blocks; rescue should only apply to soft filters like confidence floor / dead-market).

---

## BUG-003 — `fillStatus` is degenerate: always `INSTANT`, `entryDistancePct` always `0`

- **Severity:** High
- **Location:** `src/signal/engine.js:379-401`
- **Evidence (code):** The "current price" and the "entry price" are read from the **same array element**:
  ```js
  const entryPx = bestTFA && bestTFA.entry ? bestTFA.entry.price : null;   // = candles[last].close
  const tfCandles = candleData[best ? best.timeframe : '5min'];
  const lastClose = tfCandles && tfCandles.length ? tfCandles[tfCandles.length - 1].close : null;
  const dist = Math.abs(lastClose - entryPx);   // ALWAYS 0
  const rel = entryPx !== 0 ? dist / entryPx : 0; // ALWAYS 0
  const actionable = rel <= 0.0005;              // ALWAYS true
  ```
  `analysis.entry.price` was set in `timeframe.js` as `candles[candles.length - 1].close` — the identical value. So `dist === 0` by construction.
- **Evidence (live):** `GET /api/signals/latest?pair=BTC/USD` (cron generation 2026-08-06T04:40):
  ```json
  "fillStatus": "INSTANT",
  "entryPrice": 64712.59,
  "currentPrice": 64712.59,
  "entryDistancePct": 0
  ```
  `entryPrice === currentPrice` exactly; the feature can never report `PENDING_ENTRY`.
- **Impact:** The feature added in the HEAD commit is a no-op — clients always see "INSTANT" with 0 distance, so the "wait for price to come to entry" UX cannot work, and the App/bot cannot distinguish fillable vs pending entries.
- **Repro:** `curl https://fttotcv6.umuhammadiswa.workers.dev/api/signal?pair=BTC/USD` on any BUY/SELL — inspect `fillStatus`/`entryDistancePct`.
- **Suggested fix:** Compare the entry price against an independent current price (e.g., the last tick via a quote call, or the latest 1-min candle fetched separately); if no independent price exists, remove the feature rather than emit a constant.

---

## BUG-004 — `entryHit` shadow measures a mirror of the result, over the wrong window

- **Severity:** Medium-High
- **Location:** `src/history/stats.js:227-244` (entry-hit block), `:316-357` (`fetchExpiryPrice` `windowLow`/`windowHigh` over expiry ±5 min)
- **Evidence (code):**
  ```js
  // windowLow/High are computed ONLY over candles in [expiry-5min, expiry+5min]
  if (record.direction === 'BUY')  record.entryHit = wl <= record.entryPrice + 1e-12;
  else if (record.direction === 'SELL') record.entryHit = wh >= record.entryPrice - 1e-12;
  ```
  Two problems:
  1. **Wrong window.** The holding period is `[signalTime, expiry]`, but the low/high come from the expiry ±5 min bracket — the tail of the trade only. The signal-time start (where the price *is* the entry by construction) is excluded, which is what produces the weird 12.7% "hit" rate.
  2. **Near-tautology.** For a LOSS the price ended past the entry (BUY: below, SELL: above), so the expiry-window low/high almost always satisfies the condition → `entryHit ≈ (result == LOSS)`. The field carries almost no independent information about "was the entry reachable".
- **Evidence (live)** — sampled 2026-08-05/06, 74 records across `SOL/USD` (24), `EUR/USD` (20), `DOT/USD` (30):
  - **LOSS → `entryHit: true` in 42/42 rows** (e.g., `SOL/USD` `sig_1785988810342_x6mu6` LOSS hit=true; `EUR/USD` `sig_1785987923179_cjsji` LOSS hit=true; `DOT/USD` `sig_1785988507549_29vmp` LOSS hit=true).
  - **WIN → `entryHit: false` in ~74%** (e.g., `SOL/USD` `sig_1785978008697_i4fcf` WIN hit=false; `EUR/USD` `sig_1785959411049_tsaw2` WIN hit=false; `DOT/USD` `sig_1785986110691_4hqlz` WIN hit=false).
  - A degenerate SELL case: `SOL/USD` `sig_1785988810342_x6mu6` entry 73.48, expiry-window low 73.78 — price **never came back to the entry** (it gapped away upward), yet `entryHit: true` because `wh (73.83) >= entry` — for a SELL the correct "price returned to entry" test is the window *low*, not the high.
- **Impact:** This is the direct explanation of the reported "entry-hit paradox" (08-05: hit=12.7%, miss=100%): the shadow is not measuring entry reachability; it is nearly `result==LOSS`. Any conclusion drawn from `entryHit` ("signals whose entry wasn't hit always win") is an artifact.
- **Repro:** Compare `result` vs `entryHit` on `/api/history?pair=SOL/USD&limit=60` — the correlation above reproduces row-by-row.
- **Suggested fix:** Compute windowLow/windowHigh over `[timestamp, expiryTime]` (fetch candles from signal time to expiry) and use direction-correct comparisons; also document that since `entry == last close at signal time`, "entry hit" is trivially true at t0 for INSTANT entries — the metric only becomes meaningful if the entry is re-tested after leaving it (or if the signal is PENDING_ENTRY).

---

## BUG-005 — `/api/report` double-counts results and can be overwritten by the cron resolver

- **Severity:** Medium
- **Location:** `src/handlers/health.js:132-154` (`handleReport`)
- **Evidence (code):** `handleReport` updates the history row (`sig.result = result`, `reportedManually = true`) and calls `updatePairStats(pair, result, ...)` — but it never:
  1. deletes the matching `pending:<signalId>` key (written in `saveSignalToHistory`), and
  2. checks whether the row already has a `result`.
  The `*/2` cron `scheduledTracker` (`src/history/stats.js:211-255`) later picks up the still-existing pending key, re-fetches the expiry price, **overwrites `sig.result`** with the automated verdict (`updateSignalResult`) and calls `updatePairStats` **again**. Net effect: one signal contributes two outcomes (e.g., manual WIN + cron LOSS) to `stats:`, silently corrupting WR and the dynamic-confidence feedback loop.
- **Impact:** `stats.winRate` / `byTF` / `bySession` / `byRegime` and `getDynamicConfidenceAdjustment()` (which feeds every future signal's confidence) get double-counted whenever a manual report is used — a real, silent data-corruption path.
- **Repro:** Report a WIN on a signal that is still `pending:` (or that the cron will resolve later); observe `stats.wins++` then `stats.losses++` for the same id.
- **Suggested fix:** In `handleReport`, delete `pending:<id>` and skip `updatePairStats` when `sig.result` is already set (idempotent manual override); or route the manual report through the same resolver and let the pending key be consumed exactly once.

---

## BUG-006 — `passAI()` can never return true after the AI actually runs

- **Severity:** Medium
- **Location:** `src/handlers/pushToSubscribers.js:72-76`; `src/signal/engine.js:223`; `src/ai/combine.js`
- **Evidence (code):**
  ```js
  // pushToSubscribers.js
  export function passAI(sig, aiOnly) {
    if (!aiOnly) return true;
    return !!(sig && sig.aiValidation
      && sig.aiValidation.status === 'OK' && sig.aiValidation.agrees === true);
  }
  ```
  But when the AI runs, `engine.js:223` replaces `aiValidation` with the dual combiner result, which has **no top-level `status` field** — it is `{ cerebras, groq, combined, combinedAgreed }` (`combine.js`). Only `combined.status` exists.
- **Evidence (live):** `BTC/USD` signal `aiValidation` object:
  ```json
  "aiValidation": { "cerebras": {...}, "groq": {...}, "combined": { "status": "OK", ... }, "combinedAgreed": true, "agrees": true }
  ```
  — no `status` key at the `aiValidation` level, so `sig.aiValidation.status === 'OK'` is `false` even when both models agreed (`combined.status === 'OK'`, `agrees: true`).
- **Impact:** Subscribers with `aiOnlyMode: true` can never match, so they would never receive pushes even after BUG-001 is fixed. (Also makes `aiStatus`/`passAI` semantics confusing for any consumer reading `aiValidation.status`.)
- **Repro:** Run `passAI` on any post-AI signal object (`aiValidation.status` is `undefined`).
- **Suggested fix:** `passAI` should read `sig.aiValidation.combined.status === 'OK'` (or a normalised top-level status set by `combine.js`/engine).

---

## BUG-007 — `MIN_CONFIDENCE_FLOOR` (72%) is not enforced on the final output

- **Severity:** Medium
- **Location:** `src/signal/voteFilters.js:203-225` (floor check, pre-AI only); `src/signal/engine.js:233-258` (post-AI confidence changes with no re-check)
- **Evidence (code):** The floor is checked once inside the deterministic pipeline. After that, the AI paths change confidence freely — normal path `confidence - 5` (agree-with-concerns, engine.js:254), rescue path `min(92, round((raw+ai)/2))` or `min(85, raw+5)` — and there is **no second floor check** on `finalDirection`/`confidence` before output.
- **Evidence (live):** `/api/history?pair=SOL/USD&limit=60` contains emitted signals below the advertised 72% floor:
  - `sig_1785960913963_djhe0` — BUY `confidence: "69%"`, `aiStatus: "OK"`, `aiAgreed: true`, **LOSS**
  - `sig_1785956707826_hhrpa` — BUY `confidence: "70%"`, `aiStatus: "OK"`, `aiAgreed: true`, **LOSS**
  Both were persisted, pushed (would have been pushed), and counted in stats at below-floor confidence.
- **Impact:** The documented "72% minimum" filter (surfaced in `/health.filters.minConfidenceFloor`) is a pre-AI-only gate; post-AI output can silently fall to 65-71%. Since grade/confidence drive subscriber filters (`passConf`), users can receive "below the advertised minimum" signals.
- **Repro:** `/api/history?pair=SOL/USD&limit=60`, rows from 2026-08-05 19:05Z and 20:15Z.
- **Suggested fix:** After the AI block, re-apply `if (finalDirection !== 'NO_TRADE' && confidence < CONFIG.MIN_CONFIDENCE_FLOOR) finalDirection = 'NO_TRADE'` (with an explicit, logged exception only for the intended rescue semantics).

---

## BUG-008 — Tie convention: `exit == entry` counts as LOSS for both directions

- **Severity:** Low-Medium
- **Location:** `src/history/stats.js:220-221` (also duplicated in `d2store.js`, `probeStore.js`, `r71store.js`)
- **Evidence (code):**
  ```js
  if (record.direction === 'BUY')  winLoss = exitPrice > record.entryPrice ? 'WIN' : 'LOSS';
  if (record.direction === 'SELL') winLoss = exitPrice < record.entryPrice ? 'WIN' : 'LOSS';
  ```
  An exact tie is classified as LOSS in both directions; there is no `TIE` outcome class anywhere in the pipeline.
- **Evidence (live):** exact ties recorded as LOSS —
  - `SOL/USD` `sig_1785970811537_wmoco`: entry 74.03 → exit 74.03 → `result: "LOSS"`
  - `SOL/USD` `sig_1785965412142_7n0gh`: entry 74.12 → exit 74.12 → `result: "LOSS"`
  (In the current 30-row DOT/USD window no exact `exit==entry` tie was observed — the earlier "28% ties" figure is not reproducible on today's live data, but the convention remains and low-vol 3-decimal pairs like DOT/USD are the most exposed.)
- **Impact:** Deflates WR on low-volatility pairs; a fixed-time expiry that closes exactly at entry is a "push" in most trading conventions, not a loss. Affects stats, dynamic confidence, D2/probe/R7.1 counterfactual WRs.
- **Repro:** Any signal whose expiry close equals the entry close.
- **Suggested fix:** Classify ties explicitly (`exitPrice === entryPrice → 'TIE'`) and exclude them from both W and L in `updatePairStats` (or use `>=`/`<=` consistently after deciding the convention).

---

## BUG-009 — Confluence denominator is inconsistent (`/11` vs `total: 12` vs `total: 11`)

- **Severity:** Low
- **Location:** `src/signal/engine.js:273` (`'/11 categories'` + `findBestTimeframe` reason), `src/signal/timeframe.js:54,69` (`total: 11` on early-return paths), `:568` (`total: 12` on the full path), `src/signal/otcEngine.js:57,198`
- **Evidence (code):** the engine now scores **12 categories** (camarilla was added) plus an optional structure category vote (13th), yet:
  - `recommendations[rtf].confluence = rec.confluence + '/11 categories'`
  - `findBestTimeframe(...).reason = 'Strongest BUY signal with 9/11 confluence'`
  - early-return TFs emit `confluenceDetail.total: 11`, the full path emits `total: 12`
- **Evidence (live):** one `BTC/USD` response contains all three at once — `"confluence": "9/11 categories"` (5min rec), `"confluenceDetail": { "bullish": 9, "bearish": 1, "total": 12 }` (5min TF), and `"0/11 categories"` + `"total": 11` (1min dead-market TF).
- **Impact:** Display/audit confusion — "9/11" implies a different scale than the real 12-13 category system; downstream consumers computing ratios from the string get wrong numbers.
- **Repro:** Any BUY/SELL response; compare `bestTimeframe.reason` vs `timeframeAnalysis.*.confluenceDetail.total`.
- **Suggested fix:** Derive the denominator from a single constant (e.g., `CATEGORY_COUNT`) used by both the engine output and the display strings.

---

## BUG-010 — `winRate` semantics differ between `/api/stats` (lifetime) and `/api/history` (window)

- **Severity:** Low
- **Location:** `src/history/stats.js:375-378` (`updatePairStats` — lifetime winRate, `sampleSize` capped at `WIN_RATE_LOOKBACK` but winRate is not) vs `src/handlers/health.js:121-127` (`handleHistory` — winRate over the requested `limit` window); `/health` advertises `winRateLookback: 20`.
- **Evidence (live):** `SOL/USD` → `/api/stats` `winRate: 0.467` (776 signals, lifetime) while `/api/history?pair=SOL/USD&limit=15` reports `winRate: 0.6` (9/15). Both are labeled "winRate".
- **Impact:** Consumers (dashboards, the bot) get different "current WR" numbers from different endpoints; the advertised 20-signal lookback is never actually applied to `winRate`.
- **Repro:** Compare `/api/stats` and `/api/history` for the same pair.
- **Suggested fix:** Either compute `winRate` over the last `WIN_RATE_LOOKBACK` decided signals in `updatePairStats` (as advertised), or rename the fields (`lifetimeWinRate` / `windowWinRate`) to match reality.

---

## Known-issue re-check (from the brief) — status on live evidence

1. **AI rescue overriding D2 block (TRENDING bypass, "242 rescued")** → **CONFIRMED, still present.** Live rows dated 2026-08-04/05/06 (BUG-002) show TRENDING and HIGHEST-session signals emitted with `aiStatus: OK / aiAgreed: true`. At least one of them (SOL/USD TRENDING SELL, EUR/USD HIGHEST BUY) lost.
2. **Forex SELL weak (~20% WR)** → **Not reproduced in today's live window — and the recent data shows the opposite.** Last-30 EUR/USD window: SELL 5/7 wins vs BUY 0/11 (market fell; mean-reversion SELLs were right). The mechanism described in `probeStore.js` (RANGING-regime mean-reversion RSI → "overbought ⇒ SELL") is still in the code (`timeframe.js` momentum block), and the probe instrumentation is collecting, but the current window does not support "SELL systematically broken". (Statistical caveat: n=7 SELLs.)
3. **DOT/USD tie artifact (28% ties)** → The tie→LOSS convention is confirmed in code and live (BUG-008, exact ties on SOL/USD). In the current 30-row DOT/USD sample there were **0** exact `exit==entry` ties, so the 28% figure is not reproducible on today's data — likely from an earlier window/definition; the convention bug itself remains.
4. **Entry-hit paradox (hit=12.7%, miss=100%)** → **Explained and reproduced** (BUG-004): `entryHit` is nearly `result==LOSS` because of the expiry±5min window and direction test; the "paradox" is an artifact of the metric, not evidence that the engine picks the wrong direction at entry time.
5. **`structureAudit` / private-shadow leak** → **Verified clean.** `/api/history` strips `structureAudit` (health.js) and live rows don't carry it; `Symbol`-carried audits (`ENGINE_AUDIT`, `D2_AUDIT`, `PROBE_AUDIT`, `SHADOW_TF`) are non-enumerable and absent from live JSON.

---

## Notes on method (honesty)

- All live evidence was captured from the production worker on 2026-08-06 ~04:30-05:00 UTC (the sandbox cannot open TLS sockets to the host, so `fetch_page` was used for live reads; code/tests were run locally).
- The repo's own `scripts/r71_tests.mjs` cannot run in this clone because it requires git object `71e87eb` which is absent from the (trimmed) history — an infra issue, not a product finding.
- `node --check` passes on every source file; the finding list contains no syntax-level errors.

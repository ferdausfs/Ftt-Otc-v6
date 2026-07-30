# R7.1 — Structure Attribution Shadow Instrumentation · Implementation Report

> **⚠ CORRECTION NOTICE (Report-7 round).** Three corrections were applied on
> top of the original candidate and supersede specific claims in this document —
> see `R7_1_CORRECTION_REPORT.md` for the authoritative detail:
> - **Finding A (fixed):** the confirmation-candle ×0.85 penalty is now
>   **faithfully applied** to the shadow engine score (relative to
>   `shadowCoreDirection`). The §0 "never changes a direction / not reapplied"
>   wording below is OUTDATED and was corrected.
> - **Finding B (fixed):** the `directHardBlockOnly` causal flag was **removed**
>   from the persisted audit and diagnostic (a combined counterfactual cannot
>   isolate the hard-block). Any `directHardBlockOnly` / "hard-block-only"
>   reference below is superseded; only observational flags remain.
> - **Finding C (fixed):** the generated `R7_1_FULL_DIFF.patch` artifact was
>   removed from the commit so `git diff --check 71e87eb` passes (exit 0).

**Repo:** `github.com/ferdausfs/Ftt-Otc-v6`
**Base commit:** `71e87eb` (`71e87ebe3c9a033c59ecaf679a54452f268d829f`)
**Resulting commit:** the HEAD commit of this branch — exact SHA is reported in the delivery summary; verify with `git rev-parse HEAD`. (The full unified diff from the base commit is `R7_1_FULL_DIFF.patch` at repo root.)
**Work type:** implementation + test only.

> **Explicit statements required by the prompt.**
> - **No deploy.** Nothing was deployed. The worker was not published; no `wrangler deploy` ran.
> - **No accuracy / win-rate claim.** R7.1 only *measures and privately persists* a structure-excluded counterfactual. It makes no claim about whether removing structure improves results. The shadow is a **combined structure-stack counterfactual**, not proof of any single layer's causal effect.
> - **Production behavior is unchanged.** Verified by a baseline-vs-instrumented integration equivalence test (`scripts/r71_tests.mjs` [#1]): 5 candle fixtures produce byte/field-equal `direction, score, confluence, confidence, grade, recommendations, timeframeAnalysis` and identical normal-history record shapes (modulo the additive `structureAudit` field). OTC engine output is byte-equal vs baseline ([#14]).

---

## 0. Scope decisions & discrepancies vs. the prompt

- **Scope held:** standard (Forex/Crypto) engine only; private, bounded, additive audit; isolated shadow observation store; 15 mandatory tests; raw outputs. OTC untouched except an OTC regression test.
- **`STRUCTURE_CREATED` wording.** The prompt lists it as *"production deterministic trades while shadow is NO_TRADE, or directions differ as defined/documented"*. The "or directions differ" clause overlaps with `STRUCTURE_REDIRECTED`. I implemented the clean, mutually-exclusive 4-way partition (below) and use `STRUCTURE_REDIRECTED` for the "both trade, different direction" case. `STRUCTURE_CREATED` = production trades / shadow `NO_TRADE` only. This is the conservative reading; documented here per the prompt's instruction to report interpretation choices.
- **Shadow per-TF score fidelity.** The shadow reuses the **pre-structure** category scores (captured before the structure multiplier). The production confirmation-candle ×0.85 factor (applied in production *after* the decision, to the displayed score only) is **not** reapplied to the shadow score. It never changes a direction (it only scales a displayed score), so shadow *directions* are exact; shadow *confidence* is an exact re-derivation through the shared deterministic pipeline. This is a documented, bounded simplification — the three real structure interventions (multiplier, confluence vote, hard-block) are fully captured.
- **Dynamic-history adjustment in the shadow.** The shadow pass calls the same `runDeterministicVoteAndFilters` helper, so it applies the same `getDynamicConfidenceAdjustment` conditional read as production. This is one extra **conditional** KV read (only when the shadow has a candidate direction), additive to production's read. Production's conditional fetch behavior is unchanged.

---

## 1. Changed files & line-level purpose

### New files

| File | Purpose |
|---|---|
| `src/signal/voteFilters.js` | **Shared deterministic pipeline.** `decideTfDirection(...)` (the per-TF BUY/SELL/NO_TRADE decision, lifted verbatim from `timeframe.js`) and `runDeterministicVoteAndFilters(ctx)` (the weighted-vote + deterministic-filter block, lifted **verbatim** from `engine.js` 71e87eb, lines "WEIGHTED VOTING" → "NEWS BLACKOUT final check"). Production and the shadow both call it, so the two paths cannot drift. |
| `src/signal/r71shadow.js` | **Audit core (standard engine only).** Non-enumerable `Symbol` transport (`SHADOW_TF`, `ENGINE_AUDIT`) + explicit getters; `buildTimeframeAudit` (bounded per-TF audit); `computeEngineAudit` (runs the shadow through the shared pipeline, computes attribution + AI-boundary + diagnostic flags + isolated-observation eligibility + deterministically-derived shadow entry/expiry); `classifyAttribution`; `sanitizeAuditForHistory` (bounded persisted shape). Never calls an AI. |
| `src/history/r71store.js` | **Isolated shadow observation store (§E).** `admitShadowObservation`, `resolveShadowObservations`, KV accounting. Lives entirely under the `shadow:` prefix; fail-open; idempotent; capped resolver. |
| `scripts/r71_tests.mjs` | 15 mandatory tests + §E accounting/cap/dedup (94 assertions total). |
| `scripts/r71_fixtures.mjs` | Deterministic OHLCV generators (mulberry32 PRNG) + engineered CHoCH/neutral structure candles. |
| `scripts/r71_smoke.mjs` | End-to-end engine smoke (signal + private audit, no leak). |
| `verify/r71_*.txt` | Raw captured terminal output (syntax/diff-check, R7.1 suite, existing smoke). |
| `.gitignore` | Ignores `verify/baseline/` (regenerated from git on demand by the test). |

### Modified files

| File | Change (additive; production fields byte-identical) |
|---|---|
| `src/signal/timeframe.js` | (1) capture `__r71PreStructUp/Down/UpCat/DownCat` immediately before the structure multiplier; (2) track the structure confluence vote (`categoryVoteApplied`/`voteDirection`); (3) replace the inline per-TF decision with `decideTfDirection(...)` (identical logic); (4) capture `preHardBlockDirection` and `hardBlocked/hardBlockReason`; (5) compute freshness with honest names; (6) attach all of this via the non-enumerable `SHADOW_TF` Symbol on the returned analysis. No enumerable field of the return object changed. |
| `src/signal/engine.js` | Replace the inline filter chain with one `await runDeterministicVoteAndFilters(...)`, lift the returned values into locals with the **same names** so the AI-validation and output-building sections are untouched; compute + attach the engine audit (`attachEngineAudit`) inside a try/catch (fail-open). The returned signal object's enumerable fields are unchanged; only a non-enumerable `Symbol` is added. |
| `src/history/stats.js` | `saveSignalToHistory` reads the audit via `getEngineAudit(signal)` and persists a bounded `record.structureAudit` (additive; OTC/cbShadow/audit-less rows stay lean). `fetchExpiryPrice` is now `export`ed so the shadow resolver reuses it (no duplicate). |
| `src/handlers/signal.js` | `maybeAdmitShadowObservation(...)` (fail-open, `ctx.waitUntil`) admits a private observation when the engine audit reports `isolatedObservationEligible`. Standard engine only (OTC carries no audit). |
| `src/handlers/health.js` | `handleHistory` strips `structureAudit` from every row before responding. |
| `src/index.js` | The `*/2 * * * *` (result-checker) cron also runs `resolveShadowObservations(env)` (pending TTL ~2h aligns with the result-resolution window). Cron schedule unchanged. |

---

## 2. Audit schema

### 2.1 Private transport (§A)
All audits travel on **non-enumerable Symbol properties** (`SHADOW_TF` per timeframe, `ENGINE_AUDIT` on the signal). `JSON.stringify()` / `for…in` ignore Symbols, so `/api/signal`, `/api/batch`, latest cache, bot push, and public `/api/history` cannot expose them without the explicit getter (`getEngineAudit`). Proven by tests [#9] and [#10].

The only enumerable audit surface is `record.structureAudit` inside a normal history row, and `handleHistory` strips it before any public response ([#9e]/[#10b]).

### 2.2 Per-timeframe audit (`buildTimeframeAudit`)
```
productionPreHardBlockDirection   BUY | SELL | NO_TRADE
productionFinalDirection          (post-hard-block TF direction)
shadowCoreDirection               (decideTfDirection on pre-structure scores)
productionScore                   { up, down, diff }
productionConfluence              number
shadowCoreScore                   { up, down }            // pre-structure
shadowCoreConfluence              number                  // pre-vote
multiplier                        { direction, value, appliedUp, appliedDown }
structureBias                     BULLISH|BEARISH|WEAK_*|NEUTRAL
bos / choch / sweep               type string | 'NONE'
structureSummary                  string
categoryVoteApplied               bool
voteDirection                     BUY|SELL|null
hardBlocked                       bool
hardBlockReason                   string|null
multiplierOrVoteChangedDirection  bool   // preHardBlockDirection != shadowCoreDirection
hardBlockChangedDirection         bool   // hardBlocked && preHardBlockDirection != final
freshness                         { chochEventAgeBars, brokenSwingAgeBars,
                                   bosReferenceSwingBarsAgo, recentBosBreakBarsAgo }
```

### 2.3 Engine-level audit (`computeEngineAudit`)
```
decisionScope               = 'STANDARD_ENGINE_DETERMINISTIC_PRE_AI'
attribution                 UNCHANGED|STRUCTURE_CREATED|STRUCTURE_SUPPRESSED|STRUCTURE_REDIRECTED
comparability               COMPARABLE_PRE_AI | AI_AFFECTED
comparabilityReason         string
productionPreAiDirection    (deterministic pre-AI production direction)
productionPreAiConfidence
productionFinalDirection    (ACTUAL post-AI live direction)
productionFinalConfidence
shadowFinalDirection        (deterministic shadow; never sees AI)
shadowConfidence
shadowRawDirection / shadowFiltersApplied   (in-memory only; NOT persisted)
diagnostic { tfHardBlockObserved, multiplierOrVoteDivergenceObserved,
             hardBlockFlippedAny, directHardBlockOnly, prodTradeTfs, shadowTradeTfs }
timeframes { 1min, 5min, 15min }   (per-TF audits, bounded)
isolatedObservationEligible bool
shadowTradeContext          { direction, confidence, alignment, bestTF, entryPrice, expiryTime } | null
```

### 2.4 Attribution classes (§D) — computed on **deterministic pre-AI production** vs **deterministic shadow**

| production (pre-AI) | shadow | class |
|---|---|---|
| BUY/SELL = shadow | same | `UNCHANGED` |
| BUY/SELL | NO_TRADE | `STRUCTURE_CREATED` |
| NO_TRADE | BUY/SELL | `STRUCTURE_SUPPRESSED` |
| BUY/SELL | opposite | `STRUCTURE_REDIRECTED` |
| NO_TRADE | NO_TRADE | `UNCHANGED` |

### 2.5 Sanitized record per key attribution path (real module output)

**UNCHANGED** (shadow == production; no divergence):
```json
{ "decisionScope":"STANDARD_ENGINE_DETERMINISTIC_PRE_AI", "attribution":"UNCHANGED",
  "comparability":"COMPARABLE_PRE_AI",
  "productionPreAiDirection":"BUY","productionFinalDirection":"BUY",
  "shadowFinalDirection":"BUY","shadowConfidence":74,
  "diagnostic":{"tfHardBlockObserved":false,"multiplierOrVoteDivergenceObserved":false,
                "hardBlockFlippedAny":false,"directHardBlockOnly":false,
                "prodTradeTfs":1,"shadowTradeTfs":1} }
```
**STRUCTURE_SUPPRESSED — direct hard-block-only** (TF audit excerpt):
```json
{ "productionPreHardBlockDirection":"BUY","productionFinalDirection":"NO_TRADE",
  "shadowCoreDirection":"BUY","multiplier":{"direction":"BUY","value":1.4,"appliedUp":1.4,"appliedDown":0.6},
  "choch":"BULLISH_CHOCH","hardBlocked":true,"hardBlockReason":"COUNTER_CHOCH_BULLISH",
  "multiplierOrVoteChangedDirection":false,"hardBlockChangedDirection":true }
// diagnostic.directHardBlockOnly = true   (suppression explained purely by the hard-block)
```
**STRUCTURE_SUPPRESSED — NOT hard-block-only** (multiplier/vote divergence; §D honesty):
```json
{ "productionPreHardBlockDirection":"NO_TRADE","productionFinalDirection":"NO_TRADE",
  "shadowCoreDirection":"BUY","hardBlocked":false,"hardBlockReason":null,
  "multiplierOrVoteChangedDirection":true,"hardBlockChangedDirection":false }
// diagnostic.directHardBlockOnly = false, multiplierOrVoteDivergenceObserved = true
```
**STRUCTURE_REDIRECTED**: `productionPreAiDirection=BUY`, `shadowFinalDirection=SELL` (both trade, different direction). **STRUCTURE_CREATED**: `productionPreAiDirection=BUY`, `shadowFinalDirection=NO_TRADE`.

---

## 3. Pre-AI / AI comparability boundary (§C)

- The shadow is **deterministic PRE-AI only**. `computeEngineAudit` never issues an AI call and never conditionally reuses AI — it always runs `runDeterministicVoteAndFilters` (no AI). Verified by [#8].
- `productionPreAiDirection` = production's deterministic pre-AI direction (engine value before the AI block). `productionFinalDirection` = the **actual live** post-AI direction.
- **`comparability`**: `AI_AFFECTED` iff `productionFinalDirection != productionPreAiDirection` (AI altered the live decision); else `COMPARABLE_PRE_AI`. AI-affected rows are recorded but **not** treated as clean structure-only evidence.
- **Isolated observation admission** additionally requires production **actual final AND pre-AI direction both `NO_TRADE`** (plus shadow BUY/SELL + deterministic `STRUCTURE_SUPPRESSED`). An AI rescue that flips NO_TRADE→BUY therefore disqualifies the row from admission ([#8]).

---

## 4. Freshness-field semantics (§B, critical)

The BOS/CHoCH detectors (`src/indicators/structure.js`) test a break on the **latest** candle, so a *present* event is age `0`. Swing-index ages are **not** event ages and are named accordingly:

| Field | Meaning | Source |
|---|---|---|
| `chochEventAgeBars` | `0` when a CHoCH exists on the current candle; `null` otherwise. | present CHoCH ⇒ break on latest candle |
| `brokenSwingAgeBars` | `(n-1) − brokenSwing.idx` — the **broken swing pivot** age (for CHoCH the broken lower-high / higher-low; for BOS the broken swing). **Not** a CHoCH/BOS event age. | swing index |
| `bosReferenceSwingBarsAgo` | `bos.barsAgo` = `(n-1) − referenceSwing.idx`. The reference swing's age — **not** the break-event freshness. | `detectBOS` |
| `recentBosBreakBarsAgo` | min `recentEvents[].barsAgo` = `(n-1) − breakCandle.idx`. This is the break-candle age (the closest available break-event freshness). | `checkRecentStructureEvent` |

Verified by [#15e]: engineered `BULLISH_CHOCH` ⇒ `chochEventAgeBars === 0`; `brokenSwingAgeBars` is a finite number (the broken swing's age), never mislabelled as the CHoCH event age.

RSI/Stoch/Williams scalars are **not** persisted by R7.1 and no rule acts on them.

---

## 5. Isolated KV key schema, TTL, cap, dedup (§E)

All keys live under the `shadow:` prefix — distinct from `sig:`, `pending:`, `stats:`, `cb:`, `quota:`, `rr:`, `c:`, `latest:`, `pushLog:`, `pushLock:` (grep-verified in [#11e]).

| Key | Value | TTL |
|---|---|---|
| `shadow:obs:<id>` | full observation record (result/exitPrice appended on resolve) | **30 days** |
| `shadow:pending:<id>` | same payload, awaiting expiry resolution | **~2 h** (7200 s) — never 7 days |
| `shadow:idx:<PAIR>` | `[{id, admittedAt, direction, entryPrice}]` admission index (cap + dedup) | 30 days |

- **Cap:** max **30 admitted per pair per rolling 30-day window** (14 pairs ⇒ ≤ **420** total). Enforced by pruning the per-pair index to the last 30 days, then rejecting at length ≥ 30. Verified [#§E].
- **Dedup:** same pair + direction + nearby-entry (`rel ≤ 0.0005` or `abs ≤ 0.0001`) within a **2-hour** window ⇒ rejected. Verified [#§E].
- **Resolver:** idempotent (re-resolve finds the pending key already deleted ⇒ no-op, [#12c]); capped at **10** per cron execution; transient fetch failures increment a retry counter (cap **15**) and only terminalize as `UNKNOWN` after the budget/TTL exhausts ([#12a/b]); updates **only** `shadow:obs:*` and deletes **only** its own `shadow:pending:*` ([#11f]).
- **Fail-open:** every public store function is wrapped so a KV error never alters/delays a live signal ([#13]).
- **Selection limitation (stated plainly):** admission is a **rolling** 30-day window, not a permanently-fixed first-30-ever set. Under high event volume, only the **earliest** ≤30 candidates per window are admitted; later candidates are dropped, which biases the sample toward earlier events and toward times of lower structure-suppression frequency. Actual event rate is **unknown until live data exists**.

---

## 6. KV lifecycle read/write table + bounded write estimate

Per single shadow observation lifecycle (one admission + one resolution):

| Lifecycle stage | List | Read | Write | Delete |
|---|---|---|---|---|
| Admission (accepted) | 0 | 1 (index) | 3 (obs + pending + index) | 0 |
| Admission (dedup reject) | 0 | 1 | 0 | 0 |
| Admission (cap reject) | 0 | 1 | 0 | 0 |
| Resolution — success | 1 | 1 (pending) | 1 (obs) | 1 (pending) |
| Resolution — transient retry | 1 | 1 | 1 (pending) | 0 |
| Resolution — terminal UNKNOWN | 1 | 1 | 1 (obs) | 1 (pending) |

(The TwelveData expiry-price fetch inside resolution is an external HTTP call, not a KV op; it reuses the exported `fetchExpiryPrice`, no duplication.)

**Bounded worst-case write volume.** Cap = 420 observations system-wide per rolling 30 days. Each accepted observation is **3 admission writes + 1 resolution write = 4 writes** lifetime (plus at most 14 retry writes if every fetch transiently fails up to the cap). Worst case ≈ **420 × (4 + 14) = ~7,560 KV writes / 30 days / account** (retry-dominated pathological case); expected (clean resolution, few retries) ≈ **420 × 4 = 1,680 writes / 30 days**. Reads scale similarly (1 per attempt). This is well within Cloudflare Workers Free (1,000 writes/**day**). **Actual volume is unknown until live data exists** and is bounded by real structure-suppression event frequency, which cannot exceed the cap.

---

## 7. Known sampling bias / limitations

1. **Combined counterfactual only.** The shadow removes the *entire* structure stack at once (multiplier + confluence vote + hard-block). It is **not** proof that any single layer caused a divergence — the diagnostic flags only *associate* a divergence with a layer, and `directHardBlockOnly` is true only when the suppression is deterministically explained by hard-blocks with no multiplier/vote divergence anywhere.
2. **Rolling-window admission bias** toward earlier events under high volume (see §5).
3. **Shadow confidence vs. confirmation factor** (see §0): shadow *directions* are exact; shadow *confidence* omits the production confirmation-candle ×0.85 score factor (direction-neutral).
4. **AI boundary:** rows where production AI changed the final direction are flagged `AI_AFFECTED` and excluded from isolated-observation admission, so the resolved shadow sample is confined to rows where AI did not alter the production decision.
5. **Circuit-breaker note:** the per-pair circuit breaker is disabled at base (`isTripped` always returns false). The audit's `productionFinalDirection` is the engine-level (pre-CB) decision; should CB be re-enabled, CB-shadowed rows would still not be admitted because admission requires the engine pre-AI direction to be `NO_TRADE` as well.

---

## 8. Rollback steps

R7.1 is fully additive and fail-open, so rollback is low-risk. In order of severity:

1. **Disable isolated observation admission only** — in `src/handlers/signal.js`, remove the `ctx.waitUntil(maybeAdmitShadowObservation(...))` block. Audit capture/persistence continue; no new shadow observations.
2. **Disable shadow resolution** — in `src/index.js`, remove the `ctx.waitUntil(resolveShadowObservations(env))` line. Existing `shadow:` keys expire by TTL (≤30 d).
3. **Disable audit capture entirely** — revert `src/signal/engine.js` and `src/signal/timeframe.js` to `71e87eb` (`git checkout 71e87eb -- src/signal/engine.js src/signal/timeframe.js`). Because the engine refactor is behavior-equivalent, the production output is identical before and after.
4. **Full revert** — `git revert HEAD` (or `git reset --hard 71e87eb`). The `shadow:` KV keys are inert and expire; no production data is affected because they are namespaced and never read by any production path.

`R7_1_FULL_DIFF.patch` (in repo root) is the complete unified diff from `71e87eb`.

---

## 9. Test results (raw output in `verify/`)

| Suite | Result |
|---|---|
| `node --check` (all changed + new source) | **OK** (13/13) — `verify/r71_node_check.txt` |
| `git diff --check 71e87eb` | **clean** (no whitespace errors) — `verify/r71_node_check.txt` |
| `node scripts/r71_tests.mjs` (15 mandatory + §E) | **PASS: 94 FAIL: 0** — `verify/r71_test_output.txt` |
| `node scripts/r71_smoke.mjs` | **SMOKE DONE** (audit attached, no JSON leak) — `verify/r71_test_output.txt` |
| `node scripts/phase7_smoke.mjs` (existing) | **PASS: 68 FAIL: 0** — `verify/r71_smoke_output.txt` |
| `node scripts/phase10_smoke.mjs` (existing) | **PASS: 61 FAIL: 0** — `verify/r71_smoke_output.txt` |

### Mandatory-test → assertion map
1. Baseline production equivalence — [#1a] engine byte-equal ×5 fixtures, [#1b] history record additive-only.
2. Neutral structure — [#2] `UNCHANGED`, prod==shadow, no hard-block.
3. Multiplier-only — [#3] `productionScore.up = preStruct × mult`, `shadowCoreScore.up = preStruct`, multiplier flags.
4. Confluence-marginal — [#4] `categoryVoteApplied`, vote-only divergence.
5. Hard-block — [#5] pre-hard-block BUY → prod `NO_TRADE`, shadow BUY, `hardBlockChangedDirection`.
6. Redirect — [#6] both trade, `STRUCTURE_REDIRECTED`.
7. Attribution precision — [#7a] SUPPRESSED **not** hard-block-only; [#7b] contrast direct-hard-block-only.
8. AI boundary — [#8] `AI_AFFECTED`, not eligible for admission; pure 4-way classifier.
9. Public isolation — [#9a–e] signal/wrapper/latest-cache/bot/history all leak-free.
10. Internal persistence — [#10a] bounded audit saved; [#10b] history strips it.
11. Shadow isolation — [#11a–f] store/resolver touch only `shadow:*`; normal history/stats/CB/push untouched.
12. Resolver idempotency — [#12a–c] terminal UNKNOWN, pending deleted, re-resolve stable.
13. Fail-open — [#13a/b] throwing KV never breaks admission or the live signal.
14. OTC regression — [#14a–c] byte-equal vs baseline, no audit, lean record.
15. Existing smoke + syntax + `git diff --check` — [#15a–e] (incl. real `BULLISH_CHOCH` + freshness names).

---

## 10. Acceptance-criteria self-check

- **Public production contract & decisions unchanged** — [#1], [#14]; production engine output byte-equal to `71e87eb`; thresholds/multiplier/grade/confidence/cron/API contracts untouched.
- **Shadow data cannot contaminate production stats/CB/push/API** — [#9], [#10], [#11]; `shadow:` namespace only; `structureAudit` stripped from `/api/history`; Symbols invisible to JSON.
- **Freshness & attribution labels semantically honest** — §4, [#7], [#15e]; honest field names; `directHardBlockOnly` only when deterministically demonstrated.
- **AI boundary consistent** — §3, [#8]; shadow never calls AI; `AI_AFFECTED` flagged; admission requires both prod directions `NO_TRADE`.
- **KV usage bounded & correctly calculated** — §5, §6, [#§E]; 30/pair/30-day cap, 2-h pending TTL, dedup, idempotent capped resolver, fail-open; worst-case & expected write estimates stated.

# R7.1 Report-7 — Correction Report

**Base candidate corrected:** `f40371a605f8487f5ee4b7fb7f8d134b0488f320`
**Resulting commit:** reported in the delivery summary (`git rev-parse HEAD`)
**Work type:** minimal correction + tests only. **No deployment. No production
behavior change. No strategy tuning.**

This report documents ONLY the Report-7 required corrections. The original R7.1
design intent (private, deterministic, structure-excluded shadow; isolated KV
store; AI boundary; public isolation) is unchanged.

---

## Verification of the incoming correction prompt (independent check)

Per project protocol, the correction prompt was treated as material to verify,
not truth. My independent conclusion: **all three findings are correct** — no
reply-with-errors was needed; the corrections were implemented.

- **Finding A — correct.** The confirmation-candle ×0.85 penalty is a
  *non-structure* deterministic filter applied in production *after* per-TF
  direction selection. The R7.1 objective keeps all non-structure filters, so the
  shadow must include it. The previous omission was a real defect (my own Report-7
  export already admitted it could affect engine-level results).
- **Finding B — correct.** `directHardBlockOnly` used a *direction*-divergence
  proxy, but a structure multiplier can change score *magnitude* → engine
  confidence → floor outcome without changing any TF direction. A combined
  counterfactual cannot isolate the hard-block, so the causal flag was removed.
- **Finding C — correct.** `git diff --check 71e87eb` failed only because the
  committed `R7_1_FULL_DIFF.patch` artifact contains unified-diff blank-context
  lines (rendered as a single space) that Git flags. Source was already clean.

---

## Finding A — faithful shadow confirmation-candle penalty

### Change
`src/signal/timeframe.js` now computes, for each TF (right after the production
confirmation check):

- `shadowCoreDirection` = `decideTfDirection(preStructUp, preStructDown,
  preStructUpCat, preStructDownCat, minScore)` — decided on the **pre-structure /
  pre-confirmation** score, exactly mirroring production (direction first, penalty
  after).
- `shadowCandleConfirmed` / `shadowConfirmationPenaltyApplied` — the **same**
  confirmation rule (`!lastBullish && bodyRatio>0.5` for BUY; `lastBullish &&
  bodyRatio>0.5` for SELL), evaluated relative to `shadowCoreDirection`.
- `shadowEngineScoreUp/Down` = pre-structure score × (0.85 if the penalty fires on
  that side, else 1.0). The penalty is applied to the **shadow engine score only**;
  `shadowCoreDirection` is never re-decided.

`src/signal/r71shadow.js`:
- `buildTimeframeAudit` now reads `shadowCoreDirection` from the raw (single
  source) and reports `shadowCoreScore` (pre-confirmation), `shadowEngineScore`
  (post-confirmation), `shadowCandleConfirmed`, `shadowConfirmationPenaltyApplied`.
- `computeEngineAudit` feeds `shadowEngineScore` (not the pre-confirmation score)
  into the shadow weighted vote.
- `sanitizeAuditForHistory` persists the new bounded fields.

### Result
The shadow now removes **only** the three structure interventions. The
confidence-floor edge case previously demonstrated (BUY@74 → faithful NO_TRADE@70)
now produces the **faithful** result end-to-end. Per-TF shadow directions are
unchanged by the penalty (it is post-decision). No full candle arrays are
persisted.

---

## Finding B — remove false `directHardBlockOnly` claim

### Change
`src/signal/r71shadow.js`: the `directHardBlockOnly` boolean was removed from the
engine diagnostic (and therefore from the persisted audit, since
`sanitizeAuditForHistory` forwards the diagnostic object). Only honest
observational fields remain:

- `tfHardBlockObserved`, `hardBlockFlippedAny`,
  `multiplierOrVoteDivergenceObserved`, `prodTradeTfs`, `shadowTradeTfs`, plus
  per-TF `hardBlocked` / `hardBlockChangedDirection` / score / confluence fields.

A `STRUCTURE_SUPPRESSED` row may be described only as "STRUCTURE_SUPPRESSED with
hard-block observed" — never "suppressed purely/only by layer 3". A genuine
hard-block-only conclusion would require a separate isolated layer-3 shadow
variant (out of R7.1 scope); no guessed heuristic replaces the removed flag.

`R7_1_IMPLEMENTATION_REPORT.md` carries a correction banner superseding the old
`directHardBlockOnly` claims.

---

## Finding C — repository hygiene

### Change
`git rm R7_1_FULL_DIFF.patch` — the generated review-diff artifact (redundant with
`git diff`, no repo convention requires it) was removed from the commit. This was
the sole cause of `git diff --check 71e87eb` failing. The delivery report
(`R7_1_IMPLEMENTATION_REPORT.md`), this correction report, and the captured
`verify/*.txt` outputs are retained (repo convention commits `PHASE_*.md` reports
and `verify/*.txt`).

### Verification
`git diff --check 71e87eb` now exits **0** (raw output in §Validation).

---

## Safety constraints (all held)

- No deploy / no `wrangler deploy`.
- No change to production standard direction, score, confidence, grade,
  thresholds, AI calls, cron, endpoint contract, history, stats, circuit breaker,
  push, or OTC behavior (verified by 100-fixture fuzz, 0 mismatches).
- Shadow remains deterministic pre-AI (the confirmation penalty is deterministic;
  no AI is invoked).
- Shadow store remains isolated under `shadow:*` (no normal `sig:`/`pending:`/
  `stats:`/CB/pair-stats/push paths touched).
- Production remains safe if audit/shadow storage fails (fail-open retained).

---

## Validation (full raw output provided separately)

- `node scripts/r71_tests.mjs` — **PASS: 116 / FAIL: 0** (15 original + §E +
  new [#16] confirmation-penalty tests + [#17] 100-fixture fuzz).
- `node scripts/r71_smoke.mjs` — SMOKE DONE (audit attached, no JSON leak).
- `node scripts/phase7_smoke.mjs` — 68/0 · `node scripts/phase10_smoke.mjs` — 61/0.
- `node scripts/phase7_integration.mjs` — 36/0 · `node scripts/phase10_integration.mjs` — 19/0.
- `find src scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | sort -z | xargs -0 -n1 node --check` — all OK.
- `git diff --check 71e87eb` — exit 0 (clean).
- 100-fixture production-equivalence fuzz vs archived base `71e87eb`: **100
  compared, 0 mismatches**.

# FRVP Sentiment-Regime Confluence Filter — Report (Task 26)

**VERDICT: FAIL ×3 — the frozen regime filter did NOT improve net expectancy;
it slightly WORSENED it in all three exit variants while removing 35.6% of
the sample.** The unconditional baseline was recomputed from the same audit
log first and matches the published FRVP numbers exactly (consistency check:
max |Δ| 0.0005R). No parameter was changed after seeing any number; the
filter is not iterated, re-thresholded, or re-mapped (pre-reg §7/§8).

> **বাংলা সারমর্ম:** FRVP fade-এ একটা daily sentiment regime filter যোগ করা
> হলো (Fear & Greed: ≥60 = risk-on, ≤40 = risk-off, মাঝে neutral)। নিয়ম ছিল
> ফ্রোজেন: risk-off দিনে CALL fade নিষেধ, risk-on দিনে PUT fade নিষেধ।
> ফলাফল: ৩৬৬ দিনের মধ্যে ২২৭ দিন risk-on ছিল — ফিল্টার ৩৭,৭০৮ trade-এর
> মধ্যে ১৩,৪৩৩টা (৩৫.৬%, মূলত PUT) বাদ দিল। কিন্তু বাদ পড়া trade-গুলোর gross
> edge রাখা trade-গুলোর চেয়ে খারাপ ছিল না — আর খরচ ছিল গড়ের নিচে। তাই net
> expectancy আরও খারাপ হলো (যেমন 1.5R: −3.695R → −3.847R)। তিনটা TP variant-ই
> **FAIL**। অর্থাৎ: "greed-এর বিরুদ্ধে fade করলে ক্ষতি" — এই উইন্ডোতে সত্য
> নয়; সেই fade-গুলোই প্রায় সমান ভালো ছিল, বরং ভয়ের দিনের CALL fade-গুলোর
> gross সবচেয়ে ভালো ছিল (কিন্তু stop এত ছোট যে খরচ −5.2R)।

---

## 1. Frozen design (committed before any number existed)

Pre-registration: `prereg/PREREG_FRVP_REGIME_FILTER.md` (commit `00f3027`,
frozen 2026-09-13 03:54Z, before the F&G fetch, before any computation).

| Item | Frozen value |
|---|---|
| Regime source | Crypto Fear & Greed Index (alternative.me), daily |
| Publication pinning | value stamped D knowable from **D+1 00:00 UTC** (one full day conservative) |
| States | risk-on ≥ 60 · risk-off ≤ 40 · neutral 41–59 |
| Mapping | CALL fade blocked iff risk-off · PUT fade blocked iff risk-on · neutral blocks nothing |
| Lookup instant | trigger candle open + 60s (the engine's own decision instant) |
| Data | `results/FRVP_audit.jsonl.gz` TRD rows (37,708), window 2023-07-05 → 2024-07-05 (same as the original FRVP run; window-reuse legitimacy + post-hoc ≡ engine-gating equivalence argued in pre-reg §2) |
| Costs | identical to original: net R = gross R − (2×perSide)/rf; base 0.10%/side; sensitivities 0.05/0.20 |
| Statistics | Wilson 95% (WR on TP/SL-resolved), normal + bootstrap 95% (expectancy; 10,000 resamples, seed 20260913); TIMEOUT keeps realized R (original convention) |
| Gate | n ≥ 30 AND **net** expectancy bootstrap CI-LO > 0 (original gate, unchanged) |

Design-time disclosures: macro (FRED) inputs were excluded from the regime
— fed funds is quasi-constant across this window and admits no defensible
frozen mapping to daily crypto fades (pre-reg §3). The 25/75 extreme-threshold
variant was considered and rejected pre-run (would gate <5% of days).

## 2. Regime reach — the filter's theoretical footprint (before trade numbers)

Of the 366 window days (regime at each day's midday under the frozen
pinning): **risk-on 227 (62.0%) · neutral 117 (32.0%) · risk-off 22 (6.0%)**.
A greed-dominated year: the mapping was always going to bite PUT fades far
more than CALL fades. It did: of 13,433 removed trades, 12,349 were PUT and
only 1,084 were CALL.

## 3. Baseline consistency check (mandated by pre-reg §5)

Unconditional expectancy recomputed from the audit log vs published:

| Variant | gross recomputed | gross published | net recomputed | net published | match |
|---|---|---|---|---|---|
| TP=1.5R | +0.0540 | +0.054 | −3.6953 | −3.695 | ✅ |
| TP=3R | +0.1245 | +0.125 | −3.6247 | −3.625 | ✅ |
| TP=POC | +0.2370 | +0.237 | −3.5122 | −3.512 | ✅ |

## 4. Headline — unconditional vs filtered, side by side

n = 37,708 → kept 24,275 (64.4%) / removed 13,433 (35.6%).

| Metric | TP=1.5R uncond | TP=1.5R kept | TP=3R uncond | TP=3R kept | TP=POC uncond | TP=POC kept |
|---|---|---|---|---|---|---|
| n | 37,708 | 24,275 | 37,708 | 24,275 | 37,708 | 24,275 |
| WR (W/(W+L)) | 42.13% [41.63, 42.63] | 42.20% [41.58, 42.83] | 27.78% [27.33, 28.24] | 27.71% [27.14, 28.28] | 13.39% [13.04, 13.75] | 13.51% [13.07, 13.96] |
| **Gross expectancy (R)** | **+0.054** [+0.042, +0.066] | **+0.056** [+0.040, +0.071] | **+0.125** [+0.106, +0.142] | **+0.125** [+0.102, +0.146] | **+0.237** [+0.195, +0.279] | **+0.247** [+0.197, +0.300] |
| **Net expectancy @0.10%/side (R)** | **−3.695** [−3.960, −3.530] | **−3.847** [−4.241, −3.610] | **−3.625** [−3.888, −3.459] | **−3.779** [−4.174, −3.542] | **−3.512** [−3.777, −3.340] | **−3.656** [−4.055, −3.412] |
| Mean cost per trade (R) | 3.749 | 3.903 | 3.749 | 3.904 | 3.749 | 3.903 |
| Frozen gate (net CI-LO > 0) | FAIL | **FAIL** | FAIL | **FAIL** | FAIL | **FAIL** |

**The one-line read:** gross expectancy is statistically indistinguishable
between kept and removed subsets — the daily sentiment regime carries
essentially NO information about where the fade edge lives — so the filter's
only real effect is shrinking the sample while (as luck of the cost mix has
it) removing slightly-cheaper-than-average trades, which makes the kept
set's net expectancy marginally WORSE.

## 5. What was removed — and what it would have contributed (honesty accounting)

Removed subset (n = 13,433) — reported for transparency, NOT as a rescue path:

| Subset | n | gross exp 1.5R / 3R / POC (R) | net exp 1.5R / 3R / POC (R) | mean cost (R) |
|---|---|---|---|---|
| removed PUT (greed-day) | 12,349 | +0.046 / +0.121 / +0.195 | −3.262 / −3.188 / −3.114 | 3.31 |
| removed CALL (fear-day) | 1,084 | **+0.093** / **+0.165** / **+0.489** | −5.232 / −5.159 / −4.835 | 5.32 |
| all removed | 13,433 | +0.050 / +0.124 / +0.218 | −3.421 / −3.347 / −3.253 | 3.47 |
| all kept | 24,275 | +0.056 / +0.125 / +0.247 | −3.847 / −3.779 / −3.656 | 3.90 |

Directional detail (kept subset, gross 1.5R with bootstrap CI): PUT +0.077
[+0.046, +0.109] (n=6,054) vs CALL +0.049 [+0.032, +0.067] (n=18,221) —
on gross, neutral-day PUT fades actually drifted MORE than greed-day PUT
fades (the filter's premise was right for PUT), but fear-day CALL fades —
the removed ones — were the STRONGEST gross cell in the entire dataset
(+0.093 at 1.5R, +0.489 at POC), refuting the CALL half of the premise
outright. And even that best cell is net −4.8…−5.2R: fear-day fades trigger
on micro-stops (tiny rf), the exact cost swamp that killed the original
FRVP verdict, now concentrated.

Removals by pair (symmetric, no pair specialization): BTC 3,129 · ETH
3,106 · XRP 3,583 · SOL 3,615. Removals by month track the greed phases
(low of 129 in Jul-2023, peaks 1,987 in Mar-2024, 1,762 in Feb-2024) —
i.e., the filter removed the most volume exactly in the months the market
was most one-way bullish.

## 6. Per-pair × direction kept buckets (min-30 rule)

Every kept bucket clears 30 (smallest: ETH/USD PUT n=1,291) — no
INSUFFICIENT flags. Kept gross expectancy per pair×direction (1.5R) ranges
from +0.029 (SOL PUT) to +0.122 (ETH PUT); the kept PUT cells out-gross the
kept CALL cells on three of four pairs (SOL is the exception: PUT +0.029 vs
CALL +0.053) — broadly consistent with §5's directional detail.
No cell is net-positive (kept per-cell net ≈ −2.9R to −4.9R across
variants).

## 7. Verdict

1. **Frozen gate verdict: FAIL on all three variants, filtered and
   unfiltered.** The filter moves net expectancy from −3.695/−3.625/−3.512R
   to −3.847/−3.779/−3.656R. There is no cost scenario in the frozen
   sensitivity grid (0.05/0.20%/side) under which any variant approaches
   CI-LO > 0.
2. **The hypothesis is refuted on this window, in both halves:** blocking
   greed-day PUT fades removed trades that were gross-equivalent to the ones
   kept; blocking fear-day CALL fades removed the strongest gross cell in
   the dataset. The sentiment regime (F&G, daily) simply does not segment
   this fade edge.
3. **The tradeoff the task asked to be reported plainly:** 35.6% of the
   volume was removed for a change in net expectancy of −0.15R (1.5R), i.e.
   the filter cost a third of the sample to make the average trade slightly
   WORSE. The project's fifth filter-style test (T1/T2/T3 precedent) with
   the same conclusion shape: coarse exogenous regimes do not locate the
   (tiny) edges this market offers.
4. The original FRVP verdict (FAIL net of costs) is untouched by this
   extension; nothing merges, nothing deploys, and the gross-positive
   finding remains a microstructure curiosity that costs make untradeable —
   now tested once more from a second angle and still untradeable.

## 8. Reproducibility

- Analyzer: `backtest/frvp_regime_filter.mjs` (single deterministic pass;
  embedded self-checks: TRD count = 37,708, F&G sha256 pin-boundary check,
  pinning boundary unit check at consecutive-day value changes).
- F&G raw: `backtest/data/external/fng_full.json` (3,143 daily rows,
  2018-02-01 → 2026-09-13 value stamps), sha256
  `e7dc592f7d97…a6232a41f` pinned in committed `results/PROVENANCE_FNG.md`
  (fetch timestamp 2026-09-13T04:12:15Z).
- Full machine-readable output: `results/FRVP_REGIME_FILTER_summary.json`
  (headline triplets, per-direction/per-pair/per-month removals, kept-bucket
  flags, consistency table).
- Pre-registration: `prereg/PREREG_FRVP_REGIME_FILTER.md` — commit `00f3027`
  demonstrably precedes the F&G fetch (`effa253`→`67011ec`) and the analyzer
  commit; commit history is the audit trail.
- Branch: `feature/frvp-regime-filter` (base `origin/feature/frvp-rr`
  `93a9787`); `main` and the original branches untouched.

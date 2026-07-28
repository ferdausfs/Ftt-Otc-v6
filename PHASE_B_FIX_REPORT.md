# Ftt-Otc-v6 — Phase B (FIX) Report

> এই round-এ কোনো win-rate improvement claim করা হচ্ছে না। Phase A2-এর সৎ baseline (dedup-clean n=92) = 42.4% WR। CB 6h backtest projects ≈46.5% WR (n≈43, ছোট sample) — **mechanism-only gain, engine-quality gain না**। এই phase-এর আসল target: (ক) result-resolution UNKNOWN 56%→<15%, (খ) per-pair loss streak ≤3, (গ) ৪টে diagnostic field (structureVerdict, aiStatus, coreConfidence, entrySource) persist যাতে ২-৪ সপ্তাহ clean data জমার পর slice-by-slice WR মাপা যায়। "75%+ accuracy" এই dataset/engine দিয়ে reachable না — সেটা পরের কোনো phase-এ, quality-filtered smaller-frequency approach দিয়ে explore হবে।

**Base commit:** `93f2de5` (= `9fc5aef` + docs-only)
**Mode:** FIX — code change + backtest + ZIP. **কোনো deploy হয়নি**, `git push`/`wrangler deploy`/workflow trigger কিছুই চালানো হয়নি (§7.2 verified)।
**Files changed:** ৯টা modified + ২টা new = ১১টা। `src/` diff: **478 insertions, 64 deletions**।
**Verification:** node --check 31/31 pass · smoke 93/93 assertions pass · backtest reproduction 7/7 checks pass।

---

## 1. Change list (file × line ranges)

| File | Lines (new) | Item | কী হলো |
|---|---|---|---|
| `src/config.js` | 9-10 | B0-6 | `MAX_RETRIES: 3` — reserved-comment যোগ, fetch path আর ব্যবহার করে না |
| `src/config.js` | 20-22 | B0-4 | `CACHE_TTL['1min']` 60 → **120** |
| `src/config.js` | 95-98 | B0-3 | নতুন `HISTORY_CONFIG.PENDING_TTL_MS` (2h) + `PENDING_MAX_CHECKS` (15) |
| `src/fetch/keys.js` | 1-85 | B0-6 | **full rewrite** — numbered-scan (কোনো upper cap নেই), dedupe, `getNextRotationIndex`, `readRotationIndex` |
| `src/fetch/candles.js` | 1-3 | B0-4/6 | imports: `getNextRotationIndex`, `incrementQuota` |
| `src/fetch/candles.js` | 36-44 | B0-6 | `maxAttempts = apiKeys.length` (cap সরানো) + KV round-robin `startIdx` |
| `src/fetch/candles.js` | 53 | B0-4 | HTTP-এর ঠিক আগে `await incrementQuota(env)` |
| `src/fetch/candles.js` | 60-86 | B0-5 | non-ok / td-error / empty / exception — সবগুলোতে `console.warn` + `body[:200]` + `keyIdx` |
| `src/history/quota.js` | 1-31 | B0-4 | **new** — `incrementQuota` / `readQuota`, key `quota:<YYYY-MM-DD UTC>`, 3d TTL |
| `src/history/circuitBreaker.js` | 1-63 | B2 | **new** — `getCBState` / `isTripped` / `applyResult`, `cb:<PAIR>` state, 2-loss → **6h fixed** cooldown, WIN resets, UNKNOWN ignored |
| `src/history/stats.js` | 1-6 | — | imports: rotation, quota, `cbApplyResult` |
| `src/history/stats.js` | 39-59 | B5 | নতুন `derivedAiStatus()` helper (forex combined vs OTC shape) |
| `src/history/stats.js` | 61, 88-101 | B5 | `saveSignalToHistory(..., entrySource)` + record-এ ৪ field + conditional `cbShadow` |
| `src/history/stats.js` | 136 | B0-3 | pending TTL এখন `HISTORY_CONFIG.PENDING_TTL_MS` থেকে derive |
| `src/history/stats.js` | 171-217 | B0-3 | retry-cap: fail-এ delete **না**, `checks` counter, ≥15-এ UNKNOWN; outer catch আর delete করে না |
| `src/history/stats.js` | 215 | §3.3 | `if (!record.cbShadow) await updatePairStats(...)` |
| `src/history/stats.js` | 227-321 | B0-1/2/5/6 | `fetchExpiryPrice` rewrite — ±5min bracket, key rotation, `{price}` / `{error,status,body}` |
| `src/history/stats.js` | 392-396 | B2 | funnel hook — `updatePairStats` end-এ `cbApplyResult(pair, winLoss, env)` |
| `src/handlers/signal.js` | 9 | B2 | import `isTripped` |
| `src/handlers/signal.js` | 20-29 | §3.2 | `classifyEntrySource(cacheHits)` — 0/1-2/3 → FRESH_API / CACHE_PARTIAL / CACHE_ALL |
| `src/handlers/signal.js` | 89-124 | B2/§3.3 | forex-crypto CB check site + shadow save + response `circuitBreaker` block |
| `src/handlers/signal.js` | 166-201 | B2/§3.3 | OTC CB check site (same contract) |
| `src/handlers/signal.js` | 136, 217 | B5 | `saveSignalToHistory(..., entrySource)` দুই path-এ |
| `src/handlers/health.js` | 5-7, 10, 17-27 | B0-4/6 | `handleHealth` async, `quotaUsedToday` / `apiKeysLoaded` / `rotationIdx` |
| `src/index.js` | 37 | — | `await handleHealth(env)` (async হওয়ায় দরকার) |
| `src/signal/engine.js` | 379-382 | B5 | return-এ `coreConfidence: rawConfidence` (line 164-এর pre-filter anchor) |
| `src/signal/otcEngine.js` | 132-135, 224 | B5 | নতুন `rawConfidence` anchor (weighted vote-এর ঠিক পরে, MIXED-zeroing/alignment-bonus/সব penalty-র আগে) + return-এ `coreConfidence` |

**`handleBatch` আলাদা করে ছোঁয়া হয়নি** — সে `handleSignalRaw`-ই ডাকে, তাই CB automatically covered (§4.5 অনুযায়ী)।

---

## 2. Backtest results

Input: `analysis/pooled_dedup.json` — live `/api/history` থেকে ৭ pair pull (251 raw rows), production-এর dedup rule (30min window, 0.05% rel / 0.0001 abs entry tolerance, depth-5) apply করে **n=214 raw / n=92 decided**। Phase A2-এর সংখ্যার সাথে exact match।

### Primary — result clock (production semantics)

CB state আপডেট হয় যখন result আসলে resolvable (`expiryTime + 90s`), signal emit-এর সময় না।

| Config | n decided | WR | ΔWR | volume kept | pair-max streak | cross-pair streak | shadow n | shadow WR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline (no CB) | 92 | 42.4% | — | 100% | 6 | 11 | 0 | — |
| CB 2h | 64 | 40.6% | −1.8pp | 69.6% | 5 | 10 | 28 | 46.4% |
| **CB 6h (shipped)** | 56 | 41.1% | −1.3pp | 60.9% | 5 | 8 | 36 | 44.4% |
| CB 12h | 56 | 41.1% | −1.3pp | 60.9% | 5 | 8 | 36 | 44.4% |
| CB 24h | 41 | 36.6% | −5.8pp | 44.6% | 4 | 8 | 51 | 47.1% |

### Secondary — signal clock (Phase A2 semantics, reproduction gate)

| Config | n decided | WR | pair-max streak | cross-pair streak | shadow n | shadow WR |
|---|---:|---:|---:|---:|---:|---:|
| Baseline (no CB) | 92 | 42.4% | 6 | 11 | 0 | — |
| CB 2h | 49 | 42.9% | 4 | 7 | 43 | 41.9% |
| **CB 6h** | 43 | **46.5%** | **3** | 7 | 49 | 38.8% |
| CB 12h | 43 | 46.5% | 3 | 7 | 49 | 38.8% |
| CB 24h | 30 | 33.3% | 3 | 7 | 62 | 46.8% |

### Reproduction checks (±3pp tolerance)

| Check | Expected | Actual | Result |
|---|---:|---:|:--:|
| baseline WR | 42.4% | 42.4% | PASS |
| baseline n | 92 | 92 | PASS |
| baseline cross-pair loss streak | 11 | 11 | PASS |
| CB 6h [signal clock] WR | 46.5% | 46.5% | PASS |
| CB 6h [signal clock] pair-max streak | 3 | 3 | PASS |
| CB 6h [signal clock] n | ~43 | 43 | PASS |
| CB 2h / 12h / 24h shape | A2 table | matches | PASS |

A2-এর পাঁচটা target সংখ্যাই hubohu মিলেছে (2h→49/42.9%, 6h→43/46.5%, 12h→43/46.5%, 24h→30/33.3%)।

### ⚠ Material deviation — reported, not hidden

**A2-এর "11" per-pair না, cross-pair streak।** Pooled timeline-এ 11 (ETH→BNB→BTC→ETH→BNB→BTC→BNB→BNB→BTC→ETH→BNB); worst *per-pair* baseline streak আসলে **6** (BNB/USD)। Prompt §5-এর table-এ "pair-max streak 11" লেখা ছিল — সেটা metric mislabel। দুইটাই এখন আলাদা করে report করা হচ্ছে।

**দ্বিতীয় deviation, এটা বড়:** clock semantics বদলালে CB 6h-এর WR gain **উবে যায়**।

| Clock | CB 6h WR | n | pair-max streak | cross-pair streak |
|---|---:|---:|---:|---:|
| signal (A2 যেভাবে মেপেছে) | 46.5% | 43 | 3 | 7 |
| result (production যেভাবে চলবে) | **41.1%** | 56 | 5 | 8 |

**−5.4pp, tolerance-এর বাইরে।** কারণ: signal clock ধরে নেয় LOSS জানা যায় সাথে সাথে, তাই cooldown আগে arm হয়। বাস্তবে expiry+90s লাগে, এবং cron `*/2` — মাঝের window-এ পরের signal already emit হয়ে যায়। অর্থাৎ **production CB signal-clock backtest-এর চেয়ে কম aggressive**, এবং shipped mechanism-এর projected WR ≈41%, 46.5% না।

> শিপ করা হলো তবু, কারণ এই phase-এর justification WR না — **streak containment** (cross-pair 11→8, ETH 4→3, BNB 6→5) আর shadow-row instrumentation। WR verdict আসবে B0-clean data জমার পর।

**তৃতীয় observation:** shadow WR (44.4%) emitted WR (41.1%)-এর **উপরে** result clock-এ। ছোট sample (n=36), কিন্তু signal-টা হলো — CB এই dataset-এ ভালো trade-ও block করছে। ঠিক এই কারণেই §3.3 shadow rows এই round-এই দরকার ছিল; ২-৪ সপ্তাহে live shadow data দিয়ে "CB রাখব না তুলব" সিদ্ধান্ত নেওয়া যাবে।

Full numbers: `analysis/phase_b_backtest_output.md` + `.json`।

---

## 3. Verification results (§7)

### §7.1 `node --check` — PASS
১১টা changed/new file + পুরো `src/` sweep: **31 files checked, 0 failures**। (`verify/node_check.txt`)

### §7.2–7.7 grep bans — সব clean (`verify/grep_bans.txt`)

| Check | Result |
|---|---|
| §7.2 `wrangler deploy` / `git push` in `src/ analysis/ verify/` | **0 hits** |
| §7.3 `75%` / `guarantee` / `will achieve` in `src/` | **0 hits** |
| §7.3 same grep on this report | 2 hits, both benign — §9-এর mandated paragraph (যেখানে "75%+ reachable **না**" লেখা) আর এই check-এর নিজের নাম। Disclosed, suppress করা হয়নি। |
| §7.4 `apiKeys[0]` | **0 hits** |
| §7.5 `Math.min(apiKeys` | **0 hits** (MAX_RETRIES শুধু config declaration + comment) |
| §7.6 `i <= 10` in `keys.js` | **0 hits** |
| §7.7 circuit/cooldown/streak | নতুন CB hits আছে; `blocklist`/`blacklist`/`killswitch` — **0 hits** |

`.github/workflows/deploy.yml` pre-existing file, এই round-এ ছোঁয়া হয়নি, trigger হয়নি।

### §7.10 Smoke — **93/93 assertions pass** (`verify/smoke_output.txt`)

**`analysis/phase_b_smoke.js`** — 48 pass. §4.4f-এর সাতটাই:

| § | Assertion | Result |
|---|---|---|
| 4.4f-1 | numbered `_1`.._19` → length **19** exact, order preserved | PASS |
| 4.4f-2 | JSON array 19 items → length 19 | PASS |
| 4.4f-3 | gaps `_1,_2,_5,_19` → length 4, numeric (না lexicographic) order | PASS |
| 4.4f-4 | duplicate value `_1`==`_5` → deduped, length 1 | PASS |
| 4.4f-5 | 100 rotations over 5 keys → প্রতিটা 15-25 range | PASS (20/20/20/20/20) |
| 4.4f-6 | 19 keys, প্রথম 18টা 429, 19তম ok → success, **19 attempts** | PASS (cap সত্যিই নেই) |
| 4.4f-7 | 5 keys, always-ok fetch, 5 invocation → **exactly 5 HTTP calls**, 5টা distinct key | PASS (rotation ≠ multiplication) |

প্লাস CB flow (2 losses→cooldown, isTripped, WIN reset, UNKNOWN ignored, per-pair isolation, expired-cooldown auto-clear, OTC key normalisation) এবং quota counter।

**`analysis/phase_b_tracker_smoke.js`** — 27 pass, real `scheduledTracker` in-memory KV-তে:
- HTTP 500-এ pending record টেকে, `checks=1`, `lastCheckError='HTTP_500'`
- ঠিক **15তম** check-এ drop, result UNKNOWN, stats untouched
- bracket query-তে `start_date`+`end_date` আছে, `outputsize` **নেই**
- BUY 100→105 = WIN, exitPrice persist, stats.wins=1, pending cleared
- দুই LOSS → funnel hook `cb:XRP_USD` লিখেছে, cooldown armed
- shadow row: result পায় কিন্তু stats/CB **দুটোই untouched**
- B5 ৪ field persist, legacy field intact, OTC `aiStatus='OTC_DISAGREE'`

**`analysis/phase_b_handler_smoke.js`** — 21 pass, real `handleSignalRaw`:
- CB not tripped → response unchanged, `entrySource` valid enum, `coreConfidence` number
- CB tripped → `finalSignal='NO_TRADE'`, `circuitBreaker.{tripped,cbShadow,cooldownUntil,wouldBeSignal}`, history-তে shadow row (would-be direction সহ), stats+CB untouched
- OTC path-এও একই contract

### §7.8 Backtest self-check — 7/7 PASS (উপরে §2)

### §7.9 Diff — `diff/stat.txt` + `diff/full.patch` (825 lines, src/ only)

---

## 4. Known limitations

1. **CB 6h-এর WR gain production clock-এ reproduce হয় না** (46.5% → 41.1%)। §2 দেখুন। Streak containment ঠিকই আছে, WR gain না।
2. **Shadow WR > emitted WR** result clock-এ (44.4% vs 41.1%, n=36)। CB এই sample-এ net-negative selection করছে। ২-৪ সপ্তাহ live shadow data ছাড়া এটা noise না signal বলা যাবে না।
3. **Sample ছোট** — CB 6h emitted n=56 (result clock) / 43 (signal clock)। ±3pp tolerance-ও এখানে generous; 95% CI প্রায় ±13pp।
4. **Backtest CB check pre-emit simulate করে KV read ছাড়াই** — production-এ `isTripped` একটা extra KV read প্রতি signal-এ। Latency impact মাপা হয়নি (deploy হয়নি বলে)।
5. **`rr:idx` race** — দুইটা concurrent worker একই `startIdx` পেতে পারে। Design-এ accepted (comment-এ লেখা): worst case একবার duplicate, সামগ্রিক distribution তবু spread হয়।
6. **Quota counter read-modify-write** — একই race। Paid plan-এ write cost issue না, কিন্তু high-concurrency-তে count সামান্য under-report করতে পারে। Monotonic-ই থাকবে, শুধু floor।
7. **`fetchExpiryPrice` ±5min bracket** ধরে নেয় TwelveData ওই window-এ 1min candle রাখে। Forex weekend gap বা illiquid pair-এ `EMPTY_VALUES` আসতে পারে — এখন সেটা log হয় (B0-5), আগে silent ছিল।
8. **OTC `coreConfidence`** weighted-vote-এর ঠিক পরের value। OTC pipeline-এ "raw vs adjusted"-এর formal boundary ছিল না, তাই MIXED-zeroing-এর **আগের** value নেওয়া হয়েছে (`otcEngine.js:132-135`, comment সহ)। forex `rawConfidence` (engine.js:164)-এর সাথে semantically aligned, কিন্তু identical derivation না।
9. **`handleHealth` এখন async** — index.js-এ `await` যোগ হয়েছে। Response contract অপরিবর্তিত, শুধু ৩টা field additive।
10. **Pool-এ ৪টা pair নেই** (AVAX/LINK/DOT/DOGE) — তাদের KV history expire হয়ে গেছে (last activity 2026-05-02), যদিও `stats:` entry টিকে আছে। n=214 তাই ৭ pair-এর।

---

## 5. OPEN QUESTIONS

1. **CB clock mismatch — কোনটা canonical?** Backtest-এর 46.5% signal clock-এর, production result clock-এ চলবে (41.1%)। A2-এর number-টা optimistic ছিল। CB 6h রাখব, নাকি result-clock reality দেখে 2h-এ নামাব (volume 69.6% রাখে, cross-pair streak 10)? এই round-এ prompt-mandated **6h fixed** ship করা হয়েছে।
2. **Shadow WR > emitted WR** — CB যদি ৪ সপ্তাহ পরেও ভালো trade বেশি block করে, mechanism তুলে ফেলার trigger কী হবে? Threshold আগে থেকে ঠিক করা দরকার, নাহলে post-hoc rationalise হবে।
3. **EUR/USD asset-class failure** — pool-এ EUR/USD-এর ৫০টা row-এর **শূন্যটা** decided; সব UNKNOWN। Crypto pair-গুলো ঠিকঠাক resolve হচ্ছে। B0-1/B0-5 এর পর পরের data pull-এ `fetchExpiryPrice non-ok pair=EUR/USD ... body=` log-line দেখতে হবে — সন্দেহ: forex symbol-এ TwelveData plan-restriction বা bracket window-এ 1min candle missing। **B0-5 instrumentation ঠিক এই জন্যই**, কিন্তু diagnose করতে deploy + ২৪ঘন্টা log লাগবে।
4. **`quota:` counter-এর baseline অজানা** — ১৯ key × TwelveData free tier = দৈনিক কত? প্রথম ২৪ঘন্টার `quotaUsedToday` দেখে বোঝা যাবে headroom আছে কিনা। TTL 120 করার প্রকৃত সাশ্রয়ও তখনই মাপা যাবে।
5. **`PENDING_MAX_CHECKS=15` vs 2h TTL** — cron `*/2` মানে 15 checks = ৩০ মিনিট, TTL 2h-এর অনেক ভেতরে। TTL-টাই আগে শেষ হলে (record expiry-র অনেক পরে তৈরি হলে) fallback path UNKNOWN লিখে দেয় — implement করা আছে, কিন্তু cap-টা কার্যত ৩০ মিনিটের retry budget, ২ঘন্টার না। Intended কিনা confirm দরকার।

---

## 6. Out-of-scope (ছোঁয়া হয়নি, REVIEW §E অনুযায়ী)

- B1 XRP watchlist — blocklist mechanism code-এ নেই
- B3 5min block, B4 grade tune — observe-first
- `health.js:120-128` double-report hazard (`handleReport` manual result + cron দুইবার `updatePairStats` ডাকতে পারে) — pre-existing, unchanged
- tie→LOSS rule (`exitPrice == entryPrice` → LOSS) — pre-existing, unchanged
- deploy, `git push`, workflow trigger — **কিছুই না**

---

## 7. Deliverable

`phase_b_fix.zip` — §8 structure অনুযায়ী। Deploy করার আগে Claude-এর সাথে review করুন, বিশেষ করে §2-এর clock deviation আর §5-এর OPEN QUESTIONS।

Local reproduce:
```
node analysis/phase_b_smoke.js
node analysis/phase_b_tracker_smoke.js
node analysis/phase_b_handler_smoke.js
python3 analysis/phase_b_backtest.py
```

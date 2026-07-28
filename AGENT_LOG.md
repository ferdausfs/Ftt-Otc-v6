# Ftt-Otc-v6 — Agent Log

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

# Ftt-Otc-v6 — Phase 7 Report — Unified Cron-Driven Signal Cache

> এই round-এ backend architecture বদলে unified cron-driven cache introduce করা হচ্ছে। প্রতি ৫ মিনিটে cron 14টা supported pair scan করে `latest:<PAIR>` KV-তে cache করবে। নতুন endpoint `/api/signals/latest` cache read-only serve করবে। Existing `/api/signal` fresh-generation করবে যদি না `?preferCache=true` param থাকে (Force Refresh path)। App আর Bot দুটোই একই cache থেকে পড়বে — Phase 8 (App) আর Phase 9 (Bot)-এ shift হবে। এই phase-এ কোনো user-visible behavior change নেই backward compat maintained রাখা হয়েছে। Quota impact: cron ৫ মিনিটে ~14 fresh generations = ~1000-1500 credits/hour ceiling (17-key rotation দিয়ে easily sustainable), বনাম বর্তমান per-user unbounded pattern। কোনো WR guarantee দেওয়া হচ্ছে না — শুধু quota discipline + response latency improvement (~200ms cache-hit vs 5-8s fresh)।

**Base:** `d80e989` (Phase B merged) · **Deploy:** কিছুই না — no `wrangler deploy`, no `git push`
**Diff:** 10 files, **968 insertions / 4 deletions** (5 modified, 3 new, 2 test scripts)
**Verification:** `node --check` 34/34 · smoke **68/68** · integration **36/36** · engine diff **empty**

---

## 1. Live-verification: ৫টা spec assumption ভুল

Phase 5/6-এর মতোই code লেখার আগে সব যাচাই করেছি। এবার **তিনটে import spec-এ আছে যেগুলো repo-তে existই করে না** — copy-paste করলে worker boot-এই crash করত।

### 1.1 🔴 তিনটে import ভুল path/নাম

| Spec বলেছে | বাস্তবে |
|---|---|
| `getMarketStatus` from `utils/pairs.js` (§4.2) | **কোথাও নেই।** আসল check `isForexMarketOpen()` in `utils/session.js` |
| `generateSignalCore` from `signal/engine.js` (§4.2) | **নেই।** engine export করে `buildMultiTimeframeSignal` |
| `jsonResponse` from `utils/cors.js` (§4.3) | **নেই।** আছে `utils/helpers.js`-এ |

তিনটেই `import` statement — একটাও silent fail না, module resolution error। যাচাই করে সঠিকগুলো ব্যবহার করেছি।

### 1.2 🟢 Engine refactor লাগেনি — spec §5-এর আশঙ্কা অমূলক

§5 সতর্ক করেছিল generation "tangled inside request handler" হতে পারে, আর (a) extract বা (b) duplicate বেছে নিতে বলেছিল। **কোনোটাই লাগেনি।** Path ইতিমধ্যেই পরিষ্কার:

```
index.js → handleSignal(pair, env, ctx) → handleSignalRaw(pair, env, ctx) → {full response object}
```

`handleSignalRaw` already `(pair, env, ctx)` নেয় এবং ঠিক যে object cache করা দরকার সেটাই return করে। Scanner সেটাকেই call করে। **`git diff src/signal/engine.js src/signal/otcEngine.js` = খালি** (§7.5 verified) — এক engine, এক code path, শূন্য fork।

### 1.3 🔴 Spec-এর `scanOnePair` history **দুইবার** লিখত

§4.2-এর sketch-এ `scanOnePair` নিজে `saveSignalToHistory()` call করত। কিন্তু `handleSignalRaw` **আগে থেকেই** লেখে:

```js
signal.js:136  ctx.waitUntil(saveSignalToHistory(signal, pair, false, env, signalId, entrySource));
signal.js:217  ctx.waitUntil(saveSignalToHistory(signal, pair, true,  env, signalId, entrySource));
```

Sketch অনুসরণ করলে প্রতি scanned BUY/SELL-এ **দুটো record + দুটো `pending:` result-check** তৈরি হতো। 30-min dedup guard বেশিরভাগ ধরত, কিন্তু সব না — re-poll-এ `entryPrice` সামান্য বদলালে guard মিস করে (Phase A2-তে ঠিক এই duplicate inflation-ই WR নষ্ট করেছিল)।

**সিদ্ধান্ত:** scanner history লেখে **না**। শুধু KV cache লেখে; history existing path-এর দায়িত্বে। Integration test এটা প্রমাণ করে — এক scan-এর পর যেকোনো pair-এর history array ≤1 record।

### 1.4 🟡 Quota estimate বাস্তবের সাথে মেলে না

Spec বলেছে *"~1000-1500 credits/hour"*। Real pipeline চালিয়ে মাপা (network stubbed, counters instrumented):

```
per scan (14 pairs, cold candle cache) -> candles: 42   AI: 28   KV puts: 126
per hour (12 scans)                    -> candles: 504  AI: 336
immediate 2nd scan (warm c: cache)     -> candles: 0    AI: 28
```

**Candle খরচ 504/hour ceiling** — spec-এর 1000-1500 estimate ~2-3× বেশি ছিল, কারণ pair-প্রতি ৩টে timeframe (৪২ = 14×3), আর `c:` candle cache (1min TTL 120s) পরের scan-এ অনেকটা শোষণ করে। বাস্তব steady-state 504-এর **নিচে**।

**কিন্তু AI 336 calls/hour — এটাই আসল bottleneck**, §1.5 দেখুন।

### 1.5 🔴 AI **এই মুহূর্তে সম্পূর্ণ exhausted** — 429, দুই provider, persistent

Live curl (2026-07-29, ২০s ব্যবধানে ২ round, ৩ pair):

```
btcusd: cerebras API_ERROR 429 | groq API_ERROR 429 | combined BOTH_UNAVAILABLE
ethusd: cerebras API_ERROR 429 | groq API_ERROR 429 | combined BOTH_UNAVAILABLE
solusd: cerebras API_ERROR 429 | groq API_ERROR 429 | combined BOTH_UNAVAILABLE
```

আর AI **13/14 pair-এ trigger হয়** (শুধু GBP/USD skip করেছিল, কারণ direction NO_TRADE এবং rawConfidence<60)। মানে প্রতি scan-এ ~26-28 AI call, ঘণ্টায় ~336।

**এটা Phase 7-এর জন্য দুই দিকে কাটে:**
- **পক্ষে:** cache-ই একমাত্র সমাধান। এখন প্রতি user view AI call করে; scan করলে ঘণ্টায় fixed 336, user সংখ্যা যাই হোক। Unbounded → bounded।
- **বিপক্ষে:** 336/hour **এখনই** free-tier ছাড়িয়ে যাচ্ছে (তাই আজ 429)। Cache যদি AI-শূন্য signal দিয়ে ভরে, সেই `BOTH_UNAVAILABLE` signal ১০ মিনিট ধরে সবাইকে পরিবেশন হবে।

এই round-এ AI budget আমার scope-এর বাইরে (spec §9 "no engine logic modification"), কিন্তু **deploy করার আগে এটা মীমাংসা করা দরকার** — §5 OPEN QUESTIONS দেখুন।

---

## 2. যা বানানো হলো

| File | কী |
|---|---|
| `config.js` | `SCAN_PAIRS` (14, সবগুলো live-verified) + `SCAN_CONFIG` |
| `history/latestCache.js` **new** | shared key/TTL/freshness layer — ৩টে call site যাতে drift না করে |
| `handlers/scheduledScan.js` **new** | 5-min scanner: market gate, 3-per-batch, 500ms delay, 90s cap, per-pair isolation |
| `handlers/latest.js` **new** | `/api/signals/latest` (single + all) + `getScanCacheStats()` for /health |
| `handlers/signal.js` | `handleSignal(pair, env, ctx, {preferCache})` — cache-first mode + opportunistic warm |
| `index.js` | `event.cron`-ভিত্তিক routing, নতুন route, `preferCache` param |
| `handlers/health.js` | `scanCache` block |
| `wrangler.toml` | `crons = ["*/2 * * * *", "*/5 * * * *"]` |

### 2.1 Key design decisions

**`latestCache.js` কেন আলাদা module** — key format তিন জায়গায় লাগে (scanner writes, latest reads, signal?preferCache reads+writes)। Inline করলে একটা mismatch **permanent silent cache miss** তৈরি করত, কোনো error ছাড়া। একটা module = একটা সত্য, smoke test দিয়ে locked।

**OTC key round-trip** — `EURUSD-OTC` → `latest:EURUSD_OTC`। সরল underscore→slash swap ফেরত দিত `EURUSD/OTC` (ভুল pair)। আলাদা করে handle করা + tested।

**`nextRefreshIn` scan cycle-এর দিকে গোনে, TTL-এর দিকে না** — client জানতে চায় "নতুন data কখন আসবে", "cache কখন মরবে" না।

**যা cache করা হয় না:** `DUMMY_FALLBACK` (সব candle fetch fail → বানানো দাম ১০ মিনিট পরিবেশন হতো), market-closed response (signal নেই), আর error।

**Force refresh candle cache ছোঁয় না** — `?preferCache` না দিলে engine নতুন করে চলে (নতুন AI, নতুন signal id), কিন্তু `c:` candle cache (pre-existing, 1min TTL 120s) reuse হয়। এটা ইচ্ছাকৃত: force refresh মানে "নতুন করে বিশ্লেষণ করো", "TwelveData-কে আবার টাকা দাও" না।

---

## 3. Verification

### 3.1 §7 checklist

| # | Check | Result |
|---|---|---|
| 7.1 | `node --check` | **34/34 pass** + 2 scripts |
| 7.2 | deploy/push greps | **0 hits** |
| 7.3 | WR guarantee language in `src/` | **0 hits** |
| 7.4 | `SCAN_PAIRS`/`scheduledScan`/`handleLatest` wiring | present |
| 7.5 | engine diff | **empty — zero engine changes** |
| 7.6 | scan writes N `latest:*`, latest reads back with age | pass |
| 7.7 | preferCache hit=no engine, miss=engine+writeback | pass |
| 7.8 | market-closed skip | pass (14 open → 10 closed) |
| 7.9 | both crons in wrangler.toml | pass |
| 7.10 | `/health` scanCache block | pass |

### 3.2 Tests — 104 assertions, 0 failures

**`phase7_smoke.mjs` (68)** — key format + OTC round-trip, freshness maths, read/write, `handleLatest` (single/all/404/400/stale/503), `getScanCacheStats`, backward-compat routing, "scanner must not call saveSignalToHistory".

**`phase7_integration.mjs` (36)** — real `scheduledScan` → real `handleSignalRaw` → real engine, only HTTP stubbed:
- 14 pairs scanned → 14 `latest:*` entries, TTL 600s, generationId stamped, Phase B fields intact
- **history ≤1 record per pair per scan** (§1.3-এর double-write guard)
- `/api/signals/latest` serves with **zero upstream calls**
- preferCache miss → generates + warms (`opportunistic:true`); hit → **0 candle, 0 AI calls**
- default `/api/signal` → নতুন engine pass, distinct signal id, cache bypassed
- একটা pair upstream fail করলে scan থামে না, ওই pair cache-এ যায় না, বাকিরা যায়
- KV binding না থাকলে clean abort

দুটো test failure পেয়েছিলাম, **দুটোই আমার test-এর bug** (code-এর না): `OLD/USD` valid currency না তাই 400 এসেছিল 404-এর বদলে; আর একটা grep comment-এর ভেতরের উল্লেখ ধরছিল। তৃতীয়টা — "force refresh must refetch candles" — **আমার assumption ভুল ছিল**, candle cache আলাদা layer; assertion ঠিক করে engine-rerun প্রমাণে বদলেছি।

---

## 4. Known limitations

1. **AI 429 এখনই চলছে** (§1.5)। Deploy করলে cache ভরবে `BOTH_UNAVAILABLE` signal দিয়ে, আর সেটা ১০ মিনিট সবাইকে পরিবেশন হবে। এখন অন্তত প্রতি request নতুন করে চেষ্টা করে।
2. **Cron overlap সম্ভব** — `*/10` মিনিটে দুই cron একসাথে fire করে। Result checker হালকা, কিন্তু একই সময়ে scan চললে দুটো একই KV-তে লিখবে। আলাদা key space, তাই corruption নেই, শুধু সাময়িক load।
3. **Scan latency measured 2.1s** (stubbed network, 500ms batch delay সহ)। বাস্তবে candles+AI মিলিয়ে বেশি হবে; 90s cap সেটা ধরে রাখবে কিন্তু partial coverage হতে পারে — পরের tick ৫ মিনিটে ঠিক করে দেয়।
4. **`/api/signals/latest` (all) প্রতি cached pair-এ একটা KV read** — 14 pair = 14 read/request। KV read সস্তা, কিন্তু free না।
5. **`scanCache.lastGenerationId` সবচেয়ে নতুন cron entry-র** — partial scan হলে ভিন্ন pair-এ ভিন্ন id থাকতে পারে।
6. **Opportunistic entry cron entry overwrite করতে পারে** — user force-refresh করলে `opportunistic:true` লেখা হয়, পরের scan আবার `false` করে দেয়। ক্ষতিকর না, তবে /health-এর count ওঠানামা করবে।
7. **Rate-limiter `/api/signals/latest`-এ প্রযোজ্য না** — `index.js`-এ শুধু `/api/signal` আর `/api/batch` rate-limited। নতুন endpoint সস্তা (KV read), কিন্তু unmetered।

---

## 5. OPEN QUESTIONS

1. **AI budget — deploy-এর আগে সিদ্ধান্ত দরকার (blocking)।** 13/14 pair AI trigger করে = ~336 call/hour, আর আজকেই দুই provider 429 দিচ্ছে। বিকল্প: (ক) scan-এ AI skip করে শুধু engine signal cache করা, on-demand-এ AI যোগ; (খ) AI শুধু high-confidence candidate-এ চালানো; (গ) scan interval 5→10 মিনিট (AI অর্ধেক); (ঘ) paid AI tier। আমি কিছু বদলাইনি — spec §9 engine modification নিষেধ করেছে।
2. **Cache miss auto-fallback (§3.3) implement করা হয়নি** — spec বলেছিল `/api/signals/latest?pair=X` unsupported pair-এ fresh run করে opportunistically cache করবে। আমি **404 রেখেছি** কারণ (ক) §2.3 নিজেই বলে endpoint "cache read-only serve করবে", (খ) fresh run করলে `/api/signals/latest` rate-limit-হীন অথচ engine-triggering হয়ে যেত — abuse vector। `?preferCache=true` path ঠিক এই auto-fallback-টাই দেয়, rate limit সহ। ভুল trade-off মনে হলে বলবেন।
3. **`*/2` আর `*/5` overlap** — প্রতি ১০ মিনিটে একসাথে। Scanner-কে `*/5` থেকে সরিয়ে odd offset দেওয়া যায় না (Cloudflare cron syntax সীমিত), কিন্তু scan-এ lock (KV flag) যোগ করা যায়। এখন করিনি — over-engineering মনে হয়েছে।
4. **SCAN_PAIRS-এ OTC নেই।** ১৪টাই forex/crypto। OTC pair (`EURUSD-OTC`) cache layer support করে (key round-trip tested) কিন্তু scan হয় না। ইচ্ছাকৃত কিনা নিশ্চিত নই।

---

## 6. §2.5 verification — report flow unchanged

`/api/report?id=X&result=WIN` **সম্পূর্ণ অপরিবর্তিত**। `handleReport` ছোঁয়া হয়নি; signal `id` এখনো join key; cron result checker (`*/2`) আগের মতোই চলে। Scanner history লেখে না (§1.3), তাই নতুন কোনো id উৎস তৈরি হয়নি — App যা report করে Bot তাই দেখে, উল্টোটাও।

Local reproduce:
```
node scripts/phase7_smoke.mjs
node scripts/phase7_integration.mjs
for f in $(find src -name '*.js'); do node --check "$f"; done
```

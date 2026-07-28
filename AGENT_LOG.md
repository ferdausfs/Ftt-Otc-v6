# Ftt-Otc-v6 — Agent Log

Changelog-স্টাইল টেকনিক্যাল লগ — commit/date/exact-change ভিত্তিক। Project-এর overall মিশন/context জানতে `FTT-PROJECT-MASTER-PROTOCOL.md` দেখো, এখানে সেটা repeat করা হয় না। নতুন entry সবসময় উপরে যোগ হবে।

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

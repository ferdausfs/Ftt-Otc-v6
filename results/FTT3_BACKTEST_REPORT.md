# FTT3 Walk-Forward Backtest Report

**VERDICT: FAIL** — the strategy does **not** clear breakeven out-of-sample.

> **বাংলা সারমর্ম:** নতুন ৩-কন্ডিশন ইঞ্জিন (15m EMA bias → 5m MACD cross → 1m ATR gate +
> ATR-percentile expiry) পুরো process discipline মেনে walk-forward টেস্ট হয়েছে।
> Out-of-sample win rate **50.5%** (Wilson-LO 46.6%) — breakeven 55.6%-এর নিচে।
> **ফলাফল: FAIL।** কোনো rescue-filter যোগ করা হয়নি, re-split করা হয়নি।
> Repo owner-এর নির্দেশে এটি live-এ full replacement হিসেবে ডেপ্লয় হচ্ছে —
> এটি কোনো profitability claim নয়।

---

## 1. Commitments frozen before the first run

All of the following were committed to git (commit `1bddb43`) **before any
harness run touched out-of-sample data**:

| Item | Value |
|---|---|
| Walk-forward split | `SPLIT_DATE = 2026-08-16T00:00:00Z` (OOS = entry at/after split) |
| C1 | EMA(20) vs EMA(50) on last closed 15m candle (CALL/PUT bias; equal → NO_TRADE) |
| C2 | MACD(12,26,9) line×signal cross on the last closed 5m candle, in C1's direction |
| C3 | ATR(14, Wilder) on 1m ≥ its trailing median over the last 100 closed 1m candles |
| Expiry tiers | ATR-pct ≥ 75 → 5 min · 25–75 → 7 min · < 25 → 10 min |
| Min bucket | 30 decided signals (smaller → `INSUFFICIENT`, never a rate) |
| Breakeven gate | Wilson lower bound > 55.56% at 0.80 payout |
| Scope | 4 crypto + 4 forex, real data only; no OTC; no other filter exists |

No strategy constant was changed after OOS results were seen. The harness ran
twice: the first run's WR column printed `NaN` due to a display-formatting bug
(`+"50.4%"`); the second run fixed only that formatter — the decision logic,
constants and data were untouched, and every decision row is deterministic.

## 2. Data (real, public, no synthesis)

| Market | Pair | Source | 1m span | 1m candles |
|---|---|---|---|---|
| crypto | BTC/USD | Bybit spot | 07-05 → 09-05 | 89,341 |
| crypto | ETH/USD | Bybit spot | 07-05 → 09-05 | 89,341 |
| crypto | XRP/USD | Bybit spot | 07-05 → 09-05 | 89,341 |
| crypto | SOL/USD | Bybit spot | 07-05 → 09-05 | 89,341 |
| forex | EUR/USD | Yahoo | 08-07 → 09-04 | 29,130 |
| forex | GBP/USD | Yahoo | 08-07 → 09-04 | 29,124 |
| forex | USD/JPY | Yahoo | 08-07 → 09-04 | 28,974 |
| forex | AUD/USD | Yahoo | 08-07 → 09-04 | 14,562 (data holes — see below) |

- Crypto uses the USDT-quoted spot feed as an honest proxy for the /USD pairs.
- Yahoo 1m history is capped at ~30 days; 5m/15m at ~60 days (clamped, no failure).
- **AUD/USD 1m had ~15k null/invalid candles at the source** → 15,016 dropped,
  half the series missing. This halves AUD/USD's candidate count (2,895 rows vs
  5,791 for the other forex pairs). Reported as-is; no interpolation anywhere.
- Weekends create 49–50h gaps in forex; expiry windows spanning a missing exit
  candle are resolved as `EXPIRY_GAP` (55 OOS signals) and excluded from WR.
- Max observed gap within a session: 1m crypto — none (continuous).

## 3. Method

- **Candidates:** every 1m candle that closes exactly on a 5m boundary (the only
  moments where C2's "cross on the last closed 5m candle" can fire).
- **Entry:** close of the boundary 1m candle. **Exit:** close of the 1m candle
  exactly N minutes later (N = 5/7/10 from the ATR tier).
- **Outcome:** CALL wins when exit > entry, PUT wins when exit < entry; exact
  equality = `TIE`. Headline WR excludes ties (`W/(W+L)`); the conservative
  `W/(W+L+T)` rate is also reported.
- **No-lookahead:** the engine slices its own inputs to candles fully closed
  before the entry candle's close time; `scripts/strategy_tests.mjs` proves by
  mutation (future candles ×10) that decisions cannot change, on both the
  reference and the precomputed value path (42 assertions, all green).

## 4. Out-of-sample results (touched once)

**Headline (n = 642 decided, 49 ties, 55 expiry-gaps):**

| Bucket | W | L | T | WR | Wilson 95% CI | Note |
|---|---|---|---|---|---|---|
| **OOS overall** | **324** | **318** | **49** | **50.5%** | **[46.6%, 54.3%]** | **FAIL vs 55.6%** |
| OOS crypto | 190 | 204 | 12 | 48.2% | [43.3%, 53.2%] | |
| OOS forex | 134 | 114 | 37 | 54.0% | [47.8%, 60.1%] | |
| OOS BTC/USD | 38 | 53 | 1 | 41.8% | [32.2%, 52.0%] | |
| OOS ETH/USD | 52 | 47 | 0 | 52.5% | [42.8%, 62.1%] | |
| OOS XRP/USD | 45 | 57 | 5 | 44.1% | [34.9%, 53.8%] | |
| OOS SOL/USD | 55 | 47 | 6 | 53.9% | [44.3%, 63.3%] | |
| OOS EUR/USD | 35 | 39 | 34 | 47.3% | [36.3%, 58.5%] | ties-heavy (Yahoo 5-digit rounding) |
| OOS GBP/USD | 53 | 50 | 0 | 51.5% | [41.9%, 60.9%] | |
| OOS USD/JPY | 46 | 25 | 3 | 64.8% | [53.2%, 74.9%] | point estimate > breakeven, **CI-LO is not** |
| OOS AUD/USD | 0 | 0 | 0 | — | — | **INSUFFICIENT** — all 51 OOS signals EXPIRY_GAP (source data holes; zero decidable) |
| OOS expiry 5m | 181 | 205 | 34 | 46.9% | [42.0%, 51.9%] | |
| OOS expiry 7m | 143 | 113 | 15 | 55.9% | [49.7%, 61.8%] | |
| OOS expiry 10m | 0 | 0 | 0 | — | — | no OOS entry landed below the 25th pct |

Conservative WR (ties as losses): **46.9%**. Seven of eight pairs produced
reportable buckets; AUD/USD is `INSUFFICIENT` with zero decidable signals (its
source 1m series is half missing, so every expiry window hit `EXPIRY_GAP`). No
bucket's Wilson lower bound clears 55.6%.

## 5. No-skill baseline (up-rate, same windows, OOS)

| Expiry window | n | up | down | tie | up-rate |
|---|---|---|---|---|---|
| 5 min | 30,411 | 14,415 | 14,511 | 1,485 | 47.4% |
| 7 min | 30,388 | 14,547 | 14,489 | 1,352 | 47.9% |
| 10 min | 30,358 | 14,626 | 14,631 | 1,101 | 48.2% |

The window drifted slightly down. The strategy's 50.5% is **+2.7pp over the
no-skill up-rate** — real directional information, but far below the ~+7.7pp
over baseline that breakeven would need here.

## 6. Funnel (why signals are rare)

| Stage | In-sample (40/9d) | OOS (20d) |
|---|---|---|
| Boundary candidates | 53,662 | 37,958 |
| C1 pass (bias exists) | 53,154 | 37,958 |
| C2 pass (aligned cross) | 2,016 | 822 |
| C3 pass (ATR ≥ median) → **signals** | **921** | **746** |

Blocking reasons (OOS): `C2_NO_CROSS` 91.7%, `C2_WRONG_DIRECTION` 4.3%,
`C3_LOW_VOLATILITY` 2.0%. A cross-triggered entry is inherently rare; the
chain is doing exactly what it was specified to do — the outcomes just don't
carry enough edge.

## 7. Payout sensitivity

Breakeven WR = 1/(1+payout). With the OOS Wilson-LO fixed at 46.6%, the
strategy stays negative for **every** payout below ~114% — i.e. no realistic
broker payout rescues this result. At the assumed 0.80 payout breakeven is
55.56%; at 0.70 → 58.8%; at 0.90 → 52.6% (still above 46.6%).

## 8. Observations flagged for FUTURE pre-registered tests only

None of the following may be bolted onto C1–C3 now (that is the exact pattern
that broke prior engines). If a future walk-forward on fresh data is run, these
are the only pre-registerable hypotheses, stated before that run:

1. USD/JPY showed the strongest point estimate (64.8%) — per-pair or per-market
   gating is a hypothesis to test on fresh data, not a filter to add now.
2. The 7-minute tier outperformed the 5-minute tier on this window (55.9% vs
   46.9%) — tier boundaries were frozen pre-run and stay frozen.
3. Forex outperformed crypto (54.0% vs 48.2%) on this window — consistent with
   nothing more than noise at these sample sizes (CIs overlap heavily).
4. AUD/USD needs a clean 1m source (or broker-side data collection) before any
   conclusion about it is possible; nothing was interpolated to force a number.

## 9. Reproducibility

```bash
node backtest/fetch_data.mjs      # real candles -> backtest/data/ (gitignored)
node backtest/harness.mjs         # single pass -> results/ + audit JSONLs
node scripts/strategy_tests.mjs   # 42 assertions incl. no-lookahead proof
node scripts/verify_audit.mjs     # independent recount of every headline number
```

`results/audit_signals.jsonl` (19 MB, committed) contains **every OOS
candidate** — 37,958 rows: all 746 signals with full indicator values, chosen
expiry, entry/exit and result, plus all 37,212 NO_TRADEs with their exact
blocking condition and raw values. `scripts/verify_audit.mjs` re-derives every
number in this report from that file (72 checks). The in-sample audit
(`audit_in_sample.jsonl`) is written locally for diagnostics and gitignored.

## 10. Deployment note

Per the repo owner's directive this engine replaces all prior strategy code on
`main` and runs live (the Telegram push layer is unchanged plumbing). This
report makes **no profitability claim**: the live engine is a clean, honest,
fully-audited data collector whose OOS verdict is FAIL. Do not trade it with
expectations above coin-flip minus costs.

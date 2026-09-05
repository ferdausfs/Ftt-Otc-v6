# FTT3 Live Deployment Status Report — 2026-09-05

**Scope:** the real production record of the live FTT3 worker from deploy
(`48c6c6e`, 2026-09-05 10:35:11 UTC) to pull time (2026-09-05 16:01:36 UTC) —
5.4 hours of runtime. This is NOT a backtest and contains no simulation: every
number below is re-aggregated from `results/LIVE_STATUS_2026-09-05.jsonl`,
which is a verbatim extract of the worker's own KV records
(`sig:<PAIR>` history arrays, `pending:*`, and the `push:*` delivery ledgers in
namespace `SIGNAL_CACHE`), pulled read-only via the Cloudflare REST API.
6,404 rows left in KV by the previous (pre-replacement) engine were excluded —
only rows with the FTT3 engine tag and `timestamp >= 2026-09-05T10:35:11Z`
are counted.

## 1. Scanner liveness (did the cron actually run?)

The worker writes a `latest:<PAIR>` decision record on every scan tick. At
pull time all four crypto pairs had fresh records (forex pairs are absent
because the forex market is closed on Saturday — the scanner skips them by
design, no signals were possible there):

| Key | Last decision | Last write (UTC) |
|---|---|---|
| `latest:BTC_USD` | NO_TRADE | 16:01:33 |
| `latest:ETH_USD` | NO_TRADE | 16:00:52 |
| `latest:XRP_USD` | NO_TRADE | 16:00:35 |
| `latest:SOL_USD` | NO_TRADE | 15:55:14 |

`pending:*` was empty at pull time — nothing is awaiting expiry resolution.

## 2. Signal count since deploy

**2 signals** (both `BTC/USD`, both `CALL`). ~65 cron ticks x 4 crypto pairs
≈ 260 pair-evaluations produced 2 decided signals — consistent with the
engine's design as a selective 3-condition strategy (backtest rate was ~7
signals/day across 8 pairs).

By direction: CALL 2, PUT 0.

## 3. Resolved vs pending

| State | Count |
|---|---|
| Resolved WIN | 1 |
| Resolved LOSS | 1 |
| Resolved TIE | 0 |
| Resolved EXPIRY_GAP | 0 |
| Resolved UNKNOWN | 0 |
| **Pending (open)** | **0** |

All 2 signals reached expiry and were resolved by the `*/2` result checker
(both on the first check, `checks: 0`).

## 4. Win rate (ties excluded, reported separately)

**Overall: 1 W / 1 L = 50.0% win rate** (n = 2 decided; ties = 0).

| Pair | Tier | Decided | W | L | Win rate |
|---|---|---|---|---|---|
| BTC/USD | 5m | 2 | 1 | 1 | 50.0% |
| every other pair | — | 0 | 0 | 0 | — |

For context only: binary-options breakeven at the platform's 0.80 payout is
55.6%. With n = 2 this comparison carries no information — see the caveat.

## 5. Telegram push confirmation (from the worker's own ledgers)

| Signal | Delivered | Recipients | Source |
|---|---|---|---|
| `sig_mtoa0wmo_79gji4` | YES | 1 | `push:delivered24h` |
| `sig_mtok0xsw_vkw61s` | YES | 1 | `push:delivered24h` |

**2/2 signals successfully pushed, 0 push failures.** The worker's rolling
delivery ledger (`push:delivered24h`) contains a matching entry for both live
signals, and the durable `push:lastAttempt` diagnostic shows
`ok: true, sent: 1, errors: []` (1 subscriber configured). No push-error
record exists anywhere in the ledgers for the live window. Note: this ledger
is a rolling ~24h window by design, so push evidence for future signals older
than that window will honestly read "no-record" in follow-up reports.

## 6. Per-signal audit detail (raw values, from the JSONL)

| Field | `sig_mtoa0wmo_79gji4` | `sig_mtok0xsw_vkw61s` |
|---|---|---|
| Pair / decision | BTC/USD CALL | BTC/USD CALL |
| Entry time (UTC) | 11:05:00 | 15:45:00 |
| Entry price | 79663.93 | 79751.23 |
| C1 EMA20 / EMA50 | 79639.45050 / 79634.74243 (UP) | 79688.85647 / 79667.74215 (UP) |
| C2 cross | BULLISH (MACD −9.68269 > signal −10.78703) | BULLISH (MACD 12.53356 > signal 12.31219) |
| C3 ATR(14) / median | 9.76361 / 6.18159 | 13.09131 / 10.01622 |
| ATR percentile → tier | 82 → 5m | 75 → 5m |
| Expiry (UTC) | 11:10:00 | 15:50:00 |
| Exit price | 79649.83 | 79752.00 |
| Result | **LOSS** (−14.10) | **WIN** (+0.77) |
| Checked at (UTC) | 11:12:09 | 15:52:08 |
| Pushed at (UTC) | 11:05:26 | 15:45:24 |

## 7. Sample-size caveat (explicit)

**Two decided signals are not a trend.** The pre-registered evaluation rule
used throughout this project requires ~30 decided signals per bucket before
any win rate is meaningful. Every win rate printed above (50.0%) is a single
coin-flip away from swinging by 50 percentage points; the Wilson interval at
n = 2 spans roughly [9%, 91%]. Nothing in section 4 should be read as
evidence about the strategy's edge or lack of it — the OOS backtest verdict
(FAIL, 50.5% WR) remains the only statistically meaningful result, and this
live window exists to accumulate audited data, not to re-judge the engine
after 5 hours. The next status report becomes worth reading only when
buckets approach the ~30-signal floor.

## Reproducibility

- Raw extract: `/home/z/my-project/live_status_raw_2026-09-05/kv_raw.json`
  (verbatim KV values, pulled 16:01:36 UTC, read-only).
- JSONL: `results/LIVE_STATUS_2026-09-05.jsonl` — one line per live signal,
  audit field shape (`pair, decision, c1, c2, c3, expiryMinutes,
  atrPercentile, entryPrice, expiryTime, exitPrice, result`) plus `id` and
  per-record `pushStatus`.
- Every count in this report is a direct filter/aggregation of those two
  files; no number was estimated or carried over from any backtest.

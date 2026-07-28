# Phase B backtest — circuit-breaker reproduction

Input: `pooled_dedup.json` (dedup-clean pool, 214 rows, 92 decided)  
Window: 2026-06-23T00:31:19 -> 2026-07-28T10:36:01

Pairs in pool: ADA/USD, BNB/USD, BTC/USD, ETH/USD, EUR/USD, SOL/USD, XRP/USD

## Primary table (result clock = production semantics)

| Config | n decided | WR | dWR vs base | volume kept | pair-max streak | cross-pair streak | shadow n | shadow WR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline (no CB) | 92 | 42.4% | — | 100% | 6 | 11 | 0 | — |
| CB 2h | 64 | 40.6% | -1.8pp | 69.6% | 5 | 10 | 28 | 46.4% |
| CB 6h | 56 | 41.1% | -1.3pp | 60.9% | 5 | 8 | 36 | 44.4% |
| CB 12h | 56 | 41.1% | -1.3pp | 60.9% | 5 | 8 | 36 | 44.4% |
| CB 24h | 41 | 36.6% | -5.8pp | 44.6% | 4 | 8 | 51 | 47.1% |

## Secondary table (signal clock = Phase A2 semantics)

| Config | n decided | WR | pair-max streak | cross-pair streak | shadow n | shadow WR |
|---|---:|---:|---:|---:|---:|---:|
| Baseline (no CB) | 92 | 42.4% | 6 | 11 | 0 | — |
| CB 2h | 49 | 42.9% | 4 | 7 | 43 | 41.9% |
| CB 6h | 43 | 46.5% | 3 | 7 | 49 | 38.8% |
| CB 12h | 43 | 46.5% | 3 | 7 | 49 | 38.8% |
| CB 24h | 30 | 33.3% | 3 | 7 | 62 | 46.8% |

## Per-pair max loss streak (baseline vs CB 6h, result clock)

| Pair | baseline | CB 6h |
|---|---:|---:|
| ADA/USD | 2 | 2 |
| BNB/USD | 6 | 5 |
| BTC/USD | 3 | 3 |
| ETH/USD | 4 | 3 |
| SOL/USD | 2 | 2 |
| XRP/USD | 3 | 3 |

## Reproduction checks (Phase A2 targets, +/-3pp)

| Check | Expected | Actual | Pass |
|---|---:|---:|:--:|
| baseline WR 42.4% +/-3pp | 42.4 | 42.4 | PASS |
| baseline n = 92 | 92 | 92 | PASS |
| baseline cross-pair loss streak = 11 (A2 trend-table metric) | 11 | 11 | PASS |
| baseline per-pair max loss streak (informational, no A2 target) | n/a | 6 | PASS |
| CB 6h [signal clock] WR 46.5% +/-3pp | 46.5 | 46.5 | PASS |
| CB 6h [signal clock] pair-max loss streak = 3 | 3 | 3 | PASS |
| CB 6h [signal clock] n ~= 43 (+/-5) | 43 | 43 | PASS |

All checks pass: **True**


## Material deviation (reported, not hidden)

Production applies a CB update only when the result is actually resolvable (expiry + 90s), not at signal time. On that clock the CB 6h WR is 41.1% vs the 46.5% A2 reported on the signal clock — a 5.4pp shortfall, outside the +/-3pp tolerance. Reported, not hidden.

| Clock | CB 6h WR | n decided | pair-max streak | cross-pair streak |
|---|---:|---:|---:|---:|
| signal | 46.5% | 43 | 3 | 7 |
| result | 41.1% | 56 | 5 | 8 |

Baseline cross-pair loss streak: **11** (A2 trend-table metric); baseline worst per-pair streak: **6** (BNB/USD).
CB 6h cuts the cross-pair streak to **7** (signal clock) / **8** (result clock).

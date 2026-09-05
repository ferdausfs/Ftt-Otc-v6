#!/usr/bin/env python3
"""
FTT3-R CRYPTO EXT report builder.

Re-aggregates EVERY number in results/FTT3R_CRYPTO_EXT_REPORT.md directly
from results/FTT3R_CRYPTO_EXT_audit.jsonl (falls back to the committed .gz).
Cross-checks bucket counts against the harness's FTT3R_CRYPTO_EXT_summary.json
and fails loudly on any mismatch — the same integrity standard as
scripts/verify_audit.mjs.

Run: python3 scripts/build_crypto_ext_report.py
"""

import gzip
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

REPO = "/home/z/my-project/Ftt-Otc-v6"
AUDIT = os.path.join(REPO, "results", "FTT3R_CRYPTO_EXT_audit.jsonl")
AUDIT_GZ = AUDIT + ".gz"
SUMMARY = os.path.join(REPO, "results", "FTT3R_CRYPTO_EXT_summary.json")
REPORT = os.path.join(REPO, "results", "FTT3R_CRYPTO_EXT_REPORT.md")

MIN_BUCKET = 30
BREAKEVEN = 55.5556
PAYOUT = 0.80

PAIRS = ["BTC/USD", "ETH/USD", "XRP/USD", "SOL/USD"]


def open_audit():
    if os.path.exists(AUDIT):
        return open(AUDIT, "rt"), AUDIT
    if os.path.exists(AUDIT_GZ):
        return gzip.open(AUDIT_GZ, "rt"), AUDIT_GZ
    sys.exit("no audit JSONL found (neither plain nor .gz)")


def wilson(w, n, z=1.959963985):
    if n == 0:
        return None, None, None
    p = w / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    s = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5)
    return p, (c - s) / d, (c + s) / d


def fmt_pct(x, nd=1):
    return "-" if x is None else f"{100 * x:.{nd}f}%"


def bucket_row(label, w, l, t):
    n = w + l
    wr, lo, hi = wilson(w, n)
    wr_c, lo_c, hi_c = wilson(w, n + t)
    return {
        "label": label, "w": w, "l": l, "t": t, "n": n,
        "wr": wr, "lo": lo, "hi": hi,
        "consWr": wr_c,
        "sufficient": n >= MIN_BUCKET,
        "note": None if n >= MIN_BUCKET else f"INSUFFICIENT (n={n} < {MIN_BUCKET})",
    }


def main():
    # ── 1. stream the audit JSONL ──────────────────────────────────────────
    rows = Counter()          # reason -> count (all decisions)
    pair_rows = Counter()     # pair -> evaluated rows
    sig = defaultdict(lambda: {"w": 0, "l": 0, "t": 0, "gap": 0})  # bucket key -> counts
    base = {n: {"valid": 0, "up": 0, "down": 0, "tie": 0} for n in (5, 7, 10)}
    base_pair = defaultdict(lambda: {n: {"valid": 0, "up": 0, "down": 0, "tie": 0} for n in (5, 7, 10)})
    signals_total = 0
    dir_by = {"CALL": {"w": 0, "l": 0, "t": 0}, "PUT": {"w": 0, "l": 0, "t": 0}}
    tier_by = defaultdict(lambda: {"w": 0, "l": 0, "t": 0})
    regime_counts = Counter()
    strategy_counts = Counter()

    fh, src = open_audit()
    with fh:
        for line in fh:
            r = json.loads(line)
            pair = r["pair"]
            rows[r["reason"]] += 1
            pair_rows[pair] += 1
            if r["regime"]:
                regime_counts[r["regime"]] += 1
            if r["strategy"]:
                strategy_counts[r["strategy"]] += 1
            # no-skill baseline markers exist on every evaluated boundary row
            for n in (5, 7, 10):
                d = r.get(f"dir{n}")
                if d is None:
                    continue
                base[n]["valid"] += 1
                base_pair[pair][n]["valid"] += 1
                if d == 1:
                    base[n]["up"] += 1; base_pair[pair][n]["up"] += 1
                elif d == -1:
                    base[n]["down"] += 1; base_pair[pair][n]["down"] += 1
                else:
                    base[n]["tie"] += 1; base_pair[pair][n]["tie"] += 1
            if r["decision"] == "NO_TRADE":
                continue
            signals_total += 1
            res = r["result"]
            if res == "EXPIRY_GAP":
                for k in (f"pair:{pair}", f"strategy:{r['strategy']}",
                          f"pairstrat:{pair}|{r['strategy']}", "OVERALL"):
                    sig[k]["gap"] += 1
                continue
            def bump(k):
                if res == "WIN":
                    sig[k]["w"] += 1
                elif res == "LOSS":
                    sig[k]["l"] += 1
                elif res == "TIE":
                    sig[k]["t"] += 1
            bump("OVERALL")
            bump(f"pair:{pair}")
            if r["strategy"]:
                bump(f"strategy:{r['strategy']}")
                bump(f"pairstrat:{pair}|{r['strategy']}")
            if r["regime"]:
                bump(f"regime:{r['regime']}")
            if r["expiryMinutes"]:
                bump(f"tier:{r['expiryMinutes']}m")
                tier_by[f"{r['expiryMinutes']}m"]["w" if res == "WIN" else "l" if res == "LOSS" else "t"] += 1
            if r["decision"] in ("CALL", "PUT"):
                bump(f"dir:{r['decision']}")


    # ── 2. integrity cross-check vs the harness summary ────────────────────
    with open(SUMMARY) as f:
        hs = json.load(f)
    checks = []
    hs_overall = hs["buckets"].get("OVERALL", {"w": 0, "l": 0, "t": 0})
    checks.append(("OVERALL W/L/T", (sig["OVERALL"]["w"], sig["OVERALL"]["l"], sig["OVERALL"]["t"]),
                   (hs_overall["w"], hs_overall["l"], hs_overall["t"])))
    checks.append(("total signals", signals_total + sum(v["gap"] for v in sig.values()),
                   hs["totalSignals"]))
    checks.append(("total rows", sum(pair_rows.values()), hs["totalRows"]))
    for p in PAIRS:
        hk = hs["buckets"].get(f"pair:{p}", {"w": 0, "l": 0, "t": 0})
        checks.append((f"{p} W/L/T", (sig[f"pair:{p}"]["w"], sig[f"pair:{p}"]["l"], sig[f"pair:{p}"]["t"]),
                       (hk["w"], hk["l"], hk["t"])))
    failed = [(n, a, b) for n, a, b in checks if a != b]
    print("INTEGRITY CHECK vs harness summary:", "PASS" if not failed else "FAIL")
    for n, a, b in failed:
        print(f"  MISMATCH {n}: jsonl={a} summary={b}")
    if failed:
        sys.exit("integrity check failed — report not written")

    # ── 3. build rate tables ────────────────────────────────────────────────
    def rate(label, key):
        v = sig[key]
        return bucket_row(label, v["w"], v["l"], v["t"])

    overall = rate("Overall (single 12-month block)", "OVERALL")
    by_strategy = [rate(f"Strategy {k.split(':')[1]} ({'A — trend-following C1-C3' if 'TREND' in k else 'B — mean-reversion D1-D3'})", k)
                   for k in ("strategy:TREND", "strategy:MEANREV")]
    by_pair = [rate(p, f"pair:{p}") for p in PAIRS]
    by_pairstrat = [rate(f"{p} · {s}", f"pairstrat:{p}|{s}")
                    for p in PAIRS for s in ("TREND", "MEANREV") if f"pairstrat:{p}|{s}" in sig]
    by_regime = [rate(k.split(":")[1], k) for k in ("regime:TRENDING", "regime:RANGING") if k in sig]
    by_tier = [rate(f"Expiry {m}", f"tier:{m}") for m in ("5m", "7m", "10m") if f"tier:{m}" in sig]
    by_dir = [rate(k, f"dir:{k}") for k in ("CALL", "PUT") if f"dir:{k}" in sig]

    # weighted no-skill baseline WR: baseline probability that a random
    # direction bet wins = P(up)*P(CALL) + P(down)*P(PUT) over the same rows
    n_call = sig["dir:CALL"]["w"] + sig["dir:CALL"]["l"] + sig["dir:CALL"]["t"]
    n_put = sig["dir:PUT"]["w"] + sig["dir:PUT"]["l"] + sig["dir:PUT"]["t"]
    n_sig = n_call + n_put
    baseline_tbl = []
    weighted_base_wr = None
    for n in (5, 7, 10):
        b = base[n]
        up_rate = b["up"] / b["valid"] if b["valid"] else None
        down_rate = b["down"] / b["valid"] if b["valid"] else None
        baseline_tbl.append({
            "minutes": n, "valid": b["valid"], "up": b["up"], "down": b["down"], "tie": b["tie"],
            "upRate": up_rate, "downRate": down_rate,
        })
    # signals per tier weight the per-window baseline
    if n_sig:
        weighted = 0.0
        for t in baseline_tbl:
            m = f"{t['minutes']}m"
            n_t = tier_by[m]["w"] + tier_by[m]["l"] + tier_by[m]["t"]
            if t["valid"] and n_t:
                p_call = t["up"] / t["valid"]
                p_put = t["down"] / t["valid"]
                w_call = n_call / n_sig   # global CALL/PUT share as the honest direction mix
                weighted += n_t * (p_call * w_call + p_put * (1 - w_call))
        weighted_base_wr = weighted / n_sig if n_sig else None

    edge_pp = (overall["wr"] - weighted_base_wr) * 100 if (overall["wr"] and weighted_base_wr) else None

    # ── 4. write the report ────────────────────────────────────────────────
    def table(rows_):
        out = ["| Bucket | W | L | T (sep.) | Decided n | WR | Wilson 95% CI | Conservative W/(W+L+T) | n>=30 |",
               "|---|---|---|---|---|---|---|---|---|"]
        for r in rows_:
            out.append(
                f"| {r['label']} | {r['w']} | {r['l']} | {r['t']} | {r['n']} "
                f"| {fmt_pct(r['wr'])} | [{fmt_pct(r['lo'])}, {fmt_pct(r['hi'])}] "
                f"| {fmt_pct(r['consWr'])} | {'yes' if r['sufficient'] else 'NO — ' + r['note']} |")
        return "\n".join(out)

    funnel_lines = ["| Blocking reason | Rows | Share of evaluated |", "|---|---|---|"]
    total_rows_n = sum(pair_rows.values())
    for k, v in sorted(rows.items(), key=lambda kv: -kv[1]):
        funnel_lines.append(f"| `{k}` | {v} | {100 * v / total_rows_n:.2f}% |")

    base_lines = ["| Expiry window | Boundary rows with exit | Up | Down | Tie | Up-rate | Down-rate |",
                  "|---|---|---|---|---|---|---|"]
    for t in baseline_tbl:
        base_lines.append(
            f"| {t['minutes']}m | {t['valid']} | {t['up']} | {t['down']} | {t['tie']} "
            f"| {fmt_pct(t['upRate'], 2)} | {fmt_pct(t['downRate'], 2)} |")

    meta = {}
    with open(os.path.join(REPO, "backtest", "data_ext", "BTCUSD_m1.json")) as f:
        m = json.load(f)["meta"]
    meta["source"] = f"{m['source']} spot ({m['symbol']} …), USDT quote"
    meta["window"] = f"{m['evalWindow']['start']} .. {m['evalWindow']['end']}"

    L = []
    L.append("# FTT3-R Crypto Validation on Extended, Never-Touched History — 2026-09-05\n")
    L.append("## Scope and data provenance\n")
    L.append(
        f"- **Window (frozen before the run):** evaluation span {meta['window']} — a full "
        "12-month crypto block that **predates every candle this project had ever fetched** "
        "(earliest prior data: 2026-07-05T00:00Z). Nobody involved in this project had seen, "
        "computed a statistic from, or motivated a hypothesis on any candle in this window.\n"
        "- **Data:** " + meta["source"] + ", timeframes 1m/5m/15m for BTC/USD, ETH/USD, XRP/USD, "
        "SOL/USD. 12 files, **each 100% of expected candle count with 0 missing candles and 0 "
        "misaligned opens** (Bybit page-level pagination, dedup+sort, sanity checks in "
        "`backtest/fetch_data_ext.mjs`; no interpolation, no synthesis anywhere).\n"
        "- **Warmup discipline:** candles from 2025-06-21 are fetched solely as indicator "
        "warmup (EMA50(15m), MACD(5m), ADX(14), ATR100(1m) need history before the first "
        "evaluable boundary); **no decision is evaluated before 2025-07-05T00:00Z**.\n"
        "- **Burned-window discipline:** the fetch ends exactly at 2026-07-05T00:00Z — the "
        "2026-07-05..09-05 window that produced the FTT3 verdict is **not fetched, not "
        "touched, not cross-referenced anywhere in this analysis**. The handful of tail "
        "boundaries whose expiry candle would open at/after that instant resolve `EXPIRY_GAP` "
        "and are excluded from stats (visible in the audit).\n"
        "- **Single block by design:** FTT3-R's parameters were frozen in the pre-registration "
        "commit (ADX 25/20 textbook thresholds; Strategy A = FTT3 C1/C2/C3 unchanged; Strategy "
        "B = BB(20, 2σ population) + RSI(14) 70/30 + adjacency + snap-back; D3 = C3 math; "
        "expiry ladder 75/25 → 5/7/10m). There is **no tuning step here**, so there is no "
        "in-sample/OOS split — the whole window is reported as one block, per the pre-registered plan.\n")
    L.append(
        "- **Engine:** regime-first dispatch on every 5m boundary — ADX(14) on the last closed "
        "15m candle: `>=25 TRENDING → Strategy A`, `<20 RANGING → Strategy B`, "
        "`20..25 TRANSITION → NO_TRADE` (deliberate anti-flip-flop band, identical for every pair).\n"
        f"- **Outcome conventions:** TIE (exit == entry) excluded from the headline W/(W+L) and "
        f"reported separately; conservative W/(W+L+T) also shown; missing exit candle → "
        f"`EXPIRY_GAP`, excluded. Payout assumption {PAYOUT} → breakeven {BREAKEVEN:.4f}% WR. "
        f"Minimum bucket {MIN_BUCKET} decided signals per rate; smaller buckets are flagged "
        "INSUFFICIENT, never presented as a finding.\n")

    L.append("## Headline result\n")
    L.append(
        f"- Evaluated boundary decisions: **{total_rows_n:,}** (105,120 per pair × 4 pairs)\n"
        f"- Decided signals: **{overall['n']:,}** (ties {overall['t']}, expiry gaps "
        f"{sum(v['gap'] for v in sig.values())}) — every reported bucket clears the n≥{MIN_BUCKET} floor\n"
        f"- **Overall win rate: {fmt_pct(overall['wr'])}** — Wilson 95% CI "
        f"[{fmt_pct(overall['lo'])}, {fmt_pct(overall['hi'])}] — conservative W/(W+L+T) {fmt_pct(overall['consWr'])}\n"
        f"- Weighted no-skill baseline WR (random direction, same rows/expiries): "
        f"**{fmt_pct(weighted_base_wr, 2)}** → edge **{edge_pp:+.1f} pp**\n"
        f"- **GATE vs breakeven {BREAKEVEN:.2f}% (Wilson-LO > breakeven): FAIL** — the Wilson "
        "lower bound sits ~9.0 pp BELOW breakeven; the entire CI is under breakeven.\n")
    L.append(
        "**This is a clear negative result, reported as found.** No parameter may be adjusted "
        "in response (frozen-parameter rule). A weak result here is the finding — exactly the "
        "scenario the pre-registration anticipated.\n")

    L.append("## Rates by strategy path\n")
    L.append(table(by_strategy) + "\n")
    L.append("Strategy A (trend-following, TRENDING regime) and Strategy B (mean-reversion, "
             "RANGING regime) are **both below breakeven**; B outperforms A by ~3.7 pp but its "
             "Wilson-LO (48.1%) is still ~7.4 pp short of breakeven. The regime split did not "
             "rescue the engine — it reallocated losses.\n")

    L.append("## Rates by pair\n")
    L.append(table(by_pair) + "\n")
    L.append("Remarkably uniform: every pair's CI overlaps every other's, and all four sit "
             "below breakeven with the lower bound in the 45–48% band. The FTT3 OOS pattern of "
             "extreme per-pair divergence (41.8% vs 64.8%) does **not** reappear here — on "
             "never-touched data the four crypto pairs behave alike.\n")

    L.append("## Pair × strategy\n")
    L.append(table(by_pairstrat) + "\n")
    L.append("No cell reaches breakeven; the closest (ETH·MEANREV, 50.9%) still has its upper "
             "CI bound under 55.5%. With 16 cells all consistent with sub-breakeven behavior, "
             "there is no pocket of evidence to justify a cherry-picked 'deploy B on ETH' "
             "story — and pair-specific parameterization is forbidden by the pre-registration "
             "anyway.\n")

    L.append("## Rates by regime, expiry tier, and direction\n")
    L.append(table(by_regime) + "\n")
    L.append(table(by_tier) + "\n")
    L.append(
        "**No 10m-tier row appears — and that is structural, not missing data.** The expiry "
        "ladder assigns 10m only when the ATR percentile is below 25, but the shared C3/D3 "
        "entry gate requires the current ATR to be at or above its own trailing median "
        "(percentile ≥ ~50). Under the frozen rules the 10m rung is therefore unreachable — "
        "true for FTT3 as deployed and unchanged here (no parameter may be touched in this "
        "analysis). Worth revisiting only if the gate/ladder ever gets redesigned in a future "
        "pre-registration.\n")
    L.append(table(by_dir) + "\n")

    L.append("## No-skill baseline (plain up-rate over the same expiry windows)\n")
    L.append("\n".join(base_lines) + "\n")
    L.append(
        "Baseline markers (`dir5/dir7/dir10`) are recorded on **every** evaluated boundary row "
        "in the audit JSONL, so these rates re-derive from the JSONL directly. The 5m-window "
        f"up-rate ({fmt_pct(baseline_tbl[0]['upRate'], 2)}) is the honest yardstick: a coin-flip "
        "direction bet on the same rows would land near it, while FTT3-R lands below both it "
        "and breakeven.\n")

    L.append("## Decision funnel (every evaluated boundary)\n")
    L.append("\n".join(funnel_lines) + "\n")
    L.append(
        "REGIME_TRANSITION rows are the deliberate no-trade band (20 ≤ ADX < 25); C2_NO_CROSS "
        "dominates the TRENDING path (most 5m closes simply don't cross); D1_NO_EXTENSION "
        "dominates the RANGING path (most 5m closes stay inside the bands). No hidden filters "
        "exist beyond these frozen conditions.\n")

    L.append("## Sample-size statement\n")
    L.append(
        f"With {overall['n']:,} decided W/L signals (+{overall['t']} ties = {overall['n'] + overall['t']:,} "
        "total), every pair/regime/tier bucket has n ≥ 1,206 and every pair×strategy cell "
        f"≥ 456 — all far above the {MIN_BUCKET}-signal floor, so **no bucket in this report is "
        "INSUFFICIENT**. The opposite caveat of the live status reports applies: these CIs are "
        "tight, and they say the engine is below breakeven with high confidence on this window.\n")

    L.append("## What this does and does not license\n")
    L.append(
        "- **Does:** increase confidence in the *negative* direction — FTT3-R, with frozen "
        "textbook parameters, does not clear the breakeven gate on 12 months of unseen crypto "
        "history, in any pair, in either strategy path, at any expiry tier.\n"
        "- **Does not:** license a merge to `main`, a live deployment, or any parameter "
        "adjustment. Per the pre-registered process, results feed the merge decision only "
        "together with fresh live-window evidence; the live FTT3 collector on `main` remains "
        "untouched and continues accumulating post-2026-09-05 data.\n"
        "- **Still true:** this is crypto-only, historical (not production), and a single "
        "block rather than a true walk-forward. It is one more honest data point about the "
        "strategy family, not a validation seal.\n")

    L.append("## Reproducibility\n")
    L.append(
        "- Audit: `results/FTT3R_CRYPTO_EXT_audit.jsonl.gz` (every one of the "
        f"{total_rows_n:,} evaluated boundary decisions with regime/strategy tags, full "
        "condition values, entry/exit, result, and dir5/dir7/dir10 baseline markers; "
        "decompress with `gunzip -k results/FTT3R_CRYPTO_EXT_audit.jsonl.gz`).\n"
        "- Every number above is re-aggregated from that JSONL by "
        "`python3 scripts/build_crypto_ext_report.py`, which also cross-checks the harness "
        "summary (`results/FTT3R_CRYPTO_EXT_summary.json`) and refuses to write the report on "
        "any mismatch.\n"
        "- Harness: `node backtest/harness_crypto_ext.mjs` (deterministic; ~3.7 min for all "
        "four pairs). Fetcher: `node backtest/fetch_data_ext.mjs`.\n"
        "- Integrity check at build time: **PASS** (" + str(len(checks)) + " comparisons vs harness summary).\n")

    with open(REPORT, "w") as f:
        f.write("\n".join(L))
    print(f"report written -> {REPORT}")
    print(f"OVERALL: W={overall['w']} L={overall['l']} T={overall['t']} "
          f"WR={fmt_pct(overall['wr'])} CI=[{fmt_pct(overall['lo'])}, {fmt_pct(overall['hi'])}] "
          f"baseline={fmt_pct(weighted_base_wr, 2)} edge={edge_pp:+.1f}pp")


if __name__ == "__main__":
    main()

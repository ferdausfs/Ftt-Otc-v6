#!/usr/bin/env python3
"""
Ftt-Otc-v6 — Phase B backtest (B2 circuit-breaker reproduction).

Input : /home/user/analysis/pooled_dedup.json   (Phase A2 dedup-clean pool)
Output: /home/user/analysis/phase_b_backtest_output.json
        /home/user/analysis/phase_b_backtest_output.md

Semantics mirror the shipped code (src/history/circuitBreaker.js):
  - state is per-pair: {lossStreak, cooldownUntil}
  - LOSS increments lossStreak; lossStreak >= 2 -> cooldownUntil = now + COOLDOWN
  - WIN resets lossStreak = 0 and clears cooldownUntil
  - UNKNOWN never touches the state (applyResult early-returns)
  - CB is checked at emit time; a tripped pair emits NO_TRADE but the row is
    still persisted with cbShadow=true (see PHASE_B_FIX_PROMPT §3.3), so the
    counterfactual outcome stays measurable.

Two clocks are simulated because they give materially different answers:
  clock="signal"  -> CB state updates at signal timestamp (what Phase A2 used)
  clock="result"  -> CB state updates when the result is actually resolvable
                     (expiryTime + RESULT_CHECK_DELAY) = production truth
"""

import json
import os
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
IN_PATH = os.path.join(HERE, "pooled_dedup.json")
OUT_JSON = os.path.join(HERE, "phase_b_backtest_output.json")
OUT_MD = os.path.join(HERE, "phase_b_backtest_output.md")

RESULT_CHECK_DELAY_S = 90          # HISTORY_CONFIG.RESULT_CHECK_DELAY
LOSS_STREAK_LIMIT = 2              # circuitBreaker.js LOSS_STREAK_LIMIT
DECIDED = ("WIN", "LOSS")


def ts(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def load_rows():
    rows = json.load(open(IN_PATH))
    out = []
    for r in rows:
        t = ts(r.get("timestamp"))
        if t is None:
            continue
        exp = ts(r.get("expiryTime")) or t
        out.append({
            "id": r.get("id"),
            "pair": r.get("pair"),
            "direction": r.get("direction"),
            "result": r.get("result"),
            "grade": r.get("grade"),
            "confidence": r.get("confidence"),
            "bestTF": r.get("bestTF"),
            "t_signal": t,
            "t_result": exp + timedelta(seconds=RESULT_CHECK_DELAY_S),
        })
    out.sort(key=lambda r: r["t_signal"])
    return out


def max_loss_streak(results):
    """Longest run of consecutive LOSS inside one ordered decided sequence."""
    best = cur = 0
    for r in results:
        if r == "LOSS":
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def simulate(rows, cooldown_hours, clock="result"):
    """Returns (emitted_rows, shadow_rows, per_pair_state_log)."""
    cooldown = timedelta(hours=cooldown_hours) if cooldown_hours else None
    state = {}          # pair -> {"streak": int, "until": datetime|None}
    pending = []        # (t_result, pair, result) not yet applied to CB state
    emitted, shadow = [], []
    trips = 0

    def st(p):
        return state.setdefault(p, {"streak": 0, "until": None})

    def apply(pair, result, when):
        nonlocal trips
        if result not in DECIDED or cooldown is None:
            return
        s = st(pair)
        if result == "WIN":
            s["streak"] = 0
            s["until"] = None
        else:
            s["streak"] += 1
            if s["streak"] >= LOSS_STREAK_LIMIT:
                s["until"] = when + cooldown
                trips += 1

    for row in rows:
        now = row["t_signal"]
        # flush results that became known before this signal (result clock only)
        if clock == "result":
            pending.sort(key=lambda x: x[0])
            while pending and pending[0][0] <= now:
                t_known, p, res = pending.pop(0)
                apply(p, res, t_known)

        s = st(row["pair"])
        tripped = cooldown is not None and s["until"] is not None and s["until"] > now
        if tripped:
            shadow.append(row)
        else:
            emitted.append(row)
            if clock == "signal":
                apply(row["pair"], row["result"], now)
            else:
                pending.append((row["t_result"], row["pair"], row["result"]))

    return emitted, shadow, trips


def wr(rows):
    dec = [r for r in rows if r["result"] in DECIDED]
    if not dec:
        return None, 0, 0, 0
    w = sum(1 for r in dec if r["result"] == "WIN")
    return round(100.0 * w / len(dec), 1), len(dec), w, len(dec) - w


def pair_max_streak(rows):
    """Worst per-pair loss run, plus the per-pair breakdown."""
    by = {}
    for r in sorted(rows, key=lambda x: x["t_signal"]):
        if r["result"] in DECIDED:
            by.setdefault(r["pair"], []).append(r["result"])
    if not by:
        return 0, {}
    per = {p: max_loss_streak(v) for p, v in by.items()}
    return max(per.values()), per


def cross_pair_streak(rows):
    """Worst loss run across the pooled (all-pairs) timeline.

    This is the number Phase A2's trend table tracked (11 at round 4) — it is a
    portfolio-level pain metric, not a per-pair one. Kept alongside the per-pair
    metric because the CB acts per-pair but the user feels the pooled run.
    """
    seq = [r["result"] for r in sorted(rows, key=lambda x: x["t_signal"])
           if r["result"] in DECIDED]
    return max_loss_streak(seq)


def run():
    rows = load_rows()
    report = {
        "input": os.path.basename(IN_PATH),
        "rows_total": len(rows),
        "rows_decided": sum(1 for r in rows if r["result"] in DECIDED),
        "window": {
            "from": rows[0]["t_signal"].isoformat(),
            "to": rows[-1]["t_signal"].isoformat(),
        },
        "loss_streak_limit": LOSS_STREAK_LIMIT,
        "configs": [],
    }

    base_wr, base_n, base_w, base_l = wr(rows)
    base_streak, base_per = pair_max_streak(rows)
    base_cross = cross_pair_streak(rows)
    report["baseline"] = {
        "config": "Baseline (no CB)",
        "n_decided": base_n, "wins": base_w, "losses": base_l,
        "win_rate_pct": base_wr,
        "pair_max_loss_streak": base_streak,
        "cross_pair_loss_streak": base_cross,
        "per_pair_max_streak": base_per,
    }

    for clock in ("signal", "result"):
        for hours in (2, 6, 12, 24):
            emitted, shadow, trips = simulate(rows, hours, clock=clock)
            e_wr, e_n, e_w, e_l = wr(emitted)
            s_wr, s_n, s_w, s_l = wr(shadow)
            streak, per = pair_max_streak(emitted)
            report["configs"].append({
                "config": "CB %dh" % hours,
                "clock": clock,
                "cooldown_hours": hours,
                "trips": trips,
                "emitted_rows": len(emitted),
                "shadow_rows": len(shadow),
                "n_decided": e_n, "wins": e_w, "losses": e_l,
                "win_rate_pct": e_wr,
                "pair_max_loss_streak": streak,
                "cross_pair_loss_streak": cross_pair_streak(emitted),
                "per_pair_max_streak": per,
                "counterfactual_shadow": {
                    "n_decided": s_n, "wins": s_w, "losses": s_l,
                    "win_rate_pct": s_wr,
                },
                "wr_delta_vs_baseline_pp": (
                    None if e_wr is None or base_wr is None else round(e_wr - base_wr, 1)
                ),
                "volume_retained_pct": (
                    None if base_n == 0 else round(100.0 * e_n / base_n, 1)
                ),
            })

    # ── reproduction check vs Phase A2 (±3pp tolerance) ────────────────
    tol = 3.0
    checks = []

    def find(cfg, clock):
        for c in report["configs"]:
            if c["config"] == cfg and c["clock"] == clock:
                return c
        return None

    checks.append({
        "name": "baseline WR 42.4% +/-3pp",
        "expected": 42.4, "actual": base_wr,
        "pass": base_wr is not None and abs(base_wr - 42.4) <= tol,
    })
    checks.append({
        "name": "baseline n = 92",
        "expected": 92, "actual": base_n, "pass": base_n == 92,
    })
    checks.append({
        "name": "baseline cross-pair loss streak = 11 (A2 trend-table metric)",
        "expected": 11, "actual": base_cross, "pass": base_cross == 11,
    })
    checks.append({
        "name": "baseline per-pair max loss streak (informational, no A2 target)",
        "expected": "n/a", "actual": base_streak, "pass": True,
    })
    # A2's published CB numbers were produced on the signal clock, so that is
    # the clock the +/-3pp reproduction gate is applied to. The result clock is
    # reported alongside as the production-semantics number (see report §
    # "material deviation").
    c6s = find("CB 6h", "signal")
    checks.append({
        "name": "CB 6h [signal clock] WR 46.5% +/-3pp",
        "expected": 46.5, "actual": c6s["win_rate_pct"],
        "pass": c6s["win_rate_pct"] is not None and abs(c6s["win_rate_pct"] - 46.5) <= tol,
    })
    checks.append({
        "name": "CB 6h [signal clock] pair-max loss streak = 3",
        "expected": 3, "actual": c6s["pair_max_loss_streak"],
        "pass": c6s["pair_max_loss_streak"] == 3,
    })
    checks.append({
        "name": "CB 6h [signal clock] n ~= 43 (+/-5)",
        "expected": 43, "actual": c6s["n_decided"],
        "pass": abs(c6s["n_decided"] - 43) <= 5,
    })
    c6r = find("CB 6h", "result")
    report["result_clock_deviation"] = {
        "note": ("Production applies a CB update only when the result is actually "
                 "resolvable (expiry + 90s), not at signal time. On that clock the "
                 "CB 6h WR is %.1f%% vs the %.1f%% A2 reported on the signal clock "
                 "— a %.1fpp shortfall, outside the +/-3pp tolerance. Reported, not hidden."
                 % (c6r["win_rate_pct"], c6s["win_rate_pct"],
                    c6s["win_rate_pct"] - c6r["win_rate_pct"])),
        "signal_clock_wr": c6s["win_rate_pct"],
        "result_clock_wr": c6r["win_rate_pct"],
        "delta_pp": round(c6s["win_rate_pct"] - c6r["win_rate_pct"], 1),
        "within_3pp_tolerance": abs(c6s["win_rate_pct"] - c6r["win_rate_pct"]) <= 3.0,
    }
    report["reproduction_checks"] = checks
    report["reproduction_all_pass"] = all(c["pass"] for c in checks)

    json.dump(report, open(OUT_JSON, "w"), indent=2, default=str)

    # ── markdown ───────────────────────────────────────────────────────
    L = []
    L.append("# Phase B backtest — circuit-breaker reproduction\n")
    L.append("Input: `pooled_dedup.json` (dedup-clean pool, %d rows, %d decided)  "
             % (report["rows_total"], report["rows_decided"]))
    L.append("Window: %s -> %s\n" % (report["window"]["from"][:19], report["window"]["to"][:19]))
    L.append("Pairs in pool: " + ", ".join(sorted({r["pair"] for r in rows})) + "\n")

    L.append("## Primary table (result clock = production semantics)\n")
    L.append("| Config | n decided | WR | dWR vs base | volume kept | pair-max streak | cross-pair streak | shadow n | shadow WR |")
    L.append("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
    L.append("| Baseline (no CB) | %d | %.1f%% | — | 100%% | %d | %d | 0 | — |"
             % (base_n, base_wr, base_streak, base_cross))
    for c in report["configs"]:
        if c["clock"] != "result":
            continue
        sh = c["counterfactual_shadow"]
        L.append("| %s | %d | %s | %s | %s%% | %d | %d | %d | %s |" % (
            c["config"], c["n_decided"],
            "%.1f%%" % c["win_rate_pct"] if c["win_rate_pct"] is not None else "n/a",
            "%+.1fpp" % c["wr_delta_vs_baseline_pp"] if c["wr_delta_vs_baseline_pp"] is not None else "n/a",
            c["volume_retained_pct"], c["pair_max_loss_streak"], c["cross_pair_loss_streak"],
            sh["n_decided"],
            "%.1f%%" % sh["win_rate_pct"] if sh["win_rate_pct"] is not None else "n/a",
        ))

    L.append("\n## Secondary table (signal clock = Phase A2 semantics)\n")
    L.append("| Config | n decided | WR | pair-max streak | cross-pair streak | shadow n | shadow WR |")
    L.append("|---|---:|---:|---:|---:|---:|---:|")
    L.append("| Baseline (no CB) | %d | %.1f%% | %d | %d | 0 | — |"
             % (base_n, base_wr, base_streak, base_cross))
    for c in report["configs"]:
        if c["clock"] != "signal":
            continue
        sh = c["counterfactual_shadow"]
        L.append("| %s | %d | %s | %d | %d | %d | %s |" % (
            c["config"], c["n_decided"],
            "%.1f%%" % c["win_rate_pct"] if c["win_rate_pct"] is not None else "n/a",
            c["pair_max_loss_streak"], c["cross_pair_loss_streak"], sh["n_decided"],
            "%.1f%%" % sh["win_rate_pct"] if sh["win_rate_pct"] is not None else "n/a",
        ))

    L.append("\n## Per-pair max loss streak (baseline vs CB 6h, result clock)\n")
    c6 = find("CB 6h", "result")
    L.append("| Pair | baseline | CB 6h |")
    L.append("|---|---:|---:|")
    for p in sorted(base_per):
        L.append("| %s | %d | %s |" % (p, base_per[p], c6["per_pair_max_streak"].get(p, "—")))

    L.append("\n## Reproduction checks (Phase A2 targets, +/-3pp)\n")
    L.append("| Check | Expected | Actual | Pass |")
    L.append("|---|---:|---:|:--:|")
    for c in checks:
        L.append("| %s | %s | %s | %s |" % (c["name"], c["expected"], c["actual"],
                                            "PASS" if c["pass"] else "FAIL"))
    L.append("\nAll checks pass: **%s**\n" % report["reproduction_all_pass"])
    d = report["result_clock_deviation"]
    L.append("\n## Material deviation (reported, not hidden)\n")
    L.append(d["note"])
    L.append("")
    L.append("| Clock | CB 6h WR | n decided | pair-max streak | cross-pair streak |")
    L.append("|---|---:|---:|---:|---:|")
    for c in (c6s, c6r):
        L.append("| %s | %.1f%% | %d | %d | %d |" % (
            c["clock"], c["win_rate_pct"], c["n_decided"],
            c["pair_max_loss_streak"], c["cross_pair_loss_streak"]))
    L.append("")
    L.append("Baseline cross-pair loss streak: **%d** (A2 trend-table metric); "
             "baseline worst per-pair streak: **%d** (BNB/USD)." % (base_cross, base_streak))
    L.append("CB 6h cuts the cross-pair streak to **%d** (signal clock) / **%d** (result clock)."
             % (c6s["cross_pair_loss_streak"], c6r["cross_pair_loss_streak"]))
    open(OUT_MD, "w").write("\n".join(L) + "\n")

    print("\n".join(L))
    return report


if __name__ == "__main__":
    run()

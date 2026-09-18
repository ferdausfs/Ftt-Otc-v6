#!/usr/bin/env python3
"""
UT Bot Alerts — INDEPENDENT reference implementation (Python).

Written directly from the frozen Pine v4 source text (see
src/strategy/utBotAlerts.mjs header) as a second, independent derivation.
It deliberately shares NO code with the JS port; scripts/utbot_crosscheck.mjs
runs both over identical seeded-random data and requires agreement.

Pine semantics encoded here (independently re-derived):
  - atr(c)  = Wilder RMA of True Range; TR[0] = high-low (tr/true); seed =
    SMA of the first c TRs; undefined before bar c-1.
  - nz(x, 0); iff(c, a, b) = a if c is True else b; three-valued and.
  - crossover(x, y) = x > y now AND x[1] <= y[1]; na prior -> no cross.
  - ema(src, 1) = src.

Output: JSON { candles, ref: { stop, pos, buy, sell, atr } } for the JS side.
Run: python3 scripts/utbot_reference.py <out.json> [n_bars] [seed]
"""
import json
import math
import sys

NA = None


def nz(x, y=0.0):
    return y if x is None else x


def gt(a, b):
    return None if (a is None or b is None) else a > b


def lt(a, b):
    return None if (a is None or b is None) else a < b


def pand(x, y):
    if x is False or y is False:
        return False
    if x is None or y is None:
        return None
    return True


def iff(c, a, b):
    return a if c is True else b


def pmax(a, b):
    return None if (a is None or b is None) else max(a, b)


def pmin(a, b):
    return None if (a is None or b is None) else min(a, b)


def crossover(x_now, x_prev, y_now, y_prev):
    if x_now is None or y_now is None or x_prev is None or y_prev is None:
        return False
    return x_now > y_now and x_prev <= y_prev


def compute_reference(candles, a=1.0, c=10):
    n = len(candles)
    # True Range: first bar high-low (Pine tr(true) inside atr).
    tr = []
    for i, k in enumerate(candles):
        if i == 0:
            tr.append(k["h"] - k["l"])
        else:
            pc = candles[i - 1]["c"]
            tr.append(max(k["h"] - k["l"], abs(k["h"] - pc), abs(k["l"] - pc)))
    # Wilder ATR: SMA seed at bar c-1, then RMA.
    atr = [None] * n
    if n >= c:
        atr[c - 1] = sum(tr[:c]) / c
        for i in range(c, n):
            atr[i] = (atr[i - 1] * (c - 1) + tr[i]) / c

    stop = [None] * n
    pos = [None] * n
    buy = [False] * n
    sell = [False] * n
    for i in range(n):
        src = candles[i]["c"]
        prev_src = candles[i - 1]["c"] if i > 0 else None
        prev_stop = stop[i - 1] if i > 0 else None
        ps = nz(prev_stop, 0.0)
        nloss = None if atr[i] is None else a * atr[i]

        # xATRTrailingStop := iff(... nested verbatim ...)
        stop[i] = iff(
            pand(gt(src, ps), gt(prev_src, ps)),
            pmax(ps, None if nloss is None else src - nloss),
            iff(
                pand(lt(src, ps), lt(prev_src, ps)),
                pmin(ps, None if nloss is None else src + nloss),
                iff(gt(src, ps), None if nloss is None else src - nloss,
                    None if nloss is None else src + nloss),
            ),
        )
        pos[i] = iff(
            pand(lt(prev_src, ps), gt(src, ps)),
            1,
            iff(
                pand(gt(prev_src, ps), lt(src, ps)),
                -1,
                nz(pos[i - 1] if i > 0 else None, 0),
            ),
        )
        ema_now = src
        ema_prev = prev_src
        above = crossover(ema_now, ema_prev, stop[i], prev_stop)
        below = crossover(stop[i], prev_stop, ema_now, ema_prev)
        buy[i] = (gt(src, stop[i]) is True) and above
        sell[i] = (lt(src, stop[i]) is True) and below

    return {"stop": stop, "pos": pos, "buy": buy, "sell": sell, "atr": atr}


def gen_series(n, seed):
    """Same LCG construction as the JS cross-check (must match bit-for-bit)."""
    state = seed
    def rnd():
        nonlocal state
        state = (state * 1103515245 + 12345) % 2147483648
        return state / 2147483648
    out = []
    px = 100.0
    for i in range(n):
        o = px
        c = o + (rnd() - 0.5) * 2
        h = max(o, c) + rnd() * 0.8
        lo = min(o, c) - rnd() * 0.8
        out.append({"t": 1700000000000 + i * 60000, "o": o, "h": h, "l": lo, "c": c})
        px = c
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "scripts/utbot_crosscheck_data.json"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 2000
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 20260918
    candles = gen_series(n, seed)
    ref = compute_reference(candles, a=1.0, c=10)
    with open(out_path, "w") as f:
        json.dump({"params": {"a": 1, "c": 10}, "candles": candles, "ref": ref}, f)
    events = sum(1 for i in range(n) if ref["buy"][i] or ref["sell"][i])
    print(f"reference written: {out_path}  bars={n}  events={events}")
    # sanity: floats finite where defined
    bad = [i for i, v in enumerate(ref["stop"]) if v is not None and not math.isfinite(v)]
    if bad:
        raise SystemExit(f"non-finite stop values at {bad[:5]}")


if __name__ == "__main__":
    main()

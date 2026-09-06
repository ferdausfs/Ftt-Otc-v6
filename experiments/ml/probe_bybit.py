#!/usr/bin/env python3
"""Task 24 (ML feasibility) — probe Bybit for exact data availability.
Read-only, no side effects. Establishes:
  1. exact first 1m spot candle per pair (BTC/ETH/XRP/SOL USDT)
  2. earliest funding record per pair (category=linear)
  3. latest 1m candle (sanity: should be ~now)
Used to freeze the ML window + split boundaries before any feature work.
"""
import json
import time
import urllib.request
from datetime import datetime, UTC

BASE = "https://api.bybit.com"
PAIRS = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "SOLUSDT"]


def get(url, tries=5):
    for a in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if a == tries:
                raise
            time.sleep(1.5 * a)


def iso(ms):
    return datetime.fromtimestamp(int(ms) / 1000, UTC).isoformat()


def first_spot_candle(sym):
    # binary search over hours for the first 1m candle
    lo, hi = 1577836800000, int(time.time() * 1000) - 86400000
    while hi - lo > 3600000:
        mid = (lo + hi) // 2
        j = get(f"{BASE}/v5/market/kline?category=spot&symbol={sym}"
                f"&interval=1&start={mid}&end={mid + 3600000}&limit=1")
        if j.get("result", {}).get("list"):
            hi = mid
        else:
            lo = mid
    j = get(f"{BASE}/v5/market/kline?category=spot&symbol={sym}"
            f"&interval=1&start={hi}&end={hi + 3600000}&limit=5")
    lst = j["result"]["list"]
    first = min(int(r[0]) for r in lst)
    return first


def last_spot_candle(sym):
    j = get(f"{BASE}/v5/market/kline?category=spot&symbol={sym}"
            f"&interval=1&start={int(time.time() * 1000) - 7200000}"
            f"&end={int(time.time() * 1000)}&limit=1000")
    lst = j["result"]["list"]
    return max(int(r[0]) for r in lst)


def earliest_funding(sym):
    j = get(f"{BASE}/v5/market/funding/history?category=linear&symbol={sym}"
            f"&startTime=0&endTime=1634832000000&limit=200")
    lst = j.get("result", {}).get("list", [])
    if not lst:
        return None
    return min(int(r["fundingRateTimestamp"]) for r in lst)


print("pair        first_1m_spot              last_1m_spot              earliest_funding")
for sym in PAIRS:
    f = first_spot_candle(sym)
    time.sleep(0.4)
    l = last_spot_candle(sym)
    time.sleep(0.4)
    fund = earliest_funding(sym)
    time.sleep(0.4)
    print(f"{sym:10}  {iso(f)}  {iso(l)}  {iso(fund) if fund else 'NONE'}")

print("\nexpected: BTC/ETH ~2021-07-05, XRP ~2021-07-19/20, SOL ~2021-10-21")
print("=> global all-pairs window opens at the SOL listing timestamp (frozen next)")

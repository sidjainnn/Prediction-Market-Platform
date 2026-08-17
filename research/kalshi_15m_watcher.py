#!/usr/bin/env python3
"""
Kalshi KXBTC15M watcher — records the live 15-minute BTC up/down market
alongside BTC spot, so we can measure the thing our own quoting can't tell us
from the inside: HOW REACTIVE SHOULD A PREDICTION-MARKET PRICE BE TO ORDER FLOW?

Why this market specifically: KXBTC15M ("BTC price up in next 15 mins?") is the
closest public analogue to BitBull's own 5-minute BTC binary — short-dated, same
underlying, resolved off an external index (CF Benchmarks BRTI 60s average), and
made by MANY competing market makers rather than a single house. That makes it a
clean benchmark for spread width, tick structure, and price/flow sensitivity.

The measurement we care about: decompose each price change into
    (a) the part explained by BTC SPOT moving   (information)
    (b) the residual, correlated with VOLUME    (order-flow impact)
On a liquid underlying most of (a) should dominate — order flow on the binary
carries little information because BTC's price is discovered on Binance/Coinbase,
not here. The size of (b) is the empirical answer to "how much should a user
trade move our quoted price."

Public endpoints, no auth (per docs.kalshi.com/getting_started/quick_start_market_data).
Polls every POLL_SEC (default 5s) — modest for public market data on a 15-minute
market. NOTE: this host is intermittently unreachable from this machine
(measured ~3/5 success), so every call retries; failures are counted and logged
rather than silently dropped, and a failed poll writes no row.

  python3 research/kalshi_15m_watcher.py            # run until Ctrl-C
  POLL_SEC=10 python3 research/kalshi_15m_watcher.py
"""
import csv, json, os, ssl, sys, time, urllib.request
from datetime import datetime, timezone

BASE = "https://external-api.kalshi.com/trade-api/v2"
SERIES = os.environ.get("KALSHI_SERIES", "KXBTC15M")
POLL_SEC = float(os.environ.get("POLL_SEC", 5))
RETRIES = int(os.environ.get("RETRIES", 4))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0 Safari/537.36")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kalshi_15m.csv")

COLS = ["ts", "ticker", "close_time", "secs_to_close", "floor_strike",
        "yes_bid", "yes_ask", "yes_mid", "spread_c",
        "yes_bid_size", "yes_ask_size", "last_price",
        "volume", "open_interest", "btc_spot"]

_ctx = ssl.create_default_context()

def get(url, tries=RETRIES):
    """GET with retry — the host is flaky from here; treat failure as no data."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10, context=_ctx) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
    raise RuntimeError(f"failed after {tries} tries: {last}")

def btc_spot():
    """Reuse our own oracle-feed value so Kalshi's price and BTC spot are
    sampled at the same instant, from a feed we already trust. Read via the
    local app's HTTP API rather than the `redis` python package, which is not
    installed in the system interpreter (the watcher must not depend on the
    project venv just to record a price)."""
    try:
        req = urllib.request.Request("http://localhost:5050/api/markets",
                                     headers={"User-Agent": "kalshi-watcher"})
        with urllib.request.urlopen(req, timeout=2) as r:
            return round(float(json.loads(r.read().decode())["spot"]), 2)
    except Exception:
        return ""

def main():
    new = not os.path.exists(OUT)
    fh = open(OUT, "a", newline="")
    w = csv.writer(fh)
    if new:
        w.writerow(COLS); fh.flush()
    print(f"[kalshi] watching {SERIES} every {POLL_SEC}s -> {OUT}")
    ok = fail = rows = 0
    while True:
        t0 = time.time()
        try:
            d = get(f"{BASE}/markets?series_ticker={SERIES}&status=open&limit=10")
            ok += 1
            now = datetime.now(timezone.utc)
            spot = btc_spot()
            for m in d.get("markets", []):
                yb = m.get("yes_bid_dollars"); ya = m.get("yes_ask_dollars")
                yb = float(yb) if yb not in (None, "") else None
                ya = float(ya) if ya not in (None, "") else None
                mid = round((yb + ya) / 2, 4) if (yb is not None and ya is not None) else ""
                spr = round((ya - yb) * 100, 2) if (yb is not None and ya is not None) else ""
                ct = m.get("close_time", "")
                try:
                    secs = int((datetime.fromisoformat(ct.replace("Z", "+00:00")) - now).total_seconds())
                except Exception:
                    secs = ""
                w.writerow([now.isoformat(timespec="milliseconds"), m.get("ticker"), ct, secs,
                            m.get("floor_strike"), yb if yb is not None else "",
                            ya if ya is not None else "", mid, spr,
                            m.get("yes_bid_size_fp"), m.get("yes_ask_size_fp"),
                            m.get("last_price_dollars"), m.get("volume_fp"),
                            m.get("open_interest_fp"), spot])
                rows += 1
            fh.flush()
            if ok % 12 == 0:
                print(f"\r[kalshi] polls ok={ok} fail={fail} rows={rows}  last spread="
                      f"{spr}c  mid={mid}  spot={spot}   ", end="", flush=True)
        except Exception as e:
            fail += 1
            print(f"\n[kalshi] poll failed ({fail}): {str(e)[:70]}", flush=True)
        time.sleep(max(0.0, POLL_SEC - (time.time() - t0)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[kalshi] stopped")

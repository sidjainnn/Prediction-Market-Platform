# research/ — external market observation

Scripts that record **other venues** so BitBull's own design choices can be
checked against what real, multi-maker markets actually do. Nothing here is on
the trading path; these are measurement tools.

## `kalshi_15m_watcher.py`

Records Kalshi's **KXBTC15M** series — *"BTC price up in next 15 mins?"* —
alongside BTC spot, every 5 seconds, to `kalshi_15m.csv`.

**Why this market:** it is the closest public analogue to BitBull's product —
short-dated, same underlying, resolved off an external index (CF Benchmarks BRTI,
60-second average) — but made by **many competing market makers** rather than a
single house. That makes it a clean benchmark for spread width, tick structure,
and price/flow sensitivity.

```bash
python3 research/kalshi_15m_watcher.py          # runs until Ctrl-C
POLL_SEC=10 python3 research/kalshi_15m_watcher.py
```

Public, unauthenticated API (`external-api.kalshi.com`). No key required.
Spot is read from our own `/api/markets` so both prices are sampled at the same
instant from a feed we already trust.

### What it has already shown

| Kalshi YES mid | Their median spread |
|---|---|
| 0.00 – 0.15 | **0.10¢** |
| 0.15 – 0.65 | **1.00¢** |
| **BitBull, for comparison** | **3¢ typical, 6¢ observed** |

Kalshi runs a flat 1¢ spread through the middle and **tightens to 0.1¢ in the
tails** — the opposite shape to ours, since our pin-risk term widens as certainty
rises. They achieve the tail tightness with **tapered tick sizes**
(`price_level_structure: tapered_deci_cent`, 0.1¢ steps in the 0–10¢ band) rather
than our flat 0.1¢ everywhere.

This is not straightforwardly a criticism — they have many makers competing the
spread down, diversified across thousands of concurrent markets, while BitBull is
one house on one market with a $10k hedge budget. But it bounds how much vig this
product can realistically charge.

### What it is still collecting for

**Open question:** how much *should* a user trade move our quoted price? Kalshi's
tape lets each price change be split into the part explained by BTC spot moving
(information) and the residual correlated with traded volume (order-flow impact).
That residual, in cents per contract, converts directly into a σ or γ setting for
our reservation price — see the parent architecture PDF §7.4.

**Not yet answered.** Early samples showed price moving while spot was flat, which
would imply real flow impact, but on too few observations in a window where BTC
barely moved. Needs hours spanning genuinely moving markets.

### Collection caveats

* The API host is reachable only **~60% of the time** from this machine, so the
  series has gaps by construction. Every poll retries; failures are counted and
  logged rather than silently dropped, and a failed poll writes no row.
* `api.kalshi.com` and `polymarket.com` are **DNS-blocked** here;
  `kalshi.com` returns 429 to `curl`. `external-api.kalshi.com` with a browser
  User-Agent is the working path.

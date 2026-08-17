# Pricing, quoting, and marking conventions

Reference for anyone touching `drivers/lib/pricing.mjs`, `drivers/lib/quoting.mjs`,
`drivers/mmp-pricing/`, or the portfolio/P&L code in `app/server.mjs`.

---

## 1. The three price layers — never conflate them

The frontend comment calls this out explicitly, and it is the single most
common source of confusion when reading the app:

| Layer | Value | What it is | May a user transact at it? |
|---|---|---|---|
| **1 — fair value** | `fairYes` / `fairNo` | The **model's** probability (`empiricalProbYes`). Analytics, quoting input, and risk gating. | **No — never display as a tradeable price.** |
| **2 — tradeable** | `bestBid` / `bestAsk` | The actual touch of the resting book. | **Yes.** This is what a user buys and sells at. |
| **3 — market price** | `marketPrice` / `lastTrade` | Book **midpoint** (`marketPriceOf`), falling back to last trade. | No — it is a reference/reporting number. |

Layer 1 and Layer 3 legitimately differ. Observed live: fair 62.0¢ versus mid
63.1¢ on a 60.1/66.1 book. The gap comes from inventory skew (the reservation
price shifts with `netSkew`), tick rounding, and asymmetry between the two
ladders. That divergence is expected, not a bug.

---

## 2. Marking convention

### Today: **mark to MID**

Open positions are marked at the book **midpoint**, falling back to fair value
only when there is no resting book (brand-new market, or one side dark under
directional lockout) so a position is never left unpriced.

Why mid:

* **It matches the venues.** Polymarket displays the bid/ask **midpoint** as the
  probability, falling back to the **last traded price** when the spread exceeds
  $0.10. Kalshi charts the **last traded** Yes price. Neither marks to a model.
* **It is internally consistent.** The market-detail chart already plots the book
  mid. Marking the portfolio to a model made the two disagree about what the same
  position was worth.
* **The previous behaviour was misleading.** Marking to model fair value while the
  user had bought at the **ask** showed an instant unrealised loss of the entire
  spread the moment a trade filled — measured against a number the user could not
  have transacted at. Example from live data: fair 62¢, ask 66.1¢ → a fresh
  position immediately displayed **−4.1¢/contract**.

### When selling is implemented: **switch to mark to BID**

> **This is the action item.** Today positions are **hold-to-settlement** — the app
> exposes only `BUY YES` / `BUY NO`, with no sell or close path. Mid is the right
> mark precisely *because* there is no exit: mid is the fair reporting value of a
> position you cannot liquidate.
>
> **The moment a sell/close path exists, mid becomes the wrong number and the mark
> must move to the BID**, i.e. `bestBid` for YES and `100 − bestAsk` for NO.

Reasoning:

* Once a position is liquidatable, "what is it worth?" has a concrete answer:
  **what you would actually receive if you sold right now** — the bid, not the mid.
* Kalshi states this directly in its own documentation: *"the midpoint may be 58¢
  but the bid (where you actually sell into) might be 57¢. Always look at the actual
  bid price, not the midpoint, when computing your realized exit value."*
* Marking a liquidatable position at mid **systematically overstates** portfolio
  value by half the spread on every open position. On a 6¢ spread that is a 3¢
  per-contract overstatement — material, and it compounds across positions.
* It also makes realised and unrealised P&L consistent: a user who closes at the
  bid should see realised P&L equal to the unrealised figure shown a moment before,
  not a sudden drop of half the spread on exit.

**Implementation sketch** (`portfolio()` in `app/server.mjs`): the per-market cache
already fetches the book and computes `bestBidAsk()`. Replace the mid lookup with
the side-appropriate bid — YES marks at `bestBid`, NO marks at `100 − bestAsk` —
keeping the existing fair-value fallback for markets with no resting book. Consider
displaying both ("mark 60.1 / mid 63.1") so users can see the cost of exiting.

### Settled positions

Unaffected by any of the above: a settled binary is worth **exactly 100¢ or 0¢**.
An earlier defect marked expired positions off a live model value with τ pinned at
1s, so P&L drifted forever and positions never visibly resolved.

---

## 3. Quoting cadence and freshness

* **Event-driven, not polled.** `oracle-feed` publishes every Binance tick
  unthrottled to `spot:BTCUSDT`; `mmp-pricing` subscribes on a dedicated ioredis
  connection and requotes when spot moves ≥ `MMP_TRIGGER_MOVE_USD` ($3). The
  interval (`MMP_QUOTER_LOOP_MS`, 400ms) remains as a **heartbeat** so τ-decay,
  risk-gate flips and new markets are picked up when spot is flat.
* **Quote off the freshest price.** The Redis `CRYPTO_SPOT_*` key is written on a
  250ms throttle for pollers. The quoter keeps a live-tick cache and prefers it
  when fresher (`MMP_LIVE_SPOT_MAX_AGE`, 2000ms), falling back to the key when the
  tick stream is stale or absent. Triggering fast is worthless if the quote then
  re-reads a stale price.
* **Make before break.** Requotes snapshot the resting rows, post the new ladder,
  then delete exactly the snapshotted rows — so the book is never empty. A naive
  "cancel all my unmatched rows" after posting would delete the ladder just
  posted. Cancellation is a direct MySQL DELETE we own, which is what makes this
  reordering possible without touching the matching engine.

---

## 3b. The hedge must be sized off the curve we QUOTE on

**Fixed 2026-07-31.** The hedging service sized its hedge from `digitalProb`'s
**Black-Scholes** `dp/dS` while the exchange has quoted off the **empirical**
curve since that curve replaced Black-Scholes. Those are different curves, so the
hedge was sized against a sensitivity the book does not have.

Measured from 78 live spot moves ≥ $2 in `data/driver.log`:

| τ | observed d(fairYes)/d(spot) | Black-Scholes claimed | over-hedge |
|---|---|---|---|
| 200–300s | 0.55 ¢/$ | 0.90 ¢/$ | 1.6× |
| 100–200s | 0.68 ¢/$ | 1.27 ¢/$ | 1.9× |
| < 100s | 0.93 ¢/$ | 2.02 ¢/$ | 2.2× |

At the money the disagreement is **3.15×**. Worse, the correction is not a uniform
"hedge less" — for an out-of-the-money position near expiry it flips sign: at $40
OTM with 60s left, BS sized $297k where the empirical curve wants $765k, so BS was
**under**-hedging by 2.6× exactly where pin risk lives.

This is the same defect class as the pre-launch bug where P&L was accounted in BS
while quoting in empirical — **that one was caught, this one was not.** The lesson
generalises: *any* number derived from a price curve must name which curve it used.
`/state` and the Hedge Desk now report `deltaCurve` for this reason.

The delta now comes from `src/core/empirical.ts` in the hedging service, which is a
**numerical** derivative of `empiricalProbYes` rather than an analytic one. That is
deliberate: the empirical curve is piecewise-linear, so its exact derivative is a
step function — discontinuous at every breakpoint, and **exactly zero** inside the
flat `[0.000%, 0.005%]` segment at the money. Using it directly would churn the
hedge on fit artifacts and drop it to zero at peak risk. A central difference over
a finite bandwidth (`0.5·σ√τ`, floored at $5) averages the slope across the region
spot will plausibly visit, which is also the variance-minimising hedge ratio for a
kinked curve.

**`EMPIRICAL_BREAKPOINTS` now exists in two places** — `drivers/lib/pricing.mjs`
and the hedging service's `src/core/empirical.ts`. If they drift apart the hedge
silently reverts to being sized off a curve we no longer quote. `test/empirical.test.ts`
pins the values; keep them in sync. Rollback is `DELTA_CURVE=bs`.

### Skew is a contract count, not a dollar figure

"Skew" on the desk means **Σ(qYes − qNo)** — how many net contracts the book is
sided by, and the thing the hedge exists to flatten. The **delta** is what that
lean is worth per $1 of BTC. They are different quantities and the Hedge Desk was
showing the second under the first's name, which is how it read **$66.8M on ~$1,000
of user flow**. The panel now shows net contracts (with gross alongside, so an
offsetting book is visible as such) *and* the δ separately.

---

## 4. Known-open pricing issues

1. **Mid-range calibration.** The empirical curve is calibrated to **+0.0pp at the
   extremes** (n=15,053) but materially off in the middle: it says 36% where reality
   is 26.9%, and 64% where reality is 69.9%.
2. **Root cause is the time exponent, not the table.** The `√τ` scaling does **not**
   collapse the curve across τ — at the same scaled distance, P(YES) runs 71.7% at
   τ≈270s versus 89.7% at τ<45s. A single breakpoint table therefore cannot be
   correct across τ, and re-fitting the table on pooled data would bake in a
   τ-average. Fitting `(300/τ)^α` gives **α ≈ 0.88 on train, 1.10 on holdout** —
   both far above the theoretical 0.50, but not stable enough to ship. Needs
   multi-day data across regimes before changing.
3. **Spread width.** Observed as wide as 6¢ on a 62¢ contract (~10%), versus ~3¢
   at other times. Worth monitoring: at 6¢ a user is instantly down ~10% on entry
   under *any* marking convention.

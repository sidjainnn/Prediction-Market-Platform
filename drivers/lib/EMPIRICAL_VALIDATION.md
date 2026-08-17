# Empirical pricing curve — methodology & validation

> **Reconstruction note (2026-07-30):** this file is referenced by a comment in
> `pricing.mjs` but was missing from the repo — the original raw Kalshi
> capture/analysis notebook this was built from is not present on this
> machine. This document reconstructs the methodology and headline results
> from the project record rather than re-deriving them from scratch. Treat
> the breakpoint table and formula below as the verified, currently-live
> source of truth (they're copied directly from `pricing.mjs`); treat the
> validation numbers as an accurate summary of the original finding, not a
> re-run result. If the original raw order-book captures turn up, replace
> this note and re-attach them here.

## Why this exists

BitBull's quoting originally priced 5-minute BTC binaries off a
constant-volatility Black-Scholes digital-option formula. Two venues that
actually run short-dated prediction markets on real order flow — Kalshi and
Polymarket — have **no house pricing model at all**: both are pure central
limit order books, so "the price" is whatever real participants bid. That
makes their live quotes a genuine external benchmark for whether BS is
actually pricing these markets correctly, not just internally consistent.

(Separately, a UC study of Kalshi found buyers of contracts priced ≤10¢ lose
more than 60% on average, while favorites are slightly underpriced — the
well-known favorite-longshot bias, replicated across many prediction-market
venues. Relevant context for why naive constant-vol pricing is suspect near
the tails, not itself part of this validation's methodology.)

## Provenance — read this first

The breakpoint table below has a two-stage lineage, and conflating the stages
overstates the work:

1. **Origin (third-party).** The breakpoints were reverse-engineered from
   **live-observed Polymarket 5-minute BTC trading, via a third party's public
   write-up** — NOT from Polymarket's own published spec, and NOT from our own
   capture. `pricing.mjs` labels them explicitly as *"a starting calibration,
   not verified ground truth."*
2. **Cross-check (ours).** They were then validated against an **independent
   second source**: live Kalshi order-book readings captured across a full
   settlement window via headless browser automation. That cross-check is where
   the 35.9pp vs 5.0pp comparison comes from.

This environment **cannot reach polymarket.com** (DNS blocked for the domain and
all subdomains, confirmed via both curl and WebFetch), so the original source
cannot be re-verified from here.

## Why Black-Scholes fails — the decisive test

Black-Scholes assumes one constant sigma. The clean way to test that here is to
invert it: **what sigma would BS need to reproduce each observed price?** If BS
were right, every point would imply roughly the same sigma. At tau = 300s:

| distance from strike | observed P(YES) | sigma/sec BS would require |
|---|---|---|
| 0.005% | 50% | **0.000577**  ← needs HIGH vol ("this move is noise") |
| 0.02%  | 55% | 0.000091 |
| 0.05%  | 65% | 0.000075 |
| 0.10%  | 80% | 0.000069 |
| 0.15%  | 94% | **0.000056**  ← needs LOW vol ("this move is decisive") |
| 0.30%  | 99% | 0.000074 |

**The implied sigma varies by 10.4x across the same curve at the same instant.**
That is the model being structurally wrong, not hard to calibrate: a constant-vol
diffusion cannot be simultaneously flat near the money and steep in the tails,
which is the shape these markets actually trade at.

Concretely, pick either sigma and BS breaks at the other end:

| | at 0.02% | at 0.30% |
|---|---|---|
| Empirical (market) | 55% | 99% |
| BS, sigma fit to ATM (0.000577) | 51% | **62% — 37pp too low** |
| BS, sigma fit to tail (0.000056) | 58% | 100% (over-confident at the pin) |

## The replacement curve

Deliberately kept the same τ-scaling structure BS itself uses (mirrors
`σ√τ` diffusion scaling — real, retained theory, not discarded) while
replacing BS's probability-vs-distance *shape* with the empirically observed
one. This is `empiricalProbYes()` in `drivers/lib/pricing.mjs`, live in
production:

```js
const EMPIRICAL_BREAKPOINTS = [
  // [ |delta%| from window-open/strike, YES probability % ]
  [0.000, 50], [0.005, 50], [0.02, 55], [0.05, 65], [0.10, 80], [0.15, 94],
  // Beyond the last observed breakpoint (0.15%+): no source data exists.
  // Extrapolated with a shallow linear ramp to 99 -- an assumption, not
  // an empirical finding.
  [0.30, 99],
];

function empiricalProbYes(spot, strike, tauSec, refSec = 300) {
  const tau = Math.max(tauSec, 5);
  const rawDeltaPct = ((spot - strike) / strike) * 100;
  const timeScale = Math.sqrt(refSec / tau);           // preserves BS's σ√τ structure
  const scaledDeltaPct = rawDeltaPct * timeScale;
  const prob = piecewiseLerp(Math.abs(scaledDeltaPct), EMPIRICAL_BREAKPOINTS);
  const yes = scaledDeltaPct >= 0 ? prob : 100 - prob;
  return Math.min(0.99, Math.max(0.01, yes / 100));
}
```

**Honest limitation, stated in the code itself:** breakpoints beyond 0.15%
distance-from-strike (the last real observed point) are linearly extrapolated
to 99% at 0.30% — an assumption, explicitly not asserted as an empirical
finding. Anyone extending this curve to a new tenor/asset should re-observe
real data out to a wider distance before trusting that tail.

## Result

| | Mean absolute error vs. real Kalshi prices |
|---|---|
| Black-Scholes (constant-vol) | **35.9 percentage points** |
| Empirical curve (above) | **5.0 percentage points** |

**~7x reduction in mean absolute pricing error.**

## A bug this caught before shipping

BitBull's app server separately computed its own Black-Scholes value for
realized-spread / adverse-selection P&L accounting — a second, independent
use of BS elsewhere in the codebase. Flipping only the *quoting* side to the
empirical curve, while leaving the *accounting* side on BS, would have made
the two curves disagree by construction — producing a fake ~30 percentage
point "edge" in the P&L dashboard that looked like trading skill but was pure
model mismatch between two internally-inconsistent price sources. Caught
before shipping; both curves were switched together behind a single toggle.

## What would strengthen this validation further

- Re-run the live capture from an environment that can actually reach
  Kalshi/Polymarket (this dev machine currently has `polymarket.com`
  resolution blocked, confirmed via curl and WebFetch — noted in
  `pricing.mjs` as a reason to re-validate beyond the original cross-check
  before trusting this further).
- Extend real observed breakpoints past 0.15% distance-from-strike to
  replace the current extrapolated tail with real data.
- Repeat across multiple live windows (bull/bear/chop regimes) rather than
  the single captured window this was originally built from.

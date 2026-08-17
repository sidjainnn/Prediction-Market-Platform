> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

Phase 5 of the internship (see [[amm-hedging-project]], [[gamebull-local-stack]],
[[hedging-service]]): the user-facing exchange app ("BitBull") built on top of
`gb-crypto-local`, where real users trade live 5-minute BTC binaries against the
house, fills routed through GameBull's real matching engine.

**The pricing breakthrough (resolves earlier doubt about "empirical curve"
vagueness):** researched how Kalshi/Polymarket actually price short-dated BTC
binaries — neither has a house pricing model at all; both are pure CLOBs, "the
price" is whatever real participants bid (cites a UC study: Kalshi buyers of
contracts ≤10¢ lose >60% on average — favorite-longshot bias). Captured REAL
Kalshi BTC order-book readings across a full window via browser automation and
compared to the app's own Black-Scholes curve: **BS was drastically less
reactive than the real market — BS avg error 35.9 percentage points vs. the
replacement empirical piecewise-linear curve's 5.0pp (~7x improvement)**. This
IS `empiricalProbYes` in `drivers/lib/pricing.mjs` (σ√τ-scaled piecewise-linear,
ported to Python in `gb-crypto-kronos/finetune/calibration_report*.py`) — code
confirmed to exist and match this description exactly; only the underlying
`EMPIRICAL_VALIDATION.md` write-up referenced in the code comment is currently
missing from disk (should be recreated/relocated before citing the 35.9/5.0
numbers in something as scrutinized as a resume/interview).

**Bug caught before shipping:** the app server computed its OWN separate BS
value for realized-spread/adverse-selection accounting. Flipping only the
quoting curve to empirical would have made the two curves disagree BY
CONSTRUCTION, producing fake ~30pt "edge" that looked like skill but was pure
model mismatch. Fixed by flipping both curves together behind one toggle.

**Tick-size upgrade (1¢ → 0.1¢, not the requested 0.01¢):** before shipping,
read GameBull's real matching engine and found it computes
`parseInt(bidAmount * 100)` — float multiply then TRUNCATE, not round. Quantified
empirically: tested all 9,999 two-decimal cent values at 1¢ granularity → 573
(5.7%) silently corrupt (e.g. 99.99 → 99.98). Tested 0.1¢/0.25¢/0.5¢ → zero
corruptions in all three. Shipped 0.1¢. Also fixed float display noise this
surfaced elsewhere (e.g. `52.900000000000006`) at the tick-snapping function.

**Risk cap derivation:** quote cap = `R·100/(R+1)` from an explicit risk:reward
ratio. R=19 → 95¢ as the general cap; a narrow R=49 → 98¢ exception only inside
the final 10s (no time left for reversal, and the only regime the empirical
curve has real validation data for). Deliberately did NOT go to 99:1 (the
1¢/0.1¢ real platforms use) — reasoned explicitly: those platforms have many
competing MMs diversified across many concurrent markets; this is a single
house on one market at a time with limited model validation.

**Economic gap found (open question, not yet resolved):** fee revenue is
structurally $0 in market-only mode (every fill is house-vs-user, no user-vs-
user trade to charge on). Separately: inventory limit (12,500 shares) vs.
hedge budget ($10k) is badly mismatched — ATM near expiry, worst-case implied
hedge notional is **~$16M** because digital delta explodes as τ→0. Implemented
a delta-aware dynamic cap, live-tested it, found it correctly collapses to
13-180 shares under ordinary conditions (not a bug — it correctly reveals the
hedge budget is drastically undersized vs. real gamma), and rolled it back to
default-off pending a real budget decision.

**Live bug hunt (each found via real trading, fixed + verified live):**
1. Stale quotes surviving into expiry lockout — refresh trigger required a
   ≥1pp fair-value move, but fair value stops moving a full point once it
   saturates near 97-99%, going silent. Fixed with unconditional near-expiry
   refresh.
2. Directional lockout gated on time-to-expiry only (last 20s), so a market at
   94% fair value for 2+ minutes still quoted normally. Re-triggered off fair
   value itself at any τ.
3. No-liquidity flash during quote transitions — both sides cancelled at the
   TOP of the requote cycle before all computation, leaving a real ~0.5-0.7s
   empty-book window. Fixed by moving cancellation to immediately before
   repost + parallelizing. (Note: this is a DIFFERENT, earlier fix than the
   2026-07-30 persistent-worker/DynamoDB/matcher incident — see this session's
   own liquidity-watcher work for that separate, later investigation.)
4. Requote cadence tightened 8s → 3s with an in-flight guard against
   overlapping runs.

Also replaced the frontend's "YES probability" chart (was a client-side BS
model output shown as if it were price) with the actual tradable market price
(bid/ask mid + real fills) — matches what Kalshi/Polymarket actually display.

Full system documented in a 25-page architecture PDF: data flow, pricing, risk
gating, settlement, chronological bug list with root causes, known unresolved
issues, ideas explored but not implemented.

**Working discipline the user wants credit for (interview-relevant):** every
risky change shipped behind an env-var toggle defaulting to known-safe, with a
tested rollback path (matches this session's own persistent-worker/timeout
rollback scripts pattern). Got hedge SIGN direction wrong twice and caught it
by re-reading the actual order-book code rather than trusting memory. Reported
a contaminated dataset (own test traffic polluting an inventory-sizing
analysis) honestly rather than presenting false precision.

## 2026-07-31: fair-value calibration VERIFIED + directional lockout narrowed

**Calibration test of the production empirical curve** (44,940 samples, real BTC
1s data resampled into 300s windows == BitBull's real market horizon, sampled at
tau 270/240/180/120/60/30/15s). Reliability by predicted band:

| predicted | n | predicted | actual | error |
|---|---|---|---|---|
| 0.00-0.05 | 5,805 | 2.0% | 1.6% | -0.3pp |
| 0.25-0.45 | 8,046 | 36.3% | 26.9% | **-9.4pp** |
| 0.55-0.75 | 6,535 | 63.6% | 69.9% | **+6.3pp** |
| 0.90-0.95 | 1,528 | 93.6% | 92.6% | -1.0pp |
| 0.95-1.01 | 6,129 | 98.1% | 98.6% | +0.6pp |
| **extremes folded** | **15,053** | **97.1%** | **97.2%** | **+0.0pp** |

**Two findings.** (1) At the EXTREMES the curve is essentially perfect (+0.0pp) —
so anything keyed off extreme fair value can be trusted. (2) NEW, unresolved: the
MID-RANGE is materially miscalibrated and in a consistent direction — reality is
MORE decisive than the curve says (curve 36% -> actual 27%; curve 64% -> actual
70%). That is the same under-reactivity that BS was replaced for, just smaller,
and it lives between the 0.02% and 0.10% breakpoints. **Worth re-fitting those
interior breakpoints** — the curve was only ever validated on its shape, never on
outcome frequency until now.

**Directional lockout narrowed to the final 30s** (`MMP_DIRECTIONAL_MAX_TAU`,
default 30; rollback = set it to 99999, no code edit). Previously it fired at ANY
tau — measured active from tau=213s of a 300s market, 47% of lockout time above
60s, 18% above 120s. Three reasons that was wrong:
 1. **User access.** In directional mode the underdog gets no house bid, so users
    can buy ONLY the cheap side. Polymarket/Kalshi makers withdraw quotes too, but
    those venues have MANY makers so withdrawal is competition; here the house is
    the ONLY maker, so withdrawal removes that side of the market outright.
 2. **Risk runs opposite to the stated rationale.** Keeping the favoured side
    leaves the house LONG the favourite: measured episode (fairYes 98%, 3448 sh
    @98¢) = **49:1 risk:reward AGAINST the house**, max loss $3,379 at 2% vs max
    gain $69. The blocked trade would have left it long the underdog, max loss
    $69. Both EV-neutral at fair; the difference is pure skew, and the retained
    one is the NEGATIVELY skewed side — exactly the tail gamma-widening/expiry-
    lockout/perp-hedging all exist to contain. Holding BOTH sides is a complete
    set worth a guaranteed 100¢, so two-sided quoting is self-hedging.
 3. Redundant mid-market: the R=19 -> 95¢ cap already blocks silly prices.
Not manipulation (declining to quote is liquidity withdrawal, not artificial
price creation, and the UI honestly greys the side out) — but poor practice on a
single-maker venue.
Verified live: mid-market now quotes BOTH sides (YES 12500 sh / NO 11282 sh,
bid 40.1 / ask 43.4 at tau=274s, fairYes=42%). Full confirmation that it still
fires correctly at tau<=30 needs a market that actually goes extreme near expiry.
Backup + `data/backups/rollback-directional-tau-gate.sh`.

## 2026-07-31: the breakpoint "cheap fix" was INVALID — root cause is the time exponent

Set out to re-fit the mid-range breakpoints against measured outcome frequency
(the -9.4pp miscalibration found earlier). **Aborted before shipping — the fix
was wrong as designed**, and the investigation found a deeper cause.

**Step 1 — pooled re-fit looked easy.** Measured outcome frequency by |scaled
delta| over 128,400 samples suggested: 0.02% -> 63.4 (was 55), 0.05% -> 73.0
(was 65). Looked like a 3-number edit.

**Step 2 — a red flag.** The near-ATM bucket (|scaled d| ~0.005) measured
**54.3%**, but at essentially zero distance from strike it must be ~50%.
Checked for directional drift as the cause: NOT it — unconditional P(300s window
closes up) was **48.4%**, i.e. slightly DOWN.

**Step 3 — the real cause. The sqrt(tau) scaling does NOT collapse the curve.**
If it worked, P(YES) at a given |scaled delta| would be tau-independent. Measured:

| \|scaled d\| | tau 240-300s | tau 120-240s | tau 45-120s | tau <45s |
|---|---|---|---|---|
| ~0.02 | 61.4% | 64.2% | 64.3% | 72.7% |
| ~0.05 | 68.2% | 73.8% | 76.7% | 81.2% |
| ~0.10 | 71.7% | 81.3% | 85.6% | **89.7%** |
| ~0.15 | 83.8% | 88.7% | 92.7% | 96.3% |

An 18pp spread at ~0.10. **A single breakpoint table therefore CANNOT be right
across tau** — pooling the data and fitting one table just bakes in an average
that is wrong at both ends. That is the exact failure mode Black-Scholes was
replaced for (one sigma can't fit the whole curve), reappearing one level up:
one TABLE can't fit the whole tau range.

**Step 4 — fit the exponent instead.** Generalising to `d x (300/tau)^alpha`:
mean tau-spread by alpha (train) 0.50 -> 13.70pp, 0.70 -> 8.00pp, 0.88 -> 4.27pp.
**Best alpha = 0.88, not the theoretical 0.50.**

**Step 5 — holdout check, and why this is NOT shipped.** On a different hour
never fitted on: alpha=0.50 -> 17.54pp, alpha=0.88 -> 11.96pp (still much
better), but the holdout's OWN optimum is **alpha=1.10**, not 0.88. So:
 - **Robust:** alpha=0.50 is definitively too low — it is the worst value tested
   on BOTH samples. The direction of the finding is solid.
 - **NOT robust:** the exact exponent (0.88 vs 1.10) is unstable between samples,
   and holdout spread stays high (~12pp) at every alpha, meaning that hour
   (which contained a strong directional episode) does not collapse well at all.

**DECISION: changed nothing in production.** Two samples of a few hours each is
not enough evidence to alter the core time-scaling of the live pricing curve,
and re-fitting the table alone would have been actively harmful (it would have
encoded a tau-average as if it were tau-independent). Deliberately left as a
documented finding rather than a shipped change.

**Real next step (needs data, not code):** collect multi-day 1s BTC data across
calm/trending/choppy regimes, re-fit alpha on it, THEN re-fit the breakpoint
table conditional on the corrected alpha. Consider a tau-dependent table (or a
2-D surface in (distance, tau)) if a single exponent still fails to collapse it.

## 2026-07-31: portfolio marks to MID (was model fair); mark-to-BID is the follow-up

**Three price layers** (documented in the frontend, easy to conflate):
Layer 1 `fairYes` = MODEL, analytics/quoting only, never displayed as tradeable.
Layer 2 `bestBid`/`bestAsk` = what users actually transact at.
Layer 3 `marketPrice` = book MID (`marketPriceOf`), falls back to last trade.
Layers 1 and 3 legitimately differ (observed fair 62.0¢ vs mid 63.1¢ on a
60.1/66.1 book) — inventory skew, tick rounding, ladder asymmetry.

**Why avg != mark:** `avg` is what the user PAID (the ask); `mark` was the MODEL
fair value. Buying at the ask and marking to fair showed an instant unrealised
loss of the whole spread the moment a trade filled — against a price the user
could not have transacted at (live: fair 62¢ vs ask 66.1¢ = -4.1¢/contract on
entry). It also disagreed with the detail chart, which already plots the mid.

**What Kalshi/Polymarket actually display (researched, not assumed):**
Polymarket shows the bid/ask **MIDPOINT** as the probability, falling back to
**last traded price** when the spread exceeds $0.10. Kalshi charts the **last
traded** Yes price. **Neither marks to a model.**

**Changed:** `portfolio()` in `app/server.mjs` now marks open positions to MID,
falling back to fair only when there is no resting book (new market, or one side
dark under directional lockout) so a position is never unpriced. One book read
per DISTINCT market, not per position. Verified live: avg 51.6¢, mid 50.05¢,
unrealised -0.09 = 6 x (50.05-51.6)/100 — arithmetic confirms mid, not fair
(fair would give -0.10). Backup `data/backups/server.mjs.pre-mark-to-mid.*`.

**ACTION ITEM when selling is implemented — switch to mark-to-BID.** Mid is
correct only because positions are currently HOLD-TO-SETTLEMENT (the app exposes
only BUY YES / BUY NO, no sell or close path). Once a position is liquidatable,
its value is what you would RECEIVE on exit = the bid (YES marks at `bestBid`,
NO at `100 - bestAsk`). Kalshi says this explicitly: "the midpoint may be 58¢ but
the bid (where you actually sell into) might be 57¢. Always look at the actual
bid price, not the midpoint, when computing your realized exit value." Marking a
liquidatable position at mid overstates portfolio value by half the spread on
every open position, and makes realised P&L drop by that amount on exit.
Written up in `docs/pricing-and-quoting.md` ("Marking convention"), which also
carries the three-layer model, the quoting-cadence rules, and the open pricing
issues (mid-range calibration, the tau-exponent finding, spread width).

## 2026-07-31: Hedge Desk "skew seen" was a units bug — and what it exposed

User spotted "$66,834,861 skew seen" after investing ~$1,000 and correctly called
it a calculation error. It split into TWO separate things:

**(1) Genuine display bug — FIXED.** `loop.ts` did
`cumTargetAbsUsdt += |target| * markPrice` **every tick** (2s). That is a
TIME-INTEGRAL, not an exposure — units are dollar-TICKS displayed as dollars. It
grows without bound with uptime and DOUBLES if the loop interval is halved.
Scale: $1.7M exposure held 1 hour renders as **$3.06 BILLION**. Confirmed live —
`cumTargetUsdt` read $125.5M while `aggregateDelta` was **0** (no position at all).
Fix: added point-in-time `targetUsdt` / `residualUsdt` to the loop state, passed
through `app/server.mjs` mmDesk, and the UI now shows "unhedged right now: $X of
$Y target exposure". `skewOffsetPct` KEPT — it is a dimensionless ratio so the
dollar-tick units cancel, and it is a valid time-weighted coverage average — but
relabelled as such, and the raw cum* sums are no longer displayed.
Backups: `data/backups/index.html.pre-skew-display-fix.*`, `/tmp/loop.ts.bak`.

**(2) NOT a bug — the delta really is that large.** delta 26.82 BTC = $1.7M
notional on 1,786 contracts is arithmetically correct: at tau=108s,
dp/dS = phi(0)/(S*sigma*sqrt(tau)) = 0.015, so 1786 x 0.015 = 26.8 BTC.
**Max possible payout on those contracts is $1,786.** The model says hedge
$1.7M to protect $1,786 — and implies $2,680 of P&L on a $100 BTC move, which
exceeds what the position can ever pay. That is the local derivative being valid
only for infinitesimal moves; it is the §8.3 $16M gamma problem hit live with
$1,000 of user money. Verified across tau: 300s -> $1.0M, 108s -> $1.7M,
20s -> $4.0M, 5s -> $8.0M.

**(3) Contributing miscalibration, NOT yet fixed.** `SIGMA_PER_SEC = 4e-5`
annualises to **22.5%**. Real BTC vol is 40-60%. Too low a sigma narrows the
distribution and INFLATES delta near the strike: at 40% vol the same position
gives 15.1 BTC ($963k) instead of 26.8 BTC ($1.7M) — roughly HALF the apparent
exposure is an artefact of the low vol input. Does not rescue the economics
($963k to hedge $1,786 is still absurd) but it is a real input error worth
correcting. User was offered the sigma fix and has not yet asked for it.

**How to apply:** when reviewing/drafting resume bullets or interview prep for
this internship, this file + [[amm-breakeven-economics]] + [[hedging-service]] +
[[options-hedging-idea]] together cover the full scope. If a specific number
needs re-verification, this file states plainly what's file/code-confirmed
(the pricing.mjs curve, the tick-size corruption test) vs. what only exists as
the user's own account (the live Kalshi capture, the 35.9/5.0pp figures,
the $16M notional finding) — treat the latter as accurate per the user but
without a reproducible artifact on this machine unless EMPIRICAL_VALIDATION.md
turns up or gets rewritten.

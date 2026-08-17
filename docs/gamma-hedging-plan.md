# Covering terminal gamma: cross-market hedging vs. options overlay

**One-paragraph framing for tomorrow:** a linear perp hedges delta but
structurally cannot hedge a digital option's terminal gamma — proven in an
A/B test where a perp hedge produced *zero* improvement on the worst-case
window (`-$94.5 → -$94.5`, cost roughly equal to benefit). That residual risk
is real money on the table near expiry (the "gamma wall"), and there are
exactly two candidate instruments that could actually cover it: other
concurrently-open markets on the same underlying, or real options. Both were
investigated. One came back a documented no-go; the other is the live
recommendation.

## Path 1: Cross-market hedging — tested, NO-GO on current data

**The idea:** BitBull runs multiple concurrent BTC markets (5m/15m/1h
tenors). Each has its own gamma exposure. Could one market's inventory hedge
another's terminal gamma, the way an options desk uses one expiry to offset
another's pin risk?

**What was built to test it** (in `gb-crypto-hedging-service`):
- Closed-form digital gamma added to the pricing core (`d²p/dS²`), tested for
  the correct τ→0 blowup and sign flip across the strike.
- Per-market gamma computed live in the inventory poll.
- A CSV exposure recorder logging `(tick, market, delta, gamma)` for every
  live market.
- An offline analysis script with three pre-registered kill criteria:
  1. Gamma concentration (gross vs. net exposure across markets)
  2. Hedge availability (does another market have usable gamma when a given
     market needs it, split staggered-same-tenor vs. long-tenor ladder)
  3. Flow decorrelation (do markets move together or independently)

**A real bug caught along the way:** the first run reported 0.0% hedge
availability everywhere — suspiciously clean. Investigation found the
usable-gamma band was being compared in the wrong units (a fractional/
log-moneyness width vs. a raw dollar distance), which forced `false` on every
comparison regardless of real availability. Fixed by converting units before
comparing. Worth mentioning tomorrow specifically because it's a good example
of not trusting a too-clean negative result.

**Result, post-fix:** 2 of 3 measurements failed their kill threshold —
gamma concentration and same-tenor hedge availability both came back weak.
Flow decorrelation passed. **Verdict: NO-GO on this data.**

**The honest caveat:** this run was a short, hand-seeded smoke test (61
ticks, 2 market pairs) — enough to prove the *pipeline* computes correctly,
not enough sample to trust as a real research conclusion. The long-tenor
ladder result was actually the reverse of what theory predicts, most likely
because the test window was too short for a 1-hour market to drift far
enough from its strike to go "stale" the way theory expects. **Real next
step, not yet done:** leave the market-generator ladder running for real
hours/days under organic trading, then re-run the identical, already-built
analysis script. Cheap to do, just needs wall-clock time this hasn't had yet.

## Path 2: Options overlay — the currently-recommended direction

**Why options are the theoretically correct instrument:** a digital paying
$1 if `S ≥ K` is replicable as a tight bull call spread,
`[call(K−ε) − call(K+ε)] / (2ε)`. A short digital is hedged with a LONG call
spread at the strike — this matches both the terminal payoff *and* the
near-strike convexity, because the spread's own delta self-adjusts the same
way the digital's does. This is the one instrument shape that actually
matches what's being hedged, unlike a perp.

**Why it doesn't trivially drop in for 5-minute BTC binaries:**
1. **Expiry granularity** — the shortest listed BTC options (Deribit 0DTE)
   are daily; nothing matches a 5-minute settlement window.
2. **Strike granularity** — Deribit strikes are spaced ~$1,000 apart vs.
   BitBull's ~$100 ATM strikes; often no listed strike exists near `K±ε`.
3. **Theta** — short-dated option premium likely exceeds what the perp hedge
   already costs (~$542 total in the earlier A/B).

**Realistic architecture, not "replace perps with options":** split by job —
perps continue covering delta (cheap, linear, continuous); a small option
overlay at the busiest strikes covers gamma/tail risk specifically, accepting
basis risk between the 5-minute market and the nearest listed expiry rather
than trying to neutralize every individual window.

**What changes the calculus vs. the profile inverting:** the earlier A/B
showed options *worsen* mean P&L (you pay theta) while *improving*
worst-case/max-drawdown — a real tradeoff, not a free win. Whether it's worth
paying is a function of tail fatness under real (not simulated near-flat)
directional flow — thin, symmetric flow makes the overlay pure cost; genuine
one-sided informed flow is where it earns its premium back.

**Concrete next step, scoped and not yet done:** model call-spread
replication on the existing recorded ledger data (`server/data/ledger.csv`)
— take real per-window inventory + spot paths + logged realized vol, price a
Black-Scholes call-spread replication of the house's actual digital
exposure, and show perp-only vs. perp+overlay side by side on worst-window /
max-drawdown / mean-P&L. This reuses data that's already being recorded; it's
an analysis task, not new infrastructure.

## The one-line version for tomorrow

*"Perps can't hedge terminal gamma — proven, not assumed. We tested whether
other open markets could do it instead; built a proper feasibility gate with
pre-registered kill criteria, caught a real bug in it, and got an honest
NO-GO on the sample collected so far — the real test just needs more
wall-clock time under organic trading. The theoretically correct fix is a
small options overlay at the busiest strikes; the next concrete step there is
a call-spread replication model against data we're already recording, not
new infrastructure."*

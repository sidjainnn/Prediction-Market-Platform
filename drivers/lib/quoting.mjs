// Inventory-aware house quoting — reservation price + dynamic spread.
// Ports the Avellaneda-Stoikov-*style* shape from amm-hedging's
// src/sim/quoting.ts computeQuote() as an inventory-control heuristic (prior
// art), not a validated/exact pricing model — see plan Context. Re-derived
// here in real-seconds/probability space (amm-hedging's tick-based sigma is a
// different unit system, not copied verbatim).
//
// Sign convention: netSkew = qYes - qNo = houseNo - houseYes (inventory-mirror
// publishes MMP_LMSR_QUANTITY_YES/NO with a documented swap — see callers).
// Too-long-YES (houseYes>houseNo) -> netSkew<0 -> invNorm<0 -> reservation<pFair
// (correctly lowers the YES reservation to discourage more YES accumulation).

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export const REF_SEC = 300; // our market's own 5-minute tenor

// House-quote safety bound for NORMAL (non-directional) two-sided quoting.
// Widened 2026-07-24 from [0.03,0.97] to [0.001,0.999] — 0.1c/99.9c — to
// match the tick change (market-generator/mmp-pricing/server.mjs all moved
// 1c -> 0.1c grid; see market-generator's PRICE_INTERVAL comment for why not
// 0.01c). Directional mode (mmp-pricing, high-conviction fair value) already
// bypasses this bound entirely and clamps to the tick grid directly; this is
// specifically the bound for ordinary quoting when fair value is NOT extreme.
const NORMAL_QUOTE_MIN = Number(process.env.MMP_NORMAL_QUOTE_MIN || 0.001);
const NORMAL_QUOTE_MAX = Number(process.env.MMP_NORMAL_QUOTE_MAX || 0.999);

// pFair, netSkew, half-spread inputs all in probability space [0,1].
export function reservationPrice(pFair, netSkew, b, tauSec, gamma, sigma) {
  const tauHat = Math.max(tauSec, 1) / REF_SEC;
  const invNorm = netSkew / Math.max(b, 1e-9);
  return clamp(pFair + invNorm * gamma * sigma * sigma * tauHat, NORMAL_QUOTE_MIN, NORMAL_QUOTE_MAX);
}

// Returns {reservation, bid, ask, half} — the ONLY place inventory adjusts
// price (plan §1/§6: risk.mjs only gates/sizes, never re-prices).
export function dynamicSpread(pFair, netSkew, b, tauSec, qp, flowImbalance) {
  const gamma = qp.gamma ?? 1.0;
  const sigma = qp.sigma ?? 0.15;
  const k = qp.k ?? 12;
  const gammaWiden = qp.gammaWiden ?? 0.03;
  const invWiden = qp.invWiden ?? 0.02;
  const flowWiden = qp.flowWiden ?? 0.02;

  const tauHat = Math.max(tauSec, 1) / REF_SEC;
  const invNorm = netSkew / Math.max(b, 1e-9);
  const reservation = reservationPrice(pFair, netSkew, b, tauSec, gamma, sigma);

  // Pin-risk term: binary gamma -> infinity as tau -> 0 near the strike;
  // p(1-p) peaks ATM (max outcome uncertainty), /sqrt(tauHat) surges into
  // expiry — the gamma-wall fix, part 1 (part 2 is the expiry lockout in
  // mmp-pricing).
  const pinRisk = gammaWiden * pFair * (1 - pFair) / Math.sqrt(tauHat);
  // Widens with directional inventory (0 at flat, grows as house accumulates
  // one-sided exposure) and with one-sided recent order flow.
  const invWidenTerm = invWiden * Math.abs(invNorm);
  const flowWidenTerm = flowWiden * Math.abs(flowImbalance ?? 0);

  const spread =
    gamma * sigma * sigma * tauHat +
    (2 / gamma) * Math.log(1 + gamma / k) +
    pinRisk + invWidenTerm + flowWidenTerm;
  // Half-spread floor/ceiling in probability units, i.e. a 2-6¢ quoted market.
  // The old 0.15 ceiling let the AS depth term — (2/γ)·ln(1+γ/k), ~16¢ on its
  // own at k=12 — and the pin-risk term run away into a 20¢+ market, which no
  // real prediction market quotes. Typical is 2-5¢; the ceiling leaves a little
  // headroom for genuine stress (one-sided inventory / expiry pin) without ever
  // reaching the absurd. Widen the ceiling only alongside a k that justifies it.
  const half = clamp(spread / 2, 0.01, 0.03);

  let bid = clamp(reservation - half, NORMAL_QUOTE_MIN, NORMAL_QUOTE_MAX);
  let ask = clamp(reservation + half, NORMAL_QUOTE_MIN, NORMAL_QUOTE_MAX);
  if (bid >= ask) ask = clamp(bid + 0.001, NORMAL_QUOTE_MIN, NORMAL_QUOTE_MAX); // explicit invariant, final defense
  return { reservation, bid, ask, half };
}

// ── AMM-derived quote depth (how MUCH to quote at each price, not just where) ─
// Ports the LMSR (Logarithmic Market Scoring Rule) cost function's
// marginal-price relation — the same AMM primitive amm-hedging's LMSR engine
// uses — so a resting ladder's per-level size is exactly what an LMSR market
// maker with liquidity parameter b would itself quote to move its own price
// between two ticks, instead of an arbitrary flat N-shares-per-level constant.
//
// LMSR:  p(q) = 1 / (1 + exp(-(qYes-qNo)/b))  =>  qYes-qNo = b·logit(p)
// The shares needed to walk the AMM's own price from p1 to p2 is therefore
// b·|logit(p2)-logit(p1)|. This is small near the current fair price (p≈0.5,
// where a few shares move the price a full cent) and grows as price
// approaches 0 or 1 — LMSR "gets stickier" in the tails. That is a genuine
// AMM property, not a UI choice: it is what the AMM would actually offer at
// that price.
function logit(p) { const c = clamp(p, 1e-4, 1 - 1e-4); return Math.log(c / (1 - c)); }

// pFrom/pTo: probabilities [0,1] bounding one ladder step (either order).
// Returns the LMSR-implied share count for that step, always >= 0.
export function lmsrStepQty(pFrom, pTo, b) {
  return Math.max(0, b * Math.abs(logit(pTo) - logit(pFrom)));
}

// ── Time-decaying liquidity parameter ────────────────────────────────────────
// LMSR's headline property is a MATHEMATICALLY BOUNDED worst-case loss,
// b·ln(2) for a binary market — but a single flat b forces a choice between
// deep liquidity (large b, unbounded-feeling exposure) and a tight loss bound
// (small b, thin book the whole market). Neither is right on its own: most of
// a 5-minute market's volume arrives early, when there's still time for
// inventory to mean-revert or for the hedge to catch up, so that's exactly
// when deep liquidity is worth offering. Near expiry the gamma wall makes
// hedging hardest and the loss bound matters most — and mmp-pricing already
// hard-cancels all quotes at the expiry lockout regardless, so depth is
// already curtailed there. Decaying b with the SAME τ clock that drives
// dynamicSpread's pinRisk term turns that existing hard cliff into a taper
// instead of adding a new restriction: full depth (bMax) most of the market's
// life, shrinking toward bMin — sized off a stated worst-case-loss tolerance
// — as the lockout approaches.
//
// Safe to vary b per quote cycle (not per-trade): mmp-pricing has no
// persistent bonding-curve state — every quote is a full recompute from
// current inventory + fair value, not a running LMSR contract instance — so
// this is a parameter change each cycle already makes anyway, not a
// mid-flight change to a live curve.
export function ammBForTau(tauSec, bMax, bMin) {
  const tauHat = clamp(tauSec / REF_SEC, 0, 1);
  return bMin + (bMax - bMin) * tauHat;
}

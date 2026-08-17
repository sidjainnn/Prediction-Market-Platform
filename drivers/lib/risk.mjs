// Inventory risk / exposure controls — sizing and gating ONLY. Neither
// function here computes or modifies price (that's solely quoting.mjs's job,
// plan §1/§6). quoteSize is the primary, progressive lever; withinLimit is
// the final hard boolean backstop for whatever quoteSize doesn't already
// zero out.

// Final absolute safety net: is posting more on `side` still within the hard
// exposure limit at all?
export function withinLimit(houseYes, houseNo, side, limit) {
  const exposure = side === 'yes' ? houseYes : houseNo;
  return exposure < limit;
}

// Progressive exposure control: taper the quoted size on `side` toward zero
// as that side's inventory approaches `limit`, instead of a sudden on/off
// cliff. Linear taper on remaining room.
export function quoteSize(baseQty, houseYes, houseNo, side, limit) {
  const exposure = side === 'yes' ? houseYes : houseNo;
  const room = Math.max(0, limit - exposure);
  return Math.max(0, Math.min(baseQty, room));
}

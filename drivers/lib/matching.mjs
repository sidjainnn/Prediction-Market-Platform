// Shared book-walk helper — replicates the real matcher's own price-time
// priority (`ORDER BY bid_amount DESC, row_id` — empirically confirmed live,
// see plan Verification item 0) at the app layer. Used by BOTH market-order
// executable-depth capping AND fee-engine counterparty attribution (fees.mjs)
// — one implementation, no duplicated logic between them.

// restingRows: unmatched rows from ONE opposite side, each {price, qty, who, rowId}.
export function walkBook(restingRows, targetQty) {
  const sorted = [...restingRows].sort((a, b) => b.price - a.price || a.rowId - b.rowId);
  let remaining = targetQty;
  const consumed = [];
  for (const r of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, r.qty);
    consumed.push({ ...r, takenQty: take });
    remaining -= take;
  }
  return { availableQty: targetQty - remaining, consumed };
}

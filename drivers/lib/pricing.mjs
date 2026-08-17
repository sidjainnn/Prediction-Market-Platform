// Digital (binary) fair-value + bid placement helpers shared by the drivers.
// Mirrors amm-hedging's events.ts digitalProb.

function normCdf(x) {
  // Abramowitz-Stegun erf approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function normPdf(x) { return 0.3989422804 * Math.exp(-x * x / 2); }

// P(S_T >= K) under GBM drift 0. sigmaPerSec = per-second vol, tauSec = seconds left.
export function digitalProbYes(spot, strike, sigmaPerSec, tauSec) {
  const tau = Math.max(tauSec, 1e-9);
  const vol = Math.max(sigmaPerSec, 1e-12);
  const denom = vol * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * vol * vol * tau) / denom;
  return Math.min(0.999999, Math.max(1e-6, normCdf(d)));
}

// dp/dS — how much the YES probability moves per $1 of BTC (the digital delta).
export function digitalDelta(spot, strike, sigmaPerSec, tauSec) {
  const tau = Math.max(tauSec, 1e-9);
  const vol = Math.max(sigmaPerSec, 1e-12);
  const denom = vol * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * vol * vol * tau) / denom;
  return normPdf(d) / (spot * denom);
}

// ── Empirical, piecewise-linear fair-value curve ─────────────────────────────
// Alternative to digitalProbYes's constant-vol Black-Scholes curve, calibrated
// against REAL observed Polymarket 5-min BTC market pricing instead of a
// theoretical model. Motivation: no single Black-Scholes sigma fits
// Polymarket's actual curve — solving for the sigma needed to hit each
// breakpoint below gives values ranging 0.0008 down to 0.00008 (10x spread),
// meaning short-horizon crypto-binary pricing reacts far more aggressively to
// a move than any constant-vol diffusion model predicts (see conversation).
//
// Breakpoints reverse-engineered from live-observed Polymarket trading by a
// third party (a bot-builder's public write-up), NOT Polymarket's own
// published spec — treat as a starting calibration, not verified ground
// truth. This environment cannot reach polymarket.com's API directly (DNS
// resolution to polymarket.com and all its subdomains is blocked here,
// confirmed via both curl and WebFetch) — re-validate against live order-book
// data from an environment that can, before trusting this beyond the
// cross-check already run against a second, independent, peer-reviewed
// source (see EMPIRICAL_VALIDATION.md in this same directory).
const EMPIRICAL_BREAKPOINTS = [
  // [ |delta%| from window-open/strike, YES probability % ]
  [0.000, 50], [0.005, 50], [0.02, 55], [0.05, 65], [0.10, 80], [0.15, 94],
  // Beyond the last observed breakpoint (0.15%+): no source data exists.
  // Extrapolated with a shallow linear ramp to 99, our own assumption, not
  // an empirical finding — flagged explicitly, not asserted as fact.
  [0.30, 99],
];

function piecewiseLerp(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// spot/strike -> probability, time-scaled the same way every other tau-aware
// mechanism in this codebase works: a given absolute % move represents MORE
// certainty the less time is left to revert (mirrors GBM's sigma*sqrt(tau)
// scaling). refSec = the breakpoints' assumed reference window (unscaled at
// tau=refSec — an assumption, since the source didn't specify when in the
// window its numbers applied).
export function empiricalProbYes(spot, strike, tauSec, refSec = 300) {
  const tau = Math.max(tauSec, 5); // floor — mmp-pricing's own EXPIRY_LOCKOUT_SEC (20s)
                                    // already keeps this out of the danger zone in practice
  const rawDeltaPct = ((spot - strike) / strike) * 100;
  const timeScale = Math.sqrt(refSec / tau);
  const scaledDeltaPct = rawDeltaPct * timeScale;
  const prob = piecewiseLerp(Math.abs(scaledDeltaPct), EMPIRICAL_BREAKPOINTS);
  const yes = scaledDeltaPct >= 0 ? prob : 100 - prob;
  return Math.min(0.99, Math.max(0.01, yes / 100));
}

// Round to the market's ¢ tick. The final .toFixed(dp) pass matters now that
// interval can be fractional (0.1) — Math.round(p/interval)*interval alone
// still leaves binary-floating-point noise (e.g. 529*0.1 === 52.900000000000006
// in JS), which was showing up live as ugly values like bidAmount:
// 52.900000000000006 in real API responses. Harmless to GameBull's own
// decimal-aware validation, but worth cleaning up.
function decimalPlaces(x) {
  const s = String(x);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}
export function toTick(p, interval) {
  const dp = decimalPlaces(interval);
  const snapped = Math.round(p / interval) * interval;
  const clamped = Math.max(interval, Math.min(100 - interval, snapped));
  return Number(clamped.toFixed(dp));
}

let seq = 0;
export function bidId(prefix) {
  return `${prefix}-${Date.now()}-${seq++}`;
}

// Write the bb_pending_bids record the trading-api's WriteTransaction.placeBid
// normally creates BEFORE the matcher runs — post-matching reads it back to
// enrich matched bids (totalBidCount, clientId…). Keyed marketId=`${mkt}.${uid}`.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS } from '../../setup/local.mjs';
// Endpoint/region come from setup/local.mjs, which honours env overrides. This
// used to hardcode http://localhost:8000: fine on the host, fatal in a container,
// where localhost is the container itself — every writePendingBid threw
// ECONNREFUSED and the caller reported it only as a bare "Error".
const _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS,
}));
export async function writePendingBid(bid) {
  const qty = bid.currentBidCount ?? bid.bidCount ?? 0;
  const unused = (bid.bidAmount || 0) / 100 * qty;
  await _ddb.send(new PutCommand({
    TableName: 'bb_pending_bids',
    Item: {
      marketId: `${bid.marketId}.${bid.userId}`, bidId: bid.bidId,
      // GSI attrs the distribution engine reads: mkId = `${mkt}.${shard 0-3}`, clientId 0-3
      mkId: `${bid.marketId}.${bid.userId % 4}`, clientId: 1,
      userId: bid.userId, optionId: bid.optionId, bidType: bid.bidType ?? 0,
      bidAmount: bid.bidAmount, buyingPrice: bid.buyingPrice ?? bid.bidAmount,
      currentBidCount: qty, totalBidCount: qty, cancelledBidCount: 0,
      matchedBidsCount: 0, soldBidCount: 0,
      mmpPriceVersion: bid.mmpPriceVersion ?? 0, marketPrice: 100,
      clientId: 1, clientUserId: String(bid.userId),
      unusedAmount: unused, credits: 0, otherPromo: 0,
      // PostMatching2.calculateBifurcatedAmount re-fetches this record and
      // destructures `bid.appliedAmt.{unused,credits,otherPromo}` — without this
      // nested object it throws "Cannot read properties of undefined (reading
      // 'unused')" and post-matching silently aborts for the whole match pair,
      // meaning matchedBidsCount never gets written back. Verified live against
      // the real matcher (gate-0 probe) — this is not hypothetical.
      appliedAmt: { unused, credits: 0, otherPromo: 0 },
      // PostMatching2.calculateCreditAmount ALSO destructures bidData.totalRakeBifurcation
      // (fetched fresh from DynamoDB via PendingBidsTable.getBidData's ProjectionExpression,
      // which includes this field but not appliedAmt) — same crash site if missing. Verified
      // live: appliedAmt alone was not sufficient, this field was the actual remaining cause.
      totalRakeBifurcation: { unused: 0, credits: 0, otherPromo: 0 },
      avgSellPricePerBid: bid.buyingPrice ?? bid.bidAmount,
      // Also in getBidData's ProjectionExpression. On a full-fill, PostMatching2
      // does bidData.statusOptionAmountEpoch.replace('PEN','MAT') — crashes if
      // absent. Format mirrors what the matcher itself writes for its own bids:
      // `#{marketId}#{status}#{optionId}#{price}#{ts}`.
      statusOptionAmountEpoch: `#${bid.marketId}#PEN#${bid.optionId}#${bid.bidAmount}#${Date.now()}`,
      bidStatus: 1, createdAt: new Date().toISOString(),
    },
  }));
}

// Remove a user's own resting (unmatched) rows for one side of one market —
// both the matchable order-book row (MySQL) and the mirrored pending-bid
// record (DynamoDB), so nothing lingers referencing a cancelled/swept quote.
// Generalized from mmp-pricing's original cancelHouseResting (MMP-only) so
// it's also usable for market-order residual cleanup (any userId, §4).
import { DeleteCommand as _DeleteCommand } from '@aws-sdk/lib-dynamodb';
// Snapshot the caller's currently-resting rows WITHOUT cancelling them. This is
// the first half of a make-before-break requote (see mmp-pricing): take the
// old rows' identities, post the NEW ladder, then cancel exactly these — so the
// book is never empty, only briefly double-depth.
export async function snapshotRestingRows(marketId, side, userId, db) {
  const table = `bb_available_bids_${side}_${marketId}`;
  try {
    const [rows] = await db.query(
      `SELECT row_id, bid_id FROM \`${table}\` WHERE user_id = ? AND is_matched = 0`, [userId]);
    return rows;
  } catch { return []; } // table doesn't exist yet (market brand new)
}

// `preRows` (optional): cancel EXACTLY these previously-snapshotted rows instead
// of re-querying. Required for make-before-break — a fresh query here would also
// match the ladder we just posted and delete it, emptying the book completely.
export async function cancelRestingRows(marketId, side, userId, db, ddb, preRows = null) {
  const table = `bb_available_bids_${side}_${marketId}`;
  let rows;
  if (preRows) {
    rows = preRows;
  } else {
    try {
      [rows] = await db.query(
        `SELECT row_id, bid_id FROM \`${table}\` WHERE user_id = ? AND is_matched = 0`, [userId]);
    } catch { return 0; } // table doesn't exist yet (market brand new) — nothing to cancel
  }
  if (!rows.length) return 0;
  // Always drop the MySQL order-book row — that's what "cancel" means: stop
  // resting. (A partially-filled quote still has is_matched = 0 with a reduced
  // current_bid_count, so it shows up here too; pulling it is correct.)
  await db.query(`DELETE FROM \`${table}\` WHERE row_id IN (${rows.map(() => '?').join(',')})`, rows.map((r) => r.row_id));
  // The DynamoDB pending-bid record is NOT just a mirror of the resting order —
  // post-matching writes the realised `matchedBidsCount` back onto it, so it is
  // also the record of the fill. Deleting it unconditionally destroyed the
  // house's fill history on every mmp-pricing re-quote cycle: inventory-mirror
  // then derived qYes/qNo = 0 forever and the hedger never saw exposure to
  // hedge. Only delete records that never filled; a partially-filled quote's
  // record must survive the cancel. The condition makes this atomic against a
  // fill landing between our read and the delete.
  await Promise.all(rows.map((r) =>
    ddb.send(new _DeleteCommand({
      TableName: 'bb_pending_bids',
      Key: { marketId: `${marketId}.${userId}`, bidId: r.bid_id },
      ConditionExpression: 'attribute_not_exists(matchedBidsCount) OR matchedBidsCount = :zero',
      ExpressionAttributeValues: { ':zero': 0 },
    })).catch(() => {}))); // ConditionalCheckFailed = it had fills, keep it
  return rows.length;
}

// POST a bid to the matching engine's /handle route (the SQS-record body shape).
// PLACE_BID_TIMEOUT_MS (2026-07-30): this fetch previously had NO timeout at
// all — under heavy system CPU contention (confirmed live: quoter at 2%
// CPU, clearly blocked not starved) a slow matcher response could hang this
// single call for 40+ seconds, and since mmp-pricing's quoteAll() awaits
// each market SEQUENTIALLY, one hung placeBid call froze quoting for every
// other market too, not just this one. Bounding it converts a potential
// tens-of-seconds total freeze into a single failed quote attempt that
// recovers on the persistent worker's next ~2s loop tick.
const PLACE_BID_TIMEOUT_MS = Number(process.env.MMP_PLACE_BID_TIMEOUT_MS || 5000);
export async function placeBid(matcherUrl, bid) {
  const body = { creationTime: new Date().toISOString(), bidType: 0 /* Buy */, parentBuyOrder: null, ...bid };
  // wallet breakup the matcher writes into the order book (per share)
  if (!body.appliedAmt) body.appliedAmt = { unused: (body.bidAmount || 0) / 100, credits: 0, otherPromo: 0 };
  // pre-write the pending bid so post-matching can read it back (trading-api's job)
  await writePendingBid(body);
  const r = await fetch(`${matcherUrl}/handle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(PLACE_BID_TIMEOUT_MS),
  });
  const txt = await r.text();
  return { status: r.status, body: txt };
}

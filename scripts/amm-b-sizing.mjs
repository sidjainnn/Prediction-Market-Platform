// Sizes AMM_B_MAX off REAL user order sizes instead of a guess. AMM_B_MAX's
// job (see quoting.mjs's ammBForTau + mmp-pricing's time-decay) is liquidity
// DEPTH early in a market's life — settlement-loss protection is AMM_B_MIN's
// job (paired with the expiry taper) and INV_LIMIT/risk-gate's job, not
// AMM_B_MAX's. So the right target for AMM_B_MAX is: "the touch level should
// absorb a realistic single user order without walking many ladder rungs."
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, MMP_USER_ID } from '../setup/local.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

function logit(p) { const c = Math.min(Math.max(p, 1e-4), 1 - 1e-4); return Math.log(c / (1 - c)); }
function lmsrStepQty(pFrom, pTo, b) { return Math.max(0, b * Math.abs(logit(pTo) - logit(pFrom))); }

// 1. pull every REAL user-submitted order (not the house's own quotes) —
// totalBidCount is the size the user actually asked for (bb_pending_bids'
// stored field name; `bidCount` only exists in the outgoing submit payload),
// the thing the touch level needs to be able to absorb in one sweep.
let items = [], k;
do { const s = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids', ExclusiveStartKey: k })); items = items.concat(s.Items || []); k = s.LastEvaluatedKey; } while (k);
const userOrders = items.filter((x) => Number(x.userId) !== MMP_USER_ID && Number(x.totalBidCount) > 0);

if (userOrders.length === 0) {
  console.log('No real user orders found in bb_pending_bids yet — need live trading data before this can be data-driven.');
  process.exit(0);
}

const sizes = userOrders.map((x) => Number(x.totalBidCount)).sort((a, b) => a - b);
const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))];
const median = pct(0.5), p90 = pct(0.9), p99 = pct(0.99), max = sizes[sizes.length - 1];

console.log(`Real user orders found: ${sizes.length}`);
console.log(`  median=${median}  p90=${p90}  p99=${p99}  max=${max}\n`);

// 2. target: touch level (1st ladder rung, ~1c away from mid) should absorb
// the p90 order without needing to walk past level 1. Near p=0.5,
// d(logit)/dp ~= 4, so a 1c step carries ~0.04*b shares -> b = target/0.04.
const LADDER_STEP_CENTS = 1;
const targetSharesAtTouch = p90;
const dlogitPerCent = Math.abs(logit(0.51) - logit(0.50)); // ~0.04, empirically from the real function (not the p=0.5 approx)
const suggestedB = targetSharesAtTouch / dlogitPerCent;

console.log(`Target: touch level absorbs the p90 single order (${p90} shares) without walking past rung 1.`);
console.log(`suggested AMM_B_MAX = p90_order / d(logit)/d(1c) = ${p90} / ${dlogitPerCent.toFixed(4)} = ${Math.round(suggestedB)}\n`);

// 3. cross-check: cumulative 8-level ladder depth at old vs new b, and vs INV_LIMIT
const LADDER_LEVELS = 8, INV_LIMIT = 5000;
function cumulativeDepth(b, startP = 0.5) {
  let p = startP, total = 0;
  const levels = [];
  for (let i = 0; i < LADDER_LEVELS; i++) {
    const next = Math.min(0.99, p + LADDER_STEP_CENTS / 100);
    const qty = lmsrStepQty(p, next, b);
    levels.push(Math.round(qty));
    total += qty;
    p = next;
  }
  return { levels, total };
}

for (const [label, b] of [['current AMM_B_MAX=12500', 12500], [`suggested AMM_B_MAX=${Math.round(suggestedB)}`, suggestedB]]) {
  const { levels, total } = cumulativeDepth(b);
  const capped = Math.min(total, INV_LIMIT);
  console.log(`${label}: per-level shares [${levels.join(', ')}]  cumulative=${Math.round(total)}${total > INV_LIMIT ? `  (capped by INV_LIMIT to ${capped})` : ''}`);
}
process.exit(0);

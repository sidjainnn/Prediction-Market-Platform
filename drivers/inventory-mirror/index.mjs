// Inventory mirror — derives the house's net matched inventory from bb_pending_bids
// and publishes it into the MMP_LMSR_QUANTITY_{YES,NO}_{marketId} Redis keys that
// GameBull's MMP maintains in prod. This lets gb-crypto-hedging-service run its REAL
// GamebullInventorySource adapter locally (no local-only code path).
//
//   node drivers/inventory-mirror/index.mjs            (one pass)
//   node drivers/inventory-mirror/index.mjs --watch    (every 2s)
//
// ── Sign mapping (important) ─────────────────────────────────────────────────
// House-side matched counts:
//   houseYes = Σ matched where userId=MMP, optionId=1  (house LONG yes)
//   houseNo  = Σ matched where userId=MMP, optionId=2  (house LONG no ≡ SHORT yes)
// House net *long-YES* exposure  = houseYes − houseNo.
// House value delta w.r.t spot   = (houseYes − houseNo)·dp/dS.
// The hedge must OFFSET that, i.e. target = (houseNo − houseYes)·dp/dS.
// The adapter computes (qYes − qNo)·dp/dS and the hedger holds that many units,
// so we must publish  qYes = houseNo,  qNo = houseYes  (the LMSR q = shares
// OUTSTANDING to users = the house's short side). Getting this backwards would
// DOUBLE the risk instead of hedging it.
import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, MMP_USER_ID } from '../../setup/local.mjs';

const KEY_YES = 'MMP_LMSR_QUANTITY_YES_';
const KEY_NO = 'MMP_LMSR_QUANTITY_NO_';
const WATCH = process.argv.includes('--watch');

const redis = new Redis(REDIS);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

// Full-table Scan is paginated: DynamoDB caps each page at 1MB, so a single Scan
// silently returns only the first slice once bb_pending_bids grows past that —
// which at scale would understate house inventory and UNDER-hedge. Loop on
// LastEvaluatedKey to read every page. (A per-market Query on the mkId GSI is the
// real scale optimization; pagination is the correctness floor.)
async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    if (page.Items) items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function mirrorOnce() {
  const activeIds = await redis.smembers('predictor_active_markets');
  const allBids = await scanAll({ TableName: 'bb_pending_bids' });
  const houseBids = allBids.filter((b) => Number(b.userId) === MMP_USER_ID && Number(b.matchedBidsCount) > 0);

  const summary = [];
  for (const marketId of activeIds) {
    const mkt = houseBids.filter((b) => String(b.marketId).startsWith(`${marketId}.`));
    const houseYes = mkt.filter((b) => Number(b.optionId) === 1).reduce((s, b) => s + Number(b.matchedBidsCount), 0);
    const houseNo = mkt.filter((b) => Number(b.optionId) === 2).reduce((s, b) => s + Number(b.matchedBidsCount), 0);
    // qYes = houseNo, qNo = houseYes (see header). Publish even when 0 so a market
    // that goes flat is reflected.
    await redis.set(`${KEY_YES}${marketId}`, String(houseNo));
    await redis.set(`${KEY_NO}${marketId}`, String(houseYes));
    summary.push(`${marketId}: qYes=${houseNo} qNo=${houseYes} (shortYes ${houseNo - houseYes})`);
  }

  // clean up keys for markets no longer active (settled/expired)
  const liveYes = new Set(activeIds.map((id) => `${KEY_YES}${id}`));
  for (const k of await redis.keys(`${KEY_YES}*`)) {
    if (!liveYes.has(k)) {
      const id = k.slice(KEY_YES.length);
      await redis.del(k, `${KEY_NO}${id}`);
    }
  }
  return summary;
}

async function run() {
  do {
    try {
      const s = await mirrorOnce();
      console.log(`[inventory-mirror] ${new Date().toISOString().slice(11, 19)} · ${s.length ? s.join(' | ') : 'no active markets'}`);
    } catch (e) {
      console.error('[inventory-mirror] error:', e.message);
    }
    if (WATCH) await new Promise((r) => setTimeout(r, 2000));
  } while (WATCH);
  if (!WATCH) { await redis.quit(); process.exit(0); }
}
run();

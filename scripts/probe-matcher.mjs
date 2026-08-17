// One-off probe: verify the real matcher's price-priority selection and
// fill-price rule empirically (plan Verification item 0), before writing any
// walkBook/market-order logic that assumes ORDER BY bid_amount DESC, row_id
// and matchedPrice = 100 - opponentBidAmount.
//
// Self-contained: creates its own fresh market so nothing expires mid-run.
import { spawn } from 'node:child_process';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, MYSQL } from '../setup/local.mjs';
import { bidId, placeBid } from '../drivers/lib/pricing.mjs';

const MATCHER = 'http://localhost:7001';
const redis = new Redis(REDIS);
const db = await mysql.createConnection(MYSQL);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

function runDriver(rel) {
  return new Promise((res) => {
    const p = spawn('node', [new URL('../' + rel, import.meta.url).pathname]);
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', () => res(out.trim()));
  });
}

console.log('creating fresh market...');
await runDriver('drivers/market-generator/index.mjs');
const ids = await redis.smembers('predictor_active_markets');
let MKT = null, best = 0;
for (const id of ids) {
  const m = await redis.get('MMP_MARKET_META_' + id);
  if (m) { const e = JSON.parse(m).expiryTs; if (e > Date.now() && e > best) { best = e; MKT = id; } }
}
console.log('MKT =', MKT, '  (expires in', Math.round((best - Date.now()) / 1000), 's)');

const resters = [
  { userId: 300001, price: 40, qty: 20 }, // posted 1st, WORST price
  { userId: 300002, price: 50, qty: 20 }, // posted 2nd, BEST price
  { userId: 300003, price: 45, qty: 20 }, // posted 3rd, MIDDLE price
];
for (const r of resters) {
  const res = await placeBid(MATCHER, {
    marketId: MKT, bidId: bidId(`probe${r.userId}`), userId: r.userId,
    optionId: 2, bidAmount: r.price, buyingPrice: r.price,
    currentBidCount: r.qty, bidCount: r.qty, mmpPriceVersion: 0,
  });
  console.log(`rested user${r.userId} NO @ ${r.price}c x${r.qty} -> HTTP ${res.status} ${res.body.slice(0,120)}`);
}

const takerQty = 30; // > any single resting order's 20, forces a multi-maker sweep
const takerRes = await placeBid(MATCHER, {
  marketId: MKT, bidId: bidId('probeTaker'), userId: 400001,
  optionId: 1, bidAmount: 95, buyingPrice: 95,
  currentBidCount: takerQty, bidCount: takerQty, mmpPriceVersion: 0,
});
console.log(`\nTAKER user400001 YES @ 95c x${takerQty} -> HTTP ${takerRes.status} ${takerRes.body.slice(0,300)}`);

await new Promise(r => setTimeout(r, 1500));

console.log('\n=== MySQL NO-side book (consumption order) ===');
const [noRows] = await db.query(`SELECT row_id,user_id,bid_amount,current_bid_count,is_matched FROM \`bb_available_bids_no_${MKT}\` ORDER BY row_id`);
noRows.forEach(r => console.log(' row', r.row_id, 'user', r.user_id, 'price', r.bid_amount, 'remaining', r.current_bid_count, 'matched', r.is_matched));

console.log('\n=== DynamoDB bb_pending_bids (matchedPrice / matchedBidsCount) ===');
const scan = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids' }));
const rows = (scan.Items || []).filter(x => String(x.marketId).startsWith(MKT));
rows.forEach(x => console.log(' user', x.userId, 'opt', x.optionId, 'bidAmount', x.bidAmount, 'buyingPrice', x.buyingPrice, 'matchedBidsCount', x.matchedBidsCount));

await db.end(); await redis.quit();

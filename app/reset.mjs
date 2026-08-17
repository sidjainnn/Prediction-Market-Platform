// Clean slate for the office test: clears users, wallets, positions, markets,
// LMSR inventory and MM accumulators so everyone starts from zero.
//   node app/reset.mjs
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, MYSQL } from '../setup/local.mjs';

const redis = new Redis(REDIS);
const db = await mysql.createPool(MYSQL);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

// app namespace + inventory + active markets
await redis.del('app:users', 'app:names', 'app:realized', 'app:mm:settledPnl', 'app:uidseq', 'predictor_active_markets');
for (const pat of ['MMP_LMSR_QUANTITY_*', 'MMP_MARKET_META_*']) {
  const ks = await redis.keys(pat); if (ks.length) await redis.del(...ks);
}
// app users (>=200000) — drop so they re-seed on next login
await db.query('DELETE FROM bb_users WHERE user_id >= 200000');
// all pending bids
const bids = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids' }));
for (const b of bids.Items || []) await ddb.send(new DeleteCommand({ TableName: 'bb_pending_bids', Key: { marketId: b.marketId, bidId: b.bidId } }));
console.log(`✅ reset · cleared ${(bids.Items || []).length} bids, app users, markets, LMSR inventory, MM P&L`);
await redis.quit(); await db.end(); process.exit(0);

// Creates the local schema from the shapes extracted off the PRE branches:
//   DynamoDB: `market` (hash marketId), `bb_pending_bids` (hash marketId, range bidId)
//   MySQL   : `bb_users` (wallet), + seed MMP house + test users
// Per-market order-book tables (bb_available_bids_{yes|no}_{marketId}) are created
// by the app/market-generator per market, so they are NOT pre-created here.
//
//   npm run schema   (after `docker compose up -d`)

import { DynamoDBClient, CreateTableCommand, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import mysql from 'mysql2/promise';
import { REGION, DDB_ENDPOINT, AWS_CREDS, MYSQL, TABLES, MMP_USER_ID, TEST_USERS } from './local.mjs';

const ddb = new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS });

async function makeTable(name, keys, attrs) {
  const existing = (await ddb.send(new ListTablesCommand({}))).TableNames || [];
  if (existing.includes(name)) { console.log(`  · dynamo ${name} already exists`); return; }
  await ddb.send(new CreateTableCommand({
    TableName: name,
    KeySchema: keys,
    AttributeDefinitions: attrs,
    BillingMode: 'PAY_PER_REQUEST',
  }));
  console.log(`  ✓ dynamo ${name} created`);
}

async function dynamo() {
  console.log('DynamoDB:');
  // market: single hash key marketId (MarketI from gb-event-api-service)
  await makeTable(TABLES.market,
    [{ AttributeName: 'marketId', KeyType: 'HASH' }],
    [{ AttributeName: 'marketId', AttributeType: 'S' }]);
  // pending bids: base key marketId(`${mkt}.${uid}`)+bidId; plus the GSI the
  // distribution engine reads (mkId = `${mkt}.${shard}`, clientId 0-3).
  const existing = (await ddb.send(new ListTablesCommand({})).catch(() => ({ TableNames: [] }))).TableNames || [];
  if (!existing.includes(TABLES.pendingBids)) {
    await ddb.send(new CreateTableCommand({
      TableName: TABLES.pendingBids,
      KeySchema: [{ AttributeName: 'marketId', KeyType: 'HASH' }, { AttributeName: 'bidId', KeyType: 'RANGE' }],
      AttributeDefinitions: [
        { AttributeName: 'marketId', AttributeType: 'S' }, { AttributeName: 'bidId', AttributeType: 'S' },
        { AttributeName: 'mkId', AttributeType: 'S' }, { AttributeName: 'clientId', AttributeType: 'N' },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: 'mkId-clientId-index',
        KeySchema: [{ AttributeName: 'mkId', KeyType: 'HASH' }, { AttributeName: 'clientId', KeyType: 'RANGE' }],
        Projection: { ProjectionType: 'ALL' },
      }],
      BillingMode: 'PAY_PER_REQUEST',
    }));
    console.log(`  ✓ dynamo ${TABLES.pendingBids} created (+ mkId-clientId-index)`);
  } else console.log(`  · dynamo ${TABLES.pendingBids} already exists`);
}

async function sql() {
  console.log('MySQL:');
  const db = await mysql.createConnection(MYSQL);
  // bb_users: wallet columns the UsersTable model reads/writes
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLES.users} (
    user_id BIGINT PRIMARY KEY,
    unused_amount DECIMAL(12,2) DEFAULT 0,
    credits DECIMAL(12,2) DEFAULT 0,
    bonus_cash DECIMAL(12,2) DEFAULT 0
  )`);
  console.log(`  ✓ mysql ${TABLES.users} created`);
  // seed MMP house (deep pockets) + test users
  const seed = [[MMP_USER_ID, 1_000_000], ...TEST_USERS.map((u) => [u, 10_000])];
  for (const [uid, bal] of seed) {
    await db.query(
      `INSERT INTO ${TABLES.users} (user_id, unused_amount) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE unused_amount = VALUES(unused_amount)`, [uid, bal]);
  }
  console.log(`  ✓ seeded ${seed.length} users (MMP ${MMP_USER_ID} + ${TEST_USERS.length} test)`);
  await db.end();
}

(async () => {
  try {
    await dynamo();
    await sql();
    console.log('\n✅ local schema ready. Per-market order-book tables are created per market by the generator.');
  } catch (e) {
    console.error('❌ schema setup failed:', e.message);
    process.exit(1);
  }
})();

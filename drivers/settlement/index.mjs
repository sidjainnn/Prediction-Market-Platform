// Settlement — resolves expired crypto markets against the oracle and kicks the
// distribution engine. For each active market past its expiry:
//   winningOption = spot ≥ strike ? YES(1) : NO(2)
//   set market.answer + marketStatus=Completed(3) + marketDistributionStatus=
//   WinningNotAssigned(1) → then POST a status-change to the distribution engine,
//   which reads the matched bids and pays out winners.
//
//   node drivers/settlement/index.mjs         # resolve any expired markets once
//   LOOP=1 node drivers/settlement/index.mjs  # poll every 10s

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import Redis from 'ioredis';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, TABLES } from '../../setup/local.mjs';

const SYMBOL = process.env.ORACLE_SYMBOL || 'BTCUSDT';
const DIST_URL = process.env.DIST_URL || 'http://localhost:7002';
// GameWiseMarketStatus.Completed / MarketStatus.WinningNotAssigned
const GW_COMPLETED = 3;
const DIST_WINNING_NOT_ASSIGNED = 1;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));
const redis = new Redis(REDIS);

async function resolveExpired() {
  const ids = await redis.smembers('predictor_active_markets');
  const spot = JSON.parse((await redis.get(`CRYPTO_SPOT_${SYMBOL}`)) || '{}').price;
  for (const marketId of ids) {
    const metaRaw = await redis.get(`MMP_MARKET_META_${marketId}`);
    if (!metaRaw) continue;
    const { strike, expiryTs } = JSON.parse(metaRaw);
    if (Date.now() < expiryTs) continue; // not expired yet

    const winningOption = spot >= strike ? 1 : 2; // YES iff BTC ≥ strike
    await ddb.send(new UpdateCommand({
      TableName: TABLES.market, Key: { marketId },
      UpdateExpression: 'SET answer = :a, marketStatus = :ms, marketDistributionStatus = :ds, settledValue = :sv, settledAt = :sa',
      ExpressionAttributeValues: {
        ':a': winningOption, ':ms': GW_COMPLETED, ':ds': DIST_WINNING_NOT_ASSIGNED,
        ':sv': spot, ':sa': new Date().toISOString(),
      },
    }));
    await redis.srem('predictor_active_markets', marketId);
    console.log(`✓ resolved ${marketId}: spot $${spot?.toFixed(0)} vs K $${strike} → ${winningOption === 1 ? 'YES' : 'NO'} wins`);

    // kick the distribution engine (winning assignment + payout)
    try {
      const r = await fetch(`${DIST_URL}/market-status-change`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, marketStatus: GW_COMPLETED }),
      });
      console.log(`  → distribution engine: HTTP ${r.status}`);
    } catch (e) {
      console.log(`  → distribution engine not reachable (${String(e).slice(0, 40)}) — resolve stored; run distribution later`);
    }
  }
}

(async () => {
  await resolveExpired();
  if (process.env.LOOP === '1') setInterval(() => resolveExpired().catch((e) => console.error(e.message)), 10000);
  else process.exit(0);
})();

// Fire a single USER bid at the matcher — to demo a match against house liquidity.
//   node drivers/place-user-bid.mjs <YES|NO> <price¢> <qty>
import Redis from 'ioredis';
import { REDIS, TEST_USERS } from '../setup/local.mjs';
import { bidId, placeBid } from './lib/pricing.mjs';

const MATCHER = process.env.MATCHER_URL || 'http://localhost:7001';
const side = (process.argv[2] || 'YES').toUpperCase();
const price = Number(process.argv[3] || 55);
const qty = Number(process.argv[4] || 50);
const optionId = side === 'YES' ? 1 : 2;

const redis = new Redis(REDIS);
const marketId = (await redis.smembers('predictor_active_markets'))[0];
if (!marketId) { console.error('no active market'); process.exit(1); }

const res = await placeBid(MATCHER, {
  marketId, bidId: bidId('user'), userId: TEST_USERS[0],
  optionId, bidAmount: price, buyingPrice: price, currentBidCount: qty, bidCount: qty,
  mmpPriceVersion: 0, // plain user bid — no MMP version check
});
console.log(`user ${side} @ ${price}¢ x${qty} on ${marketId} → HTTP ${res.status}`);
console.log(res.body.slice(0, 300));
process.exit(0);

// Market generator — creates a rolling 5-minute BTC binary market in the stores,
// shaped like gb-event-api-service's MarketI so the matcher + distribution engine
// treat it like any other market. On each run it:
//   1. reads BTC spot from Redis (the oracle)
//   2. writes a `market` record to DynamoDB (marketStatus=Active, ATM strike, +5m)
//   3. registers the id in the `predictor_active_markets` Redis set
//   4. creates the per-market order-book tables (bb_available_bids_{yes|no}_{id})
//   5. publishes MMP_MARKET_META_{id} for the hedge (underlying/strike/expiry)
//
//   node drivers/market-generator/index.mjs        # one market
//   LOOP=1 node drivers/market-generator/index.mjs # every 5 min (the cron)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { REGION, DDB_ENDPOINT, AWS_CREDS, MYSQL, REDIS, TABLES } from '../../setup/local.mjs';

const SYMBOL = process.env.ORACLE_SYMBOL || 'BTCUSDT';
// Configurable so a second/third generator loop can run longer-tenor markets
// concurrently with the default 5m one — see cross-market-hedging-research-plan.md
// Phase 0 §"long-tenor ladder" candidate. Minutes, not ms, for a friendlier env var.
const TENOR_MS = Number(process.env.TENOR_MIN || 5) * 60 * 1000;
// Short, human-readable tenor tag for marketId/filterId — "5m", "15m", "60m", "5h".
// Optional expiry ALIGNMENT to a fixed UTC hour, for long-tenor markets that we
// intend to hedge with listed options.
//
// Why this exists: a digital is replicated by a tight call spread, and that
// replication is only exact if the option expires when OUR market settles.
// Deribit's BTC options expire DAILY at 08:00 UTC. A 24h market generated at an
// arbitrary wall-clock time therefore settles mid-option-life, leaving the
// hedge with residual time value at our settlement — the payoff match breaks
// precisely when it is needed. Snapping our expiry to the listed expiry makes
// the replication exact and costs nothing.
//
// Unset (the default) = previous behaviour exactly: expiry is now + TENOR_MS.
// Only meaningful for tenors around a day; a 5m market cannot be aligned to a
// daily hour and must not try.
const EXPIRY_ALIGN_UTC_HOUR = process.env.EXPIRY_ALIGN_UTC_HOUR === undefined
  ? null : Number(process.env.EXPIRY_ALIGN_UTC_HOUR);

function alignedExpiry(now) {
  const plain = now + TENOR_MS;
  if (EXPIRY_ALIGN_UTC_HOUR === null || !Number.isFinite(EXPIRY_ALIGN_UTC_HOUR)) return plain;
  // Next occurrence of that UTC hour at or after the un-aligned expiry, so a
  // market is never SHORTENED by alignment — only extended, up to 24h.
  const d = new Date(plain);
  const target = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EXPIRY_ALIGN_UTC_HOUR, 0, 0, 0);
  return target >= plain ? target : target + 24 * 60 * 60 * 1000;
}

const TENOR_TAG = TENOR_MS % (60 * 60 * 1000) === 0 ? `${TENOR_MS / (60 * 60 * 1000)}h` : `${TENOR_MS / (60 * 1000)}m`;
// ¢ tick. A 5¢ grid cannot express the 2-5¢ spreads a real prediction market
// quotes — rounding alone forced the effective spread to 0/5/10¢. Tightened
// 1 -> 0.1 (2026-07-24) for finer near-extreme pricing. NOT 0.01: verified
// live that GameBull's matching-engine reservation path does
// `parseInt(bidAmount*100)` (AvailableBidsTable.js) — float multiplication
// then TRUNCATION, which silently corrupts ~5.7% of two-decimal-cent values
// (e.g. 99.99 -> 99.98) since that code can't be modified. 0.1 (and 0.25,
// 0.5 — GameBull's own historical markets used 0.5) tested clean: 0 of 999+
// values corrupted. trading-api validates via
// `Number.isInteger((bidAmount/inputPriceInterval).toFixed(2))`, which is
// decimal-aware (unlike the naive `% inputPriceInterval` this comment used
// to describe) — this single value still drives every tick decision
// downstream.
const PRICE_INTERVAL = Number(process.env.PRICE_INTERVAL || 0.1);
const RAKE_PCT = 5;
// ATM strike rounding granularity ($). Was $100 — at BTC ~$65k that's a worst-
// case $50 offset, and since the digital's d1 = ln(spot/strike)/(σ√τ) has τ in
// the DENOMINATOR, the same $50 offset gets more extreme as expiry nears, not
// less: fairYes drifted 45%→33% from open to the last 20s of a 5m market,
// making one side heavily directional for the market's entire life. $10
// shrinks the worst case to $5, which stays within ~48-50% the whole way
// through (checked against the live fair-value formula, not just eyeballed).
const STRIKE_ROUND_USD = Number(process.env.STRIKE_ROUND_USD || 10);

// GameWiseMarketStatus / MarketStatus (from distribution engine models/market.ts)
const GW = { Active: 1, Completed: 3 };
const DIST = { GamePlayActive: 0 };

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));
const redis = new Redis(REDIS);

async function getSpot() {
  const raw = await redis.get(`CRYPTO_SPOT_${SYMBOL}`);
  if (!raw) throw new Error('no oracle price yet — start the oracle-feed driver first');
  return JSON.parse(raw).price;
}

async function createOrderBookTables(db, marketId) {
  for (const side of ['yes', 'no']) {
    await db.query(`CREATE TABLE IF NOT EXISTS \`${TABLES.availableBidsPrefix}${side}_${marketId}\` (
      row_id BIGINT NOT NULL AUTO_INCREMENT, user_id BIGINT, bid_id VARCHAR(100),
      opponent_bid_id VARCHAR(100), bid_type TINYINT, bid_amount DECIMAL(10,2),
      buy_amount DECIMAL(10,2), option_id INT, current_bid_count INT,
      cancel_bid_count INT, total_bids INT, unused DECIMAL(10,2) DEFAULT 0,
      credits DECIMAL(10,2) DEFAULT 0, bonus DECIMAL(10,2) DEFAULT 0,
      is_matched TINYINT DEFAULT 0, market_id VARCHAR(100),
      parent_buy_order VARCHAR(50) DEFAULT NULL, mmp_price_version VARCHAR(50),
      PRIMARY KEY (row_id),
      INDEX idx_cbc_and_ba (current_bid_count, bid_amount))`); // matcher force-indexes this
  }
}

async function generate() {
  const spot = await getSpot();
  const strike = Math.round(spot / STRIKE_ROUND_USD) * STRIKE_ROUND_USD; // ATM, tight rounding — see STRIKE_ROUND_USD
  const now = Date.now();
  const marketId = `btc${TENOR_TAG}${now}`; // no hyphen — becomes a MySQL table-name suffix
  const expiryTs = alignedExpiry(now);

  const market = {
    marketId,
    categoryId: 'CRYPTO', eventId: `${SYMBOL}`, parentEventId: `${SYMBOL}`, filterId: `crypto-${TENOR_TAG}`,
    marketType: 1,
    // exchangeRate keyed by wallet currency (trading-api reads market.exchangeRate[currency])
    exchangeRate: { INR: 1, USD: 1 },
    shardedMarket: 1, // enables mkId sharding (matcher/distribution read `${mkt}.${uid%4}`)
    // event block the placeBid controller destructures (POLL_ENDED if absent)
    event: {
      eN: 'Crypto', eSN: 'CRYPTO', pEN: 'Crypto', pESN: 'CRYPTO',
      c: { cId: 'CRYPTO', cN: 'Crypto', pCId: 'CRYPTO', pCN: 'Crypto' },
      sT: new Date(now).toISOString(),
      tAF: '', tBF: '', tAN: 'Yes', tBN: 'No', tAS: 'Y', tBS: 'N',
    },
    // Round tenors (15m/1h) read as a relative label ("in 15 mins"/"in 1 hour") instead of
    // an absolute UTC clock time — easier to parse at a glance for a fixed, known duration.
    // Everything else (5m, and any future tenor) keeps the absolute "at HH:MM:SS UTC" phrasing
    // unchanged, since a duration that isn't a clean round number reads better as a clock time
    // than as an awkward "in 37 mins"-style label.
    question: { en: `Will ${SYMBOL} be ≥ $${strike} ${
      TENOR_TAG === '15m' ? 'in 15 mins' : TENOR_TAG === '1h' ? 'in 1 hour'
      : `at ${new Date(expiryTs).toISOString().slice(11, 19)} UTC`
    }?` },
    options: [
      { optionId: 1, Name: { en: 'Yes' } },
      { optionId: 2, Name: { en: 'No' } },
    ],
    isTrending: 0, isInternal: 0, isWinMarket: 1,
    maxBidCountPerHit: 10000, minBidCountPerHit: 1, desiredBidCountPerHit: 100,
    marketPrice: 100, inputPriceInterval: PRICE_INTERVAL, pricePerQty: 1, rakePercent: RAKE_PCT,
    marketStatus: GW.Active, marketDistributionStatus: DIST.GamePlayActive,
    answer: null, totalBids: 0, totalMatchedBids: 0,
    startTime: new Date(now).toISOString(), endTime: new Date(expiryTs).toISOString(),
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  };

  // 1. DynamoDB market record
  await ddb.send(new PutCommand({ TableName: TABLES.market, Item: market }));
  // 2. active-markets set
  await redis.sadd('predictor_active_markets', marketId);
  // 3. per-market order-book tables
  const db = await mysql.createConnection(MYSQL);
  await createOrderBookTables(db, marketId);
  await db.end();
  // 4. hedge meta (underlying/strike/expiry) — what the hedge sidecar reads
  await redis.set(`MMP_MARKET_META_${marketId}`,
    JSON.stringify({ underlyingSymbol: SYMBOL, strike, expiryTs, feedId: 3 }));

  console.log(`✓ created ${marketId} | ${market.question.en} | strike $${strike} | expires ${new Date(expiryTs).toISOString().slice(11, 19)}`);
  return marketId;
}

(async () => {
  try {
    await generate();
    if (process.env.LOOP === '1') {
      console.log(`[market-generator] looping every ${TENOR_TAG}…`);
      setInterval(() => generate().catch((e) => console.error('gen error:', e.message)), TENOR_MS);
    } else {
      process.exit(0);
    }
  } catch (e) {
    console.error('❌ market generation failed:', e.message);
    process.exit(1);
  }
})();

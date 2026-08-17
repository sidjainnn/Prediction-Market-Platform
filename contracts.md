# Data contracts (extracted from the PRE branches — what our drivers must read/write)

Source of truth: `gb-trading-api-service`, `gb-trading-matching-engine-service`,
`gb-trading-distribution-engine-service` (`origin/PRE`). No repo changes — we only
match these shapes.

## Datastores (CORRECTED store split — verified against the models)
| Store | Key tables / keys |
|---|---|
| **DynamoDB** | `market` (hash: `marketId`), `bb_pending_bids` (hash: `marketId.userId`, range: `bidId`) |
| **MySQL** (the "cricketDb" conn) | **order book** `bb_available_bids_{yes\|no}_{marketId}` (created per-market by the app), `bb_users`, `market` read-model, `sb_user_participated_markets` |
| **Redis** | `predictor_active_markets` (SET), `PENDING_BIDS_COUNT_{marketId}`, `MARKET_TOTAL_AMOUNT_{marketId}`, `MARKET_TOTAL_BID_COUNT_{marketId}`, `bid_matching_lock_{marketId}` |
| **SQS** | matching-engine (FIFO) + cancel / sell queues |

### Order-book DDL (exact — app creates per market via `AvailableBidsTable.createTable`)
```sql
CREATE TABLE bb_available_bids_{yes|no}_{marketId} (
  row_id bigint AUTO_INCREMENT, user_id BIGINT, bid_id VARCHAR(100),
  opponent_bid_id VARCHAR(100), bid_type TINYINT, bid_amount DECIMAL(10,2),
  buy_amount DECIMAL(10,2), option_id INT, current_bid_count INT,
  cancel_bid_count INT, total_bids INT, unused DECIMAL(10,2), credits DECIMAL(10,2),
  bonus DECIMAL(10,2), is_matched TINYINT DEFAULT 0, market_id VARCHAR(100),
  parent_buy_order VARCHAR(50), mmp_price_version VARCHAR(50), PRIMARY KEY(row_id));
```

## Market (create → the generator writes this)
Fields (from the V3 market column list + distribution `states.ts`):
```
marketId, marketType, marketFormat, marketStatus, marketDistributionStatus,
marketPrice (=100), inputPriceInterval (tick, e.g. 5), rakePercent,
options[] { optionId (1=YES,2=NO), ... }, answer (winning optionId — set at settle),
question, questionHindi, tags, tagsName, matches, maxBidCountPerHit,
isLatestVersionMarket, settlement_rules, settledValue, settledAt, settlementTime
```
Crypto specifics we add into these fields: `question` = "Will BTC ≥ {strike} at {expiry}?",
strike/expiry/underlying carried in `matches`/tags or a small side key
`MMP_MARKET_META_{marketId}` for the hedge. Also register the id in
`predictor_active_markets` and seed empty `bb_available_bids_{yes|no}_{marketId}`.

## Bid (place → SQS → matching engine consumes)
```
{ marketId, bidId, userId, optionId (1=YES|2=NO), bidType, bidAmount (¢ price 0–100),
  buyingPrice, currentBidCount (qty), mmpPriceVersion (0=user, >0=MMP house) }
```
Matching rule: a YES bid at price `p` matches resting NO bids where
`marketPrice − p` complements (sum to 100). House quotes go in as `userId = MMP_USER_ID`
with `mmpPriceVersion > 0`.

## Resolution (settle → distribution engine pays out)
Set on the market: `answer` = winning optionId (YES iff oracle price ≥ strike),
`marketStatus` = settled, `settledValue`, `settledAt`. Distribution engine reads
the resolved market and computes per-bid winnings (`calculatePerBidWinnings`).

## The four driver services (write via these contracts, no repo edits)
1. **oracle-feed** → Redis `CRYPTO_SPOT_BTC` (poll Binance 1s).
2. **market-generator** → new `market` row (Dynamo+MySQL) + `predictor_active_markets`
   + empty books, every 5m (ATM strike, +5m expiry).
3. **mmp-pricing** → posts `MMP_USER_ID` bids via trading-api `/placeBid`, priced
   `digitalProb(spot,strike,σ,τ)+spread`, re-quoting as spot moves.
4. **settlement** → at expiry set `answer`/`marketStatus`/`settledValue` → distribution pays out.
+ **hedging sidecar** = `amm-hedging/server` reading `MMP_USER_ID` net position.

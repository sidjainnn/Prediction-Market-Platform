// Standalone replacements for the three production services on the order path,
// so this stack runs with no external dependencies.
//
//   node standalone/services.mjs
//
//     :8080  trading-api          POST /skillPolls/placeBid
//     :7001  matching-engine      POST /handle
//     :7002  distribution-engine  POST /market-status-change
//
// These are written from `contracts.md` — the data shapes this repo already
// documented — and reuse the libraries in drivers/lib. Price-time priority is
// `ORDER BY bid_amount DESC, row_id`, the rule drivers/lib/matching.mjs records
// as empirically confirmed against the live matcher.
//
// Scope: the order path the app exercises — place, match, rest, settle, pay out.
// Not a reimplementation of every production feature (cancels, sells, buyback,
// ladders and partial-cancel accounting are out of scope until needed).

import http from 'node:http';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import Redis from 'ioredis';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, MYSQL, TABLES, MMP_USER_ID } from '../setup/local.mjs';
import { walkBook } from '../drivers/lib/matching.mjs';

const WALLET = process.env.WALLET_STUB || 'http://localhost:3000';
const MARKET_PRICE = 100;                 // complement base: a YES at p pairs with a NO at 100-p
const log = (svc, ...a) => console.log(`[${svc}]`, ...a);

const redis = new Redis(REDIS);
const sql = await mysql.createPool({ ...MYSQL, connectionLimit: 10 });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS,
}));

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});
// Table identifiers are interpolated (they carry the marketId), so the id is
// restricted to an identifier-safe charset and the name is backtick-quoted.
// Without both, a marketId containing '-' is a syntax error and one containing
// a backtick would be an injection vector.
const safeId = (marketId) => {
  const s = String(marketId);
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`unsafe marketId: ${s}`);
  return s;
};
const book = (side, marketId) => `\`bb_available_bids_${side}_${safeId(marketId)}\``;
const sideOf = (optionId) => (Number(optionId) === 1 ? 'yes' : 'no');
const opposite = (side) => (side === 'yes' ? 'no' : 'yes');

async function wallet(path, body) {
  const r = await fetch(`${WALLET}/wallet/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

// ─────────────────────────────────────────────────────────────────────────────
// trading-api :8080 — validate, reserve funds, record the pending bid, match.
// ─────────────────────────────────────────────────────────────────────────────
async function placeBid(req, res) {
  const userId = Number(req.headers.user_id);
  const priceVersion = String(req.headers.mmp_price_version ?? '0');
  const { marketId, option } = await readBody(req);
  const bidAmount = Number(option?.bidAmount);
  const qty = Number(option?.bidCount);
  const optionId = Number(option?.optionId);

  // validation — mirrors the rejections the app already handles (INVALID_BID_INFO)
  if (!marketId || !Number.isFinite(bidAmount) || !Number.isFinite(qty) || qty <= 0) {
    return json(res, 200, { status: false, message: 'INVALID_BID_INFO' });
  }
  if (bidAmount <= 0 || bidAmount >= MARKET_PRICE) {
    return json(res, 200, { status: false, message: 'INVALID_BID_INFO: price out of range' });
  }
  const market = await ddb.send(new GetCommand({ TableName: TABLES.market, Key: { marketId } }));
  if (!market.Item || market.Item.marketStatus === 'settled') {
    return json(res, 200, { status: false, message: 'MARKET_NOT_OPEN' });
  }

  // The house is not wallet-constrained; users are. Debit at (price x qty),
  // which is what the production API reserves — the app's market-order pricing
  // depends on this exact convention (see app/server.mjs worstUserPrice).
  const cost = (bidAmount * qty) / 100;
  if (userId !== MMP_USER_ID) {
    const w = await wallet('debit', { userId, amount: cost, ref: marketId });
    if (w?.ok === false) return json(res, 200, { status: false, message: 'Insufficient wallet balance' });
  }

  const bidId = crypto.randomUUID();
  await ddb.send(new PutCommand({
    TableName: TABLES.pendingBids,
    Item: {
      'marketId.userId': `${marketId}.${userId}`, bidId, marketId, userId, optionId,
      bidAmount, currentBidCount: qty, mmpPriceVersion: priceVersion,
      buyingPrice: bidAmount, bidType: 1, createdAt: Date.now(),
    },
  }));
  await redis.incrby(`PENDING_BIDS_COUNT_${marketId}`, qty);
  await redis.incrbyfloat(`MARKET_TOTAL_AMOUNT_${marketId}`, cost);
  await redis.incr(`MARKET_TOTAL_BID_COUNT_${marketId}`);

  // Production enqueues to SQS and the matcher drains it. Calling the matcher
  // inline keeps the same observable ordering with one less moving part; set
  // STANDALONE_ASYNC_MATCH=1 to defer it instead.
  const bid = { marketId, bidId, userId, optionId, bidAmount, currentBidCount: qty, mmpPriceVersion: priceVersion };
  if (process.env.STANDALONE_ASYNC_MATCH === '1') setImmediate(() => matchBid(bid).catch((e) => log('matcher', 'async', e.message)));
  else await matchBid(bid);

  json(res, 200, { status: true, response: { bidInfo: { bidId, marketId, userId, optionId, bidAmount, bidCount: qty } } });
}

// ─────────────────────────────────────────────────────────────────────────────
// matching-engine :7001 — cross against the opposite book, rest the remainder.
// ─────────────────────────────────────────────────────────────────────────────
async function matchBid(bid) {
  const { marketId, bidId, userId, optionId, bidAmount } = bid;
  let remaining = Number(bid.currentBidCount);
  const side = sideOf(optionId);
  const opp = opposite(side);

  const lock = `bid_matching_lock_${marketId}`;
  const got = await redis.set(lock, bidId, 'NX', 'PX', 5000);
  if (!got) { await new Promise((r) => setTimeout(r, 25)); return matchBid(bid); }

  try {
    await ensureBook(marketId, side);
    await ensureBook(marketId, opp);

    // A bid at p crosses resting opposite rows priced >= 100 - p. Price-time
    // priority: best price first, then oldest row.
    const need = MARKET_PRICE - bidAmount;
    const [rows] = await sql.query(
      `SELECT row_id, user_id, bid_id, bid_amount, current_bid_count
         FROM ${book(opp, marketId)}
        WHERE is_matched = 0 AND bid_amount >= ?
        ORDER BY bid_amount DESC, row_id`, [need]);

    const resting = rows.map((r) => ({
      rowId: r.row_id, price: Number(r.bid_amount), qty: Number(r.current_bid_count),
      who: r.user_id, bidId: r.bid_id,
    }));
    const { consumed } = walkBook(resting, remaining);

    for (const c of consumed) {
      const take = c.takenQty;
      if (take >= c.qty) {
        await sql.query(`UPDATE ${book(opp, marketId)} SET is_matched = 1, current_bid_count = 0 WHERE row_id = ?`, [c.rowId]);
      } else {
        await sql.query(`UPDATE ${book(opp, marketId)} SET current_bid_count = current_bid_count - ? WHERE row_id = ?`, [take, c.rowId]);
      }
      remaining -= take;
      // Record BOTH sides of the fill. Settlement cannot be derived from the
      // order book alone: a fully-matched aggressive bid never becomes a
      // resting row, so a book-only payout query silently pays no taker.
      await recordFill(marketId, userId, optionId, take, bidAmount);
      await recordFill(marketId, c.who, optionId === 1 ? 2 : 1, take, c.price);
      log('matcher', `fill ${take} @ ${bidAmount}/${c.price} ${side} ${userId} x ${opp} ${c.who}`);
    }

    // Unfilled remainder rests on this side, visible to the next incoming bid.
    if (remaining > 0) {
      await sql.query(
        `INSERT INTO ${book(side, marketId)}
           (user_id, bid_id, bid_type, bid_amount, buy_amount, option_id,
            current_bid_count, total_bids, is_matched, market_id, mmp_price_version)
         VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
        [userId, bidId, 1, bidAmount, bidAmount, optionId, remaining, remaining, marketId, bid.mmpPriceVersion ?? '0']);
    }
  } finally {
    if ((await redis.get(lock)) === bidId) await redis.del(lock);
  }
}

// Every matched contract, both sides. This is the settlement source of truth —
// see the note at the call site.
let fillsReady = false;
async function recordFill(marketId, userId, optionId, qty, price) {
  if (!fillsReady) {
    await sql.query(
      `CREATE TABLE IF NOT EXISTS standalone_fills (
         id bigint AUTO_INCREMENT PRIMARY KEY, market_id VARCHAR(100), user_id BIGINT,
         option_id INT, qty INT, price DECIMAL(10,2), created_at BIGINT,
         INDEX idx_market (market_id))`);
    fillsReady = true;
  }
  await sql.query(
    `INSERT INTO standalone_fills (market_id, user_id, option_id, qty, price, created_at)
     VALUES (?,?,?,?,?,?)`, [marketId, userId, optionId, qty, price, Date.now()]);
}

// The app creates books per market in production; create on demand so a bid can
// never arrive before its table exists.
const ensured = new Set();
async function ensureBook(marketId, side) {
  const t = book(side, marketId);
  if (ensured.has(t)) return;
  await sql.query(
    `CREATE TABLE IF NOT EXISTS ${t} (
       row_id bigint AUTO_INCREMENT, user_id BIGINT, bid_id VARCHAR(100),
       opponent_bid_id VARCHAR(100), bid_type TINYINT, bid_amount DECIMAL(10,2),
       buy_amount DECIMAL(10,2), option_id INT, current_bid_count INT,
       cancel_bid_count INT, total_bids INT, unused DECIMAL(10,2), credits DECIMAL(10,2),
       bonus DECIMAL(10,2), is_matched TINYINT DEFAULT 0, market_id VARCHAR(100),
       parent_buy_order VARCHAR(50), mmp_price_version VARCHAR(50), PRIMARY KEY(row_id))`);
  ensured.add(t);
}

// ─────────────────────────────────────────────────────────────────────────────
// distribution-engine :7002 — settle a market and pay the winning side.
// ─────────────────────────────────────────────────────────────────────────────
async function marketStatusChange(req, res) {
  const { marketId, answer } = await readBody(req);
  if (!marketId || !answer) return json(res, 200, { status: false, message: 'marketId and answer required' });

  // Winners are paid the full contract value; losers already paid their premium
  // at placement, so settlement only credits. Read from the fills ledger, not
  // the order book — takers never rest, so the book undercounts them.
  const [rows] = await sql.query(
    `SELECT user_id, SUM(qty) AS filled
       FROM standalone_fills WHERE market_id = ? AND option_id = ?
       GROUP BY user_id`, [marketId, Number(answer)]);

  const credits = [];
  for (const r of rows) {
    const qty = Number(r.filled) || 0;
    if (qty <= 0 || Number(r.user_id) === MMP_USER_ID) continue;
    credits.push({ userId: Number(r.user_id), amount: qty * (MARKET_PRICE / 100), ref: marketId });
  }
  if (credits.length) await wallet('batch-process', { credits });

  await ddb.send(new UpdateCommand({
    TableName: TABLES.market, Key: { marketId },
    UpdateExpression: 'SET marketStatus = :s, answer = :a, settledAt = :t, marketDistributionStatus = :d',
    ExpressionAttributeValues: { ':s': 'settled', ':a': answer, ':t': Date.now(), ':d': 'completed' },
  }));
  await redis.srem('predictor_active_markets', marketId);

  log('distribution', `settled ${marketId} answer=${answer} paid ${credits.length} users`);
  json(res, 200, { status: true, settled: marketId, answer, paid: credits.length });
}

// ─────────────────────────────────────────────────────────────────────────────
const serve = (port, name, routes) => http.createServer(async (req, res) => {
  const route = routes[req.url?.split('?')[0]];
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: name });
  if (!route) return json(res, 404, { status: false, message: 'not found' });
  try { await route(req, res); }
  catch (e) { log(name, 'error', e.message); json(res, 200, { status: false, message: e.message }); }
}).listen(port, () => log(name, `listening on :${port}`));

serve(Number(process.env.TRADING_API_PORT || 8080), 'trading-api', { '/skillPolls/placeBid': placeBid });
serve(Number(process.env.MATCHER_PORT || 7001), 'matching-engine', { '/handle': async (req, res) => { await matchBid(await readBody(req)); json(res, 200, { status: true }); } });
serve(Number(process.env.DIST_PORT || 7002), 'distribution-engine', { '/market-status-change': marketStatusChange });

log('standalone', 'order path is self-contained — no external services required');

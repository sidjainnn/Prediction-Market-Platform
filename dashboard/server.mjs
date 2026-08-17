// Live dashboard for the local crypto exchange. Reads the stores for state and
// drives the loop (new market / house quote / user bid / settle) by running the
// same drivers + their engines. Open http://localhost:4000
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, REDIS, MYSQL, MMP_USER_ID, TEST_USERS } from '../setup/local.mjs';
import { digitalDelta } from '../drivers/lib/pricing.mjs';

const SIGMA_PER_SEC = 0.0004;
const TRADING_API = process.env.TRADING_API || 'http://localhost:8080';
const MMP_API_KEY = process.env.MMP_API_KEY || 'localkey';
const HEDGING_SERVICE = process.env.HEDGING_SERVICE || 'http://localhost:8790';

// Pull the live hedge from gb-crypto-hedging-service (the real service is the
// source of truth). Null if it's not running — the panel falls back to the
// inline computeHedge estimate.
async function fetchHedgeService() {
  try {
    const r = await fetch(`${HEDGING_SERVICE}/state`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    const s = await r.json();
    return {
      venue: s.venue, enabled: s.hedger?.enabled, armed: s.gate?.armed, idleReason: s.gate?.idleReason,
      aggregateDelta: s.inventory?.aggregateDelta ?? 0, notionalUsdt: s.inventory?.notionalUsdt ?? 0,
      position: s.hedger?.livePosition ?? 0, hedgePnl: s.hedger?.hedgePnl ?? 0, fees: s.hedger?.feesPaid ?? 0,
      effectiveGate: s.gate?.effectiveGate ?? 0,
    };
  } catch {
    return null;
  }
}

// The house's live directional exposure + the perp hedge that neutralises it.
// When a user buys YES they match the house's NO bid → the house is left SHORT
// YES. Aggregate settlement-value delta = Σ (houseShortYes − houseShortNo)·dp/dS.
// Hedge = hold that many BTC (long if +) so a BTC move offsets the book.
async function computeHedge(activeIds, spot) {
  if (!spot) return { aggregateDelta: 0, notionalUsdt: 0, perMarket: [], hedge: null };
  const bids = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids' }));
  const houseBids = (bids.Items || []).filter((b) => Number(b.userId) === MMP_USER_ID && b.matchedBidsCount > 0);
  let aggregateDelta = 0; const perMarket = [];
  for (const marketId of activeIds) {
    const metaRaw = await redis.get(`MMP_MARKET_META_${marketId}`);
    if (!metaRaw) continue;
    const { strike, expiryTs } = JSON.parse(metaRaw);
    const tau = Math.max((expiryTs - Date.now()) / 1000, 1);
    const mkt = houseBids.filter((b) => String(b.marketId).startsWith(`${marketId}.`));
    const houseYes = mkt.filter((b) => b.optionId === 1).reduce((s, b) => s + Number(b.matchedBidsCount), 0);
    const houseNo = mkt.filter((b) => b.optionId === 2).reduce((s, b) => s + Number(b.matchedBidsCount), 0);
    const shortYes = houseNo - houseYes; // house holds NO ⇒ short YES
    const d = digitalDelta(spot, strike, SIGMA_PER_SEC, tau);
    const delta = shortYes * d;
    aggregateDelta += delta;
    perMarket.push({ marketId, strike, houseYes, houseNo, shortYes, delta });
  }
  const notionalUsdt = Math.abs(aggregateDelta) * spot;
  const hedge = Math.abs(aggregateDelta) < 1e-9 ? null
    : { side: aggregateDelta > 0 ? 'LONG' : 'SHORT', btc: Math.abs(aggregateDelta), notionalUsdt };
  return { aggregateDelta, notionalUsdt, perMarket, hedge };
}

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
const SYMBOL = 'BTCUSDT';
const redis = new Redis(REDIS);
const db = await mysql.createPool(MYSQL);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));
const log = [];
const addLog = (m) => { log.unshift(`${new Date().toISOString().slice(11, 19)}  ${m}`); log.length = Math.min(log.length, 40); };

function runDriver(rel, args = []) {
  return new Promise((res) => {
    const p = spawn('node', [path.join(ROOT, rel), ...args], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => res(out.trim()));
  });
}

async function getState() {
  const spotRaw = await redis.get(`CRYPTO_SPOT_${SYMBOL}`);
  const spot = spotRaw ? JSON.parse(spotRaw).price : null;
  const activeIds = await redis.smembers('predictor_active_markets');
  const scan = await ddb.send(new ScanCommand({ TableName: 'market' }));
  const markets = (scan.Items || []).sort((a, b) => (b.marketId > a.marketId ? 1 : -1));
  const active = markets.find((m) => activeIds.includes(m.marketId));

  let book = { yes: [], no: [] };
  if (active) {
    for (const side of ['yes', 'no']) {
      try {
        const [rows] = await db.query(
          `SELECT user_id, bid_amount/100 AS price, current_bid_count AS qty, is_matched FROM \`bb_available_bids_${side}_${active.marketId}\` ORDER BY row_id`);
        book[side] = rows.map((r) => ({ ...r, who: Number(r.user_id) === MMP_USER_ID ? 'HOUSE' : 'user' }));
      } catch { /* table maybe not created */ }
    }
    const meta = await redis.get(`MMP_MARKET_META_${active.marketId}`);
    active._meta = meta ? JSON.parse(meta) : null;
  }
  const [bal] = await db.query('SELECT user_id, unused_amount FROM bb_users ORDER BY user_id');
  const settled = markets.filter((m) => m.answer != null).slice(0, 5)
    .map((m) => ({ marketId: m.marketId, q: m.question?.en, answer: m.answer === 1 ? 'YES' : 'NO', settledValue: m.settledValue }));
  const hedge = await computeHedge(activeIds, spot);
  const hedgeService = await fetchHedgeService();
  return { spot, active, book, balances: bal, settled, hedge, hedgeService, log, mmpUser: MMP_USER_ID, testUser: TEST_USERS[0] };
}

// full settlement chain (resolve → assign → distribute → wallet), the proven path
async function settle() {
  const ids = await redis.smembers('predictor_active_markets');
  if (!ids.length) return addLog('no active market to settle');
  const marketId = ids[0];
  const meta = JSON.parse(await redis.get(`MMP_MARKET_META_${marketId}`));
  meta.expiryTs = Date.now() - 1000; // force expiry for the demo
  await redis.set(`MMP_MARKET_META_${marketId}`, JSON.stringify(meta));
  await runDriver('drivers/settlement/index.mjs');
  addLog(`settlement: resolved ${marketId}`);
  // assign winning + distribute via their distribution engine
  await fetch(`http://localhost:3010/pt/assign/winning/${marketId}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await ddb.send(new UpdateCommand({ TableName: 'market', Key: { marketId }, UpdateExpression: 'SET marketDistributionStatus = :s', ExpressionAttributeValues: { ':s': 3 } }));
  await fetch(`http://localhost:3010/pt/distribute/winning/${marketId}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  // dispatch the engine-computed winnings to the wallet
  const bids = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids' }));
  const winners = (bids.Items || []).filter((b) => b.winningAmount > 0);
  for (const w of winners) {
    await fetch('http://localhost:3000/wallet/batch-process', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: `${marketId}-b`, clientId: 1, txn: [{ user_id: w.userId, unused: w.winningAmount / 100, market_id: marketId }] }),
    }).catch(() => {});
    addLog(`payout: user ${w.userId} won $${(w.winningAmount / 100).toFixed(2)}`);
  }
  if (!winners.length) addLog('settled — no winning payouts this market');
}

const server = http.createServer(async (req, res) => {
  // CORS so the page works even when opened from a file/preview origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.url === '/' || req.url === '/index.html') {
      const html = await readFile(path.join(__dir, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html);
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(await getState()));
    }
    if (req.method === 'POST') {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/new-market') { const o = await runDriver('drivers/market-generator/index.mjs'); addLog('market created: ' + (o.split('|')[1] || '').trim()); }
      else if (u.pathname === '/api/quote') { await runDriver('drivers/mmp-pricing/index.mjs'); addLog('house posted YES/NO quotes'); }
      else if (u.pathname === '/api/buy') {
        const side = u.searchParams.get('side') || 'YES';
        const price = u.searchParams.get('price') || '55';
        const qty = u.searchParams.get('qty') || '50';
        const optionId = side === 'YES' ? 1 : 2;
        const ids = await redis.smembers('predictor_active_markets');
        // newest market (marketId embeds the creation timestamp: btc5m<ts>)
        const marketId = ids.sort().reverse()[0];
        // real ingress: POST through their trading-api → SQS → bridge → matcher.
        // Falls back to the direct driver if the trading-api isn't running.
        let via = 'trading-api';
        try {
          const r = await fetch(`${TRADING_API}/skillPolls/placeBid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', user_id: String(TEST_USERS[0]), api_key: MMP_API_KEY, mmp_price_version: '0' },
            body: JSON.stringify({ marketId, option: { bidAmount: Number(price), bidCount: Number(qty), optionId }, mmp: { isHedge: 0 } }),
          });
          if (!r.ok) throw new Error('status ' + r.status);
        } catch { via = 'driver'; await runDriver('drivers/place-user-bid.mjs', [side, price, qty]); }
        addLog(`user bought ${side} @ ${price}¢ x${qty} (via ${via})`);
      }
      else if (u.pathname === '/api/settle') { await settle(); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
server.listen(4000, () => console.log('[dashboard] http://localhost:4000'));

// Auto-loop — turns the local exchange into a living QA env. Each round it runs
// the full real-ingress lifecycle through the dashboard API (which posts user
// bids through their real trading-api and settles on their real distribution
// engine): new market → house quotes → randomised user trades → settle + payout.
//
//   node drivers/auto-loop/index.mjs           (default 30s rounds, 3 trades each)
//   ROUND_MS=15000 TRADES=5 node drivers/auto-loop/index.mjs
const API = process.env.DASHBOARD_API || 'http://localhost:4000';
const ROUND_MS = Number(process.env.ROUND_MS || 30000);
const TRADES = Number(process.env.TRADES || 3);

const post = (p) => fetch(`${API}${p}`, { method: 'POST' }).then((r) => r.ok).catch(() => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let round = 0;
async function cycle() {
  round++;
  const t = new Date().toISOString().slice(11, 19);
  console.log(`\n[${t}] round ${round} ─────────────`);
  await post('/api/new-market'); await sleep(600);
  await post('/api/quote');       await sleep(600);
  for (let i = 0; i < TRADES; i++) {
    const side = pick(['YES', 'NO']);
    // price must be a multiple of the market tick (inputPriceInterval=5) or
    // the trading-api's validateBid rejects it with INVALID_BID_INFO
    const price = pick([45, 50, 55, 60]);
    const qty = pick([20, 30, 40, 50]);
    await post(`/api/buy?side=${side}&price=${price}&qty=${qty}`);
    console.log(`   trade: ${side} @ ${price}¢ x${qty}`);
    await sleep(500);
  }
  // let the position sit for the rest of the round, then settle + pay out
  await sleep(Math.max(ROUND_MS - 3000, 1000));
  await post('/api/settle');
  console.log(`   settled round ${round}`);
}

console.log(`[auto-loop] ${ROUND_MS / 1000}s rounds · ${TRADES} trades/round · via ${API}`);
while (true) {
  try { await cycle(); } catch (e) { console.error('[auto-loop] round error:', e.message); await sleep(2000); }
}

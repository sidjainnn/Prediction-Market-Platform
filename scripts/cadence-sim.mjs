// Reconstructs REAL house-inventory paths from actual matched-fill timestamps
// (ground truth, not 10s-sampled), then simulates the hedger's own
// reconcile()/deadband logic at different (poll interval, deadband) pairs
// against that real path — to answer "would tighter cadence add fee churn or
// just catch real spikes?" with data instead of theory.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, MMP_USER_ID } from '../setup/local.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

function normPdf(x) { return 0.3989422804 * Math.exp(-x * x / 2); }
function digitalDelta(spot, strike, sigma, tau) {
  tau = Math.max(tau, 1e-9); sigma = Math.max(sigma, 1e-12);
  const denom = sigma * Math.sqrt(tau);
  const d = (Math.log(spot / strike) - 0.5 * sigma * sigma * tau) / denom;
  return normPdf(d) / (spot * denom);
}

// 1. pull every house-matched fill, with real timestamps
let items = [], k;
do { const s = await ddb.send(new ScanCommand({ TableName: 'bb_pending_bids', ExclusiveStartKey: k })); items = items.concat(s.Items || []); k = s.LastEvaluatedKey; } while (k);
const houseFills = items.filter(x => Number(x.userId) === MMP_USER_ID && Number(x.matchedBidsCount) > 0 && x.createdAt);

// 2. group by market, get strike/expiry from the market table
const byMarket = {};
for (const f of houseFills) {
  const mkt = String(f.marketId).split('.')[0];
  (byMarket[mkt] ??= []).push(f);
}
const marketIds = Object.keys(byMarket);
console.log(`Reconstructing ${marketIds.length} markets, ${houseFills.length} real fill events...\n`);

const paths = []; // { events: [{t, netSkew}], strike, expiryTs, createdAtMs }
for (const mkt of marketIds) {
  const m = await ddb.send(new GetCommand({ TableName: 'market', Key: { marketId: mkt } }));
  if (!m.Item) continue;
  // market table has no top-level `strike` field — it only lives in the
  // question text ("...>= $65800 at...") and in Redis MMP_MARKET_META_*,
  // which settlement prunes. Parse it back out of the question.
  const qMatch = /\$([0-9,]+)/.exec(m.Item.question?.en || '');
  if (!qMatch) continue;
  const strike = Number(qMatch[1].replace(/,/g, ''));
  const expiryTs = new Date(m.Item.endTime).getTime();
  const createdMs = new Date(m.Item.createdAt).getTime();
  if (!Number.isFinite(strike) || !Number.isFinite(expiryTs)) continue;
  const fills = byMarket[mkt].slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let houseYes = 0, houseNo = 0;
  const events = [];
  for (const f of fills) {
    const qty = Number(f.matchedBidsCount);
    if (Number(f.optionId) === 1) houseYes += qty; else houseNo += qty;
    const t = new Date(f.createdAt).getTime();
    events.push({ t, netSkew: houseNo - houseYes }); // inventory-mirror convention
  }
  if (events.length) paths.push({ mkt, strike, expiryTs, createdMs, events });
}

// classify drift vs whipsaw: count sign reversals in netSkew across each path
let totalReversals = 0, totalSteps = 0;
for (const p of paths) {
  let prevSign = 0;
  for (const e of p.events) {
    const s = Math.sign(e.netSkew);
    if (prevSign !== 0 && s !== 0 && s !== prevSign) totalReversals++;
    if (s !== 0) prevSign = s;
    totalSteps++;
  }
}
console.log(`Direction reversals across all real inventory paths: ${totalReversals} / ${totalSteps} fill-events (${(100*totalReversals/totalSteps).toFixed(1)}%)`);
console.log(`(low % = mostly monotonic drift; high % = whipsaw/oscillation)\n`);

// 3. simulate hedger reconcile+deadband against the REAL path, at various settings
const TAKER_BPS = 4;
const SIGMA = 0.0001; // representative realized vol observed in this session's /state snapshots
const MAX_NOTIONAL = 3000;

function simulate(intervalSec, deadbandUsdt) {
  let totalFees = 0, totalFills = 0, totalNotional = 0;
  let unhedgedAreaUsd = 0, totalDurationSec = 0;
  for (const p of paths) {
    const spot = p.strike; // ATM approximation — see note in the writeup
    let pos = 0;
    const startT = p.events[0].t, endT = Math.min(p.expiryTs, p.events[p.events.length - 1].t + 20000);
    for (let t = startT; t <= endT; t += intervalSec * 1000) {
      // netSkew held from the most recent real fill at/<= t (step function)
      let netSkew = 0;
      for (const e of p.events) { if (e.t <= t) netSkew = e.netSkew; else break; }
      const tauSec = Math.max((p.expiryTs - t) / 1000, 1);
      const dpdS = digitalDelta(spot, p.strike, SIGMA, tauSec);
      const targetDelta = netSkew * dpdS;
      const cap = MAX_NOTIONAL / spot;
      const target = Math.max(-cap, Math.min(cap, targetDelta));
      const diff = target - pos;
      const notionalDiff = Math.abs(diff) * spot;
      unhedgedAreaUsd += Math.abs(target - pos) * spot * intervalSec;
      totalDurationSec += intervalSec;
      if (notionalDiff >= deadbandUsdt) {
        totalFees += notionalDiff * (TAKER_BPS / 1e4);
        totalNotional += notionalDiff;
        totalFills++;
        pos = target;
      }
    }
  }
  return { totalFees, totalFills, totalNotional, avgUnhedgedUsd: unhedgedAreaUsd / Math.max(totalDurationSec, 1) };
}

console.log('cadence  deadband   fills   fees      notional traded   avg unhedged exposure');
for (const [interval, deadband] of [[10, 75], [5, 75], [3, 75], [10, 150], [5, 125], [3, 150], [2, 150]]) {
  const r = simulate(interval, deadband);
  console.log(
    `${String(interval).padStart(2)}s      $${String(deadband).padEnd(4)}    ${String(r.totalFills).padStart(4)}   $${r.totalFees.toFixed(2).padStart(7)}   $${r.totalNotional.toFixed(0).padStart(9)}        $${r.avgUnhedgedUsd.toFixed(0)}`
  );
}

// Isolate the specific incident market from the earlier gate-audit conversation
const incident = paths.find(p => p.mkt === 'btc5m1784818643019');
if (incident) {
  console.log(`\n--- isolating the earlier $456k-exposure incident market (${incident.mkt}) ---`);
  console.log(`fills: ${incident.events.length}, strike: $${incident.strike}`);
  function simOne(p, intervalSec, deadbandUsdt) {
    let pos = 0, fees = 0, fills = 0, unhedgedPeakUsd = 0;
    const spot = p.strike;
    const startT = p.events[0].t, endT = Math.min(p.expiryTs, p.events[p.events.length - 1].t + 20000);
    for (let t = startT; t <= endT; t += intervalSec * 1000) {
      let netSkew = 0;
      for (const e of p.events) { if (e.t <= t) netSkew = e.netSkew; else break; }
      const tauSec = Math.max((p.expiryTs - t) / 1000, 1);
      const dpdS = digitalDelta(spot, p.strike, SIGMA, tauSec);
      const targetDelta = netSkew * dpdS;
      const cap = MAX_NOTIONAL / spot;
      const target = Math.max(-cap, Math.min(cap, targetDelta));
      const unhedged = Math.abs(targetDelta * spot - pos * spot); // TRUE exposure vs capped position — shows the cap gap
      unhedgedPeakUsd = Math.max(unhedgedPeakUsd, unhedged);
      const diff = target - pos;
      if (Math.abs(diff) * spot >= deadbandUsdt) { fees += Math.abs(diff) * spot * (TAKER_BPS / 1e4); fills++; pos = target; }
    }
    return { fees, fills, unhedgedPeakUsd };
  }
  for (const [interval, deadband] of [[10, 75], [3, 150]]) {
    const r = simOne(incident, interval, deadband);
    console.log(`  ${interval}s/$${deadband}: fills=${r.fills} fees=$${r.fees.toFixed(2)} PEAK true-exposure-vs-capped-position gap=$${r.unhedgedPeakUsd.toFixed(0)}`);
  }
}

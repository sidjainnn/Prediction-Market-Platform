// Oracle feed — streams Binance BTC spot over WebSocket (aggTrade) and publishes
// the latest price to Redis for the market-generator (strike), mmp-pricing (fair
// value), settlement (resolve vs strike) and the hedging service to read. Real-time
// (per-trade) instead of a 1s REST poll. Public read-only stream, no keys.
//
// Hardened against SILENT stalls: a long-lived WS can go dead on the wire (NAT/
// firewall/sleep-wake) without ever firing 'close' or 'error' — the socket looks
// "open" forever while no data arrives. A staleness watchdog therefore doesn't
// just warn, it actively force-closes and reconnects. A generation counter guards
// against a stale socket's late events undoing a fresher reconnect.
//
//   node drivers/oracle-feed/index.mjs
import Redis from 'ioredis';
import { REDIS } from '../../setup/local.mjs';

const SYMBOL = (process.env.ORACLE_SYMBOL || 'BTCUSDT').toUpperCase();
const KEY = `CRYPTO_SPOT_${SYMBOL}`;
const CHAN = `spot:${SYMBOL}`;   // pub/sub channel for latency-sensitive consumers
const WS_BASE = process.env.BINANCE_WS_BASE || 'wss://stream.binance.com:9443';
const STREAM = `${WS_BASE}/ws/${SYMBOL.toLowerCase()}@aggTrade`;
const WRITE_THROTTLE_MS = Number(process.env.SPOT_WRITE_MS || 250); // cap Redis writes
const STALE_MS = Number(process.env.ORACLE_STALE_MS || 20_000);      // force-reconnect threshold

const redis = new Redis(REDIS);
let ws = null;
let gen = 0;          // generation counter — invalidates a stale socket's late events
let lastWrite = 0;
let connectAt = 0;    // when the CURRENT dial started — the watchdog's fallback
                       // deadline for a connect that never delivers a first message
let backoff = 500;

function connect() {
  connectAt = Date.now(); // every dial gets its own watchdog deadline
  const myGen = ++gen;
  let sock;
  try { sock = new WebSocket(STREAM); } catch (e) {
    process.stdout.write(`\n[oracle] WS construct failed: ${String(e).slice(0, 60)} — retrying in ${backoff}ms\n`);
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); return;
  }
  ws = sock;

  sock.addEventListener('open', () => {
    if (myGen !== gen) return;
    backoff = 500;
    console.log(`\n[oracle] WS connected ${STREAM} → redis ${KEY}`);
  });

  sock.addEventListener('message', async (ev) => {
    if (myGen !== gen) return;
    try {
      const m = JSON.parse(ev.data);
      const p = parseFloat(m.p); // aggTrade price
      if (!(p > 0)) return;
      const now = Date.now();
      lastWrite = now; // mark data arrival even if we throttle the Redis write below
      // PUBLISH on EVERY tick, unthrottled (2026-07-31). The SET below stays
      // throttled to WRITE_THROTTLE_MS because it exists for pollers (app,
      // settlement, market-generator) that only need a recent value and would
      // otherwise hammer Redis. But the QUOTER must not inherit that lag: with
      // a 250ms write throttle plus its own 400ms poll, a price move could be
      // up to ~650ms stale before it reached a quote — measured Redis spot age
      // ranged 27ms to 1081ms — and quoting a stale price during a fast move is
      // exactly how a maker gets picked off. PUBLISH is fire-and-forget and
      // costs nothing when nobody is subscribed, so consumers that want
      // tick-level latency can subscribe instead of poll.
      redis.publish(CHAN, `${p}`).catch(() => {}); // best-effort, never block the feed
      if (now - _lastRedisWrite < WRITE_THROTTLE_MS) return;
      _lastRedisWrite = now;
      await redis.set(KEY, JSON.stringify({ price: p, ts: now, symbol: SYMBOL }));
      process.stdout.write(`\r[oracle] ${SYMBOL} $${p.toFixed(1)}  → redis ${KEY}      `);
    } catch { /* ignore malformed frame */ }
  });

  const reconnect = (why) => {
    if (myGen !== gen) return; // a newer socket already superseded this one
    gen++; // invalidate any further late events from this socket
    process.stdout.write(`\r[oracle] WS ${why} — reconnecting in ${backoff}ms         \n`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
  sock.addEventListener('close', () => reconnect('closed'));
  sock.addEventListener('error', () => { try { sock.close(); } catch { /* ignore */ } reconnect('error'); });
}
let _lastRedisWrite = 0;

// Staleness watchdog: a socket that never fires close/error but also never
// delivers data is worse than a visibly dead one — force it closed and rebuild.
//
// Trigger on "no data since the last DIAL" (lastWrite || connectAt), not "since
// the last message" (lastWrite alone). The old `if (!lastWrite) return` was
// self-disabling: a reconnect zeroes lastWrite, so if THAT reconnect also never
// delivered a first message — e.g. the socket that dies on a laptop sleep/wake,
// then the wake-up reconnect lands before the network is back — lastWrite stayed
// 0 forever and this was read as "still waiting on the first message since boot".
// The watchdog never fired again and the feed froze on its last price. Observed
// live: the oracle sat ~24h stale at a price ~$700 off, which made the whole
// app price off a phantom spot (chart glitch, wrong fair value, wrong strike
// proximity) until manually restarted.
setInterval(() => {
  const since = lastWrite || connectAt;
  if (!since) return; // connect() hasn't run yet
  const age = Date.now() - since;
  if (age > STALE_MS) {
    process.stdout.write(`\n[oracle] WARN: no data in ${(age / 1000).toFixed(0)}s (since ${lastWrite ? 'last data' : 'last connect attempt'}) — forcing reconnect\n`);
    gen++; // orphan the stalled socket's future events before we touch it
    try { ws?.close(); } catch { /* ignore */ }
    lastWrite = 0;
    connect(); // stamps a fresh connectAt for this attempt
  }
}, 5_000);

console.log(`[oracle] streaming ${SYMBOL} spot via WebSocket → redis ${KEY} (stale watchdog: ${STALE_MS}ms)`);
connect();

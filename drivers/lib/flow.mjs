// Formalized order-flow imbalance (OFI) — a directional TRADING PRESSURE
// signal, distinct from and faster-moving than the house's own accumulated
// inventory skew. Only AGGRESSIVE (taker-initiated) fills are recorded here —
// never maker/resting placements — so this is not a "fill imbalance" ratio.
import Redis from 'ioredis';
import { REDIS } from '../../setup/local.mjs';

const redis = new Redis(REDIS);
const MAX_ENTRIES = 40;
const TTL_SEC = 120;

// entry: { side: 'yes'|'no', qty, price, timestamp }
export async function recordAggressiveFill(marketId, entry) {
  const key = `app:flow:${marketId}`;
  await redis.lpush(key, JSON.stringify(entry));
  await redis.ltrim(key, 0, MAX_ENTRIES - 1);
  await redis.expire(key, TTL_SEC);
}

// OFI = (aggressive YES volume - aggressive NO volume) / total aggressive
// volume. Signed, in [-1,1]. Returns 0 when there's no recent flow.
export async function orderFlowImbalance(marketId) {
  const raw = await redis.lrange(`app:flow:${marketId}`, 0, MAX_ENTRIES - 1);
  let yesVol = 0, noVol = 0;
  for (const s of raw) {
    try {
      const { side, qty } = JSON.parse(s);
      if (side === 'yes') yesVol += qty; else if (side === 'no') noVol += qty;
    } catch { /* skip malformed */ }
  }
  const total = yesVol + noVol;
  return total > 0 ? (yesVol - noVol) / total : 0;
}

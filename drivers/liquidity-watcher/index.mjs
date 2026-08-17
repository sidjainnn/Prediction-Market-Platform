// Liquidity watcher — diagnostic-only, no side effects on trading. Polls every
// active market's resting book at high frequency (default 400ms, tight enough
// to catch the sub-second cancel-then-repost gap in mmp-pricing/index.mjs)
// and logs a timestamped alert whenever a market that ISN'T in its legitimate
// near-expiry lockout window has zero resting liquidity on either side.
//
// Root cause this exists to catch evidence for (2026-07-30 investigation):
// mmp-pricing cancels a market's ENTIRE stale ladder (both sides, in
// parallel), THEN reposts the new ladder (also in parallel) — see
// Promise.all at lines 351/366 of mmp-pricing/index.mjs. Cancel fully
// completes before repost starts, so every single requote cycle has a real,
// brief window where the book is genuinely empty on both sides. This was
// invisible when a market requoted rarely; a volatile market whose fair
// value crosses the 1% refresh threshold every few seconds (driver.log
// showed 6 requote cycles in 38s for one 5-minute market) multiplies how
// often a page load can land inside that window.
//
// This watcher doesn't fix that gap — it makes it observable: run it
// whenever chasing a liquidity report, correlate its timestamps against
// data/driver.log's requote cycle timestamps to confirm/deny root cause on
// any FUTURE report, instead of re-deriving this from scratch each time.
//
//   node drivers/liquidity-watcher/index.mjs         # run until Ctrl-C
//   POLL_MS=200 node drivers/liquidity-watcher/index.mjs

import Redis from 'ioredis';
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDIS, MYSQL } from '../../setup/local.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_PATH = path.join(ROOT, 'data', 'liquidity-watch.log');
const LOG_MAX = 2_000_000; // truncate past ~2MB, same pattern as data/driver.log
const POLL_MS = Number(process.env.POLL_MS || 400);
// Same threshold mmp-pricing/server.mjs already use for "close enough to
// expiry that single-sided/thin quoting is intentional lockout behavior, not
// a bug" — matches MMP_LOCKOUT_REFRESH_BUFFER_SEC's default in server.mjs.
const LOCKOUT_BUFFER_SEC = Number(process.env.LOCKOUT_BUFFER_SEC || 30);

const redis = new Redis(REDIS);
const db = await mysql.createPool({ ...MYSQL, waitForConnections: true, connectionLimit: 4 });

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX) fs.writeFileSync(LOG_PATH, '');
    fs.appendFileSync(LOG_PATH, stamped + '\n');
  } catch { /* best-effort */ }
}

// Structured, analysis-friendly record — one row per RESOLVED gap (the text
// log above is for reading live; this is for querying later: distribution of
// gap durations, correlating against data/driver.log timestamps, etc.
const CSV_PATH = path.join(ROOT, 'data', 'liquidity-watch.csv');
const CSV_COLUMNS = ['started_at', 'resolved_at', 'market_id', 'side', 'duration_ms', 'tau_at_start_sec'];
try {
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_COLUMNS.join(',') + '\n');
} catch { /* best-effort */ }
function logCsv(row) {
  try {
    fs.appendFileSync(CSV_PATH, CSV_COLUMNS.map((c) => row[c]).join(',') + '\n');
  } catch { /* best-effort */ }
}

async function unmatchedCount(marketId, side) {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS c FROM \`bb_available_bids_${side}_${marketId}\` WHERE current_bid_count > 0 AND is_matched = 0`);
    return Number(rows[0]?.c ?? 0);
  } catch {
    return -1; // table doesn't exist yet (market just created) — not an alert-worthy state
  }
}

// Best resting price on the given side, or null if none. Used to detect
// mmp-pricing's own "directional lockout — underdog" rule (see
// drivers/mmp-pricing/index.mjs) — a SEPARATE legitimate reason for a side
// to be intentionally empty, independent of time-to-expiry: when the market
// is strongly directional (extreme fair value), the near-worthless underdog
// side is deliberately skipped, which can persist for a long stretch, not
// just near expiry. First version of this watcher only knew about the
// expiry-based lockout and false-positived hard on this (confirmed live: a
// 26s "gap" that was actually continuous, healthy quoting the whole time —
// the log showed regular reposts every 1-2s with "YES 0 sh ... YES side
// skipped (directional lockout)" throughout). Approximate the same signal
// here without duplicating mmp-pricing's own risk-gate math: if the OTHER
// side is resting at an extreme price, treat this side's emptiness as
// expected rather than alert-worthy.
const DIRECTIONAL_PRICE_THRESHOLD = Number(process.env.DIRECTIONAL_PRICE_THRESHOLD || 90);
async function bestPrice(marketId, side) {
  try {
    const [rows] = await db.query(
      `SELECT MAX(bid_amount) AS p FROM \`bb_available_bids_${side}_${marketId}\` WHERE current_bid_count > 0 AND is_matched = 0`);
    const p = rows[0]?.p;
    return p == null ? null : Number(p) / 100;
  } catch {
    return null;
  }
}

// Tracks consecutive empty-ticks per (marketId, side) so the log reports an
// estimated GAP DURATION, not just "empty at instant X" — much more useful
// for telling a real stuck-empty bug apart from a normal sub-second blip.
const emptyStreak = new Map(); // key: `${marketId}:${side}` -> {since, ticks}

// Live state published to Redis each tick so the BitBull frontend (via
// server.mjs's /api/liquidity-watch route) can show watcher status without
// tailing log files — the actual "deploy the watcher on the website" ask.
const REDIS_STATE_KEY = 'liquidity_watch_state';
const REDIS_STATE_TTL_SEC = 30; // stale key = watcher process is dead, not just quiet
const recentGaps = []; // ring buffer of resolved gaps, newest first
const RECENT_GAPS_MAX = 30;

async function publishState(now) {
  const activeAlerts = [...emptyStreak.entries()].map(([key, s]) => {
    const [marketId, side] = key.split(':');
    return { marketId, side, emptyMs: now - s.since, tauAtStart: s.tauAtStart };
  });
  const state = { updatedAt: now, pollMs: POLL_MS, activeAlerts, recentGaps };
  try { await redis.set(REDIS_STATE_KEY, JSON.stringify(state), 'EX', REDIS_STATE_TTL_SEC); } catch { /* best-effort */ }
}

async function tick() {
  const ids = await redis.smembers('predictor_active_markets');
  const now = Date.now();
  for (const id of ids) {
    const raw = await redis.get(`MMP_MARKET_META_${id}`);
    if (!raw) continue;
    let mt;
    try { mt = JSON.parse(raw); } catch { continue; }
    const tauSec = (mt.expiryTs - now) / 1000;
    const inLockoutWindow = tauSec <= LOCKOUT_BUFFER_SEC;

    for (const side of ['yes', 'no']) {
      const key = `${id}:${side}`;
      const count = await unmatchedCount(id, side);
      if (count < 0) continue; // table not created yet, not an alert condition

      let directionalSkip = false;
      if (count === 0 && !inLockoutWindow) {
        const otherSide = side === 'yes' ? 'no' : 'yes';
        const otherBest = await bestPrice(id, otherSide);
        directionalSkip = otherBest != null && otherBest >= DIRECTIONAL_PRICE_THRESHOLD / 100;
      }

      if (count === 0 && !inLockoutWindow && !directionalSkip) {
        const streak = emptyStreak.get(key) ?? { since: now, ticks: 0, tauAtStart: tauSec };
        streak.ticks++;
        emptyStreak.set(key, streak);
        // Log on transition into empty (ticks===1) and then every ~1s while it
        // persists, rather than once per poll — keeps the log readable during
        // a real sustained outage while still catching brief blips.
        if (streak.ticks === 1 || streak.ticks % Math.max(1, Math.round(1000 / POLL_MS)) === 0) {
          log(`ALERT ${id} ${side.toUpperCase()} side EMPTY for ${now - streak.since}ms so far (τ=${tauSec.toFixed(0)}s, not in lockout window)`);
        }
      } else if (emptyStreak.has(key)) {
        const streak = emptyStreak.get(key);
        const durationMs = now - streak.since;
        log(`RESOLVED ${id} ${side.toUpperCase()} side was empty for ${durationMs}ms total`);
        logCsv({
          started_at: new Date(streak.since).toISOString(), resolved_at: new Date(now).toISOString(),
          market_id: id, side, duration_ms: durationMs, tau_at_start_sec: streak.tauAtStart.toFixed(1),
        });
        recentGaps.unshift({ marketId: id, side, durationMs, resolvedAt: now, tauAtStart: streak.tauAtStart });
        recentGaps.length = Math.min(recentGaps.length, RECENT_GAPS_MAX);
        emptyStreak.delete(key);
      }
    }
  }
  await publishState(now);
}

log(`liquidity-watcher started, polling every ${POLL_MS}ms, lockout buffer ${LOCKOUT_BUFFER_SEC}s`);
setInterval(() => tick().catch((e) => log(`watcher error: ${String(e).slice(0, 120)}`)), POLL_MS);

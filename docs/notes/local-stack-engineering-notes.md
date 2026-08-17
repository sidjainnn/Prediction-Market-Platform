> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

`~/Desktop/gb-crypto-local` is the local crypto-vertical build that drives GameBull's
**real, unmodified** services (no Bitbucket pushes, no repo edits) via a docker stack
(redis/mysql8/dynamodb-local/elasticmq-sqs/postgres) + local driver services.

**Stage 2 complete (2026-07-13): real bid ingress works end-to-end.** A user bid now
flows through their actual `gb-trading-api-service` (`POST /skillPolls/placeBid`, :8080)
→ writes `bb_pending_bids` (DynamoDB) → enqueues SQS → our `drivers/sqs-bridge` polls
`matching-engine.fifo` (elasticmq) → POSTs to their `gb-trading-matching-engine-service`
`/handle` (:7001) → `Matching Done`. Settlement/payout runs on their real
`gb-trading-distribution-engine-se` (:3010). Only stub left = wallet (our
`drivers/wallet-stub` :3000, now serves fetch-wallet + debit/credit + batch-process
against `bb_users`). Wallet debit is real accounting (deducted $2887.50/bid).

**The three seams that made trading-api run locally (all external, no repo changes):**
1. **Auth** — `checkToken` → `CheckMmpUser.checkIfMmpUser` has env flag `SKIP_MMP_AUTH=1`;
   with it, only `api_key == config.mmp.apiKeyForMmp` (env `MMP_API_KEY`) is needed, no
   IP allowlist, no JWT. Pass headers `user_id` + `api_key`.
2. **SQS host** — aws-sdk **v2 SQS derives request host from `params.QueueUrl`** (ignores
   client endpoint), and `SqsService` hardcodes `https://sqs.<region>.amazonaws.com/…`, so
   it hit real AWS (403 InvalidClientTokenId). Fixed in `run/aws-local.cjs` preload by
   wrapping each SQS **instance's** methods (NOT prototype — v2 attaches ops lazily, so
   prototype methods are undefined at preload) to rewrite QueueUrl → localhost:9324 path.
3. **Market shape** — `getActiveMarketInfo` reads the **DynamoDB** `market` table (not
   MySQL). Controller destructures `market.event{eN,eSN,c{…},…}`, `market.exchangeRate[ccy]`,
   `market.shardedMarket` → POLL_ENDED/crash if absent. Added all three to
   `drivers/market-generator`.

Run cmd for trading-api: `node -r ~/Desktop/gb-crypto-local/run/aws-local.cjs bin/www.js`
with NODE_ENV=development PORT=8080 MMP_USER_ID=999999999 MMP_API_KEY=localkey
SKIP_MMP_AUTH=1 ACCOUNT_ID=000000000000 MATCHING_SQS_NAME=matching-engine.fifo + the
mysql/redis/dynamo/sqs endpoint envs. Live dashboard :4000 — its "User buys" button now
routes through the real trading-api (falls back to `place-user-bid` driver if :8080 down).

**Stage 2 finished:** `drivers/sqs-bridge` now drains BOTH `matching-engine.fifo` and
`sell-order.fifo` → `/handle` (MatchingEngine handles buy bidType 0 + sell bidType 1 in
the same path). `drivers/auto-loop` cycles the full real-ingress lifecycle unattended
(new market → quote → randomised buys via trading-api → settle+payout) — a living QA env.
Gotcha: trading-api `validateBid` rejects any bidAmount not a multiple of the market tick
(`inputPriceInterval=5`) with INVALID_BID_INFO, so use prices ∈ {45,50,55,60}. Two local
items deliberately NOT done (they'd need repo edits → Stage 1): **cancel-order** (its
lambda isn't exposed over HTTP `/handle`) and standing up their **real wallet-api** (still
our `wallet-stub`).

Hedging: dashboard `computeHedge` reads house matched inventory from `bb_pending_bids`
→ Σ(houseNo−houseYes)·digitalDelta → perp hedge. See [[gamebull-integration]],
[[amm-hedging-project]]. Stage 1 (crypto pieces needing PRs + Paras approval) still
pending — see `docs/gamebull-crypto-build.md`.

## 2026-07-30: "no liquidity" bug investigation, fix, and website watcher panel

Separate from the earlier "no-liquidity flash" fix in [[bitbull-app-findings]]
(a request-ordering bug inside one requote cycle) — this was a NEW recurrence
traced to **process-spawn cold-start variance under system-wide RAM pressure**
(Kronos fine-tuning, see [[kronos-finetuning]], plus Docker's VM both
competing for the same 16GB).

**Root causes found and fixed in `app/server.mjs` + `drivers/mmp-pricing/index.mjs`:**
1. Old design spawned a **fresh `node` process every requote cycle**
   (fork/exec + V8 init + fresh DB/Redis handshakes each time — real, variable
   cold-start cost). Converted to a **persistent long-lived quoter worker**
   (`startPersistentQuoter()`, spawned once, loops internally on
   `MMP_QUOTER_LOOP_MS`, auto-restarts itself on crash). Backed by a tested
   rollback script (`data/backups/rollback-persistent-worker.sh`), matching
   the toggle+rollback discipline noted in [[bitbull-app-findings]].
2. **Self-introduced race during that conversion**: `lifecycle()`'s old
   explicit "house seeds both sides" call on market creation spawned a SECOND
   uncoordinated `mmp-pricing` process that raced the new persistent worker on
   brand-new markets — confirmed live (back-to-back `cancelled 48+49` /
   `cancelled 15+17` log lines with no repost between them, 15s+ empty-book
   gap). Fixed by deleting the now-redundant seed call.
2b. Also found and killed a **duplicate standalone market-generator** process
   left over from an earlier rollback, uncoordinated with `lifecycle()`'s own
   market-creation logic — was doubling the quoter's per-cycle workload.
3. **Unbounded `placeBid()` fetch** with no timeout — could hang the entire
   sequential `quoteAll()` loop for 40+ seconds under contention. Fixed with
   `AbortSignal.timeout(5000)` + per-post/per-market try/catch isolation so
   one failure doesn't cascade (backed by `rollback-timeout-fix.sh`).
4. Built `drivers/liquidity-watcher/index.mjs` (polls every 400ms, logs
   `data/liquidity-watch.{log,csv}`) — initially false-positived on
   mmp-pricing's legitimate "directional lockout — underdog" business rule
   (skips the near-worthless side when fair value is extreme, independent of
   time-to-expiry); fixed by adding a `bestPrice()` check on the OTHER side.

**Root-cause correction, user-driven:** initial diagnosis blamed pure CPU
scheduling contention (load average 7.7-14.3 on 8 cores). User pushed back
("lot cpu usage is idle, why is it still happening") — correctly so. Re-diagnosis
via `vm_stat` found the real mechanism was **RAM/swap thrashing**, not CPU
starvation: sustained 260-525MB/s swap-out, `python3.11`(Kronos, 11GB) and
`com.apple.Virtualization.VirtualMachine`(Docker, 7.4GB) both in uninterruptible
"stuck" (disk I/O wait) state, only ~60-194MB free RAM out of 16GB, swap 94-98%
full. Idle-CPU-with-ongoing-stalls is the signature of I/O wait, not scheduling
starvation — an easy misdiagnosis to make and worth remembering as a pattern.

**Mitigation applied:** lowered Docker Desktop's VM memory allocation
8GB→5GB via Settings→Resources (GUI, not the undocumented internal
`settings-store.json`, which only holds app-level keys, not the VM memory
limit — confirmed by direct inspection). This is a VM-level stop/start, NOT
`docker-compose down`+`up` — critical distinction, since MySQL/Postgres/etc.
have no named volumes (only a bind-mounted init-script dir), so a
down+up would have wiped 8+ days of session data; a VM restart preserves
existing containers. Verified all 5 containers came back with data intact (40
users, full multi-day market-table history).

**The restart itself broke three more things, all found and fixed live** (a
genuinely good adjacent-incident story): (a) DynamoDB is in-memory/unvolumed
— lost its tables on VM restart, silently killing `lifecycle()`'s market
creation for ~7min via uncaught `ResourceNotFoundException` (fixed by
re-running `setup/create-schema.mjs`, idempotent, didn't touch MySQL's real
user data); (b) the real matching-engine process
(`~/gb-trading-matching-engine-service`, port 7001) got stuck in an infinite
"waiting for 2603 active requests to finish" shutdown loop when the restart
cut its in-flight DB connections, silently blowing its log to 2.1GB and never
recovering — killed and restarted (unmodified command), log truncated; (c) the
app's own persistent quoter needed one restart after a Redis blip.

**New: liquidity watcher deployed on the live BitBull website.** The watcher
now publishes live state to Redis (`liquidity_watch_state` key, 30s TTL) each
tick — current empty-streaks + last 30 resolved gaps. New `/api/liquidity-watch`
route in `app/server.mjs`; new "📶 Liquidity Watch" tab in `app/public/index.html`
showing live status, active-gap table, and a scrolling resolved-gap table,
auto-refreshing every second while open — so this no longer needs log-tailing
to monitor.

## 2026-07-31: CRITICAL unpaginated-DynamoDB-Scan bug in app/server.mjs

Found during pre-demo verification. A test trade filled 5/5 and the hedger
picked up the exposure, but **the position did not appear in the portfolio**.

Root cause: `portfolio()`, `settle()` and `roundReset()` each issued a bare
`ddb.send(new ScanCommand(...))` on `bb_pending_bids`. DynamoDB caps every
Scan response at **1MB** + returns `LastEvaluatedKey`. The table had grown to
**3,963 rows — only 1,199 fit on page one**. Everything past page 1 was
invisible, silently, no error. Impact: (a) positions vanish from portfolio;
(b) **`settle()` credits winner wallets from that same scan, so a winning
position past page 1 would never be paid**; (c) roundReset only cleared page 1.

Fix: shared paginated `scanAll()` helper in `app/server.mjs` (mirrors the one
already in `drivers/inventory-mirror`), all 5 call sites migrated. Backup at
`data/backups/server.mjs.pre-scan-pagination-fix.*`. Verified: fresh trade
fills 8/8 and position appears immediately; a settled win reconciled exactly
(−258 points staked, +500 paid, net +242 = +$2.42).

**This is the SAME defect class already fixed in [[hedging-service]]'s QA
hardening (HIGH: unpaginated Scan → silent under-hedge).** It was fixed there
and missed in the app. Lesson worth keeping: when a bug class is found, sweep
the whole codebase for it rather than patching only the site where it showed
up. Remaining full-table scans are still O(table) per call — a per-market
Query on the `mkId` GSI is the real scale fix; pagination is only the
correctness floor.

## 2026-07-31: root cause of the RESIDUAL both-sides liquidity gaps

Earlier fixes (persistent worker, cancel-moved-late, parallelised cancel/repost)
only SHRANK the empty-book window. Root cause finally isolated by correlation:
**92.3% of watcher gap events start within the cancel window, median offset
+0.000s** — the gap IS the quoter's own cancel. Confirmed NOT resource-related:
Docker sat at 51% of its 4.8GB allocation and pageouts were ~200KB/s (vs
260-525MB/s during the real 2026-07-30 swap-thrash). **Raising Docker RAM would
not have helped** — worth remembering, it was the intuitive-but-wrong lever.

Structural issue: `quoteMarket()` does cancel-ALL-then-repost-ALL, which can
never have a zero window. 197/203 gap events were both-sides-simultaneous.

**Fix: materiality threshold** in `drivers/mmp-pricing/index.mjs` — skip the
whole cancel+repost when the change isn't economically meaningful. Measured
justification: median touch move is **0.10¢ against a ~3¢ spread**, 44% of
cycles leave touch prices byte-identical, 76% move depth <2%. Emptying the book
for a guaranteed ~600ms to fix a 0.1¢ error is a bad trade.
Env-tunable: `MMP_REQUOTE_MIN_MOVE` (0.3¢), `MMP_REQUOTE_MIN_DEPTH_PCT` (5%),
`MMP_REQUOTE_ALWAYS_BELOW_TAU` (60s).
Safety guards force a requote when staleness actually costs: near expiry
(gamma explodes), a side with nothing resting, or a risk/directional gate flip.

**IMPORTANT implementation gotcha:** an exact-equality skip was tried FIRST and
fired **zero** times — the LMSR `b` shrinks continuously with tau, so ladder
QUANTITIES drift ~1%/cycle even when prices are frozen (7565->7498->7434 sh
observed live, ~5.5%/cycle near expiry). Hence a threshold, not equality.
Also verified `bid_amount` is stored as **cents x100** (81.4¢ -> 8140) before
comparing — a units error would have skipped forever, silently.

**Measured result:** gap frequency **15.9/min -> 4.8/min (-70%)**, max duration
**5606ms -> 1203ms**, events >=3s **4 -> 0**. Caveat: "after" sample was only
3.4 min / 16 events — direction is clear, precision is not.
Backup: `data/backups/mmp-pricing-index.mjs.pre-skip-unchanged.*`.
Remaining ~4.8/min are genuinely-material requotes that still use
delete-then-insert; eliminating those needs make-before-break (post new, then
cancel old), which requires `cancelRestingRows` to accept a row/bid-id filter —
it currently cancels ALL unmatched rows for the user, so it would kill the
just-posted ladder too.

## 2026-07-31 (later): the REAL fix — make-before-break + faster loop

The materiality gate above was a mitigation, not a fix — user correctly pushed
back: "when 20 users are actively trading the price changes will be more than
the gate, the real issue is latency and quickness." Right. Under real flow the
gate is exceeded constantly and the gaps return.

**What production venues actually do** (researched): Kalshi exposes atomic
`amend_v2` / `decrease_v2` (modify in place, never cancel+create) plus batched
order ops, WebSocket, and FIX 4.4. Polymarket exposes batch order placement
(raised 5->15 orders/call explicitly so makers can move a whole ladder in one
round trip) and batch cancel; its WebSocket is ~100ms vs ~1s REST polling.
Common thread: **amend/replace atomically, batch the ladder, stay on a
persistent connection, and update on market events rather than a fixed timer.**

**Key unlock:** we cannot add an amend verb to GameBull's matching engine
(read-only), but we do not need to — `cancelRestingRows` is a direct MySQL
DELETE that we own outright, NOT a matcher call. So the order can simply be
reversed.

**Implemented — make-before-break** (`drivers/lib/pricing.mjs` +
`drivers/mmp-pricing/index.mjs`):
  1. `snapshotRestingRows()` (NEW) captures the currently-resting row_ids,
  2. the new ladder is posted (book transiently holds BOTH),
  3. `cancelRestingRows(..., preRows)` (NEW optional 6th arg) deletes EXACTLY
     the snapshotted rows.
The book is never empty; worst case it is briefly deeper than intended, which
is a strictly safer failure than empty. **The snapshot is essential** — a fresh
"cancel all my unmatched rows" at step 3 would also match the ladder just
posted and wipe it. Other callers (app/server.mjs x2) unaffected: `preRows`
defaults to null = original behaviour.

**Also: loop 2000ms -> 400ms, requote threshold 0.3¢ -> 0.1¢ (one tick).**
The 2s cadence existed ONLY because every cycle emptied the book, so quoting
faster meant more flashes. Once that coupling is gone, requote frequency is
free — the only question left is responsiveness. oracle-feed writes spot every
250ms, so 400ms tracks it closely.

**Measured, three configurations:**
| config | gaps/min | mean | max | >=3s |
|---|---|---|---|---|
| A original cancel-then-repost | 15.9 | 567ms | 5606ms | 4 |
| B materiality gate only | 6.5 | 448ms | 1203ms | 0 |
| C make-before-break + 400ms | **0.6** | 402ms | 402ms | 0 |

**96% reduction.** And the only surviving event is at tau=299.7s — market OPEN,
i.e. the ~400ms before the first quote lands on a brand-new market. That is
cold start, a different problem (fixable by seeding at creation if wanted), NOT
the cancel/repost hole, which is now structurally gone.
Verified no double-stacking: resting rows stayed 12+12 per side across samples.
Backups: `data/backups/{pricing.mjs,mmp-pricing-index.mjs}.pre-make-before-break.*`

## 2026-07-31: quoting latency — event-driven instead of polled

User reported quoting "didn't happen actively on time" during a volatile market.
Ledger confirmed the volatility: realized vol more than doubled across windows
(0.0000524 -> 0.0001245).

**The loop was NOT the problem** — measured cadence was healthy: median 401ms,
p90 507ms, p99 739ms, only 0.5% of cycles over 1s. The problem was **price
staleness**, two serial lags in front of every quote:
  1. `oracle-feed` throttles its Redis SET to `SPOT_WRITE_MS` (250ms), and
  2. the quoter then POLLED that key every 400ms.
Measured Redis spot age at read: **27ms .. 1081ms**. Quoting off a
quarter-second-old price during a fast move is exactly how a maker is picked off.

**Fix, in two parts (both needed):**
 1. `oracle-feed` now `PUBLISH`es on EVERY tick, unthrottled, to channel
    `spot:BTCUSDT`. The throttled SET stays for pollers (app, settlement,
    market-generator) that don't need tick latency. PUBLISH is fire-and-forget
    and free when unsubscribed.
 2. `mmp-pricing` SUBSCRIBEs on a DEDICATED ioredis connection (a subscribed
    client cannot run normal commands) and requotes immediately when spot moves
    >= `MMP_TRIGGER_MOVE_USD` (default $3), with `inFlight`/`pendingTrigger`
    guards so triggers never stack. The interval remains as a HEARTBEAT so
    tau-decay (b shrinks with tau), gate flips and new markets are still picked
    up when spot is flat.

**CRITICAL second half — easy to miss:** triggering fast is useless if the quote
then re-reads the stale key. `quoteMarket` was still doing
`redis.get(CRYPTO_SPOT_*)`. Now a module-level `liveSpot`/`liveSpotTs` cache is
updated on EVERY tick and used when fresher than the polled value
(`MMP_LIVE_SPOT_MAX_AGE`, 2000ms), falling back to the key when the tick stream
is stale/absent — so it can only improve freshness, never break quoting.
Verified live: quoter priced off $64054 while the polled key still read
$64056.01 at 414ms age.

Matches how real venues work: Kalshi and Polymarket both push market data over
WebSocket (Polymarket ~100ms vs ~1s REST) and expect makers to react to events,
not timers.

Measured: sub-300ms reactions 11% -> 17%, p10 297ms -> 215ms, min 28ms -> 2ms.
Median stays ~400ms because in CALM periods the heartbeat dominates (no $3 move
to trigger on) — which is correct behaviour, not a failure. Gains concentrate
exactly where they matter: fast markets.
Backups: `data/backups/{oracle-feed-index.mjs.pre-pubsub,mmp-pricing-index.mjs.pre-event-driven}.*`

## Documentation artifacts (2026-07-31)

- `docs/BitBull-System-Architecture.pdf` (+ `.html` source) — 26-page complete
  system record: topology, trade lifecycle, pricing math, gamma wall, hedging,
  negative results, WIP. Built via HTML + mermaid → headless Chrome
  `--print-to-pdf` (no mermaid CLI / weasyprint / pandoc on this machine).
  **Gotcha:** mermaid `sequenceDiagram` breaks on unquoted parentheses in
  `participant X as Label (foo)` — flowchart nodes are fine because labels are
  quoted. Always verify rendered output visually; a syntax error renders as a
  bomb icon, not a build failure.
- `drivers/lib/EMPIRICAL_VALIDATION.md` — reconstructed Kalshi validation
  methodology (the file `pricing.mjs` references but was missing from disk).
- `docs/gamma-hedging-plan.md` — cross-market + options-overlay plan.

**How to apply:** if asked about production-readiness lessons from this
internship, this incident (persistent-worker conversion → 2 new
self-introduced bugs → user-driven root-cause correction from CPU to RAM →
mitigating one system triggered 3 more failures, all diagnosed and fixed live)
is a strong, honest "here's what real operational work looks like" story —
better than a clean one, precisely because nothing about it was clean.

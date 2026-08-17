# gb-crypto-local — BitBull, the crypto vertical, running locally end to end

A working prediction-market exchange for **5-minute BTC binary options**
("Will BTC be ≥ $X at time T?"), driving GameBull's **real, unmodified** Predictor
services against a local Docker stack. **Nothing is pushed; no GameBull repo is
modified** — every integration is through their existing interfaces, exactly as an
external client would.

The house is the market maker, so the platform carries real directional inventory
risk. That single fact drives most of what is in here.

> **Full system record:** `docs/BitBull-System-Architecture.pdf` (~47pp) — architecture,
> pricing mathematics, the gamma wall, hedging, negative results, and the complete
> engineering history with root causes. Start there if you are new.

---

## What runs

```
  BitBull web app  (:5050)   Markets · Portfolio · Hedge Desk · Liquidity Watch
        │
  app/server.mjs             order entry · portfolio · settlement · P&L
        │  place bid
        ▼
  trading-api :8080  ──►  DynamoDB bb_pending_bids     [GameBull, unmodified]
        │                       ▲
        │ SQS                   │ matchedBidsCount
        ▼                       │
  sqs-bridge  ──►  matching-engine :7001  ──►  MySQL order books   [unmodified]
                                              Redis LMSR state
        │ at expiry
        ▼
  distribution-engine :3010  ──►  wallet-stub :3000  ──►  bb_users   [unmodified]

  inventory-mirror  ──►  Redis MMP_LMSR_QUANTITY_*  ──►  hedging-service :8790
                                                              └──►  Binance demo
```

The **only** substituted component on the order path is `sqs-bridge`, because
their service derives its request host from the queue URL (see the three seams
below). Order validation, matching, settlement and payout are all their code.

### Drivers

| Driver | Role |
|---|---|
| `mmp-pricing` | The house market maker. Persistent worker; event-driven requoting. |
| `market-generator` | Rolling ATM markets; tenor via `TENOR_MIN` (5m / 15m / 1h). |
| `oracle-feed` | Binance WS → Redis spot, **plus an unthrottled tick pub/sub channel**. |
| `sqs-bridge` | Drains SQS into the real matching engine. |
| `inventory-mirror` | House net inventory → the Redis keys the hedging sidecar reads. |
| `liquidity-watcher` | 400 ms diagnostic; also surfaces as a live app tab. |
| `wallet-stub` | The one component still stubbed. Accounting is genuine. |
| `secrets-stub` | AWS Secrets Manager stand-in; resolves a port/URL self-collision. |

### Shared libraries (`drivers/lib/`)

`pricing.mjs` (fair value) · `quoting.mjs` (Stoikov + gamma/inventory/flow widening) ·
`risk.mjs` (limits, sizing) · `matching.mjs` (book walking) · `fees.mjs` · `flow.mjs`

---

## Running it

```bash
docker compose up -d                 # redis · mysql8 · dynamodb-local · elasticmq · postgres
node setup/create-schema.mjs         # idempotent bootstrap
node app/server.mjs                  # :5050 — also spawns the persistent quoter

node drivers/oracle-feed/index.mjs           # spot feed (required)
node drivers/sqs-bridge/index.mjs            # order ingress
node drivers/inventory-mirror/index.mjs --watch
node drivers/liquidity-watcher/index.mjs     # optional diagnostics

cd ~/gb-crypto-hedging-service && npm start  # :8790, DRY_RUN by default
```

> **Do not use `docker compose down` casually.** MySQL, Postgres and DynamoDB have
> **no named volumes** — only a bind-mounted init-script directory. `down` + `up`
> destroys all users, markets and history. To change Docker resources use Docker
> Desktop's Settings → Resources, which is a VM-level restart and preserves
> containers. DynamoDB is additionally in-memory: it loses its tables on a VM
> restart, so re-run `setup/create-schema.mjs` afterwards (idempotent, does not
> touch MySQL data).

---

## The three integration seams

Solved entirely from outside their code:

1. **Auth** — `SKIP_MMP_AUTH=1` reduces the check to an API-key header; no IP
   allowlist, no JWT.
2. **SQS** — aws-sdk **v2 derives the request host from `params.QueueUrl`** and
   ignores the configured client endpoint, so their service kept calling real AWS
   and 403ing. A preload shim rewrites `QueueUrl` to localhost. Subtlety: v2
   attaches operations **lazily**, so prototype methods are undefined at preload
   time — each SQS **instance's** methods must be wrapped.
3. **Market shape** — their controller reads market records from **DynamoDB**, not
   MySQL, and destructures nested fields that crash if absent.

---

## Key documents

| Doc | What it covers |
|---|---|
| `docs/BitBull-System-Architecture.pdf` | **The full record.** Start here. |
| `docs/pricing-and-quoting.md` | Three price layers, marking conventions, quoting cadence, open pricing issues |
| `drivers/lib/EMPIRICAL_VALIDATION.md` | Why Black-Scholes was replaced, provenance, the implied-σ test |
| `docs/gamma-hedging-plan.md` | Cross-market hedging (NO-GO) and the options overlay |
| `contracts.md` | Exact data shapes their services expect |

---

## Things that will bite you

* **Fair value ≠ market price ≠ tradeable price.** Three distinct layers; never
  show `fairYes` as a price a user can transact at. See `docs/pricing-and-quoting.md`.
* **Wallet units are POINTS, not dollars** (100 points = $1). Passing a dollar
  figure to the wallet credits 100× too little.
* **The hedge sign mapping is `qYes = houseNo, qNo = houseYes`.** Getting it
  backwards does not fail loudly — it silently **doubles** risk.
* **DynamoDB `Scan` caps at 1MB.** An unpaginated scan silently returns only the
  first page. This caused positions to vanish from portfolios and would have left
  winners unpaid. Use `scanAll()`.
* **Requoting is make-before-break.** Post the new ladder, *then* delete the
  snapshotted old rows. A naive "cancel all my resting rows" after posting deletes
  the ladder you just posted.
* **The matching engine truncates floats** (`parseInt(bidAmount * 100)`). At a 1¢
  tick, 573 of 9,999 two-decimal values silently corrupt. 0.1¢ / 0.25¢ / 0.5¢ are
  clean; **0.01¢ is not** — hence the 0.1¢ tick.

---

## Current state

Working end to end: real user orders route through their trading-api → SQS →
matching engine → distribution engine, with live BTC pricing, house market making,
delta hedging, and settlement.

**Known open items** (all detailed in the PDF):

* **Fee revenue is structurally $0** — market-only mode means every fill is
  house-vs-user, so there is no user-to-user trade to charge on.
* **Hedge budget vs gamma:** inventory limit 12,500 contracts against a $10k hedge
  budget, when worst-case ATM notional near expiry is ~$16M.
* **Price impact is too weak to manage inventory** — a maxed-out position moves
  the mid only 0.35¢.
* **Mid-range pricing miscalibration**, whose root cause is that √τ does not
  collapse the probability curve across τ. Needs multi-day data, not a code fix.
* **Selling is not implemented** — positions are hold-to-settlement. When it ships,
  portfolio marking must move from mid to **bid**.

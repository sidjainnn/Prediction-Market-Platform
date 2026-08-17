# BitBull — working notes for a new session

A prediction-market exchange for 5-minute BTC binaries. The house quotes both
sides, so it carries directional inventory risk — that fact drives everything
here. Full context in [`README.md`](README.md); this file is the operational
short form.

## Starting it

```bash
./start.sh                # everything in Docker, app on http://localhost:5050
./start.sh --ngrok        # ... and expose it publicly
```

Or expose an already-running stack separately:

```bash
ngrok http 5050
```

`ngrok` isn't bundled — `brew install ngrok` and authenticate once. The old
machine used a reserved subdomain (`ngrok http --url=<subdomain> 5050`); a free
random URL works the same.

Stop with `docker compose -f docker-compose.yml -f docker-compose.app.yml down`
(add `-v` to wipe data).

## Architecture in one paragraph

The app (`app/server.mjs`, :5050) takes orders and routes them through three
services on the order path: trading-api (:8080), matching-engine (:7001),
distribution-engine (:7002). Those were originally production Predictor
services; **`standalone/services.mjs` now implements the endpoints the app
actually calls**, so nothing external is required. Drivers supply the rest:
`oracle-feed` (Binance spot → Redis), `market-generator` (rolling ATM markets),
`mmp-pricing` (the house quoter), `inventory-mirror` (feeds the hedging sidecar).
Datastores are Redis, MySQL, DynamoDB-local and elasticmq via compose.

## Things that will bite you

- **Drivers exit(0) without `LOOP=1`.** `market-generator` and `mmp-pricing` each
  run one pass and exit; with a restart policy that becomes a new process every
  few seconds. Both are set correctly in `docker-compose.app.yml` — keep it that
  way when adding drivers.
- **Never hardcode `localhost` in shared libs.** In a container it resolves to the
  container itself. `setup/local.mjs` reads hosts from the environment and
  defaults to localhost; import from there. A literal endpoint in
  `drivers/lib/pricing.mjs` once broke every quote with `ECONNREFUSED`.
- **`mmp-pricing` logs only `e.name` on placeBid failure** — a bare `Error` with
  no address or message. If quoting silently stops, widen that catch first
  (`index.mjs`, the `placeBid failed` line).
- **Order-book tables are per-market** (`bb_available_bids_{yes|no}_{marketId}`),
  so the marketId is interpolated into SQL. It's charset-restricted and
  backtick-quoted in `standalone/services.mjs`; keep both.
- **Markets roll every 5 minutes.** When checking whether quoting works, confirm
  you're looking at the market `mmp-pricing` is currently quoting — a freshly
  rolled market has an empty book for a few seconds.

## Known gaps

- A **real user fill through to wallet payout** has never been tested end to end.
  Settlement has only run with the house account, which is excluded from credits.
- `standalone/services.mjs` implements place/match/rest/settle only — no cancels,
  sells, buyback, ladder markets or partial-cancel accounting.
- `STANDALONE_ASYNC_MATCH=1` (defer matching to `setImmediate`) is untested;
  inline matching is the verified path.

## Related

[Hedging](https://github.com/sidjainnn/Hedging) (perp sidecar that reads this
stack's inventory) · [Kronos-Price-Discovery](https://github.com/sidjainnn/Kronos-Price-Discovery)
(can a learned model beat the pricing curve?) ·
[AMM_Hedging](https://github.com/sidjainnn/AMM_Hedging) (the research simulator)

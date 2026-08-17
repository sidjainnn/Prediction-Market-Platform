> Engineering notes carried over from working sessions. Findings, root
> causes and decisions recorded as they were made — kept because the
> reasoning behind a fix is usually harder to recover than the fix.

Two GameBull (Ballebaazi/sportsbull) production repos are cloned at
`~/gb-market-match-maker-engine-service` ("bb-m3", the CLOB matching engine —
Node/Express/MySQL/Postgres/predictorRedis) and `~/gb-trading-api-service` (the
user-facing REST API; code lives on branches, `main` is only a README). The
substantive branch on both is **`feat/lmsr`**.

Their LMSR (`src/utils/lmsrHelper.js` on feat/lmsr) is **mathematically identical
to our engine** — proven: `calcLMSRPrice.pYes` == our `sigmoid((qY−qN)/b)` to
1e-16. Their `volatility` param **IS our `b`** (default `VOLATILITY_CONSTANT_B=500`).
The **house is the market maker (MMP)**: for LMSR markets (`engineType=2`) it keeps
inventory in predictorRedis (`MMP_LMSR_QUANTITY_YES/NO_{marketId}`), quotes off it,
adds a spread (`addSpreadtoLMSRPrice`), and steers price to an external **SkillPoll**
feed via `getTargetBidsForLMSR` (oracle-anchoring — opposite of our golden rule #1).
`NON_SPORTS_FEED_ID=3` → crypto/finance markets exist alongside cricket. Neither
repo has any perp/Binance hedging — that's our gap to fill. Their market metadata
has NO strike/expiry/underlying (risk managed via `maxLossForYes/No` caps), so
perp-hedging needs a small additive `MMP_MARKET_META_{marketId}` publish for feed-3
markets. `floorToPriceInterval` uses `Math.ceil` (rounds quotes UP a tick → a
rounding bias worth flagging).

Integration design = a **read-only hedging sidecar** (this repo's `server/` runner):
reads their Redis inventory → aggregate settlement-value δ → risk-tier/vol gate →
Binance DEMO perp → A/B ledger. Non-invasive (no engine hot-path change), demo-only.
See [[amm-hedging-project]]. Full plan: `~/Desktop/amm-hedging/docs/gamebull-integration.md`.
Runnable proof: `src/sim/gamebull-parity.ts` (Phase 0 parity + Phase 1 break-even
audit — at b=500 the LMSR subsidy is b·ln2≈$346/market, ~4.5× the b=110 case, so
markets need ~17k shares @2¢ vig to break even).

All 54 repos mapped (SportsBaazi/GameBull microservices). Product lines: **Predictor**
(LMSR target: market-match-maker=bb-m3 + trading-distribution-engine[TS settlement,
already has `isHedge` on Bid] + trading-api + write lambdas), **ATH** (TS/TypeORM
market line), **Ladder** (exchange variant), **Sports** (event/feed/exchange-dist), +
platform commons (wallet/payments/user/backoffice/infra). `gb-predictor-api-service`,
`gb-mmp-engine`, `gb-trading-matching-engine-service` are **empty stubs** (likely an
in-progress TS MMP rewrite) → sidecar should attach via **Redis + events**, not a
specific service. Their `isHedge` = MMP bid inside their own book (internal offset);
OURS = external perp hedge of the residual net inventory → complementary, not overlapping.

**How to apply:** perp hedge only transfers to markets with a tradeable underlying
(crypto/feed-3), not sports; for sports our contribution is the break-even/vig +
inventory-risk analysis. Only ask of the platform team = publish
`MMP_MARKET_META_{marketId}` for feed-3 in QA.

**STALE PHASE LIST, superseded:** the "Phases 0-4" originally sketched here
(parity → break-even audit → shadow ingest → demo hedge → agent load) refers
to the read-only sidecar design BEFORE it got extracted into its own repo.
See [[hedging-service]] for what actually shipped — all 6 phases done there,
under different phase numbering. Don't cite this file's phase list as current.

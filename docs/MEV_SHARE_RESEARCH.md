# MEV-Share / Backrun Pivot — Research & Recommendation

> Companion to `PROFITABILITY_ANALYSIS.md`. Researched June 2026 from primary
> Flashbots sources + market data. Confidence levels and the one notable source
> conflict are flagged inline. The MEV space moves monthly — re-verify before
> committing capital.

## TL;DR

- **Public-mempool sandwiching (the strategy this bot was built for) is a dead
  end for a new solo searcher.** In 2025 the *entire ecosystem's* net sandwich
  profit after gas averaged **~$260k/month**, with **~70% captured by one entity
  (`jaredfromsubway.eth`)** at **~5% margins**. The pie for everyone else is
  ~$75–80k/month split among established pros.
- **Backrunning via MEV-Share / MEV Blocker is the better vehicle** — non-toxic
  (users get refunded), **~zero capital** (flash-loan funded), durable, and where
  orderflow is consolidating. **But it is also winner-take-most**: inclusion is a
  sealed-bid auction where you bid away ~80–90% of profit, and the moat is
  latency/co-location/venue-coverage, not capital. Realistic outcome for a solo
  bot: occasional niche edge, not a reliable income.
- **Recommendation:** stop deepening the sandwich path; keep it as a learning
  artifact in `DRY_RUN`. Run a cheap, listen-only **backrun edge validator** for
  a few weeks to measure whether any edge actually reaches us before deploying.

## 1. MEV-Share mechanics — *high confidence*

- Live, run by Flashbots; the orderflow engine behind Flashbots Protect.
- **Backruns only — sandwiching is structurally impossible** ("MEV-Share Nodes
  only accept backruns"; a searcher cannot be ordered *before* the user).
- **Default refund = 90% of captured MEV to the user**; searchers compete for the
  rest.
- **BuilderNet** (Nov 2024; Flashbots + Beaverbuild + Nethermind) is a separate
  *downstream* block-builder layer — it did **not** replace MEV-Share.
- Sources: https://docs.flashbots.net/flashbots-mev-share/introduction ·
  https://buildernet.org/blog/introducing-buildernet

## 2. Searcher API / on-ramp — *high confidence*

- Official SDK **`@flashbots/mev-share-client` (TS)**, v0.7.13 — stable but **last
  released May 2024** (low release velocity; not deprecated). Rust path
  (`paradigmxyz/mev-share-rs` + Artemis) is more actively maintained.
- **Hint stream:** SSE at `https://mev-share.flashbots.net`; event shape
  `{ hash, logs?, txs:[{ to?, functionSelector?, callData? }] }` — fields present
  per the user's chosen privacy level.
- **Submit:** `mev_sendBundle` with
  `body:[{ hash: userTx }, { tx: signedBackrun, canRevert: false }]`.
- **Templates:** official `example.backrun` and the `simple-blind-arbitrage`
  flash-loan tutorial (open-source contract + bot).
- Sources: https://github.com/flashbots/mev-share/blob/main/specs/events/v0.1.md ·
  https://github.com/flashbots/mev-share/blob/main/specs/bundles/v0.1.md ·
  https://docs.flashbots.net/flashbots-mev-share/searchers/tutorials/flash-loan-arbitrage/simple-blind-arbitrage

## 3. Orderflow-auction landscape — *high confidence*

- **MEV Blocker** (CoW DAO): also **90/10** to users; **2M+ users, ~4,000 ETH
  rebated**; generally the **highest rebates** and largest searcher backrun venue.
- Four main protect-RPC / OFA venues: **MEV Blocker, Flashbots Protect, Blink,
  Merkle**. Orderflow is clearly consolidating into these private channels.
- Sources: https://cow.fi/learn/what-does-an-mev-blocker-do ·
  https://cow.fi/learn/mev-blockers-explained-how-they-protect-users

## 4. Profitability reality — *medium-high confidence*

- **Sandwiching:** ecosystem-wide net profit ~$260k/month (2025); gross extraction
  fell ~$10M → ~$2.5M/month (late-2024 → Oct-2025); ~5% margins; ~70% to Jared.
- **Backrun arbitrage:** sealed-bid inclusion auction — winning means bidding
  ~80–90% of profit as the tip; "obvious arbs are instantly captured by
  sophisticated bots." Moat = latency, co-location, venue coverage, builder
  relationships. **Capital ≈ near-zero** (flash-loan funded).
- **Source conflict (flagged):** EigenPhi data shows sharp *value* decline; another
  analysis argues attack *count* stayed high (60–90k/month) with "no meaningful
  decline." Reconciliation: **volume steady, value & margins compressed** — a
  saturated, professionalized market.
- Sources: https://www.tradingview.com/news/cointelegraph:fa12ba092094b:0-exclusive-data-from-eigenphi-reveals-that-sandwich-attacks-on-ethereum-have-waned/ ·
  https://writings.flashbots.net/blind-arbitrage-fhe ·
  https://academy.extropy.io/pages/articles/mev-crosschain-analysis-2025.html ·
  https://www.bitget.com/news/detail/12560604213767

## 5. Recommendation & minimum-viable path

**Do:**
1. Stop investing in the sandwich path (shelve the V3 sizer/firing). Keep the
   finished bot in `DRY_RUN` as a learning artifact.
2. Run a **listen-only backrun edge validator** (this repo's `mevshare:validate`):
   subscribe to the MEV-Share SSE stream, and for hinted swaps on pools we cover,
   estimate the cross-venue arbitrage with our existing pool math. Measure edge
   for weeks before deploying any capital (which can be ~zero via flash loans).
3. Only if edge appears: fork `simple-blind-arbitrage` as the executor and submit
   via `mev_sendBundle`; broaden venue coverage (more V2 pools, V3, later Curve)
   since hit-rate scales with coverage; also point at MEV Blocker (highest volume).

**Reuse from this codebase:** pool readers, V2 math, decoding, bundle plumbing,
`profit.ts`, backtest harness. **Shelve:** optimal-frontrun + sandwich executor.

**Be clear-eyed:** backrunning is the *right* direction, but it's competitive and
latency-bound. For a solo dev the honest expected value is *learning + optionality
+ a small chance of niche edge*, not a business. The validator is how you find out
cheaply.

## Caveats / least-verified

- Per-searcher backrun profitability is inferred from competition dynamics, not a
  clean dataset — treat §4's backrun half as directional.
- The TS SDK's low release velocity (May 2024) is worth confirming vs the Rust
  path before building the live executor.

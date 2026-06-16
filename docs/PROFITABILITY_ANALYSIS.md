# sando-mev — Codebase Analysis & Profitability Roadmap

> A deep review of the current bot and a prioritized plan to turn it from a
> mempool *monitor* into a system that can actually capture (and keep) MEV.

---

## 1. Executive summary

**What the repo is today:** a ~150-line mempool monitor. It opens a WebSocket,
subscribes to pending tx hashes, re-fetches each full transaction, filters for
the UniswapV2 router, and `console.log`s the decoded calldata. That's it.

**What the README claims it has:** profit-calculation algos, gas-bribe
calculation, and bundle firing. **None of those exist in the code.** The only
"math" present is `calculateNextBlockBaseFee`. There is no profit logic, no
simulation, no bundle submission, and no sandwich executor contract.

**Bottom line on profitability:** in its current form the bot cannot earn
anything — it only watches. More importantly, even once the missing pieces are
filled in, the chosen strategy (naive public-mempool UniswapV2 sandwiching) is
the most saturated, lowest-edge corner of MEV in 2026. The single highest-
leverage decision is **strategic, not code**: decide whether to compete in
public-mempool sandwiching (hard, crowded, near-zero edge) or pivot toward
private orderflow / backrunning (MEV-Share, builder-integrated bundles), where
real edge still exists.

The rest of this document is split into **(A) make the existing path actually
work and not lose money**, and **(B) where the real profit is**.

---

## 2. Architecture as it stands

```
src/index.ts            → boot banner + start mempool listener
src/core/mempool.ts     → WS "pending" → getTransaction → filter router → decode → console.log
src/config/config.ts    → addresses, env vars
src/utils/utils.ts      → calculateNextBlockBaseFee (EIP-1559 next base fee)
src/logging/logging.ts  → chalk console wrappers
src/abi/abi.ts          → UniswapV2 Pair + Router ABIs
```

Pipeline that a profitable sandwicher needs, and where this repo sits:

| Stage | Needed | Present? |
|------|--------|----------|
| 1. Ingest mempool | low-latency full-tx stream | ⚠️ slow (hash→refetch) |
| 2. Decode & classify swap | identify victim swaps only | ⚠️ decodes, doesn't classify |
| 3. Fetch pool state | reserves, token metadata | ❌ |
| 4. Check feasibility | victim `amountOutMin`/slippage | ❌ |
| 5. Compute optimal frontrun | x·y=k optimal-input math | ❌ |
| 6. Simulate bundle | `eth_callBundle` / local fork | ❌ |
| 7. Price gas + bribe | net-profit-aware bidding | ❌ (random 0–9 wei only) |
| 8. Build + sign bundle | front + victim + back, atomic | ❌ |
| 9. Submit to builders | Flashbots/MEV-Boost relays | ❌ |
| 10. Track inclusion & PnL | metrics, accounting | ❌ |

So the repo implements roughly stage 1–2 of a 10-stage pipeline, and the two it
has are the slowest possible versions.

---

## 3. Correctness & efficiency bugs (fix these first — they silently cost money)

1. **EIP-1559 txs are mis-handled.** `processTransaction` reads `gasPrice`, but
   type-2 (1559) transactions — the majority of swaps — have `gasPrice` of
   `null`/derived and carry `maxFeePerGas` / `maxPriorityFeePerGas`. Any gas
   logic built on `gasPrice` will be wrong for most victims. Capture both and
   branch on `tx.type`.

2. **No method filtering.** `parseTransaction` is run on *every* router call,
   then both `addLiquidity`, `removeLiquidity`, `swapExactETHForTokens`, etc.
   are treated alike. Only the `swap*` methods are sandwichable, and each has a
   different path/amount layout. Build a per-selector handler map and ignore the
   rest early.

3. **Relying on `value` is wrong for token→token / token→ETH swaps**, where
   `value == 0`. The traded amount lives in the decoded `args`
   (`amountIn`, `amountInMax`, `amountOutMin`, `path`, `deadline`), not in the
   tx `value` field.

4. **`getTransaction(txHash)` per pending hash is a latency killer.** The
   `"pending"` subscription returns only hashes, forcing a second RPC round-trip
   per tx (often 20–100 ms). In MEV the winner is decided by milliseconds; this
   design loses by construction. Use a full-pending-tx stream (see §5).

5. **No dedup / replacement handling.** The same hash is delivered repeatedly,
   and victims send replacement txs (same nonce, higher fee). Without a seen-set
   and nonce tracking you'll re-process and potentially target stale txs.

6. **No WebSocket reconnection.** `providers.WebSocketProvider` dies silently on
   disconnect; the bot keeps "running" while seeing nothing. Every dropped
   connection = missed blocks = lost revenue. Add heartbeat + auto-reconnect
   (or use `ethers` `WebSocketProvider` keepalive wrappers).

7. **`calculateNextBlockBaseFee` "+ random 0–9 wei" is a misconception.** The
   comment says it's "so it becomes a different hash each time." Base fee is
   fixed by protocol from the parent block — you don't choose it, and nudging it
   by a few wei changes nothing meaningful. Implement the exact EIP-1559 formula
   (cap the per-block change at ±12.5%) and drop the random term. Distinct
   bundle hashes come from your own nonces/payload, not from the base fee.

8. **Dead/odd imports.** `import { METHODS } from "http";` in `mempool.ts` is
   unused. `noImplicitAny` is disabled and several handlers take `any`
   (`currentBlock: any`, `...args: any`), defeating the `strict` flag set right
   above it. Tighten types around tx/args — type errors here are money errors.

9. **Config correctness.** `config.ts` checks `process.env.WSS_URL` but
   `.env.example` defines `RPC_URL_WSS` (name mismatch → fatal exit or silent
   `undefined`). `SEARCH_WALLET` is hardcoded to a specific address while the
   private key comes from env — those two can desync, signing from a key that
   doesn't match the advertised wallet.

---

## 4. The missing core: sandwich economics

A sandwich is only profitable when **gross price-impact capture > (front gas +
back gas + bribe + DEX fees)**. The bot currently computes none of these terms.
The minimum viable profit engine needs:

- **Pool reserves**: read `getReserves()` on the target pair (and `token0`
  ordering) to know the curve you're trading against. Cache and update on `Sync`
  events rather than re-reading every time.
- **Feasibility gate from the victim's own calldata**: the victim's
  `amountOutMin` encodes their slippage tolerance. If their max acceptable
  slippage is below what your frontrun would move the price, the victim tx
  reverts and your sandwich fails — skip it. This single check eliminates most
  non-viable targets cheaply.
- **Optimal frontrun size.** On a constant-product pool (`x·y=k`, 0.30% fee),
  given current reserves and the victim's input + `amountOutMin`, there is a
  closed-form optimal frontrun amount that maximizes profit subject to not
  pushing the victim past their slippage limit. Brute-forcing or guessing a
  fixed size leaves money on the table and risks reverts. Implement the
  closed-form (or a bounded numeric solve) and unit-test it against known cases.
- **Net-profit accounting**: subtract realistic gas (two swaps via your
  executor contract, ~100–150k gas total) priced at the *next* block's base fee
  + the bribe you intend to pay. Only proceed if the remainder clears a
  configurable minimum margin (e.g. > 0.01 ETH and > X% ROI).

Until these exist, "profit calculation algos" in the README is aspirational.

---

## 5. Latency & infrastructure (this is where sandwich wars are won)

Public-mempool sandwiching is a latency race. Concrete upgrades, roughly in
order of impact:

1. **Stream full pending txs, not hashes.** Options: an Erigon/geth node you
   control with a full-tx pending feed; provider features like Alchemy's
   `alchemy_pendingTransactions` (full bodies, filterable by `to` = router);
   or specialized feeds (bloXroute, Chainbound Fiber, Eden) that deliver txs
   pre-propagation. This removes the per-tx `getTransaction` round-trip entirely.
2. **Co-locate.** Run the bot in the same region as your node and the relays you
   submit to. Tens of milliseconds decide inclusion.
3. **Filter at ingest.** Subscribe filtered by `to ∈ routers` so you don't
   decode the whole mempool in JS.
4. **An on-chain executor contract.** Sending two separate router swaps from an
   EOA is gas-heavy and racy. A minimal sandwich executor (Solidity, ideally
   Yul/Huff-optimized) that does buy+sell atomically and is callable only by you
   cuts gas dramatically — and gas is the dominant cost that decides whether a
   sandwich is profitable at all. The repo references a `SANDWICH_CONTRACT` env
   var but **no contract is in the repo.** This is the biggest single missing
   artifact.

---

## 6. Bundle submission, simulation & bribing

- **You must use private bundles.** If you broadcast your frontrun/backrun to
  the public mempool, you'll be back-run/uncle-bandit'd and frequently revert
  (paying gas for nothing). Submit `front, victim, back` as one atomic Flashbots
  / MEV-Boost bundle via the relays (`@flashbots/ethers-provider-bundle`),
  targeting one or more upcoming blocks.
- **Simulate before firing.** Use `eth_callBundle` (Flashbots) or a local fork
  (anvil/hardhat) to verify the bundle nets positive *after* gas+bribe, on the
  exact parent state, before risking it. Never fire un-simulated.
- **Bid as net-profit-aware bribe**, not a fixed tip. The builder ranks bundles
  by total value to the validator (priority fee + coinbase transfer per gas).
  Compute the max bribe that still leaves your target margin and bid that;
  too-low loses the auction, too-high gives away the profit.
- **Multi-block / multi-builder submission.** Submit to several builders and
  multiple target blocks to raise inclusion probability.

---

## 7. Risk controls that prevent losses (often the difference between net + and net −)

- **Honeypot / fee-on-transfer / blacklist detection.** Many tokens can't be
  sold back, charge transfer fees, or blacklist arbitrary addresses. Sandwiching
  these = guaranteed loss. Simulate the *sell* leg, and treat
  `...SupportingFeeOnTransferTokens` methods and unknown tokens as high-risk by
  default. Maintain an allow/deny token list.
- **Per-trade and daily loss limits / kill switch.**
- **Revert protection** via bundle atomicity (already covered) + pre-submit sim.
- **Nonce & inventory management** for the executor/EOA so concurrent bundles
  don't collide.
- **Secrets handling.** The private key sits in plaintext `.env`; at minimum
  document key isolation, use a dedicated hot wallet with limited funds, and
  keep the executor contract's privileged functions owner-gated.

---

## 8. The strategic reality (read this before writing more code)

Naive public-mempool UniswapV2 sandwiching in 2026 is a **commoditized, near-
zero-edge** game: dominated by integrated searcher-builders with private
orderflow, custom nodes, and Huff executors. Competing head-on as a TS bot
re-fetching tx hashes is a losing trade. Higher-edge directions:

- **MEV-Share / private orderflow backrunning.** Backrun user txs shared through
  MEV-Share or exclusive orderflow. Less toxic, less crowded, and a real edge is
  still available to fast, well-simulated searchers.
- **Long-tail / new-launch pairs.** Thin-liquidity and freshly launched pools
  see less competition than blue-chip pairs — but raise the honeypot risk, so
  §7 becomes mandatory.
- **Multi-DEX coverage and backrun-arbitrage.** Extend beyond the single V2
  router to UniswapV3, Sushi, and others; much volume (and much cleaner,
  atomic-arb profit) lives there. Backrunning large swaps with cross-pool arb is
  often more durable than sandwiching.
- **Become / integrate with a builder** for inclusion guarantees instead of
  bidding into someone else's auction.

A blunt note: sandwiching extracts value directly from ordinary users' slippage.
Backrun-arbitrage and MEV-Share strategies capture MEV with far less user harm
and are where the ecosystem (and the durable profit) is heading. Worth weighing.

---

## 9. Prioritized roadmap

**P0 — stop the bleeding / make it real (1–2 weeks)**
1. Fix EIP-1559 gas handling, method classification, and the `WSS_URL`/
   `RPC_URL_WSS` config mismatch (§3).
2. Add WS reconnect + dedup/replacement handling (§3).
3. Replace hash→refetch with a full-pending-tx stream (§5.1).
4. Add pool-reserve fetching + victim-`amountOutMin` feasibility gate (§4).

**P1 — minimum profitable loop (2–4 weeks)**
5. Implement optimal-frontrun math with unit tests (§4).
6. Build/deploy a gas-optimized sandwich executor contract (§5.4).
7. Add Flashbots bundle build + `eth_callBundle` simulation + net-profit-aware
   bribe (§6).
8. Add honeypot/fee-on-transfer guards + loss-limit kill switch (§7).

**P2 — edge & scale (ongoing)**
9. Multi-DEX (V3/Sushi) and backrun-arbitrage support (§8).
10. PnL/metrics + a historical backtest harness to estimate edge *before*
    risking capital.
11. Evaluate the MEV-Share / private-orderflow pivot (§8).

**Engineering hygiene throughout:** turn on full strict typing (re-enable
`noImplicitAny`/`strictNullChecks`), add a real test runner (the `test` script
currently just errors), and add CI that compiles + runs the optimal-input and
base-fee math tests.

---

## 10. TL;DR

- The bot is a **monitor**, not a sandwicher — 2 of ~10 pipeline stages, in
  their slowest form.
- Quick wins: EIP-1559 gas, method filtering, config name fix, WS reconnect,
  full-tx stream.
- The real money requires the missing core: **reserves → feasibility →
  optimal-input math → simulation → atomic bundle → profit-aware bribe →
  executor contract**, plus honeypot guards.
- The biggest decision is **strategic**: public V2 sandwiching is saturated;
  MEV-Share/backrun-arbitrage offers more durable (and less predatory) edge.

# sando-mev 🔍

![CI](https://github.com/henrykash/sando-mev/actions/workflows/ci.yml/badge.svg)

- This is the beginning of my journey experimenting with MEV sandwicher bots using  flashbot bundlers 🧱 
## Overview

The goal of this bot is to build an optimized searcher, brick 🧱 by 🧱 .

 `PHASE ONE` is just building a `MONITORING SYSTEM`. This bot contains:

- reading data from the mempool 🚧🚧
- decode transaction data 🚧🚧
- simple logging system
- profit calculation algos
- gas bribe calculation
- bundle firing
- misc
  - doing math in Typescript
  - calculating next base fee

# running locally 🏃
### Prerequisites
- **Node.js 20** + npm.
- An Ethereum **RPC + WebSocket** endpoint. Two env vars are required or the bot
  exits on start:
  - `RPC_URL` — HTTPS JSON-RPC (pool reads, simulation).
  - `WSS_URL` — WebSocket. The sandwich monitor subscribes to **pending
    transactions**, so this must be a node/provider that streams them (your own
    geth/erigon, or e.g. Alchemy's `newPendingTransactions`). The backtester and
    MEV-Share validator do **not** need a pending-tx feed.

### Install & configure
```bash
git clone https://github.com/henrykash/sando-mev.git
cd sando-mev
npm ci                 # or: npm install
cp .env.example .env   # then edit .env
```
Minimum `.env` to start (monitoring only):
```
RPC_URL=https://<your-rpc>
WSS_URL=wss://<your-ws-endpoint>
DRY_RUN=true           # keep true until you have a deployed executor
```
Everything else is optional: `PRIVATE_KEY` + `SANDWICH_CONTRACT` (live firing
only), `FLASHBOTS_AUTH_KEY`, the `TELEGRAM_*` vars, and tuning knobs
(`MAX_FRONTRUN_ETH`, `MIN_MARGIN_ETH`, …). See `.env.example` for the full list.

### Run modes
```bash
# sanity checks (no network)
npm run typecheck
npm test
npm run compile:contracts

npm run backtest             # estimate edge on the sample dataset (no network)
npm run mevshare:validate    # listen-only backrun validator (needs RPC_URL)
npm start                    # sandwich monitor (needs pending-tx WSS_URL; DRY_RUN)
```

### Telegram notifications (optional)
```bash
# put TELEGRAM_BOT_TOKEN in .env, then message your bot once
npm run telegram:chatid      # prints chat id -> set TELEGRAM_CHAT_ID in .env
npm run telegram:test        # sends a test message
```

### Going live (only when you mean it)
Live submission stays off until **all** of: `DRY_RUN=false`, `PRIVATE_KEY` set
(a funded hot wallet), and `SANDWICH_CONTRACT` set to a deployed executor
(`contracts/Sandwich.sol`). Until then the bot monitors, simulates, and alerts
but never submits. Validate edge in monitoring mode first —
see `docs/PROFITABILITY_ANALYSIS.md` and `docs/MEV_SHARE_RESEARCH.md`.

# backtesting 📊
Estimate edge before risking capital by replaying historical victim swaps
through the same optimal-input + net-profit logic the live bot uses:

```
npm run backtest -- path/to/dataset.json   # defaults to the bundled sample fixture
```

The dataset is JSON (wei-string fields); see `src/backtest/fixtures/sample.json`
for the schema. `src/backtest/loader.ts` can build a dataset from real mainnet
flow when pointed at an archive RPC.

# mev-share backrun validator 🛰️
A **listen-only** probe for the MEV-Share pivot (see `docs/MEV_SHARE_RESEARCH.md`).
It subscribes to the MEV-Share hint stream and, for hinted swaps that leak pool
reserves, estimates the cross-venue backrun arbitrage with the existing pool
math — to measure whether real backrun edge exists before building the live
path. **It never submits anything.**

```
npm run mevshare:validate
```

# tech-stack
- `Typerscript`
- `Ethersjs`

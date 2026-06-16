# sando-mev 🔍
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

# backtesting 📊
Estimate edge before risking capital by replaying historical victim swaps
through the same optimal-input + net-profit logic the live bot uses:

```
npm run backtest -- path/to/dataset.json   # defaults to the bundled sample fixture
```

The dataset is JSON (wei-string fields); see `src/backtest/fixtures/sample.json`
for the schema. `src/backtest/loader.ts` can build a dataset from real mainnet
flow when pointed at an archive RPC.

# tech-stack
- `Typerscript`
- `Ethersjs`

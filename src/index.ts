import { mempoolWrapper } from "./core/mempool";

const main = async () => {
  // Listen to the mempool on local node
  await mempoolWrapper.stremMempoolPendingTxns();
};

main()

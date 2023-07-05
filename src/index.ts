import { config } from "./config";
import { mempoolWrapper } from "./core/mempool";
import { Logging } from "./logging/logging";

const main = async () => {
  Logging.logInfo(
    "============================================================================"
  );

  Logging.logInfo("github: https://github.com/henrykash");
  Logging.logInfo("twitter: https://twitter.com/HenryKa79175189");
  Logging.logInfo(
    "============================================================================\n"
  );
  Logging.logInfo(`Searcher Wallet: ${config.SEARCH_WALLET}`);
  Logging.logInfo(`Node URL: ${config.WSS_URL}\n`);
  Logging.logInfo(
    "============================================================================\n"
  );


  // Listen to the mempool  pending transactions
  await mempoolWrapper.mempool();

};

main()

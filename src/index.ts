import { ethers } from "ethers";
import { HelpersWrapper } from "./utils";
import { Logging } from "./logging/logging";

export const wssProvider = new ethers.providers.WebSocketProvider(
  "wss://mainnet.infura.io/ws/v3/b3e60763ede44fb0a1a195cd5e2e37ab"
);

const main = async () => {
  // Listen to the mempool on local node
  const stream = wssProvider.on("pending", (txHash) =>
    sandwichUniswapV2RouterTx(txHash).catch((e) => {
 //Logging.logFatal(`txhash=${txHash} error ${JSON.stringify(e)}`);
    })
  );
  const sandwichUniswapV2RouterTx = async (txHash: any) => {
    try {
      const strLogPrefix = `txhash=${txHash}`;

      // Bot not broken right
      // Logging.logTrace(strLogPrefix, "received");

      // Get tx data
      const [tx, txRecp] = await Promise.all([
        wssProvider.getTransaction(txHash),
        wssProvider.getTransactionReceipt(txHash),
      ]);

      console.log(`Transaction Tx${tx}`);
      console.log(`Transaction Recarp ${txRecp.transactionHash}`);

      // Logging.logInfo("Listening to mempool...\n");

      console.log("we are here");
    } catch (error) {
      console.log("Error", error);
    }
  };
};

main()

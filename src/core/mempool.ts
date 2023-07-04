import { providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";

class mempool {

   public _provider: providers.WebSocketProvider;
    constructor() {
     this._provider = new providers.WebSocketProvider("wss://mainnet.infura.io/ws/v3/b3e60763ede44fb0a1a195cd5e2e37ab");

    }

    public stremMempoolPendingTxns = async () => {
        const stream = this._provider.on("pending", async (txHash) => 

        await  this._provider.getTransaction(txHash).then((tx) => {
            Logging.logInfo(txHash)

        })
      );
    }
}

export const mempoolWrapper = new mempool();
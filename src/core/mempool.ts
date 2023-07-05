import { providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";

class mempool {

   public _wsprovider: providers.WebSocketProvider;
    constructor() {
     this._wsprovider = new providers.WebSocketProvider(config.WSS_URL!);

    }

    public stremMempoolPendingTxns = async () => {
        try {
            this._wsprovider.on("pending", (txHash) => {
            let receipt = this._wsprovider.getTransaction(txHash)
                Logging.logInfo("pending txHash", {receipt});
            });
        } catch (error) {
            Logging.logError(error);
        }
    }
}

export const mempoolWrapper = new mempool();
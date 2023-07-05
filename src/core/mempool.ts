import { ethers, providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { UniswapV2RouterABI } from "../abi";

class mempool {
  private _wsprovider: providers.WebSocketProvider;
  private _uniswap: ethers.utils.Interface;
  constructor() {
    this._wsprovider = new providers.WebSocketProvider(config.WSS_URL!);
    this._uniswap = new ethers.utils.Interface(UniswapV2RouterABI)
  }

  public mempool = async () => {
    try {
      this._wsprovider.on("pending", async (txHash) => {
        let txReceipt = await this._wsprovider.getTransaction(txHash);

        txReceipt?.hash && this.processTransaction(txReceipt);
      });
    } catch (error) {
      Logging.logError(error);
    }
  };

  private processTransaction = async (
    txReceipt: providers.TransactionResponse
  ) => {
    let {
      from: targetFrom,
      to: router,
      value: targetAmountInWei,
      gasPrice: targetGasPriceInWei,
      gasLimit,
      hash: targetHash,
    } = txReceipt;

    //check if transaction is going through our list of supported routers
    if (
      router &&
      config.SUPPORTED_ROUTERS.some(
        (router) => router.toLowerCase() === txReceipt?.to?.toLowerCase()
      )
    ) {
      try {
        console.log({
          targetFrom,
          router,
          targetAmountInWei,
          targetGasPriceInWei,
          gasLimit,
          targetHash
          
        })

        const tx = this._uniswap.parseTransaction({
          data: txReceipt.data,
        }); 


        //some logic
        
      } catch (error) {
        Logging.logError(error);
      }
    }
  };
}

export const mempoolWrapper = new mempool();

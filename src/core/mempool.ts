import { ethers, providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { UniswapV2RouterABI } from "../abi";
import { METHODS } from "http";

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
    
         // parse transaction data: https://docs.ethers.io/v5/api/utils/abi/interface/#Interface--parsing -->[helps in decoding the transaction data]
        const tx = this._uniswap.parseTransaction({
          data: txReceipt.data,
        }); 
    
        //distructure the tx data to get the method name and args
        const {name: methodName,  args } = tx;

        console.log({methodName, args})

        //some logic

      } catch (error) {
        Logging.logError(error);
      }
    }
  };
}

export const mempoolWrapper = new mempool();

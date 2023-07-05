import { Logging } from "../logging/logging";

require("dotenv").config();

//check if all the required env variables are set
if (!process.env.RPC_URL || !process.env.WSS_URL ) {
  Logging.logFatal("RPC_URL or WSS_URL not set");
  process.exit(1);
}

export const config = {
  
  UNIV2_ROUTER: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", //uniswapV2 router contract
  SANDWICH: process.env.SANDWICH_CONTRACT!, // sandwhicher contract

  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", //weth
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" ,//usdc

  RPC_URL: process.env.RPC_URL!, // json rpc provider
  WSS_URL: process.env.WSS_URL!, //websocket provider

  SEARCH_WALLET: "0x23055E68DAfC3670b20651BD0B2E0Bcd46977b22",// Used to send transactions, needs ether
  PRIVATE_KEY: process.env.PRIVATE_KEY //signer private key used to sign transaction
};

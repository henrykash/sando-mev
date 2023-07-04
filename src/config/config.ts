import { Logging } from "../logging/logging";
import {ethers,  } from "ethers";

let hasEnv = true;

const ENV_VARS = [
  "RPC_URL",
  "RPC_URL_WSS",
  "PRIVATE_KEY",
  "FLASHBOTS_AUTH_KEY",
  "SANDWICH_CONTRACT",
];

for (let i = 0; i < ENV_VARS.length; i++) {
  if (!process.env[ENV_VARS[i]]) {
    Logging.logError(`Missing env var ${ENV_VARS[i]}`);
    hasEnv = false;
  }
}

if (!hasEnv) {
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

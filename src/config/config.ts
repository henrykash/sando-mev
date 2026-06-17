import { utils, BigNumber } from "ethers";
import { Logging } from "../logging/logging";

require("dotenv").config();

const ethersParseEther = (v: string) => utils.parseEther(v);

const parseAddressList = (v?: string): string[] =>
  (v ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);

// Accept either WSS_URL or the older RPC_URL_WSS name used in .env.example.
const WSS_URL = process.env.WSS_URL ?? process.env.RPC_URL_WSS;

//check if all the required env variables are set
if (!process.env.RPC_URL || !WSS_URL) {
  Logging.logFatal("RPC_URL or WSS_URL (a.k.a RPC_URL_WSS) not set");
  process.exit(1);
}

export const config = {

  SUPPORTED_ROUTERS: [
    "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", //uniswapV2 router contract
  ],
  
  UNIV2_ROUTER: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", //uniswapV2 router contract
  UNIV2_FACTORY: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", //uniswapV2 factory contract

  // UniswapV3: two router generations (different calldata shapes) + factory/quoter.
  V3_ROUTERS: [
    { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564", version: "v1" as const }, // SwapRouter
    { router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", version: "v2" as const }, // SwapRouter02
  ],
  UNIV3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNIV3_QUOTER: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // QuoterV2
  SANDWICH: process.env.SANDWICH_CONTRACT!, // sandwhicher contract

  // Capital cap for a single frontrun, in wei. The optimal-input search never
  // bets more than this regardless of how profitable a victim looks.
  MAX_FRONTRUN_WEI: ethersParseEther(process.env.MAX_FRONTRUN_ETH ?? "1"),

  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", //weth
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" ,//usdc

  RPC_URL: process.env.RPC_URL!, // json rpc provider
  WSS_URL: WSS_URL!, //websocket provider

  SEARCH_WALLET: "0x23055E68DAfC3670b20651BD0B2E0Bcd46977b22",// Used to send transactions, needs ether
  PRIVATE_KEY: process.env.PRIVATE_KEY, //signer private key used to sign transaction

  // --- Execution layer -------------------------------------------------------
  CHAIN_ID: Number(process.env.CHAIN_ID ?? "1"),
  FLASHBOTS_AUTH_KEY: process.env.FLASHBOTS_AUTH_KEY, // reputation key for the relay
  FLASHBOTS_RELAY: process.env.FLASHBOTS_RELAY ?? "https://relay.flashbots.net",

  // Safety: when true (default) we simulate and log but never submit a bundle.
  DRY_RUN: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",

  // Minimum net WETH we insist on keeping after gas + bribe.
  MIN_MARGIN_WEI: ethersParseEther(process.env.MIN_MARGIN_ETH ?? "0.02"),

  // Gas units per leg (executor swaps directly on the pair; tune from sims).
  FRONTRUN_GAS: BigNumber.from(process.env.FRONTRUN_GAS ?? "120000"),
  BACKRUN_GAS: BigNumber.from(process.env.BACKRUN_GAS ?? "120000"),

  // If a simulated leg's output falls more than this many bps below the
  // constant-product prediction, treat the token as fee-on-transfer/honeypot.
  FEE_TOLERANCE_BPS: Number(process.env.FEE_TOLERANCE_BPS ?? "100"),

  // Optional token allow/deny lists (comma-separated addresses).
  TOKEN_ALLOWLIST: parseAddressList(process.env.TOKEN_ALLOWLIST),
  TOKEN_DENYLIST: parseAddressList(process.env.TOKEN_DENYLIST),

  // --- MEV-Share backrun edge validator (listen-only) ------------------------
  MEVSHARE_STREAM_URL:
    process.env.MEVSHARE_STREAM_URL ?? "https://mev-share.flashbots.net",
  // Cap (wei) on the arb cycle size used by the optimal-input search.
  ARB_MAX_IN_WEI: ethersParseEther(process.env.ARB_MAX_IN_ETH ?? "50"),
  // Only log backrun candidates whose gross WETH profit clears this floor.
  ARB_MIN_PROFIT_WEI: ethersParseEther(process.env.ARB_MIN_PROFIT_ETH ?? "0.005"),
  // V2-compatible venues compared for cross-pool arbitrage (name -> factory).
  V2_VENUES: [
    { name: "uniswapv2", factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f" },
    { name: "sushiswap", factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac" },
  ],

  // --- Telegram notifications ------------------------------------------------
  // Set both in .env. NEVER commit real values (the .env is gitignored).
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  // Minutes between "still alive" heartbeat messages (0 disables).
  HEARTBEAT_MINUTES: Number(process.env.HEARTBEAT_MINUTES ?? "30"),
};

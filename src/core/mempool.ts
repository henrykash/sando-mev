import { ethers, providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { UniswapV2RouterABI } from "../abi";
import {
  HelpersWrapper,
  FEE_ON_TRANSFER_METHODS,
  SANDWICHABLE_METHODS,
} from "../utils";
import { reserveManager } from "./reserves";
import { computeOptimalSandwich } from "./poolMath";
import { ethers as ethersLib } from "ethers";

/** Reconnect backoff bounds for the websocket provider (ms). */
const RECONNECT_MIN_DELAY = 1_000;
const RECONNECT_MAX_DELAY = 30_000;
/** Bound the seen-hash set so memory doesn't grow unbounded. */
const MAX_SEEN_HASHES = 50_000;

class mempool {
  private _wsprovider!: providers.WebSocketProvider;
  private _uniswap: ethers.utils.Interface;
  private _routers: Set<string>;
  private _seen: Set<string> = new Set();
  private _reconnectDelay = RECONNECT_MIN_DELAY;
  private _stopped = false;

  constructor() {
    this._uniswap = new ethers.utils.Interface(UniswapV2RouterABI);
    // Lower-case the router set once so per-tx comparisons are cheap.
    this._routers = new Set(
      config.SUPPORTED_ROUTERS.map((r) => r.toLowerCase())
    );
  }

  public mempool = async () => {
    this._stopped = false;
    this.connect();
  };

  /** (Re)create the provider, wire up the pending feed, and handle drops. */
  private connect = () => {
    this._wsprovider = new providers.WebSocketProvider(config.WSS_URL!);

    this._wsprovider.on("pending", (txHash: string) => {
      // The "pending" feed delivers the same hash repeatedly and re-broadcasts
      // replacement txs; skip anything we've already queued.
      if (!txHash || this._seen.has(txHash)) return;
      this.rememberHash(txHash);

      this._wsprovider
        .getTransaction(txHash)
        .then((tx) => (tx?.hash ? this.processTransaction(tx) : undefined))
        .catch((error) => Logging.logError(error));
    });

    this.attachReconnect();
  };

  /**
   * ethers v5 WebSocketProvider does not auto-reconnect. Listen on the
   * underlying socket and rebuild the provider with capped exponential backoff
   * so a dropped connection doesn't silently kill the bot (= missed blocks).
   */
  private attachReconnect = () => {
    const ws: any = (this._wsprovider as any)._websocket;
    if (!ws) return;

    const reconnect = (reason: string) => {
      if (this._stopped) return;
      Logging.logWarn(
        `websocket ${reason}; reconnecting in ${this._reconnectDelay}ms`
      );
      // Tear down the old provider before scheduling a new one.
      this._wsprovider.removeAllListeners();
      this._wsprovider.destroy().catch(() => {});

      setTimeout(() => {
        this._reconnectDelay = Math.min(
          this._reconnectDelay * 2,
          RECONNECT_MAX_DELAY
        );
        this.connect();
      }, this._reconnectDelay);
    };

    ws.on("open", () => {
      // Healthy connection: reset backoff.
      this._reconnectDelay = RECONNECT_MIN_DELAY;
      Logging.logSuccess("websocket connected");
    });
    ws.on("close", () => reconnect("closed"));
    ws.on("error", () => reconnect("errored"));
  };

  /** Track seen hashes with a simple bound to cap memory. */
  private rememberHash = (txHash: string) => {
    if (this._seen.size >= MAX_SEEN_HASHES) {
      this._seen.clear();
    }
    this._seen.add(txHash);
  };

  private processTransaction = async (
    txReceipt: providers.TransactionResponse
  ) => {
    const router = txReceipt.to;

    // Only consider transactions going through a supported router.
    if (!router || !this._routers.has(router.toLowerCase())) return;

    let parsed: ethers.utils.TransactionDescription;
    try {
      parsed = this._uniswap.parseTransaction({ data: txReceipt.data });
    } catch {
      // Calldata that doesn't match the router ABI (or non-swap selectors that
      // fail to decode) — nothing to do.
      return;
    }

    const methodName = parsed.name;

    // Skip non-swap router calls (addLiquidity, removeLiquidity, etc.).
    if (!SANDWICHABLE_METHODS.has(methodName)) {
      if (FEE_ON_TRANSFER_METHODS.has(methodName)) {
        Logging.logTrace(
          `skipping fee-on-transfer swap ${methodName} ${txReceipt.hash}`
        );
      }
      return;
    }

    const swap = HelpersWrapper.extractSwapDetails(parsed, txReceipt.value);
    if (!swap) return;

    const gas = HelpersWrapper.parseGas(txReceipt);

    // Structured target — downstream profit logic (reserves, feasibility,
    // optimal input, simulation) plugs in here.
    Logging.logInfo("target swap detected");
    console.log({
      hash: txReceipt.hash,
      from: txReceipt.from,
      router,
      method: swap.method,
      kind: swap.kind,
      amountIn: swap.amountIn?.toString() ?? null,
      amountInMax: swap.amountInMax?.toString() ?? null,
      amountOut: swap.amountOut?.toString() ?? null,
      amountOutMin: swap.amountOutMin?.toString() ?? null,
      path: swap.path,
      to: swap.to,
      deadline: swap.deadline.toString(),
      gas: {
        type: gas.type,
        gasPrice: gas.gasPrice?.toString() ?? null,
        maxFeePerGas: gas.maxFeePerGas?.toString() ?? null,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas?.toString() ?? null,
      },
    });

    await this.evaluateSandwich(swap, txReceipt.hash);
  };

  /**
   * Feasibility gate + optimal-input calculation for a detected swap.
   *
   * For this first cut we only sandwich the simple, common case: an exact-input
   * buy of a token directly with WETH (2-hop path WETH -> TOKEN). Token sells,
   * exact-output swaps, and multi-hop paths are recognised but skipped — they
   * need their own models and are tracked for a later pass.
   */
  private evaluateSandwich = async (
    swap: ReturnType<typeof HelpersWrapper.extractSwapDetails>,
    hash: string
  ) => {
    if (!swap) return;

    const weth = config.WETH.toLowerCase();
    const isDirectWethBuy =
      swap.kind === "exactIn" &&
      swap.amountIn != null &&
      swap.path.length === 2 &&
      swap.path[0].toLowerCase() === weth;

    if (!isDirectWethBuy) {
      Logging.logTrace(`skip ${hash}: not a direct WETH->token exact-in buy`);
      return;
    }

    const tokenOut = swap.path[1];
    const reserves = await reserveManager.getReserves(config.WETH, tokenOut);
    if (!reserves) {
      Logging.logTrace(`skip ${hash}: no WETH/${tokenOut} pool`);
      return;
    }

    const quote = computeOptimalSandwich({
      victimIn: swap.amountIn!,
      victimMinOut: swap.amountOutMin ?? ethersLib.BigNumber.from(0),
      reserveIn: reserves.reserveIn, // WETH reserve
      reserveOut: reserves.reserveOut, // token reserve
      maxFrontrun: config.MAX_FRONTRUN_WEI,
    });

    if (!quote) {
      Logging.logTrace(`skip ${hash}: no profitable frontrun`);
      return;
    }

    // Gross profit only — gas + bribe accounting and simulation come next (P1
    // executor/bundle work). This is the input to that net-profit decision.
    Logging.logSuccess(`candidate sandwich for ${hash}`);
    console.log({
      pair: reserves.pair,
      token: tokenOut,
      frontrunIn: ethersLib.utils.formatEther(quote.frontrunIn),
      tokensBought: quote.tokensBought.toString(),
      victimOut: quote.victimOut.toString(),
      backrunOut: ethersLib.utils.formatEther(quote.backrunOut),
      grossProfitWeth: ethersLib.utils.formatEther(quote.grossProfit),
    });
  };
}

export const mempoolWrapper = new mempool();

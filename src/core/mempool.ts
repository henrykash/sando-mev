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
import { evaluateProfit } from "./profit";
import { checkTokenLists } from "./safety";
import { BundleExecutor, SandwichPlan } from "./bundle";
import { decodeV3Swap, V3RouterVersion } from "./v3/detect";
import { v3PoolReader } from "./v3/pool";
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
  private _v3Routers: Map<string, V3RouterVersion>;
  private _seen: Set<string> = new Set();
  private _reconnectDelay = RECONNECT_MIN_DELAY;
  private _stopped = false;
  private _executor?: BundleExecutor;

  constructor() {
    this._uniswap = new ethers.utils.Interface(UniswapV2RouterABI);
    // Lower-case the router set once so per-tx comparisons are cheap.
    this._routers = new Set(
      config.SUPPORTED_ROUTERS.map((r) => r.toLowerCase())
    );
    this._v3Routers = new Map(
      config.V3_ROUTERS.map((r) => [r.router.toLowerCase(), r.version])
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
    if (!router) return;
    const to = router.toLowerCase();

    // UniswapV3 routers take a separate detection path.
    const v3Version = this._v3Routers.get(to);
    if (v3Version) {
      this.processV3Transaction(txReceipt, v3Version);
      return;
    }

    // Only consider transactions going through a supported V2 router.
    if (!this._routers.has(to)) return;

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

    await this.evaluateSandwich(swap, txReceipt);
  };

  /**
   * Full decision pipeline for a detected swap: feasibility gate -> optimal
   * input -> token safety -> net-profit/bribe accounting -> simulate (and, when
   * DRY_RUN is off, fire) the bundle.
   *
   * For now we only sandwich the simple, common case: an exact-input buy of a
   * token directly with WETH (2-hop path WETH -> TOKEN). Token sells,
   * exact-output swaps, and multi-hop paths are recognised but skipped.
   */
  private evaluateSandwich = async (
    swap: ReturnType<typeof HelpersWrapper.extractSwapDetails>,
    txReceipt: providers.TransactionResponse
  ) => {
    if (!swap) return;
    const hash = txReceipt.hash;

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

    // Token safety: deny/allow lists (dynamic fee-on-transfer detection happens
    // against the bundle simulation downstream).
    const listCheck = checkTokenLists(tokenOut);
    if (!listCheck.ok) {
      Logging.logTrace(`skip ${hash}: ${listCheck.reason}`);
      return;
    }

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

    // Net-profit + bribe: subtract both legs' gas at the projected base fee and
    // bid the surplus above our margin to the validator.
    const block = await this._wsprovider.getBlock("latest");
    const nextBaseFee = HelpersWrapper.calculateNextBlockBaseFee(block);
    const decision = evaluateProfit({
      grossProfit: quote.grossProfit,
      nextBaseFee,
      frontrunGas: config.FRONTRUN_GAS,
      backrunGas: config.BACKRUN_GAS,
      minMargin: config.MIN_MARGIN_WEI,
    });

    if (!decision.viable) {
      Logging.logTrace(
        `skip ${hash}: net unprofitable (gross ${ethersLib.utils.formatEther(
          quote.grossProfit
        )} - gas ${ethersLib.utils.formatEther(decision.gasCost)} < margin)`
      );
      return;
    }

    Logging.logSuccess(`profitable sandwich for ${hash}`);
    console.log({
      pair: reserves.pair,
      token: tokenOut,
      frontrunIn: ethersLib.utils.formatEther(quote.frontrunIn),
      tokensBought: quote.tokensBought.toString(),
      victimOut: quote.victimOut.toString(),
      backrunOut: ethersLib.utils.formatEther(quote.backrunOut),
      grossProfitWeth: ethersLib.utils.formatEther(quote.grossProfit),
      gasCostWeth: ethersLib.utils.formatEther(decision.gasCost),
      bribeWeth: ethersLib.utils.formatEther(decision.bribe),
      netProfitWeth: ethersLib.utils.formatEther(decision.netProfit),
    });

    // Build, simulate, and (unless DRY_RUN) fire the bundle. Requires a funded
    // signer and a deployed executor; without them we stay in monitor mode.
    if (!config.PRIVATE_KEY || !config.SANDWICH) {
      Logging.logTrace(
        `not firing ${hash}: PRIVATE_KEY/SANDWICH not configured (monitor mode)`
      );
      return;
    }

    try {
      const executor = this.getExecutor();
      const tolBps = config.FEE_TOLERANCE_BPS;
      const plan: SandwichPlan = {
        quote,
        pair: reserves.pair,
        token: tokenOut,
        wethIsToken0: reserves.token0 === weth,
        frontMinOut: quote.tokensBought.mul(10_000 - tolBps).div(10_000),
        backMinOut: quote.backrunOut.mul(10_000 - tolBps).div(10_000),
        bribe: decision.bribe,
        gasPerLeg: { frontrun: config.FRONTRUN_GAS, backrun: config.BACKRUN_GAS },
        nextBaseFee,
      };
      const victimRaw = BundleExecutor.reconstructVictimRaw(txReceipt);
      await executor.fire(plan, victimRaw);
    } catch (error) {
      Logging.logError(error);
    }
  };

  /** Lazily construct the bundle executor (needs signer + deployed contract). */
  private getExecutor = (): BundleExecutor => {
    if (!this._executor) this._executor = new BundleExecutor();
    return this._executor;
  };

  /**
   * UniswapV3 detection path. Decodes the victim swap and reads the target
   * pool's state. Sizing + firing for V3 require stateful simulation (tick math
   * or eth_callBundle) and land in a follow-up — for now we surface the target
   * and the pool state a sizer will consume.
   */
  private processV3Transaction = async (
    txReceipt: providers.TransactionResponse,
    version: V3RouterVersion
  ) => {
    const swap = decodeV3Swap(txReceipt.data, version);
    if (!swap) return;

    const weth = config.WETH.toLowerCase();
    // First cut mirrors the V2 path: only WETH-funded buys.
    if (swap.tokenIn !== weth) {
      Logging.logTrace(`skip v3 ${txReceipt.hash}: input is not WETH`);
      return;
    }

    const listCheck = checkTokenLists(swap.tokenOut);
    if (!listCheck.ok) {
      Logging.logTrace(`skip v3 ${txReceipt.hash}: ${listCheck.reason}`);
      return;
    }

    const pool = await v3PoolReader.getState(
      swap.tokenIn,
      swap.tokenOut,
      swap.fee
    );
    if (!pool) {
      Logging.logTrace(
        `skip v3 ${txReceipt.hash}: no pool ${swap.tokenOut}/${swap.fee}`
      );
      return;
    }

    Logging.logInfo("v3 target swap detected");
    console.log({
      hash: txReceipt.hash,
      from: txReceipt.from,
      method: swap.method,
      multiHop: swap.multiHop,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      fee: swap.fee,
      amountIn: swap.amountIn.toString(),
      amountOutMinimum: swap.amountOutMinimum.toString(),
      pool: pool.pool,
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      liquidity: pool.liquidity.toString(),
      tick: pool.tick,
    });
    // NOTE: optimal-input sizing + bundle firing for V3 are a follow-up.
  };
}

export const mempoolWrapper = new mempool();

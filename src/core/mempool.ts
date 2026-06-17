import { ethers, providers, BigNumber } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { UniswapV2RouterABI } from "../abi";
import {
  HelpersWrapper,
  FEE_ON_TRANSFER_METHODS,
  SANDWICHABLE_METHODS,
} from "../utils";
import { reserveManager } from "./reserves";
import { computeOptimalSandwich, getAmountOut } from "./poolMath";
import { evaluateProfit } from "./profit";
import { checkTokenLists } from "./safety";
import { BundleExecutor, SandwichPlan } from "./bundle";
import { decodeV3Swap, V3RouterVersion } from "./v3/detect";
import { v3PoolReader } from "./v3/pool";
import { telegram } from "../notify/telegram";
import {
  formatSandwichAlert,
  formatStartup,
  formatConnection,
  formatHeartbeat,
} from "../notify/format";
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

  // Status/heartbeat tracking for Telegram visibility.
  private _startedAt = 0;
  private _wasConnected = false;
  private _heartbeatTimer?: ReturnType<typeof setInterval>;
  private _v2Targets = 0;
  private _v3Targets = 0;
  private _profitable = 0;

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
    this._startedAt = Date.now();
    telegram.notify(formatStartup(config.DRY_RUN));
    this.startHeartbeat();
    this.connect();
  };

  /** Periodic "still alive" Telegram summary so a quiet bot looks healthy. */
  private startHeartbeat = () => {
    const minutes = config.HEARTBEAT_MINUTES;
    if (minutes <= 0 || this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      telegram.notify(
        formatHeartbeat({
          uptimeMinutes: Math.round((Date.now() - this._startedAt) / 60_000),
          v2Targets: this._v2Targets,
          v3Targets: this._v3Targets,
          profitable: this._profitable,
          dryRun: config.DRY_RUN,
        })
      );
    }, minutes * 60_000);
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
      // Notify once per "down" episode (guarded so a flapping socket doesn't spam).
      if (this._wasConnected) {
        this._wasConnected = false;
        telegram.notify(formatConnection(false));
      }
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
      // Notify once per "up" transition (not on every reconnect attempt).
      if (!this._wasConnected) {
        this._wasConnected = true;
        telegram.notify(formatConnection(true));
      }
    });
    // Surface the real reason so endpoint/auth/unsupported-subscription issues
    // are diagnosable (e.g. "closed (code 1006)", "errored: Unexpected server
    // response: 401"). A 4xx/426/1006 right after connect usually means the
    // WSS url/key is wrong or the provider doesn't support pending-tx streaming.
    ws.on("close", (code: number, reason: Buffer | string) => {
      const why = reason?.toString().trim();
      reconnect(`closed (code ${code}${why ? `: ${why}` : ""})`);
    });
    ws.on("error", (err: Error) =>
      reconnect(`errored: ${err?.message ?? err}`)
    );
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
    this._v2Targets++;

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
   * Full decision pipeline for a detected swap: token safety -> optimal input
   * -> net-profit/bribe accounting -> simulate (and, when DRY_RUN is off, fire).
   *
   * Generalised to ANY direct 2-hop exact-input swap (any tokenIn -> tokenOut):
   * WETH->token buys, token->WETH sells, and token->token. The optimal-input math
   * is token-agnostic, so gross profit is computed in tokenIn units and then
   * valued in WETH (via the tokenIn/WETH pool) so it can be netted against gas.
   *
   * Firing is limited to WETH-funded frontruns (the on-chain executor holds
   * WETH); profitable non-WETH-input opportunities are surfaced + alerted but not
   * fired, since the frontrun would need tokenIn inventory.
   */
  private evaluateSandwich = async (
    swap: ReturnType<typeof HelpersWrapper.extractSwapDetails>,
    txReceipt: providers.TransactionResponse
  ) => {
    if (!swap) return;
    const hash = txReceipt.hash;
    const weth = config.WETH.toLowerCase();

    if (swap.kind !== "exactIn" || swap.amountIn == null || swap.path.length !== 2) {
      Logging.logTrace(`skip ${hash}: not a direct exact-in 2-hop swap`);
      return;
    }
    const tokenIn = swap.path[0].toLowerCase();
    const tokenOut = swap.path[1].toLowerCase();

    // Token safety on the token we'd acquire and resell.
    const listCheck = checkTokenLists(tokenOut);
    if (!listCheck.ok) {
      Logging.logTrace(`skip ${hash}: ${listCheck.reason}`);
      return;
    }

    const reserves = await reserveManager.getReserves(tokenIn, tokenOut);
    if (!reserves) {
      Logging.logTrace(`skip ${hash}: no ${tokenIn}/${tokenOut} pool`);
      return;
    }

    // Capital cap and the gas-netting valuation both need a WETH reference.
    // For WETH input it's the identity; otherwise we go through the tokenIn/WETH
    // pool to (a) size the cap in tokenIn units and (b) value profit in WETH.
    let maxFrontrun: BigNumber;
    let valueInWeth: (amt: BigNumber) => BigNumber;
    if (tokenIn === weth) {
      maxFrontrun = config.MAX_FRONTRUN_WEI;
      valueInWeth = (amt) => amt;
    } else {
      const wethPool = await reserveManager.getReserves(weth, tokenIn);
      if (!wethPool) {
        Logging.logTrace(`skip ${hash}: no WETH route to value ${tokenIn}`);
        return;
      }
      // wethPool.reserveIn = WETH reserve, reserveOut = tokenIn reserve.
      maxFrontrun = getAmountOut(
        config.MAX_FRONTRUN_WEI,
        wethPool.reserveIn,
        wethPool.reserveOut
      );
      valueInWeth = (amt) =>
        getAmountOut(amt, wethPool.reserveOut, wethPool.reserveIn);
    }
    if (maxFrontrun.lte(0)) {
      Logging.logTrace(`skip ${hash}: zero frontrun cap`);
      return;
    }

    const quote = computeOptimalSandwich({
      victimIn: swap.amountIn!,
      victimMinOut: swap.amountOutMin ?? ethersLib.BigNumber.from(0),
      reserveIn: reserves.reserveIn, // tokenIn reserve
      reserveOut: reserves.reserveOut, // tokenOut reserve
      maxFrontrun,
    });

    if (!quote) {
      Logging.logTrace(`skip ${hash}: no profitable frontrun`);
      return;
    }

    // Value the (tokenIn-denominated) gross profit in WETH, then net out gas.
    const grossWeth = valueInWeth(quote.grossProfit);
    const block = await this._wsprovider.getBlock("latest");
    const nextBaseFee = HelpersWrapper.calculateNextBlockBaseFee(block);
    const decision = evaluateProfit({
      grossProfit: grossWeth,
      nextBaseFee,
      frontrunGas: config.FRONTRUN_GAS,
      backrunGas: config.BACKRUN_GAS,
      minMargin: config.MIN_MARGIN_WEI,
    });

    if (!decision.viable) {
      Logging.logTrace(
        `skip ${hash}: net unprofitable (gross ${ethersLib.utils.formatEther(
          grossWeth
        )} WETH - gas ${ethersLib.utils.formatEther(decision.gasCost)} < margin)`
      );
      return;
    }

    this._profitable++;
    Logging.logSuccess(`profitable sandwich for ${hash}`);
    console.log({
      pair: reserves.pair,
      tokenIn,
      token: tokenOut,
      frontrunIn: quote.frontrunIn.toString(), // tokenIn base units
      grossProfitTokenIn: quote.grossProfit.toString(),
      grossProfitWeth: ethersLib.utils.formatEther(grossWeth),
      gasCostWeth: ethersLib.utils.formatEther(decision.gasCost),
      bribeWeth: ethersLib.utils.formatEther(decision.bribe),
      netProfitWeth: ethersLib.utils.formatEther(decision.netProfit),
    });

    // Notify before we execute, so opportunities are visible even in DRY_RUN.
    await telegram.notify(
      formatSandwichAlert({
        hash,
        tokenIn,
        token: tokenOut,
        pair: reserves.pair,
        quote,
        grossProfitWeth: grossWeth,
        decision,
        dryRun: config.DRY_RUN,
      })
    );

    // Firing is limited to WETH-funded frontruns (the executor holds WETH).
    if (tokenIn !== weth) {
      Logging.logTrace(
        `alert-only ${hash}: non-WETH input ${tokenIn} (firing needs inventory)`
      );
      return;
    }
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

    // Detection covers all pairs (no WETH filter). Sizing/firing for V3 still
    // need stateful simulation, so this path only surfaces the target + pool.
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

    this._v3Targets++;
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

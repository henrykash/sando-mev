import { BigNumber, ethers, providers, Wallet } from "ethers";
import {
  FlashbotsBundleProvider,
  FlashbotsBundleResolution,
} from "@flashbots/ethers-provider-bundle";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { SandwichQuote } from "./poolMath";

/** Minimal ABI for the deployed Sandwich executor (see contracts/Sandwich.sol). */
const SANDWICH_ABI = [
  "function swap(address pair, address tokenIn, uint256 amountIn, uint256 amountOut, uint256 minOut, bool zeroForOne)",
];

export interface SandwichPlan {
  quote: SandwichQuote;
  pair: string;
  /** The token being bought/sold (the non-WETH side of the pair). */
  token: string;
  /** WETH is token0 in the pair (decides swap direction flags). */
  wethIsToken0: boolean;
  /** Min-out guards for each leg (slippage protection on-chain). */
  frontMinOut: BigNumber;
  backMinOut: BigNumber;
  /** Coinbase bribe to pay the validator (from profit accounting). */
  bribe: BigNumber;
  gasPerLeg: { frontrun: BigNumber; backrun: BigNumber };
  /** Projected next-block base fee. */
  nextBaseFee: BigNumber;
}

/**
 * Builds, simulates, and (unless DRY_RUN) submits the front/victim/back bundle
 * to the Flashbots relay. The frontrun and backrun call the on-chain executor
 * directly on the pair; the victim's signed tx is replayed verbatim in between.
 */
export class BundleExecutor {
  private _provider: providers.JsonRpcProvider;
  private _wallet: Wallet;
  private _executor: ethers.Contract;
  private _flashbots?: FlashbotsBundleProvider;

  constructor() {
    this._provider = new providers.JsonRpcProvider(config.RPC_URL);
    if (!config.PRIVATE_KEY) {
      throw new Error("PRIVATE_KEY required for the execution layer");
    }
    this._wallet = new Wallet(config.PRIVATE_KEY, this._provider);
    this._executor = new ethers.Contract(
      config.SANDWICH,
      SANDWICH_ABI,
      this._wallet
    );
  }

  private async flashbots(): Promise<FlashbotsBundleProvider> {
    if (this._flashbots) return this._flashbots;
    // A separate key signs the relay reputation header (not transactions).
    const authSigner = config.FLASHBOTS_AUTH_KEY
      ? new Wallet(config.FLASHBOTS_AUTH_KEY)
      : Wallet.createRandom();
    this._flashbots = await FlashbotsBundleProvider.create(
      this._provider,
      authSigner,
      config.FLASHBOTS_RELAY,
      config.CHAIN_ID === 1 ? "mainnet" : config.CHAIN_ID
    );
    return this._flashbots;
  }

  /** Reconstruct the victim's raw signed tx so it can be replayed in the bundle. */
  static reconstructVictimRaw(tx: providers.TransactionResponse): string {
    const baseTx: ethers.utils.UnsignedTransaction = {
      to: tx.to ?? undefined,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      data: tx.data,
      value: tx.value,
      chainId: tx.chainId,
      type: tx.type ?? undefined,
    };
    if (tx.type === 2) {
      baseTx.maxFeePerGas = tx.maxFeePerGas!;
      baseTx.maxPriorityFeePerGas = tx.maxPriorityFeePerGas!;
      baseTx.accessList = tx.accessList ?? [];
    } else {
      baseTx.gasPrice = tx.gasPrice!;
    }
    return ethers.utils.serializeTransaction(baseTx, {
      r: tx.r!,
      s: tx.s!,
      v: tx.v!,
    });
  }

  /** Encode a single executor swap leg as an unsigned tx with EIP-1559 fees. */
  private encodeLeg(
    pair: string,
    tokenIn: string,
    amountIn: BigNumber,
    amountOut: BigNumber,
    minOut: BigNumber,
    zeroForOne: boolean,
    gasLimit: BigNumber,
    maxFeePerGas: BigNumber,
    bribePerGas: BigNumber,
    nonce: number
  ): ethers.providers.TransactionRequest {
    return {
      to: this._executor.address,
      data: this._executor.interface.encodeFunctionData("swap", [
        pair,
        tokenIn,
        amountIn,
        amountOut,
        minOut,
        zeroForOne,
      ]),
      type: 2,
      chainId: config.CHAIN_ID,
      nonce,
      value: 0,
      gasLimit,
      maxFeePerGas: maxFeePerGas.add(bribePerGas),
      maxPriorityFeePerGas: bribePerGas,
    };
  }

  /**
   * Simulate the bundle and submit it for the next block (unless DRY_RUN).
   * Returns the simulated coinbase delta so the caller can confirm net profit.
   */
  async fire(
    plan: SandwichPlan,
    victimRaw: string
  ): Promise<{ submitted: boolean; coinbaseDiff?: BigNumber }> {
    const fb = await this.flashbots();
    const blockNumber = await this._provider.getBlockNumber();
    const targetBlock = blockNumber + 1;

    const weth = config.WETH;
    const token = plan.token;

    // Frontrun buys token with WETH; backrun sells the token back for WETH.
    // Pay the whole bribe via the backrun leg's priority fee per gas.
    const totalGas = plan.gasPerLeg.frontrun.add(plan.gasPerLeg.backrun);
    const bribePerGas = totalGas.gt(0)
      ? plan.bribe.div(totalGas)
      : BigNumber.from(0);

    // Our two legs come from the same wallet inside one bundle, so they need
    // consecutive nonces (the victim's tx sits between them but is a different
    // sender).
    const nonce = await this._wallet.getTransactionCount("pending");

    const front = this.encodeLeg(
      plan.pair,
      weth,
      plan.quote.frontrunIn,
      plan.quote.tokensBought,
      plan.frontMinOut,
      plan.wethIsToken0,
      plan.gasPerLeg.frontrun,
      plan.nextBaseFee,
      bribePerGas,
      nonce
    );
    const back = this.encodeLeg(
      plan.pair,
      token, // tokenIn = the bought token
      plan.quote.tokensBought,
      plan.quote.backrunOut,
      plan.backMinOut,
      !plan.wethIsToken0,
      plan.gasPerLeg.backrun,
      plan.nextBaseFee,
      bribePerGas,
      nonce + 1
    );

    const signedFront = await this._wallet.signTransaction(front);
    const signedBack = await this._wallet.signTransaction(back);

    const bundle = [
      { signedTransaction: signedFront },
      { signedTransaction: victimRaw },
      { signedTransaction: signedBack },
    ];

    const signedBundle = await fb.signBundle(bundle);
    const sim = await fb.simulate(signedBundle, targetBlock);

    if ("error" in sim) {
      Logging.logError(`bundle sim error: ${sim.error.message}`);
      return { submitted: false };
    }
    if (sim.firstRevert) {
      Logging.logWarn(`bundle reverts: ${JSON.stringify(sim.firstRevert)}`);
      return { submitted: false };
    }

    const coinbaseDiff = BigNumber.from(sim.coinbaseDiff);
    Logging.logInfo(
      `sim ok: coinbaseDiff=${ethers.utils.formatEther(coinbaseDiff)} ETH, gasUsed=${sim.totalGasUsed}`
    );

    if (config.DRY_RUN) {
      Logging.logWarn("DRY_RUN: not submitting bundle");
      return { submitted: false, coinbaseDiff };
    }

    const submission = await fb.sendRawBundle(signedBundle, targetBlock);
    if ("error" in submission) {
      Logging.logError(`submit error: ${submission.error.message}`);
      return { submitted: false, coinbaseDiff };
    }
    const resolution = await submission.wait();
    Logging.logInfo(
      `bundle resolution: ${FlashbotsBundleResolution[resolution]}`
    );
    return {
      submitted: resolution === FlashbotsBundleResolution.BundleIncluded,
      coinbaseDiff,
    };
  }
}

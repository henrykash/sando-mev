import { ethers, BigNumber, providers } from "ethers";
import { TransactionDescription } from "ethers/lib/utils";

/**
 * Swap method names on the UniswapV2 router that we can sandwich.
 * The `...SupportingFeeOnTransferTokens` variants are intentionally excluded:
 * they usually signal fee-on-transfer / honeypot tokens which are a common
 * source of losses (see docs/PROFITABILITY_ANALYSIS.md §7).
 */
export const SANDWICHABLE_METHODS = new Set<string>([
  "swapExactETHForTokens",
  "swapExactTokensForETH",
  "swapExactTokensForTokens",
  "swapETHForExactTokens",
  "swapTokensForExactETH",
  "swapTokensForExactTokens",
]);

/** Fee-on-transfer variants we recognise but treat as high-risk and skip. */
export const FEE_ON_TRANSFER_METHODS = new Set<string>([
  "swapExactETHForTokensSupportingFeeOnTransferTokens",
  "swapExactTokensForETHSupportingFeeOnTransferTokens",
  "swapExactTokensForTokensSupportingFeeOnTransferTokens",
]);

/** Gas pricing fields, normalised across legacy (type 0/1) and EIP-1559 (type 2). */
export interface GasInfo {
  type: number | null;
  gasPrice: BigNumber | null;
  maxFeePerGas: BigNumber | null;
  maxPriorityFeePerGas: BigNumber | null;
}

/** Normalised view of a victim swap, regardless of which swap method it used. */
export interface SwapDetails {
  method: string;
  /** "exactIn" => amountIn is fixed; "exactOut" => amountOut is fixed. */
  kind: "exactIn" | "exactOut";
  amountIn: BigNumber | null;
  amountInMax: BigNumber | null;
  amountOut: BigNumber | null;
  amountOutMin: BigNumber | null;
  path: string[];
  to: string;
  deadline: BigNumber;
}

class Helpers {
  constructor() {}

  /**
   * Exact EIP-1559 next-block base fee.
   * Base fee is fixed by the protocol from the parent block and changes by at
   * most ±12.5% per block; the searcher does not get to choose it. (The old
   * "+ random wei" trick was a misconception — bundle uniqueness comes from
   * your own nonces/payload, not the base fee.)
   */
  calculateNextBlockBaseFee = (currentBlock: providers.Block): BigNumber => {
    const baseFee = currentBlock.baseFeePerGas;
    if (!baseFee) {
      // Pre-1559 block; no base fee to project.
      return BigNumber.from(0);
    }

    const gasUsed = currentBlock.gasUsed;
    const gasLimit = currentBlock.gasLimit;
    const targetGasUsed = gasLimit.div(2);

    if (gasUsed.eq(targetGasUsed)) {
      return baseFee;
    }

    const BASE_FEE_MAX_CHANGE_DENOMINATOR = BigNumber.from(8); // 12.5%

    if (gasUsed.gt(targetGasUsed)) {
      const delta = gasUsed.sub(targetGasUsed);
      const baseFeeDelta = baseFee
        .mul(delta)
        .div(targetGasUsed)
        .div(BASE_FEE_MAX_CHANGE_DENOMINATOR);
      // Increase by at least 1 wei when the block was over target.
      return baseFee.add(baseFeeDelta.gt(0) ? baseFeeDelta : BigNumber.from(1));
    }

    const delta = targetGasUsed.sub(gasUsed);
    const baseFeeDelta = baseFee
      .mul(delta)
      .div(targetGasUsed)
      .div(BASE_FEE_MAX_CHANGE_DENOMINATOR);
    return baseFee.sub(baseFeeDelta);
  };

  /** Pull the gas pricing fields, correctly handling EIP-1559 vs legacy txs. */
  parseGas = (tx: providers.TransactionResponse): GasInfo => ({
    type: tx.type ?? null,
    gasPrice: tx.gasPrice ?? null,
    maxFeePerGas: tx.maxFeePerGas ?? null,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
  });

  /**
   * Normalise a decoded swap into a single shape so downstream profit logic
   * doesn't have to branch on the specific method. Returns null for methods we
   * don't sandwich.
   */
  extractSwapDetails = (
    parsed: TransactionDescription,
    txValue: BigNumber
  ): SwapDetails | null => {
    const method = parsed.name;
    if (!SANDWICHABLE_METHODS.has(method)) return null;

    const args = parsed.args;
    const path: string[] = args.path;
    const to: string = args.to;
    const deadline: BigNumber = args.deadline;

    switch (method) {
      // ETH in, fixed input is the tx value.
      case "swapExactETHForTokens":
        return {
          method,
          kind: "exactIn",
          amountIn: txValue,
          amountInMax: null,
          amountOut: null,
          amountOutMin: args.amountOutMin,
          path,
          to,
          deadline,
        };
      // Token in, fixed input in calldata.
      case "swapExactTokensForETH":
      case "swapExactTokensForTokens":
        return {
          method,
          kind: "exactIn",
          amountIn: args.amountIn,
          amountInMax: null,
          amountOut: null,
          amountOutMin: args.amountOutMin,
          path,
          to,
          deadline,
        };
      // ETH in, fixed output; max input is the tx value.
      case "swapETHForExactTokens":
        return {
          method,
          kind: "exactOut",
          amountIn: null,
          amountInMax: txValue,
          amountOut: args.amountOut,
          amountOutMin: null,
          path,
          to,
          deadline,
        };
      // Token in, fixed output, max input in calldata.
      case "swapTokensForExactETH":
      case "swapTokensForExactTokens":
        return {
          method,
          kind: "exactOut",
          amountIn: null,
          amountInMax: args.amountInMax,
          amountOut: args.amountOut,
          amountOutMin: null,
          path,
          to,
          deadline,
        };
      default:
        return null;
    }
  };
}

export const HelpersWrapper = new Helpers();

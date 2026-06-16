import { BigNumber } from "ethers";

/**
 * Net-profit and bribe accounting.
 *
 * P1 produced the *gross* profit of a sandwich (backrun WETH out − frontrun WETH
 * in). To decide whether to actually fire, we must subtract gas for both legs
 * and the bribe paid to the validator, and only proceed if what's left clears a
 * minimum margin. This module is pure BigNumber math so it can be unit-tested.
 *
 * Bribe model: builders order bundles by total value delivered to the validator
 * per gas. We pay the validator a coinbase transfer (the "bribe") and want it as
 * high as possible to win the block auction, while keeping our configured margin.
 * So: bribe = grossProfit − gasCost − minMargin, clamped to >= 0. Net to us then
 * equals exactly minMargin at that bribe — increase margin to keep more, decrease
 * to bid more aggressively.
 */

export interface ProfitInputs {
  /** Gross WETH profit from the sandwich (backrunOut − frontrunIn). */
  grossProfit: BigNumber;
  /** Projected next-block base fee (wei per gas). */
  nextBaseFee: BigNumber;
  /** Gas units for the frontrun leg. */
  frontrunGas: BigNumber;
  /** Gas units for the backrun leg. */
  backrunGas: BigNumber;
  /** Minimum net WETH we insist on keeping after gas + bribe. */
  minMargin: BigNumber;
}

export interface ProfitDecision {
  viable: boolean;
  /** base fee × (frontrunGas + backrunGas). */
  gasCost: BigNumber;
  /** Coinbase transfer to the validator. */
  bribe: BigNumber;
  /** What we keep: grossProfit − gasCost − bribe. */
  netProfit: BigNumber;
}

export function evaluateProfit(inputs: ProfitInputs): ProfitDecision {
  const { grossProfit, nextBaseFee, frontrunGas, backrunGas, minMargin } =
    inputs;

  const totalGas = frontrunGas.add(backrunGas);
  const gasCost = nextBaseFee.mul(totalGas);

  // What's available to split between us (margin) and the validator (bribe).
  const surplus = grossProfit.sub(gasCost);

  if (surplus.lte(minMargin)) {
    // Not enough to cover gas and still keep our minimum margin.
    return {
      viable: false,
      gasCost,
      bribe: BigNumber.from(0),
      netProfit: surplus, // may be negative; informational
    };
  }

  // Bid everything above our margin as the bribe; we keep exactly minMargin.
  const bribe = surplus.sub(minMargin);
  const netProfit = grossProfit.sub(gasCost).sub(bribe);

  return { viable: true, gasCost, bribe, netProfit };
}

import { BigNumber } from "ethers";
import { computeOptimalSandwich } from "../core/poolMath";
import { evaluateProfit } from "../core/profit";

/**
 * Backtest engine.
 *
 * Replays historical victim swaps through the exact same logic the live bot
 * uses (optimal-input search + net-profit/bribe accounting) so we can estimate
 * realised edge *before* risking capital. It is pure BigNumber math: feed it
 * scenarios (from the on-chain loader or a JSON fixture) and it returns an
 * aggregate report.
 *
 * Caveat: this measures the *opportunity* (could we have profitably sandwiched
 * this swap given the pool state), not inclusion — it does not model whether we
 * would have won the block auction against competitors. It is an upper bound on
 * capturable edge, useful for sizing and go/no-go decisions.
 */
export interface BacktestScenario {
  /** Free-form label, e.g. block:txHash. */
  label?: string;
  /** Victim's WETH input. */
  victimIn: BigNumber;
  /** Victim's amountOutMin (slippage limit); 0 if none. */
  victimMinOut: BigNumber;
  /** Pool reserves at the parent block. */
  reserveWeth: BigNumber;
  reserveToken: BigNumber;
  /** Projected next-block base fee at that point. */
  nextBaseFee: BigNumber;
}

export interface BacktestParams {
  maxFrontrun: BigNumber;
  minMargin: BigNumber;
  frontrunGas: BigNumber;
  backrunGas: BigNumber;
}

export interface BacktestReport {
  scenarios: number;
  /** Had a positive-gross-profit optimal frontrun. */
  feasible: number;
  /** Cleared gas + margin (would actually fire). */
  profitable: number;
  /** profitable / scenarios. */
  hitRate: number;
  grossProfitTotal: BigNumber;
  gasCostTotal: BigNumber;
  bribeTotal: BigNumber;
  netProfitTotal: BigNumber;
  /** Best single net result, with its label. */
  bestNet: BigNumber;
  bestLabel?: string;
}

export function runBacktest(
  scenarios: BacktestScenario[],
  params: BacktestParams
): BacktestReport {
  let feasible = 0;
  let profitable = 0;
  let grossProfitTotal = BigNumber.from(0);
  let gasCostTotal = BigNumber.from(0);
  let bribeTotal = BigNumber.from(0);
  let netProfitTotal = BigNumber.from(0);
  let bestNet = BigNumber.from(0);
  let bestLabel: string | undefined;

  for (const s of scenarios) {
    const quote = computeOptimalSandwich({
      victimIn: s.victimIn,
      victimMinOut: s.victimMinOut,
      reserveIn: s.reserveWeth,
      reserveOut: s.reserveToken,
      maxFrontrun: params.maxFrontrun,
    });
    if (!quote) continue;
    feasible++;

    const decision = evaluateProfit({
      grossProfit: quote.grossProfit,
      nextBaseFee: s.nextBaseFee,
      frontrunGas: params.frontrunGas,
      backrunGas: params.backrunGas,
      minMargin: params.minMargin,
    });
    if (!decision.viable) continue;

    profitable++;
    grossProfitTotal = grossProfitTotal.add(quote.grossProfit);
    gasCostTotal = gasCostTotal.add(decision.gasCost);
    bribeTotal = bribeTotal.add(decision.bribe);
    netProfitTotal = netProfitTotal.add(decision.netProfit);

    if (decision.netProfit.gt(bestNet)) {
      bestNet = decision.netProfit;
      bestLabel = s.label;
    }
  }

  return {
    scenarios: scenarios.length,
    feasible,
    profitable,
    hitRate: scenarios.length === 0 ? 0 : profitable / scenarios.length,
    grossProfitTotal,
    gasCostTotal,
    bribeTotal,
    netProfitTotal,
    bestNet,
    bestLabel,
  };
}

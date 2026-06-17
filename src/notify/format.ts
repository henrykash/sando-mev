import { BigNumber, utils } from "ethers";
import { SandwichQuote } from "../core/poolMath";
import { ProfitDecision } from "../core/profit";
import { ArbQuote } from "../mevshare/arb";
import { BacktestReport } from "../backtest/engine";

/**
 * Pure formatters for Telegram alerts. Kept separate from the transport so they
 * can be unit-tested. Output is Telegram Markdown.
 */
const eth = (v: BigNumber) => utils.formatEther(v);

/** Alert for a profitable sandwich candidate (sent before we execute). */
export function formatSandwichAlert(params: {
  hash: string;
  token: string;
  pair: string;
  quote: SandwichQuote;
  decision: ProfitDecision;
  dryRun: boolean;
}): string {
  const { hash, token, pair, quote, decision, dryRun } = params;
  return [
    `🥪 *Sandwich opportunity*${dryRun ? " _(DRY_RUN)_" : ""}`,
    `token: \`${token}\``,
    `pair: \`${pair}\``,
    `frontrun in: ${eth(quote.frontrunIn)} WETH`,
    `gross: ${eth(quote.grossProfit)} WETH`,
    `gas: ${eth(decision.gasCost)} | bribe: ${eth(decision.bribe)} WETH`,
    `*net: ${eth(decision.netProfit)} WETH*`,
    `tx: \`${hash}\``,
  ].join("\n");
}

/** Alert for a cross-venue backrun arbitrage candidate. */
export function formatBackrunAlert(params: {
  hash: string;
  token: string;
  venues: string[];
  quote: ArbQuote;
}): string {
  const { hash, token, venues, quote } = params;
  return [
    `🛰️ *Backrun arb opportunity*`,
    `token: \`${token}\``,
    `venues: ${venues.join(" ↔ ")}`,
    `direction: ${quote.direction}`,
    `amount in: ${eth(quote.amountIn)} WETH`,
    `*gross: ${eth(quote.profit)} WETH*`,
    `hint: \`${hash}\``,
  ].join("\n");
}

/** Summary of a backtest run. */
export function formatBacktestSummary(r: BacktestReport): string {
  return [
    `📊 *Backtest complete*`,
    `scenarios: ${r.scenarios} | feasible: ${r.feasible} | profitable: ${r.profitable}`,
    `hit rate: ${(r.hitRate * 100).toFixed(1)}%`,
    `gross: ${eth(r.grossProfitTotal)} | gas: ${eth(r.gasCostTotal)} WETH`,
    `bribe: ${eth(r.bribeTotal)} WETH`,
    `*net total: ${eth(r.netProfitTotal)} WETH*`,
    `best single: ${eth(r.bestNet)} WETH${r.bestLabel ? ` (${r.bestLabel})` : ""}`,
  ].join("\n");
}

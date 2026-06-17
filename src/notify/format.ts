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
  tokenIn: string;
  token: string;
  pair: string;
  quote: SandwichQuote;
  /** Gross profit valued in WETH (profit is denominated in tokenIn). */
  grossProfitWeth: BigNumber;
  decision: ProfitDecision;
  dryRun: boolean;
}): string {
  const { hash, tokenIn, token, pair, quote, grossProfitWeth, decision, dryRun } =
    params;
  return [
    `🥪 *Sandwich opportunity*${dryRun ? " _(DRY_RUN)_" : ""}`,
    `tokenIn: \`${tokenIn}\``,
    `tokenOut: \`${token}\``,
    `pair: \`${pair}\``,
    `frontrun in: ${quote.frontrunIn.toString()} (tokenIn)`,
    `gross: ${eth(grossProfitWeth)} WETH`,
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

/** Sent once when the mempool monitor starts. */
export function formatStartup(dryRun: boolean): string {
  return [
    `🤖 *sando-mev started*${dryRun ? " _(DRY_RUN)_" : ""}`,
    `monitoring the mempool — alerts will arrive when a profitable opportunity is found.`,
  ].join("\n");
}

/** Sent on a websocket connect/disconnect transition. */
export function formatConnection(connected: boolean): string {
  return connected
    ? `🟢 *websocket connected* — watching pending transactions.`
    : `🔴 *websocket disconnected* — reconnecting…`;
}

/** Periodic "still alive" summary with running counters. */
export function formatHeartbeat(p: {
  uptimeMinutes: number;
  v2Targets: number;
  v3Targets: number;
  profitable: number;
  dryRun: boolean;
}): string {
  return [
    `💓 *sando-mev heartbeat*${p.dryRun ? " _(DRY_RUN)_" : ""}`,
    `uptime: ${p.uptimeMinutes}m`,
    `v2 targets: ${p.v2Targets} | v3 targets: ${p.v3Targets}`,
    `profitable found: ${p.profitable}`,
  ].join("\n");
}

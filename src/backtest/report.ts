import { BigNumberish, utils } from "ethers";
import { BacktestReport } from "./engine";

/** Human-readable summary of a backtest run. */
export function formatReport(r: BacktestReport): string {
  const eth = (v: BigNumberish) => utils.formatEther(v);
  const pct = (n: number) => (n * 100).toFixed(1) + "%";

  const lines = [
    "================ backtest report ================",
    `scenarios evaluated : ${r.scenarios}`,
    `feasible (gross > 0) : ${r.feasible}`,
    `profitable (net)     : ${r.profitable}  (hit rate ${pct(r.hitRate)})`,
    "-------------------------------------------------",
    `gross profit total   : ${eth(r.grossProfitTotal)} ETH`,
    `gas cost total       : ${eth(r.gasCostTotal)} ETH`,
    `bribe total          : ${eth(r.bribeTotal)} ETH`,
    `net profit total     : ${eth(r.netProfitTotal)} ETH`,
    `best single net      : ${eth(r.bestNet)} ETH${
      r.bestLabel ? `  (${r.bestLabel})` : ""
    }`,
    "=================================================",
  ];
  return lines.join("\n");
}

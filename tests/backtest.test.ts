import assert from "assert";
import { BigNumber, utils } from "ethers";
import { runBacktest, BacktestScenario, BacktestParams } from "../src/backtest/engine";
import { formatReport } from "../src/backtest/report";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);
const gwei = (n: number) => BigNumber.from(n).mul(1_000_000_000);

const params: BacktestParams = {
  maxFrontrun: eth("1"),
  minMargin: eth("0.02"),
  frontrunGas: BigNumber.from("120000"),
  backrunGas: BigNumber.from("120000"),
};

// A scenario that profitably sandwiches, and one that can't (tiny victim, deep pool).
const profitable: BacktestScenario = {
  label: "p",
  victimIn: eth("5"),
  victimMinOut: BigNumber.from(0),
  reserveWeth: eth("100"),
  reserveToken: eth("200000"),
  nextBaseFee: gwei(20),
};
const unprofitable: BacktestScenario = {
  label: "u",
  victimIn: BigNumber.from("1000000000000000"), // 0.001 WETH
  victimMinOut: BigNumber.from(0),
  reserveWeth: eth("1000000"),
  reserveToken: eth("1000000"),
  nextBaseFee: gwei(30),
};

test("runBacktest: counts profitable vs unprofitable correctly", () => {
  const r = runBacktest([profitable, unprofitable], params);
  assert.strictEqual(r.scenarios, 2);
  assert.strictEqual(r.profitable, 1);
  assert.ok(r.netProfitTotal.gt(0), "expected positive net total");
  assert.strictEqual(r.bestLabel, "p");
});

test("runBacktest: totals reconcile (gross = gas + bribe + net)", () => {
  const r = runBacktest([profitable], params);
  assert.strictEqual(
    r.gasCostTotal.add(r.bribeTotal).add(r.netProfitTotal).toString(),
    r.grossProfitTotal.toString()
  );
});

test("runBacktest: empty input yields a zeroed report", () => {
  const r = runBacktest([], params);
  assert.strictEqual(r.scenarios, 0);
  assert.strictEqual(r.profitable, 0);
  assert.strictEqual(r.hitRate, 0);
  assert.strictEqual(r.netProfitTotal.toString(), "0");
});

test("formatReport: renders without throwing and includes the hit rate", () => {
  const out = formatReport(runBacktest([profitable, unprofitable], params));
  assert.ok(out.includes("backtest report"));
  assert.ok(out.includes("hit rate"));
});

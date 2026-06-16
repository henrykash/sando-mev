import assert from "assert";
import { BigNumber, utils } from "ethers";
import { evaluateProfit } from "../src/core/profit";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);

test("evaluateProfit: viable trade keeps exactly the margin and bids the rest", () => {
  const grossProfit = eth("1");
  const nextBaseFee = BigNumber.from("20000000000"); // 20 gwei
  const frontrunGas = BigNumber.from("120000");
  const backrunGas = BigNumber.from("120000");
  const minMargin = eth("0.02");

  const d = evaluateProfit({ grossProfit, nextBaseFee, frontrunGas, backrunGas, minMargin });

  assert.ok(d.viable, "expected viable");
  // gasCost = 20 gwei * 240000 = 0.0048 ETH
  assert.strictEqual(d.gasCost.toString(), nextBaseFee.mul(240000).toString());
  // We keep exactly the margin.
  assert.strictEqual(d.netProfit.toString(), minMargin.toString());
  // Conservation: gross == gas + bribe + net.
  assert.strictEqual(
    d.gasCost.add(d.bribe).add(d.netProfit).toString(),
    grossProfit.toString()
  );
  assert.ok(d.bribe.gt(0), "expected a positive bribe");
});

test("evaluateProfit: rejects when gross can't cover gas + margin", () => {
  const d = evaluateProfit({
    grossProfit: eth("0.01"),
    nextBaseFee: BigNumber.from("50000000000"), // 50 gwei
    frontrunGas: BigNumber.from("120000"),
    backrunGas: BigNumber.from("120000"),
    minMargin: eth("0.02"),
  });
  assert.strictEqual(d.viable, false);
  assert.strictEqual(d.bribe.toString(), "0");
});

test("evaluateProfit: boundary where surplus == margin is not viable", () => {
  const nextBaseFee = BigNumber.from("10000000000"); // 10 gwei
  const totalGas = 240000;
  const gasCost = nextBaseFee.mul(totalGas);
  const minMargin = eth("0.02");
  // gross exactly equals gasCost + margin => surplus == margin => not viable.
  const grossProfit = gasCost.add(minMargin);
  const d = evaluateProfit({
    grossProfit,
    nextBaseFee,
    frontrunGas: BigNumber.from("120000"),
    backrunGas: BigNumber.from("120000"),
    minMargin,
  });
  assert.strictEqual(d.viable, false);
});

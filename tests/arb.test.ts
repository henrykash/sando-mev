import assert from "assert";
import { BigNumber, utils } from "ethers";
import { optimalCrossPoolArb, Pool } from "../src/mevshare/arb";
import { getAmountOut } from "../src/core/poolMath";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);

test("optimalCrossPoolArb: no profit when pools are identical", () => {
  const p: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  assert.strictEqual(optimalCrossPoolArb(p, { ...p }, eth("50")), null);
});

test("optimalCrossPoolArb: finds profit when one pool is mispriced", () => {
  // Pool A: token is cheaper (more token per WETH). Pool B: dearer.
  const a: Pool = { reserveWeth: eth("100"), reserveToken: eth("220000") };
  const b: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  const q = optimalCrossPoolArb(a, b, eth("50"))!;
  assert.ok(q, "expected an arb");
  assert.ok(q.profit.gt(0), `expected positive profit, got ${q.profit}`);
  // Token is cheaper on A => buy on A, sell on B.
  assert.strictEqual(q.direction, "buyOnA");
});

test("optimalCrossPoolArb: direction flips when the dear/cheap pools swap", () => {
  const a: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  const b: Pool = { reserveWeth: eth("100"), reserveToken: eth("220000") };
  const q = optimalCrossPoolArb(a, b, eth("50"))!;
  assert.strictEqual(q.direction, "buyOnB");
});

test("optimalCrossPoolArb: reported profit reproduces via the two swaps", () => {
  const a: Pool = { reserveWeth: eth("80"), reserveToken: eth("200000") };
  const b: Pool = { reserveWeth: eth("120"), reserveToken: eth("200000") };
  const q = optimalCrossPoolArb(a, b, eth("50"))!;
  assert.ok(q, "expected an arb");
  // Recompute the cycle for the chosen direction and amount.
  const [buy, sell] = q.direction === "buyOnA" ? [a, b] : [b, a];
  const tok = getAmountOut(q.amountIn, buy.reserveWeth, buy.reserveToken);
  const wethBack = getAmountOut(tok, sell.reserveToken, sell.reserveWeth);
  assert.strictEqual(wethBack.sub(q.amountIn).toString(), q.profit.toString());
});

test("optimalCrossPoolArb: profit is not beaten by nearby input sizes", () => {
  const a: Pool = { reserveWeth: eth("80"), reserveToken: eth("210000") };
  const b: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  const q = optimalCrossPoolArb(a, b, eth("50"))!;
  const [buy, sell] = q.direction === "buyOnA" ? [a, b] : [b, a];
  const cycle = (amt: BigNumber) => {
    const tok = getAmountOut(amt, buy.reserveWeth, buy.reserveToken);
    return getAmountOut(tok, sell.reserveToken, sell.reserveWeth).sub(amt);
  };
  const step = q.amountIn.div(50).add(1);
  assert.ok(q.profit.gte(cycle(q.amountIn.sub(step))), "smaller input beat optimum");
  assert.ok(q.profit.gte(cycle(q.amountIn.add(step))), "larger input beat optimum");
});

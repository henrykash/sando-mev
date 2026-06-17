import assert from "assert";
import { BigNumber, utils } from "ethers";
import {
  optimalCrossPoolArb,
  applySwapToReserves,
  Pool,
} from "../src/mevshare/arb";
import { getAmountOut } from "../src/core/poolMath";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);

test("applySwapToReserves: moves reserves consistently with getAmountOut", () => {
  const rIn = eth("100");
  const rOut = eth("200000");
  const amountIn = eth("5");
  const out = getAmountOut(amountIn, rIn, rOut);
  const post = applySwapToReserves(amountIn, rIn, rOut);
  assert.strictEqual(post.reserveIn.toString(), rIn.add(amountIn).toString());
  assert.strictEqual(post.reserveOut.toString(), rOut.sub(out).toString());
  // Constant-product invariant grows (fee accrues): k_after >= k_before.
  assert.ok(post.reserveIn.mul(post.reserveOut).gte(rIn.mul(rOut)));
});

test("applySwapToReserves then arb: a big swap opens a cross-venue gap", () => {
  // Two equal pools; a large WETH buy on pool A should make A's token dearer,
  // creating a profitable buy-on-B / sell-on-A backrun.
  const a: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  const b: Pool = { reserveWeth: eth("100"), reserveToken: eth("200000") };
  const post = applySwapToReserves(eth("20"), a.reserveWeth, a.reserveToken);
  const hit: Pool = { reserveWeth: post.reserveIn, reserveToken: post.reserveOut };
  const q = optimalCrossPoolArb(hit, b, eth("50"));
  assert.ok(q, "expected a backrun arb after the swap");
  assert.ok(q!.profit.gt(0), `expected positive profit, got ${q!.profit}`);
});

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

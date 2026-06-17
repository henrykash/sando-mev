import assert from "assert";
import { BigNumber, utils } from "ethers";
import {
  optimalCrossPoolArb,
  applySwapToReserves,
  v3VirtualPool,
  Pool,
} from "../src/mevshare/arb";
import { getAmountOut } from "../src/core/poolMath";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);
const Q96 = BigNumber.from(2).pow(96);

test("getAmountOut: feeBps default matches V2 0.30% and lower fee yields more", () => {
  const rIn = BigNumber.from(1_000_000);
  const rOut = BigNumber.from(1_000_000);
  assert.strictEqual(getAmountOut(BigNumber.from(1000), rIn, rOut).toString(), "996");
  assert.strictEqual(
    getAmountOut(BigNumber.from(1000), rIn, rOut, 30).toString(),
    "996"
  );
  // 5bps (V3 0.05% tier) returns strictly more than 30bps.
  assert.ok(
    getAmountOut(BigNumber.from(1000), rIn, rOut, 5).gt(
      getAmountOut(BigNumber.from(1000), rIn, rOut, 30)
    )
  );
});

test("v3VirtualPool: price-1 pool gives equal reserves and maps fee tier", () => {
  const L = eth("1000");
  // sqrtPriceX96 = Q96 => price 1 => virtual reserves equal.
  const pool = v3VirtualPool(Q96, L, 3000, true);
  assert.strictEqual(pool.reserveWeth.toString(), L.toString());
  assert.strictEqual(pool.reserveToken.toString(), L.toString());
  assert.strictEqual(pool.feeBps, 30); // 3000 -> 30bps
});

test("v3VirtualPool: orientation flips with wethIsToken0", () => {
  const L = eth("1000");
  const sqrtP = Q96.mul(2); // price 4 (token1/token0)
  const asToken0 = v3VirtualPool(sqrtP, L, 500, true);
  const asToken1 = v3VirtualPool(sqrtP, L, 500, false);
  // Swapping which side is WETH swaps the two reserves.
  assert.strictEqual(asToken0.reserveWeth.toString(), asToken1.reserveToken.toString());
  assert.strictEqual(asToken0.reserveToken.toString(), asToken1.reserveWeth.toString());
  assert.strictEqual(asToken0.feeBps, 5); // 500 -> 5bps
});

test("arb works across a V2 pool and a V3 virtual pool", () => {
  // V2 pool priced differently from a V3 pool of the same pair => arb exists.
  const v2: Pool = { reserveWeth: eth("100"), reserveToken: eth("220000") };
  const v3 = v3VirtualPool(Q96, eth("150000"), 3000, true); // ~price 1 region
  const q = optimalCrossPoolArb(v2, v3, eth("50"));
  assert.ok(q, "expected an arb across V2 and V3");
  assert.ok(q!.profit.gt(0), `expected positive profit, got ${q!.profit}`);
});

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

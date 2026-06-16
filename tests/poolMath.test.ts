import assert from "assert";
import { BigNumber } from "ethers";
import {
  getAmountOut,
  getAmountIn,
  maxFrontrunWithinSlippage,
  evaluateSandwich,
  computeOptimalSandwich,
} from "../src/core/poolMath";
import { test } from "./harness";

const bn = (n: string | number) => BigNumber.from(n);

// --- getAmountOut matches the on-chain UniswapV2Library formula ---------------
test("getAmountOut matches reference value", () => {
  // 1000 in, 1e6/1e6 reserves -> floor(997000*1e6 / (1e9 + 997000)) = 996
  assert.strictEqual(getAmountOut(bn(1000), bn(1_000_000), bn(1_000_000)).toString(), "996");
});

test("getAmountOut returns 0 on degenerate inputs", () => {
  assert.strictEqual(getAmountOut(bn(0), bn(1_000_000), bn(1_000_000)).toString(), "0");
  assert.strictEqual(getAmountOut(bn(1000), bn(0), bn(1_000_000)).toString(), "0");
});

// --- getAmountIn is the inverse (round-trips within rounding) -----------------
test("getAmountIn round-trips getAmountOut", () => {
  const Rin = bn("5000000000000000000000");
  const Rout = bn("9000000000000000000000");
  const amountIn = bn("1000000000000000000"); // 1 token
  const out = getAmountOut(amountIn, Rin, Rout);
  const backIn = getAmountIn(out, Rin, Rout);
  // getAmountIn rounds up, so backIn should be >= amountIn and very close.
  assert.ok(backIn.gte(amountIn), `backIn ${backIn} < amountIn ${amountIn}`);
  const diff = backIn.sub(amountIn);
  assert.ok(diff.lte(bn("1000000000000")), `round-trip drift too large: ${diff}`);
});

// --- slippage bound: victim always still gets >= their min out ----------------
test("maxFrontrunWithinSlippage respects victim min-out", () => {
  const Rin = bn("100000000000000000000"); // 100 WETH
  const Rout = bn("200000000000000000000000"); // 200k token
  const victimIn = bn("1000000000000000000"); // 1 WETH
  // Victim's no-frontrun output, then demand 99% of it as their min.
  const cleanOut = getAmountOut(victimIn, Rin, Rout);
  const minOut = cleanOut.mul(99).div(100);

  const cap = bn("50000000000000000000"); // 50 WETH cap
  const a = maxFrontrunWithinSlippage(victimIn, minOut, Rin, Rout, cap);

  // At the chosen frontrun the victim still clears their min...
  const out = evaluateSandwich(a, victimIn, Rin, Rout).victimOut;
  assert.ok(out.gte(minOut), `victimOut ${out} < minOut ${minOut}`);
  // ...and one wei more would (in general) violate it or hit the cap.
  assert.ok(a.gt(0), "expected a positive frontrun bound");
  assert.ok(a.lte(cap), "frontrun exceeded cap");
});

test("maxFrontrunWithinSlippage returns cap when victim has no protection", () => {
  const Rin = bn("100000000000000000000");
  const Rout = bn("200000000000000000000000");
  const cap = bn("5000000000000000000");
  const a = maxFrontrunWithinSlippage(bn("1000000000000000000"), bn(0), Rin, Rout, cap);
  assert.strictEqual(a.toString(), cap.toString());
});

// --- optimal sandwich: profitable, bounded, and constraint-respecting --------
test("computeOptimalSandwich finds a positive-profit frontrun", () => {
  const Rin = bn("100000000000000000000"); // 100 WETH
  const Rout = bn("200000000000000000000000"); // 200k token
  const victimIn = bn("5000000000000000000"); // 5 WETH buy
  const cleanOut = getAmountOut(victimIn, Rin, Rout);
  const minOut = cleanOut.mul(90).div(100); // 10% slippage tolerance

  const quote = computeOptimalSandwich({
    victimIn,
    victimMinOut: minOut,
    reserveIn: Rin,
    reserveOut: Rout,
    maxFrontrun: bn("100000000000000000000"),
  });

  assert.ok(quote, "expected a quote");
  assert.ok(quote!.grossProfit.gt(0), `expected positive profit, got ${quote!.grossProfit}`);
  assert.ok(quote!.victimOut.gte(minOut), "victim pushed below min-out");
  // Re-evaluating the returned frontrun reproduces the same profit (consistency).
  const re = evaluateSandwich(quote!.frontrunIn, victimIn, Rin, Rout);
  assert.strictEqual(re.grossProfit.toString(), quote!.grossProfit.toString());
});

test("computeOptimalSandwich rejects when no profit is possible", () => {
  // Tiny victim trade in a deep pool: price impact (and thus extractable MEV)
  // is below the rounding floor -> no profitable frontrun.
  const Rin = bn("1000000000000000000000000"); // 1,000,000 WETH
  const Rout = bn("1000000000000000000000000");
  const quote = computeOptimalSandwich({
    victimIn: bn("1"), // 1 wei
    victimMinOut: bn(0),
    reserveIn: Rin,
    reserveOut: Rout,
    maxFrontrun: bn("1000000000000000000"),
  });
  assert.strictEqual(quote, null);
});

test("optimal frontrun beats every other feasible frontrun", () => {
  // Protected victim with loose (30%) slippage and a generous cap. The
  // optimiser must return the profit-maximising frontrun within the feasible
  // range [0, slippage-bound] — we assert that directly by sampling, without
  // assuming where the optimum lies (boundary vs interior peak).
  const Rin = bn("50000000000000000000"); // 50 WETH
  const Rout = bn("100000000000000000000000"); // 100k token
  const victimIn = bn("2000000000000000000"); // 2 WETH
  const cap = bn("50000000000000000000");
  const cleanOut = getAmountOut(victimIn, Rin, Rout);
  const minOut = cleanOut.mul(70).div(100);

  const upper = maxFrontrunWithinSlippage(victimIn, minOut, Rin, Rout, cap);
  const quote = computeOptimalSandwich({
    victimIn,
    victimMinOut: minOut,
    reserveIn: Rin,
    reserveOut: Rout,
    maxFrontrun: cap,
  })!;
  assert.ok(quote, "expected a quote");
  assert.ok(quote.victimOut.gte(minOut), "victim pushed below min-out");

  // No feasible frontrun (within the slippage bound) yields more gross profit.
  for (let i = 0; i <= 40; i++) {
    const a = upper.mul(i).div(40);
    const p = evaluateSandwich(a, victimIn, Rin, Rout).grossProfit;
    assert.ok(
      quote.grossProfit.gte(p),
      `frontrun ${a} (profit ${p}) beat the reported optimum ${quote.grossProfit}`
    );
  }
});

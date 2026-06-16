import { BigNumber } from "ethers";

/**
 * UniswapV2 constant-product (x*y=k) math and the sandwich profit model.
 *
 * Everything here is pure integer math on BigNumber so it can be unit-tested
 * deterministically (see tests/poolMath.test.ts) and matches the on-chain
 * UniswapV2Library exactly (0.30% fee => 997/1000).
 */

const FEE_NUMERATOR = BigNumber.from(997);
const FEE_DENOMINATOR = BigNumber.from(1000);
const ZERO = BigNumber.from(0);

/** Exact analogue of UniswapV2Library.getAmountOut. */
export function getAmountOut(
  amountIn: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber
): BigNumber {
  if (amountIn.lte(0) || reserveIn.lte(0) || reserveOut.lte(0)) return ZERO;
  const amountInWithFee = amountIn.mul(FEE_NUMERATOR);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(FEE_DENOMINATOR).add(amountInWithFee);
  return numerator.div(denominator);
}

/** Exact analogue of UniswapV2Library.getAmountIn. */
export function getAmountIn(
  amountOut: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber
): BigNumber {
  if (amountOut.lte(0) || reserveIn.lte(0) || reserveOut.lte(0)) return ZERO;
  if (amountOut.gte(reserveOut)) return BigNumber.from(0); // not satisfiable
  const numerator = reserveIn.mul(amountOut).mul(FEE_DENOMINATOR);
  const denominator = reserveOut.sub(amountOut).mul(FEE_NUMERATOR);
  return numerator.div(denominator).add(1);
}

/** What the victim receives if we frontrun their buy with `frontrunIn` WETH. */
export function victimOutputAfterFrontrun(
  frontrunIn: BigNumber,
  victimIn: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber
): BigNumber {
  const tokensBought = getAmountOut(frontrunIn, reserveIn, reserveOut);
  const reserveInAfter = reserveIn.add(frontrunIn);
  const reserveOutAfter = reserveOut.sub(tokensBought);
  return getAmountOut(victimIn, reserveInAfter, reserveOutAfter);
}

/**
 * Largest frontrun (in WETH) that still leaves the victim's output >= their
 * `victimMinOut`. victimOutput is monotonically decreasing in the frontrun
 * size, so we binary-search within [0, cap].
 *
 * If victimMinOut is 0 (no slippage protection) the constraint never binds and
 * we return `cap`.
 */
export function maxFrontrunWithinSlippage(
  victimIn: BigNumber,
  victimMinOut: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber,
  cap: BigNumber
): BigNumber {
  if (cap.lte(0)) return ZERO;
  if (victimMinOut.lte(0)) return cap;

  // If even a zero frontrun can't satisfy the victim, it's not our concern.
  if (victimOutputAfterFrontrun(ZERO, victimIn, reserveIn, reserveOut).lt(victimMinOut)) {
    return ZERO;
  }
  // If the cap itself still satisfies the victim, the cap is the answer.
  if (victimOutputAfterFrontrun(cap, victimIn, reserveIn, reserveOut).gte(victimMinOut)) {
    return cap;
  }

  let lo = ZERO;
  let hi = cap;
  while (hi.sub(lo).gt(1)) {
    const mid = lo.add(hi).div(2);
    const out = victimOutputAfterFrontrun(mid, victimIn, reserveIn, reserveOut);
    if (out.gte(victimMinOut)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export interface SandwichQuote {
  /** WETH put into the frontrun buy. */
  frontrunIn: BigNumber;
  /** Tokens received from the frontrun (and later sold). */
  tokensBought: BigNumber;
  /** Tokens the victim receives (>= their amountOutMin). */
  victimOut: BigNumber;
  /** WETH received from the backrun sell. */
  backrunOut: BigNumber;
  /** WETH profit before gas/bribe: backrunOut - frontrunIn. */
  grossProfit: BigNumber;
}

/** Evaluate the full sandwich (front -> victim -> back) for a given frontrun. */
export function evaluateSandwich(
  frontrunIn: BigNumber,
  victimIn: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber
): SandwichQuote {
  const tokensBought = getAmountOut(frontrunIn, reserveIn, reserveOut);
  const r1In = reserveIn.add(frontrunIn);
  const r1Out = reserveOut.sub(tokensBought);

  const victimOut = getAmountOut(victimIn, r1In, r1Out);
  const r2In = r1In.add(victimIn);
  const r2Out = r1Out.sub(victimOut);

  // Sell our tokens back for WETH (reserves are now token-in / WETH-out).
  const backrunOut = getAmountOut(tokensBought, r2Out, r2In);

  return {
    frontrunIn,
    tokensBought,
    victimOut,
    backrunOut,
    grossProfit: backrunOut.sub(frontrunIn),
  };
}

/**
 * Find the gross-profit-maximising frontrun for a victim buying `victimIn`
 * WETH for tokens, subject to their slippage limit and a capital cap.
 *
 * grossProfit(frontrun) is unimodal on [0, slippageMax], so we ternary-search
 * it. The search bound is min(slippage-bound, capital cap), which means the
 * result is automatically min(unconstrained-optimum, slippage-bound) — i.e. we
 * never push the victim past their amountOutMin, and we never bet more capital
 * than allowed.
 *
 * Returns null when no positive-gross-profit sandwich exists (gas is applied by
 * the caller on top of this).
 */
export function computeOptimalSandwich(params: {
  victimIn: BigNumber;
  victimMinOut: BigNumber;
  reserveIn: BigNumber; // WETH reserve
  reserveOut: BigNumber; // token reserve
  maxFrontrun: BigNumber; // capital cap, in WETH
}): SandwichQuote | null {
  const { victimIn, victimMinOut, reserveIn, reserveOut, maxFrontrun } = params;

  const upper = maxFrontrunWithinSlippage(
    victimIn,
    victimMinOut,
    reserveIn,
    reserveOut,
    maxFrontrun
  );
  if (upper.lte(0)) return null;

  let lo = ZERO;
  let hi = upper;
  const profitAt = (a: BigNumber) =>
    evaluateSandwich(a, victimIn, reserveIn, reserveOut).grossProfit;

  // Ternary search over the integer-valued unimodal profit curve.
  while (hi.sub(lo).gt(2)) {
    const third = hi.sub(lo).div(3);
    const m1 = lo.add(third);
    const m2 = hi.sub(third);
    if (profitAt(m1).lt(profitAt(m2))) {
      lo = m1;
    } else {
      hi = m2;
    }
  }

  // Scan the small remaining window for the exact best point.
  let best = lo;
  let bestProfit = profitAt(lo);
  for (let c = lo.add(1); c.lte(hi); c = c.add(1)) {
    const p = profitAt(c);
    if (p.gt(bestProfit)) {
      bestProfit = p;
      best = c;
    }
  }

  if (bestProfit.lte(0)) return null;
  return evaluateSandwich(best, victimIn, reserveIn, reserveOut);
}

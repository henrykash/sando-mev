import { BigNumber } from "ethers";
import { getAmountOut } from "../core/poolMath";

/**
 * Cross-venue backrun arbitrage.
 *
 * When a user's swap moves the price of a token on one venue, the same pair on
 * another venue is now mispriced. The atomic backrun is: borrow WETH, buy the
 * token where it's cheap, sell it where it's dear, repay — keeping the spread.
 * This is the core estimator for the listen-only edge validator (and, later, the
 * live backrun executor).
 *
 * Both pools are modelled as UniswapV2 constant-product (0.30% fee). The profit
 * curve in the input amount is unimodal, so we ternary-search it — the same
 * approach (and reasoning) as the sandwich optimal-input search.
 */
export interface Pool {
  /** WETH-side reserve. */
  reserveWeth: BigNumber;
  /** Token-side reserve. */
  reserveToken: BigNumber;
  /** Swap fee in basis points (default 30 = 0.30%). V3 pools set their tier. */
  feeBps?: number;
}

const Q96 = BigNumber.from(2).pow(96);

/**
 * Model a UniswapV3 pool as constant-product "virtual reserves" at its current
 * price. With active liquidity L and price sqrtPriceX96, the virtual reserves
 * are x = L·2^96 / sqrtP (token0) and y = L·sqrtP / 2^96 (token1); locally
 * (within the current tick) the pool swaps exactly like a V2 pool with those
 * reserves and the tier's fee. This lets V3 pools drop into the same arb math.
 * (It under-models large, tick-crossing swaps — fine for a listen-only estimate.)
 */
export function v3VirtualPool(
  sqrtPriceX96: BigNumber,
  liquidity: BigNumber,
  feeTier: number,
  wethIsToken0: boolean
): Pool {
  const token0 = liquidity.mul(Q96).div(sqrtPriceX96); // virtual reserve token0
  const token1 = liquidity.mul(sqrtPriceX96).div(Q96); // virtual reserve token1
  const feeBps = Math.round(feeTier / 100); // 3000 -> 30bps
  return wethIsToken0
    ? { reserveWeth: token0, reserveToken: token1, feeBps }
    : { reserveWeth: token1, reserveToken: token0, feeBps };
}

export interface ArbQuote {
  /** WETH put in at the start of the cycle. */
  amountIn: BigNumber;
  /** "buyOnA" => buy token on A, sell on B; "buyOnB" => the reverse. */
  direction: "buyOnA" | "buyOnB";
  /** WETH profit after both swaps (gross, pre-gas/bribe). */
  profit: BigNumber;
}

const ZERO = BigNumber.from(0);

/**
 * Apply an exact-input swap of `amountIn` (the "in" token) to a pool and return
 * its post-swap reserves. Used by orderflow sources that deliver the pending tx
 * *before* execution (mempool / MEV Blocker), where we must simulate the swap's
 * effect on the pool to know the reserves a backrun would act on. (MEV-Share, by
 * contrast, leaks the post-swap Sync reserves directly.)
 */
export function applySwapToReserves(
  amountIn: BigNumber,
  reserveIn: BigNumber,
  reserveOut: BigNumber
): { reserveIn: BigNumber; reserveOut: BigNumber } {
  const out = getAmountOut(amountIn, reserveIn, reserveOut);
  return { reserveIn: reserveIn.add(amountIn), reserveOut: reserveOut.sub(out) };
}

/** WETH out from cycling `amountIn` WETH: buy token on `buy`, sell it on `sell`. */
function cycleProfit(amountIn: BigNumber, buy: Pool, sell: Pool): BigNumber {
  if (amountIn.lte(0)) return ZERO;
  // WETH -> token on `buy`
  const tokenOut = getAmountOut(amountIn, buy.reserveWeth, buy.reserveToken, buy.feeBps);
  if (tokenOut.lte(0)) return ZERO;
  // token -> WETH on `sell`
  const wethOut = getAmountOut(tokenOut, sell.reserveToken, sell.reserveWeth, sell.feeBps);
  return wethOut.sub(amountIn);
}

/** Ternary-search the unimodal profit curve for the best input in [0, hi]. */
function bestInput(
  buy: Pool,
  sell: Pool,
  hi: BigNumber
): { amountIn: BigNumber; profit: BigNumber } {
  let lo = ZERO;
  let h = hi;
  while (h.sub(lo).gt(2)) {
    const third = h.sub(lo).div(3);
    const m1 = lo.add(third);
    const m2 = h.sub(third);
    if (cycleProfit(m1, buy, sell).lt(cycleProfit(m2, buy, sell))) {
      lo = m1;
    } else {
      h = m2;
    }
  }
  let best = lo;
  let bestProfit = cycleProfit(lo, buy, sell);
  for (let c = lo.add(1); c.lte(h); c = c.add(1)) {
    const p = cycleProfit(c, buy, sell);
    if (p.gt(bestProfit)) {
      bestProfit = p;
      best = c;
    }
  }
  return { amountIn: best, profit: bestProfit };
}

/**
 * Best WETH-funded arbitrage between two pools for the same pair.
 *
 * `maxIn` caps the cycle size (an upper bound for the search; for flash-loan
 * funded backruns this is a notional/liquidity cap rather than owned capital).
 * Returns null if neither direction is profitable.
 */
export function optimalCrossPoolArb(
  poolA: Pool,
  poolB: Pool,
  maxIn: BigNumber
): ArbQuote | null {
  if (maxIn.lte(0)) return null;

  const ab = bestInput(poolA, poolB, maxIn); // buy on A, sell on B
  const ba = bestInput(poolB, poolA, maxIn); // buy on B, sell on A

  if (ab.profit.lte(0) && ba.profit.lte(0)) return null;

  if (ab.profit.gte(ba.profit)) {
    return { amountIn: ab.amountIn, direction: "buyOnA", profit: ab.profit };
  }
  return { amountIn: ba.amountIn, direction: "buyOnB", profit: ba.profit };
}

import { v3PoolReader } from "../core/v3/pool";
import { v3VirtualPool, Pool } from "./arb";

/** Common UniswapV3 fee tiers to probe for a pair. */
const FEE_TIERS = [500, 3000, 10000];

export interface ArbVenue {
  venue: string;
  pool: Pool;
}

/**
 * UniswapV3 pools for (weth, token), modelled as constant-product virtual
 * reserves so they can be compared against V2 venues in the same arb math.
 * Returns one entry per fee tier that exists and has active liquidity.
 */
export async function v3Venues(
  weth: string,
  token: string
): Promise<ArbVenue[]> {
  const wethLc = weth.toLowerCase();
  const out: ArbVenue[] = [];
  for (const fee of FEE_TIERS) {
    const state = await v3PoolReader.getState(weth, token, fee);
    if (!state || state.liquidity.lte(0) || state.sqrtPriceX96.lte(0)) continue;
    const wethIsToken0 = state.token0 === wethLc;
    out.push({
      venue: `univ3-${fee}`,
      pool: v3VirtualPool(state.sqrtPriceX96, state.liquidity, fee, wethIsToken0),
    });
  }
  return out;
}

import { BigNumber, ethers, providers } from "ethers";
import { config } from "../../config/config";
import { Logging } from "../../logging/logging";
import { V3_FACTORY_ABI, V3_POOL_ABI } from "./abi";

export interface V3PoolState {
  pool: string;
  token0: string;
  token1: string;
  fee: number;
  sqrtPriceX96: BigNumber;
  tick: number;
  liquidity: BigNumber;
}

/**
 * Resolves UniswapV3 pools and reads their current state (price + liquidity).
 *
 * This is the input a stateful sizer (tick math or eth_callBundle simulation)
 * needs to size a V3 sandwich. Detection + this reader are the correct
 * foundation; composing the front/victim/back legs is a follow-up because the
 * on-chain Quoter only quotes against live state and can't model our frontrun.
 */
export class V3PoolReader {
  private _provider: providers.JsonRpcProvider;
  private _factory: ethers.Contract;
  private _poolCache = new Map<string, string>();

  constructor(rpcUrl: string = config.RPC_URL) {
    this._provider = new providers.JsonRpcProvider(rpcUrl);
    this._factory = new ethers.Contract(
      config.UNIV3_FACTORY,
      V3_FACTORY_ABI,
      this._provider
    );
  }

  private key = (a: string, b: string, fee: number) =>
    [a.toLowerCase(), b.toLowerCase()].sort().join(":") + ":" + fee;

  async getPoolAddress(
    tokenA: string,
    tokenB: string,
    fee: number
  ): Promise<string | null> {
    const k = this.key(tokenA, tokenB, fee);
    const cached = this._poolCache.get(k);
    if (cached) return cached;
    const pool: string = await this._factory.getPool(tokenA, tokenB, fee);
    if (!pool || pool === ethers.constants.AddressZero) return null;
    this._poolCache.set(k, pool);
    return pool;
  }

  async getState(
    tokenA: string,
    tokenB: string,
    fee: number
  ): Promise<V3PoolState | null> {
    const pool = await this.getPoolAddress(tokenA, tokenB, fee);
    if (!pool) return null;
    try {
      const contract = new ethers.Contract(pool, V3_POOL_ABI, this._provider);
      const [slot0, liquidity, token0, token1] = await Promise.all([
        contract.slot0(),
        contract.liquidity(),
        contract.token0(),
        contract.token1(),
      ]);
      return {
        pool,
        token0: (token0 as string).toLowerCase(),
        token1: (token1 as string).toLowerCase(),
        fee,
        sqrtPriceX96: slot0.sqrtPriceX96,
        tick: Number(slot0.tick),
        liquidity,
      };
    } catch (error) {
      Logging.logError(error);
      return null;
    }
  }
}

export const v3PoolReader = new V3PoolReader();

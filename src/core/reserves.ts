import { BigNumber, ethers, providers } from "ethers";
import { config } from "../config/config";
import { UniswapV2PairABI } from "../abi";

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

export interface PairReserves {
  pair: string;
  token0: string;
  token1: string;
  reserve0: BigNumber;
  reserve1: BigNumber;
  /** Reserve of `tokenIn` and `tokenOut` for convenience, oriented to a query. */
  reserveIn: BigNumber;
  reserveOut: BigNumber;
}

/**
 * Resolves UniswapV2 pair addresses and fetches reserves, with a short cache so
 * we don't re-query the same pool on every pending tx. Reserves are cached for
 * `ttlMs` — long enough to avoid hammering the node, short enough that we act on
 * fresh state. (P2 will replace polling with `Sync`-event subscriptions.)
 */
export class ReserveManager {
  private _provider: providers.JsonRpcProvider;
  private _factory: ethers.Contract;
  private _pairCache = new Map<string, string>();
  private _reserveCache = new Map<
    string,
    { token0: string; reserve0: BigNumber; reserve1: BigNumber; at: number }
  >();
  private _ttlMs: number;

  constructor(rpcUrl: string = config.RPC_URL, ttlMs = 2_000) {
    this._provider = new providers.JsonRpcProvider(rpcUrl);
    this._factory = new ethers.Contract(
      config.UNIV2_FACTORY,
      FACTORY_ABI,
      this._provider
    );
    this._ttlMs = ttlMs;
  }

  private pairKey = (a: string, b: string) =>
    [a.toLowerCase(), b.toLowerCase()].sort().join(":");

  /** Resolve (and cache) the pair address for two tokens. */
  async getPairAddress(tokenA: string, tokenB: string): Promise<string | null> {
    const key = this.pairKey(tokenA, tokenB);
    const cached = this._pairCache.get(key);
    if (cached) return cached;

    const pair: string = await this._factory.getPair(tokenA, tokenB);
    if (!pair || pair === ethers.constants.AddressZero) return null;

    this._pairCache.set(key, pair);
    return pair;
  }

  /**
   * Fetch reserves for the pool that trades `tokenIn`/`tokenOut`, oriented so
   * `reserveIn` corresponds to `tokenIn`. Returns null if the pool doesn't exist.
   */
  async getReserves(
    tokenIn: string,
    tokenOut: string
  ): Promise<PairReserves | null> {
    const pair = await this.getPairAddress(tokenIn, tokenOut);
    if (!pair) return null;

    let entry = this._reserveCache.get(pair);
    const now = Date.now();
    if (!entry || now - entry.at > this._ttlMs) {
      const contract = new ethers.Contract(
        pair,
        UniswapV2PairABI,
        this._provider
      );
      const [reserves, token0] = await Promise.all([
        contract.getReserves(),
        contract.token0(),
      ]);
      entry = {
        token0: (token0 as string).toLowerCase(),
        reserve0: reserves[0],
        reserve1: reserves[1],
        at: now,
      };
      this._reserveCache.set(pair, entry);
    }

    const token1 =
      entry.token0 === tokenIn.toLowerCase()
        ? tokenOut.toLowerCase()
        : tokenIn.toLowerCase();
    const inIsToken0 = entry.token0 === tokenIn.toLowerCase();

    return {
      pair,
      token0: entry.token0,
      token1,
      reserve0: entry.reserve0,
      reserve1: entry.reserve1,
      reserveIn: inIsToken0 ? entry.reserve0 : entry.reserve1,
      reserveOut: inIsToken0 ? entry.reserve1 : entry.reserve0,
    };
  }
}

export const reserveManager = new ReserveManager();

import { BigNumber, ethers, providers } from "ethers";
import { config } from "../config/config";
import { UniswapV2PairABI } from "../abi";

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

export interface VenueReserves {
  venue: string;
  pool: string;
  reserveWeth: BigNumber;
  reserveToken: BigNumber;
}

/**
 * Reads the same token pair across several UniswapV2-compatible venues so the
 * backrun validator can spot cross-venue price gaps. Pair addresses and pool
 * token ordering are cached; reserves are read fresh (the validator acts on a
 * just-emitted swap, so staleness must be low).
 */
export class MultiVenueV2 {
  private _provider: providers.JsonRpcProvider;
  private _factories: { name: string; contract: ethers.Contract }[];
  private _pairCache = new Map<string, string | null>();
  private _tokenCache = new Map<string, { token0: string; token1: string }>();

  constructor(
    rpcUrl: string = config.RPC_URL,
    venues: { name: string; factory: string }[] = config.V2_VENUES
  ) {
    this._provider = new providers.JsonRpcProvider(rpcUrl);
    this._factories = venues.map((v) => ({
      name: v.name,
      contract: new ethers.Contract(v.factory, FACTORY_ABI, this._provider),
    }));
  }

  /** token0/token1 of a pool (cached). */
  async poolTokens(pool: string): Promise<{ token0: string; token1: string }> {
    const key = pool.toLowerCase();
    const cached = this._tokenCache.get(key);
    if (cached) return cached;
    const c = new ethers.Contract(pool, UniswapV2PairABI, this._provider);
    const [token0, token1] = await Promise.all([c.token0(), c.token1()]);
    const entry = {
      token0: (token0 as string).toLowerCase(),
      token1: (token1 as string).toLowerCase(),
    };
    this._tokenCache.set(key, entry);
    return entry;
  }

  private async pairAddress(
    venue: ethers.Contract,
    a: string,
    b: string
  ): Promise<string | null> {
    const key = venue.address + ":" + [a, b].sort().join(":");
    if (this._pairCache.has(key)) return this._pairCache.get(key)!;
    const pair: string = await venue.getPair(a, b);
    const resolved =
      !pair || pair === ethers.constants.AddressZero ? null : pair;
    this._pairCache.set(key, resolved);
    return resolved;
  }

  /** Reserves of (weth, token) on every venue that lists the pair. */
  async reservesAcrossVenues(
    weth: string,
    token: string
  ): Promise<VenueReserves[]> {
    const out: VenueReserves[] = [];
    for (const f of this._factories) {
      const pool = await this.pairAddress(f.contract, weth, token);
      if (!pool) continue;
      try {
        const c = new ethers.Contract(pool, UniswapV2PairABI, this._provider);
        const [reserves, token0] = await Promise.all([
          c.getReserves(),
          c.token0(),
        ]);
        const wethIsToken0 = (token0 as string).toLowerCase() === weth.toLowerCase();
        out.push({
          venue: f.name,
          pool: pool.toLowerCase(),
          reserveWeth: wethIsToken0 ? reserves[0] : reserves[1],
          reserveToken: wethIsToken0 ? reserves[1] : reserves[0],
        });
      } catch {
        // skip unreadable pool
      }
    }
    return out;
  }
}

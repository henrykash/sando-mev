import { BigNumber, ethers, providers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
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

interface PairState {
  token0: string;
  reserve0: BigNumber;
  reserve1: BigNumber;
  /** Last time this state was refreshed (event or fetch), ms. */
  at: number;
  /** A live Sync subscription is keeping this state fresh. */
  subscribed: boolean;
}

/**
 * Resolves UniswapV2 pair addresses and serves reserves.
 *
 * Two modes:
 *  - **Subscription** (default, when a WSS url is available): on first access to
 *    a pair we fetch its state once, then subscribe to its `Sync` events and
 *    update the cache the moment reserves change — no per-tx RPC round-trip and
 *    state that is fresh to the latest block. Subscriptions are LRU-capped.
 *  - **Polling fallback**: if no WSS url, reserves are fetched on demand and
 *    cached for `ttlMs`.
 *
 * Even when subscribed we re-fetch if the state is older than `maxStaleMs`, as a
 * guard against a missed/dropped event.
 */
export class ReserveManager {
  private _provider: providers.JsonRpcProvider;
  private _wssUrl?: string;
  private _wsProvider?: providers.WebSocketProvider;
  private _factory: ethers.Contract;
  private _pairCache = new Map<string, string>();
  private _state = new Map<string, PairState>();
  private _listeners = new Map<string, ethers.Contract>();
  private _subOrder: string[] = []; // LRU order of subscribed pairs
  private _ttlMs: number;
  private _maxStaleMs: number;
  private _maxSubscriptions: number;

  constructor(
    rpcUrl: string = config.RPC_URL,
    wssUrl: string | undefined = config.WSS_URL,
    opts: { ttlMs?: number; maxStaleMs?: number; maxSubscriptions?: number } = {}
  ) {
    this._provider = new providers.JsonRpcProvider(rpcUrl);
    this._wssUrl = wssUrl;
    this._factory = new ethers.Contract(
      config.UNIV2_FACTORY,
      FACTORY_ABI,
      this._provider
    );
    this._ttlMs = opts.ttlMs ?? 2_000;
    this._maxStaleMs = opts.maxStaleMs ?? 60_000;
    this._maxSubscriptions = opts.maxSubscriptions ?? 256;
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
   * Fetch reserves for the pool trading `tokenIn`/`tokenOut`, oriented so
   * `reserveIn` corresponds to `tokenIn`. Returns null if the pool doesn't exist.
   */
  async getReserves(
    tokenIn: string,
    tokenOut: string
  ): Promise<PairReserves | null> {
    const pair = await this.getPairAddress(tokenIn, tokenOut);
    if (!pair) return null;

    const entry = await this.ensureFresh(pair);
    if (!entry) return null;

    const inIsToken0 = entry.token0 === tokenIn.toLowerCase();
    const token1 = inIsToken0 ? tokenOut.toLowerCase() : tokenIn.toLowerCase();

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

  /** Ensure we have fresh state for a pair, fetching/subscribing as needed. */
  private async ensureFresh(pair: string): Promise<PairState | null> {
    const now = Date.now();
    const entry = this._state.get(pair);

    if (entry) {
      // Subscribed and recently updated, or within polling TTL: use as-is.
      const maxAge = entry.subscribed ? this._maxStaleMs : this._ttlMs;
      if (now - entry.at <= maxAge) {
        if (entry.subscribed) this.touch(pair);
        return entry;
      }
    }

    const fetched = await this.fetchState(pair);
    if (!fetched) return null;

    if (this._wssUrl) {
      this.subscribe(pair, fetched);
    }
    this._state.set(pair, fetched);
    return fetched;
  }

  /** One-shot read of a pair's token0 + reserves. */
  private async fetchState(pair: string): Promise<PairState | null> {
    try {
      const contract = new ethers.Contract(
        pair,
        UniswapV2PairABI,
        this._provider
      );
      const [reserves, token0] = await Promise.all([
        contract.getReserves(),
        contract.token0(),
      ]);
      return {
        token0: (token0 as string).toLowerCase(),
        reserve0: reserves[0],
        reserve1: reserves[1],
        at: Date.now(),
        subscribed: false,
      };
    } catch (error) {
      Logging.logError(error);
      return null;
    }
  }

  private ensureWs(): providers.WebSocketProvider {
    if (!this._wsProvider) {
      this._wsProvider = new providers.WebSocketProvider(this._wssUrl!);
    }
    return this._wsProvider;
  }

  /** Subscribe to a pair's Sync events to keep reserves live. LRU-capped. */
  private subscribe(pair: string, state: PairState) {
    if (this._listeners.has(pair)) {
      this.touch(pair);
      return;
    }
    const ws = this.ensureWs();
    const contract = new ethers.Contract(pair, UniswapV2PairABI, ws);
    contract.on("Sync", (reserve0: BigNumber, reserve1: BigNumber) => {
      const s = this._state.get(pair);
      if (s) {
        s.reserve0 = reserve0;
        s.reserve1 = reserve1;
        s.at = Date.now();
      }
    });
    this._listeners.set(pair, contract);
    state.subscribed = true;
    this._subOrder.push(pair);
    this.evictIfNeeded();
  }

  /** Mark a pair as most-recently-used for LRU eviction. */
  private touch(pair: string) {
    const i = this._subOrder.indexOf(pair);
    if (i >= 0) this._subOrder.splice(i, 1);
    this._subOrder.push(pair);
  }

  /** Drop the least-recently-used subscription(s) once over the cap. */
  private evictIfNeeded() {
    while (this._subOrder.length > this._maxSubscriptions) {
      const victim = this._subOrder.shift();
      if (!victim) break;
      const contract = this._listeners.get(victim);
      if (contract) contract.removeAllListeners("Sync");
      this._listeners.delete(victim);
      const s = this._state.get(victim);
      if (s) s.subscribed = false; // will fall back to polling on next access
    }
  }
}

export const reserveManager = new ReserveManager();

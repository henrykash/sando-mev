import { BigNumber, ethers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { MevShareStream } from "./client";
import { parseHint, HintEvent, SyncHint } from "./hints";
import { MultiVenueV2 } from "./venues";
import { optimalCrossPoolArb, Pool } from "./arb";
import { telegram } from "../notify/telegram";
import { formatBackrunAlert } from "../notify/format";

/**
 * Listen-only MEV-Share backrun edge validator (Phase A of the pivot — see
 * docs/MEV_SHARE_RESEARCH.md).
 *
 * It subscribes to the MEV-Share hint stream and, whenever a hint leaks a
 * UniswapV2 `Sync` (post-swap reserves for a pool), it looks up the same pair on
 * the other configured venues and estimates the cross-venue backrun arbitrage
 * with our existing pool math. It NEVER submits anything — its only job is to
 * measure whether real backrun edge reaches us before we build the live path.
 */
export class BackrunValidator {
  private _venues: MultiVenueV2;
  private _stream: MevShareStream;
  private _weth = config.WETH.toLowerCase();

  // Running tally so a session prints a simple edge summary.
  private _hints = 0;
  private _syncs = 0;
  private _candidates = 0;
  private _bestProfit = BigNumber.from(0);

  constructor() {
    this._venues = new MultiVenueV2();
    this._stream = new MevShareStream(config.MEVSHARE_STREAM_URL, (e) =>
      this.onEvent(e)
    );
  }

  start() {
    Logging.logInfo(
      `MEV-Share backrun validator (listen-only) -> ${config.MEVSHARE_STREAM_URL}`
    );
    this._stream.start();
  }

  private onEvent = async (event: HintEvent) => {
    this._hints++;
    const parsed = parseHint(event);
    for (const sync of parsed.syncs) {
      this._syncs++;
      try {
        await this.evaluateSync(sync, parsed.hash);
      } catch (error) {
        Logging.logError(error);
      }
    }
  };

  private async evaluateSync(sync: SyncHint, hash: string) {
    // Identify the pair behind the leaked pool and orient to WETH.
    const { token0, token1 } = await this._venues.poolTokens(sync.pool);
    let token: string;
    let poolFromHint: Pool;
    if (token0 === this._weth) {
      token = token1;
      poolFromHint = { reserveWeth: sync.reserve0, reserveToken: sync.reserve1 };
    } else if (token1 === this._weth) {
      token = token0;
      poolFromHint = { reserveWeth: sync.reserve1, reserveToken: sync.reserve0 };
    } else {
      return; // not a WETH pair (out of scope for this first cut)
    }

    // Same pair across venues; use the fresh hint reserves for the leaked pool.
    const venues = await this._venues.reservesAcrossVenues(this._weth, token);
    const pools: Pool[] = venues.map((v) =>
      v.pool === sync.pool
        ? poolFromHint
        : { reserveWeth: v.reserveWeth, reserveToken: v.reserveToken }
    );
    if (!venues.some((v) => v.pool === sync.pool)) pools.push(poolFromHint);
    if (pools.length < 2) return; // need two venues to arb

    // Evaluate every venue pairing; keep the best.
    let best = null as ReturnType<typeof optimalCrossPoolArb>;
    for (let i = 0; i < pools.length; i++) {
      for (let j = i + 1; j < pools.length; j++) {
        const q = optimalCrossPoolArb(pools[i], pools[j], config.ARB_MAX_IN_WEI);
        if (q && (!best || q.profit.gt(best.profit))) best = q;
      }
    }

    if (!best || best.profit.lt(config.ARB_MIN_PROFIT_WEI)) return;

    this._candidates++;
    if (best.profit.gt(this._bestProfit)) this._bestProfit = best.profit;

    Logging.logSuccess(`backrun arb candidate (${hash})`);
    console.log({
      token,
      venues: venues.map((v) => v.venue),
      amountInWeth: ethers.utils.formatEther(best.amountIn),
      grossProfitWeth: ethers.utils.formatEther(best.profit),
      sessionTotals: {
        hints: this._hints,
        syncs: this._syncs,
        candidates: this._candidates,
        bestProfitWeth: ethers.utils.formatEther(this._bestProfit),
      },
    });

    await telegram.notify(
      formatBackrunAlert({
        hash,
        token,
        venues: venues.map((v) => v.venue),
        quote: best,
      })
    );
  }
}

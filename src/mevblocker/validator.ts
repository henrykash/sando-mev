import { BigNumber, ethers } from "ethers";
import { config } from "../config/config";
import { Logging } from "../logging/logging";
import { UniswapV2RouterABI } from "../abi";
import { HelpersWrapper, SANDWICHABLE_METHODS } from "../utils";
import { MultiVenueV2 } from "../mevshare/venues";
import { applySwapToReserves, optimalCrossPoolArb, Pool } from "../mevshare/arb";
import { v3Venues } from "../mevshare/v3venues";
import { MevBlockerStream, PartialPendingTx } from "./client";
import { telegram } from "../notify/telegram";
import { formatBackrunAlert } from "../notify/format";

/**
 * Listen-only MEV Blocker backrun edge validator.
 *
 * MEV Blocker streams the (private) pending swaps that have left the public
 * mempool. For each WETH-funded V2 swap we recognise, we simulate its effect on
 * the pool it hits, then look for a profitable cross-venue backrun with our
 * existing arb math. It NEVER submits a bundle — it measures whether real
 * backrun edge reaches us before we build the executor. (See
 * docs/MEV_SHARE_RESEARCH.md.)
 *
 * First cut: WETH-input, direct 2-hop swaps on a known V2 router.
 */
export class MevBlockerBackrunValidator {
  private _venues = new MultiVenueV2();
  private _router = new ethers.utils.Interface(UniswapV2RouterABI);
  private _factories: Map<string, string>; // router -> factory
  private _venueByFactory: Map<string, string>; // factory -> venue name
  private _weth = config.WETH.toLowerCase();
  private _stream: MevBlockerStream;

  private _seen = 0;
  private _candidates = 0;
  private _bestProfit = BigNumber.from(0);

  constructor() {
    this._factories = new Map(
      config.V2_ROUTER_FACTORIES.map((r) => [
        r.router.toLowerCase(),
        r.factory.toLowerCase(),
      ])
    );
    this._venueByFactory = new Map(
      config.V2_VENUES.map((v) => [v.factory.toLowerCase(), v.name])
    );
    this._stream = new MevBlockerStream(config.MEVBLOCKER_WS_URL, (tx) =>
      this.onTx(tx)
    );
  }

  start() {
    Logging.logInfo(
      `MEV Blocker backrun validator (listen-only) -> ${config.MEVBLOCKER_WS_URL}`
    );
    this._stream.start();
  }

  private onTx = async (tx: PartialPendingTx) => {
    this._seen++;
    try {
      await this.evaluate(tx);
    } catch (error) {
      Logging.logError(error);
    }
  };

  private async evaluate(tx: PartialPendingTx) {
    const to = (tx.to ?? "").toLowerCase();
    const factory = this._factories.get(to);
    if (!factory) return; // not a known V2 router

    const data = tx.input ?? tx.data;
    if (!data) return;

    let parsed: ethers.utils.TransactionDescription;
    try {
      parsed = this._router.parseTransaction({ data });
    } catch {
      return;
    }
    if (!SANDWICHABLE_METHODS.has(parsed.name)) return;

    const swap = HelpersWrapper.extractSwapDetails(
      parsed,
      BigNumber.from(tx.value ?? 0)
    );
    if (
      !swap ||
      swap.kind !== "exactIn" ||
      swap.amountIn == null ||
      swap.path.length !== 2
    ) {
      return;
    }

    const tokenIn = swap.path[0].toLowerCase();
    const tokenOut = swap.path[1].toLowerCase();
    if (tokenIn !== this._weth) return; // WETH-input only (first cut)

    const venues = await this._venues.reservesAcrossVenues(this._weth, tokenOut);
    if (venues.length < 2) return; // need at least two venues to arb

    const hitVenue = this._venueByFactory.get(factory);
    const hit = venues.find((v) => v.venue === hitVenue);
    if (!hit) return; // can't locate the pool the swap hits

    // Simulate the victim's WETH-in swap on the hit pool.
    const post = applySwapToReserves(
      swap.amountIn,
      hit.reserveWeth,
      hit.reserveToken
    );
    const hitPool: Pool = {
      reserveWeth: post.reserveIn,
      reserveToken: post.reserveOut,
    };

    // Counterparties: the other V2 venues plus any UniswapV3 pools (modelled as
    // virtual constant-product reserves). The V3 pools are at live state — they
    // aren't touched by the victim's V2 swap — so they're valid arb targets.
    const counterparties: { venue: string; pool: Pool }[] = [
      ...venues
        .filter((v) => v.venue !== hitVenue)
        .map((v) => ({
          venue: v.venue,
          pool: { reserveWeth: v.reserveWeth, reserveToken: v.reserveToken },
        })),
      ...(await v3Venues(this._weth, tokenOut)),
    ];

    let best: ReturnType<typeof optimalCrossPoolArb> = null;
    let bestVenue = "";
    for (const cp of counterparties) {
      const q = optimalCrossPoolArb(hitPool, cp.pool, config.ARB_MAX_IN_WEI);
      if (q && (!best || q.profit.gt(best.profit))) {
        best = q;
        bestVenue = cp.venue;
      }
    }

    if (!best || best.profit.lt(config.ARB_MIN_PROFIT_WEI)) return;

    this._candidates++;
    if (best.profit.gt(this._bestProfit)) this._bestProfit = best.profit;

    Logging.logSuccess(`mev-blocker backrun candidate (${tx.hash ?? "?"})`);
    console.log({
      token: tokenOut,
      venues: [hitVenue, bestVenue],
      amountInWeth: ethers.utils.formatEther(best.amountIn),
      grossProfitWeth: ethers.utils.formatEther(best.profit),
      sessionTotals: {
        seen: this._seen,
        candidates: this._candidates,
        bestProfitWeth: ethers.utils.formatEther(this._bestProfit),
      },
    });

    await telegram.notify(
      formatBackrunAlert({
        hash: tx.hash ?? "",
        token: tokenOut,
        venues: [hitVenue ?? "?", bestVenue],
        quote: best,
      })
    );
  }
}

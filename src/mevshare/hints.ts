import { BigNumber, ethers } from "ethers";
import { UniswapV2PairABI } from "../abi";

/**
 * Parse a MEV-Share hint event into the bits useful for backrun estimation.
 *
 * Hint events only carry what the user chose to share. The most actionable hint
 * for us is a `Sync` log from a UniswapV2 pair: it leaks the pool address and its
 * *post-swap* reserves directly, which is exactly the state we need to price a
 * cross-venue backrun. We also surface touched `to`/selector for routing.
 *
 * Event shape (Flashbots mev-share specs/events/v0.1):
 *   { hash, logs?: {address,topics,data}[], txs?: {to?,functionSelector?,callData?}[] }
 */
export interface HintLog {
  address: string;
  topics: string[];
  data: string;
}
export interface HintEvent {
  hash: string;
  logs?: HintLog[];
  txs?: { to?: string; functionSelector?: string; callData?: string }[];
}

export interface SyncHint {
  /** The pair contract that emitted Sync. */
  pool: string;
  reserve0: BigNumber;
  reserve1: BigNumber;
}

export interface ParsedHint {
  hash: string;
  touched: { to?: string; functionSelector?: string }[];
  /** Decoded UniswapV2 Sync logs (post-swap reserves), if shared. */
  syncs: SyncHint[];
}

const PAIR_IFACE = new ethers.utils.Interface(UniswapV2PairABI);

export function parseHint(event: HintEvent): ParsedHint {
  const touched = (event.txs ?? []).map((t) => ({
    to: t.to?.toLowerCase(),
    functionSelector: t.functionSelector,
  }));

  const syncs: SyncHint[] = [];
  for (const log of event.logs ?? []) {
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = PAIR_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue; // not a pair event we recognise
    }
    if (parsed.name === "Sync") {
      syncs.push({
        pool: log.address.toLowerCase(),
        reserve0: parsed.args.reserve0,
        reserve1: parsed.args.reserve1,
      });
    }
  }

  return { hash: event.hash, touched, syncs };
}

import { BigNumber, ethers } from "ethers";
import { SWAP_ROUTER_V1_ABI, SWAP_ROUTER_V2_ABI } from "./abi";

export type V3RouterVersion = "v1" | "v2";

const IFACE: Record<V3RouterVersion, ethers.utils.Interface> = {
  v1: new ethers.utils.Interface(SWAP_ROUTER_V1_ABI),
  v2: new ethers.utils.Interface(SWAP_ROUTER_V2_ABI),
};

/** Normalised view of a UniswapV3 victim swap (exact-input only, for now). */
export interface V3SwapDetails {
  method: string;
  /** First-hop input token (the side we'd spend, e.g. WETH). */
  tokenIn: string;
  /** First-hop output token. */
  tokenOut: string;
  /** Pool fee tier of the first hop (e.g. 500, 3000, 10000). */
  fee: number;
  amountIn: BigNumber;
  /** Victim's minimum final output (slippage limit). */
  amountOutMinimum: BigNumber;
  recipient: string;
  /** True if this came from a multi-hop `exactInput` (min-out is on the final hop). */
  multiHop: boolean;
}

/**
 * V3 swap paths are tightly packed bytes: token(20) | fee(3) | token(20) | ...
 * Returns the first hop's [tokenIn, fee, tokenOut].
 */
export function decodeV3Path(
  path: string
): { tokenIn: string; fee: number; tokenOut: string } | null {
  const hex = path.startsWith("0x") ? path.slice(2) : path;
  // Need at least token(20) + fee(3) + token(20) = 43 bytes = 86 hex chars.
  if (hex.length < 86) return null;
  const tokenIn = "0x" + hex.slice(0, 40);
  const fee = parseInt(hex.slice(40, 46), 16);
  const tokenOut = "0x" + hex.slice(46, 86);
  return { tokenIn: tokenIn.toLowerCase(), fee, tokenOut: tokenOut.toLowerCase() };
}

/** Decode one inner (non-multicall) call into a V3 swap, if it is one. */
function decodeInner(
  iface: ethers.utils.Interface,
  data: string
): V3SwapDetails | null {
  let parsed: ethers.utils.TransactionDescription;
  try {
    parsed = iface.parseTransaction({ data });
  } catch {
    return null;
  }
  const p = parsed.args.params;

  if (parsed.name === "exactInputSingle") {
    return {
      method: parsed.name,
      tokenIn: (p.tokenIn as string).toLowerCase(),
      tokenOut: (p.tokenOut as string).toLowerCase(),
      fee: Number(p.fee),
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      recipient: p.recipient,
      multiHop: false,
    };
  }

  if (parsed.name === "exactInput") {
    const hop = decodeV3Path(p.path);
    if (!hop) return null;
    return {
      method: parsed.name,
      tokenIn: hop.tokenIn,
      tokenOut: hop.tokenOut,
      fee: hop.fee,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      recipient: p.recipient,
      multiHop: true,
    };
  }

  // exactOutput* and others are recognised but not sandwiched here.
  return null;
}

/**
 * Decode a UniswapV3 router transaction into a normalised swap. Handles both
 * router generations and unwraps `multicall(...)`, returning the first
 * exact-input swap found.
 */
export function decodeV3Swap(
  data: string,
  version: V3RouterVersion
): V3SwapDetails | null {
  const iface = IFACE[version];

  // Direct (non-multicall) call?
  const direct = decodeInner(iface, data);
  if (direct) return direct;

  // multicall: try each known overload, then decode each inner call.
  for (const fn of ["multicall(bytes[])", "multicall(uint256,bytes[])", "multicall(bytes32,bytes[])"]) {
    let decoded: ethers.utils.Result;
    try {
      decoded = iface.decodeFunctionData(fn, data);
    } catch {
      continue;
    }
    const calls: string[] = decoded.data;
    for (const call of calls) {
      const inner = decodeInner(iface, call);
      if (inner) return inner;
    }
    return null; // it was a multicall, just nothing sandwichable inside
  }

  return null;
}

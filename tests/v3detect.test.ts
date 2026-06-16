import assert from "assert";
import { ethers } from "ethers";
import { decodeV3Swap, decodeV3Path } from "../src/core/v3/detect";
import {
  SWAP_ROUTER_V1_ABI,
  SWAP_ROUTER_V2_ABI,
} from "../src/core/v3/abi";
import { test } from "./harness";

const v1 = new ethers.utils.Interface(SWAP_ROUTER_V1_ABI);
const v2 = new ethers.utils.Interface(SWAP_ROUTER_V2_ABI);
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const REC = "0x" + "cc".repeat(20);

test("decodeV3Swap: SwapRouter02 exactInputSingle", () => {
  const data = v2.encodeFunctionData("exactInputSingle", [
    { tokenIn: A, tokenOut: B, fee: 3000, recipient: REC, amountIn: 1000, amountOutMinimum: 900, sqrtPriceLimitX96: 0 },
  ]);
  const s = decodeV3Swap(data, "v2")!;
  assert.ok(s, "expected decode");
  assert.strictEqual(s.method, "exactInputSingle");
  assert.strictEqual(s.tokenIn, A.toLowerCase());
  assert.strictEqual(s.tokenOut, B.toLowerCase());
  assert.strictEqual(s.fee, 3000);
  assert.strictEqual(s.amountIn.toString(), "1000");
  assert.strictEqual(s.amountOutMinimum.toString(), "900");
  assert.strictEqual(s.multiHop, false);
});

test("decodeV3Swap: original SwapRouter exactInputSingle (with deadline)", () => {
  const data = v1.encodeFunctionData("exactInputSingle", [
    { tokenIn: A, tokenOut: B, fee: 500, recipient: REC, deadline: 9999999999, amountIn: 5, amountOutMinimum: 4, sqrtPriceLimitX96: 0 },
  ]);
  const s = decodeV3Swap(data, "v1")!;
  assert.strictEqual(s.fee, 500);
  assert.strictEqual(s.amountIn.toString(), "5");
});

test("decodeV3Swap: unwraps multicall to find exactInputSingle", () => {
  const inner = v2.encodeFunctionData("exactInputSingle", [
    { tokenIn: A, tokenOut: B, fee: 10000, recipient: REC, amountIn: 7, amountOutMinimum: 6, sqrtPriceLimitX96: 0 },
  ]);
  const data = v2.encodeFunctionData("multicall(bytes[])", [[inner]]);
  const s = decodeV3Swap(data, "v2")!;
  assert.ok(s, "expected decode from multicall");
  assert.strictEqual(s.fee, 10000);
  assert.strictEqual(s.amountIn.toString(), "7");
});

test("decodeV3Swap: exactInput multi-hop takes the first hop", () => {
  // path = A | 3000 | B | 500 | C
  const C = "0x" + "dd".repeat(20);
  const path = ethers.utils.solidityPack(
    ["address", "uint24", "address", "uint24", "address"],
    [A, 3000, B, 500, C]
  );
  const data = v2.encodeFunctionData("exactInput", [
    { path, recipient: REC, amountIn: 100, amountOutMinimum: 80 },
  ]);
  const s = decodeV3Swap(data, "v2")!;
  assert.strictEqual(s.method, "exactInput");
  assert.strictEqual(s.tokenIn, A.toLowerCase());
  assert.strictEqual(s.tokenOut, B.toLowerCase());
  assert.strictEqual(s.fee, 3000);
  assert.strictEqual(s.multiHop, true);
});

test("decodeV3Swap: exactOutputSingle is not sandwiched (returns null)", () => {
  const data = v2.encodeFunctionData("exactOutputSingle", [
    { tokenIn: A, tokenOut: B, fee: 3000, recipient: REC, amountOut: 1000, amountInMaximum: 2000, sqrtPriceLimitX96: 0 },
  ]);
  assert.strictEqual(decodeV3Swap(data, "v2"), null);
});

test("decodeV3Path: parses first hop", () => {
  const path = ethers.utils.solidityPack(
    ["address", "uint24", "address"],
    [A, 3000, B]
  );
  const hop = decodeV3Path(path)!;
  assert.strictEqual(hop.tokenIn, A.toLowerCase());
  assert.strictEqual(hop.tokenOut, B.toLowerCase());
  assert.strictEqual(hop.fee, 3000);
});

test("decodeV3Path: rejects too-short path", () => {
  assert.strictEqual(decodeV3Path("0x1234"), null);
});

import assert from "assert";
import { ethers, BigNumberish } from "ethers";
import { UniswapV2PairABI } from "../src/abi";
import { parseHint, HintEvent } from "../src/mevshare/hints";
import { test } from "./harness";

const iface = new ethers.utils.Interface(UniswapV2PairABI);
const POOL = "0x" + "ab".repeat(20);
const ROUTER = "0x" + "cd".repeat(20);

function syncLog(pool: string, r0: BigNumberish, r1: BigNumberish) {
  const frag = iface.getEvent("Sync");
  const { data, topics } = iface.encodeEventLog(frag, [r0, r1]);
  return { address: pool, topics, data };
}

test("parseHint: decodes a Sync log into pool + reserves", () => {
  const event: HintEvent = {
    hash: "0xdeadbeef",
    logs: [syncLog(POOL, "1000", "2000")],
    txs: [{ to: ROUTER, functionSelector: "0x38ed1739" }],
  };
  const parsed = parseHint(event);
  assert.strictEqual(parsed.hash, "0xdeadbeef");
  assert.strictEqual(parsed.syncs.length, 1);
  assert.strictEqual(parsed.syncs[0].pool, POOL.toLowerCase());
  assert.strictEqual(parsed.syncs[0].reserve0.toString(), "1000");
  assert.strictEqual(parsed.syncs[0].reserve1.toString(), "2000");
  assert.strictEqual(parsed.touched[0].to, ROUTER.toLowerCase());
  assert.strictEqual(parsed.touched[0].functionSelector, "0x38ed1739");
});

test("parseHint: no logs yields no syncs but still surfaces touched txs", () => {
  const parsed = parseHint({ hash: "0x1", txs: [{ to: ROUTER }] });
  assert.strictEqual(parsed.syncs.length, 0);
  assert.strictEqual(parsed.touched[0].to, ROUTER.toLowerCase());
});

test("parseHint: ignores logs that aren't recognised pair events", () => {
  const parsed = parseHint({
    hash: "0x2",
    logs: [{ address: POOL, topics: ["0x" + "00".repeat(32)], data: "0x" }],
  });
  assert.strictEqual(parsed.syncs.length, 0);
});

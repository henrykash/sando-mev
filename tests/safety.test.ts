import assert from "assert";
import { BigNumber } from "ethers";
import { checkOutputAgainstPrediction, checkTokenLists } from "../src/core/safety";
import { test } from "./harness";

const bn = (n: string) => BigNumber.from(n);

test("checkOutputAgainstPrediction: passes when output meets prediction", () => {
  const r = checkOutputAgainstPrediction(bn("1000"), bn("1000"), 100);
  assert.ok(r.ok, r.reason);
});

test("checkOutputAgainstPrediction: passes within tolerance", () => {
  // 1% tolerance, output 0.5% low => fine.
  const r = checkOutputAgainstPrediction(bn("10000"), bn("9950"), 100);
  assert.ok(r.ok, r.reason);
});

test("checkOutputAgainstPrediction: flags fee-on-transfer below tolerance", () => {
  // 1% tolerance, output 5% low => fee-on-transfer/honeypot.
  const r = checkOutputAgainstPrediction(bn("10000"), bn("9500"), 100);
  assert.strictEqual(r.ok, false);
});

test("checkOutputAgainstPrediction: rejects non-positive prediction", () => {
  assert.strictEqual(checkOutputAgainstPrediction(bn("0"), bn("0"), 100).ok, false);
});

test("checkTokenLists: allows arbitrary token when no lists configured", () => {
  // Default config has empty allow/deny lists.
  const r = checkTokenLists("0x1111111111111111111111111111111111111111");
  assert.ok(r.ok, r.reason);
});

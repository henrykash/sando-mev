import assert from "assert";
import { BigNumber, utils } from "ethers";
import { TelegramNotifier, TelegramPayload } from "../src/notify/telegram";
import {
  formatSandwichAlert,
  formatBackrunAlert,
  formatBacktestSummary,
  formatStartup,
  formatConnection,
  formatHeartbeat,
} from "../src/notify/format";
import { test } from "./harness";

const eth = (v: string) => utils.parseEther(v);

test("TelegramNotifier: disabled (no-op) when unconfigured", async () => {
  let called = false;
  const n = new TelegramNotifier(undefined, undefined, async () => {
    called = true;
  });
  assert.strictEqual(n.enabled, false);
  assert.strictEqual(await n.notify("hi"), false);
  assert.strictEqual(called, false);
});

test("TelegramNotifier: sends correct payload when configured", async () => {
  const sent: { token: string; payload: TelegramPayload }[] = [];
  const n = new TelegramNotifier("TOK", "123", async (token, payload) => {
    sent.push({ token, payload });
  });
  assert.strictEqual(n.enabled, true);
  assert.strictEqual(await n.notify("hello"), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].token, "TOK");
  assert.strictEqual(sent[0].payload.chat_id, "123");
  assert.strictEqual(sent[0].payload.text, "hello");
  // Plain text — no parse_mode (avoids Telegram entity-parse errors).
  assert.strictEqual(sent[0].payload.parse_mode, undefined);
});

test("formatters emit no Markdown entity characters", () => {
  // Guard against the "can't parse entities" 400: messages must be plain text.
  const samples = [
    formatStartup(true),
    formatConnection(true),
    formatConnection(false),
    formatHeartbeat({ uptimeMinutes: 1, v2Targets: 0, v3Targets: 0, profitable: 0, dryRun: true }),
  ];
  // Underscores (e.g. DRY_RUN) are fine in plain text; only the bold/code
  // markers we removed would render as literal noise.
  for (const s of samples) {
    assert.ok(!/[*`]/.test(s), `unexpected markdown char in: ${s}`);
  }
});

test("TelegramNotifier: never throws if transport rejects", async () => {
  const n = new TelegramNotifier("TOK", "123", async () => {
    throw new Error("network down");
  });
  assert.strictEqual(await n.notify("x"), false);
});

test("formatSandwichAlert: includes net profit, tokenIn, and tx hash", () => {
  const msg = formatSandwichAlert({
    hash: "0xabc",
    tokenIn: "0xwethish",
    token: "0xtoken",
    pair: "0xpair",
    quote: {
      frontrunIn: eth("1"),
      tokensBought: BigNumber.from("5"),
      victimOut: BigNumber.from("4"),
      backrunOut: eth("1.1"),
      grossProfit: eth("0.1"),
    },
    grossProfitWeth: eth("0.1"),
    decision: {
      viable: true,
      gasCost: eth("0.005"),
      bribe: eth("0.075"),
      netProfit: eth("0.02"),
    },
    dryRun: true,
  });
  assert.ok(msg.includes("Sandwich opportunity"));
  assert.ok(msg.includes("DRY_RUN"));
  assert.ok(msg.includes("0xabc"));
  assert.ok(msg.includes("0xwethish"));
  assert.ok(msg.includes("net: 0.02 WETH"));
});

test("formatBackrunAlert: includes venues and gross profit", () => {
  const msg = formatBackrunAlert({
    hash: "0xhint",
    token: "0xtoken",
    venues: ["uniswapv2", "sushiswap"],
    quote: { amountIn: eth("2"), direction: "buyOnA", profit: eth("0.03") },
  });
  assert.ok(msg.includes("Backrun arb"));
  assert.ok(msg.includes("uniswapv2 ↔ sushiswap"));
  assert.ok(msg.includes("0.03 WETH"));
});

test("formatStartup: notes DRY_RUN", () => {
  assert.ok(formatStartup(true).includes("DRY_RUN"));
  assert.ok(formatStartup(false).includes("started"));
});

test("formatConnection: distinguishes up vs down", () => {
  assert.ok(formatConnection(true).includes("connected"));
  assert.ok(formatConnection(false).includes("disconnected"));
});

test("formatHeartbeat: includes uptime and counters", () => {
  const msg = formatHeartbeat({
    uptimeMinutes: 42,
    v2Targets: 7,
    v3Targets: 99,
    profitable: 1,
    dryRun: true,
  });
  assert.ok(msg.includes("42m"));
  assert.ok(msg.includes("v2 targets: 7"));
  assert.ok(msg.includes("profitable found: 1"));
});

test("formatBacktestSummary: includes hit rate and net total", () => {
  const msg = formatBacktestSummary({
    scenarios: 10,
    feasible: 6,
    profitable: 4,
    hitRate: 0.4,
    grossProfitTotal: eth("1"),
    gasCostTotal: eth("0.02"),
    bribeTotal: eth("0.9"),
    netProfitTotal: eth("0.08"),
    bestNet: eth("0.05"),
    bestLabel: "blk:1",
  });
  assert.ok(msg.includes("Backtest complete"));
  assert.ok(msg.includes("40.0%"));
  assert.ok(msg.includes("net total: 0.08 WETH"));
});

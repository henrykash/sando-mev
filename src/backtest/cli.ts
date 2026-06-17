import * as fs from "fs";
import * as path from "path";
import { BigNumber } from "ethers";
import { runBacktest, BacktestScenario, BacktestParams } from "./engine";
import { formatReport } from "./report";
import { telegram } from "../notify/telegram";
import { formatBacktestSummary } from "../notify/format";

/**
 * Run a backtest from a JSON fixture of historical scenarios.
 *
 *   npm run backtest -- path/to/dataset.json
 *
 * All numeric fields are wei strings (the on-chain loader emits this shape).
 * See src/backtest/fixtures/sample.json for the schema.
 */
interface RawScenario {
  label?: string;
  victimIn: string;
  victimMinOut: string;
  reserveWeth: string;
  reserveToken: string;
  nextBaseFee: string;
}
interface RawDataset {
  params: {
    maxFrontrun: string;
    minMargin: string;
    frontrunGas: string;
    backrunGas: string;
  };
  scenarios: RawScenario[];
}

function load(file: string): { scenarios: BacktestScenario[]; params: BacktestParams } {
  const raw: RawDataset = JSON.parse(fs.readFileSync(file, "utf8"));
  const params: BacktestParams = {
    maxFrontrun: BigNumber.from(raw.params.maxFrontrun),
    minMargin: BigNumber.from(raw.params.minMargin),
    frontrunGas: BigNumber.from(raw.params.frontrunGas),
    backrunGas: BigNumber.from(raw.params.backrunGas),
  };
  const scenarios: BacktestScenario[] = raw.scenarios.map((s) => ({
    label: s.label,
    victimIn: BigNumber.from(s.victimIn),
    victimMinOut: BigNumber.from(s.victimMinOut),
    reserveWeth: BigNumber.from(s.reserveWeth),
    reserveToken: BigNumber.from(s.reserveToken),
    nextBaseFee: BigNumber.from(s.nextBaseFee),
  }));
  return { scenarios, params };
}

async function main() {
  const file =
    process.argv[2] ||
    path.join(__dirname, "fixtures", "sample.json");
  if (!fs.existsSync(file)) {
    console.error(`dataset not found: ${file}`);
    process.exit(1);
  }
  const { scenarios, params } = load(file);
  const report = runBacktest(scenarios, params);
  console.log(formatReport(report));
  // Push the summary to Telegram if configured (no-op otherwise).
  await telegram.notify(formatBacktestSummary(report));
}

main();

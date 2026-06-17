// Aggregate runner: imports every *.test.ts so they register against the shared
// harness, then prints a single summary and sets the exit code.
import "./setup"; // must come before any module that imports `config`
import "./poolMath.test";
import "./profit.test";
import "./safety.test";
import "./backtest.test";
import "./v3detect.test";
import "./arb.test";
import "./hints.test";
import { summary } from "./harness";

summary();

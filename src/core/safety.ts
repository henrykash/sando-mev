import { BigNumber } from "ethers";
import { config } from "../config/config";

/**
 * Token safety guards. Sandwiching fee-on-transfer, honeypot, or blacklisting
 * tokens is a common way to lose money: the sell leg can return less than the
 * constant-product math predicts, or fail outright. These checks gate a token
 * before we commit capital.
 *
 * The static list checks are pure; the dynamic check compares a *simulated*
 * output against the math prediction and is fed by the bundle simulation.
 */

export interface SafetyResult {
  ok: boolean;
  reason?: string;
}

/** Deny/allow-list gate. Deny always wins; an allow-list (if set) is required. */
export function checkTokenLists(token: string): SafetyResult {
  const t = token.toLowerCase();
  if (config.TOKEN_DENYLIST.includes(t)) {
    return { ok: false, reason: "token on denylist" };
  }
  if (config.TOKEN_ALLOWLIST.length > 0 && !config.TOKEN_ALLOWLIST.includes(t)) {
    return { ok: false, reason: "token not on allowlist" };
  }
  return { ok: true };
}

/**
 * Compare a simulated output to the constant-product prediction. If the
 * realised amount is more than `toleranceBps` below prediction, the token is
 * almost certainly taking a transfer fee (or worse) and must not be sandwiched.
 */
export function checkOutputAgainstPrediction(
  predicted: BigNumber,
  simulated: BigNumber,
  toleranceBps: number = config.FEE_TOLERANCE_BPS
): SafetyResult {
  if (predicted.lte(0)) return { ok: false, reason: "non-positive prediction" };

  // floor = predicted * (10000 - toleranceBps) / 10000
  const floor = predicted.mul(10_000 - toleranceBps).div(10_000);
  if (simulated.lt(floor)) {
    return {
      ok: false,
      reason: `simulated output ${simulated} below tolerance floor ${floor} (fee-on-transfer/honeypot)`,
    };
  }
  return { ok: true };
}

import { BackrunValidator } from "../mevshare/validator";
import { MevBlockerBackrunValidator } from "./validator";
import { Logging } from "../logging/logging";

// Entry point: `npm run mevblocker:validate`
// Runs the MEV Blocker backrun edge validator (listen-only). Optionally also
// runs the MEV-Share validator in the same process so both orderflow sources
// feed alerts (set MEVSHARE_ALSO=true).
new MevBlockerBackrunValidator().start();

if ((process.env.MEVSHARE_ALSO ?? "false").toLowerCase() === "true") {
  Logging.logInfo("also starting MEV-Share validator");
  new BackrunValidator().start();
}

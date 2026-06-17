import { BackrunValidator } from "./validator";

// Entry point: `npm run mevshare:validate`
// Listen-only — subscribes to the MEV-Share hint stream and logs estimated
// cross-venue backrun arbitrage. Submits nothing. See docs/MEV_SHARE_RESEARCH.md.
new BackrunValidator().start();

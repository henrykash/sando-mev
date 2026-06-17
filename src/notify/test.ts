import { telegram } from "./telegram";

/**
 * Send a test message to confirm Telegram is wired up.
 *   npm run telegram:test
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.
 */
(async () => {
  if (!telegram.enabled) {
    console.error(
      "Telegram not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env."
    );
    process.exit(1);
  }
  const ok = await telegram.notify("✅ *sando-mev* Telegram notifications are wired up.");
  console.log(ok ? "sent" : "failed to send");
})();

import * as https from "https";
import { config } from "../config/config";

/**
 * Discover your Telegram chat id.
 *
 *   1. Send any message to your bot in Telegram (or add it to a group and post).
 *   2. Run: `npm run telegram:chatid`
 *
 * It calls getUpdates and prints the chat id(s) seen. Put the value in
 * TELEGRAM_CHAT_ID in your .env. Requires TELEGRAM_BOT_TOKEN to be set.
 */
function main() {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not set in .env");
    process.exit(1);
  }

  https
    .get(`https://api.telegram.org/bot${token}/getUpdates`, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          console.error(
            "Unexpected non-JSON response (network policy/proxy blocking api.telegram.org?):"
          );
          console.error("  " + data.slice(0, 200));
          process.exit(1);
        }
        try {
          if (!json.ok) {
            console.error("Telegram API error:", json);
            process.exit(1);
          }
          const chats = new Map<string, string>();
          for (const u of json.result ?? []) {
            const chat = u.message?.chat ?? u.channel_post?.chat;
            if (chat) {
              const label = chat.title ?? chat.username ?? chat.first_name ?? "";
              chats.set(String(chat.id), `${chat.type} ${label}`.trim());
            }
          }
          if (chats.size === 0) {
            console.log(
              "No chats found. Message your bot first, then re-run this."
            );
            return;
          }
          console.log("Discovered chats (set TELEGRAM_CHAT_ID to one of these):");
          for (const [id, label] of chats) console.log(`  ${id}  — ${label}`);
        } catch (err) {
          console.error("Failed to parse response:", err);
          process.exit(1);
        }
      });
    })
    .on("error", (err) => {
      console.error(err);
      process.exit(1);
    });
}

main();

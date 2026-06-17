import * as https from "https";
import { config } from "../config/config";
import { Logging } from "../logging/logging";

/**
 * Telegram notifier.
 *
 * Sends alerts via the Telegram Bot API. Configuration comes from env
 * (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — never hardcode the token. The
 * transport is injectable so the formatting/enablement logic is unit-testable
 * without touching the network, and it fails soft (a notification problem must
 * never crash the bot or block execution decisions).
 */
export type SendFn = (token: string, payload: TelegramPayload) => Promise<void>;

export interface TelegramPayload {
  chat_id: string;
  text: string;
  parse_mode?: string;
  disable_web_page_preview?: boolean;
}

const httpsSend: SendFn = (token, payload) =>
  new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // Drain and resolve regardless of status; log non-2xx for visibility.
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            Logging.logWarn(`telegram sendMessage HTTP ${res.statusCode}: ${data}`);
          }
          resolve();
        });
      }
    );
    req.on("error", (err) => {
      Logging.logError(err);
      resolve();
    });
    req.write(body);
    req.end();
  });

export class TelegramNotifier {
  constructor(
    private readonly token: string | undefined = config.TELEGRAM_BOT_TOKEN,
    private readonly chatId: string | undefined = config.TELEGRAM_CHAT_ID,
    private readonly send: SendFn = httpsSend
  ) {}

  /** True only when both token and chat id are configured. */
  get enabled(): boolean {
    return !!this.token && !!this.chatId;
  }

  /**
   * Send a Markdown message. Returns true if it was dispatched, false if
   * notifications are disabled (unconfigured). Never throws.
   */
  async notify(text: string): Promise<boolean> {
    if (!this.token || !this.chatId) return false;
    try {
      // Plain text on purpose — no parse_mode. Our messages contain underscores
      // (DRY_RUN), em dashes and parentheses that break Telegram's Markdown
      // entity parser ("Bad Request: can't parse entities").
      await this.send(this.token, {
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true,
      });
      return true;
    } catch (err) {
      Logging.logError(err);
      return false;
    }
  }
}

export const telegram = new TelegramNotifier();

import * as https from "https";
import { Logging } from "../logging/logging";
import { HintEvent } from "./hints";

/**
 * Minimal, listen-only Server-Sent-Events client for the MEV-Share hint stream
 * (https://mev-share.flashbots.net). Listening is public — no auth is needed to
 * receive hints; auth only matters when you *submit* bundles, which this
 * validator never does.
 *
 * Uses Node's built-in https to avoid pulling in (and version-pinning) the
 * MEV-Share SDK for what is a one-way read. Auto-reconnects with capped backoff.
 */
export class MevShareStream {
  private _buf = "";
  private _stopped = false;
  private _delay = 1_000;
  private readonly _maxDelay = 30_000;

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: HintEvent) => void
  ) {}

  start() {
    this._stopped = false;
    this.connect();
  }

  stop() {
    this._stopped = true;
  }

  private connect() {
    const req = https.get(
      this.url,
      { headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          Logging.logError(`mev-share stream HTTP ${res.statusCode}`);
          res.resume();
          this.scheduleReconnect();
          return;
        }
        Logging.logSuccess("mev-share stream connected");
        this._delay = 1_000;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => this.onChunk(chunk));
        res.on("end", () => this.scheduleReconnect());
        res.on("error", () => this.scheduleReconnect());
      }
    );
    req.on("error", (err) => {
      Logging.logError(err);
      this.scheduleReconnect();
    });
  }

  private onChunk(chunk: string) {
    this._buf += chunk;
    let idx: number;
    // SSE events are separated by a blank line.
    while ((idx = this._buf.indexOf("\n\n")) >= 0) {
      const block = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 2);
      this.handleBlock(block);
    }
  }

  private handleBlock(block: string) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data || data === ":ping") return;
    try {
      this.onEvent(JSON.parse(data) as HintEvent);
    } catch {
      // keep-alives / non-JSON frames
    }
  }

  private scheduleReconnect() {
    if (this._stopped) return;
    const delay = this._delay;
    this._delay = Math.min(this._delay * 2, this._maxDelay);
    Logging.logWarn(`mev-share stream dropped; reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }
}

import WebSocket from "ws";
import { Logging } from "../logging/logging";

/**
 * Listen-only MEV Blocker searcher stream.
 *
 * Searchers connect to the MEV Blocker searcher websocket and
 * `eth_subscribe("mevblocker_partialPendingTransactions")` to receive unsigned
 * pending transactions (the orderflow that has left the public mempool). This
 * client only listens — it never submits `eth_sendBundle` — so no auth is
 * needed. Auto-reconnects with capped backoff.
 *
 * Ref: https://docs.mevblocker.io/how-to/searchers/bid
 */
export interface PartialPendingTx {
  hash?: string;
  to?: string;
  /** Calldata — MEV Blocker uses `input` (some feeds use `data`). */
  input?: string;
  data?: string;
  value?: string;
}

export class MevBlockerStream {
  private _ws?: WebSocket;
  private _stopped = false;
  private _delay = 1_000;
  private readonly _maxDelay = 30_000;
  private _id = 1;

  constructor(
    private readonly url: string,
    private readonly onTx: (tx: PartialPendingTx) => void
  ) {}

  start() {
    this._stopped = false;
    this.connect();
  }

  stop() {
    this._stopped = true;
    this._ws?.close();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this._ws = ws;

    ws.on("open", () => {
      this._delay = 1_000;
      Logging.logSuccess("mev-blocker stream connected");
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this._id++,
          method: "eth_subscribe",
          params: ["mevblocker_partialPendingTransactions"],
        })
      );
    });
    ws.on("message", (data: WebSocket.Data) =>
      this.onMessage(data.toString())
    );
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (err) => Logging.logError(err)); // a 'close' follows
  }

  private onMessage(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Subscription notifications: { method: "eth_subscription", params: { result } }
    if (msg?.method === "eth_subscription" && msg.params?.result) {
      this.onTx(msg.params.result as PartialPendingTx);
    }
  }

  private scheduleReconnect() {
    if (this._stopped) return;
    const delay = this._delay;
    this._delay = Math.min(this._delay * 2, this._maxDelay);
    Logging.logWarn(`mev-blocker stream dropped; reconnecting in ${delay}ms`);
    setTimeout(() => this.connect(), delay);
  }
}

import {
  RGADocument,
  type ClientMessage,
  type Operation,
  type ServerMessage,
} from "@collab-write/crdt-core";

/**
 * Owns the local CRDT replica and the WebSocket to the collab server.
 *
 * Reconnect/offline strategy: there is deliberately no outbox. Ops created
 * while disconnected accumulate in the replica's history; on (re)connect the
 * join/sync vector exchange sends exactly the diff each side is missing.
 * Idempotent apply makes any accidental double-delivery harmless.
 */
export class CollabSession {
  readonly doc: RGADocument;
  /** Called after remote ops are applied — the editor rerenders from doc. */
  onRemoteChange: (() => void) | null = null;
  onStatus: ((connected: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private disposed = false;

  constructor(
    private url: string,
    private docId: string,
    clientId: string,
  ) {
    this.doc = new RGADocument(clientId);
  }

  connect(): void {
    if (this.disposed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: "join", docId: this.docId, vector: this.doc.versionVector() });
      this.onStatus?.(true);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMessage;
      if (msg.type === "sync") {
        for (const op of msg.ops) this.doc.apply(op);
        // Push back whatever the server is missing (our offline edits).
        for (const op of this.doc.opsSince(msg.vector)) this.send({ type: "op", op });
      } else {
        this.doc.apply(msg.op);
      }
      this.onRemoteChange?.();
    };

    ws.onclose = () => {
      this.onStatus?.(false);
      if (!this.disposed) setTimeout(() => this.connect(), 1000);
    };
  }

  /** Broadcast an op already applied locally (by localInsert/localDelete). */
  sendLocal(op: Operation): void {
    this.send({ type: "op", op });
  }

  dispose(): void {
    this.disposed = true;
    this.ws?.close();
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // If the socket is down, do nothing: the op is in doc history and the
    // next sync exchange will deliver it.
  }
}

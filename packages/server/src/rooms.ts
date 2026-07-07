import { WebSocket } from "ws";
import {
  RGADocument,
  type Operation,
  type PeerPresence,
  type ServerMessage,
} from "@collab-write/crdt-core";
import type { Db } from "./db.js";
import type { PubSub, PubSubPayload } from "./pubsub.js";

export interface Room {
  doc: RGADocument;
  sockets: Set<WebSocket>;
  /** Presence of clients connected to THIS node, keyed by socket. */
  localPresence: Map<WebSocket, PeerPresence>;
  /** Presence of clients on OTHER nodes, learned via pub/sub. */
  remotePresence: Map<string, PeerPresence>;
  /** Highest op-log row id this room has persisted (snapshot cut point). */
  lastOpId: number;
  opsSinceSnapshot: number;
}

/**
 * Owns every active document on this node. A room is hydrated from
 * Postgres (latest snapshot + op-log tail) on first join, kept hot in
 * memory, and mirrored across nodes via pub/sub.
 */
export class RoomManager {
  private rooms = new Map<string, Promise<Room>>();

  constructor(
    private db: Db,
    private pubsub: PubSub,
    private snapshotEvery: number,
  ) {}

  /** Get the live room, hydrating from the DB exactly once per node. */
  getRoom(docId: string): Promise<Room> {
    let room = this.rooms.get(docId);
    if (!room) {
      // Store the promise (not the room) so concurrent joiners of a cold
      // document share one hydration instead of racing.
      room = this.hydrate(docId);
      this.rooms.set(docId, room);
    }
    return room;
  }

  private async hydrate(docId: string): Promise<Room> {
    const doc = new RGADocument(`server:${docId}`);
    const snapshot = await this.db.latestSnapshot(docId);
    let lastOpId = 0;
    if (snapshot) {
      for (const op of snapshot.state_blob) doc.apply(op);
      lastOpId = snapshot.last_op_id;
    }
    const tail = await this.db.loadOpsAfter(docId, lastOpId);
    for (const op of tail) doc.apply(op);

    const room: Room = {
      doc,
      sockets: new Set(),
      localPresence: new Map(),
      remotePresence: new Map(),
      lastOpId: 0,
      opsSinceSnapshot: 0,
    };
    // Start receiving other nodes' traffic for this document.
    await this.pubsub.subscribe(docId, (payload) => this.applyFromPeerNode(room, payload));
    return room;
  }

  /**
   * An op from one of OUR clients: apply, persist, fan out locally, and
   * publish to peer nodes. Only the receiving node writes to the op-log —
   * peers apply to memory only, so each op is persisted exactly once.
   */
  async applyFromClient(docId: string, room: Room, op: Operation, from?: WebSocket): Promise<void> {
    room.doc.apply(op);
    const rowId = await this.db.appendOperation(docId, op);
    this.broadcastLocal(room, { type: "op", op }, from);
    this.pubsub.publish(docId, { kind: "op", op });

    if (rowId !== null) {
      room.lastOpId = Math.max(room.lastOpId, rowId);
      room.opsSinceSnapshot++;
      if (room.opsSinceSnapshot >= this.snapshotEvery) {
        room.opsSinceSnapshot = 0;
        await this.db.saveSnapshot(docId, room.lastOpId, room.doc.opsSince({}), room.doc.versionVector());
      }
    }
  }

  /** Presence from one of OUR clients: remember, fan out, publish. */
  presenceFromClient(docId: string, room: Room, ws: WebSocket, peer: PeerPresence): void {
    room.localPresence.set(ws, peer);
    this.broadcastLocal(room, { type: "presence", peer }, ws);
    this.pubsub.publish(docId, { kind: "presence", peer });
  }

  /** Everyone currently in the doc except the given socket's own entry. */
  peersFor(room: Room, except?: WebSocket): PeerPresence[] {
    const peers: PeerPresence[] = [];
    for (const [ws, p] of room.localPresence) if (ws !== except) peers.push(p);
    peers.push(...room.remotePresence.values());
    return peers;
  }

  /** Traffic published by a peer node: memory + local fan-out only. */
  private applyFromPeerNode(room: Room, payload: PubSubPayload): void {
    switch (payload.kind) {
      case "op":
        room.doc.apply(payload.op); // idempotent — duplicates are harmless
        this.broadcastLocal(room, { type: "op", op: payload.op });
        break;
      case "presence":
        room.remotePresence.set(payload.peer.clientId, payload.peer);
        this.broadcastLocal(room, { type: "presence", peer: payload.peer });
        break;
      case "presence-left":
        room.remotePresence.delete(payload.clientId);
        this.broadcastLocal(room, { type: "presence-left", clientId: payload.clientId });
        break;
    }
  }

  async leave(docId: string, room: Room, ws: WebSocket): Promise<void> {
    room.sockets.delete(ws);
    const peer = room.localPresence.get(ws);
    room.localPresence.delete(ws);
    if (peer) {
      this.broadcastLocal(room, { type: "presence-left", clientId: peer.clientId });
      this.pubsub.publish(docId, { kind: "presence-left", clientId: peer.clientId });
    }
    if (room.sockets.size === 0) {
      // Evict idle rooms so a node's memory tracks its active docs, not
      // every doc it has ever seen. Postgres has the durable copy.
      this.rooms.delete(docId);
      await this.pubsub.unsubscribe(docId);
    }
  }

  broadcastLocal(room: Room, msg: ServerMessage, except?: WebSocket): void {
    const frame = JSON.stringify(msg);
    for (const peer of room.sockets) {
      if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(frame);
    }
  }
}

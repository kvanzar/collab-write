import { WebSocketServer, WebSocket } from "ws";
import {
  RGADocument,
  type ClientMessage,
  type ServerMessage,
} from "@collab-write/crdt-core";

interface Room {
  /** The server's own replica — the source of truth for late joiners. */
  doc: RGADocument;
  sockets: Set<WebSocket>;
}

/**
 * A collab server node. Holds one RGADocument replica per active document
 * and relays ops between the clients in each room. It never arbitrates
 * conflicts — the CRDT makes every replica resolve them identically.
 */
export function createCollabServer(port: number): WebSocketServer {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    let room: Room | undefined;

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed frames
      }

      if (msg.type === "join") {
        room = rooms.get(msg.docId);
        if (!room) {
          room = { doc: new RGADocument(`server:${msg.docId}`), sockets: new Set() };
          rooms.set(msg.docId, room);
        }
        room.sockets.add(ws);
        // Diff sync: send only what this client hasn't seen, plus our
        // vector so the client can push back its offline edits.
        send(ws, {
          type: "sync",
          ops: room.doc.opsSince(msg.vector),
          vector: room.doc.versionVector(),
        });
      } else if (msg.type === "op" && room) {
        room.doc.apply(msg.op); // idempotent: duplicates are no-ops
        broadcast(room, { type: "op", op: msg.op }, ws);
      }
    });

    ws.on("close", () => room?.sockets.delete(ws));
  });

  return wss;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: ServerMessage, except?: WebSocket): void {
  const frame = JSON.stringify(msg);
  for (const peer of room.sockets) {
    if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(frame);
  }
}

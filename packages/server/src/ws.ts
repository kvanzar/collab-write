import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { RequestHandler } from "express";
import type { ClientMessage } from "@collab-write/crdt-core";
import type { Db } from "./db.js";
import type { Room, RoomManager } from "./rooms.js";

/**
 * Attach the collab WebSocket endpoint to the HTTP server, reusing the
 * Express session middleware to authenticate the upgrade request — the
 * socket is rejected before it can join a room if there's no valid session.
 */
export function attachWebSocket(
  server: Server,
  sessionParser: RequestHandler,
  db: Db,
  rooms: RoomManager,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // Run the same session middleware HTTP requests go through.
    sessionParser(req as never, {} as never, () => {
      const userId = sessionUserId(req);
      if (!userId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, userId);
      });
    });
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, userId: string) => {
    let joined: { docId: string; room: Room } | undefined;

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "join" && !joined) {
        const doc = await db.getDocument(msg.docId);
        if (!doc) {
          ws.close(4004, "document not found");
          return;
        }
        await db.grantEditorAccess(msg.docId, userId);
        const room = await rooms.getRoom(msg.docId);
        room.sockets.add(ws);
        joined = { docId: msg.docId, room };
        ws.send(
          JSON.stringify({
            type: "sync",
            ops: room.doc.opsSince(msg.vector),
            vector: room.doc.versionVector(),
            peers: rooms.peersFor(room, ws),
          }),
        );
      } else if (msg.type === "op" && joined) {
        await rooms.applyFromClient(joined.docId, joined.room, msg.op, ws);
      } else if (msg.type === "presence" && joined) {
        rooms.presenceFromClient(joined.docId, joined.room, ws, msg.peer);
      }
    });

    ws.on("close", () => {
      if (joined) rooms.leave(joined.docId, joined.room, ws).catch(() => {});
    });
  });

  return wss;
}

function sessionUserId(req: IncomingMessage): string | undefined {
  // express-session + passport store the logged-in user id here.
  const session = (req as { session?: { passport?: { user?: string } } }).session;
  return session?.passport?.user;
}

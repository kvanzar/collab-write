import http from "node:http";
import express from "express";
import session from "express-session";
import { configFromEnv, type ServerConfig } from "./config.js";
import { Db } from "./db.js";
import { setupAuth, requireAuth } from "./auth.js";
import { createLocalPubSub, createRedisPubSub, type PubSub } from "./pubsub.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocket } from "./ws.js";

export interface CollabServer {
  server: http.Server;
  port: number;
  db: Db;
  close(): Promise<void>;
}

/**
 * Boot one collab server node: REST (auth, documents) + WebSocket sync,
 * backed by Postgres, optionally joined to peer nodes through Redis.
 */
export async function createServer(config: ServerConfig): Promise<CollabServer> {
  const db = new Db(config.databaseUrl);
  await db.init();

  const pubsub: PubSub = config.redisUrl
    ? createRedisPubSub(config.redisUrl)
    : createLocalPubSub();
  const rooms = new RoomManager(db, pubsub, config.snapshotEvery);

  const app = express();
  app.use(express.json());
  const sessionParser = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", httpOnly: true },
  });
  app.use(sessionParser);
  setupAuth(app, db, config);

  app.get("/api/documents", requireAuth, async (req, res) => {
    res.json(await db.listDocuments(req.user!.id));
  });

  app.post("/api/documents", requireAuth, async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    if (!title) return res.status(400).json({ error: "title required" });
    res.status(201).json(await db.createDocument(req.user!.id, title));
  });

  const server = http.createServer(app);
  attachWebSocket(server, sessionParser, db, rooms);

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;

  return {
    server,
    port,
    db,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await pubsub.close();
      await db.close();
    },
  };
}

// Direct execution (npm start / dev) — boot from environment.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const config = configFromEnv();
  createServer(config)
    .then(({ port }) => {
      console.log(`collab server node listening on http://localhost:${port}`);
      console.log(`  postgres: ${config.databaseUrl}`);
      console.log(`  redis:    ${config.redisUrl ?? "(none — single node mode)"}`);
    })
    .catch((err) => {
      console.error("failed to start:", err);
      process.exit(1);
    });
}

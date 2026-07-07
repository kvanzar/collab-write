import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
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
  // Behind a load balancer / reverse proxy in production; needed so
  // secure cookies and client IPs work through the proxy.
  app.set("trust proxy", 1);
  app.use(express.json());

  // Sessions live in Postgres, not process memory — they survive server
  // restarts and are shared across nodes (any node can serve any user).
  const PgSession = connectPgSimple(session);
  const sessionParser = session({
    store: new PgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", httpOnly: true, secure: config.isProd },
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

  app.get("/api/documents/:id", requireAuth, async (req, res) => {
    const doc = await db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  });

  // In production the node serves the built web app itself: one origin
  // for HTML, REST, and WebSocket — no CORS, cookies just work.
  const webDist =
    process.env.WEB_DIST ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api")) {
        res.sendFile(path.join(webDist, "index.html"));
      } else {
        next();
      }
    });
  }

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
      console.log(`  google:   ${config.google ? "configured" : "not configured (dev login active)"}`);
    })
    .catch((err) => {
      console.error("failed to start:", err);
      process.exit(1);
    });
}

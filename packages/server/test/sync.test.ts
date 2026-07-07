import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  RGADocument,
  type ClientMessage,
  type PeerPresence,
  type ServerMessage,
} from "@collab-write/crdt-core";
import { createServer, type CollabServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";

const TEST_DB = "postgres://localhost:5432/collabwrite_test";
const REDIS = "redis://localhost:6379";

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    isProd: false,
    databaseUrl: TEST_DB,
    redisUrl: undefined,
    sessionSecret: "test-secret",
    snapshotEvery: 5, // low so tests exercise snapshots quickly
    google: undefined,
    allowDevLogin: true,
    ...overrides,
  };
}

/** Log in via the real REST endpoint and keep the session cookie. */
async function login(port: number, name: string): Promise<string> {
  const r = await fetch(`http://localhost:${port}/api/auth/dev-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}

async function createDoc(port: number, cookie: string, title: string): Promise<string> {
  const r = await fetch(`http://localhost:${port}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).id;
}

/** Authenticated collab client — same protocol dance as the browser. */
class TestClient {
  readonly doc: RGADocument;
  readonly peers = new Map<string, PeerPresence>();
  private ws: WebSocket;
  private synced: Promise<void>;

  constructor(
    port: number,
    docId: string,
    readonly clientId: string,
    cookie: string,
  ) {
    this.doc = new RGADocument(clientId);
    this.ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { cookie } });
    this.synced = new Promise((resolve, reject) => {
      this.ws.on("error", reject);
      this.ws.on("open", () => {
        this.send({ type: "join", docId, vector: this.doc.versionVector() });
      });
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        switch (msg.type) {
          case "sync":
            for (const op of msg.ops) this.doc.apply(op);
            for (const op of this.doc.opsSince(msg.vector)) this.send({ type: "op", op });
            for (const peer of msg.peers) this.peers.set(peer.clientId, peer);
            resolve();
            break;
          case "op":
            this.doc.apply(msg.op);
            break;
          case "presence":
            this.peers.set(msg.peer.clientId, msg.peer);
            break;
          case "presence-left":
            this.peers.delete(msg.clientId);
            break;
        }
      });
    });
  }

  async join(): Promise<void> {
    await this.synced;
  }

  type(index: number, text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.send({ type: "op", op: this.doc.localInsert(index + i, text[i]) });
    }
  }

  sendPresence(name: string, color: string, cursorIndex: number | null): void {
    const cursor =
      cursorIndex === null
        ? null
        : { afterId: cursorIndex === 0 ? null : (this.doc.charIdAtVisibleIndex(cursorIndex - 1) ?? null) };
    this.send({
      type: "presence",
      peer: { clientId: this.clientId, name, color, cursor },
    });
  }

  close(): void {
    this.ws.close();
  }

  private send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const nodes: CollabServer[] = [];
async function bootNode(overrides: Partial<ServerConfig> = {}): Promise<CollabServer> {
  const node = await createServer(testConfig(overrides));
  nodes.push(node);
  return node;
}

beforeAll(async () => {
  // Clean slate in the test database.
  const wipe = await createServer(testConfig());
  await wipe.db.pool.query(
    "TRUNCATE document_access, snapshots, operations, documents, users CASCADE",
  );
  await wipe.close();
});

afterAll(async () => {
  for (const n of nodes) await n.close().catch(() => {});
});

describe("auth and documents API", () => {
  test("endpoints require a session; login + create + list works", async () => {
    const node = await bootNode();

    // No session: REST rejects, and so does the WebSocket upgrade.
    const anon = await fetch(`http://localhost:${node.port}/api/documents`);
    expect(anon.status).toBe(401);
    const badWs = new WebSocket(`ws://localhost:${node.port}/ws`);
    await new Promise<void>((resolve) => badWs.on("error", () => resolve()));

    const cookie = await login(node.port, "Alice");
    const me = await fetch(`http://localhost:${node.port}/api/me`, { headers: { cookie } });
    expect((await me.json()).name).toBe("Alice");

    const docId = await createDoc(node.port, cookie, "My first doc");
    const list = await fetch(`http://localhost:${node.port}/api/documents`, { headers: { cookie } });
    expect((await list.json()).map((d: { id: string }) => d.id)).toContain(docId);
  });
});

describe("persistence (op-log + snapshots)", () => {
  test("document survives a full server restart; snapshots get written", async () => {
    const node1 = await bootNode();
    const cookie = await login(node1.port, "Alice");
    const docId = await createDoc(node1.port, cookie, "durable doc");

    const alice = new TestClient(node1.port, docId, "alice", cookie);
    await alice.join();
    alice.type(0, "persist me!"); // 11 ops > snapshotEvery=5

    // Wait until the op-log has everything, then kill the node.
    await waitUntil(() => false, 300).catch(() => {});
    const { rows } = await node1.db.pool.query(
      "SELECT count(*)::int AS n FROM operations WHERE document_id = $1",
      [docId],
    );
    expect(rows[0].n).toBe(11);
    alice.close();
    await node1.close();

    // Fresh node, same database: the room hydrates from snapshot + tail.
    const node2 = await bootNode();
    const cookie2 = await login(node2.port, "Bob");
    const bob = new TestClient(node2.port, docId, "bob", cookie2);
    await bob.join();
    expect(bob.doc.text()).toBe("persist me!");

    const snaps = await node2.db.pool.query(
      "SELECT count(*)::int AS n FROM snapshots WHERE document_id = $1",
      [docId],
    );
    expect(snaps.rows[0].n).toBeGreaterThanOrEqual(1);
    bob.close();
  });

  test("re-sending the same op is persisted only once (durable idempotency)", async () => {
    const node = await bootNode();
    const cookie = await login(node.port, "Alice");
    const docId = await createDoc(node.port, cookie, "idempotent doc");

    const alice = new TestClient(node.port, docId, "alice2", cookie);
    await alice.join();
    const op = alice.doc.localInsert(0, "x");
    // Simulate a paranoid client re-sending after a flaky connection.
    for (let i = 0; i < 3; i++) {
      (alice as unknown as { send: (m: ClientMessage) => void }).send({ type: "op", op });
    }
    await waitUntil(() => false, 300).catch(() => {});
    const { rows } = await node.db.pool.query(
      "SELECT count(*)::int AS n FROM operations WHERE document_id = $1",
      [docId],
    );
    expect(rows[0].n).toBe(1);
    alice.close();
  });
});

describe("presence (ephemeral cursors)", () => {
  test("peers see each other's cursors; presence is never persisted", async () => {
    const node = await bootNode();
    const cookie = await login(node.port, "Alice");
    const docId = await createDoc(node.port, cookie, "presence doc");

    const alice = new TestClient(node.port, docId, "alice-p", cookie);
    await alice.join();
    alice.type(0, "hi");
    alice.sendPresence("Alice", "#e11", 2);

    // Late joiner receives current presence in the sync reply.
    const cookieB = await login(node.port, "Bob");
    const bob = new TestClient(node.port, docId, "bob-p", cookieB);
    await bob.join();
    await waitUntil(() => bob.peers.has("alice-p"));
    expect(bob.peers.get("alice-p")!.name).toBe("Alice");

    // Cursor anchored to a CharId, not an index.
    expect(bob.peers.get("alice-p")!.cursor?.afterId).toEqual(
      alice.doc.charIdAtVisibleIndex(1),
    );

    // Disconnect notifies peers.
    alice.close();
    await waitUntil(() => !bob.peers.has("alice-p"));

    // Ephemeral: only the 2 typed chars hit the op-log, nothing from presence.
    const { rows } = await node.db.pool.query(
      "SELECT count(*)::int AS n FROM operations WHERE document_id = $1",
      [docId],
    );
    expect(rows[0].n).toBe(2);
    bob.close();
  });

  test("presence crosses nodes via Redis", async () => {
    const nodeA = await bootNode({ redisUrl: REDIS });
    const nodeB = await bootNode({ redisUrl: REDIS });
    const cookieA = await login(nodeA.port, "Alice");
    const cookieB = await login(nodeB.port, "Bob");
    const docId = await createDoc(nodeA.port, cookieA, "cross-node presence");

    const alice = new TestClient(nodeA.port, docId, "alice-x", cookieA);
    await alice.join();
    const bob = new TestClient(nodeB.port, docId, "bob-x", cookieB);
    await bob.join();

    alice.sendPresence("Alice", "#e11", 0);
    await waitUntil(() => bob.peers.has("alice-x"));
    expect(bob.peers.get("alice-x")!.color).toBe("#e11");

    alice.close();
    bob.close();
  });
});

describe("horizontal scaling (Redis pub/sub)", () => {
  test("clients on two different server nodes converge", async () => {
    const nodeA = await bootNode({ redisUrl: REDIS });
    const nodeB = await bootNode({ redisUrl: REDIS });
    expect(nodeA.port).not.toBe(nodeB.port);

    const cookieA = await login(nodeA.port, "Alice");
    const cookieB = await login(nodeB.port, "Bob");
    const docId = await createDoc(nodeA.port, cookieA, "cross-node doc");

    const alice = new TestClient(nodeA.port, docId, "alice3", cookieA);
    await alice.join();
    const bob = new TestClient(nodeB.port, docId, "bob3", cookieB);
    await bob.join();

    alice.type(0, "from A");
    await waitUntil(() => bob.doc.text() === "from A");

    bob.type(6, " meets B");
    await waitUntil(() => alice.doc.text() === "from A meets B");

    expect(alice.doc.text()).toBe(bob.doc.text());
    alice.close();
    bob.close();
  });
});

import { afterAll, describe, expect, test } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import {
  RGADocument,
  type ClientMessage,
  type ServerMessage,
} from "@collab-write/crdt-core";
import { createCollabServer } from "../src/server.js";

/** Minimal collab client — the same protocol dance the browser will do. */
class TestClient {
  readonly doc: RGADocument;
  private ws: WebSocket;
  private synced: Promise<void>;

  constructor(port: number, docId: string, clientId: string) {
    this.doc = new RGADocument(clientId);
    this.ws = new WebSocket(`ws://localhost:${port}`);
    this.synced = new Promise((resolve) => {
      this.ws.on("open", () => {
        this.send({ type: "join", docId, vector: this.doc.versionVector() });
      });
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === "sync") {
          for (const op of msg.ops) this.doc.apply(op);
          // Push back anything the server is missing (offline edits).
          for (const op of this.doc.opsSince(msg.vector)) this.send({ type: "op", op });
          resolve();
        } else {
          this.doc.apply(msg.op);
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

  delete(index: number): void {
    this.send({ type: "op", op: this.doc.localDelete(index) });
  }

  close(): void {
    this.ws.close();
  }

  private send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}

async function waitUntil(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: WebSocketServer;
afterAll(() => server?.close());

describe("collab server", () => {
  test("live edits relay between clients, late joiners catch up, offline edits merge", async () => {
    server = createCollabServer(0);
    const port = (server.address() as AddressInfo).port;

    // Alice joins an empty doc and types.
    const alice = new TestClient(port, "doc1", "alice");
    await alice.join();
    alice.type(0, "hello");

    // Bob joins late — the sync reply must carry Alice's whole history.
    const bob = new TestClient(port, "doc1", "bob");
    await bob.join();
    expect(bob.doc.text()).toBe("hello");

    // Live relay in both directions.
    bob.type(5, " world");
    await waitUntil(() => alice.doc.text() === "hello world");
    alice.delete(0);
    await waitUntil(() => bob.doc.text() === "ello world");

    // Carol edited the same doc "offline" (never connected) — her client
    // joins with pre-existing local history and it merges in.
    const carolOffline = new TestClient(port, "doc1", "carol");
    carolOffline.doc.localInsert(0, "*"); // typed before joining
    await carolOffline.join();
    await waitUntil(
      () =>
        alice.doc.text() === carolOffline.doc.text() &&
        bob.doc.text() === carolOffline.doc.text() &&
        carolOffline.doc.text().includes("*") &&
        carolOffline.doc.text().includes("ello world"),
    );

    // Rooms are isolated: a different docId starts empty.
    const dave = new TestClient(port, "doc2", "dave");
    await dave.join();
    expect(dave.doc.text()).toBe("");

    for (const c of [alice, bob, carolOffline, dave]) c.close();
  });
});

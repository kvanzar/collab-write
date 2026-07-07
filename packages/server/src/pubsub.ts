import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type { Operation } from "@collab-write/crdt-core";

/**
 * Cross-node op broadcast (PRD §8.5). Each node publishes every op it
 * receives from its own clients to a channel keyed by document ID; every
 * node with that document open applies what the others publish.
 */
export interface PubSub {
  publish(docId: string, op: Operation): void;
  subscribe(docId: string, onRemoteOp: (op: Operation) => void): Promise<void>;
  unsubscribe(docId: string): Promise<void>;
  close(): Promise<void>;
}

/** Single-node fallback: no other nodes exist, so publishing is a no-op. */
export function createLocalPubSub(): PubSub {
  return {
    publish() {},
    async subscribe() {},
    async unsubscribe() {},
    async close() {},
  };
}

export function createRedisPubSub(redisUrl: string): PubSub {
  // Redis requires a dedicated connection for subscribing — a subscribed
  // connection can't issue regular commands, so we hold two.
  const pub = new Redis(redisUrl);
  const sub = new Redis(redisUrl);
  const nodeId = randomUUID();
  const handlers = new Map<string, (op: Operation) => void>();

  sub.on("message", (channel: string, raw: string) => {
    const msg = JSON.parse(raw) as { nodeId: string; op: Operation };
    if (msg.nodeId === nodeId) return; // our own publish echoed back
    handlers.get(channel)?.(msg.op);
  });

  return {
    publish(docId, op) {
      pub.publish(`doc:${docId}`, JSON.stringify({ nodeId, op }));
    },
    async subscribe(docId, onRemoteOp) {
      handlers.set(`doc:${docId}`, onRemoteOp);
      await sub.subscribe(`doc:${docId}`);
    },
    async unsubscribe(docId) {
      handlers.delete(`doc:${docId}`);
      // The connection may already be gone during shutdown — the handler
      // is removed above, which is what actually stops op delivery.
      await sub.unsubscribe(`doc:${docId}`).catch(() => {});
    },
    async close() {
      pub.disconnect();
      sub.disconnect();
    },
  };
}

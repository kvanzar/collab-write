import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type { Operation, PeerPresence } from "@collab-write/crdt-core";

/**
 * What travels between nodes: durable ops, plus ephemeral presence.
 * Presence rides the same channel but is never persisted anywhere.
 */
export type PubSubPayload =
  | { kind: "op"; op: Operation }
  | { kind: "presence"; peer: PeerPresence }
  | { kind: "presence-left"; clientId: string };

/**
 * Cross-node broadcast (PRD §8.5). Each node publishes what its own
 * clients produce to a channel keyed by document ID; every node with that
 * document open applies what the others publish.
 */
export interface PubSub {
  publish(docId: string, payload: PubSubPayload): void;
  subscribe(docId: string, onMessage: (payload: PubSubPayload) => void): Promise<void>;
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
  const handlers = new Map<string, (payload: PubSubPayload) => void>();

  sub.on("message", (channel: string, raw: string) => {
    const msg = JSON.parse(raw) as { nodeId: string; payload: PubSubPayload };
    if (msg.nodeId === nodeId) return; // our own publish echoed back
    handlers.get(channel)?.(msg.payload);
  });

  return {
    publish(docId, payload) {
      pub.publish(`doc:${docId}`, JSON.stringify({ nodeId, payload }));
    },
    async subscribe(docId, onMessage) {
      handlers.set(`doc:${docId}`, onMessage);
      await sub.subscribe(`doc:${docId}`);
    },
    async unsubscribe(docId) {
      handlers.delete(`doc:${docId}`);
      // The connection may already be gone during shutdown — the handler
      // is removed above, which is what actually stops delivery.
      await sub.unsubscribe(`doc:${docId}`).catch(() => {});
    },
    async close() {
      pub.disconnect();
      sub.disconnect();
    },
  };
}

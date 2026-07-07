import type { CharId, Operation, VersionVector } from "./types.js";

/**
 * Wire protocol between client and collab server. Lives in the shared
 * package so both sides are compiled against the same message shapes.
 */

/**
 * A cursor location expressed in CRDT terms: "immediately after the char
 * with this ID" (null = start of document). Unlike a numeric index, this
 * stays correct while concurrent edits shift positions — each client
 * resolves it against its own replica.
 */
export interface CursorAnchor {
  afterId: CharId | null;
}

/** Ephemeral per-user presence — never persisted, never in the op-log. */
export interface PeerPresence {
  clientId: string;
  name: string;
  color: string;
  cursor: CursorAnchor | null;
}

export type ClientMessage =
  /** Enter a document room. `vector` = what this client has already seen. */
  | { type: "join"; docId: string; vector: VersionVector }
  /** One CRDT operation to apply and broadcast. */
  | { type: "op"; op: Operation }
  /** Throttled cursor/identity update. Safe to drop under load. */
  | { type: "presence"; peer: PeerPresence };

export type ServerMessage =
  /**
   * Reply to join: every op the client is missing, plus the server's own
   * vector so the client can push back its offline edits, plus who else
   * is currently in the document.
   */
  | { type: "sync"; ops: Operation[]; vector: VersionVector; peers: PeerPresence[] }
  | { type: "op"; op: Operation }
  | { type: "presence"; peer: PeerPresence }
  | { type: "presence-left"; clientId: string };

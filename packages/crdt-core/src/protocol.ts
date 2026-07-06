import type { Operation, VersionVector } from "./types.js";

/**
 * Wire protocol between client and collab server. Lives in the shared
 * package so both sides are compiled against the same message shapes.
 */

export type ClientMessage =
  /** Enter a document room. `vector` = what this client has already seen. */
  | { type: "join"; docId: string; vector: VersionVector }
  /** One CRDT operation to apply and broadcast. */
  | { type: "op"; op: Operation };

export type ServerMessage =
  /**
   * Reply to join: every op the client is missing, plus the server's own
   * vector so the client can push back its offline edits.
   */
  | { type: "sync"; ops: Operation[]; vector: VersionVector }
  | { type: "op"; op: Operation };

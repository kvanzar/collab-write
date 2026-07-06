/**
 * Globally unique, permanent identity for one character.
 * Never reused, never changes — the whole CRDT hinges on this stability.
 */
export interface CharId {
  /** Which client created this character. */
  clientId: string;
  /** Lamport clock value at the client when the character was created. */
  clock: number;
}

/** One character cell in the RGA sequence. */
export interface Char {
  id: CharId;
  /** The single character this cell holds. */
  value: string;
  /** ID of the character this was inserted after; null = start of document. */
  afterId: CharId | null;
  /** Tombstone flag — deleted chars stay in the structure so refs to them stay valid. */
  deleted: boolean;
}

/**
 * The unit that travels over the network. Contains everything needed to
 * apply it on any replica, in any order relative to concurrent ops.
 * Every op carries its own unique ID (for inserts, the char's ID) so
 * replicas can deduplicate and diff-sync any op, not just inserts.
 */
export type Operation =
  | { type: "insert"; char: Char }
  | { type: "delete"; id: CharId; targetId: CharId };

/** The unique identity of any operation. */
export function opId(op: Operation): CharId {
  return op.type === "insert" ? op.char.id : op.id;
}

/**
 * Compact summary of "which ops have I seen": highest clock observed per
 * client. Two replicas exchange these to compute exactly which ops the
 * other is missing — the basis of reconnect/offline sync.
 */
export type VersionVector = Record<string, number>;

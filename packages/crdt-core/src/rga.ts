import { opId, type Char, type CharId, type Operation, type VersionVector } from "./types.js";

export function idsEqual(a: CharId | null, b: CharId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.clientId === b.clientId && a.clock === b.clock;
}

function idKey(id: CharId): string {
  return `${id.clientId}:${id.clock}`;
}

/**
 * Total order over character IDs, used to break ties between concurrent
 * inserts at the same position. Every replica must compute the exact same
 * ordering from the same two IDs — this determinism is what makes the
 * whole document converge.
 *
 * Contract: return a positive number if `a` takes precedence over `b`,
 * a negative number if `b` takes precedence. Must never return 0 for
 * two distinct IDs (the order must be *total*).
 */
export function compareCharIds(a: CharId, b: CharId): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  if (a.clientId === b.clientId) return 0;
  return a.clientId > b.clientId ? 1 : -1;
}

/**
 * A replica of the document. Each connected client (and the server) holds
 * one of these. Local edits produce Operations to broadcast; remote
 * Operations are fed into apply().
 */
export class RGADocument {
  /** Full sequence including tombstones, in document order. */
  private chars: Char[] = [];
  /** Lamport clock: incremented on local ops, fast-forwarded on remote ops. */
  private clock = 0;
  /** Op IDs already applied, so duplicate delivery is a no-op. */
  private applied = new Set<string>();
  /** Ops waiting on a char we haven't seen yet, keyed by the missing char's ID. */
  private pending = new Map<string, Operation[]>();
  /** Every op ever applied, in application order — the diff-sync source. */
  private history: Operation[] = [];
  /** Highest clock observed per client (only counting applied ops). */
  private seen = new Map<string, number>();

  constructor(readonly clientId: string) {}

  /** The visible text (tombstones filtered out). */
  text(): string {
    let out = "";
    for (const c of this.chars) if (!c.deleted) out += c.value;
    return out;
  }

  /**
   * Type one character at a visible position (0 = start of doc).
   * Applies it locally and returns the Operation to broadcast.
   */
  localInsert(visibleIndex: number, value: string): Operation {
    const afterId = this.refIdForVisibleIndex(visibleIndex);
    this.clock += 1;
    const char: Char = {
      id: { clientId: this.clientId, clock: this.clock },
      value,
      afterId,
      deleted: false,
    };
    const op: Operation = { type: "insert", char };
    this.apply(op);
    return op;
  }

  /**
   * Delete the character at a visible position.
   * Applies it locally and returns the Operation to broadcast.
   */
  localDelete(visibleIndex: number): Operation {
    const target = this.visibleCharAt(visibleIndex);
    if (!target) throw new RangeError(`no visible char at index ${visibleIndex}`);
    this.clock += 1;
    const op: Operation = {
      type: "delete",
      id: { clientId: this.clientId, clock: this.clock },
      targetId: target.id,
    };
    this.apply(op);
    return op;
  }

  /**
   * Apply an operation (local or remote). Safe to call with duplicates —
   * application is idempotent, which is what lets us scale across nodes
   * later without exactly-once delivery guarantees.
   */
  apply(op: Operation): void {
    const key = idKey(opId(op));
    if (this.applied.has(key)) return;

    if (op.type === "insert") {
      // Causal dependency missing? Park the op until its reference arrives.
      if (op.char.afterId !== null && !this.applied.has(idKey(op.char.afterId))) {
        this.park(idKey(op.char.afterId), op);
        return;
      }
      this.record(op, key);
      this.integrateInsert({ ...op.char });
      this.drainPending(idKey(op.char.id));
    } else {
      const target = this.chars.find((c) => idsEqual(c.id, op.targetId));
      if (!target) {
        // Delete arrived before the insert it targets.
        this.park(idKey(op.targetId), op);
        return;
      }
      this.record(op, key);
      target.deleted = true;
    }
  }

  /** Bookkeeping shared by every successfully applied op. */
  private record(op: Operation, key: string): void {
    this.applied.add(key);
    this.history.push(op);
    const id = opId(op);
    // Lamport receive rule: never let our clock fall behind one we've seen.
    this.clock = Math.max(this.clock, id.clock);
    this.seen.set(id.clientId, Math.max(this.seen.get(id.clientId) ?? 0, id.clock));
  }

  /** Snapshot of "what I've seen from each client" — send this on reconnect. */
  versionVector(): VersionVector {
    return Object.fromEntries(this.seen);
  }

  /**
   * Every applied op the given replica hasn't seen, in an order that's
   * always safe to apply (history order never puts a char before its
   * reference). This is the diff half of reconnect sync.
   */
  opsSince(remote: VersionVector): Operation[] {
    return this.history.filter((op) => {
      const id = opId(op);
      return id.clock > (remote[id.clientId] ?? 0);
    });
  }

  /**
   * Position of a char among visible chars, or -1 if deleted/unknown.
   * The editor binding uses this to turn a remote op into a screen update.
   */
  visibleIndexOfId(id: CharId): number {
    let index = 0;
    for (const c of this.chars) {
      if (idsEqual(c.id, id)) return c.deleted ? -1 : index;
      if (!c.deleted) index++;
    }
    return -1;
  }

  /** Number of ops still waiting on a missing dependency (for tests/debugging). */
  pendingCount(): number {
    let n = 0;
    for (const ops of this.pending.values()) n += ops.length;
    return n;
  }

  private park(missingKey: string, op: Operation): void {
    const queue = this.pending.get(missingKey);
    if (queue) queue.push(op);
    else this.pending.set(missingKey, [op]);
  }

  /** Re-apply any ops that were waiting on the char that just arrived. */
  private drainPending(arrivedKey: string): void {
    const waiting = this.pending.get(arrivedKey);
    if (!waiting) return;
    this.pending.delete(arrivedKey);
    for (const op of waiting) this.apply(op); // may cascade into further drains
  }

  /**
   * Core RGA insertion: place `char` after its reference, then skip
   * forward past any chars that (a) landed in the same spot concurrently
   * and (b) win the compareCharIds tie-break.
   */
  private integrateInsert(char: Char): void {
    let i =
      char.afterId === null ? 0 : this.indexOfId(char.afterId) + 1;
    while (i < this.chars.length && compareCharIds(this.chars[i].id, char.id) > 0) {
      i++;
    }
    this.chars.splice(i, 0, char);
  }

  /** Index in the full (tombstones included) array, or throws if absent. */
  private indexOfId(id: CharId): number {
    const i = this.chars.findIndex((c) => idsEqual(c.id, id));
    if (i === -1) throw new Error(`unknown ref ${idKey(id)}`);
    return i;
  }

  /** The visible char preceding an insertion at visibleIndex (null = head). */
  private refIdForVisibleIndex(visibleIndex: number): CharId | null {
    if (visibleIndex === 0) return null;
    const prev = this.visibleCharAt(visibleIndex - 1);
    if (!prev) throw new RangeError(`insert index ${visibleIndex} out of range`);
    return prev.id;
  }

  private visibleCharAt(visibleIndex: number): Char | undefined {
    let seen = 0;
    for (const c of this.chars) {
      if (c.deleted) continue;
      if (seen === visibleIndex) return c;
      seen++;
    }
    return undefined;
  }
}

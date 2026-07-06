import { describe, expect, test } from "vitest";
import { RGADocument, compareCharIds } from "../src/rga.js";
import type { Operation } from "../src/types.js";

/** Type a whole string into a doc starting at a visible index, collecting ops. */
function typeString(doc: RGADocument, index: number, text: string): Operation[] {
  const ops: Operation[] = [];
  for (let i = 0; i < text.length; i++) {
    ops.push(doc.localInsert(index + i, text[i]));
  }
  return ops;
}

/**
 * Randomly interleave two op streams while preserving each stream's internal
 * order — models two WebSocket connections delivering FIFO per sender but
 * with arbitrary relative timing.
 */
function interleave(a: Operation[], b: Operation[]): Operation[] {
  const out: Operation[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const takeA =
      j >= b.length || (i < a.length && Math.random() < 0.5);
    out.push(takeA ? a[i++] : b[j++]);
  }
  return out;
}

/** One random local edit (70% insert, 30% delete when possible). */
function randomEdit(doc: RGADocument): Operation {
  const len = doc.text().length;
  if (len > 0 && Math.random() < 0.3) {
    return doc.localDelete(Math.floor(Math.random() * len));
  }
  const index = Math.floor(Math.random() * (len + 1));
  const value = String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return doc.localInsert(index, value);
}

describe("compareCharIds", () => {
  test("orders by clock first, clientId as tie-break", () => {
    expect(compareCharIds({ clientId: "a", clock: 2 }, { clientId: "z", clock: 1 })).toBeGreaterThan(0);
    expect(compareCharIds({ clientId: "b", clock: 5 }, { clientId: "a", clock: 5 })).toBeGreaterThan(0);
    expect(compareCharIds({ clientId: "a", clock: 5 }, { clientId: "b", clock: 5 })).toBeLessThan(0);
  });

  test("is antisymmetric", () => {
    const x = { clientId: "alice", clock: 3 };
    const y = { clientId: "bob", clock: 3 };
    expect(Math.sign(compareCharIds(x, y))).toBe(-Math.sign(compareCharIds(y, x)));
  });
});

describe("single replica editing", () => {
  test("insert builds text left to right", () => {
    const doc = new RGADocument("a");
    typeString(doc, 0, "hello");
    expect(doc.text()).toBe("hello");
  });

  test("insert in the middle and at the ends", () => {
    const doc = new RGADocument("a");
    typeString(doc, 0, "hd");
    doc.localInsert(1, "i"); // hid
    doc.localInsert(0, "!"); // !hid
    doc.localInsert(4, "e"); // !hide
    expect(doc.text()).toBe("!hide");
  });

  test("delete removes visible chars but text stays consistent", () => {
    const doc = new RGADocument("a");
    typeString(doc, 0, "hello");
    doc.localDelete(0);
    doc.localDelete(3); // deletes 'o' of "ello"
    expect(doc.text()).toBe("ell");
  });
});

describe("two-replica convergence", () => {
  test("concurrent inserts at the same position converge, keystrokes stay contiguous", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    const aliceOps = typeString(alice, 0, "AA");
    const bobOps = typeString(bob, 0, "BB");

    // Deliver in opposite orders to each replica.
    for (const op of bobOps) alice.apply(op);
    for (const op of aliceOps) bob.apply(op);

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toHaveLength(4);
    // RGA property: one user's run of keystrokes is never split by the other's.
    expect(alice.text()).toContain("AA");
    expect(alice.text()).toContain("BB");
  });

  test("insert after a char that was concurrently deleted still lands correctly", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    // Shared base: both replicas have "abc".
    const base = typeString(alice, 0, "abc");
    for (const op of base) bob.apply(op);

    const del = alice.localDelete(1); // alice deletes 'b'
    const ins = bob.localInsert(2, "X"); // bob inserts after 'b' -> "abXc"

    alice.apply(ins);
    bob.apply(del);

    expect(alice.text()).toBe("aXc");
    expect(bob.text()).toBe("aXc");
  });

  test("duplicate delivery is a no-op (idempotency)", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    const ops = typeString(alice, 0, "hey");
    for (const op of ops) bob.apply(op);
    for (const op of ops) bob.apply(op); // redelivered
    for (const op of ops) bob.apply(op); // and again

    expect(bob.text()).toBe("hey");
  });
});

describe("out-of-order delivery (pending buffer)", () => {
  test("insert chain delivered in reverse order still converges", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    const ops = typeString(alice, 0, "abc"); // each char refs the previous one
    for (const op of ops.slice().reverse()) bob.apply(op);

    expect(bob.text()).toBe("abc");
    expect(bob.pendingCount()).toBe(0);
  });

  test("delete arriving before its insert is parked, then applied", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    const [insA] = typeString(alice, 0, "a");
    const del = alice.localDelete(0);

    bob.apply(del); // targets a char bob has never seen
    expect(bob.pendingCount()).toBe(1);
    bob.apply(insA);

    expect(bob.text()).toBe("");
    expect(bob.pendingCount()).toBe(0);
  });
});

describe("version vectors and diff sync", () => {
  test("opsSince returns exactly the missing ops, and vector exchange converges", () => {
    const alice = new RGADocument("alice");
    const bob = new RGADocument("bob");

    // Shared base, then both edit "offline".
    for (const op of typeString(alice, 0, "doc")) bob.apply(op);
    typeString(alice, 3, "!!!");
    bob.localDelete(0);
    bob.localInsert(2, "s");

    // Reconnect: exchange vectors, send only what the other is missing.
    const forBob = alice.opsSince(bob.versionVector());
    const forAlice = bob.opsSince(alice.versionVector());
    expect(forBob).toHaveLength(3); // just the "!!!" inserts, not the base
    expect(forAlice).toHaveLength(2);

    for (const op of forBob) bob.apply(op);
    for (const op of forAlice) alice.apply(op);

    expect(alice.text()).toBe(bob.text());
    expect(alice.versionVector()).toEqual(bob.versionVector());
  });

  test("empty vector requests full history; up-to-date vector requests nothing", () => {
    const alice = new RGADocument("alice");
    const ops = typeString(alice, 0, "hi");
    alice.localDelete(0);

    const fresh = new RGADocument("fresh");
    for (const op of alice.opsSince(fresh.versionVector())) fresh.apply(op);

    expect(fresh.text()).toBe(alice.text());
    expect(alice.opsSince(fresh.versionVector())).toHaveLength(0);
    expect(ops).toBeDefined();
  });

  test("visibleIndexOfId reports positions, -1 for tombstones", () => {
    const alice = new RGADocument("alice");
    const [h, i] = typeString(alice, 0, "hi");
    if (h.type !== "insert" || i.type !== "insert") throw new Error("expected inserts");

    expect(alice.visibleIndexOfId(h.char.id)).toBe(0);
    expect(alice.visibleIndexOfId(i.char.id)).toBe(1);
    alice.localDelete(0);
    expect(alice.visibleIndexOfId(h.char.id)).toBe(-1);
    expect(alice.visibleIndexOfId(i.char.id)).toBe(0);
  });
});

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("randomized convergence (fuzz)", () => {
  test("300 rounds of fully shuffled delivery (no ordering guarantee) converge", () => {
    for (let round = 0; round < 300; round++) {
      const alice = new RGADocument("alice");
      const bob = new RGADocument("bob");

      const aliceOps = typeString(alice, 0, "hello");
      for (let k = 0; k < 8; k++) aliceOps.push(randomEdit(alice));

      // Bob receives everything in a completely random order.
      for (const op of shuffle(aliceOps)) bob.apply(op);

      expect(bob.text()).toBe(alice.text());
      expect(bob.pendingCount()).toBe(0);
    }
  });

  test("300 rounds of concurrent random edits converge on all replicas", () => {
    for (let round = 0; round < 300; round++) {
      const alice = new RGADocument("alice");
      const bob = new RGADocument("bob");
      const observer = new RGADocument("observer");

      // Shared base document.
      const base = typeString(alice, 0, "base text");
      for (const op of base) {
        bob.apply(op);
        observer.apply(op);
      }

      // Both edit concurrently without seeing each other.
      const aliceOps: Operation[] = [];
      const bobOps: Operation[] = [];
      for (let k = 0; k < 10; k++) {
        aliceOps.push(randomEdit(alice));
        bobOps.push(randomEdit(bob));
      }

      // Exchange with independent random interleavings per receiver.
      for (const op of interleave(bobOps, [])) alice.apply(op);
      for (const op of interleave(aliceOps, [])) bob.apply(op);
      for (const op of interleave(aliceOps, bobOps)) observer.apply(op);

      expect(alice.text()).toBe(bob.text());
      expect(observer.text()).toBe(alice.text());
    }
  });
});

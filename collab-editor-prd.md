# PRD: CollabWrite — Real-Time Collaborative Text Editor

**Owner:** [Your name]
**Status:** Draft for personal/portfolio build
**Last updated:** July 2026

---

## 1. Problem statement

Multiple people editing the same document at the same time need their edits to converge to an identical final state, in real time, without overwriting each other's work — even when the network is slow, drops out, or delivers messages out of order.

This is a genuinely hard distributed-systems problem, not a CRUD problem. Google Docs, Notion, and Figma all solve it with either **Operational Transformation (OT)** or **CRDTs (Conflict-free Replicated Data Types)**. Building a simplified version of this yourself — and being able to explain *why* it converges — is one of the strongest "I understand distributed systems" signals you can put on a resume as a student.

## 2. Goals

- Multiple users can type into the same document simultaneously and see each other's cursors and edits live, with sub-200ms perceived latency on a good connection.
- Edits always converge to the same final document state on every client, regardless of network reordering.
- The system survives a client disconnecting mid-edit and rejoining later (offline edits merge back in).
- The backend can scale horizontally — adding more server instances should not break correctness.
- The project is deployable and demoable live, not just running on localhost.

### Non-goals (cut for MVP, mention as "future work")
- Rich text formatting (bold/italic/images) — start with plain text, add formatting only if time allows, since it multiplies CRDT complexity.
- Permissions/sharing granularity (viewer vs editor) beyond basic auth.
- Mobile native apps — web only.

## 3. Why CRDT over OT (the decision to defend in an interview)

| | Operational Transformation | CRDT |
|---|---|---|
| Core idea | Transform incoming operations against concurrent ones before applying | Design the data structure so *any* merge order produces the same result |
| Needs a central server to sequence ops? | Yes, typically | No — can work peer-to-peer |
| Complexity | Transformation functions get notoriously hard to prove correct as operation types grow | Merge logic is simpler per-operation, but the data structure (e.g. list of unique IDs) has memory overhead |
| Real-world use | Google Docs (historically) | Figma, Notion, Yjs-based apps |

**Recommendation for this project: CRDT.** It's more tractable to implement correctly from scratch as a solo project, and it's the more modern/talked-about approach — Figma's engineering blog and Yjs are both good reference reading.

Specifically, implement a simplified **RGA (Replicated Growable Array)**-style CRDT: every character gets a globally unique ID `(client_id, logical_clock)`, and each character stores a reference to the ID of the character it was inserted after. Because the "insert after this stable ID" relationship never changes, operations can arrive in any order and the document still converges to the same sequence.

## 4. Core features (MVP)

1. **Live multi-user text editing** — plain-text document, multiple cursors visible with user-colored labels.
2. **Presence indicators** — see who's currently in the document, colored cursor + name tag.
3. **Auto-save + version snapshot** — periodic snapshot to DB so a server restart doesn't lose data.
4. **Reconnect & offline merge** — if a client drops, local edits queue up and merge in once reconnected.
5. **Document list + basic auth** — create/open documents, Google OAuth login.

## 5. Stretch features (post-MVP, "phase 2" — good for a v2 blog post)

- **Undo/redo that works correctly in a multi-user context** (genuinely hard — naive undo can resurrect a character someone else already deleted).
- **Comment threads anchored to text ranges** that survive edits shifting position.
- **Version history / time-travel** — scrub back through document states.
- **Selective sync for huge documents** — don't ship the whole CRDT structure to every client, chunk it.

## 6. System architecture

```
Client (React + CodeMirror/Slate)
   │  WebSocket
   ▼
Load Balancer (sticky sessions)
   │
   ▼
Collab Server Nodes (stateless, Node.js + ws)
   │  pub/sub for cross-node broadcast
   ▼
Redis Pub/Sub
   │
   ▼
Persistence Layer (PostgreSQL: op-log + periodic snapshots)
```

**Why this shape:**
- Collab server nodes are **stateless** — the CRDT document state for an active session lives in memory on whichever node holds it, but the node doesn't need to be the *only* source of truth. Redis pub/sub means an edit landing on Node A gets broadcast and applied on Node B, C, etc., so two users in the same document on different nodes still stay in sync.
- Sticky sessions at the load balancer keep a given client attached to one node for the life of a connection (simpler than making every node hold full state for every document), but the pub/sub layer means correctness doesn't depend on sticky routing — it's an optimization, not a requirement.
- Postgres holds the durable **operation log** (every CRDT operation, append-only) plus **periodic snapshots** so recovery doesn't mean replaying the entire history from op #1.

## 7. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + CodeMirror 6 (or Slate.js) | CodeMirror has good low-level control over text operations, which you need to hook CRDT ops into keystrokes |
| Real-time transport | WebSocket (native `ws` library, or Socket.IO for reconnect handling) | Bidirectional, low-latency, and you get to reason about reconnect/backoff yourself |
| CRDT logic | Hand-rolled RGA-style implementation in TypeScript (shared between client and server as a package) | This *is* the project — don't just import Yjs, though referencing Yjs's design in your writeup shows you know the landscape |
| Backend | Node.js + Express (for REST: auth, doc list) + `ws` (for realtime) | JS end-to-end keeps the CRDT code shareable between client and server |
| Cross-node broadcast | Redis Pub/Sub | Standard pattern for scaling WebSocket servers horizontally |
| Database | PostgreSQL | Append-only op-log table + snapshot table; relational is fine, you don't need anything exotic here |
| Auth | Google OAuth (Passport.js or Auth.js) | No password system to build/secure yourself |
| Deployment | Frontend on Vercel, backend on Railway/Render, Redis on Upstash (free tier), Postgres on Supabase/Railway | All have generous free tiers, good for a live demo link |

## 8. Hard problems you will actually hit (and how to counter them)

### 8.1 Concurrent inserts at the same position
**Problem:** Two users place their cursor at the same spot and type simultaneously. Naive approaches either lose one user's characters or produce different final orderings on each client.

**Counter:** Every character gets a unique ID `(client_id, counter)`. Tie-break concurrent inserts at the same position deterministically — e.g., by comparing client IDs — so *every* client, regardless of the order operations arrive in, computes the same tie-break and lands on the identical final sequence. This determinism is the entire point of a CRDT: no negotiation needed, just a pure function of the operation's own data.

### 8.2 Out-of-order delivery
**Problem:** WebSocket messages can arrive in a different order than they were sent, especially across multiple hops (client → node A → Redis → node B → other client).

**Counter:** Because each operation references a stable ID ("insert after ID X") rather than a numeric position ("insert at index 5"), applying operation B before operation A still produces the correct structure once A arrives — the reference is to an identity, not a position that shifts. Structure the apply-function to be commutative: `apply(apply(state, A), B) == apply(apply(state, B), A)`.

### 8.3 Reconnection and offline edits
**Problem:** A client's WebSocket drops for 30 seconds. They kept typing offline. How do those edits merge back in cleanly?

**Counter:** Queue local operations in an outbox while disconnected. On reconnect, request the server's current version vector (a compact summary of "what operations have I seen from each client"), send only the operations the server hasn't seen, and receive back only the operations the client is missing. This is the same mechanism Git uses conceptually — you're doing a targeted diff sync, not a full re-download.

### 8.4 Unbounded memory growth (tombstones)
**Problem:** Deleted characters in a naive CRDT are often kept as "tombstones" (marked deleted, not removed) so concurrent operations can still reference them. Over a long-lived, heavily-edited document, tombstones accumulate forever.

**Counter:** Periodic **garbage collection**: once you're confident no client has an in-flight operation older than a certain point (tracked via version vectors), you can safely compact tombstones out of the structure and write a clean snapshot to Postgres, keeping only the op-log after that point for replay.

### 8.5 Horizontal scaling correctness
**Problem:** If a document's editors are split across two server nodes, how do you guarantee both nodes' in-memory CRDT states stay identical?

**Counter:** Every operation applied locally is also published to a Redis channel keyed by document ID. Every node subscribes to channels for documents it currently has open. This means a node never needs to "own" a document exclusively — it just needs to apply every operation exactly once, which the operation's unique ID makes idempotent (an operation with an ID you've already applied is simply ignored).

### 8.6 Presence/cursor state churn
**Problem:** Cursor position updates fire on every keystroke or click — broadcasting all of them to every client is wasteful and can flood the connection.

**Counter:** Throttle/debounce cursor broadcasts (e.g., max 10/sec per user) and treat presence as **ephemeral** — never persisted, never part of the op-log, just a lightweight separate WebSocket message type that's fine to drop under load.

## 9. Data model (Postgres)

```
documents
  id, title, owner_id, created_at

operations (append-only op-log)
  id, document_id, client_id, logical_clock, op_type (insert/delete),
  char_id, ref_id (ID this was inserted after), value, created_at

snapshots
  id, document_id, state_blob (serialized CRDT state), version_vector, created_at

document_access
  document_id, user_id, role (owner/editor)
```

## 10. Milestones

| Week | Deliverable |
|---|---|
| 1 | CRDT core logic implemented and unit-tested in isolation (no networking yet) — insert, delete, merge, convergence tests with simulated random operation orderings |
| 2 | Single-server WebSocket sync working — two browser tabs editing the same doc, live |
| 3 | Auth, document list, persistence (op-log + snapshot), reconnect/offline merge |
| 4 | Horizontal scaling — Redis pub/sub, deploy 2+ backend instances behind a load balancer, verify cross-node sync works |
| 5 | Presence/cursors, polish UI, deploy live, write up the architecture (blog post or detailed README) |

## 11. How to talk about this in an interview

- Lead with the convergence guarantee: *"I implemented a CRDT so that regardless of network delivery order, every client's document converges to an identical state — I wrote property-based tests that apply randomly-ordered operation sequences and assert the final state always matches."*
- Have the horizontal-scaling story ready: *"Initially two users on the same server synced fine, but I realized the moment I scaled to multiple server instances, users on different nodes would diverge — that's what pushed me to add Redis pub/sub for cross-node broadcast, with idempotent operation application so duplicate delivery doesn't corrupt state."*
- Be ready to draw the RGA structure on a whiteboard — a linked list of characters where each node has a stable ID and a reference to its predecessor's ID.

## 12. Success metrics (for your own validation, not a real product)

- Convergence test suite: 1000+ randomized concurrent operation sequences all converge to identical state across simulated clients.
- Two real browser clients editing simultaneously show <200ms perceived edit latency on a normal connection.
- Killing one backend instance mid-session (with 2+ instances running) does not lose data or desync remaining clients.

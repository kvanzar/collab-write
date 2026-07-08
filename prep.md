# CollabWrite — Interview Prep Document

*Everything you need to explain, defend, and whiteboard this project in an SDE interview.*

---

## 1. The 30-second pitch

> **In beginner terms:** Imagine Google Docs, but you built the "many people can edit at once without breaking things" part yourself, instead of importing someone else's ready-made solution. The hard problem in any multi-user editor: what happens when two people type in the *same spot* at the *same time*? Whose change wins, and how do you guarantee everyone ends up looking at the exact same final document? The trick used here is a special data structure (a **CRDT**) where every single character gets its own permanent, unique "ID card." Instead of saying "insert at position 5" (which breaks the instant someone else edits before position 5), an edit says "insert this right after the character with ID card #123" — an instruction that never goes stale. Two words worth knowing before reading on: **commutative** just means *order doesn't matter* (like `2+3` and `3+2` both equal 5), and **idempotent** means *doing something twice has the same effect as doing it once* (like pressing an elevator's "close door" button twice — nothing extra happens). Once your data structure has both properties, you stop needing special-case code for "what if messages arrive out of order" or "what if the same message arrives twice" — it just works, automatically.

> "CollabWrite is a real-time collaborative text editor — think a minimal Google Docs — where I implemented the conflict-resolution engine from scratch instead of importing a library. It's built on an RGA CRDT (Replicated Growable Array): every character has a globally unique ID, and edits reference identities instead of positions, so any number of users can type simultaneously — even offline or across different server instances — and every replica provably converges to identical text. The backend scales horizontally: N Node.js instances share state through Redis pub/sub, with an append-only op-log and periodic snapshots in Postgres. I fuzz-tested convergence with hundreds of randomized, fully-shuffled operation orderings."

If they ask "what's the hardest part?": *"Designing the data structure so that applying operations is **commutative and idempotent** — once you have that, out-of-order delivery, duplicate delivery, offline merge, and multi-node scaling all stop being special cases."*

---

## 2. System architecture

```
Browser (React + CodeMirror 6)
  │  one origin: HTML + REST + WebSocket
  ▼
[Load balancer]  (prod; sticky sessions optional — NOT required for correctness)
  │
  ├── Collab Node 1 (Express + ws) ──┐
  │     in-memory RGADocument per     ├── Redis Pub/Sub ── channel per docId
  ├── Collab Node 2 ─────────────────┘    (ops + ephemeral presence)
  │
  ▼
PostgreSQL
  ├─ operations   (append-only op-log, UNIQUE(doc, client, clock))
  ├─ snapshots    (state blob + version vector + log cut point)
  ├─ users / documents / document_access
  └─ session      (connect-pg-simple — sessions shared across nodes)
```

> **In beginner terms:**
> - **Browser** = the user's tab, running the React app.
> - **WebSocket** = think of it as a phone call that stays connected, instead of the usual "send a letter, wait for a reply" pattern of a normal web request (REST). This lets the server *push* new edits to you the instant they happen, instead of you having to keep asking "anything new yet?"
> - **Load balancer** = a traffic cop sitting in front of your servers, spreading incoming users across multiple machines so no single one gets overwhelmed.
> - **Redis Pub/Sub** = a group chat between your servers. One server "publishes" a message to a named channel, and every other server "subscribed" to that channel instantly gets a copy — this is how Server 1 tells Server 2 "someone just typed a character" without the two servers sharing memory directly.
> - **PostgreSQL** = the permanent, reliable database — the single source of truth that survives restarts (unlike each server's in-memory copy of a document, which vanishes if that server crashes).
> - **op-log** = literally a diary table where every single edit ("operation") that has ever happened gets written down, in order, forever. "Append-only" means you only ever *add* rows — you never rewrite or delete old ones.
> - **snapshot** = a periodic "save point," like a video-game checkpoint, so a restarting server doesn't have to replay every edit since the document was created — it just loads the latest checkpoint and replays only what happened after it.
> - **Monorepo / npm workspaces** = instead of three separate repos for the CRDT logic, the server, and the frontend, they all live together in one repo as three "packages" that can import each other's code directly — see why that matters below.

**Monorepo layout (npm workspaces):**

| Package | Role |
|---|---|
| `packages/crdt-core` | The CRDT + wire protocol. Shared by client AND server — one implementation, zero drift. |
| `packages/server` | Stateless-ish collab node: rooms, persistence, pub/sub, auth, serves built frontend in prod. |
| `packages/web` | React + CodeMirror client: editor binding, remote cursors, login/doc UI. |

**Why the CRDT is a shared package:** client and server both hold replicas and both run `apply()`. If they had separate implementations, one divergent edge case would silently corrupt documents — the exact bug class CRDTs exist to eliminate. (Interviewers love this point: it's a *correctness* argument for a build-system decision.)

---

## 3. The life of a keystroke (memorize this walkthrough)

> **In beginner terms:** In short — you type a letter → your browser turns that into a small structured "instruction" (not "put X at position 5", but "put X right after this *specific* other character") → that instruction travels to a server over the always-open WebSocket connection → the server saves it permanently in the database and also broadcasts it to any other servers via Redis → every other user's browser receives that instruction, updates its own internal copy of the document, and refreshes what's shown on screen. Every ~200 edits, the server also saves a checkpoint (snapshot) so it never has to replay the *entire* history from edit #1 if it restarts. Now the detailed, step-by-step version:

User types "x" at cursor position 5 in their browser:

1. **CodeMirror** fires an update. The update listener checks it's not a remote-tagged transaction (no echo loops), then calls `doc.localInsert(5, "x")`.
2. **The replica** finds the visible char at index 4, uses its ID as the *reference*, increments its Lamport clock, creates `{id: (myClientId, clock), value: "x", afterId: refId}`, applies it locally, returns the op.
3. **The op is sent** over the WebSocket: `{type: "op", op}`. Note: what travels is *identity-based* ("after char X"), never index-based.
4. **The server node** applies the op to its own in-memory replica (idempotent), **persists it to the Postgres op-log** (`ON CONFLICT DO NOTHING` on the op's unique identity), fans it out to other local sockets, and **publishes it to Redis** channel `doc:{id}`.
5. **Peer nodes** subscribed to that channel apply it to their replicas (memory only — the receiving node already persisted it) and fan out to their local sockets.
6. **Every other client** receives it, calls `doc.apply(op)` — the RGA insert algorithm finds the reference char and skips past any concurrent inserts that win the deterministic tie-break — then updates the editor via a minimal text diff dispatched as a remote-tagged transaction.
7. Every ~200 persisted ops, the server writes a **snapshot** (full op history + version vector + op-log cut point) so recovery never replays from op #1.

---

## 4. CRDT deep dive

### 4.1 Why CRDT over OT (guaranteed question)

> **In beginner terms:** There are two competing philosophies for "how do multiple people edit the same document at once": **OT (Operational Transformation)** and **CRDT**.
> - OT's idea: when an edit arrives, mathematically *adjust* it based on other edits that happened at the same time, so it still makes sense in context. This needs a referee (usually one central server) to decide the official order of edits, and the "adjustment math" is famously tricky to get exactly right — real published OT algorithms have had bugs discovered years later.
> - CRDT's idea: instead of adjusting edits after the fact, design the data itself so it simply *does not matter* what order edits arrive in — you always land on the same final result. The trade-off is you carry a little more metadata per character (those permanent ID cards), but the actual merge logic stays simple and is easy to prove correct.
>
> Analogy: OT is like resolving a scheduling clash by constantly renegotiating meeting times through a mediator. CRDT is like everyone already having a fixed, unchangeable timestamp on their request, so the correct order is obvious to everyone without any negotiation at all.

| | Operational Transformation | CRDT |
|---|---|---|
| Core idea | Transform incoming ops against concurrent ones before applying | Design the data so ANY merge order gives the same result |
| Needs central sequencing server? | Typically yes | No — works peer-to-peer |
| Correctness burden | Transformation functions are notoriously hard to prove correct (published OT algorithms have had bugs found years later) | Each operation's merge logic is simple; cost is metadata/memory overhead |
| Used by | Google Docs (historically) | Figma, Notion, Yjs/Automerge ecosystem |

**My answer:** "OT's complexity lives in the transformation functions — quadratic pairs of op types to get right, and the server must sequence everything. CRDT moves the complexity into the data structure once: unique stable IDs. I chose CRDT because a solo developer can actually *prove it correct with property tests*, and because it makes horizontal scaling almost free — no sequencer to shard."

Also know: **why not just import Yjs?** "The point was to understand and be able to defend the convergence guarantee. I referenced Yjs's design (their pending-struct buffering, their client-clock scheme) but implementing RGA myself is what lets me answer everything below."

### 4.2 The RGA structure

> **In beginner terms:** Every character you ever type gets a permanent "ID card" made of two things: *who* typed it (`clientId`) and *how many things that person has typed so far* (`clock`) — together, this combination never repeats, across any user, ever. Instead of saying "delete the letter at position 5" or "insert at position 5" (positions constantly shift as people type!), every operation refers to these permanent ID cards instead: "insert this new character right after the character with ID card #47" or "delete the character with ID card #12." Because ID cards never change even as the surrounding document changes, a reference to one never goes stale. Deleting a character doesn't actually erase it from memory — it just flips a `deleted: true` flag, leaving a "ghost" behind (explained in 4.5).

The document is a sequence of `Char` cells:

```ts
CharId  = { clientId: string, clock: number }          // globally unique, permanent
Char    = { id: CharId, value: string, afterId: CharId | null, deleted: boolean }
Operation = { type: "insert", char: Char }
          | { type: "delete", id: CharId, targetId: CharId }   // deletes have identity too!
```

- **Insert** says "put me after the character with ID X" (`afterId: null` = document start). Identity never moves, so the reference survives any concurrent edits.
- **Delete** marks `deleted: true` — a **tombstone**. The cell stays so in-flight ops referencing it still resolve.
- Deletes carry their own `(clientId, clock)` ID → every op is identifiable → dedupe and diff-sync work uniformly.

### 4.3 The insert algorithm (whiteboard this)

> **In beginner terms:** When a new character arrives with an instruction like "put me after character X," the algorithm (1) finds where X currently sits in the array, then (2) looks at whatever comes immediately after X — if something there should "win" a tie against the new character (using the rule below), it keeps stepping forward past those until it finds the true landing spot. This "skip rule" is what guarantees that even if Alice and Bob both insert right after the *same* character at the *same time*, everyone's document ends up with Alice's and Bob's characters in the same relative order — with nobody needing to ask anybody else; each computer just runs the same deterministic rule locally and independently arrives at the same answer.

```
integrateInsert(char):
  i = (char.afterId == null) ? 0 : indexOf(char.afterId) + 1
  while i < len && compareCharIds(chars[i].id, char.id) > 0:   # skip rule
    i++
  chars.insert(i, char)
```

```
compareCharIds(a, b):
  if a.clock != b.clock: return a.clock - b.clock     # causality first
  return a.clientId > b.clientId ? 1 : -1             # arbitrary but universal
```

> **In beginner terms (the tie-break rule):** When comparing two characters to decide their order: first check who typed "later" in logical time (the clock) — the earlier one goes first. If it's a genuine tie (both edits happened without either person having seen the other's edit yet — true concurrency), just compare the two people's client IDs alphabetically. It doesn't matter *which* rule you use to break the tie — it only matters that *every single computer applies the exact same rule*, so they all agree on the same answer without needing to communicate.

**Concrete example to draw:** Doc is empty. Alice types "AA" (ops A1,A2), Bob concurrently types "BB" (B1,B2). Both have clock values 1,2 — pure tie on clocks, clientId breaks it ("bob" > "alice", so Bob's chars win the skip race). Every replica computes "BBAA", *regardless of arrival order*. Walk both orders on the whiteboard.

**Why compare clock first, clientId second?** The Lamport clock encodes causality: if Bob typed *after seeing* Alice's char, his clock is strictly higher, and RGA's skip rule then places causally-newer inserts closer to their reference — which keeps one user's consecutive keystrokes contiguous (no "ABAB" interleaving of two users' words). ClientId only breaks true concurrent ties, where the winner doesn't matter — only that everyone picks the *same* winner.

### 4.4 Lamport clocks

> **In beginner terms:** A Lamport clock is not a real wall clock — it's just a counter each person keeps that goes up every time they make an edit, and jumps forward whenever they learn about someone else's edit that's "further ahead" than their own count. Why not just use real timestamps (like `Date.now()`)? Because different computers' clocks are never perfectly in sync — computer A's "3:00:01.500" might actually be earlier or later in real cause-and-effect terms than computer B's "3:00:01.500" (this is called *clock skew*). A Lamport clock instead captures "happened-before" relationships directly: if you only found out about my edit and *then* made your own edit, your clock number is guaranteed to end up higher than mine. That's exactly the information the tie-break rule above needs.

- Increment on every local op.
- On receiving any op: `clock = max(clock, op.clock)` — never fall behind what you've seen.
- Guarantee: *if op B was created after its author had seen op A, then B.clock > A.clock.* That's exactly the property the tie-break needs. Wall-clock time can't give you this (skew); a per-client counter alone can't either (no cross-client ordering).

### 4.5 Tombstones (PRD's memory problem)

> **In beginner terms:** When you "delete" a character, the system doesn't actually erase it from the array — it just marks it invisible (`deleted: true`) and leaves a ghost behind, called a **tombstone** (like a gravestone marking where something used to be, instead of removing all trace it ever existed). Why keep the ghost around? Because someone else, at the exact same moment, might send an instruction like "insert my new character right after that character" — referring to the very one you just deleted! If it had been truly erased, that instruction would have nowhere to point and the system would break or crash. The tombstone still exists (just hidden from view), so the reference still resolves correctly. The downside: a document's memory footprint only ever grows, even for "deleted" text — real cleanup (garbage collection) is honestly labeled as future work below, not yet built.

- **Why keep deleted chars:** someone's in-flight op may say "insert after char X" where X was just deleted elsewhere. Remove X physically → dangling reference → divergence or crash. Test case: Alice deletes 'b' in "abc" while Bob concurrently inserts after 'b' → both converge to "aXc" because the tombstone still resolves.
- **The cost:** memory grows forever in a long-lived doc.
- **The counter (not yet implemented — say so honestly):** garbage collection using version vectors: once every client's vector shows they've seen past op N, no in-flight op can reference tombstones older than N → compact them out and write a clean snapshot. "I designed for it — vectors and snapshots are already there — but GC is future work."

### 4.6 Out-of-order delivery: the pending buffer

> **In beginner terms:** Imagine an instruction says "insert this after character X," but character X hasn't actually arrived at your computer yet — maybe it's delayed on the network, still in transit. Instead of guessing or erroring out, the system politely puts that instruction in a "waiting room" (a lookup map keyed by the ID it's waiting for). The moment X finally arrives, the system checks the waiting room, finds anything that was waiting on X, and applies it right away — and if *that* thing was itself being waited on by something else, the unlock cascades forward like a chain of dominoes. This means the network is free to deliver messages in any order at all, or even duplicate them, and the document still ends up correct.

`apply()` refuses to guess: if an insert's `afterId` (or a delete's target) isn't known yet, the op is **parked** in a map keyed by the missing ID. When that char later arrives, `drainPending()` re-applies the parked ops — cascading (op C waiting on B waiting on A unwinds when A arrives). This is *causal delivery implemented in the data structure* — no ordering demanded from the transport. Yjs does the same ("pending structs").

Each op has exactly ONE causal dependency (insert → its reference; delete → its target). That minimalism is why this is ~30 lines.

### 4.7 Version vectors & diff sync (reconnect/offline)

> **In beginner terms:** A version vector is like a little receipt: "here's the highest edit-counter number I've seen from each person." When you reconnect after being offline, you send your receipt to the server, and the server compares it against its own — anything in the server's history that your receipt doesn't cover gets sent to you (that's what you missed), and anything in *your* history the server's receipt doesn't cover gets sent back to the server (your offline edits). This is essentially the same idea as `git fetch` + `git push`: compare two histories and exchange exactly the difference, nothing more, nothing less.

```
VersionVector = { [clientId]: highestClockSeen }
opsSince(vector) = every op in my history whose (clientId, clock) the vector doesn't cover
```

**The reconnect handshake (bidirectional diff, like git fetch+push):**
1. Client connects: `join {docId, vector: myVector}`
2. Server replies: `sync {ops: server.opsSince(clientVector), vector: serverVector, peers}`
3. Client applies those, then pushes back `client.opsSince(serverVector)` — its offline edits.

**Key design consequence — no outbox:** the PRD suggested queueing offline edits in an outbox. I realized the version-vector exchange subsumes it: offline ops are already in the replica's history, and the handshake delivers exactly the diff. One mechanism covers cold start, reconnect, and offline merge. Idempotent apply makes accidental re-sends a non-event.

**Soundness caveat (if pressed):** "max clock seen" summarizes correctly when each sender's ops arrive in order (true here: TCP per client, server log replay in order). The pending buffer is defense-in-depth for anomalies.

### 4.8 The three properties, named

> **In beginner terms — the three "superpowers" that make all of this work:**
> 1. **Commutative** — apply edit A then B, or B then A: same final result. Order doesn't matter.
> 2. **Idempotent** — applying the exact same edit twice has the same effect as applying it once. Duplicates are harmless.
> 3. **Deterministic tie-break** — when two edits are genuinely simultaneous, every computer independently picks the *same* winner, without needing to ask each other.
>
> Put these three together and you get a system with no central authority deciding "the official order" — every computer just applies whatever it receives, whenever it receives it, and they're all mathematically guaranteed to end up agreeing.

- **Commutative:** apply(A) then B == apply(B) then A → out-of-order safe.
- **Idempotent:** applying the same op twice == once → duplicate-delivery safe (in-memory `applied` set; in Postgres, the UNIQUE constraint).
- **Deterministic tie-break:** all replicas order concurrent inserts identically → no negotiation, no coordinator.

Convergence claim: after all replicas have received all ops, states are identical. Backed by fuzz tests, not just argument.

---

## 5. Sync protocol (wire format)

> **In beginner terms:** This is just the "vocabulary" of messages flowing over the WebSocket connection, in both directions. `join` = "let me into this document, here's what I've already seen." `op` = "here's one single edit." `presence` = "here's where my cursor currently is" (for showing other people's cursors, like Google Docs' colored cursor labels). The server's replies mirror these back. The key distinction: `op` messages are precious and permanent — saved to the database, never lost. `presence` messages are throwaway — if you miss one, the very next one replaces it with no harm done, so they're never written to the database at all.

```
Client → Server:
  join     {docId, vector}                 — enter room + request diff
  op       {op}                            — one CRDT operation
  presence {peer: {clientId,name,color,cursor}}   — throttled, droppable

Server → Client:
  sync           {ops, vector, peers}      — reply to join
  op             {op}
  presence       {peer}
  presence-left  {clientId}
```

JSON over a single WebSocket. Ops are durable and idempotent; presence is ephemeral (never persisted, never in the op-log — verified by a test that counts op-log rows).

---

## 6. Persistence design

> **In beginner terms:**
> - **Tables** = the database's "spreadsheets" — `users` (who has an account), `documents` (which docs exist), `document_access` (who can edit which doc), `operations` (the permanent diary of every edit), `snapshots` (checkpoints), `session` (who's currently logged in, so login survives page refreshes and works across different servers).
> - **JSONB** = a way to store a flexible, structured object (like a whole JavaScript object) directly in a single Postgres column, instead of forcing it into rigid rows/columns. Handy here because an "operation" can be shaped differently for an insert vs. a delete, and you don't want to redesign the database schema every time the operation shape changes.
> - **UNIQUE constraint** = a rule you give the database: "never allow two rows with the same combination of (document, client, clock) to exist." This is the real safety net — even if the exact same edit gets sent to the database twice (say, two servers both tried to save it), the database itself refuses the second attempt, guaranteeing each edit is stored exactly once.
> - **Exactly-once persistence** = making sure an edit is written to the permanent database exactly one time — not zero times (data loss) and not multiple times (wasted space/confusion).

**Tables:** `users`, `documents`, `document_access(role: owner/editor)`, `operations`, `snapshots`, `session`.

**Op-log (`operations`):** append-only; identity columns `(document_id, client_id, logical_clock)` with a UNIQUE constraint + the full op as JSONB. Two reasons for JSONB: the stored op is byte-identical to the wire op (no lossy mapping), and schema evolution is easy. The identity columns exist for the constraint and indexed lookups.

**Durable idempotency:** the in-memory dedupe set dies with the process. The DB UNIQUE constraint survives restarts and protects against two nodes racing to persist the same op. `ON CONFLICT DO NOTHING RETURNING id` tells us in one round-trip whether we were first.

**Snapshots:** every N=200 persisted ops, write `{state_blob: full op history, version_vector, last_op_id}`. Cold-start hydration = latest snapshot + `operations WHERE id > last_op_id` — never replay from op #1. (Honest note if asked: the snapshot currently stores op history, same asymptotic size as the log tail it replaces; a compacted char-array snapshot is the natural next step and pairs with tombstone GC.)

**Exactly-once persistence with multiple nodes:** only the node that received the op from its client writes it to Postgres; peer nodes apply to memory only. The UNIQUE constraint is the backstop if that ever double-fires.

**Room lifecycle:** rooms hydrate lazily on first join (a `Map<docId, Promise<Room>>` so concurrent joiners share one hydration — no race), and evict when the last socket leaves (unsubscribe Redis, drop memory; Postgres has the durable copy).

---

## 7. Horizontal scaling (Week 4 story — tell it as a narrative)

> **In beginner terms:** "Horizontal scaling" means handling more users by adding more server machines, as opposed to "vertical scaling" (making one server machine bigger/faster). The tricky part: if you have two separate server processes, each keeps its own in-memory copy of a document. If User A talks to Server 1 and User B talks to Server 2, and neither server tells the other what happened, their copies of the document silently drift apart and never match again. The fix is Redis Pub/Sub acting as a shared "town crier" between servers — whenever any server receives an edit, it shouts it out on a Redis channel, and every other server listening picks it up and applies it to its own copy too. Because the underlying CRDT already tolerates duplicate and out-of-order messages (§4.8), the servers don't need Redis to guarantee perfect delivery — "good enough, fire-and-forget" messaging is fine, because anything missed gets healed later by the reconnect/sync handshake (§4.7).

> "Two users on one server synced fine. The moment there are two server instances, users on different nodes would silently diverge — each node has its own in-memory replica. So every op a node receives is published to a Redis channel keyed by document ID (`doc:{uuid}`); every node with that doc open subscribes and applies. Because apply is idempotent and commutative, I don't need Redis to be exactly-once or ordered — duplicates are no-ops and reordering is already handled. Each publish is tagged with a node UUID so a node ignores its own echoes."

- **Sticky sessions:** an *optimization* (keeps a client's room hot on one node), never a correctness requirement — sessions are in Postgres, ops flow through Redis+Postgres, so any node can serve anyone.
- **Kill test (PRD success metric):** kill a node mid-edit → its clients auto-reconnect (1s backoff) → LB routes them to a survivor → join/sync vector exchange replays anything missed → nothing lost, because *persist happens before broadcast*.
- **Redis pub/sub is fire-and-forget** (no persistence, at-most-once). Why is that OK? Any gap a client suffers is healed by the next sync handshake against the durable log. You *engineer around* delivery guarantees instead of paying for stronger ones.

**Presence across nodes** rides the same channels with `kind: "presence"` payloads; nodes track remote peers in memory only.

---

## 8. Auth & security

> **In beginner terms:**
> - **OAuth (Google login)** — instead of building your own username/password system, you let Google verify who the user is. The flow: your app redirects the user to Google's login page → user approves → Google sends your server back a temporary "authorization code" → your server exchanges that code, server-to-server, for the user's actual profile → you create or find a matching user account. This means your app never sees or stores the user's Google password.
> - **Session / cookie** — after login, the server hands the browser a small token (a cookie) that says "you're logged in as user #42." The browser automatically sends this back on every future request, so the user isn't asked to log in on every page. Storing sessions in Postgres (rather than a single server's memory) matters here specifically because with *multiple* servers, any server needs to recognize any user's cookie — not just the one they originally logged in through.
> - **httpOnly / sameSite / secure** — three cookie safety flags: `httpOnly` stops JavaScript from reading the cookie (blocks a common attack where injected malicious script steals your session), `sameSite=lax` stops other websites from silently reusing your cookie, `secure` means the cookie is only ever sent over HTTPS, never plain HTTP.
> - **WebSocket auth "at the HTTP upgrade"** — a WebSocket connection actually starts life as a normal HTTP request that gets "upgraded" into a persistent connection. This project checks the user's login cookie right at that upgrade moment, before the WebSocket is even allowed to open, so an unauthenticated user's connection is rejected immediately instead of being let in and checked later (a mistake many real apps make).
> - **The Passport singleton bug** — a genuinely interesting real bug: the login library (Passport) keeps some setup in one shared global object by default. When tests started several "fake servers" inside a single test process, they all accidentally shared that one global object, and the *first* server's now-dead database connection stayed wired in for everyone → random 500 errors elsewhere. The fix was giving each server instance its own fresh Passport object instead of sharing the global one. Good story because it only shows up when you test multiple server instances together, not a single one.

- **Google OAuth** via Passport (authorization-code flow: redirect → consent → callback with code → server exchanges for profile → find-or-create user). Falls back to a name-only **dev login** that refuses to run in production.
- **Sessions:** cookie-based (`httpOnly`, `sameSite=lax`, `secure` in prod), stored in **Postgres** via connect-pg-simple → survive restarts, valid on every node. Session stores only the user id; the user row is re-read per request.
- **The WebSocket is authenticated at the HTTP upgrade:** the same express-session middleware runs against the upgrade request; no session → socket destroyed with 401 *before* any room access. (Common real-world gap — worth volunteering.)
- **A subtle bug I fixed (great story):** Passport is a module-level singleton and `deserializeUser` registrations *accumulate*. Booting several server instances in one process (integration tests) left the first instance's dead DB pool wired into everyone's session path → 500s. Fix: per-instance `new passport.Passport()`. Invisible in single-process prod, fatal in multi-node tests — an argument for integration-testing your *architecture*, not just your logic.
- **Sharing model (stated simplification):** any authenticated user who opens a doc URL is granted editor access ("anyone with the link"). The `document_access` table with roles exists, so per-user ACL enforcement is a small change: check membership on join instead of upserting it.
- Ops are NOT attributed to authenticated users server-side (clientId is client-chosen) — honest limitation; fix = bind clientId to session at join, stamp server-side.

---

## 9. Presence (Week 5)

> **In beginner terms:** "Presence" just means showing other people's live cursors and who's currently viewing the doc — the colored cursor labels you see in Google Docs. The clever bit: a cursor's position is stored as "I'm right after the character with ID X" (not "I'm at position 47"), for the exact same reason edits use IDs instead of positions — if it used a plain number, the moment anyone typed before that spot, everyone's cursor labels would jump to the wrong place. Presence updates are also throttled (capped at ~10 per second) so a fast typer doesn't flood the network with cursor-position spam, and they're "ephemeral" — never saved to the database — because if you miss one, the very next update makes it irrelevant anyway.

- **Cursor = CRDT anchor, not index:** `{afterId: CharId | null}` — "my cursor sits after char X". A numeric index goes stale the moment anyone types before it; an identity anchor survives concurrent edits. Every client resolves the anchor against its own replica (`visibleIndexOfId + 1`). If the anchor char was deleted → hide until the next update (self-healing since updates are frequent).
- **Throttled** to max ~10/sec (100ms leading+trailing throttle) per PRD §8.6.
- **Ephemeral by design:** separate message type; never persisted; safe to drop (next update supersedes). Verified by a test asserting the op-log row count is unaffected by presence traffic.
- **Rendering:** CodeMirror `StateField<DecorationSet>` of widget decorations. Between presence updates, `decorations.map(tr.changes)` shifts cursors along with text edits — the same position-mapping machinery CodeMirror uses for the local selection.
- Late joiners get current peers in the `sync` reply; disconnect broadcasts `presence-left` (locally + via Redis).

---

## 10. The editor binding (CodeMirror ↔ CRDT)

> **In beginner terms:** CodeMirror is the actual text-editing widget shown in the browser (handles cursors, syntax highlighting, etc.) — a separate library from the CRDT logic, so this section is about wiring the two together correctly.
> - **Echo loop problem** — when a remote edit arrives and the code tells CodeMirror to update its text, that update itself fires CodeMirror's "something changed" event. If not handled carefully, that could be mistaken for a *new local edit* and get sent right back out, causing an infinite loop or duplicate work. The fix "tags" system-generated updates with a hidden marker, so the code can tell "this change came from applying a remote edit" apart from "this change is the user actually typing."
> - **Local → CRDT** — when the user types, CodeMirror reports what changed as `(from, to, insertedText)`; this gets translated into the CRDT's ID-based operations.
> - **Remote → editor** — when a remote edit arrives, rather than crudely replacing the entire text (which would reset the user's cursor/scroll position), the code computes the smallest possible diff and applies just that tiny patch, so editing stays smooth even while other people are typing.

- **The cardinal rule — no echo loops:** remote-originated editor transactions are tagged with an `Annotation`; the update listener skips tagged transactions. (y-codemirror uses the identical pattern.)
- **Local → CRDT:** precise translation. Each change gives `(from, to, inserted)` in *pre-change* coordinates; process changes back-to-front so earlier positions stay valid; a replacement = deletes (back-to-front) then inserts.
- **Remote → editor:** apply op to replica, then compute a **minimal diff** (common prefix/suffix trim) between editor text and replica text, dispatch one transaction. Always correct even when ops were parked/batched; CodeMirror maps the user's cursor across it.
- Editor thinks in *visible* indexes; the CRDT array includes tombstones — `visibleIndexOfId` / `charIdAtVisibleIndex` translate at the boundary.

---

## 11. Testing strategy (memorize the numbers)

> **In beginner terms:** Most tests you've probably written check one specific example ("if I do X, I expect Y"). "Fuzz testing" (also called property-based testing here) instead generates hundreds of *random* scenarios and checks that a general rule always holds — in this case, "no matter what random order these edits arrive in, every replica ends up with the identical final text." This matters because the actual claim being made ("this system converges correctly") is a claim about *every possible ordering*, not just a few orderings someone thought to write by hand — so testing it with hundreds of randomized attempts gives far more confidence than a handful of manually written examples.

**21 tests total.**

*crdt-core (15):* comparator properties (antisymmetry, ordering); single-replica editing; concurrent same-position inserts converge with keystrokes contiguous; insert-after-concurrently-deleted-char (tombstone proof); triple-duplicate delivery; reverse-order chain delivery; delete-before-insert parking; **300 fuzz rounds** of two clients editing concurrently + random per-receiver interleavings across three replicas; **300 fuzz rounds** of fully-shuffled (no ordering guarantee at all) delivery, asserting `pendingCount() == 0` (no stranded ops); version-vector diff exchange; visible-index/tombstone accounting.

*server (6, against real Postgres + real Redis):* REST + WS both reject unauthenticated access; login/create/list flow; **restart durability** (kill node, fresh node hydrates from snapshot + log tail); **durable idempotency** (op re-sent 3× → one op-log row); same-node presence (late joiner gets peers in sync; cursor anchored to CharId; leave notification; op-log untouched by presence); **two nodes, one client each, converge through Redis**.

**Why fuzz/property tests over examples:** convergence is a *universal* claim ("for all orderings"), so test the property, not instances. 600 randomized rounds ≈ the PRD's "1000+ randomized sequences" success metric.

---

## 12. Likely questions & strong answers

> **In beginner terms:** This section is the rehearsed answer bank. For each question below, make sure you could explain the *why* out loud in your own words — not just recite it — since interviewers usually follow up with "why" or "what if" on whatever you say first.

**Q: Prove convergence / why does the skip rule work?**
Sketch: all replicas eventually hold the same *set* of chars (same ops applied, set union is order-independent). Position of each char is a pure function of that set: its reference chain + the total order `(clock, clientId)` among siblings. Lamport clocks make causally-later inserts sort deterministically relative to earlier ones; the tie-break is total. Same set + same deterministic ordering = same sequence. The fuzz tests are the empirical backstop.

**Q: Complexity?**
Insert: O(n) worst case (indexOf scan + skip) with array `splice`. Fine for documents in the tens-of-thousands of chars. Real editors (Yjs) use item-run trees: O(log n) and run-length compression of consecutive chars — my stated next optimization. Memory: O(inserted chars incl. tombstones) until GC.

**Q: Why one char per op? Isn't that wasteful?**
Correct and simple first; the optimization (batching a run of keystrokes into one op with a char array, or Yjs-style item runs) is mechanical once single-char is proven. Wire overhead is mitigated by WebSocket frame batching in practice.

**Q: Undo/redo in multi-user? (PRD stretch)**
Naive undo (re-insert what I deleted) can resurrect text someone else deleted — wrong. Correct approach: per-user undo stack of *inverse operations* scoped to that user's own ops, where undo of an insert = delete(thatCharId), and undo of a delete = re-insert with a NEW id after the same reference. Hard parts: redo identity chains and interleaving with concurrent edits.

**Q: Rich text?**
Formatting as ranges anchored to CharIds (like comments), or per-char attribute maps with LWW registers per attribute. Multiplies CRDT complexity — that's why the PRD cut it from MVP.

**Q: What if Redis goes down?**
Nodes keep serving their local clients; cross-node real-time sync pauses. No data loss (Postgres persists everything). Heal on Redis return or client reconnect (vector sync). Detection/alerting would be the production add.

**Q: What if Postgres goes down?**
Current behavior: op persistence fails → that's the availability boundary. Mitigation options: queue-and-retry buffer with backpressure, or accept-and-replicate with async persistence (weaker durability window) — discuss trade-off (CP-ish vs AP-ish for the persistence path).

**Q: Two clients pick the same clientId?**
UUIDv4 per tab — collision probability negligible. Hardening: server binds clientId to the authenticated session at join and rejects mismatches.

**Q: How big can a document get before this hurts?**
Array-based replica: ~10⁵ chars is comfortable, 10⁶ starts hurting (O(n) integrate + full-text diff per remote op). Fixes in order: tree structure, run-compression, tombstone GC, then PRD's "selective sync" (ship snapshot + recent tail, not full history).

**Q: Why WebSocket over SSE/polling/WebRTC?**
Bidirectional low-latency ops both ways (SSE is one-way, polling adds latency and load). WebRTC P2P is interesting for CRDTs (no server relay needed for correctness!) but NAT traversal + persistence + auth still want a server; complexity not justified.

**Q: Security holes you know about?**
Rate limiting (op flooding), payload validation of op shape (a malicious client could send malformed CharIds), clientId spoofing (above), no per-doc ACL enforcement beyond auth (stated demo policy). I'd add zod validation at the ws boundary + per-session rate limits first.

**Q: What was the hardest bug?**
Two candidates, both true: (1) the Passport singleton/multi-instance bug (§8) — architecture-level, only visible in multi-node tests; (2) getting the editor↔CRDT binding echo-free while translating multi-change transactions back-to-front (§10).

**Q: What would you do differently?**
Item-run tree from the start (perf); snapshot as compacted state rather than op history; server-attributed ops; and I'd add tombstone GC before calling it production-ready. None block the demo; all are designed-for.

---

## 13. Whiteboard drills (practice these)

1. **Draw the RGA:** boxes `[id | value | afterId | deleted]` in a chain from HEAD; show an insert referencing a tombstoned char.
2. **Trace the AA/BB example** (§4.3) in both delivery orders → same result. This is THE demo of commutativity + deterministic tie-break.
3. **Draw the architecture** (§2) unprompted, then narrate the life of a keystroke (§3).
4. **Reconnect handshake:** two vectors, two `opsSince` arrows, offline edits flowing back.

## 14. Numbers & facts to have ready

- ~2.5k lines of TypeScript across 3 packages; 21 tests; 600 randomized convergence rounds.
- Snapshot every 200 ops; presence throttle 100ms; reconnect backoff 1s.
- Stack: TypeScript everywhere, React + CodeMirror 6, Express + ws, Postgres (pg), Redis (ioredis), Passport (Google OAuth 2.0), Vitest, Vite, npm workspaces.
- Postgres UNIQUE `(document_id, client_id, logical_clock)` = durable idempotency.
- Redis channel per document: `doc:{uuid}`; payloads tagged with node UUID to drop self-echo.
- PRD targets: <200ms perceived latency; survive node kill with zero loss; 1000+ randomized convergence sequences (met via 600 heavier rounds + integration tests).

## 15. Honest limitations (volunteer these before they're found)

> **In beginner terms:** As a fresher, it's tempting to hide anything you know is imperfect — resist that. Interviewers already know every real project has rough edges; what they're testing is whether *you* know where yours are and have a plan for them. Bringing these up yourself, unprompted, signals more seniority than pretending the project is flawless.

- Tombstone GC designed but not implemented (vectors + snapshots ready for it).
- O(n) integrate on an array replica; tree + run-compression is the known fix.
- Full-history snapshots (not yet compacted state).
- ClientId trusted from client; no op schema validation or rate limiting yet.
- "Anyone with the link" access policy (ACL table exists, enforcement is a small change).
- Presence of a crashed *node's* users can linger until those users' sockets are noticed gone (TTL heartbeat would fix).

*Owning limitations with the fix in hand reads as senior; hiding them reads as junior.*

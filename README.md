# CollabWrite

Real-time collaborative text editor built on a **hand-rolled RGA CRDT** —
multiple people type in the same document simultaneously and every replica
converges to identical state, regardless of network ordering, disconnects,
or which server node handled which edit.

See `collab-editor-prd.md` for the product/architecture plan,
`DEPLOYMENT.md` for deploying, and `prep.md` for a deep technical walkthrough.

## Features

- **Live multi-user editing** — CRDT-backed, sub-keystroke latency, provably convergent (fuzz-tested).
- **Presence** — colored remote cursors with name labels, anchored to CRDT character IDs so they stay correct through concurrent edits; avatar stack per document.
- **Offline & reconnect** — edits made while disconnected merge back automatically via version-vector diff sync.
- **Durable** — append-only op-log + periodic snapshots in Postgres; documents survive server restarts.
- **Horizontally scalable** — run N server nodes; Redis pub/sub keeps them converged (verified by integration tests).
- **Auth** — Google OAuth (when configured) or dev login; Postgres-backed sessions guard REST *and* the WebSocket upgrade.

## Packages

- `packages/crdt-core` — the RGA CRDT shared by client and server: unique char IDs, Lamport clocks, tombstoned deletes, pending buffer for out-of-order delivery, version vectors, wire protocol types.
- `packages/server` — Express + `ws` collab node: document rooms, op-log + snapshot persistence, Redis pub/sub, session auth, serves the built web app in production.
- `packages/web` — React + CodeMirror 6 client: CRDT↔editor binding, remote cursors, login/document UI.

## Run locally

Prereqs: Node 22+, PostgreSQL, Redis (both installable via Homebrew).

```bash
# one-time
createdb collabwrite && createdb collabwrite_test
cp packages/server/.env.example packages/server/.env   # optional: add Google creds

npm install

# terminal 1 — server node (add a second with PORT=3002 to demo scaling)
REDIS_URL=redis://localhost:6379 npm run dev:server

# terminal 2 — web client
npm run dev:web    # → http://localhost:5173
```

Open http://localhost:5173 in two browser windows, sign in with different
names, open the same document — live edits and both cursors appear.

## Test

```bash
npm test
```

Covers: CRDT convergence under fully-shuffled op delivery (600 randomized
rounds), duplicate delivery, tombstone semantics, version-vector diff sync,
REST auth, WebSocket auth rejection, restart durability, snapshot writing,
durable idempotency, same-node and cross-node presence, and two-node
convergence through real Redis.

# CollabWrite

Real-time collaborative text editor built on a hand-rolled RGA CRDT.
See `collab-editor-prd.md` for the full product/architecture plan.

## Packages

- `packages/crdt-core` — the RGA CRDT (shared by client and server): unique char IDs,
  Lamport clocks, tombstoned deletes, pending buffer for out-of-order delivery,
  version vectors for diff sync. Fully unit/fuzz tested.
- `packages/server` — WebSocket collab server (`ws`): one document room per doc ID,
  relays ops, syncs joiners via version-vector diff.
- `packages/web` — React + CodeMirror 6 client with the CRDT↔editor binding.

## Run it

```bash
npm install
npm run dev:server   # ws://localhost:3001
npm run dev:web      # http://localhost:5173
```

Open http://localhost:5173 in two browser windows and type — edits sync live.
Use a URL hash (e.g. `#notes`) to switch documents.

## Test

```bash
npm test             # all workspaces (CRDT convergence fuzz + server integration)
```

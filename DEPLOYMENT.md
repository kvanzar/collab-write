# Deploying CollabWrite

## Architecture choice: one service, one origin

The PRD sketches Vercel (frontend) + Railway (backend). We deliberately deploy
**a single Node service that serves the built React app itself** (the server
already does this: it statically serves `packages/web/dist` and falls back to
`index.html` for non-`/api` routes). Why:

- **No CORS, no cross-site cookies.** REST, WebSocket, and HTML share one
  origin, so the session cookie (`sameSite=lax`, `secure`, `httpOnly`) just
  works — including on the WebSocket upgrade. A split Vercel/Railway deploy
  needs `sameSite=none` cookies and a CORS allowlist, which is strictly more
  attack surface for zero benefit at this scale.
- Fewer moving parts to demo. Scaling the *collab* tier is what's
  interesting, and that still works: N instances of this one service.

## Recommended stack (all free tiers)

| Piece | Provider | Notes |
|---|---|---|
| App service(s) | Render or Railway | Both support WebSockets + horizontal scaling |
| PostgreSQL | Neon / Supabase / Railway | Set `DATABASE_URL` |
| Redis | Upstash | Set `REDIS_URL` (needed once you run 2+ instances) |

## Steps (Render example)

1. Push the repo to GitHub (done: `kvanzar/CRUD-multi-write`).
2. Create a **PostgreSQL** database (e.g. Neon). Copy its connection string.
3. Create an **Upstash Redis** database. Copy its `rediss://` URL.
4. Render → New → **Web Service** → connect the repo.
   - **Build command:** `npm install && npm run build --workspace @collab-write/web`
   - **Start command:** `npm start --workspace @collab-write/server`
   - **Environment variables:**
     - `NODE_ENV=production`
     - `DATABASE_URL=...` (from step 2)
     - `REDIS_URL=...` (from step 3)
     - `SESSION_SECRET=<long random string>` (`openssl rand -hex 32`)
     - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (see below)
     - `GOOGLE_CALLBACK_URL=https://<your-app>.onrender.com/api/auth/google/callback`
5. Deploy. The service serves the app, the API, and the WebSocket on one URL.
6. **To demo horizontal scaling:** raise the instance count to 2+. Render's
   load balancer will spread WebSocket connections across instances; Redis
   pub/sub keeps documents converged across them (this is exactly what the
   two-node integration test proves).

## Google OAuth setup

1. https://console.cloud.google.com → create a project.
2. **APIs & Services → OAuth consent screen**: External, add your app name;
   add yourself as a test user (no verification needed for testing).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application.**
   - Authorized JavaScript origin: `http://localhost:5173` (dev) and your
     production URL.
   - Authorized redirect URI: exactly `GOOGLE_CALLBACK_URL` — dev is
     `http://localhost:5173/api/auth/google/callback`.
4. Put the client ID/secret in `packages/server/.env` (dev) or the host's
   env settings (prod). When set, the login page automatically shows
   "Sign in with Google". Dev login disables itself when `NODE_ENV=production`.

## Production notes already handled in code

- Sessions are stored in **Postgres** (`connect-pg-simple`), not memory —
  restarts don't log users out, and any instance can validate any session.
- `trust proxy` is on, and cookies are `secure` in production (required
  behind Render/Railway's TLS-terminating proxy).
- `SESSION_SECRET` is refused-if-missing in production.
- Sticky sessions are an optimization, not a correctness requirement: any
  instance can serve any user (sessions in Postgres, ops in Redis/Postgres).

## Kill-test (PRD §12)

With 2+ instances running: kill one instance mid-edit. Clients attached to it
auto-reconnect (1s backoff), land on a surviving instance via the load
balancer, and the join/sync version-vector exchange replays anything missed.
Nothing is lost: every op was persisted before broadcast.

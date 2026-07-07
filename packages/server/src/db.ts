import pg from "pg";
import { opId, type Operation, type VersionVector } from "@collab-write/crdt-core";

export interface User {
  id: string;
  google_id: string | null;
  name: string;
  email: string | null;
}

export interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only op-log. The op's own (client_id, logical_clock) identity is
-- broken out into columns for the uniqueness constraint; the full payload
-- lives in JSONB so the wire format and the stored format never drift.
CREATE TABLE IF NOT EXISTS operations (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  client_id TEXT NOT NULL,
  logical_clock INTEGER NOT NULL,
  op JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, client_id, logical_clock)
);
CREATE INDEX IF NOT EXISTS operations_doc_idx ON operations (document_id, id);

CREATE TABLE IF NOT EXISTS snapshots (
  id BIGSERIAL PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  last_op_id BIGINT NOT NULL,
  state_blob JSONB NOT NULL,
  version_vector JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_doc_idx ON snapshots (document_id, id DESC);

CREATE TABLE IF NOT EXISTS document_access (
  document_id UUID NOT NULL REFERENCES documents(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor')),
  PRIMARY KEY (document_id, user_id)
);
`;

export class Db {
  readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---- users ----

  async findOrCreateGoogleUser(googleId: string, name: string, email: string | null): Promise<User> {
    const { rows } = await this.pool.query<User>(
      `INSERT INTO users (google_id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (google_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [googleId, name, email],
    );
    return rows[0];
  }

  async findOrCreateDevUser(name: string): Promise<User> {
    // Dev users are keyed by a synthetic email so re-login reuses the row.
    const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}@dev.local`;
    const { rows } = await this.pool.query<User>(
      `INSERT INTO users (name, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [name, email],
    );
    return rows[0];
  }

  async getUser(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<User>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0];
  }

  // ---- documents & access ----

  async createDocument(ownerId: string, title: string): Promise<DocumentRow> {
    const { rows } = await this.pool.query<DocumentRow>(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2) RETURNING *`,
      [title, ownerId],
    );
    await this.pool.query(
      `INSERT INTO document_access (document_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [rows[0].id, ownerId],
    );
    return rows[0];
  }

  async listDocuments(userId: string): Promise<DocumentRow[]> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT d.* FROM documents d
       JOIN document_access a ON a.document_id = d.id
       WHERE a.user_id = $1
       ORDER BY d.created_at DESC`,
      [userId],
    );
    return rows;
  }

  async getDocument(id: string): Promise<DocumentRow | undefined> {
    const { rows } = await this.pool.query<DocumentRow>(
      `SELECT * FROM documents WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** Demo sharing policy: any authenticated user who opens a doc becomes an editor. */
  async grantEditorAccess(documentId: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO document_access (document_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (document_id, user_id) DO NOTHING`,
      [documentId, userId],
    );
  }

  // ---- op-log & snapshots ----

  /**
   * Append one op. Returns the log row id, or null if this exact op was
   * already persisted (the unique constraint is the durable idempotency
   * guard — in-memory dedupe doesn't survive restarts).
   */
  async appendOperation(documentId: string, op: Operation): Promise<number | null> {
    const id = opId(op);
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO operations (document_id, client_id, logical_clock, op)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (document_id, client_id, logical_clock) DO NOTHING
       RETURNING id`,
      [documentId, id.clientId, id.clock, JSON.stringify(op)],
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async loadOpsAfter(documentId: string, afterOpId: number): Promise<Operation[]> {
    const { rows } = await this.pool.query<{ op: Operation }>(
      `SELECT op FROM operations WHERE document_id = $1 AND id > $2 ORDER BY id`,
      [documentId, afterOpId],
    );
    return rows.map((r) => r.op);
  }

  async latestSnapshot(
    documentId: string,
  ): Promise<{ last_op_id: number; state_blob: Operation[]; version_vector: VersionVector } | undefined> {
    const { rows } = await this.pool.query(
      `SELECT last_op_id, state_blob, version_vector FROM snapshots
       WHERE document_id = $1 ORDER BY id DESC LIMIT 1`,
      [documentId],
    );
    if (!rows[0]) return undefined;
    return { ...rows[0], last_op_id: Number(rows[0].last_op_id) };
  }

  async saveSnapshot(
    documentId: string,
    lastOpId: number,
    history: Operation[],
    vector: VersionVector,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (document_id, last_op_id, state_blob, version_vector)
       VALUES ($1, $2, $3, $4)`,
      [documentId, lastOpId, JSON.stringify(history), JSON.stringify(vector)],
    );
  }
}

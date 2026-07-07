export interface ServerConfig {
  port: number;
  databaseUrl: string;
  /** Optional — without it the node runs standalone (no cross-node sync). */
  redisUrl: string | undefined;
  sessionSecret: string;
  /** Write a snapshot every N persisted ops. */
  snapshotEvery: number;
  google:
    | { clientId: string; clientSecret: string; callbackUrl: string }
    | undefined;
  /** Dev login (name-only) — must be off in production. */
  allowDevLogin: boolean;
}

export function configFromEnv(): ServerConfig {
  const isProd = process.env.NODE_ENV === "production";
  return {
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/collabwrite",
    redisUrl: process.env.REDIS_URL,
    sessionSecret: process.env.SESSION_SECRET ?? "dev-only-secret",
    snapshotEvery: Number(process.env.SNAPSHOT_EVERY ?? 200),
    google:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackUrl:
              process.env.GOOGLE_CALLBACK_URL ??
              "http://localhost:5173/api/auth/google/callback",
          }
        : undefined,
    allowDevLogin: !isProd,
  };
}

import { Pool, type PoolClient, type QueryResultRow } from "pg";

// Single shared pool. In dev, Next's module reloading would otherwise create a
// new pool on every hot reload and exhaust connections, so it is cached on
// globalThis.

declare global {
  // eslint-disable-next-line no-var
  var __outreachPool: Pool | undefined;
}

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }
  if (!globalThis.__outreachPool) {
    // Sized for serverless (Vercel functions). Each warm instance keeps a small
    // pool cached on globalThis; the real connection multiplexing is done by the
    // provider's pooler (Neon's -pooler endpoint / Supabase pgBouncer), so DATABASE_URL
    // should point at the POOLED connection string. Keeping max low here avoids a
    // burst of cold instances exhausting the provider's connection ceiling.
    const isServerless = Boolean(process.env.VERCEL);
    globalThis.__outreachPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Managed Postgres (Neon/Supabase) requires TLS; allow the common
      // self-signed chain used by poolers.
      ssl: process.env.DATABASE_URL.includes("sslmode=disable")
        ? false
        : { rejectUnauthorized: false },
      max: isServerless ? 3 : 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalThis.__outreachPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

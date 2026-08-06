import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema-pg.js';

type PgClient = ReturnType<typeof drizzle<typeof schema>>;

let pgPool: pg.Pool | null = null;
let pgClient: PgClient | null = null;

export function initPostgres(connectionString: string): { pool: pg.Pool; client: PgClient } {
  if (pgPool) return { pool: pgPool, client: pgClient! };

  pgPool = new pg.Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pgClient = drizzle(pgPool, { schema });

  return { pool: pgPool, client: pgClient };
}

export function getPgPool(): pg.Pool {
  if (!pgPool) throw new Error('Postgres not initialized — call initPostgres() first');
  return pgPool;
}

export function getPgClient(): PgClient {
  if (!pgClient) throw new Error('Postgres not initialized — call initPostgres() first');
  return pgClient;
}

export async function migratePostgres(client: PgClient): Promise<void> {
  await migrate(client, { migrationsFolder: './drizzle/pg' });
}

/**
 * Empty all `public` schema tables (used only under `PG_TEST_RESET=1`, set by
 * the `test:db-pg` script) so each test-file process sees the same blank
 * database that SQLite's `:memory:` init gives the sqlite suite.
 *
 * The Drizzle migration journal lives in its own `drizzle` schema and is
 * deliberately untouched, so re-running `migratePostgres()` stays a no-op.
 */
export async function resetPostgresTables(): Promise<void> {
  if (!pgPool) throw new Error('Postgres not initialized — call initPostgres() first');
  const { rows } = await pgPool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
  );
  const tables = rows.map((r) => r.tablename);
  if (tables.length === 0) return;
  await pgPool.query(
    `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
  );
}

export async function closePostgres(): Promise<void> {
  if (pgPool) {
    try {
      if (process.env.PG_TEST_RESET === '1') {
        await resetPostgresTables();
      }
      await Promise.race([
        pgPool.end(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Pool end timed out after 5s')), 5_000)),
      ]);
    } catch (err) {
      console.error('Error closing Postgres pool:', err);
    }
    pgPool = null;
    pgClient = null;
  }
}

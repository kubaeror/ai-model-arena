import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema-pg.js';

export type PgClient = ReturnType<typeof drizzle<typeof schema>>;

let pgPool: pg.Pool | null = null;
let pgClient: PgClient | null = null;

export function initPostgres(connectionString: string): { pool: pg.Pool; client: PgClient } {
  if (pgPool) return { pool: pgPool, client: pgClient! };

  pgPool = new pg.Pool({ connectionString });
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

export async function closePostgres(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
    pgClient = null;
  }
}

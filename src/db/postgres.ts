import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema-pg.js';

export type PgClient = ReturnType<typeof drizzle<typeof schema>>;

let pgPool: pg.Pool | null = null;
let pgClient: PgClient | null = null;

/**
 * Execute a raw query against the pool.
 * Handles both Drizzle sql.raw template literals and plain strings.
 */
function extractSql(q: any): string {
  if (typeof q === 'string') return q;
  if (q.source) return q.source;
  // Drizzle sql.raw template — SQL is in queryChunks[0].value[0]
  if (q.queryChunks?.[0]?.value?.[0]) return q.queryChunks[0].value[0];
  return String(q);
}

async function doRawQuery(query: any, ...params: any[]): Promise<any[]> {
  let sqlStr = extractSql(query);

  // Flatten params: SQLite callers pass named objects or positional arrays
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    // named params object — convert ? placeholders to $1,$2,... and extract values in order
    const named = params[0] as Record<string, unknown>;
    const reorder: any[] = [];
    let idx = 0;
    const replaced = sqlStr.replace(/\?/g, () => {
      const key = Object.keys(named)[idx++] ?? '';
      reorder.push(named[key]);
      return `$${idx}`;
    });
    const result = await pgPool!.query(replaced, reorder);
    return result.rows;
  }

  // Positional params — convert ? placeholders to $1,$2,...
  let counter = 0;
  const replaced = sqlStr.replace(/\?/g, () => {
    counter++;
    return `$${counter}`;
  });
  const result = await pgPool!.query(replaced, params.slice(0, counter));
  return result.rows;
}

export function initPostgres(connectionString: string): { pool: pg.Pool; client: PgClient } {
  if (pgPool) return { pool: pgPool, client: pgClient! };

  pgPool = new pg.Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pgClient = drizzle(pgPool, { schema });

  // ── Add .all() / .run() compatibility for SQLite callers ──────────────
  const rawClient = pgClient as any;
  rawClient.all = async (query: any, ...params: any[]) => {
    return doRawQuery(query, ...params);
  };
  rawClient.run = (query: any, ...params: any[]) => {
    const promise = doRawQuery(query, ...params);
    const wrapper = Object.assign(promise, {
      values: async (namedParams: Record<string, unknown>) => {
        return doRawQuery(query, namedParams);
      },
      changes: 0,
      lastInsertRowid: null,
    });
    return wrapper;
  };

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
    try {
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

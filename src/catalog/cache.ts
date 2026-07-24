import type { CatalogCacheStateRow } from '../db/schema.js';
import { getDrizzleDb } from '../db/index.js';
import { catalog_cache_state } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function isStale(source: string): Promise<boolean> {
  const db = getDrizzleDb();
  const rows = await db.select({
    next_refresh: catalog_cache_state.next_refresh,
    last_status: catalog_cache_state.last_status,
  }).from(catalog_cache_state).where(eq(catalog_cache_state.source, source)).limit(1);
  if (rows.length === 0) return true;
  return new Date(rows[0].next_refresh).getTime() <= Date.now();
}

export async function getCacheStates(): Promise<CatalogCacheStateRow[]> {
  const db = getDrizzleDb();
  return db.select().from(catalog_cache_state).orderBy(catalog_cache_state.source);
}

export async function ensureFresh(source: 'models.dev' | 'modelbench' | 'zeroeval'): Promise<void> {
  if (!(await isStale(source))) return;
  if (source === 'models.dev') {
    const { fetchSync } = await import('./sync.js');
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } else {
    const { fetchBenchmarks } = await import('./benchmarks.js');
    await fetchBenchmarks(source, { force: true });
  }
}

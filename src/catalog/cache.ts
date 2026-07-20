import type { Database } from 'better-sqlite3';
import type { CatalogCacheStateRow } from '../db/schema.js';

export function isStale(db: Database, source: string): boolean {
  const row = db.prepare('SELECT next_refresh, last_status FROM catalog_cache_state WHERE source = ?').get(source) as { next_refresh: string; last_status: string } | undefined;
  if (!row) return true;
  return new Date(row.next_refresh).getTime() <= Date.now();
}

export function getCacheStates(db: Database): CatalogCacheStateRow[] {
  return db.prepare('SELECT * FROM catalog_cache_state ORDER BY source').all() as CatalogCacheStateRow[];
}

export async function ensureFresh(source: 'models.dev' | 'modelbench' | 'zeroeval'): Promise<void> {
  const { getDb } = await import('../db/client.js');
  const db = getDb();
  if (!isStale(db, source)) return;
  if (source === 'models.dev') {
    const { fetchSync } = await import('./sync.js');
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } else {
    const { fetchBenchmarks } = await import('./benchmarks.js');
    await fetchBenchmarks(source, { force: true });
  }
}

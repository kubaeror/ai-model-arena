import { eq, gte, lte, and, desc, avg, max, count, gt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { models, model_runtime_stats } from '../schema.js';

// ── Dashboard: metrics helpers ────────────────────────────────────────────

export async function queryModelRuntimeStats(opts: {
  modelId?: string; from?: string; to?: string; limit?: number;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (opts.modelId) conds.push(eq(model_runtime_stats.model_id, opts.modelId));
  if (opts.from) conds.push(gte(model_runtime_stats.measured_at, opts.from));
  if (opts.to) conds.push(lte(model_runtime_stats.measured_at, opts.to));
  const limit = Math.min(opts.limit ?? 100, 1000);
  return db.select().from(model_runtime_stats)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(model_runtime_stats.measured_at))
    .limit(limit) as any;
}

export async function queryTpsLeaderboard(): Promise<any[]> {
  const db = getDrizzleDb();
  const r = model_runtime_stats;
  return db.select({
    model_id: models.id,
    name: models.name,
    provider_id: models.provider_id,
    avg_tps: avg(r.tps),
    max_tps: max(r.tps),
    avg_latency_p50: avg(r.latency_p50_ms),
    avg_cache_hit_rate: avg(r.cache_hit_rate),
    run_count: count(r.run_id),
  })
    .from(models)
    .leftJoin(r, eq(r.model_id, models.id))
    .groupBy(models.id)
    .having(gt(count(r.run_id), 0))
    .orderBy(desc(avg(r.tps))) as any;
}

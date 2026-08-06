import { and, desc, eq, sql } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { models, pricing, model_runtime_stats } from '../schema.js';

// ── Dashboard: cache leaderboard ──────────────────────────────────────────

export async function queryCacheLeaderboard(): Promise<any[]> {
  const db = getDrizzleDb();
  const r = model_runtime_stats;
  return db.select({
    id: models.id,
    name: models.name,
    provider_id: models.provider_id,
    context_limit: models.context_limit,
    input: pricing.input,
    output: pricing.output,
    cache_read: pricing.cache_read,
    intelligence: sql<number>`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index')`,
    coding: sql<number>`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Coding Score')`,
    arena_tps: sql<number>`(SELECT AVG(x.tps) FROM ${r} x WHERE x.model_id = ${models.id})`,
    arena_latency: sql<number>`(SELECT AVG(x.latency_p50_ms) FROM ${r} x WHERE x.model_id = ${models.id})`,
    arena_runs: sql<number>`(SELECT COUNT(*) FROM ${r} x WHERE x.model_id = ${models.id})`,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .orderBy(desc(sql`(SELECT score FROM benchmarks b WHERE b.model_id = ${models.id} AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index')`)) as any;
}

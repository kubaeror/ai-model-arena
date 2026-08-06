import { eq, gte, lte, and, desc, avg, max, count, gt, inArray, sum, countDistinct, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { models, model_runtime_stats, tool_call_stats, cost_ledger, run_models } from '../schema.js';

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

// ── Dashboard: analytics queries (moved from routes/analytics.ts) ─────────

export interface ToolCallStatsRow {
  model: string;
  tool_name: string;
  total: number;
  success_count: number;
  fail_count: number;
}

export interface DailyToolTrendRow {
  date: string;
  model: string;
  tool_name: string;
  total_calls: number;
  success_count: number;
  fail_count: number;
  run_count: number;
}

export interface CostLeaderboardRow {
  model: string;
  total_cost: number | null;
  total_tokens: number | null;
  runs: number;
  successes: number;
}

/** Per-(model, tool) tool call sums, optionally scoped to run IDs / model. */
export async function queryToolCallStats(opts: { model?: string; runIds?: string[] } = {}): Promise<ToolCallStatsRow[]> {
  const db = getDrizzleDb();
  const conds: SQL[] = [];
  if (opts.runIds && opts.runIds.length > 0) conds.push(inArray(tool_call_stats.run_id, opts.runIds));
  if (opts.model) conds.push(eq(tool_call_stats.model, opts.model));
  const rows = await db.select({
    model: tool_call_stats.model,
    tool_name: tool_call_stats.tool_name,
    total: sql<number>`SUM(${tool_call_stats.total})`,
    success_count: sql<number>`SUM(${tool_call_stats.success_count})`,
    fail_count: sql<number>`SUM(${tool_call_stats.fail_count})`,
  })
    .from(tool_call_stats)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .groupBy(tool_call_stats.model, tool_call_stats.tool_name)
    .orderBy(sql`model`, sql`total DESC`) as Array<{
    model: string;
    tool_name: string;
    total: number;
    success_count: number;
    fail_count: number;
  }>;
  return rows.map((r) => ({
    model: String(r.model),
    tool_name: String(r.tool_name),
    total: Number(r.total ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
  }));
}

/** Daily per-(model, tool) trend aggregates over the last `days` days. */
export async function queryDailyToolTrends(days: number, opts: { model?: string; tool?: string } = {}): Promise<DailyToolTrendRow[]> {
  const db = getDrizzleDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const conds: SQL[] = [sql`${tool_call_stats.recorded_at} >= ${since}`];
  if (opts.model) conds.push(eq(tool_call_stats.model, opts.model));
  if (opts.tool) conds.push(eq(tool_call_stats.tool_name, opts.tool));
  const rows = await db.select({
    date: sql<string>`DATE(${tool_call_stats.recorded_at})`,
    model: tool_call_stats.model,
    tool_name: tool_call_stats.tool_name,
    total_calls: sql<number>`SUM(${tool_call_stats.total})`,
    success_count: sql<number>`SUM(${tool_call_stats.success_count})`,
    fail_count: sql<number>`SUM(${tool_call_stats.fail_count})`,
    run_count: sql<number>`COUNT(DISTINCT ${tool_call_stats.run_id})`,
  })
    .from(tool_call_stats)
    .where(and(...conds))
    .groupBy(sql`DATE(${tool_call_stats.recorded_at})`, tool_call_stats.model, tool_call_stats.tool_name)
    .orderBy(sql`DATE(${tool_call_stats.recorded_at}) ASC`) as Array<{
    date: string;
    model: string;
    tool_name: string;
    total_calls: number;
    success_count: number;
    fail_count: number;
    run_count: number;
  }>;
  return rows.map((r) => ({
    date: String(r.date),
    model: String(r.model),
    tool_name: String(r.tool_name),
    total_calls: Number(r.total_calls ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    run_count: Number(r.run_count ?? 0),
  }));
}

/** Cost leaderboard rows merging cost_ledger with run_models run/success counts. */
export async function queryCostLeaderboard(opts: { model?: string } = {}): Promise<CostLeaderboardRow[]> {
  const db = getDrizzleDb();
  const costWhere = opts.model ? eq(cost_ledger.model, opts.model) : undefined;
  const runWhere = opts.model ? eq(run_models.model, opts.model) : undefined;

  const costRows = await db.select({
    model: cost_ledger.model,
    total_cost: sum(cost_ledger.cost_usd),
    total_tokens: sum(sql<number>`COALESCE(${cost_ledger.input_tokens}, 0) + COALESCE(${cost_ledger.output_tokens}, 0)`),
  })
    .from(cost_ledger)
    .where(costWhere)
    .groupBy(cost_ledger.model) as Array<{ model: string; total_cost: number | null; total_tokens: number | null }>;

  const runRows = await db.select({
    model: run_models.model,
    runs: countDistinct(run_models.run_id),
    successes: sum(sql<number>`CASE WHEN ${run_models.success} = 1 THEN 1 ELSE 0 END`),
  })
    .from(run_models)
    .where(runWhere)
    .groupBy(run_models.model) as Array<{ model: string; runs: number | null; successes: number | null }>;

  const byModel = new Map<string, CostLeaderboardRow>();
  for (const c of costRows) {
    byModel.set(c.model, {
      model: c.model,
      total_cost: c.total_cost != null ? Number(c.total_cost) : null,
      total_tokens: c.total_tokens != null ? Number(c.total_tokens) : null,
      runs: 0,
      successes: 0,
    });
  }
  for (const r of runRows) {
    const entry = byModel.get(r.model) ?? { model: r.model, total_cost: null, total_tokens: null, runs: 0, successes: 0 };
    entry.runs = Number(r.runs ?? 0);
    entry.successes = Number(r.successes ?? 0);
    byModel.set(r.model, entry);
  }
  return [...byModel.values()];
}

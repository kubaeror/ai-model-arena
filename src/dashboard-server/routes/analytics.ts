import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import { listRuns } from '../../orchestrator/orchestrator.js';
import { extractToolCallsFromConversation, detectTurnLoops, type LoopIncident } from '../../logger/conversation-parser.js';
import { getDrizzleDb } from '../../db/index.js';
import { tool_call_stats, run_models } from '../../db/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';

// ── In-memory cache (30s TTL) ──────────────────────────────────────────────

interface CacheEntry<T> { key: string; data: T; ts: number; }
function getCached<T>(cache: CacheEntry<T> | null, key: string): T | undefined {
  if (cache && cache.key === key && (Date.now() - cache.ts) < 30_000) return cache.data;
  return undefined;
}
function setCache<T>(key: string, data: T): CacheEntry<T> {
  return { key, data, ts: Date.now() };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface ToolStatRow {
  model: string;
  tool_name: string;
  total: number;
  success_count: number;
  fail_count: number;
}

interface ToolStatsAggregated {
  name: string;
  totalCalls: number;
  failedCalls: number;
  successCalls: number;
  successRate: number;
  avgPerRun: number;
  avgPerSuccessfulTask: number;
}

interface ModelToolStat {
  model: string;
  tool_name: string;
  total: number;
  success_count: number;
  fail_count: number;
  success_rate: number;
}

interface ToolAnalyticsResponse {
  model: string | null;
  totalRuns: number;
  successfulRuns: number;
  totalToolCalls: number;
  toolStats: ToolStatsAggregated[];
  perModel: ModelToolStat[];
  failedRate: number;
  avgCallsPerSuccess: number;
  loopIncidents: LoopIncident[];
}

interface ToolTrendPoint {
  date: string;
  totalCalls: number;
  successRate: number;
  toolName: string;
  model: string;
  runCount: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function readResultFile(resultPath: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fsp.readFile(resultPath, 'utf8')); } catch { return null; }
}

async function readConversationFile(convPath: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fsp.readFile(convPath, 'utf8')); } catch { return null; }
}

export function createAnalyticsRouter(): Router {
  const router = Router();

  let toolsCache: CacheEntry<ToolAnalyticsResponse> | null = null;
  let trendCache: CacheEntry<ToolTrendPoint[]> | null = null;

  // ── GET /tools — Comprehensive tool analytics ─────────────────────────

  router.get('/tools', async (req, res) => {
    const { model: filterModel, scenario: filterScenario, from, to } = req.query as Record<string, string | undefined>;
    const cacheKey = `tools:${filterModel ?? ''}:${filterScenario ?? ''}:${from ?? ''}:${to ?? ''}`;
    const cached = getCached(toolsCache, cacheKey);
    if (cached) { res.json(cached); return; }

    const db = getDrizzleDb();
    const runs = await listRuns();

    // Build date + scenario filter
    let filteredRuns = runs;
    if (from) { const d = new Date(from); filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) >= d); }
    if (to) { const d = new Date(to); filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) <= d); }
    if (filterScenario) { filteredRuns = filteredRuns.filter(r => r.scenario === filterScenario); }

    // ── DB path: query tool_call_stats for matching runs ──────────────────
    const runIds = filteredRuns.map(r => r.runId);
    let dbRows: ToolStatRow[] = [];
    if (runIds.length > 0) {
      let query = db.select({
        model: tool_call_stats.model,
        tool_name: tool_call_stats.tool_name,
        total: sql<number>`SUM(${tool_call_stats.total})`,
        success_count: sql<number>`SUM(${tool_call_stats.success_count})`,
        fail_count: sql<number>`SUM(${tool_call_stats.fail_count})`,
      }).from(tool_call_stats)
        .where(inArray(tool_call_stats.run_id, runIds as any))
        .groupBy(tool_call_stats.model, tool_call_stats.tool_name);

      if (filterModel) {
        query = query.where(eq(tool_call_stats.model, filterModel)) as any;
      }
      const result = await query.orderBy(sql`model`, sql`total DESC`);
      dbRows = result as unknown as ToolStatRow[];
    }

    // Track which (run_id, model) pairs we have DB data for
    const coveredRunIds = new Set<string>();
    if (runIds.length > 0) {
      const coveredRows = await db.select({ run_id: tool_call_stats.run_id }).from(tool_call_stats)
        .where(inArray(tool_call_stats.run_id, runIds as any))
        .all();
      for (const r of coveredRows as any[]) coveredRunIds.add(r.run_id);
    }

    // ── File fallback: scan runs not in DB ────────────────────────────────
    const perModelMap = new Map<string, ModelToolStat>();
    let totalRuns = 0;
    let successfulRuns = 0;
    let totalToolCalls = 0;
    const allLoops: LoopIncident[] = [];

    for (const run of filteredRuns) {
      if (filterModel && !run.models.includes(filterModel)) continue;
      totalRuns++;

      for (const perModel of run.perModel) {
        if (filterModel && perModel.model !== filterModel) continue;

        if (coveredRunIds.has(run.runId)) {
          const result = await readResultFile(perModel.resultPath);
          if (result?.success === true) successfulRuns++;
          continue;
        }

        // File fallback
        const result = await readResultFile(perModel.resultPath);
        const conv = await readConversationFile(perModel.conversationPath);
        if (conv) {
          const loops = detectTurnLoops(conv);
          allLoops.push(...loops);
        }
        const toolCalls = conv ? extractToolCallsFromConversation(conv) : [];
        const success = result?.success === true;
        if (success) successfulRuns++;

        for (const tc of toolCalls) {
          totalToolCalls++;
          const mk = `${perModel.model}:${tc.name}`;
          const existing = perModelMap.get(mk) ?? { model: perModel.model, tool_name: tc.name, total: 0, success_count: 0, fail_count: 0, success_rate: 0 };
          existing.total++;
          if (tc.success) existing.success_count++;
          else existing.fail_count++;
          perModelMap.set(mk, existing);
        }
      }
    }

    // Merge DB rows into perModelMap
    for (const row of dbRows) {
      totalToolCalls += row.total;
      const mk = `${row.model}:${row.tool_name}`;
      const existing = perModelMap.get(mk) ?? { model: row.model, tool_name: row.tool_name, total: 0, success_count: 0, fail_count: 0, success_rate: 0 };
      existing.total += row.total;
      existing.success_count += row.success_count;
      existing.fail_count += row.fail_count;
      perModelMap.set(mk, existing);
    }

    // For DB-covered runs, query run-level success
    if (coveredRunIds.size > 0) {
      const coveredList = [...coveredRunIds];
      const successRows = await db.select({ run_id: run_models.run_id, model: run_models.model, success: run_models.success })
        .from(run_models)
        .where(inArray(run_models.run_id, coveredList as any))
        .all() as any[];
      for (const row of successRows) {
        if (row.success === 1) successfulRuns++;
      }
    }

    // Calculate success rates for perModel entries
    for (const entry of perModelMap.values()) {
      entry.success_rate = entry.total > 0 ? entry.success_count / entry.total : 0;
    }

    // ── Aggregate tool-level stats ─────────────────────────────────────────
    const toolAggMap = new Map<string, { total: number; failed: number; success: number; runCount: number; successRunCount: number }>();
    for (const entry of perModelMap.values()) {
      const stats = toolAggMap.get(entry.tool_name) ?? { total: 0, failed: 0, success: 0, runCount: 0, successRunCount: 0 };
      stats.total += entry.total;
      stats.failed += entry.fail_count;
      stats.success += entry.success_count;
      stats.runCount++;
      toolAggMap.set(entry.tool_name, stats);
    }

    const toolStats: ToolStatsAggregated[] = [];
    for (const [name, stats] of toolAggMap) {
      toolStats.push({
        name,
        totalCalls: stats.total,
        failedCalls: stats.failed,
        successCalls: stats.success,
        successRate: stats.total > 0 ? stats.success / stats.total : 0,
        avgPerRun: stats.runCount > 0 ? stats.total / stats.runCount : 0,
        avgPerSuccessfulTask: stats.successRunCount > 0 ? stats.total / stats.successRunCount : 0,
      });
    }
    toolStats.sort((a, b) => b.totalCalls - a.totalCalls);

    const perModel = [...perModelMap.values()].sort((a, b) => b.total - a.total);

    const failedRate = totalRuns > 0 ? (totalRuns - successfulRuns) / totalRuns : 0;
    const avgCallsPerSuccess = successfulRuns > 0 ? totalToolCalls / successfulRuns : 0;

    const response: ToolAnalyticsResponse = {
      model: filterModel ?? null,
      totalRuns,
      successfulRuns,
      totalToolCalls,
      toolStats,
      perModel,
      failedRate,
      avgCallsPerSuccess,
      loopIncidents: allLoops.slice(0, 50),
    };

    toolsCache = setCache(cacheKey, response);
    res.json(response);
  });

  // ── GET /tools/trends — Daily tool success rate trends ─────────────────

  router.get('/tools/trends', async (req, res) => {
    const { model: filterModel, tool: filterTool, days } = req.query as Record<string, string | undefined>;
    const cacheKey = `trends:${filterModel ?? ''}:${filterTool ?? ''}:${days ?? '30'}`;
    const cached = getCached(trendCache, cacheKey);
    if (cached) { res.json(cached); return; }

    const db = getDrizzleDb();
    const dayCount = Math.min(parseInt(days ?? '30', 10) || 30, 90);
    const since = new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000).toISOString();

    let query = db.select({
      date: sql<string>`DATE(${tool_call_stats.recorded_at})`,
      model: tool_call_stats.model,
      tool_name: tool_call_stats.tool_name,
      total_calls: sql<number>`SUM(${tool_call_stats.total})`,
      success_count: sql<number>`SUM(${tool_call_stats.success_count})`,
      fail_count: sql<number>`SUM(${tool_call_stats.fail_count})`,
      run_count: sql<number>`COUNT(DISTINCT ${tool_call_stats.run_id})`,
    }).from(tool_call_stats)
      .where(sql`${tool_call_stats.recorded_at} >= ${since}`);

    if (filterModel) query = query.where(eq(tool_call_stats.model, filterModel)) as any;
    if (filterTool) query = query.where(eq(tool_call_stats.tool_name, filterTool)) as any;

    const rows = await query.groupBy(sql`date`, tool_call_stats.model, tool_call_stats.tool_name)
      .orderBy(sql`date ASC`)
      .all() as any[];

    const trends: ToolTrendPoint[] = rows.map((r: any) => ({
      date: r.date,
      totalCalls: r.total_calls,
      successRate: r.total_calls > 0 ? r.success_count / r.total_calls : 0,
      toolName: r.tool_name,
      model: r.model,
      runCount: r.run_count,
    }));

    trendCache = setCache(cacheKey, trends);
    res.json(trends);
  });

  // ── GET /cost — Cost leaderboard ───────────────────────────────────────

  router.get('/cost', async (req, res) => {
    const runs = await listRuns();
    const filterModel = req.query.model as string | undefined;

    const modelStats = new Map<string, { runs: number; successes: number; totalCost: number; totalTokens: number }>();

    for (const run of runs) {
      for (const perModel of run.perModel) {
        if (filterModel && perModel.model !== filterModel) continue;

        const result = await readResultFile(perModel.resultPath);
        if (!result) continue;

        const modelName = perModel.model;
        const stats = modelStats.get(modelName) ?? { runs: 0, successes: 0, totalCost: 0, totalTokens: 0 };
        stats.runs++;
        if (result.success === true) stats.successes++;
        stats.totalCost += (result.costUsd as number) ?? 0;
        const tokenUsage = result.tokenUsage as Record<string, number> | undefined;
        stats.totalTokens += (tokenUsage?.prompt ?? 0) + (tokenUsage?.completion ?? 0);
        modelStats.set(modelName, stats);
      }
    }

    const leaderboard = Array.from(modelStats.entries()).map(([model, stats]) => ({
      model,
      runs: stats.runs,
      successes: stats.successes,
      successRate: stats.runs > 0 ? stats.successes / stats.runs : 0,
      totalCost: stats.totalCost,
      costPerSuccess: stats.successes > 0 ? stats.totalCost / stats.successes : 0,
      avgCostPerRun: stats.runs > 0 ? stats.totalCost / stats.runs : 0,
      totalTokens: stats.totalTokens,
    })).sort((a, b) => a.costPerSuccess - b.costPerSuccess);

    res.json({ leaderboard });
  });

  return router;
}

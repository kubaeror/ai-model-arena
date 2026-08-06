import { Router } from 'express';
import { listRuns } from '../../orchestrator/orchestrator.js';
import { extractToolCallsFromConversation, detectTurnLoops, type LoopIncident } from '../../logger/conversation-parser.js';
import { getDrizzleDb } from '../../db/index.js';
import { tool_call_stats, run_models } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';
import { readJsonFile } from '../../fs/read-json.js';
import { queryToolCallStats, queryDailyToolTrends, queryCostLeaderboard, type ToolCallStatsRow } from '../../db/query.js';

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
    let dbRows: ToolCallStatsRow[] = [];
    if (runIds.length > 0) {
      dbRows = await queryToolCallStats({ runIds, model: filterModel });
    }

    // Track which (run_id, model) pairs we have DB data for
    const coveredRunIds = new Set<string>();
    if (runIds.length > 0) {
      const coveredRows = await db.select({ run_id: tool_call_stats.run_id }).from(tool_call_stats)
        .where(inArray(tool_call_stats.run_id, runIds));
      for (const r of coveredRows) coveredRunIds.add(r.run_id);
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
          const result = await readJsonFile<Record<string, unknown>>(perModel.resultPath);
          if (result?.success === true) successfulRuns++;
          continue;
        }

        // File fallback
        const result = await readJsonFile<Record<string, unknown>>(perModel.resultPath);
        const conv = await readJsonFile<Record<string, unknown>>(perModel.conversationPath);
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
        .where(inArray(run_models.run_id, coveredList));
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

    const dayCount = Math.min(parseInt(days ?? '30', 10) || 30, 90);
    const rows = await queryDailyToolTrends(dayCount, { model: filterModel, tool: filterTool });

    const trends: ToolTrendPoint[] = rows.map((r) => ({
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

  // ── GET /cost — Cost leaderboard (cost_ledger + run_models, no file reads) ──

  router.get('/cost', async (req, res) => {
    const filterModel = typeof req.query.model === 'string' && req.query.model ? req.query.model : undefined;
    const rows = await queryCostLeaderboard(filterModel ? { model: filterModel } : {});

    const leaderboard = rows.map((s) => {
      const runs = s.runs;
      const successes = s.successes;
      const totalCost = s.total_cost ?? 0;
      const totalTokens = s.total_tokens ?? 0;
      return {
        model: s.model,
        runs,
        successes,
        successRate: runs > 0 ? successes / runs : 0,
        totalCost,
        costPerSuccess: successes > 0 ? totalCost / successes : 0,
        avgCostPerRun: runs > 0 ? totalCost / runs : 0,
        totalTokens,
      };
    }).sort((a, b) => b.totalCost - a.totalCost);

    res.json({ leaderboard });
  });

  return router;
}

import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import { listRuns } from '../../orchestrator/orchestrator.js';
import { extractToolCallsFromConversation } from '../../logger/conversation-parser.js';
import { getDb } from '../../db/client.js';

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

interface LoopIncident {
  runId: string;
  model: string;
  turn: number;
  tools: string[];
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

function detectLoopsInConversation(conv: Record<string, unknown>): LoopIncident[] {
  const entries = (conv.entries as Array<Record<string, unknown>>) ?? [];
  const incidents: LoopIncident[] = [];
  const turnTools = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      const turn = (entry.turn as number) ?? 0;
      const toolName = entry.toolName as string;
      if (!turnTools.has(turn)) turnTools.set(turn, []);
      turnTools.get(turn)!.push(toolName);
    }
  }
  const turns = Array.from(turnTools.keys()).sort((a, b) => a - b);
  for (let i = 0; i < turns.length - 2; i++) {
    const t1 = turnTools.get(turns[i]!) ?? [];
    const t2 = turnTools.get(turns[i + 1]!) ?? [];
    const t3 = turnTools.get(turns[i + 2]!) ?? [];
    if (t1.length > 0 && JSON.stringify(t1) === JSON.stringify(t2) && JSON.stringify(t2) === JSON.stringify(t3)) {
      incidents.push({
        runId: (conv.runId as string) ?? '',
        model: (conv.meta as Record<string, unknown>)?.model as string ?? '',
        turn: turns[i]!,
        tools: t1,
      });
    }
  }
  return incidents;
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

    const db = getDb();
    const runs = listRuns();

    // Build date + scenario filter
    let filteredRuns = runs;
    if (from) { const d = new Date(from); filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) >= d); }
    if (to) { const d = new Date(to); filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) <= d); }
    if (filterScenario) { filteredRuns = filteredRuns.filter(r => r.scenario === filterScenario); }

    // ── DB path: query tool_call_stats for matching runs ──────────────────
    const runIds = filteredRuns.map(r => r.runId);
    let dbRows: ToolStatRow[] = [];
    if (runIds.length > 0) {
      const placeholders = runIds.map(() => '?').join(',');
      let sql = `SELECT model, tool_name, SUM(total) as total, SUM(success_count) as success_count, SUM(fail_count) as fail_count FROM tool_call_stats WHERE run_id IN (${placeholders})`;
      const params: string[] = [...runIds];
      if (filterModel) { sql += ' AND model = ?'; params.push(filterModel); }
      sql += ' GROUP BY model, tool_name ORDER BY model, total DESC';
      dbRows = db.prepare(sql).all(...params) as ToolStatRow[];
    }

    // Track which (run_id, model) pairs we have DB data for
    // Re-query to get the set of covered run_ids
    const coveredRunIds = new Set<string>();
    if (runIds.length > 0) {
      const coveredSql = `SELECT DISTINCT run_id FROM tool_call_stats WHERE run_id IN (${runIds.map(() => '?').join(',')})`;
      const coveredRows = db.prepare(coveredSql).all(...runIds) as { run_id: string }[];
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
          // DB covers this run — success/fail counts come from the DB aggregate
          const result = await readResultFile(perModel.resultPath);
          if (result?.success === true) successfulRuns++;
          continue;
        }

        // File fallback
        const result = await readResultFile(perModel.resultPath);
        const conv = await readConversationFile(perModel.conversationPath);
        if (conv) {
          const loops = detectLoopsInConversation(conv);
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

    // For DB-covered runs where we didn't have per-model data in the aggregation,
    // re-query for run-level success
    if (coveredRunIds.size > 0) {
      const coveredList = [...coveredRunIds];
      const placeholders = coveredList.map(() => '?').join(',');
      const successSql = `SELECT run_id, model, success FROM run_models WHERE run_id IN (${placeholders})`;
      const successRows = db.prepare(successSql).all(...coveredList) as { run_id: string; model: string; success: number | null }[];
      for (const row of successRows) {
        if (row.success === 1) successfulRuns++;
      }
    }

    // Calculate success rates for perModel entries
    for (const entry of perModelMap.values()) {
      entry.success_rate = entry.total > 0 ? entry.success_count / entry.total : 0;
    }

    // ── Aggregate tool-level stats (merged across models) ─────────────────
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

    const perModel = [...perModelMap.values()]
      .sort((a, b) => b.total - a.total);

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

    const db = getDb();
    const dayCount = Math.min(parseInt(days ?? '30', 10) || 30, 90);
    const since = new Date(Date.now() - dayCount * 24 * 60 * 60 * 1000).toISOString();

    let sql = `SELECT DATE(recorded_at) as date, model, tool_name, SUM(total) as total_calls, SUM(success_count) as success_count, SUM(fail_count) as fail_count, COUNT(DISTINCT run_id) as run_count FROM tool_call_stats WHERE recorded_at >= ?`;
    const params: string[] = [since];

    if (filterModel) { sql += ' AND model = ?'; params.push(filterModel); }
    if (filterTool) { sql += ' AND tool_name = ?'; params.push(filterTool); }
    sql += ' GROUP BY date, model, tool_name ORDER BY date ASC';

    const rows = db.prepare(sql).all(...params) as (ToolStatRow & { date: string; run_count: number })[];

    const trends: ToolTrendPoint[] = rows.map(r => ({
      date: r.date,
      totalCalls: r.total,
      successRate: r.total > 0 ? r.success_count / r.total : 0,
      toolName: r.tool_name,
      model: r.model,
      runCount: r.run_count,
    }));

    trendCache = setCache(cacheKey, trends);
    res.json(trends);
  });

  // ── GET /cost — Cost leaderboard ───────────────────────────────────────

  router.get('/cost', async (req, res) => {
    const runs = listRuns();
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

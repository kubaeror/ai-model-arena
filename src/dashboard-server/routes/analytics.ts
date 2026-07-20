import { Router } from 'express';
import { promises as fsp } from 'node:fs';
import { listRuns } from '../../orchestrator/orchestrator.js';
import { extractToolCallsFromConversation } from '../../logger/conversation-parser.js';

interface AnalyticsToolsCache { key: string; data: ToolAnalyticsResponse; ts: number; }
let analyticsToolsCache: AnalyticsToolsCache | null = null;
const ANALYTICS_TTL_MS = 30_000;

interface ToolStatsAggregated {
  name: string;
  totalCalls: number;
  failedCalls: number;
  successCalls: number;
  avgPerRun: number;
  avgPerSuccessfulTask: number;
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
  failedRate: number;
  avgCallsPerSuccess: number;
  loopIncidents: LoopIncident[];
}

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
      if (!turnTools.has(turn)) {
        turnTools.set(turn, []);
      }
      turnTools.get(turn)!.push(toolName);
    }
  }
  
  const turns = Array.from(turnTools.keys()).sort((a, b) => a - b);
  for (let i = 0; i < turns.length - 2; i++) {
    const t1 = turnTools.get(turns[i]!) ?? [];
    const t2 = turnTools.get(turns[i + 1]!) ?? [];
    const t3 = turnTools.get(turns[i + 2]!) ?? [];
    
    if (JSON.stringify(t1) === JSON.stringify(t2) && JSON.stringify(t2) === JSON.stringify(t3) && t1.length > 0) {
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
  
  router.get('/tools', async (req, res) => {
    const { model: filterModel, scenario: filterScenario, from, to } = req.query as Record<string, string | undefined>;
    const cacheKey = `${filterModel ?? ''}:${filterScenario ?? ''}:${from ?? ''}:${to ?? ''}`;
    if (analyticsToolsCache && analyticsToolsCache.key === cacheKey && (Date.now() - analyticsToolsCache.ts) < ANALYTICS_TTL_MS) {
      res.json(analyticsToolsCache.data);
      return;
    }
    const runs = listRuns();
    
    let filteredRuns = runs;
    
    if (from) {
      const fromDate = new Date(from);
      filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) >= fromDate);
    }
    if (to) {
      const toDate = new Date(to);
      filteredRuns = filteredRuns.filter(r => new Date(r.startedAt) <= toDate);
    }
    if (filterScenario) {
      filteredRuns = filteredRuns.filter(r => r.scenario === filterScenario);
    }
    
    const toolStatsMap = new Map<string, { total: number; failed: number; success: number; runCount: number; successRunCount: number }>();
    let totalRuns = 0;
    let successfulRuns = 0;
    let totalToolCalls = 0;
    const allLoops: LoopIncident[] = [];
    
    for (const run of filteredRuns) {
      if (filterModel) {
        const hasModel = run.models.includes(filterModel);
        if (!hasModel) continue;
      }
      
      totalRuns++;
      
      for (const perModel of run.perModel) {
        if (filterModel && perModel.model !== filterModel) continue;
        
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
          const stats = toolStatsMap.get(tc.name) ?? { total: 0, failed: 0, success: 0, runCount: 0, successRunCount: 0 };
          stats.total++;
          if (tc.success) stats.success++;
          else stats.failed++;
          stats.runCount++;
          if (success) stats.successRunCount++;
          toolStatsMap.set(tc.name, stats);
        }
      }
    }
    
    const toolStats: ToolStatsAggregated[] = [];
    for (const [name, stats] of toolStatsMap) {
      toolStats.push({
        name,
        totalCalls: stats.total,
        failedCalls: stats.failed,
        successCalls: stats.success,
        avgPerRun: stats.runCount > 0 ? stats.total / stats.runCount : 0,
        avgPerSuccessfulTask: stats.successRunCount > 0 ? stats.total / stats.successRunCount : 0,
      });
    }
    
    toolStats.sort((a, b) => b.totalCalls - a.totalCalls);
    
    const failedRate = totalRuns > 0 ? (totalRuns - successfulRuns) / totalRuns : 0;
    const avgCallsPerSuccess = successfulRuns > 0 ? totalToolCalls / successfulRuns : 0;
    
    const response: ToolAnalyticsResponse = {
      model: filterModel ?? null,
      totalRuns,
      successfulRuns,
      totalToolCalls,
      toolStats,
      failedRate,
      avgCallsPerSuccess,
      loopIncidents: allLoops.slice(0, 50),
    };
    
    analyticsToolsCache = { key: cacheKey, data: response, ts: Date.now() };
    res.json(response);
  });
  
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

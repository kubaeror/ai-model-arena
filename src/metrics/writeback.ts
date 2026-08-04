import fs from 'node:fs';
import path from 'node:path';
import { getDrizzleDb } from '../db/index.js';
import { models, model_runtime_stats, tool_call_stats } from '../db/schema.js';
import { aggregateLatency, computeTps } from './runtime.js';
import { extractCacheMetrics } from './cache-metrics.js';
import { matchModelToCanonical, type CatalogEntry } from '../catalog/match.js';

interface TraceMeta {
  spans: Array<{ spanId?: string; name: string; startedAt: number; endedAt: number; durationMs?: number | null; attributes?: Record<string, unknown> }>;
}

interface RunResult {
  model: string;
  runId: string;
  durationMs: number;
  tokenUsage?: { prompt?: number; completion?: number; total?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costUsd?: number;
  success: boolean;
  toolSuccessRates?: Record<string, { success: number; fail: number }>;
}

export async function writeRunStats(runId: string, root: string): Promise<void> {
  const db = getDrizzleDb();
  const outputsDir = path.join(root, 'outputs');

  // Find the run's model dir
  const modelDirs = fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir) : [];
  let resultPath: string | null = null;
  let tracePath: string | null = null;
  let modelName: string | null = null;
  for (const dir of modelDirs) {
    const candidate = path.join(outputsDir, dir, runId);
    const r = path.join(candidate, 'result.json');
    if (fs.existsSync(r)) {
      resultPath = r;
      tracePath = path.join(candidate, 'trace-meta.json');
      modelName = dir;
      break;
    }
  }
  if (!resultPath || !modelName) return;

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as RunResult;
  const trace: TraceMeta = tracePath && fs.existsSync(tracePath)
    ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceMeta
    : { spans: [] };

  const catalog = (await db.select({ id: models.id, name: models.name, provider_id: models.provider_id }).from(models)).map((r: any) => ({ id: r.id, name: r.name, provider_id: r.provider_id })) as CatalogEntry[];
  const canonicalId = matchModelToCanonical(result.model, undefined, catalog) ?? matchModelToCanonical(undefined, undefined, catalog, result.model);
  if (!canonicalId) return;

  const spans = trace.spans ?? [];
  const { p50, p95 } = aggregateLatency(spans, 'chat');
  const completionTokens = result.tokenUsage?.completion ?? 0;
  const tps = computeTps(spans, completionTokens);
  const cache = extractCacheMetrics(result.tokenUsage ?? {});

  // Note: objective quality metrics (loop detection, turn efficiency, tool stats)
  // are computed during anomaly detection via analyzeRun() and judge scoring.
  // No schema changes needed for the existing model_runtime_stats table.

  const now = new Date().toISOString();
  await db.insert(model_runtime_stats).values({
    model_id: canonicalId, run_id: runId,
    latency_p50_ms: p50, latency_p95_ms: p95, tps,
    ttft_ms: null, cache_hit_rate: cache.cacheHitRate,
    cache_read_tokens: cache.cacheReadTokens, cache_write_tokens: cache.cacheWriteTokens,
    cost_usd: result.costUsd ?? null,
    success: result.success ? 1 : 0,
    measured_at: now,
  }).onConflictDoUpdate({
    target: [model_runtime_stats.model_id, model_runtime_stats.run_id],
    set: {
      latency_p50_ms: p50, latency_p95_ms: p95, tps,
      cache_hit_rate: cache.cacheHitRate, cache_read_tokens: cache.cacheReadTokens,
      cache_write_tokens: cache.cacheWriteTokens, cost_usd: result.costUsd ?? null,
      success: result.success ? 1 : 0, measured_at: now,
    },
  });

  // Write per-tool success/fail stats
  if (result.toolSuccessRates) {
    for (const [toolName, rates] of Object.entries(result.toolSuccessRates)) {
      await db.insert(tool_call_stats).values({
        run_id: runId,
        model: result.model,
        tool_name: toolName,
        total: rates.success + rates.fail,
        success_count: rates.success,
        fail_count: rates.fail,
        recorded_at: now,
      });
    }
  }
}

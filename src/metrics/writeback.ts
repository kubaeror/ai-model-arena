import fs from 'node:fs';
import path from 'node:path';
import { getDrizzleDb } from '../db/index.js';
import { models, model_runtime_stats, tool_call_stats } from '../db/schema.js';
import { listModelCalls } from '../db/query.js';
import { getRunRecord } from '../db/runs.js';
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

/**
 * Write per-model runtime stats for a run. Model discovery comes from the run
 * index (runs/run_models tables) instead of scanning the outputs directory,
 * so every model in a multi-model run gets a row. TTFT is taken from the
 * first recorded model_call of each model's session (sessions are keyed
 * `${runId}-${model}`); latency/TPS still come from trace-meta.json.
 */
export async function writeRunStats(runId: string, root: string): Promise<void> {
  const db = getDrizzleDb();
  const rec = await getRunRecord(runId);
  if (!rec || rec.perModel.length === 0) return;

  const catalog = (await db.select({ id: models.id, name: models.name, provider_id: models.provider_id }).from(models)).map((r: any) => ({ id: r.id, name: r.name, provider_id: r.provider_id })) as CatalogEntry[];
  const calls = await listModelCalls(runId);
  const callsBySession = new Map<string, typeof calls>();
  for (const c of calls) {
    const lst = callsBySession.get(c.session_id);
    if (lst) lst.push(c);
    else callsBySession.set(c.session_id, [c]);
  }

  const now = new Date().toISOString();
  for (const pm of rec.perModel) {
    if (!pm.resultPath || !fs.existsSync(pm.resultPath)) continue;
    const result = JSON.parse(fs.readFileSync(pm.resultPath, 'utf8')) as RunResult;

    let canonicalId: string | null = null;
    for (const candidate of [result.model, pm.model]) {
      canonicalId = matchModelToCanonical(candidate, undefined, catalog) ?? matchModelToCanonical(undefined, undefined, catalog, candidate);
      if (canonicalId) break;
    }
    if (!canonicalId) continue;

    // TTFT: the first recorded model call (earliest by created_at) for this
    // model's session.
    const sessionCalls = callsBySession.get(`${runId}-${pm.model}`) ?? [];
    const firstCall = sessionCalls[0];
    const ttftMs = firstCall?.ttft_ms ?? firstCall?.latency_ms ?? null;

    const outputDir = pm.outputDir || path.join(root, 'outputs', pm.model, runId);
    const tracePath = path.join(outputDir, 'trace-meta.json');
    const trace: TraceMeta = fs.existsSync(tracePath)
      ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceMeta
      : { spans: [] };
    const spans = trace.spans ?? [];
    const { p50, p95 } = aggregateLatency(spans, 'chat');
    const completionTokens = result.tokenUsage?.completion ?? 0;
    const tps = computeTps(spans, completionTokens);
    const cache = extractCacheMetrics(result.tokenUsage ?? {});

    await db.insert(model_runtime_stats).values({
      model_id: canonicalId, run_id: runId,
      latency_p50_ms: p50, latency_p95_ms: p95, tps,
      ttft_ms: ttftMs, cache_hit_rate: cache.cacheHitRate,
      cache_read_tokens: cache.cacheReadTokens, cache_write_tokens: cache.cacheWriteTokens,
      cost_usd: result.costUsd ?? null,
      success: result.success ? 1 : 0,
      measured_at: now,
    }).onConflictDoUpdate({
      target: [model_runtime_stats.model_id, model_runtime_stats.run_id],
      set: {
        latency_p50_ms: p50, latency_p95_ms: p95, tps,
        ttft_ms: ttftMs, cache_hit_rate: cache.cacheHitRate,
        cache_read_tokens: cache.cacheReadTokens, cache_write_tokens: cache.cacheWriteTokens,
        cost_usd: result.costUsd ?? null,
        success: result.success ? 1 : 0, measured_at: now,
      },
    });

    // Write per-tool success/fail stats keyed by the canonical model id so
    // tool_call_stats.model matches model_runtime_stats.model_id.
    if (result.toolSuccessRates) {
      for (const [toolName, rates] of Object.entries(result.toolSuccessRates)) {
        await db.insert(tool_call_stats).values({
          run_id: runId,
          model: canonicalId,
          tool_name: toolName,
          total: rates.success + rates.fail,
          success_count: rates.success,
          fail_count: rates.fail,
          recorded_at: now,
        });
      }
    }
  }
}

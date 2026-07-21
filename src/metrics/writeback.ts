import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { aggregateLatency, computeTps } from './runtime.js';
import { extractCacheMetrics } from './cache-metrics.js';
import { matchModelToCanonical, type CatalogEntry } from '../catalog/match.js';

interface TraceMeta {
  spans: Array<{ spanId?: string; name: string; startTime: number; endTime: number; attributes?: Record<string, unknown> }>;
}

interface RunResult {
  model: string;
  runId: string;
  durationMs: number;
  tokenUsage?: { prompt?: number; completion?: number; total?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costUsd?: number;
  success: boolean;
}

export async function writeRunStats(runId: string, root: string): Promise<void> {
  const db = getDb();
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

  const catalog = db.prepare('SELECT id, name, provider_id FROM models').all() as CatalogEntry[];
  const canonicalId = matchModelToCanonical(result.model, undefined, catalog) ?? matchModelToCanonical(undefined, undefined, catalog, result.model);
  if (!canonicalId) return;

  const spans = trace.spans ?? [];
  const { p50, p95 } = aggregateLatency(spans, 'chat');
  const completionTokens = result.tokenUsage?.completion ?? 0;
  const tps = computeTps(spans, completionTokens);
  const cache = extractCacheMetrics(result.tokenUsage ?? {});

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_runtime_stats (model_id, run_id, latency_p50_ms, latency_p95_ms, tps, ttft_ms, cache_hit_rate, cache_read_tokens, cache_write_tokens, cost_usd, success, measured_at)
    VALUES (@model_id, @run_id, @latency_p50_ms, @latency_p95_ms, @tps, NULL, @cache_hit_rate, @cache_read_tokens, @cache_write_tokens, @cost_usd, @success, @measured_at)
    ON CONFLICT(model_id, run_id) DO UPDATE SET
      latency_p50_ms=@latency_p50_ms, latency_p95_ms=@latency_p95_ms, tps=@tps,
      cache_hit_rate=@cache_hit_rate, cache_read_tokens=@cache_read_tokens, cache_write_tokens=@cache_write_tokens,
      cost_usd=@cost_usd, success=@success, measured_at=@measured_at
  `).run({
    model_id: canonicalId, run_id: runId,
    latency_p50_ms: p50, latency_p95_ms: p95, tps,
    cache_hit_rate: cache.cacheHitRate,
    cache_read_tokens: cache.cacheReadTokens,
    cache_write_tokens: cache.cacheWriteTokens,
    cost_usd: result.costUsd ?? null,
    success: result.success ? 1 : 0,
    measured_at: now,
  });
}

import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  listCatalogModels, getModelDetail, paginate,
} from '../../db/query.js';
import { benchmarks, model_runtime_stats, pricing } from '../../db/schema.js';

const benchmarkColumns = {
  id: benchmarks.id,
  model_id: benchmarks.model_id,
  benchmark: benchmarks.benchmark,
  source: benchmarks.source,
  score: benchmarks.score,
  measured_at: benchmarks.measured_at,
  source_url: benchmarks.source_url,
  is_preferred: benchmarks.is_preferred,
};

const runtimeColumns = {
  id: model_runtime_stats.id,
  run_id: model_runtime_stats.run_id,
  model_id: model_runtime_stats.model_id,
  latency_p50_ms: model_runtime_stats.latency_p50_ms,
  latency_p95_ms: model_runtime_stats.latency_p95_ms,
  tps: model_runtime_stats.tps,
  ttft_ms: model_runtime_stats.ttft_ms,
  cache_hit_rate: model_runtime_stats.cache_hit_rate,
  cost_usd: model_runtime_stats.cost_usd,
  success: model_runtime_stats.success,
  measured_at: model_runtime_stats.measured_at,
};

const pricingColumns = {
  model_id: pricing.model_id,
  tier_size: pricing.tier_size,
  input: pricing.input,
  output: pricing.output,
  cache_read: pricing.cache_read,
  cache_write: pricing.cache_write,
  updated_at: pricing.updated_at,
};

export function createCatalogRouter(): Router {
  const router = Router();

  // GET /api/models?provider=&reasoning=&tool_call=&min_context=&sort=
  router.get('/models', async (req, res) => {
    const rows = await listCatalogModels({
      provider: typeof req.query.provider === 'string' ? req.query.provider : undefined,
      reasoning: req.query.reasoning === '1',
      toolCall: req.query.tool_call === '1',
      minContext: req.query.min_context ? Number(req.query.min_context) : undefined,
      sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
    });
    res.json({ data: rows });
  });

  router.get('/models/:id', async (req, res) => {
    const model = (await getModelDetail(req.params.id))[0] ?? null;
    if (!model) { res.status(404).json({ error: 'Model not found' }); return; }
    const [{ rows: benchmarkRows }, { rows: runtimeRows }] = await Promise.all([
      paginate(benchmarks, benchmarkColumns, {
        where: eq(benchmarks.model_id, req.params.id),
        orderBy: 'benchmark', pageSize: 200, offset: 0,
      }),
      paginate(model_runtime_stats, runtimeColumns, {
        where: eq(model_runtime_stats.model_id, req.params.id),
        orderBy: 'measured_at', dir: 'desc', pageSize: 50, offset: 0,
      }),
    ]);
    const benchmarksOut = benchmarkRows.map((r: Record<string, unknown>) => ({
      benchmark: r.benchmark, source: r.source, score: r.score,
      measured_at: r.measured_at, source_url: r.source_url, is_preferred: r.is_preferred,
    }));
    const runtime = runtimeRows.map((r: Record<string, unknown>) => ({
      run_id: r.run_id, latency_p50_ms: r.latency_p50_ms, latency_p95_ms: r.latency_p95_ms,
      tps: r.tps, ttft_ms: r.ttft_ms, cache_hit_rate: r.cache_hit_rate, cost_usd: r.cost_usd,
      success: r.success, measured_at: r.measured_at,
    }));
    res.json({ model, benchmarks: benchmarksOut, runtime });
  });

  router.get('/benchmarks', async (req, res) => {
    const conds = [];
    if (typeof req.query.name === 'string') conds.push(eq(benchmarks.benchmark, req.query.name));
    if (typeof req.query.source === 'string') conds.push(eq(benchmarks.source, req.query.source));
    if (typeof req.query.model === 'string') conds.push(eq(benchmarks.model_id, req.query.model));
    const { rows } = await paginate(benchmarks, benchmarkColumns, {
      where: conds.length ? and(...conds) : undefined,
      orderBy: 'benchmark, score DESC',
      pageSize: 1000,
      offset: 0,
    });
    res.json({ data: rows });
  });

  router.get('/benchmarks/:modelId', async (req, res) => {
    const { rows } = await paginate(benchmarks, benchmarkColumns, {
      where: eq(benchmarks.model_id, req.params.modelId),
      orderBy: 'benchmark', pageSize: 200, offset: 0,
    });
    res.json({ data: rows });
  });

  router.get('/pricing', async (req, res) => {
    const { rows } = await paginate(pricing, pricingColumns, {
      where: typeof req.query.model === 'string' ? eq(pricing.model_id, req.query.model) : undefined,
      orderBy: 'model_id', pageSize: 5000, offset: 0,
    });
    res.json({ data: rows });
  });

  return router;
}

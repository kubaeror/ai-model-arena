import { Router } from 'express';
import {
  listCatalogModels, getModelDetail,
} from '../../db/query.js';

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
    });
    res.json({ data: rows });
  });

  router.get('/models/:id', async (req, res) => {
    const model = (await getModelDetail(req.params.id))[0] ?? null;
    if (!model) { res.status(404).json({ error: 'Model not found' }); return; }
    const { paginatedQuery } = await import('../../db/query.js');
    const { rows: benchmarks } = await paginatedQuery({
      table: 'benchmarks', select: 'benchmark, source, score, measured_at, source_url, is_preferred',
      whereClause: 'model_id = ?', params: [req.params.id],
      orderBy: 'benchmark', limit: 200, offset: 0,
    });
    const { rows: runtime } = await paginatedQuery({
      table: 'model_runtime_stats',
      select: 'run_id, latency_p50_ms, latency_p95_ms, tps, ttft_ms, cache_hit_rate, cost_usd, success, measured_at',
      whereClause: 'model_id = ?', params: [req.params.id],
      orderBy: 'measured_at DESC', limit: 50, offset: 0,
    });
    res.json({ model, benchmarks, runtime });
  });

  router.get('/benchmarks', async (req, res) => {
    const where: string[] = [];
    const params: string[] = [];
    if (typeof req.query.name === 'string') { where.push('benchmark = ?'); params.push(req.query.name); }
    if (typeof req.query.source === 'string') { where.push('source = ?'); params.push(req.query.source); }
    if (typeof req.query.model === 'string') { where.push('model_id = ?'); params.push(req.query.model); }
    const { paginatedQuery } = await import('../../db/query.js');
    const { rows } = await paginatedQuery({
      table: 'benchmarks',
      whereClause: where.length ? where.join(' AND ') : '1=1',
      params,
      orderBy: 'benchmark, score DESC',
      limit: 1000,
      offset: 0,
    });
    res.json({ data: rows });
  });

  router.get('/benchmarks/:modelId', async (req, res) => {
    const { paginatedQuery } = await import('../../db/query.js');
    const { rows } = await paginatedQuery({
      table: 'benchmarks',
      whereClause: 'model_id = ?', params: [req.params.modelId],
      orderBy: 'benchmark', limit: 200, offset: 0,
    });
    res.json({ data: rows });
  });

  router.get('/pricing', async (req, res) => {
    const params = typeof req.query.model === 'string' ? [req.query.model] : [];
    const { paginatedQuery } = await import('../../db/query.js');
    const { rows } = await paginatedQuery({
      table: 'pricing',
      whereClause: typeof req.query.model === 'string' ? 'model_id = ?' : '1=1',
      params,
      orderBy: 'model_id',
      limit: 5000,
      offset: 0,
    });
    res.json({ data: rows });
  });

  return router;
}

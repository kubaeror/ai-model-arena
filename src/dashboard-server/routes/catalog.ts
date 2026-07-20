import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createCatalogRouter(): Router {
  const router = Router();

  // GET /api/models?provider=&reasoning=&tool_call=&min_context=&sort=
  router.get('/models', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.provider === 'string') { where.push('m.provider_id = @provider'); params.provider = req.query.provider; }
    if (req.query.reasoning === '1') where.push('m.reasoning = 1');
    if (req.query.tool_call === '1') where.push('m.tool_call = 1');
    if (req.query.min_context) { where.push('m.context_limit >= @min_context'); params.min_context = Number(req.query.min_context); }
    const sort = req.query.sort === 'context' ? 'm.context_limit DESC' : req.query.sort === 'name' ? 'm.name ASC' : 'm.name ASC';
    const sql = `
      SELECT m.id, m.name, m.family, m.provider_id, m.release_date, m.attachment, m.reasoning, m.temperature,
        m.tool_call, m.context_limit, m.output_limit, m.status, m.reasoning_options,
        p.input, p.output, p.cache_read, p.cache_write
      FROM models m LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${sort}
    `;
    const rows = db.prepare(sql).all(params);
    res.json({ data: rows });
  });

  router.get('/models/:id', (req, res) => {
    const db = getDb();
    const model = db.prepare(`
      SELECT m.*, p.input, p.output, p.cache_read, p.cache_write, p.tier_size
      FROM models m LEFT JOIN pricing p ON p.model_id = m.id
      WHERE m.id = ?
    `).get(req.params.id);
    if (!model) { res.status(404).json({ error: 'Model not found' }); return; }
    const benchmarks = db.prepare('SELECT benchmark, source, score, measured_at, source_url, is_preferred FROM benchmarks WHERE model_id = ? ORDER BY benchmark').all(req.params.id);
    const runtime = db.prepare('SELECT run_id, latency_p50_ms, latency_p95_ms, tps, ttft_ms, cache_hit_rate, cost_usd, success, measured_at FROM model_runtime_stats WHERE model_id = ? ORDER BY measured_at DESC LIMIT 50').all(req.params.id);
    res.json({ model, benchmarks, runtime });
  });

  router.get('/benchmarks', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.name === 'string') { where.push('benchmark = @name'); params.name = req.query.name; }
    if (typeof req.query.source === 'string') { where.push('source = @source'); params.source = req.query.source; }
    if (typeof req.query.model === 'string') { where.push('model_id = @model'); params.model = req.query.model; }
    const sql = `SELECT * FROM benchmarks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY benchmark, score DESC`;
    res.json({ data: db.prepare(sql).all(params) });
  });

  router.get('/benchmarks/:modelId', (req, res) => {
    const db = getDb();
    res.json({ data: db.prepare('SELECT * FROM benchmarks WHERE model_id = ? ORDER BY benchmark').all(req.params.modelId) });
  });

  router.get('/pricing', (req, res) => {
    const db = getDb();
    const where = typeof req.query.model === 'string' ? 'WHERE model_id = ?' : '';
    const params = typeof req.query.model === 'string' ? [req.query.model] : [];
    res.json({ data: db.prepare(`SELECT * FROM pricing ${where} ORDER BY model_id`).all(...params) });
  });

  return router;
}

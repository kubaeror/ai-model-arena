import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createMetricsRouter(): Router {
  const router = Router();

  // GET /api/metrics/runtime?model=&from=&to=&limit=
  router.get('/runtime', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.model === 'string') { where.push('model_id = @model'); params.model = req.query.model; }
    if (typeof req.query.from === 'string') { where.push('measured_at >= @from'); params.from = req.query.from; }
    if (typeof req.query.to === 'string') { where.push('measured_at <= @to'); params.to = req.query.to; }
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const sql = `SELECT * FROM model_runtime_stats ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY measured_at DESC LIMIT ${limit}`;
    res.json({ data: db.prepare(sql).all(params) });
  });

  // GET /api/metrics/tps — leaderboard joining catalog + arena measurements
  router.get('/tps', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id as model_id, m.name, m.provider_id,
        AVG(r.tps) as avg_tps, MAX(r.tps) as max_tps,
        AVG(r.latency_p50_ms) as avg_latency_p50,
        AVG(r.cache_hit_rate) as avg_cache_hit_rate,
        COUNT(r.run_id) as run_count
      FROM models m
      LEFT JOIN model_runtime_stats r ON r.model_id = m.id
      GROUP BY m.id
      HAVING run_count > 0
      ORDER BY avg_tps DESC
    `).all();
    res.json({ data: rows });
  });

  return router;
}

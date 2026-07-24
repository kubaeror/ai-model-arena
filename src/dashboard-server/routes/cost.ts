import { Router } from 'express';
import { paginatedQuery, getCostSummary } from '../../db/query.js';

export function createCostRouter(): Router {
  const router = Router();

  // GET /api/cost/ledger - paginated, filterable cost entries
  router.get('/ledger', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;

    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];

    if (runId) { clauses.push('run_id = ?'); params.push(runId); }
    if (model) { clauses.push('model = ?'); params.push(model); }
    if (from) { clauses.push('recorded_at >= ?'); params.push(from); }
    if (to) { clauses.push('recorded_at <= ?'); params.push(to); }

    const { rows, total } = await paginatedQuery({
      table: 'cost_ledger',
      whereClause: clauses.join(' AND '),
      params,
      orderBy: 'recorded_at DESC',
      limit,
      offset,
    });

    res.json({ entries: rows, total, limit, offset });
  });

  // GET /api/cost/summary - aggregated cost by group
  router.get('/summary', async (req, res) => {
    const groupBy = (typeof req.query.by === 'string' ? req.query.by : 'model') as 'model' | 'day';
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;

    const rows = await getCostSummary(groupBy, model);

    res.json({ summary: rows, groupBy });
  });

  return router;
}

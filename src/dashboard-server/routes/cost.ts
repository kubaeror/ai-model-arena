import { Router } from 'express';
import { and, eq, gte, lte } from 'drizzle-orm';
import { paginate, getCostSummary } from '../../db/query.js';
import { cost_ledger } from '../../db/schema.js';

const costColumns = {
  id: cost_ledger.id,
  run_id: cost_ledger.run_id,
  model: cost_ledger.model,
  cost_usd: cost_ledger.cost_usd,
  recorded_at: cost_ledger.recorded_at,
};

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

    const conds = [];
    if (runId) conds.push(eq(cost_ledger.run_id, runId));
    if (model) conds.push(eq(cost_ledger.model, model));
    if (from) conds.push(gte(cost_ledger.recorded_at, from));
    if (to) conds.push(lte(cost_ledger.recorded_at, to));

    const { rows, total } = await paginate(cost_ledger, costColumns, {
      where: conds.length ? and(...conds) : undefined,
      orderBy: 'recorded_at',
      dir: 'desc',
      pageSize: limit,
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

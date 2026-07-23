import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createCostRouter(): Router {
  const router = Router();

  // GET /api/cost/ledger - paginated, filterable cost entries
  router.get('/ledger', (req, res) => {
    const db = getDb();
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

    const where = clauses.join(' AND ');

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM cost_ledger WHERE ${where}`).get(...params) as { total: number };
    params.push(limit, offset);

    const rows = db.prepare(`
      SELECT * FROM cost_ledger
      WHERE ${where}
      ORDER BY recorded_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    res.json({ entries: rows, total: countRow.total, limit, offset });
  });

  // GET /api/cost/summary - aggregated cost by group
  router.get('/summary', (req, res) => {
    const db = getDb();
    const groupBy = (typeof req.query.by === 'string' ? req.query.by : 'model') as 'model' | 'day';
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;

    let query: string;
    const params: unknown[] = [];

    if (groupBy === 'day') {
      query = `
        SELECT date(recorded_at) AS period, model, SUM(cost_usd) AS total_cost,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          COUNT(*) AS entry_count
        FROM cost_ledger
        WHERE ${model ? 'model = ?' : '1=1'}
        GROUP BY period, model
        ORDER BY period DESC, model ASC
      `;
      if (model) params.push(model);
    } else {
      query = `
        SELECT model, SUM(cost_usd) AS total_cost,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          COUNT(*) AS entry_count
        FROM cost_ledger
        WHERE ${model ? 'model = ?' : '1=1'}
        GROUP BY model
        ORDER BY total_cost DESC
      `;
      if (model) params.push(model);
    }

    const rows = db.prepare(query).all(...params);

    res.json({ summary: rows, groupBy });
  });

  return router;
}

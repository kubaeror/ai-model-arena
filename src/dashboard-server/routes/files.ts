import { Router } from 'express';
import { paginatedQuery } from '../../db/query.js';

export function createFilesRouter(): Router {
  const router = Router();

  // GET /api/files - paginated, filterable file listing
  router.get('/', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const model = typeof req.query.model === 'string' ? req.query.model : undefined;
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    const promptId = typeof req.query.promptId === 'string' ? req.query.promptId : undefined;
    const tool = typeof req.query.tool === 'string' ? req.query.tool : undefined;

    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];

    if (model) { clauses.push('model = ?'); params.push(model); }
    if (runId) { clauses.push('run_id = ?'); params.push(runId); }
    if (promptId) { clauses.push('prompt_id = ?'); params.push(promptId); }
    if (tool) { clauses.push('produced_by_tool = ?'); params.push(tool); }

    const { rows, total } = await paginatedQuery({
      table: 'files',
      whereClause: clauses.join(' AND '),
      params,
      orderBy: 'produced_at DESC',
      limit,
      offset,
    });

    res.json({ files: rows, total, limit, offset });
  });

  return router;
}

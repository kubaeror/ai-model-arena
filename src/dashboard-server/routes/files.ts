import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { paginate } from '../../db/query.js';
import { files } from '../../db/schema.js';

const fileColumns = {
  id: files.id,
  run_id: files.run_id,
  prompt_id: files.prompt_id,
  model: files.model,
  produced_at: files.produced_at,
  produced_by_tool: files.produced_by_tool,
};

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

    const conds = [];
    if (model) conds.push(eq(files.model, model));
    if (runId) conds.push(eq(files.run_id, runId));
    if (promptId) conds.push(eq(files.prompt_id, promptId));
    if (tool) conds.push(eq(files.produced_by_tool, tool));

    const { rows, total } = await paginate(files, fileColumns, {
      where: conds.length ? and(...conds) : undefined,
      orderBy: 'produced_at',
      dir: 'desc',
      pageSize: limit,
      offset,
    });

    res.json({ files: rows, total, limit, offset });
  });

  return router;
}

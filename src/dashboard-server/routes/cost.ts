import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { getCostSummary } from '../../db/query.js';

/** Cost ledger read surface (viewer-level). Query params: groupBy=model|day, model=. */
export function createCostRouter(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const groupBy = req.query.groupBy === 'day' ? 'day' : 'model';
    const model = typeof req.query.model === 'string' ? String(req.query.model) : undefined;
    const models = await getCostSummary(groupBy, model);
    res.json({ groupBy, models });
  }));

  return router;
}

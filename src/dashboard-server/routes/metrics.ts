import { Router } from 'express';
import { queryModelRuntimeStats, queryTpsLeaderboard } from '../../db/query.js';

export function createMetricsRouter(): Router {
  const router = Router();

  // GET /api/metrics/runtime?model=&from=&to=&limit=
  router.get('/runtime', async (req, res) => {
    const modelId = typeof req.query.model === 'string' ? req.query.model : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);

    const data = await queryModelRuntimeStats({ modelId, from, to, limit });
    res.json({ data });
  });

  // GET /api/metrics/tps — leaderboard joining catalog + arena measurements
  router.get('/tps', async (_req, res) => {
    const rows = await queryTpsLeaderboard();
    res.json({ data: rows });
  });

  return router;
}

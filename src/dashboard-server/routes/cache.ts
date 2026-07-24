import { Router } from 'express';
import { queryCacheLeaderboard } from '../../db/query.js';
import { getCacheStates } from '../../catalog/cache.js';
import type { ApiKeyRequest } from '../auth-api-types.js';
import { INTERNAL_ERROR } from '../error-sanitizer.js';

export function createCacheRouter(): Router {
  const router = Router();

  router.get('/stats', async (_req, res) => {
    res.json({ data: await getCacheStates() });
  });

  router.get('/leaderboard', async (_req, res) => {
    const rows = await queryCacheLeaderboard();
    res.json({ data: rows });
  });

  router.post('/refresh', async (req, res) => {
    const apiKeyCtx = (req as ApiKeyRequest).apiKey;
    if (apiKeyCtx && !apiKeyCtx.permissions.includes('cache:write')) {
      res.status(403).json({ error: 'Missing permission: cache:write' });
      return;
    }
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    if (!source || !['models.dev', 'modelbench', 'zeroeval'].includes(source)) {
      res.status(400).json({ error: 'source must be one of: models.dev, modelbench, zeroeval' });
      return;
    }
    try {
      if (source === 'models.dev') {
        const { fetchSync } = await import('../../catalog/sync.js');
        const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
        res.json(result);
      } else {
        const { fetchBenchmarks } = await import('../../catalog/benchmarks.js');
        const result = await fetchBenchmarks(source as 'modelbench' | 'zeroeval', { force: true });
        res.json(result);
      }
    } catch {
      res.status(500).json({ error: INTERNAL_ERROR });
    }
  });

  return router;
}

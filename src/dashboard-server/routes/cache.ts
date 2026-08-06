import { Router } from 'express';
import { queryCacheLeaderboard } from '../../db/query.js';
import { getCacheStates, ensureFresh } from '../../catalog/cache.js';
import type { ApiKeyRequest } from '../auth-api-types.js';
import { requireRole } from '../../auth/rbac.js';
import { asyncHandler } from '../helpers.js';

export function createCacheRouter(): Router {
  const router = Router();

  router.get('/stats', async (_req, res) => {
    res.json({ data: await getCacheStates() });
  });

  router.get('/leaderboard', async (_req, res) => {
    const rows = await queryCacheLeaderboard();
    res.json({ data: rows });
  });

  // Write operation: a viewer must not be able to force catalog re-syncs.
  router.post('/refresh', requireRole('editor'), asyncHandler(async (req, res) => {
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
    const result = await ensureFresh(source as 'models.dev' | 'modelbench' | 'zeroeval', { force: true });
    res.json(result ?? { ok: true });
  }));

  return router;
}

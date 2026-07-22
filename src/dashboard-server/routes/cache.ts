import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { getCacheStates } from '../../catalog/cache.js';
import type { ApiKeyRequest } from '../auth-api-types.js';

export function createCacheRouter(): Router {
  const router = Router();

  router.get('/stats', (_req, res) => {
    res.json({ data: getCacheStates(getDb()) });
  });

  router.get('/leaderboard', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id, m.name, m.provider_id, m.context_limit,
        p.input, p.output, p.cache_read,
        (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index') as intelligence,
        (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Coding Score') as coding,
        (SELECT AVG(r.tps) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_tps,
        (SELECT AVG(r.latency_p50_ms) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_latency,
        (SELECT COUNT(*) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_runs
      FROM models m
      LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
      ORDER BY intelligence DESC
    `).all();
    res.json({ data: rows });
  });

  router.post('/refresh', async (req, res) => {
    // If using API key auth, require cache:write scope for mutations
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
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

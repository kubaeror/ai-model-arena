import { Router } from 'express';
import { computeObservabilityStats } from '../../observability/stats.js';
import { exporterEndpoint, isTracingEnabled } from '../../observability/tracing.js';
import { getDb, closeDb } from '../../anomaly-detection/db.js';
import * as pm2h from '../../orchestrator/pm2-helpers.js';

/**
 * Observability API:
 *  GET /api/v1/observability/stats   — aggregated latency/error/baseline stats
 *  GET /api/v1/observability/health   — healthcheck for OTel exporter, SQLite, PM2
 */
export function createObservabilityRouter(): Router {
  const router = Router();

  // GET /stats — avg/p95/p99 latency per model/tool, error rates, baselines.
  router.get('/stats', (req, res) => {
    const model = typeof req.query.model === 'string' ? String(req.query.model) : undefined;
    try {
      res.json(computeObservabilityStats(model));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /health — healthcheck for external monitoring of ai-model-arena itself.
  router.get('/health', async (_req, res) => {
    const otel = {
      enabled: isTracingEnabled(),
      exporterEndpoint: exporterEndpoint() ?? null,
      reachable: exporterEndpoint() ? 'configured' : 'not_configured',
    };

    let sqlite: { ok: boolean; error?: string } = { ok: false };
    try {
      const db = getDb();
      // A trivial query proves the handle is live + file readable/writable.
      db.prepare('SELECT 1 AS ok').get();
      sqlite = { ok: true };
    } catch (err) {
      sqlite = { ok: false, error: err instanceof Error ? err.message : String(err) };
      closeDb();
    }

    let pm2Bus: { ok: boolean; error?: string } = { ok: false };
    try {
      await pm2h.pm2Connect();
      await pm2h.pm2List();
      await pm2h.pm2Disconnect();
      pm2Bus = { ok: true };
    } catch (err) {
      pm2Bus = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const healthy = otel.enabled && sqlite.ok && pm2Bus.ok;
    res.status(healthy ? 200 : 503).json({ healthy, otel, sqlite, pm2Bus, timestamp: new Date().toISOString() });
  });

  return router;
}

import { Router } from 'express';
import { computeObservabilityStats } from '../../observability/stats.js';
import { getDb, closeDb } from '../../anomaly-detection/db.js';
import { listRuns } from '../../orchestrator/run-index.js';
import { readTraceIndex } from '../../observability/trace-meta.js';

/**
 * Observability API:
 *  GET /api/v1/observability/stats          — aggregated latency/error/baseline stats
 *  GET /api/v1/observability/recent-traces  — recent traces across all runs
 *  GET /api/v1/observability/health          — healthcheck for OTel exporter, SQLite, PM2
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

  // GET /recent-traces — latest N traces across all runs.
  router.get('/recent-traces', (req, res) => {
    const limit = Math.min(
      Number(req.query.limit) || 50,
      200,
    );
    try {
      const runs = listRuns();
      const entries: Array<{
        runId: string;
        model: string;
        scenario: string;
        spanCount: number;
        totalDurationMs: number;
        errorCount: number;
      }> = [];
      for (const run of runs) {
        if (entries.length >= limit) break;
        for (const pm of run.perModel) {
          if (entries.length >= limit) break;
          const idx = readTraceIndex(pm.outputDir);
          entries.push({
            runId: run.runId,
            model: pm.model,
            scenario: run.scenario,
            spanCount: idx?.span_count ?? 0,
            totalDurationMs: idx?.total_duration_ms ?? 0,
            errorCount: idx?.error_count ?? 0,
          });
        }
      }
      res.json({ traces: entries });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /health — healthcheck for SQLite.
  router.get('/health', async (_req, res) => {
    let sqlite: { ok: boolean; error?: string } = { ok: false };
    try {
      const db = getDb();
      db.prepare('SELECT 1 AS ok').get();
      sqlite = { ok: true };
    } catch (err) {
      sqlite = { ok: false, error: err instanceof Error ? err.message : String(err) };
      closeDb();
    }

    const healthy = sqlite.ok;
    res.status(healthy ? 200 : 503).json({ healthy, sqlite, timestamp: new Date().toISOString() });
  });

  return router;
}

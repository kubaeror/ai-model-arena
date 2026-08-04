import { Router } from 'express';
import { getRunRecord } from '../../orchestrator/run-index.js';
import { readTraceMeta, type TraceMeta } from '../../observability/trace-meta.js';
import { allowIfRunOwner } from '../run-ownership.js';
import type { AuthedRequest } from '../auth.js';

/**
 * GET /api/v1/traces/:runId — stored span metadata tree for a run.
 *
 * Returns the per-model trace metadata reconstructed from the locally stored
 * `trace-meta.json` files. Traces are rendered in-app via the TraceWaterfall
 * component and the Observability page — no external backend required.
 */
export function createTracesRouter(): Router {
  const router = Router();

  router.get('/:runId', async (req, res) => {
    const runId = String(req.params.runId);
    if (!(await allowIfRunOwner(req as AuthedRequest, res, runId, `Run not found: ${runId}`))) return;
    const modelFilter = typeof req.query.model === 'string' ? String(req.query.model) : undefined;
    const rec = await getRunRecord(runId);
    if (!rec) return;

    const traces = rec.perModel
      .filter((pm) => !modelFilter || pm.model === modelFilter)
      .map((pm) => {
        const meta: TraceMeta | null = readTraceMeta(pm.outputDir);
        if (!meta) {
          return {
            model: pm.model,
            traceId: null,
            spanCount: 0,
            totalDurationMs: 0,
            errorCount: 0,
            spans: [],
          };
        }
        return {
          model: pm.model,
          traceId: meta.traceId,
          spanCount: meta.spanCount,
          totalDurationMs: meta.totalDurationMs,
          errorCount: meta.errorCount,
          spans: meta.spans,
        };
      });

    res.json({
      runId,
      scenario: rec.scenario,
      traces,
    });
  });

  return router;
}

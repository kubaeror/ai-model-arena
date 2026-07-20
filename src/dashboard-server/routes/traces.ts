import { Router } from 'express';
import { getRunRecord } from '../../orchestrator/run-index.js';
import { readTraceMeta, type TraceMeta } from '../../observability/trace-meta.js';
import { externalTraceUrl, exporterEndpoint } from '../../observability/tracing.js';

/**
 * GET /api/v1/traces/:runId — stored span metadata tree for a run.
 *
 * Returns the per-model trace metadata reconstructed from the locally stored
 * `trace-meta.json` files. When an external OTel backend + trace UI are
 * configured (`OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_TRACE_UI_BASE_URL`), each
 * trace also carries an `externalUrl` linking straight into Jaeger/Grafana.
 */
export function createTracesRouter(): Router {
  const router = Router();

  router.get('/:runId', (req, res) => {
    const runId = String(req.params.runId);
    const modelFilter = typeof req.query.model === 'string' ? String(req.query.model) : undefined;
    const rec = getRunRecord(runId);
    if (!rec) {
      res.status(404).json({ error: `Run not found: ${runId}` });
      return;
    }

    const externalBackend = Boolean(exporterEndpoint());
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
            externalUrl: null,
            spans: [],
          };
        }
        return {
          model: pm.model,
          traceId: meta.traceId,
          spanCount: meta.spanCount,
          totalDurationMs: meta.totalDurationMs,
          errorCount: meta.errorCount,
          externalUrl: meta.externalUrl ?? externalTraceUrl(meta.traceId),
          spans: meta.spans,
        };
      });

    res.json({
      runId,
      scenario: rec.scenario,
      externalBackend,
      traces,
    });
  });

  return router;
}

import { Router } from 'express';
import { audit } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { INTERNAL_ERROR } from '../error-sanitizer.js';
import {
  listAnomalies,
  getAnomaly,
  resolveAnomaly,
  type AnomalyType,
  type AnomalySeverity,
  type AnomalyQuery,
} from '../../anomaly-detection/db.js';
import { getRunRecord } from '../../orchestrator/run-index.js';
import { readTraceMeta } from '../../observability/trace-meta.js';

function parseBool(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

export function createAnomaliesRouter(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const q: AnomalyQuery = {
      model: typeof req.query.model === 'string' ? String(req.query.model) : undefined,
      type: typeof req.query.type === 'string' ? (String(req.query.type) as AnomalyType) : undefined,
      severity: typeof req.query.severity === 'string' ? (String(req.query.severity) as AnomalySeverity) : undefined,
      resolved: parseBool(req.query.resolved),
      from: typeof req.query.from === 'string' ? String(req.query.from) : undefined,
      to: typeof req.query.to === 'string' ? String(req.query.to) : undefined,
      limit: req.query.limit ? Math.min(500, Number(req.query.limit)) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    };
    try {
      res.json({ anomalies: await listAnomalies(q) });
    } catch {
      res.status(500).json({ error: INTERNAL_ERROR });
    }
  });

  router.get('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid anomaly id' });
      return;
    }
    const anomaly = await getAnomaly(id);
    if (!anomaly) {
      res.status(404).json({ error: `Anomaly ${id} not found` });
      return;
    }
    let run = null;
    let trace = null;
    const rec = await getRunRecord(anomaly.run_id);
    if (rec) {
      const pm = rec.perModel.find((m) => m.model === anomaly.model);
      run = {
        runId: rec.runId,
        scenario: rec.scenario,
        model: anomaly.model,
        success: pm?.success,
        durationMs: pm?.durationMs,
      };
      if (pm) {
        const meta = readTraceMeta(pm.outputDir);
        if (meta) {
          trace = {
            traceId: meta.traceId,
            spanCount: meta.spanCount,
            errorCount: meta.errorCount,
            spans: meta.spans,
          };
        }
      }
    }
    res.json({ anomaly, run, trace });
  });

  router.patch('/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid anomaly id' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resolvedAs = body.resolved_as ?? body.resolvedAs ?? body.status;
    if (resolvedAs !== 'resolved' && resolvedAs !== 'false_positive') {
      res.status(400).json({ error: 'resolved_as must be "resolved" or "false_positive"' });
      return;
    }
    const updated = await resolveAnomaly(id, resolvedAs as 'resolved' | 'false_positive');
    if (!updated) {
      res.status(404).json({ error: `Anomaly ${id} not found` });
      return;
    }
    audit((req as AuthedRequest).user?.sub ?? 'system', 'anomaly.resolve', { type: 'anomaly', id: String(id) }, undefined, { resolvedAs }).catch(() => {});
    res.json({ anomaly: updated });
  });

  return router;
}

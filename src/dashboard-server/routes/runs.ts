import { Router } from 'express';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  listRuns,
  getRunRecord,
  startRun,
  stopRun,
  restartRun,
  checkRunStatus,
} from '../../orchestrator/orchestrator.js';
import type { RunSpec } from '../../orchestrator/run-lifecycle.js';
import type { RunIndexModelEntry } from '../../orchestrator/run-index.js';
import { safeResolve } from '../../sandbox/sandbox.js';
import { readDiffPatch } from '../../sandbox/git.js';
import { walkFiles } from '../../fs/walk.js';
import { auditSafe, requireRole } from '../../auth/rbac.js';
import type { AuthedRequest } from '../auth.js';
import { allowIfRunOwner } from '../run-ownership.js';

async function findEntry(runId: string, model: string): Promise<RunIndexModelEntry | undefined> {
  return (await getRunRecord(runId))?.perModel.find((m) => m.model === model);
}

/**
 * Ownership check for a run. Returns one of:
 *   - { ok: true }                — the caller may proceed (is owner or admin)
 *   - { ok: false, status: 404 }  — run not found
 *   - { ok: false, status: 403 }  — run exists but caller is neither owner nor admin
 *
 * Default-DENY (H2): a run with no `createdBy` (legacy/migrated) is NOT
 * accessible to non-admins. Previously `rec.createdBy && ...` short-circuited
 * to allow when createdBy was null, letting any authenticated viewer read
 * another tenant's sandbox files, logs, diffs, and metadata by runId — an
 * IDOR-style confidentiality gap. Now: only the owner or an admin may proceed.
 */
const IGNORE_DIRS = ['dist', '.cache'];

async function readTail(filePath: string, lines = 400): Promise<string> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function createRunsRouter(): Router {
  const router = Router();

  // GET /api/runs — list all runs (from the index, no filesystem scan)
  router.get('/', async (_req, res) => {
    res.json({ runs: await listRuns() });
  });

  // POST /api/runs — trigger a new run (non-blocking; uses the orchestrator)
  router.post('/', requireRole('editor'), async (req, res) => {
    const scenario = String(req.body?.scenario ?? '');
    const rawModels = req.body?.models;
    if (!scenario || !Array.isArray(rawModels) || rawModels.length === 0) {
      res.status(400).json({ error: 'body must include scenario (string) and models (non-empty string[])' });
      return;
    }
    const models: string[] = (rawModels as unknown[])
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      .map((m) => m.trim());
    if (models.length === 0) {
      res.status(400).json({ error: 'models[] must contain at least one non-empty string' });
      return;
    }
    if (models.some((m) => m.includes('/') || m.includes('\\') || m.includes('..'))) {
      res.status(400).json({ error: 'model names must not contain path separators or ..' });
      return;
    }
    try {
      const spec: RunSpec = await startRun({ scenario, models, source: 'dashboard', createdBy: (req as AuthedRequest).user?.sub });
      auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'run.create', { type: 'run', id: spec.runId }, undefined, { scenario, models });
      res.status(202).json({
        runId: spec.runId,
        scenario: spec.scenario,
        startedAt: spec.startedAt,
        models: spec.models.map((m) => ({ model: m.model })),
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /api/runs/:runId — run metadata + live per-model status
  router.get('/:runId', async (req, res) => {
    // This endpoint returns absolute filesystem paths (sandboxDir, outputDir,
    // resultPath, conversationPath, reportPath, logFile). Restrict it to the
    // run owner or admin to avoid leaking the on-disk layout of another
    // tenant's run.
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const rec = await getRunRecord(req.params.runId as string);
    if (!rec) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    const spec = {
      runId: rec.runId, scenario: rec.scenario, ts: '', startedAt: rec.startedAt,
      models: rec.perModel.map((m) => ({ model: m.model, providerId: 'unknown', outputDir: m.outputDir, sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath, reportPath: m.reportPath, logFile: m.logFile })),
    } satisfies RunSpec;
    let statuses: { model: string; status: string; online: boolean; exitCode: number | null }[] = [];
    try {
      statuses = (await checkRunStatus(spec)).map((s) => ({
        model: s.model, status: s.status, online: s.online, exitCode: s.exitCode,
      }));
    } catch {
      /* pm2 unavailable — still return the index record */
    }
    res.json({ run: rec, statuses });
  });

  // GET /api/runs/:runId/models/:model/conversation
  router.get('/:runId/models/:model/conversation', async (req, res) => {
    // Default-deny ownership check (H2): runs with no createdBy are only
    // accessible to admins.
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    try {
      const raw = await fsp.readFile(entry.conversationPath, 'utf8');
      res.json({ model: req.params.model, conversation: JSON.parse(raw) });
    } catch {
      res.json({ model: req.params.model, conversation: { entries: [] } });
    }
  });

  // GET /api/runs/:runId/models/:model/report
  router.get('/:runId/models/:model/report', async (req, res) => {
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    res.type('text/markdown').send(await readTail(entry.reportPath, 100000) || '(report not available yet)');
  });

  // GET /api/runs/:runId/models/:model/files — list sandbox files
  router.get('/:runId/models/:model/files', async (req, res) => {
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    if (!fs.existsSync(entry.sandboxDir)) {
      res.json({ files: [] });
      return;
    }
    const files = walkFiles(entry.sandboxDir, { exclude: IGNORE_DIRS })
      .map((f) => path.relative(entry.sandboxDir, f).replace(/\\/g, '/'))
      .sort();
    res.json({ files });
  });

  // GET /api/runs/:runId/models/:model/files/* — read one sandbox file
  router.get('/:runId/models/:model/files/*filepath', async (req, res) => {
    // Ownership check (H3): without this, any authenticated viewer could read
    // any run's sandbox files by runId — sandbox files frequently contain
    // secrets, prompts, and model-generated credentials.
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    const prefix = `/api/runs/${req.params.runId as string}/models/${req.params.model}/files/`;
    const relRaw = req.path.startsWith(prefix) ? req.path.slice(prefix.length) : '';
    let abs: string;
    try {
      abs = safeResolve(entry.sandboxDir, decodeURIComponent(relRaw));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    try {
      const content = await fsp.readFile(abs, 'utf8');
      res.type('text/plain').send(content);
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });

  // GET /api/runs/:runId/models/:model/logs — tail PM2 log
  router.get('/:runId/models/:model/logs', async (req, res) => {
    // Ownership check (H3): PM2 logs can leak environment variables, build
    // output, and model-generated credentials. Without this check any
    // authenticated viewer could read any run's logs by runId.
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    res.type('text/plain').send(await readTail(entry.logFile, 400));
  });

  // POST /api/runs/:runId/stop
  router.post('/:runId/stop', requireRole('editor'), async (req, res) => {
    try {
      if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string, 'run not found'))) return;
      await stopRun(req.params.runId as string);
      auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'run.stop', { type: 'run', id: req.params.runId as string });
      res.json({ runId: req.params.runId as string, action: 'stop' });
    } catch (e) {
      res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /api/runs/:runId/restart
  router.post('/:runId/restart', requireRole('editor'), async (req, res) => {
    try {
      if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string, 'run not found'))) return;
      await restartRun(req.params.runId as string);
      auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'run.restart', { type: 'run', id: req.params.runId as string });
      res.json({ runId: req.params.runId as string, action: 'restart' });
    } catch (e) {
      res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // GET /api/runs/:runId/models/:model/diff
  router.get('/:runId/models/:model/diff', async (req, res) => {
    // Ownership check (H3): diffs expose generated source code; restrict to
    // the run owner or an admin, matching the conversation/report/files-list
    // endpoints above.
    if (!(await allowIfRunOwner(req as AuthedRequest, res, req.params.runId as string))) return;
    const entry = await findEntry(req.params.runId as string, req.params.model);
    if (!entry) {
      res.status(404).json({ error: 'Run or model not found' });
      return;
    }
    const diff = await readDiffPatch(entry.outputDir);
    res.json({ model: req.params.model, diff });
  });

  return router;
}

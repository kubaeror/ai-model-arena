import type { Response } from 'express';
import { getRunRecord } from '../orchestrator/run-index.js';
import type { AuthedRequest } from './auth.js';
import { isOwnerAllowed } from '../auth/rbac.js';

/**
 * Shared run-ownership gate (extracted from routes/runs.ts so every runId
 * endpoint — runs, traces, export, sessions — enforces the same contract).
 *
 * Default-DENY (H2 / I3): a run with no `createdBy` (legacy/migrated) is NOT
 * accessible to non-admins, closing the IDOR gap where any authenticated
 * viewer could read another tenant's artifacts by runId.
 */
async function checkRunOwnership(
  req: AuthedRequest,
  runId: string,
): Promise<{ ok: true } | { ok: false; status: 404 | 403 }> {
  const rec = await getRunRecord(runId);
  if (!rec) return { ok: false, status: 404 };
  const allowed = isOwnerAllowed({ sub: req.user?.sub, role: req.user?.role }, rec.createdBy);
  if (!allowed) return { ok: false, status: 403 };
  return { ok: true };
}

/**
 * Run `checkRunOwnership` and send the denial response when rejected;
 * returns `true` if the handler may proceed.
 */
export async function allowIfRunOwner(
  req: AuthedRequest,
  res: Response,
  runId: string,
  notFoundMsg: string = 'Run not found',
): Promise<boolean> {
  const owner = await checkRunOwnership(req, runId);
  if (owner.ok) return true;
  res.status(owner.status).json({
    error: owner.status === 404 ? notFoundMsg : 'forbidden: not the run owner',
  });
  return false;
}

import type { Response } from 'express';
import { getRunRecord, listRuns } from '../orchestrator/run-index.js';
import type { AuthedRequest } from './auth.js';
import { isOwnerAllowed, apiKeyIsAdmin } from '../auth/rbac.js';

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
  const allowed = apiKeyIsAdmin(req) || isOwnerAllowed({ sub: req.user?.sub, role: req.user?.role }, rec.createdBy);
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

/**
 * Resolve the run a dashboard session belongs to. Session ids are minted as
 * `${runId}-${model}` (run-lifecycle), so the fast path strips the known model
 * suffix and verifies the run record exists. Sessions without a matching run
 * resolve to null; callers default-deny non-admins for those.
 */
export async function resolveSessionRunId(
  sessionId: string,
  model: string | null | undefined,
): Promise<string | null> {
  if (model) {
    const suffix = `-${model}`;
    if (sessionId.endsWith(suffix)) {
      // Convention matched: the session belongs to this exact run or to no
      // live run at all. Never fall through to prefix matching here, which
      // could hand a session to an unrelated run that shares a prefix.
      const candidate = sessionId.slice(0, -suffix.length);
      return candidate && (await getRunRecord(candidate)) ? candidate : null;
    }
  }
  // Fallback for sessions whose model column is missing/stale: the longest run
  // id that prefixes `sessionId-` wins, so the most specific run owns it.
  let match: string | null = null;
  for (const rec of await listRuns()) {
    if (!sessionId.startsWith(`${rec.runId}-`)) continue;
    if (model && !rec.perModel.some((pm) => pm.model === model)) continue;
    if (!match || rec.runId.length > match.length) match = rec.runId;
  }
  return match;
}

/**
 * Session equivalent of `allowIfRunOwner`: resolves the owning run via
 * `resolveSessionRunId` and applies the same predicate. Sessions with no
 * resolvable run (legacy/migrated) are admin-only.
 */
export async function allowIfSessionOwner(
  req: AuthedRequest,
  res: Response,
  sessionId: string,
  model: string | null | undefined,
  notFoundMsg: string = 'Session not found',
): Promise<boolean> {
  const runId = await resolveSessionRunId(sessionId, model);
  if (runId) return allowIfRunOwner(req, res, runId, notFoundMsg);
  if (req.user?.role === 'admin' || apiKeyIsAdmin(req)) return true;
  res.status(403).json({ error: 'forbidden: not the session owner' });
  return false;
}

/**
 * Filter run-index rows to what the caller may see: admins (JWT or API key)
 * keep everything, everyone else only runs they own. Ownerless legacy runs
 * drop out for non-admins — the same default-deny predicate made by
 * `allowIfRunOwner`, applied to list/export responses.
 */
export function visibleRunsFor<T extends { createdBy?: string | null }>(
  req: AuthedRequest,
  runs: T[],
): T[] {
  if (req.user?.role === 'admin' || apiKeyIsAdmin(req)) return runs;
  const actor = req.user ?? {};
  return runs.filter((r) => isOwnerAllowed(actor, r.createdBy));
}

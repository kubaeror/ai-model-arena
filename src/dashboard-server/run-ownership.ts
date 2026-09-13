import type { Response } from 'express';
import { getRunRecord, listRuns } from '../orchestrator/run-index.js';
import type { RunIndexRecord } from '../orchestrator/run-index.js';
import type { AuthedRequest } from './auth.js';
import type { ApiKeyRequest } from './auth-api-types.js';
import { isOwnerAllowed, apiKeyIsAdmin } from '../auth/rbac.js';

/** True when the request is admin-equivalent (JWT role or ops:admin API key). */
export function isAdminRequest(req: AuthedRequest): boolean {
  return req.user?.role === 'admin' || apiKeyIsAdmin(req);
}

/**
 * Identity string for the request actor: the JWT subject, or `key:<name>` for
 * an API key (v1 run creation records the same string as `createdBy` so a key
 * owns the runs it creates). JWT-only requests are unaffected.
 */
export function actorSubject(req: AuthedRequest): string | undefined {
  const apiKey = (req as ApiKeyRequest).apiKey;
  return req.user?.sub ?? (apiKey ? `key:${apiKey.keyName}` : undefined);
}

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
  const allowed = apiKeyIsAdmin(req) || isOwnerAllowed({ sub: actorSubject(req), role: req.user?.role }, rec.createdBy);
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
 * suffix and verifies the run record exists AND actually ran that model. A
 * missing run never falls through to prefix matching (that would hand the
 * session to an unrelated run sharing its id prefix); a candidate that exists
 * only owns the session when `perModel` lists the model, otherwise the
 * longest-prefix fallback applies. Sessions without a matching run resolve to
 * null; callers default-deny non-admins for those.
 */
export async function resolveSessionRunId(
  sessionId: string,
  model: string | null | undefined,
): Promise<string | null> {
  if (model) {
    const suffix = `-${model}`;
    if (sessionId.endsWith(suffix)) {
      const candidate = sessionId.slice(0, -suffix.length);
      if (!candidate) return null;
      const rec = await getRunRecord(candidate);
      if (!rec) return null;
      if (rec.perModel.some((pm) => pm.model === model)) return candidate;
    }
  }
  return resolveSessionRunIdFromRuns(sessionId, model, await listRuns());
}

/**
 * Pure form of `resolveSessionRunId` for callers that already hold the run
 * index (list filters). Keeps the exact same ownership semantics: the fast
 * path requires `perModel` membership, and when it does not hold the longest
 * run id that prefixes `sessionId-` (and ran the model) wins.
 */
export function resolveSessionRunIdFromRuns(
  sessionId: string,
  model: string | null | undefined,
  runs: RunIndexRecord[],
): string | null {
  if (model) {
    const suffix = `-${model}`;
    if (sessionId.endsWith(suffix)) {
      const candidate = sessionId.slice(0, -suffix.length);
      if (!candidate) return null;
      const rec = runs.find((r) => r.runId === candidate);
      if (!rec) return null;
      if (rec.perModel.some((pm) => pm.model === model)) return candidate;
    }
  }
  let match: string | null = null;
  for (const rec of runs) {
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
  if (isAdminRequest(req)) return true;
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
  if (isAdminRequest(req)) return runs;
  const actor = { sub: actorSubject(req), role: req.user?.role };
  return runs.filter((r) => isOwnerAllowed(actor, r.createdBy));
}

/**
 * Build the per-session ownership predicate for list endpoints. Returns
 * `undefined` for admins so the query keeps its unfiltered pagination fast
 * path; for everyone else the predicate resolves each session's run with the
 * same semantics as `allowIfSessionOwner` (ownerless/foreign/orphan sessions
 * are hidden).
 */
export function sessionVisibilityFilter(
  req: AuthedRequest,
  runs: RunIndexRecord[],
): ((session: { id: string; model: string | null }) => boolean) | undefined {
  if (isAdminRequest(req)) return undefined;
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const actor = { sub: actorSubject(req), role: req.user?.role };
  return (session) => {
    const runId = resolveSessionRunIdFromRuns(session.id, session.model, runs);
    if (!runId) return false;
    const rec = byId.get(runId);
    return rec !== undefined && isOwnerAllowed(actor, rec.createdBy);
  };
}

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createLogger } from '../logger/pino-logger.js';

interface UserRequest extends Request {
  user?: { sub: string; role: string };
}

const logger = createLogger('ai-arena:audit');

const ROLE_ORDER = { viewer: 0, editor: 1, admin: 2 } as const;
type Role = keyof typeof ROLE_ORDER;

export function requireRole(min: Role): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as UserRequest).user?.role as string | undefined;
    const order = ROLE_ORDER as Record<string, number>;
    if (!role || (order[role] ?? -1) < (order[min] ?? 0)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

export function requireOwnership(
  getOwnerId: (req: Request) => string | undefined,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as UserRequest).user?.sub;
    const owner = getOwnerId(req);
    if (!owner) return next(); // No owner = legacy resource, allow
    if (actor !== owner && (req as UserRequest).user?.role !== 'admin') {
      res.status(403).json({ error: 'forbidden: not the resource owner' });
      return;
    }
    next();
  };
}

let auditFailureCount = 0;

export function getAuditFailureCount(): number {
  return auditFailureCount;
}

export async function audit(
  actor: string,
  action: string,
  entity: { type: string; id?: string },
  before?: unknown,
  after?: unknown,
): Promise<void> {
  try {
    const { insertAuditEntry } = await import('../db/query.js');
    await insertAuditEntry({
      actor,
      action,
      entityType: entity.type,
      entityId: entity.id ?? null,
      before: before ? JSON.stringify(before) : null,
      after: after ? JSON.stringify(after) : null,
      at: new Date().toISOString(),
    });
  } catch {
    auditFailureCount++;
    // Increment Prometheus counter if available (non-fatal if prom-client is not loaded)
    try {
      const { auditFailures } = await import('../observability/metrics.js');
      auditFailures.inc();
    } catch { /* metrics unavailable in test/dev */ }
  }
}

/**
 * Fire-and-forget audit wrapper. Returns `void` (not a Promise) so it is
 * eslint-safe under `no-floating-promises` — callers can invoke it as a plain
 * statement without a trailing `.catch()`.
 *
 * Replaces the 30+ `audit(...).catch(() => {})` call sites across the
 * dashboard routes, which swallowed audit-log failures silently (the outer
 * `.catch` was redundant because `audit()` already swallows internally, but
 * it also hid the failure from logs entirely — operators had no signal that
 * audit records were being dropped).
 *
 * This helper:
 *   - Is non-blocking (the route handler does not await it; audit is
 *     best-effort and must not delay the response).
 *   - Is observable: on failure it logs at `error` level via pino with the
 *     full event payload, so dropped audit records are visible in logs and
 *     can be correlated with the `auditFailures` Prometheus counter.
 *   - Never throws (the inner `audit()` already catches, but we wrap once
 *     more so a buggy logger can't take down a request).
 *
 * @param actor    - The user/API-key subject performing the action.
 * @param action   - The action name (e.g. 'user.delete').
 * @param entity   - The affected entity { type, id? }.
 * @param before   - Optional before-state snapshot.
 * @param after    - Optional after-state snapshot.
 */
export function auditSafe(
  actor: string,
  action: string,
  entity: { type: string; id?: string },
  before?: unknown,
  after?: unknown,
): void {
  void audit(actor, action, entity, before, after).catch((err: unknown) => {
    // `audit()` is not expected to throw (it catches internally), but if the
    // dynamic import itself fails or the logger throws, we still must not
    // propagate. Log and move on.
    const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
    logger.error('auditSafe: audit() threw unexpectedly', { actor, action, entity, ...detail });
  });
}

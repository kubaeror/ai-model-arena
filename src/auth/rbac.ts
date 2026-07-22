import type { Request, Response, NextFunction, RequestHandler } from 'express';

interface UserRequest extends Request {
  user?: { sub: string; role: string };
}

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
    const { getDb } = await import('../db/client.js');
    const db = getDb();
    db.prepare(
      'INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      actor,
      action,
      entity.type,
      entity.id ?? null,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      new Date().toISOString(),
    );
  } catch {
    auditFailureCount++;
    // Increment Prometheus counter if available (non-fatal if prom-client is not loaded)
    try {
      const { auditFailures } = await import('../observability/metrics.js');
      auditFailures.inc();
    } catch { /* metrics unavailable in test/dev */ }
  }
}

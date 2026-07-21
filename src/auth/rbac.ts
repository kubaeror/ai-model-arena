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
  } catch { /* audit failures are non-fatal */ }
}

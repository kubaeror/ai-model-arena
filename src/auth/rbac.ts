const ROLE_ORDER = { viewer: 0, editor: 1, admin: 2 } as const;
type Role = keyof typeof ROLE_ORDER;

export function requireRole(min: Role) {
  return (req: any, res: any, next: any) => {
    const role = req.user?.role as string | undefined;
    const order = ROLE_ORDER as Record<string, number>;
    if (!role || (order[role] ?? -1) < (order[min] ?? 0)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

export async function audit(
  actor: string,
  action: string,
  entity: { type: string; id?: string; },
  before?: unknown,
  after?: unknown,
): Promise<void> {
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
}

import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createAuditRouter(): Router {
  const router = Router();

  // GET /api/audit - paginated, filterable audit log
  router.get('/', (req, res) => {
    const db = getDb();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const actor = typeof req.query.actor === 'string' ? req.query.actor : undefined;
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const entityType = typeof req.query.entity_type === 'string' ? req.query.entity_type : undefined;
    const entityId = typeof req.query.entity_id === 'string' ? req.query.entity_id : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;

    const clauses: string[] = ['1=1'];
    const params: unknown[] = [];

    if (actor) { clauses.push('actor = ?'); params.push(actor); }
    if (action) { clauses.push('action = ?'); params.push(action); }
    if (entityType) { clauses.push('entity_type = ?'); params.push(entityType); }
    if (entityId) { clauses.push('entity_id = ?'); params.push(entityId); }
    if (from) { clauses.push('"at" >= ?'); params.push(from); }
    if (to) { clauses.push('"at" <= ?'); params.push(to); }

    const where = clauses.join(' AND ');

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM audit_log WHERE ${where}`).get(...params) as { total: number };
    params.push(limit, offset);

    const rows = db.prepare(`
      SELECT * FROM audit_log
      WHERE ${where}
      ORDER BY "at" DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    // Parse JSON fields
    const entries = (rows as Record<string, unknown>[]).map((r) => ({
      ...r,
      before: r.before ? tryParse(r.before as string) : null,
      after: r.after ? tryParse(r.after as string) : null,
    }));

    res.json({ entries, total: countRow.total, limit, offset });
  });

  return router;
}

function tryParse(val: string): unknown {
  try { return JSON.parse(val); } catch { return val; }
}

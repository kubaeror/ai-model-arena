import { Router } from 'express';
import { and, eq, gte, lte } from 'drizzle-orm';
import { paginate } from '../../db/query.js';
import { audit_log } from '../../db/schema.js';
import { parsePagination } from '../helpers.js';

const auditColumns = {
  id: audit_log.id,
  actor: audit_log.actor,
  action: audit_log.action,
  entity_type: audit_log.entity_type,
  entity_id: audit_log.entity_id,
  before: audit_log.before,
  after: audit_log.after,
  at: audit_log.at,
};

export function createAuditRouter(): Router {
  const router = Router();

  // GET /api/audit - paginated, filterable audit log
  router.get('/', async (req, res) => {
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const actor = typeof req.query.actor === 'string' ? req.query.actor : undefined;
    const action = typeof req.query.action === 'string' ? req.query.action : undefined;
    const entityType = typeof req.query.entity_type === 'string' ? req.query.entity_type : undefined;
    const entityId = typeof req.query.entity_id === 'string' ? req.query.entity_id : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to : undefined;

    const conds = [];
    if (actor) conds.push(eq(audit_log.actor, actor));
    if (action) conds.push(eq(audit_log.action, action));
    if (entityType) conds.push(eq(audit_log.entity_type, entityType));
    if (entityId) conds.push(eq(audit_log.entity_id, entityId));
    if (from) conds.push(gte(audit_log.at, from));
    if (to) conds.push(lte(audit_log.at, to));

    const { rows, total } = await paginate(audit_log, auditColumns, {
      where: conds.length ? and(...conds) : undefined,
      orderBy: 'at',
      dir: 'desc',
      pageSize: limit,
      offset,
    });

    // Parse JSON fields
    const entries = rows.map((r: Record<string, unknown>) => ({
      ...r,
      before: r.before ? tryParse(String(r.before)) : null,
      after: r.after ? tryParse(String(r.after)) : null,
    }));

    res.json({ entries, total, limit, offset });
  });

  return router;
}

function tryParse(val: string): unknown {
  try { return JSON.parse(val); } catch { return val; }
}

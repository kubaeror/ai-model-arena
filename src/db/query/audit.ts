import { getDrizzleDb } from '../index.js';
import { audit_log } from '../schema.js';

// ── Audit Log ─────────────────────────────────────────────────────────────

export async function insertAuditEntry(data: {
  actor: string; action: string; entityType: string; entityId?: string | null;
  before?: string | null; after?: string | null; at: string;
}): Promise<void> {
  const db = getDrizzleDb();
  await db.insert(audit_log).values({
    actor: data.actor, action: data.action,
    entity_type: data.entityType, entity_id: data.entityId ?? null,
    before: data.before ?? null, after: data.after ?? null, at: data.at,
  });
}

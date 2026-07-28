import crypto from 'node:crypto';
import { getDrizzleDb } from '../db/index.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  entityType: string;
  entityId: string;
  data: string;
  requestedBy: string;
  status: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  createdAt: string;
}

/**
 * Create an approval request for a high-risk configuration change.
 * Returns the approval request ID. The change is NOT applied until approved.
 */
export async function createApproval(
  entityType: string,
  entityId: string,
  data: Record<string, unknown>,
  requestedBy: string,
): Promise<string> {
  const db = getDrizzleDb() as any;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO approvals (id, entity_type, entity_id, data_json, requested_by, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    id, entityType, entityId, JSON.stringify(data), requestedBy, now,
  );

  return id;
}

/**
 * Approve or reject a pending approval request.
 * Only admins (not the original requester) may approve.
 */
export async function resolveApproval(
  id: string,
  status: 'approved' | 'rejected',
  actor: string,
): Promise<ApprovalRequest | null> {
  const db = getDrizzleDb() as any;
  const now = new Date().toISOString();

  const row = await db.all(
    `SELECT * FROM approvals WHERE id = ? AND status = 'pending'`, id,
  );
  if (!row.length) return null;

  await db.run(
    `UPDATE approvals SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`,
    status, actor, now, id,
  );

  return {
    id,
    entityType: row[0].entity_type,
    entityId: row[0].entity_id,
    data: row[0].data_json,
    requestedBy: row[0].requested_by,
    status,
    approvedBy: actor,
    approvedAt: now,
    createdAt: row[0].created_at,
  };
}

/**
 * Check if there's an approved approval for an entity since a given timestamp.
 * Used to verify that a config change wasn't applied without approval.
 */
export async function isApprovedSince(
  entityType: string,
  entityId: string,
  since: string,
): Promise<boolean> {
  const db = getDrizzleDb() as any;
  const rows = await db.all(
    `SELECT 1 FROM approvals WHERE entity_type = ? AND entity_id = ? AND status = 'approved' AND approved_at >= ? LIMIT 1`,
    entityType, entityId, since,
  );
  return rows.length > 0;
}

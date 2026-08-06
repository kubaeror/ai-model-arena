import { getDrizzleDb } from '../index.js';
import { anomalies } from '../schema.js';
import type { DbAnomaly } from '../schema.js';
import { eq, and, desc, sql, count, sum } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export type AnomalyType =
  | 'latency'
  | 'loop'
  | 'token_spike'
  | 'cost_spike'
  | 'error_rate'
  | 'silent_failure';

export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AnomalyRecord {
  id: number;
  run_id: string;
  model: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  detected_at: string;
  resolved: boolean;
  resolved_at: string | null;
  resolved_as: string | null;
  metadata_json: string | null;
}

export interface NewAnomaly {
  run_id: string;
  model: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  metadata?: Record<string, unknown>;
}

export async function insertAnomaly(input: NewAnomaly): Promise<AnomalyRecord> {
  const db = getDrizzleDb();
  // Dedup: one anomaly per (run, model, type). Guarded by the
  // uq_anomalies_run_model_type unique index; pre-check first so re-analysis
  // of the same run is idempotent and returns the existing record.
  const existing = await findAnomaly(input.run_id, input.model, input.type);
  if (existing) return existing;
  const detectedAt = new Date().toISOString();
  const meta = input.metadata ? JSON.stringify(input.metadata) : null;
  const result = await db.insert(anomalies).values({
    run_id: input.run_id, model: input.model, type: input.type,
    severity: input.severity, description: input.description,
    detected_at: detectedAt, resolved: 0, metadata_json: meta,
  }).onConflictDoNothing({
    target: [anomalies.run_id, anomalies.model, anomalies.type],
  }).returning();
  if (result.length === 0) {
    // Lost a race against a concurrent insert — return the winner.
    const raced = await findAnomaly(input.run_id, input.model, input.type);
    if (raced) return raced;
  }
  return rowToRecord(result[0]);
}

async function findAnomaly(runId: string, model: string, type: AnomalyType): Promise<AnomalyRecord | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(anomalies)
    .where(and(eq(anomalies.run_id, runId), eq(anomalies.model, model), eq(anomalies.type, type)))
    .limit(1);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export interface AnomalyQuery {
  model?: string;
  type?: AnomalyType;
  severity?: AnomalySeverity;
  resolved?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function rowToRecord(row: Record<string, unknown>): AnomalyRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    model: String(row.model),
    type: String(row.type) as AnomalyType,
    severity: String(row.severity) as AnomalySeverity,
    description: String(row.description),
    detected_at: String(row.detected_at),
    resolved: Number(row.resolved) === 1,
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
    resolved_as: row.resolved_as ? String(row.resolved_as) : null,
    metadata_json: row.metadata_json ? String(row.metadata_json) : null,
  };
}

export async function listAnomalies(q: AnomalyQuery = {}): Promise<AnomalyRecord[]> {
  const db = getDrizzleDb();
  const conditions: SQL[] = [];
  if (q.model) conditions.push(eq(anomalies.model, q.model));
  if (q.type) conditions.push(eq(anomalies.type, q.type));
  if (q.severity) conditions.push(eq(anomalies.severity, q.severity));
  if (q.resolved !== undefined) conditions.push(eq(anomalies.resolved, q.resolved ? 1 : 0));
  if (q.from) conditions.push(sql`${anomalies.detected_at} >= ${q.from}`);
  if (q.to) conditions.push(sql`${anomalies.detected_at} <= ${q.to}`);
  const rows = await db.select().from(anomalies)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(anomalies.detected_at))
    .limit(q.limit ?? 100)
    .offset(q.offset ?? 0);
  return rows.map((r: DbAnomaly) => rowToRecord(r));
}

export async function getAnomaly(id: number): Promise<AnomalyRecord | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(anomalies).where(eq(anomalies.id, id)).limit(1);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function listAnomaliesForRun(runId: string): Promise<AnomalyRecord[]> {
  const db = getDrizzleDb();
  const rows = await db.select().from(anomalies)
    .where(eq(anomalies.run_id, runId))
    .orderBy(desc(anomalies.detected_at));
  return rows.map((r: DbAnomaly) => rowToRecord(r));
}

export async function resolveAnomaly(id: number, resolvedAs: 'resolved' | 'false_positive'): Promise<AnomalyRecord | null> {
  const db = getDrizzleDb();
  await db.update(anomalies).set({
    resolved: 1, resolved_at: new Date().toISOString(), resolved_as: resolvedAs,
  }).where(eq(anomalies.id, id));
  return getAnomaly(id);
}

export async function anomalyCountsByModel(): Promise<Array<{ model: string; total: number; unresolved: number }>> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: anomalies.model,
    total: count(),
    unresolved: sum(sql<number>`CASE WHEN ${anomalies.resolved} = 0 THEN 1 ELSE 0 END`),
  }).from(anomalies).groupBy(anomalies.model).orderBy(desc(count()));
  return rows.map((r: { model: string; total: number | null; unresolved: number | null }) =>
    ({ model: String(r.model), total: Number(r.total), unresolved: Number(r.unresolved) }));
}

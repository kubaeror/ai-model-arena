import { getDrizzleDb } from '../db/index.js';
import { anomalies, webhooks } from '../db/schema.js';
import { eq, and, desc, sql, count, sum } from 'drizzle-orm';

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

export function dbPath(): string {
  // compat shim
  return '';
}

export async function getDb(): Promise<any> {
  return getDrizzleDb();
}

export async function closeDb(): Promise<void> {}

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
  const detectedAt = new Date().toISOString();
  const meta = input.metadata ? JSON.stringify(input.metadata) : null;
  const result = await db.insert(anomalies).values({
    run_id: input.run_id, model: input.model, type: input.type,
    severity: input.severity, description: input.description,
    detected_at: detectedAt, resolved: 0, metadata_json: meta,
  }).returning();
  return rowToRecord(result[0]);
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
  const conditions: any[] = [];
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
  return rows.map((r: any) => rowToRecord(r));
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
  return rows.map((r: any) => rowToRecord(r));
}

export async function resolveAnomaly(id: number, resolvedAs: 'resolved' | 'false_positive'): Promise<AnomalyRecord | null> {
  const db = getDrizzleDb();
  await db.update(anomalies).set({
    resolved: 1, resolved_at: new Date().toISOString(), resolved_as: resolvedAs,
  }).where(eq(anomalies.id, id));
  return getAnomaly(id);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface WebhookRecord {
  id: number;
  url: string;
  events: string;
  secretSet: boolean;
  created_at: string;
  active: boolean;
}

export interface NewWebhook {
  url: string;
  events: string[];
  secret?: string;
}

export async function insertWebhook(input: NewWebhook): Promise<WebhookRecord> {
  const db = getDrizzleDb();
  const createdAt = new Date().toISOString();
  const result = await db.insert(webhooks).values({
    url: input.url, events: input.events.join(','), secret: input.secret ?? null,
    created_at: createdAt, active: 1,
  }).returning();
  return webhookRowToRecord(result[0]);
}

function webhookRowToRecord(row: Record<string, unknown>): WebhookRecord {
  return {
    id: Number(row.id),
    url: String(row.url),
    events: String(row.events),
    secretSet: row.secret != null && String(row.secret).length > 0,
    created_at: String(row.created_at),
    active: Number(row.active) === 1,
  };
}

export async function getWebhookSecret(id: number): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db.select({ secret: webhooks.secret }).from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return (rows[0]?.secret as string) ?? null;
}

export async function listWebhooks(activeOnly = false): Promise<WebhookRecord[]> {
  const db = getDrizzleDb();
  const rows = activeOnly
    ? await db.select().from(webhooks).where(eq(webhooks.active, 1))
    : await db.select().from(webhooks).orderBy(desc(webhooks.created_at));
  return rows.map((r: any) => webhookRowToRecord(r));
}

export async function getWebhook(id: number): Promise<WebhookRecord | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return rows.length ? webhookRowToRecord(rows[0]) : null;
}

export async function deleteWebhook(id: number): Promise<boolean> {
  const db = getDrizzleDb();
  const result = await db.delete(webhooks).where(eq(webhooks.id, id));
  return (result as any).rowCount > 0;
}

export async function webhooksForEvent(event: string): Promise<WebhookRecord[]> {
  const ws = await listWebhooks(true);
  return ws.filter(w => w.events.split(',').map(e => e.trim()).includes(event));
}

export async function anomalyCountsByModel(): Promise<Array<{ model: string; total: number; unresolved: number }>> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: anomalies.model,
    total: count(),
    unresolved: sum(sql<number>`CASE WHEN ${anomalies.resolved} = 0 THEN 1 ELSE 0 END`),
  }).from(anomalies).groupBy(anomalies.model).orderBy(desc(count()));
  return rows.map((r: any) => ({ model: String(r.model), total: Number(r.total), unresolved: Number(r.unresolved) }));
}

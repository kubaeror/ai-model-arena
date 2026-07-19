import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { findProjectRoot } from '../paths.js';

/**
 * SQLite store for detected anomalies + webhook subscriptions.
 *
 * A single `outputs/arena.db` database is shared by the worker (writes on
 * anomaly detection) and the dashboard server (reads + PATCH). The connection
 * is opened lazily and cached for the process lifetime.
 */

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
  resolved_as: string | null; // 'resolved' | 'false_positive' | null
  metadata_json: string | null;
}

let db: Database.Database | null = null;

export function dbPath(): string {
  return path.join(findProjectRoot(), 'outputs', 'arena.db');
}

function migrate(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      resolved_as TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_anomalies_run ON anomalies(run_id);
    CREATE INDEX IF NOT EXISTS idx_anomalies_model ON anomalies(model);
    CREATE INDEX IF NOT EXISTS idx_anomalies_type ON anomalies(type);
    CREATE INDEX IF NOT EXISTS idx_anomalies_resolved ON anomalies(resolved);
    CREATE INDEX IF NOT EXISTS idx_anomalies_detected ON anomalies(detected_at);
  `);
  // Webhooks table (added in the same migration step).
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT,
      created_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
}

/** Open (and migrate) the shared SQLite database. Cached per process. */
export function getDb(): Database.Database {
  if (db) return db;
  const p = dbPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const database = new Database(p);
  migrate(database);
  db = database;
  return database;
}

/** Close the database connection (mainly for tests / shutdown). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface NewAnomaly {
  run_id: string;
  model: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  metadata?: Record<string, unknown>;
}

/** Insert an anomaly. Returns the created record. */
export function insertAnomaly(input: NewAnomaly): AnomalyRecord {
  const database = getDb();
  const detectedAt = new Date().toISOString();
  const stmt = database.prepare(
    `INSERT INTO anomalies (run_id, model, type, severity, description, detected_at, resolved, metadata_json)
     VALUES (@run_id, @model, @type, @severity, @description, @detected_at, 0, @metadata_json)`,
  );
  const meta = input.metadata ? JSON.stringify(input.metadata) : null;
  const info = stmt.run({
    run_id: input.run_id,
    model: input.model,
    type: input.type,
    severity: input.severity,
    description: input.description,
    detected_at: detectedAt,
    metadata_json: meta,
  });
  return getAnomaly(Number(info.lastInsertRowid))!;
}

export interface AnomalyQuery {
  model?: string;
  type?: AnomalyType;
  severity?: AnomalySeverity;
  resolved?: boolean;
  from?: string; // ISO date
  to?: string;
  limit?: number;
  offset?: number;
}

function rowToRecord(row: Record<string, unknown>): AnomalyRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    model: String(row.model),
    type: row.type as AnomalyType,
    severity: row.severity as AnomalySeverity,
    description: String(row.description),
    detected_at: String(row.detected_at),
    resolved: Number(row.resolved) === 1,
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
    resolved_as: row.resolved_as ? String(row.resolved_as) : null,
    metadata_json: row.metadata_json ? String(row.metadata_json) : null,
  };
}

export function listAnomalies(q: AnomalyQuery = {}): AnomalyRecord[] {
  const database = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.model) { where.push('model = @model'); params.model = q.model; }
  if (q.type) { where.push('type = @type'); params.type = q.type; }
  if (q.severity) { where.push('severity = @severity'); params.severity = q.severity; }
  if (q.resolved !== undefined) { where.push('resolved = @resolved'); params.resolved = q.resolved ? 1 : 0; }
  if (q.from) { where.push('detected_at >= @from'); params.from = q.from; }
  if (q.to) { where.push('detected_at <= @to'); params.to = q.to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.limit = q.limit ?? 100;
  params.offset = q.offset ?? 0;
  const rows = database.prepare(`SELECT * FROM anomalies ${clause} ORDER BY detected_at DESC LIMIT @limit OFFSET @offset`).all(params) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function getAnomaly(id: number): AnomalyRecord | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM anomalies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

export function listAnomaliesForRun(runId: string): AnomalyRecord[] {
  const database = getDb();
  const rows = database.prepare('SELECT * FROM anomalies WHERE run_id = ? ORDER BY detected_at DESC').all(runId) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

export function resolveAnomaly(id: number, resolvedAs: 'resolved' | 'false_positive'): AnomalyRecord | null {
  const database = getDb();
  database.prepare('UPDATE anomalies SET resolved = 1, resolved_at = ?, resolved_as = ? WHERE id = ?').run(new Date().toISOString(), resolvedAs, id);
  return getAnomaly(id);
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface WebhookRecord {
  id: number;
  url: string;
  events: string; // comma-separated
  secretSet: boolean;    // true if a secret was provided; never return plaintext
  created_at: string;
  active: boolean;
}

export interface NewWebhook {
  url: string;
  events: string[];
  secret?: string;
}

export function insertWebhook(input: NewWebhook): WebhookRecord {
  const database = getDb();
  const createdAt = new Date().toISOString();
  const info = database.prepare(
    'INSERT INTO webhooks (url, events, secret, created_at, active) VALUES (?, ?, ?, ?, 1)',
  ).run(input.url, input.events.join(','), input.secret ?? null, createdAt);
  return getWebhook(Number(info.lastInsertRowid))!;
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

/** INTERNAL ONLY — never expose via API. Returns raw secret for outbound HMAC. */
export function getWebhookSecret(id: number): string | null {
  const database = getDb();
  const row = database.prepare('SELECT secret FROM webhooks WHERE id = ?').get(id) as
    { secret?: string } | undefined;
  return row?.secret ?? null;
}

export function listWebhooks(activeOnly = false): WebhookRecord[] {
  const database = getDb();
  const sql = activeOnly ? 'SELECT * FROM webhooks WHERE active = 1' : 'SELECT * FROM webhooks ORDER BY created_at DESC';
  const rows = database.prepare(sql).all() as Record<string, unknown>[];
  return rows.map(webhookRowToRecord);
}

export function getWebhook(id: number): WebhookRecord | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? webhookRowToRecord(row) : null;
}

export function deleteWebhook(id: number): boolean {
  const database = getDb();
  const info = database.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return info.changes > 0;
}

/** Webhooks registered for a given event (e.g. anomaly_detected). */
export function webhooksForEvent(event: string): WebhookRecord[] {
  return listWebhooks(true).filter((w) => w.events.split(',').map((e) => e.trim()).includes(event));
}

/** Anomaly counts grouped by model, for the observability stats endpoint. */
export function anomalyCountsByModel(): Array<{ model: string; total: number; unresolved: number }> {
  const database = getDb();
  const rows = database.prepare(
    `SELECT model, COUNT(*) as total, SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) as unresolved
     FROM anomalies GROUP BY model ORDER BY total DESC`,
  ).all() as Array<{ model: string; total: number; unresolved: number }>;
  return rows.map((r) => ({ model: r.model, total: Number(r.total), unresolved: Number(r.unresolved) }));
}



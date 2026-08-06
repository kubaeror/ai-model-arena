import { getDrizzleDb } from '../index.js';
import { webhooks } from '../schema.js';
import type { DbWebhook } from '../schema.js';
import { eq, desc } from 'drizzle-orm';
import { encryptWebhookSecret, decryptWebhookSecret } from '../../security/webhook-secret-crypto.js';

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
  // Encrypt the HMAC secret at rest (H5). Previously stored in plaintext,
  // readable by anyone with DB read access (or via the S5 regression
  // path-traversal before that fix).
  const encryptedSecret = encryptWebhookSecret(input.secret ?? null);
  const result = await db.insert(webhooks).values({
    url: input.url, events: input.events.join(','), secret: encryptedSecret,
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
  const stored = (rows[0]?.secret as string | null) ?? null;
  // Decrypt at read time (H5). Accepts both v1: ciphertext and legacy
  // plaintext (no prefix) for backward compatibility.
  return decryptWebhookSecret(stored);
}

export async function listWebhooks(activeOnly = false): Promise<WebhookRecord[]> {
  const db = getDrizzleDb();
  const rows = activeOnly
    ? await db.select().from(webhooks).where(eq(webhooks.active, 1))
    : await db.select().from(webhooks).orderBy(desc(webhooks.created_at));
  return rows.map((r: DbWebhook) => webhookRowToRecord(r));
}

export async function deleteWebhook(id: number): Promise<boolean> {
  const db = getDrizzleDb();
  const result = (await db.delete(webhooks).where(eq(webhooks.id, id))) as { rowCount?: number; changes?: number };
  // better-sqlite3 returns { changes, lastInsertRowid }, pg returns { rowCount }.
  const changes = typeof result.rowCount === 'number' ? result.rowCount : (result.changes ?? 0);
  return changes > 0;
}

export async function webhooksForEvent(event: string): Promise<WebhookRecord[]> {
  const ws = await listWebhooks(true);
  return ws.filter(w => w.events.split(',').map(e => e.trim()).includes(event));
}

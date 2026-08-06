import crypto from 'node:crypto';
import { eq, and, or, isNull, lte, desc } from 'drizzle-orm';
import type { Logger } from '../types.js';
import { getDrizzleDb } from '../db/index.js';
import { notifications } from '../db/schema.js';
import type { DispatchEvent, NotificationResult } from './types.js';
import { sendNotification } from './index.js';

interface OutboxRow {
  id: string;
  eventType: string;
  channel: string;
  payloadJson: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

const MAX_BACKOFF_MS = 15 * 60 * 1000;
const DUE_BATCH_LIMIT = 50;

function toRow(r: Record<string, unknown>): OutboxRow {
  return {
    id: String(r.id),
    eventType: String(r.event_type),
    channel: String(r.channel),
    payloadJson: String(r.payload_json),
    status: String(r.status) as OutboxRow['status'],
    attempts: Number(r.attempts),
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    nextAttemptAt: r.next_attempt_at ? String(r.next_attempt_at) : null,
    deliveredAt: r.delivered_at ? String(r.delivered_at) : null,
  };
}

/**
 * Persist a pending outbox row for a dispatched event/channel. Returns the row id.
 */
export async function persistNotification(event: DispatchEvent, channel: string): Promise<string> {
  const db = getDrizzleDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(notifications).values({
    id,
    event_type: event.type,
    channel,
    payload_json: JSON.stringify(event.data ?? {}),
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: now,
    next_attempt_at: null,
    delivered_at: null,
  });
  return id;
}

/**
 * Deliver every pending row whose backoff window has elapsed (up to 50).
 * `sender` defaults to the real channel senders; inject a fake for tests.
 */
export async function deliverDueNotifications(
  logger?: Logger,
  sender?: (channel: string, event: DispatchEvent) => Promise<NotificationResult>,
): Promise<{ delivered: number; failed: number }> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const due = await db.select().from(notifications).where(and(
    eq(notifications.status, 'pending'),
    or(isNull(notifications.next_attempt_at), lte(notifications.next_attempt_at, now)),
  )).limit(DUE_BATCH_LIMIT);

  let delivered = 0;
  let failed = 0;
  for (const row of due) {
    const send = sender ?? sendNotification;
    const event: DispatchEvent = {
      type: row.event_type as DispatchEvent['type'],
      data: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
    };
    try {
      const result = await send(row.channel, event);
      if (result.success) {
        await db.update(notifications)
          .set({ status: 'delivered', delivered_at: new Date().toISOString() })
          .where(eq(notifications.id, row.id));
        delivered++;
      } else {
        failed++;
        await failRow(db, row.id, row.attempts + 1, result.error ?? 'send failed', logger);
      }
    } catch (err) {
      failed++;
      await failRow(db, row.id, row.attempts + 1, err instanceof Error ? err.message : String(err), logger);
    }
  }
  return { delivered, failed };
}

/**
 * Exponential backoff: 60s, 2m, 4m, 8m, ... capped at 15m.
 * `attempts` is the new attempt count (previous + 1), so the first failure
 * waits 60s (2^0), the second 120s (2^1), etc.
 */
async function failRow(
  db: ReturnType<typeof getDrizzleDb>,
  id: string,
  attempts: number,
  error: string,
  logger?: Logger,
): Promise<void> {
  const backoffMs = Math.min(60_000 * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  await db.update(notifications).set({
    status: 'pending',
    attempts,
    last_error: error,
    next_attempt_at: nextAttemptAt,
  }).where(eq(notifications.id, id));
  logger?.warn('Notification delivery failed, will retry', { id, attempts, error, nextAttemptAt });
}

/** Newest first. */
export async function listNotifications(limit = 100): Promise<OutboxRow[]> {
  const db = getDrizzleDb();
  const rows = await db.select().from(notifications)
    .orderBy(desc(notifications.created_at))
    .limit(limit);
  return (rows as unknown as Record<string, unknown>[]).map(toRow);
}

export async function getNotificationById(id: string): Promise<OutboxRow | null> {
  const db = getDrizzleDb();
  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  return row ? toRow(row as unknown as Record<string, unknown>) : null;
}

/** Reset a row so the delivery loop picks it up on its next tick. */
export async function retryNotification(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.update(notifications).set({
    status: 'pending',
    next_attempt_at: null,
    last_error: null,
  }).where(eq(notifications.id, id));
}

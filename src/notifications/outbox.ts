import crypto from 'node:crypto';
import { eq, and, or, isNull, lte, desc } from 'drizzle-orm';
import type { Logger } from '../types.js';
import { getDrizzleDb } from '../db/index.js';
import { notifications } from '../db/schema.js';
import type { DispatchEvent, NotificationResult } from './types.js';
import { sendNotification, loadNotificationConfig } from './index.js';

interface OutboxRow {
  id: string;
  eventType: string;
  channel: string;
  payloadJson: string;
  status: 'pending' | 'sending' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
}

const MAX_BACKOFF_MS = 15 * 60 * 1000;
const DUE_BATCH_LIMIT = 50;

/** Failed rows are dead-lettered (status `dead`) once attempts reach this cap. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Conditional UPDATE as the claim: only the sweep whose UPDATE affects a row
 * owns that delivery, so overlapping sweeps skip rows another sweep took.
 */
async function claimRow(db: ReturnType<typeof getDrizzleDb>, id: string): Promise<boolean> {
  const result = (await db.update(notifications)
    .set({ status: 'sending' })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'pending')))) as { rowCount?: number; changes?: number };
  // better-sqlite3 returns { changes }, pg returns { rowCount }.
  const changes = typeof result.rowCount === 'number' ? result.rowCount : (result.changes ?? 0);
  return changes > 0;
}

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
    if (!(await claimRow(db, row.id))) continue;
    const send = sender ?? sendNotification;
    let event: DispatchEvent;
    try {
      event = {
        type: row.event_type as DispatchEvent['type'],
        data: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
      };
    } catch (err) {
      failed++;
      await failRow(db, row.id, row.attempts + 1, `Invalid payload JSON: ${err instanceof Error ? err.message : String(err)}`, logger);
      continue;
    }
    try {
      const result = await send(row.channel, event);
      if (result.success) {
        await db.update(notifications)
          .set({ status: 'delivered', delivered_at: new Date().toISOString() })
          .where(and(eq(notifications.id, row.id), eq(notifications.status, 'sending')));
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

export interface OutboxTimerOptions {
  intervalMs?: number;
  sender?: (channel: string, event: DispatchEvent) => Promise<NotificationResult>;
}

/**
 * Dashboard boot path: load the channel config (so sendNotification can route
 * without "Channel not found") and start the periodic outbox sweep. Ticks are
 * single-flight — a tick that fires while the previous sweep is still running
 * is skipped instead of stacking a second concurrent sweep.
 */
export function startNotificationOutboxTimer(
  logger: Logger,
  configPath: string,
  opts: OutboxTimerOptions = {},
): { stop: () => void } {
  loadNotificationConfig(configPath, logger);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) {
      logger.debug('Notification outbox sweep skipped: previous sweep still running');
      return;
    }
    inFlight = true;
    void deliverDueNotifications(logger, opts.sender)
      .catch((e) => logger.warn('Notification outbox delivery failed', { error: String(e) }))
      .finally(() => { inFlight = false; });
  }, opts.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/**
 * Backoff: 60s, 2m, 4m, 8m, ... capped at 15m; once a row reaches
 * MAX_DELIVERY_ATTEMPTS it is dead-lettered. `attempts` is the new attempt
 * count (previous + 1), so the first failure waits 60s (2^0), etc.
 */
async function failRow(
  db: ReturnType<typeof getDrizzleDb>,
  id: string,
  attempts: number,
  error: string,
  logger?: Logger,
): Promise<void> {
  // Only transition a row this sweep still owns, so a concurrent manual retry
  // is not silently overwritten.
  const owned = and(eq(notifications.id, id), eq(notifications.status, 'sending'));
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    await db.update(notifications).set({
      status: 'dead',
      attempts,
      last_error: error,
      next_attempt_at: null,
    }).where(owned);
    logger?.error('Notification dead-lettered after max attempts', { id, attempts, error });
    return;
  }
  const backoffMs = Math.min(60_000 * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  await db.update(notifications).set({
    status: 'pending',
    attempts,
    last_error: error,
    next_attempt_at: nextAttemptAt,
  }).where(owned);
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

import crypto from 'node:crypto';
import { eq, and, or, isNull, lte, desc, sql } from 'drizzle-orm';
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
 * Lease deadline stored in `next_attempt_at` while a row is `sending` (there is
 * no claimed_at column). A crash/SIGKILL between claim and resolution strands
 * the row as `sending` only until this deadline, after which the next sweep
 * reclaims it. Must comfortably exceed a real send so a live in-flight send is
 * not stolen; `postWithRetry` can take ~3 network attempts, hence 5 minutes.
 */
export const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * A sweep may only resolve (deliver/fail) the row while it still holds the
 * lease set at claim time. A reclaim after lease expiry resets the deadline,
 * so the stale sweep's resolution no longer matches.
 */
function ownedRow(id: string, leaseDeadline: string) {
  return and(
    eq(notifications.id, id),
    eq(notifications.status, 'sending'),
    eq(notifications.next_attempt_at, leaseDeadline),
  );
}

/** better-sqlite3 returns { changes }, pg returns { rowCount }. */
function affectedRows(result: { rowCount?: number; changes?: number }): number {
  return typeof result.rowCount === 'number' ? result.rowCount : (result.changes ?? 0);
}

/**
 * Conditional UPDATE as the claim: only the sweep whose UPDATE affects a row
 * owns that delivery, so overlapping sweeps skip rows another sweep took.
 *
 * The WHERE clause is the full due predicate — `pending` past its backoff OR
 * `sending` past its lease — so a stale candidate list cannot claim a row
 * another sweep just failed back to `pending` (which would bypass the backoff
 * gate and undercount attempts). Claiming (re)sets `next_attempt_at` to the
 * lease deadline, protecting the in-flight send until it expires.
 */
async function claimRow(
  db: ReturnType<typeof getDrizzleDb>,
  id: string,
  now: string,
  leaseDeadline: string,
): Promise<boolean> {
  const result = (await db.update(notifications)
    .set({ status: 'sending', next_attempt_at: leaseDeadline })
    .where(and(
      eq(notifications.id, id),
      or(eq(notifications.status, 'pending'), eq(notifications.status, 'sending')),
      or(isNull(notifications.next_attempt_at), lte(notifications.next_attempt_at, now)),
    ))) as { rowCount?: number; changes?: number };
  return affectedRows(result) > 0;
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
 * Deliver every due row (up to 50): `pending` past its backoff, plus `sending`
 * rows whose claim lease expired (a crash between claim and resolution would
 * otherwise strand them forever). `sender` defaults to the real channel
 * senders; inject a fake for tests.
 */
export async function deliverDueNotifications(
  logger?: Logger,
  sender?: (channel: string, event: DispatchEvent) => Promise<NotificationResult>,
): Promise<{ delivered: number; failed: number }> {
  const db = getDrizzleDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseDeadline = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  const due = await db.select().from(notifications).where(and(
    or(eq(notifications.status, 'pending'), eq(notifications.status, 'sending')),
    or(isNull(notifications.next_attempt_at), lte(notifications.next_attempt_at, nowIso)),
  )).limit(DUE_BATCH_LIMIT);

  let delivered = 0;
  let failed = 0;
  // Resolutions are lease-gated: a sweep whose lease was reclaimed while its
  // send was in flight writes and counts nothing — the new owner decides.
  for (const row of due) {
    if (!(await claimRow(db, row.id, nowIso, leaseDeadline))) continue;
    const send = sender ?? sendNotification;
    let event: DispatchEvent;
    try {
      event = {
        type: row.event_type as DispatchEvent['type'],
        data: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
      };
    } catch (err) {
      if (await failRow(db, row.id, leaseDeadline, `Invalid payload JSON: ${err instanceof Error ? err.message : String(err)}`, logger)) {
        failed++;
      }
      continue;
    }
    try {
      const result = await send(row.channel, event);
      if (result.success) {
        const marked = (await db.update(notifications)
          .set({ status: 'delivered', delivered_at: new Date().toISOString(), next_attempt_at: null })
          .where(ownedRow(row.id, leaseDeadline))) as { rowCount?: number; changes?: number };
        if (affectedRows(marked) > 0) delivered++;
      } else {
        if (await failRow(db, row.id, leaseDeadline, result.error ?? 'send failed', logger)) {
          failed++;
        }
      }
    } catch (err) {
      if (await failRow(db, row.id, leaseDeadline, err instanceof Error ? err.message : String(err), logger)) {
        failed++;
      }
    }
  }
  return { delivered, failed };
}

export interface OutboxTimerOptions {
  intervalMs?: number;
  sender?: (channel: string, event: DispatchEvent) => Promise<NotificationResult>;
}

export interface OutboxTimer {
  stop: () => void;
  /** Resolves once the in-flight sweep settles (immediately when idle). */
  whenIdle: () => Promise<void>;
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
): OutboxTimer {
  try {
    loadNotificationConfig(configPath, logger);
  } catch (err) {
    // Malformed/schema-invalid YAML must not kill dashboard boot. With no
    // channels loaded, sends fail with "Channel not found" and back off
    // normally until the config is fixed.
    logger.warn('Notification config load failed (continuing without channels)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) {
      logger.debug('Notification outbox sweep skipped: previous sweep still running');
      return;
    }
    inFlight = deliverDueNotifications(logger, opts.sender)
      .then(() => undefined)
      .catch((e) => logger.warn('Notification outbox delivery failed', { error: String(e) }))
      .finally(() => { inFlight = null; });
  }, opts.intervalMs ?? 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), whenIdle: () => inFlight ?? Promise.resolve() };
}

/**
 * Backoff: 60s, 2m, 4m, 8m, ... capped at 15m; once a row reaches
 * MAX_DELIVERY_ATTEMPTS it is dead-lettered. `attempts` is the new attempt
 * count (previous + 1), so the first failure waits 60s (2^0), etc.
 *
 * `attempts` is incremented atomically in SQL (`attempts = attempts + 1`) and
 * read back via RETURNING, so concurrent writers cannot undercount it. The
 * update is conditioned on the claim-time lease, so a stale sweep whose lease
 * was reclaimed cannot resolve (or double-count) the row.
 *
 * Returns true when this sweep recorded the failure; false when it lost the
 * lease (manual retry, or reclaim after expiry while it was slow).
 */
async function failRow(
  db: ReturnType<typeof getDrizzleDb>,
  id: string,
  leaseDeadline: string,
  error: string,
  logger?: Logger,
): Promise<boolean> {
  const owned = ownedRow(id, leaseDeadline);
  const bumped = (await db.update(notifications)
    .set({ attempts: sql`${notifications.attempts} + 1`, last_error: error })
    .where(owned)
    .returning({ attempts: notifications.attempts })) as Array<{ attempts: number }>;
  const attempts = bumped[0]?.attempts;
  if (attempts === undefined) return false;
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    await db.update(notifications).set({
      status: 'dead',
      next_attempt_at: null,
    }).where(owned);
    logger?.error('Notification dead-lettered after max attempts', { id, attempts, error });
    return true;
  }
  const backoffMs = Math.min(60_000 * Math.pow(2, Math.max(0, attempts - 1)), MAX_BACKOFF_MS);
  const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
  await db.update(notifications).set({
    status: 'pending',
    next_attempt_at: nextAttemptAt,
  }).where(owned);
  logger?.warn('Notification delivery failed, will retry', { id, attempts, error, nextAttemptAt });
  return true;
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

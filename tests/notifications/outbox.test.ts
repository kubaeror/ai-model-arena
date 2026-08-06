import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/index.js';
import {
  persistNotification,
  deliverDueNotifications,
  listNotifications,
  retryNotification,
  getNotificationById,
} from '../../src/notifications/outbox.js';
import { DispatchEventType } from '../../src/notifications/types.js';

/**
 * Notification delivery outbox (Task 5).
 *
 * Uses a real in-memory SQLite DB (migrations applied on init) and an
 * injected fake sender — no network, no config needed. Mirrors the DB
 * init pattern of tests/notifications/webhooks-dispatch.test.ts.
 */

afterEach(async () => {
  await closeDb();
});

test('persist + deliverDue delivers due rows and retries failed ones with backoff', async () => {
  initDb(':memory:');
  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'r1' } },
    'slack',
  );
  const row0 = await getNotificationById(id);
  assert.equal(row0?.status, 'pending');
  assert.equal(row0?.attempts, 0);
  assert.equal(row0?.nextAttemptAt, null);

  let calls = 0;
  const r = await deliverDueNotifications(undefined, async () => {
    calls++;
    return { channel: 'slack', success: false, error: 'boom', timestamp: new Date().toISOString() };
  });
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  assert.equal(calls, 1, 'exactly one send attempt for the single due row');

  const row = (await listNotifications())[0];
  assert.equal(row?.id, id);
  assert.equal(row?.status, 'pending', 'failed delivery stays pending');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, 'boom');
  assert.ok(row?.nextAttemptAt, 'failed rows get a retry time');

  const ok = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: true,
    timestamp: new Date().toISOString(),
  }));
  assert.equal(ok.delivered, 0, 'not due yet — backoff gate holds');
  assert.equal((await getNotificationById(id))?.attempts, 1, 'no extra attempts while gated');
});

test('deliverDueNotifications marks successful rows delivered', async () => {
  initDb(':memory:');
  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'r2' } },
    'slack',
  );
  const r = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: true,
    timestamp: new Date().toISOString(),
  }));
  assert.equal(r.delivered, 1);
  const row = await getNotificationById(id);
  assert.equal(row?.status, 'delivered');
  assert.ok(row?.deliveredAt, 'delivered rows get a delivered_at timestamp');
});

test('retryNotification resets a failed row to pending (clears backoff gate)', async () => {
  initDb(':memory:');
  const id = await persistNotification(
    { type: DispatchEventType.onAnomalyDetected, data: { runId: 'r3' } },
    'discord',
  );
  await deliverDueNotifications(undefined, async () => ({
    channel: 'discord',
    success: false,
    error: 'nope',
    timestamp: new Date().toISOString(),
  }));
  let row = await getNotificationById(id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.attempts, 1);
  assert.ok(row?.nextAttemptAt);

  await retryNotification(id);
  row = await getNotificationById(id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.nextAttemptAt, null, 'retry clears the backoff gate');
  assert.equal(row?.lastError, null);

  const r = await deliverDueNotifications(undefined, async () => ({
    channel: 'discord',
    success: true,
    timestamp: new Date().toISOString(),
  }));
  assert.equal(r.delivered, 1, 'retried row is immediately due again');
  assert.equal((await getNotificationById(id))?.status, 'delivered');
});

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDrizzleDb } from '../../src/db/index.js';
import { notifications } from '../../src/db/schema.js';
import {
  persistNotification,
  deliverDueNotifications,
  listNotifications,
  retryNotification,
  getNotificationById,
  MAX_DELIVERY_ATTEMPTS,
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

test('concurrent sweeps claim a due row so it is delivered exactly once', async () => {
  initDb(':memory:');
  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'race' } },
    'slack',
  );

  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sender = async () => {
    sends++;
    await gate;
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  };

  const first = deliverDueNotifications(undefined, sender);
  const second = deliverDueNotifications(undefined, sender);
  await new Promise((r) => setImmediate(r));
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(sends, 1, 'exactly one sweep wins the atomic claim');
  assert.equal(a.delivered + b.delivered, 1);
  assert.equal(a.failed + b.failed, 0);
  assert.equal((await getNotificationById(id))?.status, 'delivered');

  const again = await deliverDueNotifications(undefined, sender);
  assert.equal(again.delivered, 0, 'sequential re-sweep must not redeliver');
  assert.equal(sends, 1);
});

test('a corrupt payload row fails alone without aborting the sweep', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const badId = 'corrupt-row';
  await db.insert(notifications).values({
    id: badId,
    event_type: 'onRunCompleted',
    channel: 'slack',
    payload_json: '{ definitely not json',
    status: 'pending',
    attempts: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    next_attempt_at: null,
    delivered_at: null,
  });
  const goodId = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'good' } },
    'slack',
  );

  const r = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: true,
    timestamp: new Date().toISOString(),
  }));

  assert.equal(r.delivered, 1, 'the healthy row is still delivered');
  assert.equal(r.failed, 1, 'the corrupt row is counted as a failure');
  assert.equal((await getNotificationById(goodId))?.status, 'delivered');

  const bad = await getNotificationById(badId);
  assert.equal(bad?.status, 'pending', 'corrupt row stays retryable until max attempts');
  assert.equal(bad?.attempts, 1);
  assert.ok(bad?.lastError, 'corrupt row records the parse error');
  assert.match(bad?.lastError ?? '', /payload|json/i);
  assert.ok(bad?.nextAttemptAt, 'corrupt row gets a backoff window');
});

test('a row that exhausts max attempts is dead-lettered and stops retrying', async () => {
  initDb(':memory:');
  const id = await persistNotification(
    { type: DispatchEventType.onAnomalyDetected, data: { runId: 'poison' } },
    'slack',
  );
  const sender = async () => ({
    channel: 'slack',
    success: false,
    error: 'poison',
    timestamp: new Date().toISOString(),
  });

  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
    await retryNotification(id); // clear the backoff gate so each sweep sees the row
    const r = await deliverDueNotifications(undefined, sender);
    assert.equal(r.failed, 1, `attempt ${i + 1} fails`);
  }

  const row = await getNotificationById(id);
  assert.equal(row?.status, 'dead');
  assert.equal(row?.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(row?.lastError, 'poison');
  assert.equal(row?.nextAttemptAt, null, 'dead rows are never due again');

  const after = await deliverDueNotifications(undefined, sender);
  assert.equal(after.failed, 0, 'dead-lettered rows are excluded from sweeps');
  assert.equal((await getNotificationById(id))?.attempts, MAX_DELIVERY_ATTEMPTS, 'no further attempts');
});

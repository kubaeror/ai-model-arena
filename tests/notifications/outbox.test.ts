import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
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
import { DispatchEventType, type DispatchEvent } from '../../src/notifications/types.js';

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
  assert.equal(row?.attempts, 0, 'retry restarts the attempt budget');
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

test('retryNotification revives a dead row with a fresh attempt budget', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'dead-retry' } },
    'slack',
  );
  const failing = async () => ({
    channel: 'slack',
    success: false,
    error: 'poison',
    timestamp: new Date().toISOString(),
  });

  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
    // Clear only the backoff gate — retryNotification would reset attempts.
    await db.update(notifications).set({ next_attempt_at: null }).where(eq(notifications.id, id));
    await deliverDueNotifications(undefined, failing);
  }
  let row = await getNotificationById(id);
  assert.equal(row?.status, 'dead');
  assert.equal(row?.attempts, MAX_DELIVERY_ATTEMPTS);

  await retryNotification(id);
  row = await getNotificationById(id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.attempts, 0, 'a revived row must not re-die on its next failure');
  assert.equal(row?.lastError, null);
  assert.equal(row?.nextAttemptAt, null, 'revived rows are immediately due');

  const r = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: true,
    timestamp: new Date().toISOString(),
  }));
  assert.equal(r.delivered, 1, 'a retried dead row is delivered by the next sweep');
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
  const inFlight = await getNotificationById(id);
  assert.equal(inFlight?.status, 'sending', 'claim marks the row sending while the send is in flight');
  assert.ok(
    Date.parse(inFlight?.nextAttemptAt ?? '') > Date.now(),
    'claim stores a future lease deadline in next_attempt_at',
  );
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

test('a stranded sending row is reclaimed after its lease expires and delivered once', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const id = 'stranded-expired-lease';
  await db.insert(notifications).values({
    id,
    event_type: DispatchEventType.onRunCompleted,
    channel: 'slack',
    payload_json: JSON.stringify({ runId: 'stranded' }),
    status: 'sending',
    attempts: 0,
    last_error: null,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
    delivered_at: null,
  });

  let sends = 0;
  const sender = async () => {
    sends++;
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  };
  const r = await deliverDueNotifications(undefined, sender);
  assert.equal(r.delivered, 1, 'a crash between claim and resolution must not strand the row');
  assert.equal(sends, 1);
  assert.equal((await getNotificationById(id))?.status, 'delivered');

  const again = await deliverDueNotifications(undefined, sender);
  assert.equal(again.delivered, 0, 'the reclaimed row is delivered exactly once');
  assert.equal(sends, 1);
});

test('a sending row with no lease (claimed before leases existed) is reclaimed', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const id = 'stranded-null-lease';
  await db.insert(notifications).values({
    id,
    event_type: DispatchEventType.onRunCompleted,
    channel: 'slack',
    payload_json: JSON.stringify({ runId: 'legacy' }),
    status: 'sending',
    attempts: 0,
    last_error: null,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    next_attempt_at: null,
    delivered_at: null,
  });

  const r = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: true,
    timestamp: new Date().toISOString(),
  }));
  assert.equal(r.delivered, 1);
  assert.equal((await getNotificationById(id))?.status, 'delivered');
});

test('an unexpired sending lease is not stolen', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const id = 'in-flight-lease';
  const lease = new Date(Date.now() + 60_000).toISOString();
  await db.insert(notifications).values({
    id,
    event_type: DispatchEventType.onRunCompleted,
    channel: 'slack',
    payload_json: JSON.stringify({ runId: 'in-flight' }),
    status: 'sending',
    attempts: 0,
    last_error: null,
    created_at: new Date().toISOString(),
    next_attempt_at: lease,
    delivered_at: null,
  });

  let sends = 0;
  const r = await deliverDueNotifications(undefined, async () => {
    sends++;
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  });
  assert.equal(sends, 0, 'a live in-flight send must not be stolen');
  assert.equal(r.delivered + r.failed, 0);
  const row = await getNotificationById(id);
  assert.equal(row?.status, 'sending');
  assert.equal(row?.nextAttemptAt, lease, 'the live lease is left untouched');
});

test('a stale sweep cannot resolve a row reclaimed after its lease expired', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const id = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'slow' } },
    'slack',
  );

  let markStarted!: () => void;
  const started = new Promise<void>((r) => { markStarted = r; });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = deliverDueNotifications(undefined, async () => {
    markStarted();
    await gate;
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  });
  await started;

  // Simulate the lease expiring while sweep 1 is still in flight.
  await db.update(notifications)
    .set({ next_attempt_at: new Date(Date.now() - 1_000).toISOString() })
    .where(eq(notifications.id, id));

  const second = await deliverDueNotifications(undefined, async () => ({
    channel: 'slack',
    success: false,
    error: 'second sweep failed it',
    timestamp: new Date().toISOString(),
  }));
  assert.equal(second.failed, 1, 'expired lease is reclaimed by the next sweep');

  release();
  const firstResult = await first;
  assert.equal(firstResult.delivered, 0, 'a stale sweep must not count a resolution it no longer owns');

  const row = await getNotificationById(id);
  assert.equal(row?.status, 'pending', 'the claimant resolution stands');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, 'second sweep failed it');
});

test('a stale candidate list cannot re-claim a row already backed off by another sweep', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const firstId = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'first' } },
    'slack',
  );
  const otherId = await persistNotification(
    { type: DispatchEventType.onRunCompleted, data: { runId: 'second' } },
    'slack',
  );
  const otherBackoff = new Date(Date.now() + 5 * 60_000).toISOString();

  const sent: string[] = [];
  const sender = async (_channel: string, event: DispatchEvent) => {
    const current = String(event.data.runId);
    sent.push(current);
    // Simulate another sweep claiming and failing the still-unclaimed candidate
    // while this sweep is busy sending the first one. Its failRow leaves the
    // row pending with a future backoff; the claim predicate must honour that
    // due time instead of re-claiming from this sweep's stale candidate list.
    const target = current === 'first' ? otherId : firstId;
    await db.update(notifications).set({
      status: 'pending',
      attempts: 1,
      last_error: 'failed by other sweep',
      next_attempt_at: otherBackoff,
    }).where(eq(notifications.id, target));
    return { channel: 'slack', success: true, timestamp: new Date().toISOString() };
  };

  const r = await deliverDueNotifications(undefined, sender);
  assert.equal(sent.length, 1, 'a backed-off row must not be re-claimed from a stale candidate list');
  assert.equal(r.delivered, 1);
  const notSentId = sent[0] === 'first' ? otherId : firstId;
  const other = await getNotificationById(notSentId);
  assert.equal(other?.status, 'pending');
  assert.equal(other?.attempts, 1, 'the other sweep attempt count is preserved');
  assert.equal(other?.nextAttemptAt, otherBackoff, 'the backoff window set by the other sweep is preserved');
  assert.equal(other?.lastError, 'failed by other sweep');
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

  const db = getDrizzleDb();
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
    // Clear only the backoff gate so each sweep sees the row; retryNotification
    // would also reset attempts and the row would never reach the dead cap.
    await db.update(notifications).set({ next_attempt_at: null }).where(eq(notifications.id, id));
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

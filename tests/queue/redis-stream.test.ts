/**
 * Unit tests for RedisStreamQueue (src/queue/redis.ts) driven by an in-memory
 * fake of the ioredis surface — no REDIS_URL needed.
 *
 * ── ioredis surface used by src/queue/redis.ts (enumerated) ──────────────
 *   xlen(stream)                                        → number
 *   xgroup('CREATE', stream, group, '$', 'MKSTREAM')    → 'OK' | throws Error{message:'BUSYGROUP …'} if group exists
 *   xadd(stream, '*', ...fields: (string|number)[])     → entry id (string)
 *   xreadgroup('GROUP', g, c, 'COUNT', 1, 'BLOCK', ms,
 *              'STREAMS', stream, '>')                  → [[stream, [[id, fields]]]] | null   (delivers NEW entries, marks them pending)
 *   xack(stream, group, id)                             → number acked (removes from PEL)
 *   xdel(stream, id)                                    → number deleted (removes from stream)
 *   xrange(stream, start, end, 'COUNT', n)              → [[id, fields]]  (start/end: '-'/'+' or exact id)
 *   xautoclaim(stream, group, consumer, minIdleMs,
 *              start, 'COUNT', 5)                       → [nextStart, [[id, fields]], [deletedIds]]
 *   eval(script, numKeys, ...keyOrArg)                  → 0|1 for SETNX dedup script; {ok,attempts} for nack script
 *   quit()                                              → 'OK'
 *   disconnect()                                        → void
 * ─────────────────────────────────────────────────────────────────────────
 * Not used by redis.ts: evalsha, defineCommand, xpending (fake provides
 * xpending only as a test-side assertion helper).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';
import { RedisStreamQueue } from '../../src/queue/redis.js';
import { createFakeRedis, type FakeRedis } from './fake-redis.js';
import type { Task, TaskQueue } from '../../src/queue/types.js';
import type { RedisQueueConfig } from '../../src/queue/redis-config.js';
import { streamKey, dlqStreamKey } from '../../src/queue/router.js';

const PREFIX = 'arena:tasks';
const GROUP = 'g';
const CONSUMER = 'c';
const MAIN_STREAM = streamKey(PREFIX, 'openai');
const DLQ_STREAM = dlqStreamKey(PREFIX, 'openai');

function mkTask(taskId: string): Task {
  return {
    taskId, sessionId: `session-${taskId}`, promptId: 'test-prompt', promptVersion: 1,
    provider: 'openai', model: 'gpt-4o', scenario: 'express-rest',
    config: { maxTurns: 5 }, enqueuedAt: new Date().toISOString(), attempts: 0,
  };
}

function makeQueue(fake: FakeRedis, overrides: Partial<RedisQueueConfig> = {}): TaskQueue & RedisStreamQueue {
  return new RedisStreamQueue({
    url: 'redis://fake',
    streamPrefix: PREFIX,
    consumerGroup: GROUP,
    consumerName: CONSUMER,
    maxAttempts: 5,
    reclaimIdleMs: 60_000,
    reclaimIntervalMs: 30_000,
    providerFilter: 'openai',
    ...overrides,
  }, fake as unknown as Redis);
}

test('dequeue returns the oldest message for the provider stream and marks it in-flight', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  await q.enqueue(mkTask('t1'));
  await q.enqueue(mkTask('t2'));

  const first = await q.dequeue(0);
  const second = await q.dequeue(0);
  assert.equal(first?.taskId, 't1', 'oldest message first');
  assert.equal(second?.taskId, 't2');
  assert.ok(first?._redisId, 'delivered message carries its stream id');

  // XREADGROUP must have marked both messages pending (in-flight) for our consumer
  const pending = await fake.xpending(MAIN_STREAM, GROUP);
  assert.equal(pending[0], 2);
  assert.deepEqual(pending[3], [[CONSUMER, 2]]);

  await q.ack(second!._redisId!);
  const after = await fake.xpending(MAIN_STREAM, GROUP);
  assert.equal(after[0], 1, 'ack removes the message from pending');
  await q.close();
});

test('nack re-enqueues with a bumped attempt; after maxAttempts moves the task to the DLQ', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  await q.enqueue(mkTask('t1'));

  for (let i = 1; i < 5; i++) {
    const task = await q.dequeue(0);
    assert.ok(task);
    assert.equal(task!.attempts, i - 1);
    await q.nack(task!._redisId!, 'transient');
    assert.equal(await q.size(), 1, 'nack re-adds to pending before maxAttempts');
    assert.equal(await q.deadLetterSize(), 0, 'not dead-lettered before maxAttempts');
  }

  const last = await q.dequeue(0);
  assert.ok(last);
  assert.equal(last!.attempts, 4);
  await q.nack(last!._redisId!, 'final');

  assert.equal(await q.size(), 0, 'stream empty after dead-letter');
  assert.equal(await q.deadLetterSize(), 1);
  const peeked = (await q.deadLetterPeek(10)) as Array<Task & { dlqReason?: string }>;
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0]!.taskId, 't1');
  assert.equal(peeked[0]!.attempts, 5);
  assert.equal(peeked[0]!.dlqReason, 'final');
  await q.close();
});

test('reclaim re-processes stale pending messages via XAUTOCLAIM', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const fake = createFakeRedis();
  const q = makeQueue(fake, { reclaimIntervalMs: 1_000, reclaimIdleMs: 1_000 });
  await q.enqueue(mkTask('t1'));
  const task = await q.dequeue(0); // delivered at virtual t=0
  assert.ok(task);

  // Advance the clock past reclaimIdleMs and fire the reclaim loop interval
  t.mock.timers.tick(1_500);
  await new Promise((r) => setTimeout(r, 0)); // flush reclaim's microtask chain
  await new Promise((r) => setTimeout(r, 0));

  const reclaimed = await q.dequeue(0);
  assert.ok(reclaimed, 'stale pending message is reclaimed and re-delivered');
  assert.equal(reclaimed!.taskId, 't1');
  assert.equal(reclaimed!.attempts, 1, 'reclaim bumps attempts');
  await q.close();
});

test('enqueue with the same idempotencyKey is a no-op', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  const t1 = mkTask('t1');
  t1.idempotencyKey = 'idem-1';
  await q.enqueue(t1);
  assert.equal(fake.getDedup('arena:dedup:idem-1'), 't1', 'SETNX dedup key recorded');

  await q.enqueue({ ...t1, taskId: 't1-copy' });
  assert.equal(await q.size(), 1, 'duplicate idempotencyKey is skipped');

  const t2 = mkTask('t2');
  t2.idempotencyKey = 'idem-2';
  await q.enqueue(t2);
  assert.equal(await q.size(), 2, 'a different idempotencyKey enqueues normally');
  await q.close();
});

test('deadLetterRetry re-enqueues a DLQ message and resets its attempts', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  await q.enqueue(mkTask('t1'));
  for (let i = 0; i < 5; i++) {
    const task = await q.dequeue(0);
    assert.ok(task);
    await q.nack(task!._redisId!, 'flaky');
  }
  assert.equal(await q.deadLetterSize(), 1);

  // NOTE: redis.ts addresses DLQ messages by their stream entry id, not the
  // task id (see report: deadLetterPeek does not currently expose it).
  const dlqIds = fake.getStreamIds(DLQ_STREAM);
  assert.equal(dlqIds.length, 1);
  assert.equal(await q.deadLetterRetry(dlqIds[0]!), true);
  assert.equal(await q.deadLetterSize(), 0, 'DLQ entry removed after retry');

  const retried = await q.dequeue(0);
  assert.ok(retried);
  assert.equal(retried!.taskId, 't1');
  assert.equal(retried!.attempts, 0, 'attempts reset for the retry');
  await q.close();
});

test('deadLetterRetry returns false for an unknown message id', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  assert.equal(await q.deadLetterRetry('does-not-exist'), false);
  await q.close();
});

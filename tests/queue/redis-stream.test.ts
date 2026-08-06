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
 *   eval(script, numKeys, ...keyOrArg)                  → 0|1 for SETNX dedup script; {ok,attempts} for nack script;
 *                                                       1 for the rotation script (XACK+XDEL+XADD, fake counts these)
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
    retryBackoffMs: 2_000,
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

test('nack re-enqueues with a bumped attempt; after maxAttempts moves the task to the DLQ', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fake = createFakeRedis();
  const q = makeQueue(fake, { retryBackoffMs: 50 });
  await q.enqueue(mkTask('t1'));

  for (let i = 1; i < 5; i++) {
    const task = await q.dequeue(0);
    assert.ok(task);
    assert.equal(task!.attempts, i - 1);
    await q.nack(task!._redisId!, 'transient');
    assert.equal(await q.size(), 1, 'nack re-adds to pending before maxAttempts');
    assert.equal(await q.deadLetterSize(), 0, 'not dead-lettered before maxAttempts');
    // Exponential backoff delays the re-delivery (50ms * 2^(attempts-1)) —
    // advance past it so the next dequeue can pick the task up again.
    t.mock.timers.tick(50 * 2 ** i);
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

  const pending = await fake.xpending(MAIN_STREAM, GROUP);
  assert.equal(pending[0], 0, 'reclaim removes the re-enqueued message from the pending list');

  const reclaimed = await q.dequeue(0);
  assert.ok(reclaimed, 'stale pending message is reclaimed and re-delivered');
  assert.equal(reclaimed!.taskId, 't1');
  assert.equal(reclaimed!.attempts, 1, 'reclaim bumps attempts');
  await q.close();
});

test('reclaim removes DLQed messages from the pending list', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const fake = createFakeRedis();
  const queue = makeQueue(fake, { maxAttempts: 1, reclaimIdleMs: 1_000 });
  // attempts already at maxAttempts so reclaim dead-letters on first pass
  await queue.enqueue({ ...mkTask('t1'), attempts: 1 });
  await queue.dequeue(0); // delivered -> pending (deliveredAt = t=0)
  // The fake's xautoclaim compares Date.now() against the PEL deliveredAt,
  // not real elapsed time — advance the mocked clock past reclaimIdleMs
  // instead of waiting, like the existing reclaim test does.
  t.mock.timers.tick(1_500);
  await (queue as unknown as { reclaimOrphaned(): Promise<void> }).reclaimOrphaned();
  const pending = await fake.xpending(MAIN_STREAM, GROUP);
  assert.equal(pending[0], 0, 'pending count must be 0 after reclaim dead-letters it');
  assert.ok((await queue.deadLetterSize()) > 0);
  await queue.close();
});

test('reclaim quarantines malformed messages and clears the pending list', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fake = createFakeRedis();
  const queue = makeQueue(fake, { reclaimIdleMs: 1_000 });
  await fake.xgroup('CREATE', MAIN_STREAM, GROUP, '$', 'MKSTREAM');
  await fake.xadd(MAIN_STREAM, '*', 'task', '{not-json');
  await fake.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', 1, 'BLOCK', 0, 'STREAMS', MAIN_STREAM, '>');
  t.mock.timers.tick(1_500);
  await (queue as unknown as { reclaimOrphaned(): Promise<void> }).reclaimOrphaned();
  const pending = await fake.xpending(MAIN_STREAM, GROUP);
  assert.equal(pending[0], 0, 'malformed entry must not linger in the pending list');
  assert.ok((await queue.deadLetterSize()) > 0, 'malformed entry quarantined to the DLQ');
  await queue.close();
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

test('deadLetterRetry re-enqueues a DLQ message by task id and resets its attempts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fake = createFakeRedis();
  const q = makeQueue(fake, { retryBackoffMs: 50 });
  await q.enqueue(mkTask('t1'));
  for (let i = 0; i < 5; i++) {
    const task = await q.dequeue(0);
    assert.ok(task);
    await q.nack(task!._redisId!, 'flaky');
    // Backoff is 50ms * 2^attempts — advance past it before the next dequeue
    t.mock.timers.tick(50 * 2 ** i);
  }
  assert.equal(await q.deadLetterSize(), 1);

  // DLQ entries carry opaque auto-ids from XADD '*', so retry must match the
  // embedded taskId field (deadLetterPeek exposes task ids, not stream ids).
  assert.equal(await q.deadLetterRetry('t1'), true);
  assert.equal(await q.deadLetterSize(), 0, 'DLQ entry removed after retry');

  const retried = await q.dequeue(0);
  assert.ok(retried);
  assert.equal(retried!.taskId, 't1');
  assert.equal(retried!.attempts, 0, 'attempts reset for the retry');
  await q.close();
});

test('deadLetterRetry returns false for a task id never in the DLQ', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  assert.equal(await q.deadLetterRetry('t1'), false);
  assert.equal(await q.deadLetterSize(), 0, 'nothing moved');
  await q.close();
});

test('enqueue routes tasks to the provider family stream from the router', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake, { providerFilter: 'groq' });
  const t = { ...mkTask('t1'), provider: 'groq' };
  await q.enqueue(t);

  // groq belongs to the openai-compat family — never its own literal stream
  assert.equal(streamKey(PREFIX, 'groq'), streamKey(PREFIX, 'openai'));
  assert.equal(fake.getStreamIds(`${PREFIX}:openai-compat`).length, 1);
  assert.equal(fake.getStreamIds(`${PREFIX}:groq`).length, 0, 'no literal provider stream');
  await q.close();
});

test('DLQ ops target the provider family DLQ stream', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const fake = createFakeRedis();
  const q = makeQueue(fake, { providerFilter: 'groq', retryBackoffMs: 50 });
  await q.enqueue({ ...mkTask('t1'), provider: 'groq' });
  for (let i = 0; i < 5; i++) {
    const task = await q.dequeue(0);
    assert.ok(task);
    await q.nack(task!._redisId!, 'boom');
    // Backoff is 50ms * 2^attempts — advance past it before the next dequeue
    t.mock.timers.tick(50 * 2 ** i);
  }
  assert.equal(await q.deadLetterSize(), 1);
  assert.equal(fake.getStreamIds(dlqStreamKey(PREFIX, 'groq')).length, 1, 'dead-lettered on the provider DLQ stream');

  const peeked = (await q.deadLetterPeek(10)) as Array<Task & { dlqReason?: string }>;
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0]!.taskId, 't1');
  assert.equal(peeked[0]!.dlqReason, 'boom');
  await q.close();
});

test('pending reports waiting (not in-flight) task count', async () => {
  const fake = createFakeRedis();
  const q = makeQueue(fake);
  await q.enqueue(mkTask('t1'));
  await q.enqueue(mkTask('t2'));
  assert.equal(await q.pendingCount(), 2, 'xlen - xpending = 2 - 0');

  const first = await q.dequeue(0);
  assert.ok(first);
  assert.equal(await q.pendingCount(), 1, 'delivered-but-unacked message is not waiting');

  await q.ack(first!._redisId!);
  assert.equal(await q.pendingCount(), 2, 'acked message is waiting again');
  await q.close();
});

test('nack applies backoff: task is not re-delivered before dueAt', async () => {
  const fake = createFakeRedis();
  const queue = makeQueue(fake, { retryBackoffMs: 100 });
  await queue.enqueue(mkTask('t1'));
  const first = await queue.dequeue(0);
  assert.ok(first);
  await queue.nack(first._redisId!, 'retry me');
  const tooSoon = await queue.dequeue(0);
  assert.equal(tooSoon, null, 'task must not be delivered before its backoff elapses');
  await new Promise((r) => setTimeout(r, 250));
  const after = await queue.dequeue(0);
  assert.ok(after);
  assert.equal(after.attempts, 1);
});

test('rotation re-entry serves ready tasks behind not-due ones', async () => {
  const fake = createFakeRedis();
  const queue = makeQueue(fake, { retryBackoffMs: 10_000 });
  // t1 is not due; t2/t3 are ready and sit behind it in the stream
  await queue.enqueue({ ...mkTask('t1'), dueAt: Date.now() + 60_000 });
  await queue.enqueue(mkTask('t2'));
  await queue.enqueue(mkTask('t3'));

  const next = await queue.dequeue(0);
  assert.ok(next, 'a ready task behind a not-due head must be served (no null fall-through)');
  assert.notEqual(next!.taskId, 't1', 'the not-due head is never served');
  assert.ok(['t2', 't3'].includes(next!.taskId), 'the returned task is one of the ready ones');
  assert.equal(await queue.size(), 3, 'rotation re-adds the not-due task — nothing is lost');

  const ids = fake.getStreamIds(MAIN_STREAM);
  const tailFields = fake.getStreamEntry(MAIN_STREAM, ids[ids.length - 1]!);
  const tailData: Record<string, string> = {};
  for (let i = 0; i < (tailFields ?? []).length; i += 2) tailData[tailFields![i]!] = tailFields![i + 1]!;
  assert.equal(JSON.parse(tailData.task ?? '{}').taskId, 't1', 'the not-due task is rotated to the tail of the stream');
  await queue.close();
});

test('rotation preserves the task on the stream across any number of rotations', async () => {
  const fake = createFakeRedis();
  const queue = makeQueue(fake, { retryBackoffMs: 10_000 });
  const t1 = mkTask('t1');
  (t1 as unknown as { _traceparent?: string })._traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  await queue.enqueue(t1);

  const first = await queue.dequeue(0);
  assert.ok(first);
  await queue.nack(first!._redisId!, 'backoff'); // dueAt = now + 10s → not due

  const assertSurvives = () => {
    const ids = fake.getStreamIds(MAIN_STREAM);
    assert.equal(ids.length, 1, 'stream must always hold the nacked task');
    const fields = fake.getStreamEntry(MAIN_STREAM, ids[0]!);
    const data: Record<string, string> = {};
    for (let i = 0; i < (fields ?? []).length; i += 2) data[fields![i]!] = fields![i + 1]!;
    const task = JSON.parse(data.task ?? '{}');
    assert.equal(task.taskId, 't1', 'rotated entry still carries the original task');
    assert.equal(task.attempts, 1, 'rotation preserves the bumped attempts');
    assert.equal(data.traceparent, '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'rotation preserves traceparent');
  };

  await queue.dequeue(0); // rotates the not-due head up to MAX_RETRY_ROTATIONS times
  assertSurvives();
  assert.ok(fake.rotationEvalCount >= 1, 'rotation went through the atomic Lua script');

  const idBefore = fake.getStreamIds(MAIN_STREAM)[0];
  await queue.dequeue(0); // second rotation pass
  assertSurvives();
  assert.notEqual(fake.getStreamIds(MAIN_STREAM)[0], idBefore, 'each rotation re-adds the entry under a fresh id');
  await queue.close();
});

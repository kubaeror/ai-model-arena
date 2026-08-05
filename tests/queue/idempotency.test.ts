import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';

function mkTask(id: string, idemKey?: string): Task {
  return {
    taskId: id, sessionId: 's', provider: 'openai', model: 'gpt-4o',
    scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(),
    attempts: 0, idempotencyKey: idemKey,
  };
}

test('duplicate enqueue with same idempotencyKey is ignored', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1', 'key-abc'));
  await q.enqueue(mkTask('t2', 'key-abc')); // duplicate
  assert.equal(await q.size(), 1);
});

test('different idempotencyKeys produce separate tasks', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1', 'key-a'));
  await q.enqueue(mkTask('t2', 'key-b'));
  assert.equal(await q.size(), 2);
});

test('task without idempotencyKey is always enqueued', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1'));
  await q.enqueue(mkTask('t1')); // same taskId, no key — should produce 2
  assert.equal(await q.size(), 2);
});

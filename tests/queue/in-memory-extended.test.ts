import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';

function mkTask(taskId: string, provider = 'openai', model = 'gpt-4o'): Task {
  return {
    taskId, sessionId: `session-${taskId}`, promptId: 'test-prompt', promptVersion: 1,
    provider, model, scenario: 'express-rest',
    config: { maxTurns: 5 }, enqueuedAt: new Date().toISOString(), attempts: 0,
  };
}

test('InMemoryQueue: full enqueue → dequeue → ack lifecycle', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1'));
  assert.equal(await q.size(), 1);
  const dequeued = await q.dequeue(1000);
  assert.ok(dequeued);
  assert.equal(dequeued!.taskId, 't1');
  assert.equal(await q.size(), 1); // still in-flight
  await q.ack('t1');
  assert.equal(await q.size(), 0);
  await q.close?.();
});

test('InMemoryQueue: nack requeues with attempt increment', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t2'));
  const dequeued = await q.dequeue(1000);
  assert.ok(dequeued);
  assert.equal(dequeued!.attempts, 0);
  await q.nack('t2', 'transient');
  assert.equal(await q.size(), 1); // requeued but still in pending/in-flight
  const dequeued2 = await q.dequeue(1000);
  assert.ok(dequeued2);
  assert.equal(dequeued2!.attempts, 1);
  await q.close?.();
});

test('InMemoryQueue: nack moves to dead-letter after 5 attempts', async () => {
  const q = new InMemoryQueue();
  const t = mkTask('t3', 'openai', 'gpt-4o');
  t.attempts = 4;
  await q.enqueue(t);
  const dequeued = await q.dequeue(1000);
  assert.ok(dequeued);
  await q.nack('t3', 'exceeded');
  // after nack, attempts would be 5 → dead (not requeued)
  assert.equal(await q.size(), 0);
  await q.close?.();
});

test('InMemoryQueue: dequeue blocks until task arrives', async () => {
  const q = new InMemoryQueue();
  let result: Task | null = null;
  const promise = q.dequeue(5000).then(t => { result = t; });
  // enqueue after a short delay while dequeue is waiting
  setTimeout(() => q.enqueue(mkTask('t4')), 50);
  await promise;
  assert.ok(result);
  assert.equal(result!.taskId, 't4');
  await q.close?.();
});

test('InMemoryQueue: dequeue returns null on timeout', async () => {
  const q = new InMemoryQueue();
  const result = await q.dequeue(50);
  assert.equal(result, null);
  await q.close?.();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';

function mkTask(id: string): Task {
  return { taskId: id, sessionId: 's', provider: 'openai', model: 'gpt-4o', scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(), attempts: 0 };
}

test('enqueue then dequeue returns the task', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1'));
  const t = await q.dequeue(100);
  assert.equal(t?.taskId, 't1');
});

test('dequeue blocks until a task is available', async () => {
  const q = new InMemoryQueue();
  setTimeout(() => { q.enqueue(mkTask('t2')); }, 20);
  const t = await q.dequeue(1000);
  assert.equal(t?.taskId, 't2');
});

test('dequeue returns null on timeout', async () => {
  const q = new InMemoryQueue();
  const t = await q.dequeue(50);
  assert.equal(t, null);
});

test('ack removes; nack requeues', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t3'));
  const t = await q.dequeue(100);
  await q.nack(t!.taskId);
  assert.equal(await q.size(), 1);
  const t2 = await q.dequeue(100);
  assert.equal(t2?.taskId, 't3');
  await q.ack(t2!.taskId);
  assert.equal(await q.size(), 0);
});

test('pending counts only waiting tasks, not in-flight', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1'));
  await q.enqueue(mkTask('t2'));
  assert.equal(await q.pendingCount(), 2);

  const t = await q.dequeue(100);
  assert.equal(t?.taskId, 't1');
  assert.equal(await q.pendingCount(), 1, 'in-flight task is not waiting');

  await q.ack(t!.taskId);
  assert.equal(await q.pendingCount(), 1, 'acked task does not return to pending');
});

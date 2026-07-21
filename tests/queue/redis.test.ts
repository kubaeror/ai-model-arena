import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisStreamQueue } from '../../src/queue/redis.js';

const REDIS_URL = process.env.REDIS_URL;
const it = REDIS_URL ? test : test.skip;

it('enqueue + dequeue round-trip', async () => {
  const prefix = 'arena:test:' + Date.now();
  const q = new RedisStreamQueue({ url: REDIS_URL!, streamPrefix: prefix, consumerGroup: 'g', consumerName: 'c', maxAttempts: 5, blockMs: 2000, providerFilter: 'openai' });
  await q.enqueue({ taskId: 't1', sessionId: 's', provider: 'openai', model: 'gpt-4o', scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(), attempts: 0 });
  const t = await q.dequeue(5000);
  assert.ok(t);
  assert.equal(t!.taskId, 't1');
});

it('dequeue returns null on empty stream', async () => {
  const prefix = 'arena:test:' + Date.now();
  const q = new RedisStreamQueue({ url: REDIS_URL!, streamPrefix: prefix, consumerGroup: 'g', consumerName: 'c', maxAttempts: 5, blockMs: 200, providerFilter: 'openai' });
  const t = await q.dequeue(100);
  assert.equal(t, null);
});

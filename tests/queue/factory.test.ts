import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../../src/queue/index.js';
import { InMemoryQueue } from '../../src/queue/in-memory.js';

function saveEnv() {
  const driver = process.env.QUEUE_DRIVER;
  const url = process.env.REDIS_URL;
  return () => {
    if (driver === undefined) delete process.env.QUEUE_DRIVER;
    else process.env.QUEUE_DRIVER = driver;
    if (url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = url;
  };
}

test('createQueue defaults to in-memory queue', (t) => {
  t.after(saveEnv());
  delete process.env.QUEUE_DRIVER;
  assert.ok(createQueue() instanceof InMemoryQueue);
});

test('createQueue returns in-memory queue for QUEUE_DRIVER=memory', (t) => {
  t.after(saveEnv());
  process.env.QUEUE_DRIVER = 'memory';
  assert.ok(createQueue() instanceof InMemoryQueue);
});

test('createQueue throws when QUEUE_DRIVER=redis without REDIS_URL', (t) => {
  t.after(saveEnv());
  process.env.QUEUE_DRIVER = 'redis';
  delete process.env.REDIS_URL;
  assert.throws(() => createQueue(), /REDIS_URL is required/);
});

test('createQueue throws for unknown driver', (t) => {
  t.after(saveEnv());
  process.env.QUEUE_DRIVER = 'bogus';
  assert.throws(() => createQueue(), /Unknown QUEUE_DRIVER: bogus/);
});

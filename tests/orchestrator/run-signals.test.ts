import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRunSignalStore,
  RedisRunSignalStore,
  setRunSignalStoreForTests,
  isKillSwitchActive,
  setKillSwitch,
  isRunCancelled,
  markRunCancelled,
  clearRunCancelled,
} from '../../src/orchestrator/run-signals.js';

test('in-memory store: kill switch + cancellation round-trip', async () => {
  const store = new InMemoryRunSignalStore();
  assert.equal(await store.isKillSwitchActive(), false);
  await store.setKillSwitch(true);
  assert.equal(await store.isKillSwitchActive(), true);
  await store.setKillSwitch(false);
  assert.equal(await store.isKillSwitchActive(), false);
  assert.equal(await store.isRunCancelled('r1'), false);
  await store.markRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r1'), true);
  await store.clearRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r1'), false);
});

test('in-memory store: independent runs', async () => {
  const store = new InMemoryRunSignalStore();
  await store.markRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r2'), false);
});

test('singleton follows a replaced store (test seam)', async () => {
  const store = new InMemoryRunSignalStore();
  setRunSignalStoreForTests(store);
  await markRunCancelled('x1');
  assert.equal(await isRunCancelled('x1'), true);
  await clearRunCancelled('x1');
  assert.equal(await isRunCancelled('x1'), false);
  await setKillSwitch(true);
  assert.equal(await isKillSwitchActive(), true);
  await setKillSwitch(false);
});

test('redis store uses the documented key shapes', { skip: !process.env.REDIS_URL }, async () => {
  const store = new RedisRunSignalStore({ url: process.env.REDIS_URL as string });
  await store.setKillSwitch(true);
  assert.equal(await store.isKillSwitchActive(), true);
  await store.setKillSwitch(false);
  await store.markRunCancelled('pg-run');
  assert.equal(await store.isRunCancelled('pg-run'), true);
  await store.clearRunCancelled('pg-run');
  assert.equal(await store.isRunCancelled('pg-run'), false);
  await store.close();
});

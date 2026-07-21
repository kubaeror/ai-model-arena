import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTaskId, configHash } from '../../src/runner/idempotency.js';
import { initDb, closeDb } from '../../src/db/client.js';

test('configHash is deterministic across JSON key reorderings', () => {
  const a = configHash({ b: 2, a: 1, c: 3 });
  const b = configHash({ c: 3, a: 1, b: 2 });
  assert.equal(a, b);
});

test('configHash changes with different values', () => {
  const a = configHash({ x: 1 });
  const b = configHash({ x: 2 });
  assert.notEqual(a, b);
});

test('configHash is stable for nested objects', () => {
  const a = configHash({ outer: { inner: 'val', other: 1 } });
  const b = configHash({ outer: { other: 1, inner: 'val' } });
  assert.equal(a, b);
});

test('computeTaskId is deterministic', () => {
  const id1 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  const id2 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  assert.equal(id1, id2);
});

test('computeTaskId differs on model change', () => {
  const id1 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  const id2 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'claude-3', configHash: 'abc', runId: 'r1' });
  assert.notEqual(id1, id2);
});

test('computeTaskId differs on promptVersion change', () => {
  const id1 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  const id2 = computeTaskId({ promptId: 'p1', promptVersion: 2, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  assert.notEqual(id1, id2);
});

test('computeTaskId differs on configHash change', () => {
  const id1 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  const id2 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'def', runId: 'r1' });
  assert.notEqual(id1, id2);
});

test('computeTaskId differs on runId change', () => {
  const id1 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r1' });
  const id2 = computeTaskId({ promptId: 'p1', promptVersion: 1, model: 'gpt-4o', configHash: 'abc', runId: 'r2' });
  assert.notEqual(id1, id2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTaskId, configHash } from '../../src/runner/idempotency.js';

test('computeTaskId is deterministic', () => {
  const opts = { promptId: 'p', promptVersion: 1, model: 'gpt-4o', configHash: 'h', runId: 'r' };
  assert.equal(computeTaskId(opts), computeTaskId(opts));
});

test('computeTaskId differs on model change', () => {
  const base = { promptId: 'p', promptVersion: 1, configHash: 'h', runId: 'r' };
  assert.notEqual(
    computeTaskId({ ...base, model: 'gpt-4o' }),
    computeTaskId({ ...base, model: 'claude' }),
  );
});

test('configHash is stable for object key order', () => {
  assert.equal(configHash({ a: 1, b: 2 }), configHash({ b: 2, a: 1 }));
});

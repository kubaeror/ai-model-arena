import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, safeParseTask } from '../../src/queue/task-schema.js';

const validTask = {
  taskId: 't1',
  sessionId: 's1',
  provider: 'openai',
  model: 'gpt-4o',
  scenario: 'benchmark',
  config: {},
  enqueuedAt: new Date().toISOString(),
};

test('parseTask returns task for valid input (attempts defaults to 0)', () => {
  const task = parseTask(validTask);
  assert.equal(task.attempts, 0);
  assert.equal(task.taskId, 't1');
});

test('parseTask accepts optional fields', () => {
  const task = parseTask({
    ...validTask,
    promptId: 'p1',
    promptVersion: 2,
    attempts: 3,
    idempotencyKey: 'idem',
    _redisId: 'rid',
    _traceparent: '00-abcdef-123456-01',
  });
  assert.equal(task.promptId, 'p1');
  assert.equal(task.promptVersion, 2);
  assert.equal(task.attempts, 3);
  assert.equal(task.idempotencyKey, 'idem');
  assert.equal(task._redisId, 'rid');
  assert.equal(task._traceparent, '00-abcdef-123456-01');
});

test('parseTask throws for empty model', () => {
  assert.throws(() => parseTask({ ...validTask, model: '' }), /model/);
});

test('parseTask throws for empty taskId', () => {
  assert.throws(() => parseTask({ ...validTask, taskId: '' }), /taskId/);
});

test('parseTask throws for missing provider', () => {
  const { provider: _omitted, ...noProvider } = validTask;
  assert.throws(() => parseTask(noProvider), /provider/);
});

test('safeParseTask returns task for valid input', () => {
  assert.equal(safeParseTask(validTask)?.taskId, 't1');
});

test('safeParseTask returns null for invalid input', () => {
  assert.equal(safeParseTask({ ...validTask, sessionId: '' }), null);
});

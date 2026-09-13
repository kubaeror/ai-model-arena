import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationLogger } from '../../src/logger/conversation-logger.js';

function tmpConvPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-conv-logger-'));
  return path.join(dir, 'conversation.json');
}

const META = {
  model: 'gpt-4o',
  scenario: 'smoke',
  runId: 'run-1',
  startedAt: '2026-01-01T00:00:00.000Z',
};

test('append coalesces writes; flush persists the full JSON object', () => {
  const filePath = tmpConvPath();
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'system', role: 'system', content: 'sys', turn: 0, timestamp: '2026-01-01T00:00:01.000Z' });
  conv.append({ type: 'user', role: 'user', content: 'hi', turn: 1, timestamp: '2026-01-01T00:00:02.000Z' });
  assert.equal(fs.existsSync(filePath), false, 'append must not rewrite the growing transcript synchronously');

  conv.append({ type: 'assistant', role: 'assistant', content: 'hello', turn: 1, timestamp: '2026-01-01T00:00:03.000Z' });
  assert.equal(fs.existsSync(filePath), false, 'multiple appends must be coalesced into one pending write');

  conv.flush();
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed, {
    ...META,
    entries: [
      { type: 'system', role: 'system', content: 'sys', turn: 0, timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'user', role: 'user', content: 'hi', turn: 1, timestamp: '2026-01-01T00:00:02.000Z' },
      { type: 'assistant', role: 'assistant', content: 'hello', turn: 1, timestamp: '2026-01-01T00:00:03.000Z' },
    ],
  });
});

test('a pending append is persisted by the debounce timer without an explicit flush', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tmpConvPath();
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'info', content: 'later', timestamp: '2026-01-01T00:00:04.000Z' });
  assert.equal(fs.existsSync(filePath), false);
  t.mock.timers.tick(1000);
  assert.equal(fs.existsSync(filePath), true);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.entries, [
    { type: 'info', content: 'later', timestamp: '2026-01-01T00:00:04.000Z' },
  ]);
});

test('flush writes atomically and leaves no temp files behind', () => {
  const filePath = tmpConvPath();
  const dir = path.dirname(filePath);
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'info', content: 'atomic', timestamp: '2026-01-01T00:00:05.000Z' });
  conv.flush();

  assert.deepEqual(fs.readdirSync(dir), ['conversation.json'], 'flush must not leave temp files behind');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.entries, [
    { type: 'info', content: 'atomic', timestamp: '2026-01-01T00:00:05.000Z' },
  ]);
});

test('a failed flush does not throw, cleans up its temp file, and retries on the next flush', () => {
  const filePath = tmpConvPath();
  const dir = path.dirname(filePath);
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'info', content: 'x', timestamp: '2026-01-01T00:00:06.000Z' });
  // A directory at the destination makes renameSync fail after the temp write.
  fs.mkdirSync(filePath);
  assert.doesNotThrow(() => conv.flush(), 'a transient transcript write failure must not crash the caller');

  const leftoverTemps = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftoverTemps, [], 'failed flush must not leave a temp file behind');

  fs.rmdirSync(filePath);
  conv.flush();
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.entries, [
    { type: 'info', content: 'x', timestamp: '2026-01-01T00:00:06.000Z' },
  ], 'the retained entries are persisted by the next flush');
});

test('a failing debounce write never throws and a later flush retries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tmpConvPath();
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'info', content: 'debounced', timestamp: '2026-01-01T00:00:07.000Z' });
  fs.mkdirSync(filePath);
  assert.doesNotThrow(() => t.mock.timers.tick(1000), 'the debounce timer must swallow write failures');

  fs.rmdirSync(filePath);
  conv.flush();
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.entries.map((e: { content?: string }) => e.content), ['debounced']);
});

test('flushing mid-run keeps earlier entries and appends later ones', () => {
  const filePath = tmpConvPath();
  const conv = new ConversationLogger(filePath, META);

  conv.append({ type: 'user', role: 'user', content: 'one', turn: 1, timestamp: '2026-01-01T00:00:01.000Z' });
  conv.flush();
  conv.append({ type: 'assistant', role: 'assistant', content: 'two', turn: 2, timestamp: '2026-01-01T00:00:02.000Z' });
  conv.flush();

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(parsed.entries.map((e: { content?: string }) => e.content), ['one', 'two']);
});

test('setEnded flushes the ended marker immediately', () => {
  const filePath = tmpConvPath();
  const conv = new ConversationLogger(filePath, META);
  conv.append({ type: 'info', content: 'x', timestamp: '2026-01-01T00:00:01.000Z' });
  conv.setEnded('2026-01-01T00:01:00.000Z');

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(parsed.endedAt, '2026-01-01T00:01:00.000Z');
  assert.equal(parsed.entries.length, 1);
});

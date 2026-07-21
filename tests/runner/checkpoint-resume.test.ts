import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';
import { resumeFrom } from '../../src/runner/checkpoint.js';

test('resumeFrom returns empty messages + lastCompletedTurn -1 for fresh session', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  const result = await resumeFrom(s.id);
  assert.deepStrictEqual(result.messages, []);
  assert.equal(result.lastCompletedTurn, -1);
  closeDb();
});

test('resumeFrom returns stored messages and computes lastCompletedTurn', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });

  await store.appendMessage(s.id, {
    id: 'm1', sessionId: s.id, turn: 0, role: 'user',
    content: 'task', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o',
    requestHash: 'h1', responseText: 'done', usage: null, latencyMs: 200,
  });

  await store.appendMessage(s.id, {
    id: 'm2', sessionId: s.id, turn: 1, role: 'user',
    content: 'more', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 2);
  assert.equal(result.lastCompletedTurn, 0);
  closeDb();
});

test('resumeFrom returns chat messages with toolCalls parsed from JSON', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });

  await store.appendMessage(s.id, {
    id: 'm3', sessionId: s.id, turn: 1, role: 'assistant',
    content: null,
    toolCalls: JSON.stringify([{ id: 'tc1', name: 'list_files', arguments: {} }]),
    toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 1);
  const msg = result.messages[0]!;
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content, null);
  assert.ok(msg.toolCalls);
  assert.equal(msg.toolCalls![0]!.name, 'list_files');
  closeDb();
});

test('resumeFrom handles multi-turn with mixed completed turns', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'claude-3' });

  await store.appendMessage(s.id, {
    id: 'm1', sessionId: s.id, turn: 0, role: 'user', content: 'hello',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 0, provider: 'anthropic', model: 'claude-3',
    requestHash: 'h1', responseText: 'hi', usage: null, latencyMs: 100,
  });

  await store.appendMessage(s.id, {
    id: 'm2', sessionId: s.id, turn: 1, role: 'user', content: 'build',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });
  await store.recordModelCall({
    sessionId: s.id, turn: 1, provider: 'anthropic', model: 'claude-3',
    requestHash: 'h2', responseText: 'building', usage: null, latencyMs: 150,
  });

  await store.appendMessage(s.id, {
    id: 'm3', sessionId: s.id, turn: 2, role: 'user', content: 'finish',
    toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null,
    createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 3);
  assert.equal(result.lastCompletedTurn, 1);
  closeDb();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';

test('createSession → loadSession round-trips', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ promptId: 'p1', promptVersion: 2, model: 'gpt-4o' });
  assert.ok(s.id);
  assert.equal(s.model, 'gpt-4o');
  assert.equal(s.status, 'active');

  const loaded = await store.loadSession(s.id);
  assert.ok(loaded);
  assert.equal(loaded!.model, 'gpt-4o');
  assert.equal(loaded!.promptId, 'p1');
  assert.equal(loaded!.promptVersion, 2);
  closeDb();
});

test('loadSession returns null for unknown id', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const loaded = await store.loadSession('nonexistent');
  assert.equal(loaded, null);
  closeDb();
});

test('appendMessage stores and listMessages returns messages', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'claude-3' });
  await store.appendMessage(s.id, {
    id: 'msg-1', sessionId: s.id, turn: 0, role: 'user',
    content: 'hello', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });
  await store.appendMessage(s.id, {
    id: 'msg-2', sessionId: s.id, turn: 0, role: 'assistant',
    content: 'hi there', toolCalls: null, toolCallId: null,
    tokenInput: 50, tokenOutput: 10, createdAt: new Date().toISOString(),
  });

  const msgs = await store.listMessages(s.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'user');
  assert.equal(msgs[1]!.role, 'assistant');
  assert.equal(msgs[1]!.tokenInput, 50);
  closeDb();
});

test('recordModelCall → getModelCall round-trips', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  await store.recordModelCall({
    sessionId: s.id, turn: 1, provider: 'openai', model: 'gpt-4o',
    requestHash: 'abc123', responseText: 'response', usage: { prompt: 10, completion: 5 },
    latencyMs: 250,
  });

  const mc = await store.getModelCall(s.id, 1);
  assert.ok(mc);
  assert.equal(mc!.provider, 'openai');
  assert.equal(mc!.model, 'gpt-4o');
  assert.equal(mc!.latencyMs, 250);
  assert.deepStrictEqual(mc!.usage, { prompt: 10, completion: 5 });
  closeDb();
});

test('getModelCall returns null for unknown turn', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  const mc = await store.getModelCall(s.id, 99);
  assert.equal(mc, null);
  closeDb();
});

test('updateSessionStatus changes status', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'claude-3' });
  assert.equal(s.status, 'active');
  await store.updateSessionStatus(s.id, 'completed');
  const loaded = await store.loadSession(s.id);
  assert.equal(loaded!.status, 'completed');
  closeDb();
});

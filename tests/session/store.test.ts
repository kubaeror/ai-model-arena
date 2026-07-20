import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';

test('session round-trips messages + model_calls', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  assert.ok(s.id);
  await store.appendMessage(s.id, { id: 'msg1', sessionId: s.id, turn: 0, role: 'user', content: 'hi', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString() });
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h1', responseText: 'hello', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 10 });
  const msgs = await store.listMessages(s.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.content, 'hi');
  const mc = await store.getModelCall(s.id, 0);
  assert.equal(mc?.responseText, 'hello');
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h1', responseText: 'hello2', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 12 });
  assert.equal((await store.getModelCall(s.id, 0))?.responseText, 'hello2');
  closeDb();
});

test('updateSessionStatus changes status', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  await store.updateSessionStatus(s.id, 'completed');
  const loaded = await store.loadSession(s.id);
  assert.equal(loaded?.status, 'completed');
  closeDb();
});

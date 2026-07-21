import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';
import { resumeFrom } from '../../src/runner/checkpoint.js';

test('resumeFrom returns persisted messages + last turn', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  await store.appendMessage(s.id, { id: 'm1', sessionId: s.id, turn: 0, role: 'user', content: 'hi', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString() });
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h', responseText: 'hello', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 10 });
  await store.appendMessage(s.id, { id: 'm2', sessionId: s.id, turn: 1, role: 'assistant', content: 'hello', toolCalls: null, toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString() });
  const { messages, lastCompletedTurn } = await resumeFrom(s.id);
  assert.equal(lastCompletedTurn, 0);
  assert.equal(messages.length, 2);
  closeDb();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';
import { resumeFrom } from '../../src/runner/checkpoint.js';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter, ChatMessage } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

function stubToolCtx() {
  return { sandboxDir: '/tmp', logger: stubLogger(), shellTimeoutMs: 10000, maxShellOutputBytes: 524288 };
}

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

  await store.appendMessage(s.id, {
    id: 'm2', sessionId: s.id, turn: 1, role: 'user',
    content: 'more', toolCalls: null, toolCallId: null,
    tokenInput: null, tokenOutput: null, createdAt: new Date().toISOString(),
  });

  const result = await resumeFrom(s.id);
  assert.equal(result.messages.length, 2);
  assert.equal(result.lastCompletedTurn, 1);
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
  assert.equal(result.lastCompletedTurn, 2);
  closeDb();
});

test('runAgentLoop resumed from checkpoint does not duplicate system+user entries in the conversation', async () => {
  const systemPrompt = 'You are a coding agent.';
  const task = 'Build a feature.';

  // Messages as resumeFrom() would return them: the initial pair plus one completed turn.
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
    { role: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'list_files', arguments: {} }] },
    { role: 'tool', toolCallId: 'tc1', name: 'list_files', content: '[]' },
  ];

  // Conversation already persisted by the original run (system+user pair).
  const entries: any[] = [
    { type: 'system', role: 'system', content: systemPrompt },
    { type: 'user', role: 'user', content: task },
  ];
  const conv = {
    append: (e: any) => entries.push({ ...e, timestamp: e.timestamp ?? new Date().toISOString() }),
    flush: () => {},
    setEnded: () => {},
  } as unknown as ConversationLogger;

  const adapter: ModelAdapter = {
    sendMessage: async () => ({ text: 'done', toolCalls: [], usage: { prompt: 10, completion: 5 }, stopReason: 'no_tool_calls' }),
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };

  await runAgentLoop({
    adapter, tools: [], executors: {},
    systemPrompt, task, maxTurns: 5,
    toolCtx: stubToolCtx(), conv, logger: stubLogger(),
    initialMessages,
  });

  const systemPromptEntries = entries.filter((e) => e.role === 'system' && e.content === systemPrompt);
  const taskEntries = entries.filter((e) => e.role === 'user' && e.content === task);
  assert.equal(systemPromptEntries.length, 1, `system prompt duplicated on resume: ${systemPromptEntries.length} entries`);
  assert.equal(taskEntries.length, 1, `task duplicated on resume: ${taskEntries.length} entries`);
  assert.ok(entries.some((e) => e.content === '[resumed from checkpoint]'), 'expected "[resumed from checkpoint]" marker entry');
});

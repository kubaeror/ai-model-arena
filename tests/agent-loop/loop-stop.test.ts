import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter, ModelResponse, ChatMessage, ToolDefinition } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { TASK_COMPLETE_TOOL } from '../../src/tools/schema.js';

function stubAdapter(responses: ModelResponse[]): ModelAdapter & { sendCalls: () => number } {
  let i = 0;
  let sent = 0;
  return {
    sendMessage: async () => {
      sent++;
      const r = responses[i++] ?? { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'no_tool_calls' };
      return r;
    },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
    sendCalls: () => sent,
  };
}

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

function stubConv() {
  const entries: any[] = [];
  return { append: (e: any) => entries.push({ ...e, timestamp: e.timestamp ?? new Date().toISOString() }), flush: () => {}, entries, setEnded: () => {}, get entries_readonly() { return entries; } } as unknown as ConversationLogger;
}

function stubToolCtx() {
  return { sandboxDir: '/tmp', logger: stubLogger(), shellTimeoutMs: 10000, maxShellOutputBytes: 524288 };
}

function baseOpts() {
  return {
    tools: [], executors: {},
    systemPrompt: 's', task: 't', maxTurns: 10, toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  };
}

test('stops on task_complete', async () => {
  const adapter = stubAdapter([
    { text: '', toolCalls: [{ id: '1', name: TASK_COMPLETE_TOOL, arguments: {} }], usage: { prompt: 10, completion: 5 }, stopReason: 'tool_call' },
  ]);
  const result = await runAgentLoop({
    adapter: adapter as ModelAdapter, tools: [{ name: TASK_COMPLETE_TOOL, description: '', parameters: {} }], executors: { [TASK_COMPLETE_TOOL]: async () => ({ content: 'done', isError: false }) },
    systemPrompt: 's', task: 't', maxTurns: 10, toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  });
  assert.equal(result.stopReason, 'task_complete');
});

test('stops on no_tool_calls', async () => {
  const adapter = stubAdapter([
    { text: 'done', toolCalls: [], usage: { prompt: 10, completion: 5 }, stopReason: 'no_tool_calls' },
  ]);
  const result = await runAgentLoop({
    adapter: adapter as ModelAdapter, tools: [], executors: {},
    systemPrompt: 's', task: 't', maxTurns: 10, toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  });
  assert.equal(result.stopReason, 'no_tool_calls');
});

test('stops on maxTurns', async () => {
  const tool: ToolDefinition = { name: 'list_files', description: '', parameters: {} };
  const adapter = stubAdapter(
    Array(30).fill({ text: '', toolCalls: [{ id: 'x', name: 'list_files', arguments: {} }], usage: { prompt: 10, completion: 5 }, stopReason: 'tool_call' }),
  );
  const result = await runAgentLoop({
    adapter: adapter as ModelAdapter, tools: [tool], executors: { list_files: async () => ({ content: 'files', isError: false }) },
    systemPrompt: 's', task: 't', maxTurns: 5, toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  });
  assert.equal(result.stopReason, 'max_turns');
  assert.equal(result.turnsUsed, 5);
});

test('stops on api_error', async () => {
  const adapter: ModelAdapter = {
    sendMessage: async () => { throw new Error('API down'); },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };
  const result = await runAgentLoop({
    adapter, tools: [], executors: {},
    systemPrompt: 's', task: 't', maxTurns: 10, toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  });
  assert.equal(result.stopReason, 'api_error');
  assert.ok(result.errors.length > 0);
});

test('budget check runs before the first model call and stops immediately', async () => {
  const calls: number[] = [];
  const adapter = stubAdapter([]);
  const result = await runAgentLoop({
    ...baseOpts(),
    adapter: adapter as ModelAdapter, maxTurns: 5,
    onBudgetCheck: async () => { calls.push(1); return false; },
  });
  assert.equal(result.stopReason, 'budget_exceeded');
  assert.equal(calls.length, 1);
  assert.equal(adapter.sendCalls(), 0); // adapter.sendMessage never invoked
});

test('maxTurns=0 returns stopReason max_turns without invoking the model', async () => {
  const adapter = stubAdapter([]);
  const result = await runAgentLoop({
    ...baseOpts(),
    adapter: adapter as ModelAdapter, maxTurns: 0,
  });
  assert.equal(result.stopReason, 'max_turns');
  assert.equal(adapter.sendCalls(), 0);
});

test('no_tool_calls completion calls onTurnComplete once with the turn usage', async () => {
  const adapter = stubAdapter([
    { text: 'done', toolCalls: [], usage: { prompt: 10, completion: 5 }, stopReason: 'no_tool_calls' },
  ]);
  let calls = 0;
  let capturedUsage: { prompt?: number } | undefined;
  await runAgentLoop({
    ...baseOpts(),
    adapter: adapter as ModelAdapter, maxTurns: 5,
    onTurnComplete: async (_turn: number, _messages: ChatMessage[], usage: { prompt?: number }) => { calls++; capturedUsage = usage; },
  });
  assert.equal(calls, 1);
  assert.equal(capturedUsage?.prompt, 10);
});

test('api_error does not call onTurnComplete', async () => {
  const adapter: ModelAdapter = {
    sendMessage: async () => { throw new Error('API down'); },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };
  let calls = 0;
  await runAgentLoop({
    ...baseOpts(),
    adapter, maxTurns: 5,
    onTurnComplete: async () => { calls++; },
  });
  assert.equal(calls, 0);
});

test('onTurnComplete receives the model response durationMs for ttft capture', async () => {
  const tool: ToolDefinition = { name: 'list_files', description: '', parameters: {} };
  const adapter: ModelAdapter = {
    sendMessage: async () => ({
      text: '', toolCalls: [{ id: 'tc1', name: 'list_files', arguments: {} }],
      usage: { prompt: 10, completion: 5 }, stopReason: 'tool_call', durationMs: 777,
    }),
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };
  let captured: number | undefined;
  await runAgentLoop({
    ...baseOpts(),
    adapter, tools: [tool], executors: { list_files: async () => ({ content: 'files', isError: false }) },
    onTurnComplete: async (_turn: number, _messages: ChatMessage[], _usage: { prompt?: number }, durationMs?: number) => { captured = durationMs; },
  });
  assert.equal(captured, 777);
});

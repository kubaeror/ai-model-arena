import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter, ModelResponse, ChatMessage, ToolDefinition } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { TASK_COMPLETE_TOOL } from '../../src/tools/schema.js';

function stubAdapter(responses: ModelResponse[]): ModelAdapter {
  let i = 0;
  return {
    sendMessage: async () => {
      const r = responses[i++] ?? { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'no_tool_calls' };
      return r;
    },
    supportsStreaming: () => false,
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
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
    supportsStreaming: () => false,
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

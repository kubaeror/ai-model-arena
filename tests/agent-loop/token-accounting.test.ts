import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter } from '../../src/providers/adapters/base.js';
import type { ModelResponse } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';

function stubAdapter(responses: ModelResponse[]): ModelAdapter {
  let i = 0;
  return {
    sendMessage: async () => responses[i++] ?? { text: '', toolCalls: [], usage: {}, stopReason: 'no_tool_calls' },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
  };
}

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

function stubConv() {
  const entries: any[] = [];
  return { append: (e: any) => entries.push(e), flush: () => {}, entries, setEnded: () => {} } as unknown as ConversationLogger;
}

function stubToolCtx() {
  return { sandboxDir: '/tmp', logger: stubLogger(), shellTimeoutMs: 10000, maxShellOutputBytes: 524288 };
}

test('runAgentLoop accumulates cache read/write tokens and exposes per-call usage', async () => {
  const adapter = stubAdapter([
    {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'list_files', arguments: {} }],
      usage: { prompt: 1000, completion: 10, total: 1010, cacheReadTokens: 700, cacheWriteTokens: 150 },
      stopReason: 'tool_call',
    },
    {
      text: 'done',
      toolCalls: [],
      usage: { prompt: 1200, completion: 20, total: 1220, cacheReadTokens: 900, cacheWriteTokens: 0 },
      stopReason: 'no_tool_calls',
    },
  ]);

  const result = await runAgentLoop({
    adapter,
    tools: [{ name: 'list_files', description: '', parameters: {} }],
    executors: { list_files: async () => ({ content: '[]', isError: false }) },
    systemPrompt: 's',
    task: 't',
    maxTurns: 5,
    toolCtx: stubToolCtx(),
    conv: stubConv(),
    logger: stubLogger(),
  });

  assert.equal(result.tokenUsage.prompt, 2200);
  assert.equal(result.tokenUsage.completion, 30);
  assert.equal(result.tokenUsage.cacheReadTokens, 1600);
  assert.equal(result.tokenUsage.cacheWriteTokens, 150);

  assert.equal(result.usagePerCall.length, 2, 'one entry per model call');
  assert.equal(result.usagePerCall[0]?.cacheReadTokens, 700);
  assert.equal(result.usagePerCall[0]?.cacheWriteTokens, 150);
  assert.equal(result.usagePerCall[1]?.cacheReadTokens, 900);
  assert.equal(result.usagePerCall[1]?.cacheWriteTokens, 0);
});

test('runAgentLoop tags each per-call usage with the serving model for billing', async () => {
  const adapter = stubAdapter([
    {
      text: 'done',
      toolCalls: [],
      usage: { prompt: 100, completion: 5, total: 105 },
      stopReason: 'no_tool_calls',
    },
  ]);

  const result = await runAgentLoop({
    adapter,
    tools: [],
    executors: {},
    systemPrompt: 's',
    task: 't',
    maxTurns: 3,
    toolCtx: stubToolCtx(),
    conv: stubConv(),
    logger: stubLogger(),
    billingModel: 'anthropic/claude-sonnet-4',
  });

  assert.equal(result.usagePerCall.length, 1);
  assert.equal(result.usagePerCall[0]?.model, 'anthropic/claude-sonnet-4');
});

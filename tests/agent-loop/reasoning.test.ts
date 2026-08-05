import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter, SendOpts } from '../../src/providers/adapters/base.js';
import type { ModelResponse } from '../../src/types.js';
import type { ConversationLogger } from '../../src/logger/conversation-logger.js';
import { TASK_COMPLETE_TOOL } from '../../src/tools/schema.js';

function stubAdapter(responses: ModelResponse[]): ModelAdapter & { opts: (SendOpts | undefined)[] } {
  const opts: (SendOpts | undefined)[] = [];
  return {
    sendMessage: async (_messages, _tools, sendOpts) => {
      opts.push(sendOpts);
      const r = responses.shift() ?? { text: '', toolCalls: [], usage: {}, stopReason: 'no_tool_calls' };
      return r;
    },
    supportsReasoning: () => false,
    supportsPromptCaching: () => false,
    opts,
  };
}

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

function stubConv() {
  return { append: () => {}, flush: () => {} } as unknown as ConversationLogger;
}

function stubToolCtx() {
  return { sandboxDir: '/tmp', logger: stubLogger(), shellTimeoutMs: 10000, maxShellOutputBytes: 524288 };
}

test('forwards sendOpts to the adapter on every model call', async () => {
  const adapter = stubAdapter([
    { text: '', toolCalls: [{ id: '1', name: 'list_files', arguments: {} }], usage: { prompt: 10, completion: 5 }, stopReason: 'tool_call' },
    { text: 'done', toolCalls: [], usage: { prompt: 20, completion: 10 }, stopReason: 'no_tool_calls' },
  ]);
  const sendOpts: SendOpts = { reasoning: { type: 'effort', value: 'high' } };
  const result = await runAgentLoop({
    adapter: adapter as ModelAdapter,
    tools: [{ name: 'list_files', description: '', parameters: {} }],
    executors: { list_files: async () => ({ content: 'files', isError: false }) },
    systemPrompt: 's', task: 't', maxTurns: 10,
    toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
    sendOpts,
  });
  assert.equal(result.turnsUsed, 2);
  assert.equal(adapter.opts.length, 2);
  assert.deepEqual(adapter.opts[0], sendOpts);
  assert.deepEqual(adapter.opts[1], sendOpts);
});

test('passes undefined sendOpts to the adapter when none configured', async () => {
  const adapter = stubAdapter([
    { text: 'done', toolCalls: [], usage: { prompt: 10, completion: 5 }, stopReason: 'no_tool_calls' },
  ]);
  await runAgentLoop({
    adapter: adapter as ModelAdapter,
    tools: [{ name: TASK_COMPLETE_TOOL, description: '', parameters: {} }],
    executors: {},
    systemPrompt: 's', task: 't', maxTurns: 10,
    toolCtx: stubToolCtx(), conv: stubConv(), logger: stubLogger(),
  });
  assert.equal(adapter.opts.length, 1);
  assert.equal(adapter.opts[0], undefined);
});

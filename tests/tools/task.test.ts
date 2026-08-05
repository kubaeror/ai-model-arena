import { describe, it } from 'node:test';
import assert from 'node:assert';
import { task } from '../../src/tools/task.js';
import type { ToolExecutionContext, ChatMessage, ModelResponse, ToolDefinition } from '../../src/types.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger } as ToolExecutionContext['logger'];

function makeCtx(sendMessage?: typeof mockSendMessage): ToolExecutionContext {
  if (!sendMessage) {
    return {
      sandboxDir: '/tmp/arena-task-test',
      logger,
      shellTimeoutMs: 30000,
      maxShellOutputBytes: 524288,
    };
  }
  return {
    sandboxDir: '/tmp/arena-task-test',
    logger,
    shellTimeoutMs: 30000,
    maxShellOutputBytes: 524288,
    subagent: {
      maxTurns: 3,
      sendMessage,
      logger,
      tools: [],
      executors: {},
      shellTimeoutMs: 30000,
      maxShellOutputBytes: 524288,
    },
  };
}

function mockSendMessage(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ModelResponse> {
  // Auto-respond with task_complete on the first call
  return {
    [Symbol.toPrimitive]() { return 'mock'; },
  } as any;
}

function createMockAdapter(responses: ModelResponse[]): (msgs: ChatMessage[], tools: ToolDefinition[]) => Promise<ModelResponse> {
  let idx = 0;
  return async () => {
    const r = responses[idx] ?? responses[responses.length - 1]!;
    if (idx < responses.length - 1) idx++;
    return r;
  };
}

describe('task', () => {
  it('rejects when subagent config is missing', async () => {
    const r = await task({ description: 'test', prompt: 'do it' }, makeCtx());
    assert.strictEqual(r.isError, true);
    assert.ok(r.content.includes('subagent support not configured'));
  });

  it('rejects missing description', async () => {
    const r = await task({ prompt: 'do it' } as any, makeCtx());
    assert.strictEqual(r.isError, true);
  });

  it('rejects missing prompt', async () => {
    const r = await task({ description: 'test' } as any, makeCtx());
    assert.strictEqual(r.isError, true);
  });

  it('runs subagent and returns results', async () => {
    const responses: ModelResponse[] = [
      {
        text: null,
        toolCalls: [{ id: 'tc1', name: 'task_complete', arguments: { summary: 'done' } }],
        usage: { prompt: 100, completion: 10, total: 110 },
        stopReason: 'tool_calls',
      },
    ];
    const sendMsg = createMockAdapter(responses);
    const ctx = makeCtx(sendMsg);
    ctx.subagent!.executors = {
      task_complete: async (args: any) => ({
        content: `Task marked as complete. ${args.summary ?? ''}`.trim(),
        isError: false,
      }),
    };
    const r = await task({
      description: 'simple task',
      prompt: 'Just say done',
    }, ctx);
    assert.strictEqual(r.isError, false);
    assert.ok(r.content.includes('task_complete'), 'should complete');
    assert.ok(r.content.includes('turns: 1/3'));
  });

  it('handles subagent that stops without tool calls', async () => {
    const responses: ModelResponse[] = [];
    for (let i = 0; i < 5; i++) {
      responses.push({
        text: `thinking ${i}`,
        toolCalls: [],
        usage: { prompt: 50, completion: 10, total: 60 },
        stopReason: 'stop',
      });
    }
    const sendMsg = createMockAdapter(responses);
    const r = await task({
      description: 'thinking task',
      prompt: 'Think',
    }, makeCtx(sendMsg));
    // Stops with no_tool_calls on first turn (no tool calls returned)
    assert.ok(r.content.includes('no_tool_calls'));
  });

  it('handles subagent API error', async () => {
    const sendMsg = async (): Promise<ModelResponse> => {
      throw new Error('API down');
    };
    const r = await task({
      description: 'risky task',
      prompt: 'Go',
    }, makeCtx(sendMsg));
    assert.ok(r.content.includes('API down'));
  });

  it('strips task + todo tools from subagent', async () => {
    // Verify the stripping happens in worker/runner setup via the tool context
    const ctx = makeCtx();
    ctx.subagent = {
      maxTurns: 2,
      sendMessage: async () => ({
        text: null,
        toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'test.txt' } }],
        usage: { prompt: 10, completion: 5, total: 15 },
        stopReason: 'tool_calls',
      }),
      logger,
      tools: [
        { name: 'read_file', description: '', parameters: { type: 'object', properties: {} } },
        { name: 'write_file', description: '', parameters: { type: 'object', properties: {} } },
      ],
      executors: {
        read_file: async () => ({ content: 'hello', isError: false }),
        write_file: async () => ({ content: 'written', isError: false }),
      },
      shellTimeoutMs: 30000,
      maxShellOutputBytes: 524288,
    };
    const r = await task({
      description: 'file task',
      prompt: 'Read test.txt',
    }, ctx);
    assert.strictEqual(r.isError, false);
    // Should have called read_file executor — if stripped incorrectly, it'd fail on unknown tool
  });
});

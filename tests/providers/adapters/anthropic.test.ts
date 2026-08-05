import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../../../src/providers/adapters/anthropic.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';
import type { FetchInput } from '../../helpers/fetch-types.js';

const anthropicDescriptor: ProviderDescriptor = {
  id: 'anthropic', name: 'Anthropic', apiBase: 'https://api.anthropic.com',
  authScheme: 'x-api-key', envVar: 'ANTHROPIC_API_KEY', adapter: 'anthropic', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('AnthropicAdapter.sendMessage parses text response', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({
      id: 'msg_1', role: 'assistant',
      content: [{ type: 'text', text: 'Hello there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello there');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.sendMessage parses tool_use blocks', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading file' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.text, 'Reading file');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.id, 'toolu_1');
    assert.equal(result.toolCalls[0]!.name, 'read_file');
    assert.deepEqual(result.toolCalls[0]!.arguments, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_use');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.sendMessage extracts cache tokens', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.usage.cacheReadTokens, 800);
    assert.equal(result.usage.cacheWriteTokens, 150);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.supportsReasoning returns true', () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-7-sonnet-20250219', { apiKey: 'sk-ant' });
  assert.equal(adapter.supportsReasoning(), true);
  assert.equal(adapter.supportsPromptCaching(), true);
});

test('AnthropicAdapter.sendMessage maps system/assistant-tool/tool messages and options into the request body', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'read a.ts' },
      { role: 'assistant', content: 'Reading...', toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'tc1', content: 'contents of a.ts' },
    ], [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }], {
      temperature: 0.3, maxTokens: 500, reasoning: { type: 'budget_tokens', value: 2048 },
    });

    assert.equal(capturedBody.model, 'claude-3-5-sonnet-20241022');
    assert.equal(capturedBody.max_tokens, 500);
    assert.equal(capturedBody.temperature, 0.3);
    assert.equal(capturedBody.system, 'You are a test agent.', 'system hoisted out of messages');
    assert.deepEqual(capturedBody.thinking, { type: 'enabled', budget_tokens: 2048 });
    const messages = capturedBody.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 3, 'system excluded, tool role becomes user');
    const parts0 = messages[0]!.content as Array<Record<string, unknown>>;
    assert.deepEqual(parts0[0], { type: 'text', text: 'read a.ts', cache_control: { type: 'ephemeral' } }, 'cache breakpoint on stable prefix');
    const parts1 = messages[1]!.content as Array<Record<string, unknown>>;
    assert.deepEqual(parts1[0], { type: 'text', text: 'Reading...' });
    assert.deepEqual(parts1[1], { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'a.ts' } });
    assert.equal(messages[2]!.role, 'user');
    assert.deepEqual(messages[2]!.content, [{ type: 'tool_result', tool_use_id: 'tc1', content: 'contents of a.ts' }]);
    assert.deepEqual(capturedBody.tools, [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } }]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter defaults thinking budget when reasoning value is not a number', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-7-sonnet-20250219', { apiKey: 'sk-ant' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], [], { reasoning: { type: 'budget_tokens' } });
    assert.deepEqual(capturedBody.thinking, { type: 'enabled', budget_tokens: 4096 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter surfaces HttpError on non-OK responses', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return mockResponse({ error: 'overloaded' }, 500);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => adapter.sendMessage([{ role: 'user', content: 'hi' }], []),
      (err: Error) => err.name === 'HttpError' && err.message.includes('500'),
    );
    assert.ok(calls >= 3, `expected retries, got ${calls} calls`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

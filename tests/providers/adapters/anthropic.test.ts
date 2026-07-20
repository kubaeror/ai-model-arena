import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../../../src/providers/adapters/anthropic.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';
import type { ChatMessage } from '../../../src/types.js';

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
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    assert.equal(result.toolCalls[0].id, 'toolu_1');
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
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
  assert.equal(adapter.supportsStreaming(), true);
});

test('AnthropicAdapter.buildCacheBreakpoints preserves message count', () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-7-sonnet-20250219', { apiKey: 'sk-ant' });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
  const result = adapter.buildCacheBreakpoints!(messages);
  assert.equal(result.length, messages.length);
});

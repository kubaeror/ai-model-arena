import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '../../../src/providers/adapters/openai-compat.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';

const openaiDescriptor: ProviderDescriptor = {
  id: 'openai', name: 'OpenAI', apiBase: 'https://api.openai.com/v1',
  authScheme: 'bearer', envVar: 'OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('OpenAICompatAdapter.sendMessage parses chat completion response', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({
      choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(result.stopReason, 'stop');
    assert.equal(capturedHeaders['authorization'], 'Bearer sk-test');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage parses tool_calls', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.text, null);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_calls');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage extracts cached_tokens from prompt_tokens_details', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005,
      prompt_tokens_details: { cached_tokens: 700 },
    },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.usage.cacheReadTokens, 700);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.supportsStreaming returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsStreaming(), true);
});

test('OpenAICompatAdapter.supportsPromptCaching returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsPromptCaching(), true);
});

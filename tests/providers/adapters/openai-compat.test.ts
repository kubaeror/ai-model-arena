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

test('OpenAICompatAdapter.supportsStreaming returns false without a stream implementation', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsStreaming(), false);
});

test('OpenAICompatAdapter.supportsPromptCaching returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsPromptCaching(), true);
});

test('OpenAICompatAdapter tolerates non-JSON tool call arguments', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: 'not json {' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {},
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'x' }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(result.toolCalls[0].arguments, {});
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter x-api-key scheme sends the key even without headerName', async () => {
  const desc: ProviderDescriptor = {
    id: 'custom', name: 'Custom', apiBase: 'https://custom.example/v1',
    authScheme: 'x-api-key', envVar: 'CUSTOM_KEY', adapter: 'openai-compat', isBuiltin: false,
  };
  const adapter = new OpenAICompatAdapter(desc, 'model-1', { apiKey: 'secret-key' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(capturedHeaders['x-api-key'], 'secret-key');
    assert.ok(!capturedHeaders['authorization']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter refuses unconfigured placeholder base URLs', () => {
  const desc: ProviderDescriptor = {
    id: 'azure-openai', name: 'Azure OpenAI', apiBase: 'https://{resource}.openai.azure.com/openai/v1',
    authScheme: 'x-api-key', envVar: 'AZURE_KEY', adapter: 'openai-compat', isBuiltin: true,
  };
  assert.throws(
    () => new OpenAICompatAdapter(desc, 'gpt-4o', { apiKey: 'k' }),
    /unconfigured baseUrl/,
  );
});

test('OpenAICompatAdapter retries 429 and 5xx, surfaces HttpError after retries', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let calls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return mockResponse({ error: 'rate limited' }, 429);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => adapter.sendMessage([{ role: 'user', content: 'hi' }], []),
      (err: Error) => err.name === 'HttpError',
    );
    // 3 attempts: initial + 2 retries.
    assert.ok(calls >= 3, `expected retries, got ${calls} calls`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

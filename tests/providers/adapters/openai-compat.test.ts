import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '../../../src/providers/adapters/openai-compat.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';
import type { FetchInput } from '../../helpers/fetch-types.js';

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
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
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
    assert.equal(result.toolCalls[0]!.id, 'call_1');
    assert.equal(result.toolCalls[0]!.name, 'read_file');
    assert.deepEqual(result.toolCalls[0]!.arguments, { path: 'a.ts' });
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

test('OpenAICompatAdapter.sendMessage maps reasoning effort into reasoning_effort', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], [], { reasoning: { type: 'effort', value: 'high' } });
    assert.equal(capturedBody.reasoning_effort, 'high');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage ignores non-effort reasoning options', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], [], { reasoning: { type: 'budget_tokens', value: 4096 } });
    assert.ok(!('reasoning_effort' in capturedBody), 'budget_tokens must not leak into reasoning_effort');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage leaves body unchanged when reasoning is absent', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.deepEqual(capturedBody, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.supportsPromptCaching returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsPromptCaching(), true);
});

test('OpenAICompatAdapter.sendMessage attaches durationMs to the response', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs! >= 0);
  } finally {
    globalThis.fetch = origFetch;
  }
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
    assert.deepEqual(result.toolCalls[0]!.arguments, {});
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
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
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
    /unreplaced placeholder/,
  );
});

test('OpenAICompatAdapter serializes tools and tool-call messages into the body', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedBody: Record<string, unknown> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([
      { role: 'assistant', content: null, toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', toolCallId: 'tc1', name: 'read_file', content: 'contents' },
    ], [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }]);
    assert.deepEqual(capturedBody.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } }]);
    assert.deepEqual(capturedBody.messages, [
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: 'contents', tool_call_id: 'tc1', name: 'read_file' },
    ]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter returns an empty response for empty choices', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({ choices: [] }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, null);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.stopReason, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter custom headerName sends the key for non-bearer schemes', async () => {
  const desc: ProviderDescriptor = {
    id: 'custom2', name: 'Custom2', apiBase: 'https://custom.example/v1',
    authScheme: 'none', headerName: 'x-custom-key', envVar: 'CUSTOM2_KEY', adapter: 'openai-compat', isBuiltin: false,
  };
  const adapter = new OpenAICompatAdapter(desc, 'model-2', { apiKey: 'secret-2' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: FetchInput, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(capturedHeaders['x-custom-key'], 'secret-2');
  } finally {
    globalThis.fetch = origFetch;
  }
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

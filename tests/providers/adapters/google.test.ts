import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAdapter } from '../../../src/providers/adapters/google.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';

const googleDescriptor: ProviderDescriptor = {
  id: 'google', name: 'Google AI Studio', apiBase: 'https://generativelanguage.googleapis.com',
  authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('GoogleAdapter.sendMessage parses generateContent response', async () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  let capturedUrl = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return mockResponse({
      candidates: [{ content: { parts: [{ text: 'Hello Gemini' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 3 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello Gemini');
    assert.equal(result.stopReason, 'STOP');
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(result.usage.cacheReadTokens, 3);
    assert.ok(capturedUrl.includes('key=AIza-test'));
    assert.ok(capturedUrl.includes('gemini-1.5-pro'));
    assert.ok(capturedUrl.includes('generateContent'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GoogleAdapter.sendMessage parses functionCall', async () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    candidates: [{
      content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GoogleAdapter.supportsStreaming returns true', () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  assert.equal(adapter.supportsStreaming(), true);
  assert.equal(adapter.supportsPromptCaching(), true);
});

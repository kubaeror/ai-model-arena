import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeProvider } from '../../src/providers/capability-probe.js';
import type { ProviderDescriptor } from '../../src/providers/types.js';

const API_BASE = 'https://provider.example.com';

function descriptor(adapter: ProviderDescriptor['adapter'], apiBase?: string): ProviderDescriptor {
  return {
    id: 'test-provider', name: 'Test Provider', apiBase,
    authScheme: 'bearer', adapter, isBuiltin: false,
  };
}

function mockResponse(status = 200, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface CapturedRequest { url: string; method: string; headers: Record<string, string>; body?: unknown }

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): { restore: () => void; last: () => CapturedRequest } {
  const origFetch = globalThis.fetch;
  let lastRequest: CapturedRequest = { url: '', method: '', headers: {} };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawHeaders = (init?.headers as Record<string, string> | undefined) ?? {};
    // Real fetch lowercases header names; mirror that so lookups are case-insensitive.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    lastRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    };
    return handler(String(input), init);
  }) as typeof fetch;
  return {
    restore: () => { globalThis.fetch = origFetch; },
    last: () => lastRequest,
  };
}

test('openai-compat: GET {apiBase}/models with bearer auth, true on 200', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200, { data: [{ id: 'gpt-4o' }] }));
  try {
    const result = await probeProvider(descriptor('openai-compat', API_BASE), { apiKey: 'sk-test' });
    assert.equal(result.reachable, true);
    assert.equal(fetchMock.last().method, 'GET');
    assert.equal(fetchMock.last().url, `${API_BASE}/models`);
    assert.equal(fetchMock.last().headers['authorization'], 'Bearer sk-test');
  } finally {
    fetchMock.restore();
  }
});

test('openai-compat: false on 500', async () => {
  const fetchMock = mockFetch(async () => mockResponse(500, { error: 'boom' }));
  try {
    const result = await probeProvider(descriptor('openai-compat', API_BASE), { apiKey: 'sk-test' });
    assert.equal(result.reachable, false);
    assert.ok(result.error, 'error message should be present');
  } finally {
    fetchMock.restore();
  }
});

test('openai-compat: false on network error', async () => {
  const fetchMock = mockFetch(async () => { throw new Error('fetch failed'); });
  try {
    const result = await probeProvider(descriptor('openai-compat', API_BASE), { apiKey: 'sk-test' });
    assert.equal(result.reachable, false);
    assert.ok(result.error?.includes('fetch failed'));
  } finally {
    fetchMock.restore();
  }
});

test('openai-compat: 204 (no body) counts as reachable', async () => {
  const fetchMock = mockFetch(async () => mockResponse(204));
  try {
    const result = await probeProvider(descriptor('openai-compat', API_BASE), { apiKey: 'sk-test' });
    assert.equal(result.reachable, true);
  } finally {
    fetchMock.restore();
  }
});

test('anthropic: POST count_tokens with 1-token message, true on 200', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200, { input_tokens: 1 }));
  try {
    const result = await probeProvider(descriptor('anthropic', API_BASE), { apiKey: 'sk-ant-test' });
    assert.equal(result.reachable, true);
    const last = fetchMock.last();
    assert.equal(last.method, 'POST');
    assert.equal(last.url, `${API_BASE}/v1/messages/count_tokens`);
    assert.equal(last.headers['x-api-key'], 'sk-ant-test');
    assert.equal(last.headers['anthropic-version'], '2023-06-01');
    assert.equal(last.body?.model, 'claude-sonnet-4');
    assert.deepEqual(last.body?.messages, [{ role: 'user', content: 'hi' }]);
  } finally {
    fetchMock.restore();
  }
});

test('anthropic: honors explicit model via opts', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200, { input_tokens: 1 }));
  try {
    await probeProvider(descriptor('anthropic', API_BASE), { apiKey: 'sk-ant-test', model: 'claude-3-5-sonnet' });
    assert.equal(fetchMock.last().body?.model, 'claude-3-5-sonnet');
  } finally {
    fetchMock.restore();
  }
});

test('anthropic: false on 500', async () => {
  const fetchMock = mockFetch(async () => mockResponse(500));
  try {
    const result = await probeProvider(descriptor('anthropic', API_BASE), { apiKey: 'sk-ant-test' });
    assert.equal(result.reachable, false);
  } finally {
    fetchMock.restore();
  }
});

test('anthropic: false on network error', async () => {
  const fetchMock = mockFetch(async () => { throw new Error('fetch failed'); });
  try {
    const result = await probeProvider(descriptor('anthropic', API_BASE), { apiKey: 'sk-ant-test' });
    assert.equal(result.reachable, false);
  } finally {
    fetchMock.restore();
  }
});

test('google: GET {apiBase}/v1beta/models with x-goog-api-key, true on 200', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }] }));
  try {
    const result = await probeProvider(descriptor('google', API_BASE), { apiKey: 'AIza-test' });
    assert.equal(result.reachable, true);
    const last = fetchMock.last();
    assert.equal(last.method, 'GET');
    assert.equal(last.url, `${API_BASE}/v1beta/models`);
    assert.equal(last.headers['x-goog-api-key'], 'AIza-test');
  } finally {
    fetchMock.restore();
  }
});

test('google: false on 500', async () => {
  const fetchMock = mockFetch(async () => mockResponse(500));
  try {
    const result = await probeProvider(descriptor('google', API_BASE), { apiKey: 'AIza-test' });
    assert.equal(result.reachable, false);
  } finally {
    fetchMock.restore();
  }
});

test('google: false on network error', async () => {
  const fetchMock = mockFetch(async () => { throw new Error('fetch failed'); });
  try {
    const result = await probeProvider(descriptor('google', API_BASE), { apiKey: 'AIza-test' });
    assert.equal(result.reachable, false);
  } finally {
    fetchMock.restore();
  }
});

test('bedrock gateway: GET {gateway}/health with bearer, true on 200', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200, { status: 'ok' }));
  try {
    const result = await probeProvider(descriptor('bedrock', API_BASE), { apiKey: 'gw-test' });
    assert.equal(result.reachable, true);
    const last = fetchMock.last();
    assert.equal(last.method, 'GET');
    assert.equal(last.url, `${API_BASE}/health`);
    assert.equal(last.headers['authorization'], 'Bearer gw-test');
  } finally {
    fetchMock.restore();
  }
});

test('bedrock gateway: false on 500', async () => {
  const fetchMock = mockFetch(async () => mockResponse(500));
  try {
    const result = await probeProvider(descriptor('bedrock', API_BASE), { apiKey: 'gw-test' });
    assert.equal(result.reachable, false);
  } finally {
    fetchMock.restore();
  }
});

test('bedrock native (no gateway): reachable without any network call', async () => {
  const savedUrl = process.env.AWS_BEDROCK_GATEWAY_URL;
  const savedKey = process.env.AWS_BEDROCK_GATEWAY_KEY;
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
  delete process.env.AWS_BEDROCK_GATEWAY_KEY;
  let fetchCalled = false;
  const fetchMock = mockFetch(async () => { fetchCalled = true; return mockResponse(200); });
  try {
    const result = await probeProvider(descriptor('bedrock'));
    assert.equal(result.reachable, true);
    assert.equal(fetchCalled, false);
  } finally {
    if (savedUrl !== undefined) process.env.AWS_BEDROCK_GATEWAY_URL = savedUrl;
    if (savedKey !== undefined) process.env.AWS_BEDROCK_GATEWAY_KEY = savedKey;
    fetchMock.restore();
  }
});

test('unknown adapter kind: falls back to GET /models', async () => {
  const fetchMock = mockFetch(async () => mockResponse(200));
  try {
    const weird = { ...descriptor('openai-compat', API_BASE), adapter: 'mystery' } as unknown as ProviderDescriptor;
    const result = await probeProvider(weird, { apiKey: 'sk-test' });
    assert.equal(result.reachable, true);
    assert.equal(fetchMock.last().method, 'GET');
    assert.equal(fetchMock.last().url, `${API_BASE}/models`);
  } finally {
    fetchMock.restore();
  }
});

test('missing apiBase (non-bedrock): unreachable with error', async () => {
  const result = await probeProvider(descriptor('openai-compat'));
  assert.equal(result.reachable, false);
  assert.ok(result.error);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../../src/providers/adapters/base.js';
import { BedrockAdapter } from '../../src/providers/adapters/bedrock.js';
import type { ProviderDescriptor } from '../../src/providers/types.js';

const bedrockDescriptor: ProviderDescriptor = {
  id: 'amazon-bedrock', name: 'Amazon Bedrock', authScheme: 'bedrock',
  adapter: 'bedrock', isBuiltin: true,
};

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

test('BedrockAdapter constructs in native SigV4 mode without gateway', () => {
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
  delete process.env.AWS_BEDROCK_GATEWAY_KEY;
  process.env.AWS_BEDROCK_REGION = 'us-east-1';
  const adapter = new BedrockAdapter(bedrockDescriptor, 'anthropic.claude-3-sonnet-20240229-v1:0', { logger: stubLogger() });
  assert.ok(adapter);
  assert.equal(adapter.supportsReasoning(), false);
  assert.equal(adapter.supportsPromptCaching(), false);
  delete process.env.AWS_BEDROCK_REGION;
});

test('BedrockAdapter merges every system message and forwards inference options', async () => {
  process.env.AWS_BEDROCK_REGION = 'us-east-1';
  const adapter = new BedrockAdapter(bedrockDescriptor, 'anthropic.claude-3-sonnet-20240229-v1:0', { logger: stubLogger() });

  let capturedInput: Record<string, unknown> = {};
  const fakeClient = {
    send: async (command: { input?: Record<string, unknown> }) => {
      capturedInput = command.input ?? {};
      return {
        output: { message: { role: 'assistant', content: [{ text: 'done' }] } },
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
        stopReason: 'end_turn',
      };
    },
  };

  // Load the SDK (so ConverseCommand exists) and replace the fresh client with
  // a stub before any network call happens.
  const probe = adapter as unknown as { getClient(): Promise<unknown>; client: unknown; clientCreatedAt: number };
  await probe.getClient();
  probe.client = fakeClient;
  probe.clientCreatedAt = Date.now();

  try {
    const result = await adapter.sendMessage([
      { role: 'system', content: 'You are first.' },
      { role: 'system', content: 'You are second.' },
      { role: 'user', content: 'hello' },
    ], [], { temperature: 0.4, maxTokens: 512 });

    assert.deepEqual(capturedInput.system, [{ text: 'You are first.\n\nYou are second.' }]);
    assert.deepEqual(capturedInput.inferenceConfig, { temperature: 0.4, maxTokens: 512 });
    assert.deepEqual(capturedInput.messages, [{ role: 'user', content: [{ text: 'hello' }] }]);
    assert.equal(result.text, 'done');
    assert.equal(result.usage.prompt, 7);
    assert.equal(result.usage.completion, 3);
  } finally {
    delete process.env.AWS_BEDROCK_REGION;
  }
});

test('BedrockAdapter maps prompt-cache usage into the canonical token shape', async () => {
  process.env.AWS_BEDROCK_REGION = 'us-east-1';
  const adapter = new BedrockAdapter(bedrockDescriptor, 'anthropic.claude-3-sonnet-20240229-v1:0', { logger: stubLogger() });

  const fakeClient = {
    send: async () => ({
      output: { message: { role: 'assistant', content: [{ text: 'cached' }] } },
      // Converse reports UNcached input separately: total input =
      // inputTokens + cacheReadInputTokens + cacheWriteInputTokens.
      usage: {
        inputTokens: 46, outputTokens: 17, totalTokens: 1474,
        cacheReadInputTokens: 1000, cacheWriteInputTokens: 411,
      },
      stopReason: 'end_turn',
    }),
  };

  const probe = adapter as unknown as { getClient(): Promise<unknown>; client: unknown; clientCreatedAt: number };
  await probe.getClient();
  probe.client = fakeClient;
  probe.clientCreatedAt = Date.now();

  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hello' }], []);
    assert.equal(result.usage.prompt, 1457, 'prompt is the total input including cached tokens');
    assert.equal(result.usage.completion, 17);
    assert.equal(result.usage.total, 1474);
    assert.equal(result.usage.cacheReadTokens, 1000);
    assert.equal(result.usage.cacheWriteTokens, 411);
  } finally {
    delete process.env.AWS_BEDROCK_REGION;
  }
});

test('BedrockAdapter throws in gateway mode without key', () => {
  process.env.AWS_BEDROCK_GATEWAY_URL = 'https://gateway.example.com';
  delete process.env.AWS_BEDROCK_GATEWAY_KEY;
  assert.throws(
    () => new BedrockAdapter(bedrockDescriptor, 'claude-3', { logger: stubLogger() }),
    /AWS_BEDROCK_GATEWAY_KEY/,
  );
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
});

test('BedrockAdapter constructs in gateway mode with URL and key', () => {
  process.env.AWS_BEDROCK_REGION = 'eu-west-1';
  process.env.AWS_BEDROCK_GATEWAY_URL = 'https://gateway.example.com';
  process.env.AWS_BEDROCK_GATEWAY_KEY = 'test-key';
  const adapter = new BedrockAdapter(bedrockDescriptor, 'claude-3', { logger: stubLogger() });
  assert.ok(adapter);
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
  delete process.env.AWS_BEDROCK_GATEWAY_KEY;
  delete process.env.AWS_BEDROCK_REGION;
});

test('BedrockAdapter constructs with opts.baseUrl and apiKey', () => {
  const adapter = new BedrockAdapter(bedrockDescriptor, 'claude-3', {
    logger: stubLogger(),
    baseUrl: 'https://custom.example.com',
    apiKey: 'custom-key',
  });
  assert.ok(adapter);
});

test('BedrockAdapter gateway mode tolerates malformed tool call arguments JSON', async () => {
  const adapter = new BedrockAdapter(bedrockDescriptor, 'claude-3', {
    logger: stubLogger(),
    baseUrl: 'https://gateway.example.com',
    apiKey: 'test-key',
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{broken' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: {},
    }),
    text: async () => '',
  } as Response)) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'x' }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(result.toolCalls[0]!.arguments, {});
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('HttpError preserves status and message', () => {
  const err = new HttpError(429, 'rate limited', 'Too many requests');
  assert.equal(err.status, 429);
  assert.equal(err.body, 'rate limited');
  assert.equal(err.message, 'Too many requests');
});

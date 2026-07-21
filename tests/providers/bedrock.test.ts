import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseAdapter, HttpError } from '../../src/providers/adapters/base.js';
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
  const adapter = new BedrockAdapter(bedrockDescriptor, 'anthropic.claude-3-sonnet-20240229-v1:0', { logger: stubLogger() });
  assert.ok(adapter);
  assert.equal(adapter.supportsStreaming(), true);
  assert.equal(adapter.supportsReasoning(), false);
  assert.equal(adapter.supportsPromptCaching(), false);
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
  process.env.AWS_BEDROCK_GATEWAY_URL = 'https://gateway.example.com';
  process.env.AWS_BEDROCK_GATEWAY_KEY = 'test-key';
  const adapter = new BedrockAdapter(bedrockDescriptor, 'claude-3', { logger: stubLogger() });
  assert.ok(adapter);
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
  delete process.env.AWS_BEDROCK_GATEWAY_KEY;
});

test('BedrockAdapter constructs with opts.baseUrl and apiKey', () => {
  const adapter = new BedrockAdapter(bedrockDescriptor, 'claude-3', {
    logger: stubLogger(),
    baseUrl: 'https://custom.example.com',
    apiKey: 'custom-key',
  });
  assert.ok(adapter);
});

test('HttpError preserves status and message', () => {
  const err = new HttpError(429, 'rate limited', 'Too many requests');
  assert.equal(err.status, 429);
  assert.equal(err.body, 'rate limited');
  assert.equal(err.message, 'Too many requests');
});

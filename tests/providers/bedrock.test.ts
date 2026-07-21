import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseAdapter, HttpError } from '../../src/providers/adapters/base.js';
import { BedrockAdapter } from '../../src/providers/adapters/bedrock.js';
import type { ProviderDescriptor } from '../../src/providers/types.js';

function stubLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => stubLogger() } as any;
}

test('BedrockAdapter throws without gateway URL', () => {
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
  const descriptor: ProviderDescriptor = { id: 'bedrock', name: 'AWS Bedrock', env: ['AWS_BEDROCK_GATEWAY_URL'] };
  assert.throws(
    () => new BedrockAdapter(descriptor, 'claude-3', { logger: stubLogger() }),
    /AWS_BEDROCK_GATEWAY_URL/,
  );
});

test('BedrockAdapter constructs with env-provided gateway URL', () => {
  process.env.AWS_BEDROCK_GATEWAY_URL = 'https://gateway.example.com';
  const descriptor: ProviderDescriptor = { id: 'bedrock', name: 'AWS Bedrock', env: ['AWS_BEDROCK_GATEWAY_URL'] };
  const adapter = new BedrockAdapter(descriptor, 'claude-3', { logger: stubLogger() });
  assert.ok(adapter);
  assert.equal(adapter.supportsStreaming(), true);
  assert.equal(adapter.supportsReasoning(), false);
  assert.equal(adapter.supportsPromptCaching(), false);
  delete process.env.AWS_BEDROCK_GATEWAY_URL;
});

test('BedrockAdapter constructs with opts.baseUrl', () => {
  const descriptor: ProviderDescriptor = { id: 'bedrock', name: 'AWS Bedrock', env: ['AWS_BEDROCK_GATEWAY_URL'] };
  const adapter = new BedrockAdapter(descriptor, 'claude-3', {
    logger: stubLogger(),
    baseUrl: 'https://custom.example.com',
  });
  assert.ok(adapter);
});

test('HttpError preserves status and message', () => {
  const err = new HttpError(429, 'rate limited', 'Too many requests');
  assert.equal(err.status, 429);
  assert.equal(err.body, 'rate limited');
  assert.equal(err.message, 'Too many requests');
});

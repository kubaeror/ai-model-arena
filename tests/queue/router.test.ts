import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamKey, dlqStreamKey } from '../../src/queue/router.js';

test('streamKey routes openai to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'openai'), 'arena:tasks:openai-compat');
});

test('streamKey routes groq to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'groq'), 'arena:tasks:openai-compat');
});

test('streamKey routes cerebras to openai-compat family', () => {
  assert.equal(streamKey('arena:tasks', 'cerebras'), 'arena:tasks:openai-compat');
});

test('streamKey routes anthropic as-is (no remapped family)', () => {
  assert.equal(streamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic');
});

test('streamKey routes google as-is', () => {
  assert.equal(streamKey('arena:tasks', 'google'), 'arena:tasks:google');
});

test('streamKey falls through for unknown provider', () => {
  assert.equal(streamKey('prefix', 'unknown-provider'), 'prefix:unknown-provider');
});

test('dlqStreamKey suffixes with :dlq', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'openai'), 'arena:tasks:openai-compat:dlq');
});

test('dlqStreamKey for anthropic', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic:dlq');
});

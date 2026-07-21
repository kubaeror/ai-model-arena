import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamForProvider, dlqStreamForProvider } from '../../src/queue/router.js';

test('streamForProvider prefixes with default', () => {
  assert.equal(streamForProvider('openai'), 'arena:tasks:openai');
});

test('streamForProvider uses custom prefix', () => {
  assert.equal(streamForProvider('anthropic', 'custom'), 'custom:anthropic');
});

test('dlqStreamForProvider suffixes with dlq', () => {
  assert.equal(dlqStreamForProvider('openai'), 'arena:tasks:openai:dlq');
});

test('dlqStreamForProvider uses custom prefix', () => {
  assert.equal(dlqStreamForProvider('google', 'dead'), 'dead:google:dlq');
});

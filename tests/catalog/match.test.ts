import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, matchModelToCanonical } from '../../src/catalog/match.js';

test('normalizeModelId produces provider/model-id form', () => {
  assert.equal(normalizeModelId('claude-3-7-sonnet-20250219', 'anthropic'), 'anthropic/claude-3-7-sonnet-20250219');
  assert.equal(normalizeModelId('gpt-4o', 'openai'), 'openai/gpt-4o');
});

test('matchModelToCanonical finds existing canonical id by provider+model', () => {
  const catalog = [
    { id: 'anthropic/claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic' },
    { id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai' },
  ];
  assert.equal(matchModelToCanonical('claude-3-7-sonnet-20250219', 'anthropic', catalog), 'anthropic/claude-3-7-sonnet-20250219');
  assert.equal(matchModelToCanonical('gpt-4o', 'openai', catalog), 'openai/gpt-4o');
});

test('matchModelToCanonical fuzzy-matches by name when exact id missing', () => {
  const catalog = [
    { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic' },
  ];
  // modelbench returns "Claude 3.7 Sonnet" as name
  assert.equal(matchModelToCanonical(undefined, 'anthropic', catalog, 'Claude 3.7 Sonnet'), 'anthropic/claude-3.7-sonnet');
});

test('matchModelToCanonical returns null when no match', () => {
  const catalog = [{ id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai' }];
  assert.equal(matchModelToCanonical('unknown-model', 'mistral', catalog), null);
});

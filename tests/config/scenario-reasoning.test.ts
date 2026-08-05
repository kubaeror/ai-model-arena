import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioConfigSchema, toSendOptsReasoning } from '../../src/config.js';

test('ScenarioConfigSchema parses a reasoning block', () => {
  const scenario = ScenarioConfigSchema.parse({
    name: 'reasoning-test',
    systemPrompt: 'test prompt',
    task: 'test task',
    reasoning: { effort: 'high' },
  });
  assert.deepEqual(scenario.reasoning, { effort: 'high' });
});

test('ScenarioConfigSchema rejects unknown reasoning efforts', () => {
  assert.throws(() => ScenarioConfigSchema.parse({
    name: 'reasoning-test',
    systemPrompt: 'test prompt',
    task: 'test task',
    reasoning: { effort: 'ultra' },
  }));
});

test('toSendOptsReasoning: effort maps to effort-type union member', () => {
  assert.deepEqual(toSendOptsReasoning({ effort: 'high' }), { type: 'effort', value: 'high' });
  assert.deepEqual(toSendOptsReasoning({ effort: 'medium' }), { type: 'effort', value: 'medium' });
  assert.deepEqual(toSendOptsReasoning({ effort: 'low' }), { type: 'effort', value: 'low' });
});

test('toSendOptsReasoning: budget_tokens maps to budget_tokens-type union member', () => {
  assert.deepEqual(toSendOptsReasoning({ budget_tokens: 4096 }), { type: 'budget_tokens', value: 4096 });
});

test('toSendOptsReasoning: toggle is presence-based per adapter semantics', () => {
  assert.deepEqual(toSendOptsReasoning({ toggle: true }), { type: 'toggle', value: undefined });
});

test('toSendOptsReasoning: precedence is effort > budget_tokens > toggle', () => {
  assert.deepEqual(toSendOptsReasoning({ effort: 'low', budget_tokens: 4096, toggle: true }), { type: 'effort', value: 'low' });
  assert.deepEqual(toSendOptsReasoning({ budget_tokens: 4096, toggle: true }), { type: 'budget_tokens', value: 4096 });
});

test('toSendOptsReasoning: returns undefined when absent or empty', () => {
  assert.equal(toSendOptsReasoning(undefined), undefined);
  assert.equal(toSendOptsReasoning({}), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DispatchEventType } from '../../src/notifications/types.js';
import { formatSlackPayload } from '../../src/notifications/slack.js';
import { formatDiscordPayload } from '../../src/notifications/discord.js';
import { normalizeEvent, regressionSummary } from '../../src/notifications/format.js';

type SlackField = { title: string; value: string; short?: boolean };

function slackFields(payload: object): SlackField[] {
  const attachments = (payload as { attachments?: Array<{ fields?: SlackField[] }> }).attachments;
  assert.ok(attachments, 'expected attachments in slack payload');
  assert.ok(attachments[0]?.fields, 'expected fields in slack attachment');
  return attachments[0].fields!;
}

type DiscordField = { name: string; value: string; inline?: boolean };

function discordFields(payload: object): DiscordField[] {
  const embeds = (payload as { embeds?: Array<{ fields?: DiscordField[] }> }).embeds;
  assert.ok(embeds, 'expected embeds in discord payload');
  assert.ok(embeds[0]?.fields, 'expected fields in discord embed');
  return embeds[0].fields!;
}

test('slack budget payload renders spentUsd/limitUsd (not $0.00)', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 12.345, limitUsd: 100.5 },
    timestamp: '2026-08-03T00:00:00Z',
  });
  const fields = slackFields(payload);
  const spent = fields.find((f) => f.title === 'Spent');
  const limit = fields.find((f) => f.title === 'Limit');
  assert.equal(spent?.value, '$12.35');
  assert.equal(limit?.value, '$100.50');
});

test('slack budget payload escalates when percentUsed >= 100', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 110, limitUsd: 100, percentUsed: 110 },
  }) as { text: string };
  assert.match(payload.text, /🚨/);
});

test('slack budget payload stays warning below 100%', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 90, limitUsd: 100, percentUsed: 90 },
  }) as { text: string };
  assert.match(payload.text, /⚠️/);
});

test('slack anomaly payload renders fields (not JSON dump)', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onAnomalyDetected,
    data: { type: 'budget_spike', severity: 'high', model: 'gpt-4o', runId: 'run-123', description: '5x spend spike' },
  }) as { text: string };
  assert.equal(payload.text, '⚠️ Anomaly Detected');
  const fields = slackFields(payload);
  const byTitle = new Map(fields.map((f) => [f.title, f.value]));
  assert.equal(byTitle.get('Type'), 'budget_spike');
  assert.equal(byTitle.get('Severity'), 'high');
  assert.equal(byTitle.get('Model'), 'gpt-4o');
  assert.equal(byTitle.get('Run'), 'run-123');
  assert.equal(byTitle.get('Description'), '5x spend spike');
});

test('slack regression payload renders fields', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onRegressionFailed,
    data: { suite: 'backend-api', model: 'gpt-4o', regressions: [{ metric: 'averageScore', baseline: 80, current: 60 }] },
  });
  const fields = slackFields(payload);
  const byTitle = new Map(fields.map((f) => [f.title, f.value]));
  assert.equal(byTitle.get('Suite'), 'backend-api');
  assert.equal(byTitle.get('Model'), 'gpt-4o');
  assert.match(byTitle.get('Regressions') ?? '', /averageScore/);
});

test('slack regression payload includes baseline/current/threshold values', () => {
  const payload = formatSlackPayload({
    type: DispatchEventType.onRegressionFailed,
    data: {
      suite: 'backend-api',
      model: 'gpt-4o',
      regressions: [{ metric: 'averageScore', baseline: 80, current: 60, threshold: 10 }],
    },
  });
  const fields = slackFields(payload);
  const rendered = fields.find((f) => f.title === 'Regressions')?.value ?? '';
  const numbers: string[] = rendered.match(/\d+(\.\d+)?/g) ?? [];
  assert.ok(numbers.includes('80'), `baseline 80 missing from rendered text: ${rendered}`);
  assert.ok(numbers.includes('60'), `current 60 missing from rendered text: ${rendered}`);
  assert.ok(numbers.includes('10'), `threshold 10 missing from rendered text: ${rendered}`);
});

test('discord budget payload renders spentUsd/limitUsd (not $0.00)', () => {
  const payload = formatDiscordPayload({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 42.1, limitUsd: 200 },
  });
  const fields = discordFields(payload);
  const spent = fields.find((f) => f.name === 'Spent');
  const limit = fields.find((f) => f.name === 'Limit');
  assert.equal(spent?.value, '$42.10');
  assert.equal(limit?.value, '$200.00');
});

test('discord budget payload escalates when percentUsed >= 100', () => {
  const payload = formatDiscordPayload({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 110, limitUsd: 100, percentUsed: 110 },
  }) as { embeds: Array<{ color: number }> };
  assert.equal(payload.embeds[0]!.color, 0xff0000);
});

test('discord anomaly payload renders fields (not JSON dump)', () => {
  const payload = formatDiscordPayload({
    type: DispatchEventType.onAnomalyDetected,
    data: { type: 'loop', severity: 'medium', model: 'gpt-4o', runId: 'run-9', description: 'tool loop detected' },
  }) as { embeds: Array<{ title: string; description: string }> };
  assert.equal(payload.embeds[0]!.title, 'Anomaly Detected');
  assert.equal(payload.embeds[0]!.description, 'tool loop detected');
  const fields = discordFields(payload);
  const byName = new Map(fields.map((f) => [f.name, f.value]));
  assert.equal(byName.get('Type'), 'loop');
  assert.equal(byName.get('Severity'), 'medium');
  assert.equal(byName.get('Model'), 'gpt-4o');
  assert.equal(byName.get('Run'), 'run-9');
  assert.equal(byName.get('Description'), 'tool loop detected');
});

test('discord regression payload renders fields', () => {
  const payload = formatDiscordPayload({
    type: DispatchEventType.onRegressionFailed,
    data: { suite: 'backend-api', model: 'gpt-4o', regressions: [{ metric: 'averageScore', baseline: 80, current: 60 }] },
  });
  const fields = discordFields(payload);
  const byName = new Map(fields.map((f) => [f.name, f.value]));
  assert.equal(byName.get('Suite'), 'backend-api');
  assert.equal(byName.get('Model'), 'gpt-4o');
  assert.match(byName.get('Regressions') ?? '', /averageScore/);
});

test('discord regression payload includes baseline/current/threshold values', () => {
  const payload = formatDiscordPayload({
    type: DispatchEventType.onRegressionFailed,
    data: {
      suite: 'backend-api',
      model: 'gpt-4o',
      regressions: [{ metric: 'averageScore', baseline: 80, current: 60, threshold: 10 }],
    },
  });
  const fields = discordFields(payload);
  const rendered = fields.find((f) => f.name === 'Regressions')?.value ?? '';
  const numbers: string[] = rendered.match(/\d+(\.\d+)?/g) ?? [];
  assert.ok(numbers.includes('80'), `baseline 80 missing from rendered text: ${rendered}`);
  assert.ok(numbers.includes('60'), `current 60 missing from rendered text: ${rendered}`);
  assert.ok(numbers.includes('10'), `threshold 10 missing from rendered text: ${rendered}`);
});

test('normalizeEvent maps budget keys from spentUsd/limitUsd', () => {
  const n = normalizeEvent({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spentUsd: 12.345, limitUsd: 100.5, percentUsed: 12.2 },
    timestamp: '2026-08-03T00:00:00Z',
  });
  assert.equal(n.type, DispatchEventType.onBudgetThreshold);
  assert.equal(n.model, 'gpt-4o');
  assert.equal(n.spent, 12.345);
  assert.equal(n.limit, 100.5);
  assert.equal(n.percentUsed, 12.2);
  assert.deepEqual(n.extra, { model: 'gpt-4o', spentUsd: 12.345, limitUsd: 100.5, percentUsed: 12.2 });
});

test('normalizeEvent falls back to spent/limit when spentUsd/limitUsd absent', () => {
  const n = normalizeEvent({
    type: DispatchEventType.onBudgetThreshold,
    data: { model: 'gpt-4o', spent: 9, limit: 10, percentUsed: 90 },
  });
  assert.equal(n.spent, 9);
  assert.equal(n.limit, 10);
  assert.equal(n.percentUsed, 90);
});

test('normalizeEvent maps run-completed keys', () => {
  const n = normalizeEvent({
    type: DispatchEventType.onRunCompleted,
    data: { runId: 'run-123', scenario: 'backend-api', models: ['gpt-4o', 'claude-3.5'], status: 'success' },
  });
  assert.equal(n.status, 'success');
  assert.equal(n.runId, 'run-123');
  assert.equal(n.scenario, 'backend-api');
  assert.deepEqual(n.models, ['gpt-4o', 'claude-3.5']);
});

test('normalizeEvent maps anomaly keys (data.type becomes anomalyType)', () => {
  const n = normalizeEvent({
    type: DispatchEventType.onAnomalyDetected,
    data: { type: 'budget_spike', severity: 'high', model: 'gpt-4o', runId: 'run-123', description: '5x spend spike' },
  });
  assert.equal(n.anomalyType, 'budget_spike');
  assert.equal(n.severity, 'high');
  assert.equal(n.model, 'gpt-4o');
  assert.equal(n.runId, 'run-123');
  assert.equal(n.description, '5x spend spike');
});

test('normalizeEvent maps regression keys and preserves regressions in extra', () => {
  const regressions = [{ metric: 'averageScore', baseline: 80, current: 60, threshold: 10 }];
  const n = normalizeEvent({
    type: DispatchEventType.onRegressionFailed,
    data: { suite: 'backend-api', model: 'gpt-4o', regressions },
  });
  assert.equal(n.suite, 'backend-api');
  assert.equal(n.model, 'gpt-4o');
  assert.deepEqual(n.extra.regressions, regressions);
});

test('normalizeEvent treats missing data as empty and keeps extra a full copy', () => {
  const n = normalizeEvent({
    type: DispatchEventType.onRunCompleted,
    data: { runId: 'r1', custom: { nested: true }, extraKey: 42 },
  });
  assert.equal(n.runId, 'r1');
  assert.deepEqual(n.extra, { runId: 'r1', custom: { nested: true }, extraKey: 42 });
  assert.equal(JSON.stringify(n.extra), JSON.stringify({ runId: 'r1', custom: { nested: true }, extraKey: 42 }));
});

test('regressionSummary renders metric with baseline/current/threshold', () => {
  const rendered = regressionSummary({
    regressions: [{ metric: 'averageScore', baseline: 80, current: 60, threshold: 10 }],
  });
  assert.equal(rendered, 'averageScore baseline=80 current=60 threshold=10');
});

test('regressionSummary omits missing parts per entry', () => {
  const rendered = regressionSummary({
    regressions: [{ metric: 'accuracy' }, { metric: 'latency', baseline: 1.2, current: 3.4 }],
  });
  assert.equal(rendered, 'accuracy, latency baseline=1.2 current=3.4');
});

test('regressionSummary returns n/a when regressions is null/undefined', () => {
  assert.equal(regressionSummary({}), 'n/a');
  assert.equal(regressionSummary({ regressions: null }), 'n/a');
});

test('regressionSummary JSON-stringifies non-array regressions', () => {
  assert.equal(regressionSummary({ regressions: 'boom' }), '"boom"');
});

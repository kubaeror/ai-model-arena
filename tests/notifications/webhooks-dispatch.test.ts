import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { insertWebhook } from '../../src/anomaly-detection/db.js';
import { dispatchWebhooks } from '../../src/notifications/webhooks.js';
import { sendSlackNotification } from '../../src/notifications/slack.js';
import { sendDiscordNotification } from '../../src/notifications/discord.js';
import { DispatchEventType } from '../../src/notifications/types.js';
import { resetBudgetCache } from '../../src/cost-tracking/budget.js';
import { startRun, dispatchBudgetExceeded } from '../../src/orchestrator/run-lifecycle.js';

/**
 * Webhook dispatch integration test (Task 2.4 — budget_exceeded wiring).
 *
 * Uses REAL behavior end-to-end: an in-memory SQLite DB seeded via
 * insertWebhook (the path the API writes through) and a local http server
 * that captures the signed POST. No DB mocking.
 */

const KNOWN_SECRET = 'test-hmac-secret-42';

interface CapturedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startCapturingServer(): Promise<{ server: http.Server; port: number; captured: Record<string, CapturedRequest>; hits: () => number }> {
  const captured: Record<string, CapturedRequest> = {};
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      captured[req.url ?? '/'] = { url: req.url ?? '/', headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({ server, port: address.port, captured, hits: () => count });
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function startFailingServer(): Promise<{ server: http.Server; port: number; hits: () => number }> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count++;
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({ server, port: address.port, hits: () => count });
    });
  });
}

async function waitForHits(hits: () => number, expected: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hits() < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

let activeServer: http.Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await stopServer(activeServer);
    activeServer = null;
  }
  closeDb();
});

test('dispatchWebhooks delivers a signed POST to a registered webhook (real HTTP)', async () => {
  initDb(':memory:');
  const { server, port, captured, hits } = await startCapturingServer();
  activeServer = server;
  await insertWebhook({
    url: `http://127.0.0.1:${port}/hooks/budget`,
    events: ['budget_exceeded'],
    secret: KNOWN_SECRET,
  });

  const payload = { model: 'gpt-4o', spentUsd: 12.5, limitUsd: 10, percentUsed: 125, reason: 'Budget exceeded for gpt-4o' };
  await dispatchWebhooks('budget_exceeded', payload);

  const hit = captured['/hooks/budget'];
  assert.ok(hit, 'server should have received the webhook POST');
  const contentType = hit.headers['content-type'];
  assert.ok(contentType && contentType.includes('application/json'), 'request must be application/json');

  const authHeader = hit.headers['x-arena-signature'];
  assert.ok(typeof authHeader === 'string' && authHeader.startsWith('sha256='), `expected x-arena-signature, got ${authHeader}`);
  const sig = authHeader.slice('sha256='.length);

  // HMAC cross-check: recompute over the exact body the server received.
  const expected = crypto.createHmac('sha256', KNOWN_SECRET).update(hit.body).digest('hex');
  assert.equal(sig, expected, 'x-arena-signature must be HMAC-SHA256 of the body over the stored secret');

  const parsed = JSON.parse(hit.body) as { event: string; timestamp: string; data: { model: string; spentUsd: number; limitUsd: number; percentUsed: number; reason: string } };
  assert.equal(parsed.event, 'budget_exceeded');
  assert.ok(parsed.timestamp, 'payload must include a timestamp');
  assert.deepEqual(parsed.data, {
    model: 'gpt-4o',
    spentUsd: 12.5,
    limitUsd: 10,
    percentUsed: 125,
    reason: 'Budget exceeded for gpt-4o',
  });
  assert.equal(hits(), 1, 'exactly one delivery attempt');
});

test('dispatchWebhooks does NOT deliver to a webhook that did not subscribe to the event', async () => {
  initDb(':memory:');
  const { server, port, hits } = await startCapturingServer();
  activeServer = server;
  await insertWebhook({
    url: `http://127.0.0.1:${port}/unused`,
    events: ['run_completed'], // subscribed to a DIFFERENT event
    secret: KNOWN_SECRET,
  });

  // budget_exceeded fires, but the only registered webhook listens for run_completed.
  await dispatchWebhooks('budget_exceeded', { model: 'x', spentUsd: 1, limitUsd: 0, percentUsed: 999, reason: 'over' });

  assert.equal(hits(), 0, 'server must not be hit for a non-subscribed event');
});

test('dispatchWebhooks with no registered webhooks makes no HTTP call', async () => {
  initDb(':memory:');
  const { server, hits } = await startCapturingServer();
  activeServer = server;

  await dispatchWebhooks('budget_exceeded', { model: 'y', spentUsd: 2, limitUsd: 1, percentUsed: 200, reason: 'over' });

  assert.equal(hits(), 0, 'no fetch when webhooksForEvent returns empty');
});

test('sendSlackNotification retries a 500 response twice before failing', async () => {
  const { server, port, hits } = await startFailingServer();
  activeServer = server;

  const result = await sendSlackNotification(`http://127.0.0.1:${port}/hooks/slack`, {
    type: DispatchEventType.onRunCompleted,
    data: { runId: 'run-retry', scenario: 's', models: ['gpt-4o'], status: 'success' },
  });

  assert.equal(hits(), 3, 'initial attempt + 2 retries');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /boom/);
});

test('sendDiscordNotification retries a 500 response twice before failing', async () => {
  const { server, port, hits } = await startFailingServer();
  activeServer = server;

  const result = await sendDiscordNotification(`http://127.0.0.1:${port}/hooks/discord`, {
    type: DispatchEventType.onRunCompleted,
    data: { runId: 'run-retry', scenario: 's', models: ['gpt-4o'], status: 'success' },
  });

  assert.equal(hits(), 3, 'initial attempt + 2 retries');
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /boom/);
});

test('budget_exceeded reaches registered webhooks via startRun reserve-time path', async () => {
  initDb(':memory:');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-budget-webhook-'));
  const root = path.join(tmp, 'root');
  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'configs', 'budget.yaml'), [
    'global:',
    '  daily: 10',
    'models:',
    '  test-model:',
    '    daily: 10',
    'thresholds:',
    '  warn: 80',
    '  block: 100',
    'stateFile: .budget-state.json',
  ].join('\n'));
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(root, '.budget-state.json'), JSON.stringify({
    global: { daily: {}, monthly: {} },
    models: { 'test-model': { daily: { [today]: 15 }, monthly: {} } },
    reservations: {},
    lastReset: new Date().toISOString(),
  }));

  const { server, port, captured, hits } = await startCapturingServer();
  activeServer = server;
  await insertWebhook({
    url: `http://127.0.0.1:${port}/hooks/reserve`,
    events: ['budget_exceeded'],
  });

  const prevRoot = process.env.AI_ARENA_ROOT;
  process.env.AI_ARENA_ROOT = root;
  resetBudgetCache();
  try {
    await assert.rejects(
      startRun({ scenario: 'blocked', models: ['test-model'] }),
      /budget exceeded/i,
    );
  } finally {
    delete process.env.AI_ARENA_ROOT;
    if (prevRoot) process.env.AI_ARENA_ROOT = prevRoot;
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await waitForHits(hits, 1);
  const hit = captured['/hooks/reserve'];
  assert.ok(hit, 'reserve-time budget rejection must dispatch budget_exceeded webhook');
  const parsed = JSON.parse(hit.body) as { event: string; data: { model: string; spentUsd: number; limitUsd: number; percentUsed: number; reason: string } };
  assert.equal(parsed.event, 'budget_exceeded');
  assert.equal(parsed.data.model, 'test-model');
  assert.equal(parsed.data.spentUsd, 15);
  assert.equal(parsed.data.limitUsd, 10);
  assert.equal(parsed.data.percentUsed, 150);
  assert.match(parsed.data.reason, /budget exceeded/i);
});

test('budget_exceeded dispatch helper (during-run path) reaches registered webhooks', async () => {
  initDb(':memory:');
  const { server, port, captured } = await startCapturingServer();
  activeServer = server;
  await insertWebhook({
    url: `http://127.0.0.1:${port}/hooks/during-run`,
    events: ['budget_exceeded'],
  });

  await dispatchBudgetExceeded('gpt-4o', {
    reason: 'Daily budget exceeded for gpt-4o',
    spentUsd: 9,
    limitUsd: 5,
    percentUsed: 180,
  });

  const hit = captured['/hooks/during-run'];
  assert.ok(hit, 'during-run budget trip must dispatch budget_exceeded webhook');
  const parsed = JSON.parse(hit.body) as { event: string; data: { model: string; spentUsd: number; limitUsd: number; percentUsed: number; reason: string } };
  assert.equal(parsed.event, 'budget_exceeded');
  assert.deepEqual(parsed.data, {
    model: 'gpt-4o',
    spentUsd: 9,
    limitUsd: 5,
    percentUsed: 180,
    reason: 'Daily budget exceeded for gpt-4o',
  });
});

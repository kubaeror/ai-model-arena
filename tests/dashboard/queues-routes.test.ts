import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import express from 'express';
import type { RequestHandler } from 'express';
import { registerQueueRoutes } from '../../src/dashboard-server/routes/queues.js';

const KNOWN_PROVIDERS = [
  'openai', 'groq', 'cerebras', 'nvidia', 'mistral', 'sambanova', 'scaleway',
  'cloudflare', 'github-copilot', 'xai', 'openrouter', 'ollama',
  'anthropic', 'google',
];

let server: http.Server;
let base: string;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  const auth: RequestHandler = (req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'admin', role: 'admin' };
    next();
  };
  registerQueueRoutes(app, auth);
  return app;
}

function restoreEnv(...keys: string[]): () => void {
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

before(async () => {
  server = makeApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test('GET /api/queues reports per-provider depth, dlqDepth, consumerLag and maxReplicas', async (t) => {
  t.after(restoreEnv('QUEUE_DRIVER', 'ARENA_KEDA_MAX_REPLICAS'));
  delete process.env.QUEUE_DRIVER;
  process.env.ARENA_KEDA_MAX_REPLICAS = '7';

  const res = await fetch(`${base}/api/queues`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { queues: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(body.queues));
  assert.deepEqual(body.queues.map((q) => q.provider), KNOWN_PROVIDERS);
  for (const q of body.queues) {
    assert.ok('depth' in q, 'entry has depth');
    assert.ok('dlqDepth' in q, 'entry has dlqDepth');
    assert.ok('consumerLag' in q, 'entry has consumerLag');
    assert.equal(q.maxReplicas, 7, 'maxReplicas honors ARENA_KEDA_MAX_REPLICAS');
  }
});

test('GET /api/queues reports maxReplicas null when ARENA_KEDA_MAX_REPLICAS is unset', async (t) => {
  t.after(restoreEnv('QUEUE_DRIVER', 'ARENA_KEDA_MAX_REPLICAS'));
  delete process.env.QUEUE_DRIVER;
  delete process.env.ARENA_KEDA_MAX_REPLICAS;

  const res = await fetch(`${base}/api/queues`);
  const body = (await res.json()) as { queues: Array<{ maxReplicas: number | null }> };
  assert.ok(body.queues.length > 0);
  assert.ok(body.queues.every((q) => q.maxReplicas === null), 'maxReplicas is null by default');
});

test('GET /api/queues/:provider/tasks peeks the named provider DLQ and echoes the provider', async (t) => {
  t.after(restoreEnv('QUEUE_DRIVER'));
  delete process.env.QUEUE_DRIVER;

  const res = await fetch(`${base}/api/queues/openai/tasks?limit=5`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { provider: string; tasks: unknown[] };
  assert.equal(body.provider, 'openai', 'provider echoed from the route param');
  assert.ok(Array.isArray(body.tasks));
});

test('POST /api/queues/:provider/tasks/:id/retry reports retried:false for a task not in the DLQ', async (t) => {
  t.after(restoreEnv('QUEUE_DRIVER'));
  delete process.env.QUEUE_DRIVER;

  const res = await fetch(`${base}/api/queues/openai/tasks/does-not-exist/retry`, { method: 'POST' });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { id: string; retried: boolean; note?: string };
  assert.equal(body.id, 'does-not-exist');
  assert.equal(body.retried, false, 'retried honors deadLetterRetry result');
  assert.ok(body.note, 'response explains why the task was not retried');
});

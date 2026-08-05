import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, login, authedGet, postJson, TEST_ADMIN } from './route-test-harness.js';
import { getDrizzleDb } from '../../src/db/index.js';
import { insertAuditEntry } from '../../src/db/query.js';
import { models, pricing, providers, run_models, runs } from '../../src/db/schema.js';

function requiresModuleMocks(t: TestContext): boolean {
  return typeof (t.mock as { module?: unknown }).module === 'function';
}

test('POST /api/auth/login authenticates env and DB users, rejects bad credentials', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);

  const dbUser = await postJson(h.base, null, '/api/auth/login', { username: TEST_ADMIN.username, password: TEST_ADMIN.password });
  assert.equal(dbUser.status, 200);
  const dbBody = (await dbUser.json()) as { token: string; username: string; role: string };
  assert.ok(typeof dbBody.token === 'string' && dbBody.token.length > 10, 'login returns a JWT');
  assert.equal(dbBody.username, 'tester');
  assert.equal(dbBody.role, 'admin');

  const envUser = await postJson(h.base, null, '/api/auth/login', { username: 'admin', password: 'admin-pass-123' });
  assert.equal(envUser.status, 200);
  assert.equal(((await envUser.json()) as { role: string }).role, 'admin');

  const wrongPassword = await postJson(h.base, null, '/api/auth/login', { username: TEST_ADMIN.username, password: 'wrong-password' });
  assert.equal(wrongPassword.status, 401);

  const unknownUser = await postJson(h.base, null, '/api/auth/login', { username: 'nobody', password: 'x' });
  assert.equal(unknownUser.status, 401);
});

test('GET /api/models requires auth; POST /api/models registers a provider and lists models', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(providers).values({
    id: 'openai', name: 'OpenAI', auth_scheme: 'bearer', is_builtin: 1,
    adapter: 'openai-compat', created_at: now, updated_at: now,
  });
  await db.insert(models).values({
    id: 'test-model-1', name: 'Test Model One', provider_id: 'openai',
    context_limit: 128000, output_limit: 8192, last_synced_at: now,
  });
  await db.insert(pricing).values({ model_id: 'test-model-1', tier_size: 0, input: 0.5, output: 1.5, updated_at: now });

  const anon = await fetch(`${h.base}/api/models`);
  assert.equal(anon.status, 401);

  const list = await authedGet(h.base, h.adminToken, '/api/models');
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { models: Array<{ id: string; name: string; input: number | null }> };
  assert.ok(listBody.models.some((m) => m.id === 'test-model-1'), 'seeded model listed with pricing');
  const seeded = listBody.models.find((m) => m.id === 'test-model-1');
  assert.equal(seeded?.input, 0.5);

  const created = await postJson(h.base, h.adminToken, '/api/models', {
    name: 'Custom Runner',
    apiBase: 'https://example.com/v1',
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { models: unknown[] };
  assert.ok(Array.isArray(createdBody.models) && createdBody.models.length > 0, 'POST returns the model list');
});

test('POST /api/scenarios then GET /api/scenarios/:name round-trips a scenario YAML', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);

  const created = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'roundtrip',
    systemPrompt: 'You are a helpful test agent.',
    task: 'Write a test file.',
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { scenario: { name: string; systemPrompt: string } };
  assert.equal(createdBody.scenario.name, 'roundtrip');
  assert.equal(createdBody.scenario.systemPrompt, 'You are a helpful test agent.');

  const yamlPath = path.join(h.tmpDir, 'configs', 'scenarios', 'roundtrip.yaml');
  assert.ok(fs.existsSync(yamlPath), 'scenario YAML written under temp configs/scenarios');

  const fetched = await authedGet(h.base, h.adminToken, '/api/scenarios/roundtrip');
  assert.equal(fetched.status, 200);
  const fetchedBody = (await fetched.json()) as { scenario: { name: string; task: string }; starterFiles: unknown[] };
  assert.equal(fetchedBody.scenario.name, 'roundtrip');
  assert.equal(fetchedBody.scenario.task, 'Write a test file.');
  assert.ok(Array.isArray(fetchedBody.starterFiles));

  const dup = await postJson(h.base, h.adminToken, '/api/scenarios', { name: 'roundtrip', systemPrompt: 'x', task: 'y' });
  assert.equal(dup.status, 409, 'duplicate scenario name rejected');

  const missing = await authedGet(h.base, h.adminToken, '/api/scenarios/does-not-exist');
  assert.equal(missing.status, 404);
});

test('GET /api/runs returns seeded runs', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);
  const db = getDrizzleDb();
  await db.insert(runs).values({
    run_id: 'run-1',
    scenario: 'scenario-a',
    models: JSON.stringify(['gpt-4o', 'claude-3-5-sonnet']),
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:05:00.000Z',
    status: 'completed',
    source: 'cli',
  });
  await db.insert(run_models).values({
    run_id: 'run-1',
    model: 'gpt-4o',
    status: 'completed',
    output_dir: path.join(h.tmpDir, 'out'),
    sandbox_dir: path.join(h.tmpDir, 'sandbox'),
    result_path: '/x/result.json',
    conversation_path: '/x/conv.json',
    report_path: '/x/report.md',
    log_file: '/x/run.log',
  });

  const res = await authedGet(h.base, h.adminToken, '/api/runs');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    runs: Array<{ runId: string; scenario: string; models: string[]; status: string; perModel: Array<{ model: string; status: string }> }>;
  };
  const run = body.runs.find((r) => r.runId === 'run-1');
  assert.ok(run, 'seeded run is listed');
  assert.equal(run!.scenario, 'scenario-a');
  assert.deepEqual(run!.models, ['gpt-4o', 'claude-3-5-sonnet']);
  assert.equal(run!.status, 'completed');
  assert.equal(run!.perModel[0]?.model, 'gpt-4o');
  assert.equal(run!.perModel[0]?.status, 'completed');
});

test('GET /api/queues reports queue entries, admin only', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t, { seedViewerUser: true });

  const anon = await fetch(`${h.base}/api/queues`);
  assert.equal(anon.status, 401);

  const forbidden = await authedGet(h.base, h.viewerToken!, '/api/queues');
  assert.equal(forbidden.status, 403);

  const res = await authedGet(h.base, h.adminToken, '/api/queues');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    queues: Array<{ provider: string; depth: number; dlqDepth: number | null; consumerLag: number | null; maxReplicas: number | null }>;
  };
  assert.ok(Array.isArray(body.queues) && body.queues.length > 0, 'per-provider queue entries');
  const openai = body.queues.find((q) => q.provider === 'openai');
  assert.ok(openai, 'openai queue entry present');
  assert.equal(typeof openai!.depth, 'number');
  assert.ok('dlqDepth' in openai! && 'consumerLag' in openai!, 'depth, dlqDepth and consumerLag reported');
});

test('GET /api/secrets masks values, admin only', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t, { seedViewerUser: true });
  t.after(() => { delete process.env.ARENA_TEST_API_KEY; });
  process.env.ARENA_TEST_API_KEY = 'sk-test-1234567890';

  const forbidden = await authedGet(h.base, h.viewerToken!, '/api/secrets');
  assert.equal(forbidden.status, 403);

  const res = await authedGet(h.base, h.adminToken, '/api/secrets');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    platform: string;
    secrets: Array<{ envVar: string; status: string; maskedValue?: string }>;
  };
  assert.equal(body.platform, 'bare-metal');
  const entry = body.secrets.find((s) => s.envVar === 'ARENA_TEST_API_KEY');
  assert.ok(entry, 'test key listed');
  assert.equal(entry!.status, 'set');
  assert.equal(entry!.maskedValue, 'sk-t...7890', 'value masked to first 4 + last 4 chars');
  assert.ok(!JSON.stringify(body).includes('sk-test-1234567890'), 'raw secret value is not leaked');
});

test('GET /api/roles lists seeded roles', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);

  const res = await authedGet(h.base, h.adminToken, '/api/roles');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { roles: Array<{ id: string }> };
  assert.deepEqual(body.roles.map((r) => r.id), ['admin', 'editor', 'viewer']);
});

test('GET /api/audit returns paginated audit entries', async (t) => {
  if (!requiresModuleMocks(t)) { t.skip('requires --experimental-test-module-mocks (provided by npm test)'); return; }
  const h = await boot(t);
  await insertAuditEntry({
    actor: 'tester', action: 'model.create', entityType: 'model', entityId: 'm1',
    after: JSON.stringify({ name: 'a' }), at: '2026-01-01T00:00:00.000Z',
  });
  await insertAuditEntry({
    actor: 'tester', action: 'model.update', entityType: 'model', entityId: 'm2',
    after: JSON.stringify({ name: 'b' }), at: '2026-01-03T00:00:00.000Z',
  });
  await insertAuditEntry({
    actor: 'system', action: 'user.create', entityType: 'user', entityId: 'u1',
    at: '2026-01-02T00:00:00.000Z',
  });

  const first = await authedGet(h.base, h.adminToken, '/api/audit?limit=2');
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    entries: Array<{ action: string; actor: string }>;
    total: number; limit: number; offset: number;
  };
  assert.equal(firstBody.total, 3);
  assert.equal(firstBody.limit, 2);
  assert.equal(firstBody.offset, 0);
  assert.equal(firstBody.entries.length, 2);
  assert.equal(firstBody.entries[0]?.action, 'model.update', 'ordered newest first');

  const second = await authedGet(h.base, h.adminToken, '/api/audit?limit=2&offset=2');
  const secondBody = (await second.json()) as { entries: unknown[]; total: number };
  assert.equal(secondBody.entries.length, 1);
  assert.equal(secondBody.total, 3);

  const clamped = await authedGet(h.base, h.adminToken, '/api/audit?limit=2000');
  const clampedBody = (await clamped.json()) as { limit: number };
  assert.equal(clampedBody.limit, 200, 'limit clamped to 200');
});

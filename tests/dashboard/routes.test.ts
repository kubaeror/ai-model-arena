import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { boot, authedGet, postJson, TEST_ADMIN, TEST_VIEWER } from './route-test-harness.js';
import { getDrizzleDb } from '../../src/db/index.js';
import { insertAnomaly, insertAuditEntry, insertPrompt, insertPromptVersion } from '../../src/db/query.js';
import { messages, model_calls, models, model_providers, pricing, providers, run_models, runs, sessions, audit_log as auditLog, cost_ledger as costLedger } from '../../src/db/schema.js';
import { outputRoot } from '../../src/paths.js';
import { isWithin } from '../../src/sandbox/sandbox.js';
import { getRunRecord, upsertRun } from '../../src/db/runs.js';
import { loadAuthConfig, signToken } from '../../src/dashboard-server/auth.js';

function runFixture(runId: string, createdBy: string | undefined, tmpDir: string): Parameters<typeof upsertRun>[0] {
  const outputDir = path.join(tmpDir, runId);
  fs.mkdirSync(outputDir, { recursive: true });
  return {
    runId,
    scenario: 'scenario-ownership',
    models: ['gpt-4o'],
    startedAt: '2026-02-01T00:00:00.000Z',
    finishedAt: '2026-02-01T00:01:00.000Z',
    status: 'completed',
    source: 'cli',
    createdBy,
    comparisonMdPath: null,
    comparisonJsonPath: null,
    perModel: [{
      model: 'gpt-4o',
      runId,
      outputDir,
      sandboxDir: path.join(outputDir, 'sandbox'),
      resultPath: path.join(outputDir, 'result.json'),
      conversationPath: path.join(outputDir, 'conversation.json'),
      reportPath: path.join(outputDir, 'report.md'),
      logFile: path.join(outputDir, 'run.log'),
      status: 'completed',
    }],
  };
}

test('GET /api/cost exposes the cost ledger summary', async (t) => {
  const h = await boot(t);
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(runs).values({
    run_id: 'cost-run-1', scenario: 'smoke', models: '["gpt-4o"]',
    started_at: now, finished_at: now, status: 'completed', source: 'cli',
    comparison_md_path: null, comparison_json_path: null, created_by: null,
  });
  await db.insert(costLedger).values({
    run_id: 'cost-run-1', model: 'gpt-4o', cost_usd: 1.25,
    input_tokens: 1000, output_tokens: 500, recorded_at: now,
  });

  const anon = await fetch(`${h.base}/api/cost`);
  assert.equal(anon.status, 401);

  const res = await authedGet(h.base, h.adminToken, '/api/cost');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { groupBy: string; models: Array<{ model: string; total_cost: string | number }> };
  assert.equal(body.groupBy, 'model');
  const row = body.models.find((m) => m.model === 'gpt-4o');
  assert.equal(Number(row?.total_cost), 1.25, 'sqlite sum() may come back as a string');

  const byDay = await authedGet(h.base, h.adminToken, '/api/cost?groupBy=day');
  assert.equal(byDay.status, 200);
});

test('user password changes never reach the audit log as plaintext', async (t) => {
  const h = await boot(t);
  const db = getDrizzleDb();

  const created = await postJson(h.base, h.adminToken, '/api/users', {
    username: 'pw-audit-user', password: 'initial-pass-123',
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { id: string };
  assert.ok(body.id);

  const updated = await fetch(`${h.base}/api/users/${body.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.adminToken}` },
    body: JSON.stringify({ password: 'changed-pass-456' }),
  });
  assert.equal(updated.status, 200);

  const rows = await db.select().from(auditLog).all();
  for (const row of rows) {
    assert.ok(!String(row.after ?? '').includes('pass-'), `audit after must not contain the password: ${row.after}`);
    assert.ok(!String(row.before ?? '').includes('pass-'), `audit before must not contain the password: ${row.before}`);
  }
});

test('POST /api/auth/login authenticates env and DB users, rejects bad credentials', async (t) => {
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

test('POST /api/models rejects provider URLs targeting blocked addresses', async (t) => {
  const h = await boot(t);

  for (const apiBase of ['http://127.0.0.1:11434/v1', 'https://[fd00::1]/v1', 'https://169.254.169.254/latest/meta-data']) {
    const res = await postJson(h.base, h.adminToken, '/api/models', { name: 'Bad Provider', apiBase });
    assert.equal(res.status, 400, `${apiBase} must be rejected`);
  }

  const publicRes = await postJson(h.base, h.adminToken, '/api/models', {
    name: 'Public Provider',
    apiBase: 'https://example.com/v1',
  });
  assert.equal(publicRes.status, 201);
});

test('POST /api/scenarios then GET /api/scenarios/:name round-trips a scenario YAML', async (t) => {
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
  const h = await boot(t);

  const res = await authedGet(h.base, h.adminToken, '/api/roles');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { roles: Array<{ id: string }> };
  assert.deepEqual(body.roles.map((r) => r.id), ['admin', 'editor', 'viewer']);
});

test('GET /api/audit returns paginated audit entries', async (t) => {
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

test('POST /api/runs rejects traversal scenario and model identifiers', async (t) => {
  const h = await boot(t);
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(providers).values({
    id: 'openai', name: 'OpenAI', auth_scheme: 'bearer', is_builtin: 1,
    adapter: 'openai-compat', created_at: now, updated_at: now,
  });
  await db.insert(models).values({
    id: 'gpt-4o', name: 'GPT-4o', provider_id: 'openai',
    context_limit: 128000, output_limit: 8192, last_synced_at: now,
  });
  await db.insert(model_providers).values({ model_id: 'gpt-4o', provider_id: 'openai', api_model_id: 'gpt-4o' });
  await db.insert(pricing).values({ model_id: 'gpt-4o', tier_size: 0, input: 2.5, output: 10, updated_at: now });

  const badScenario = await postJson(h.base, h.adminToken, '/api/runs', {
    scenario: '../../evil', models: ['gpt-4o'],
  });
  assert.equal(badScenario.status, 400, 'traversal scenario rejected');

  for (const model of ['../../evil', 'nested/model', 'model.yaml']) {
    const res = await postJson(h.base, h.adminToken, '/api/runs', { scenario: 'smoke', models: [model] });
    assert.equal(res.status, 400, `traversal model ${model} rejected`);
  }

  assert.ok(
    !fs.readdirSync(h.tmpDir).some((name) => name.startsWith('evil')),
    'rejected run identifiers must not create directories',
  );
});

test('POST /api/runs launches catalog display names (Launcher payload)', async (t) => {
  const h = await boot(t);
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(providers).values({
    id: 'anthropic', name: 'Anthropic', auth_scheme: 'x-api-key', is_builtin: 1,
    adapter: 'anthropic', created_at: now, updated_at: now,
  });
  for (const [id, name] of [['claude-3-7-sonnet', 'Claude 3.7 Sonnet'], ['claude-3.7', 'claude-3.7']] as const) {
    const canonical = `anthropic/${id}`;
    await db.insert(models).values({
      id: canonical, name, provider_id: 'anthropic',
      context_limit: 200000, output_limit: 8192, last_synced_at: now,
    });
    await db.insert(model_providers).values({ model_id: canonical, provider_id: 'anthropic', api_model_id: id });
    await db.insert(pricing).values({ model_id: canonical, tier_size: 0, input: 3, output: 15, updated_at: now });
  }

  const res = await postJson(h.base, h.adminToken, '/api/runs', {
    scenario: 'smoke', models: ['Claude 3.7 Sonnet', 'claude-3.7'],
  });
  assert.equal(res.status, 202, `display names must launch, got ${res.status}: ${await res.clone().text()}`);
  const body = (await res.json()) as { runId: string; models: { model: string }[] };
  assert.deepEqual(
    body.models.map((m) => m.model),
    ['Claude 3.7 Sonnet', 'claude-3.7'],
    'the run response keeps the original lookup keys',
  );

  const rec = await getRunRecord(body.runId);
  assert.ok(rec, 'run must be registered');
  for (const model of rec.perModel) {
    assert.ok(
      isWithin(outputRoot(), model.outputDir),
      `output dir for ${model.model} must stay within ${outputRoot()}`,
    );
  }
});

test('POST /api/prompts/enqueue rejects traversal scenario and model identifiers', async (t) => {
  await boot(t);
  const now = new Date().toISOString();
  await insertPrompt({ id: 'prompt-1', name: 'Prompt One', description: null, createdAt: now, updatedAt: now });
  await insertPromptVersion({
    id: 'version-1', promptId: 'prompt-1', version: 1,
    systemPrompt: 'system', task: 'task', config: null, tag: null,
    createdAt: now, createdBy: 'tester',
  });

  const express = (await import('express')).default;
  const { createPromptsRouter } = await import('../../src/dashboard-server/routes/prompts.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: { sub: string; role: string } }).user = { sub: 'tester', role: 'admin' };
    next();
  });
  app.use('/api/prompts', createPromptsRouter());

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const cases = [
      { promptId: 'prompt-1', models: ['gpt-4o'], scenario: '../../evil' },
      { promptId: 'prompt-1', models: ['../../evil'], scenario: 'smoke' },
    ];
    for (const body of cases) {
      const res = await fetch(`${base}/api/prompts/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400, `enqueue must reject ${JSON.stringify(body)}`);
    }
  } finally {
    server.close();
    server.closeIdleConnections();
  }
});

test('GET /api/runs only lists runs owned by the caller for non-admins', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  await upsertRun(runFixture('owned-by-viewer1', TEST_VIEWER.username, h.tmpDir));
  await upsertRun(runFixture('owned-by-alice', 'alice', h.tmpDir));
  await upsertRun(runFixture('legacy-ownerless', undefined, h.tmpDir));

  const adminRes = await authedGet(h.base, h.adminToken, '/api/runs');
  assert.equal(adminRes.status, 200);
  const adminBody = (await adminRes.json()) as { runs: Array<{ runId: string }> };
  const adminIds = adminBody.runs.map((r) => r.runId);
  assert.ok(adminIds.includes('owned-by-viewer1') && adminIds.includes('owned-by-alice') && adminIds.includes('legacy-ownerless'));

  const viewerRes = await authedGet(h.base, h.viewerToken!, '/api/runs');
  assert.equal(viewerRes.status, 200);
  const viewerBody = (await viewerRes.json()) as { runs: Array<{ runId: string }> };
  assert.deepEqual(viewerBody.runs.map((r) => r.runId), ['owned-by-viewer1']);
  const raw = JSON.stringify(viewerBody);
  assert.ok(!raw.includes('owned-by-alice'), 'other owner run must not be listed');
  assert.ok(!raw.includes('legacy-ownerless'), 'ownerless run must not be listed');
  assert.ok(!raw.includes(path.join(h.tmpDir, 'owned-by-alice')), 'other owner absolute paths must not leak');
});

test('session detail endpoints enforce run ownership', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const db = getDrizzleDb();
  await upsertRun(runFixture('session-run-alice', 'alice', h.tmpDir));
  const sessionId = 'session-run-alice-gpt-4o';
  const now = new Date().toISOString();
  await db.insert(sessions).values({ id: sessionId, model: 'gpt-4o', status: 'active', created_at: now, updated_at: now });
  await db.insert(messages).values({ id: 'msg-secret', session_id: sessionId, turn: 0, role: 'user', content: 'top secret prompt', created_at: now });
  await db.insert(model_calls).values({
    id: 'call-secret', session_id: sessionId, turn: 0, provider: 'openai', model: 'gpt-4o',
    request_hash: 'hash', response_text: 'secret completion', created_at: now,
  });

  for (const p of [`/api/sessions/${sessionId}`, `/api/sessions/${sessionId}/messages`, `/api/sessions/${sessionId}/calls`]) {
    const denied = await authedGet(h.base, h.viewerToken!, p);
    assert.equal(denied.status, 403, `${p} must deny a non-owner viewer`);
    assert.ok(!(await denied.text()).includes('secret'), `${p} must not leak session data`);
  }

  const aliceToken = signToken(loadAuthConfig(), 'alice', 'viewer');
  const ownerMsgs = await authedGet(h.base, aliceToken, `/api/sessions/${sessionId}/messages`);
  assert.equal(ownerMsgs.status, 200);
  const ownerMsgsBody = (await ownerMsgs.json()) as { messages: Array<{ content: string }> };
  assert.equal(ownerMsgsBody.messages[0]?.content, 'top secret prompt');

  const adminDetail = await authedGet(h.base, h.adminToken, `/api/sessions/${sessionId}`);
  assert.equal(adminDetail.status, 200);
});

test('sessions with no owning run are default-denied to non-admins', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(sessions).values({ id: 'orphan-session', model: 'gpt-4o', status: 'active', created_at: now, updated_at: now });
  await upsertRun(runFixture('legacy-session-run', undefined, h.tmpDir));
  await db.insert(sessions).values({
    id: 'legacy-session-run-gpt-4o', model: 'gpt-4o', status: 'active', created_at: now, updated_at: now,
  });
  // A session whose run does not exist must not inherit ownership from a run
  // that merely shares an id prefix, even for that run's owner.
  await db.insert(sessions).values({
    id: 'legacy-session-run-extra-gpt-4o', model: 'gpt-4o', status: 'active', created_at: now, updated_at: now,
  });

  for (const id of ['orphan-session', 'legacy-session-run-gpt-4o']) {
    const denied = await authedGet(h.base, h.viewerToken!, `/api/sessions/${id}`);
    assert.equal(denied.status, 403, `${id} must be denied to a viewer`);
    const admin = await authedGet(h.base, h.adminToken, `/api/sessions/${id}`);
    assert.equal(admin.status, 200, `${id} must stay visible to admins`);
  }

  const aliceToken = signToken(loadAuthConfig(), 'alice', 'viewer');
  const prefixInheritance = await authedGet(h.base, aliceToken, '/api/sessions/legacy-session-run-extra-gpt-4o');
  assert.equal(prefixInheritance.status, 403, 'a missing run must not inherit a prefix run owner');
});

test('session ownership falls back to run lookup when the model suffix is stale', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const db = getDrizzleDb();
  await upsertRun(runFixture('fallback-run', 'alice', h.tmpDir));
  const now = new Date().toISOString();
  await db.insert(sessions).values({
    id: 'fallback-run-gpt-4o-restart', model: 'gpt-4o', status: 'active', created_at: now, updated_at: now,
  });

  const aliceToken = signToken(loadAuthConfig(), 'alice', 'viewer');
  assert.equal((await authedGet(h.base, aliceToken, '/api/sessions/fallback-run-gpt-4o-restart')).status, 200);
  assert.equal((await authedGet(h.base, h.viewerToken!, '/api/sessions/fallback-run-gpt-4o-restart')).status, 403);
  assert.equal((await authedGet(h.base, h.adminToken, '/api/sessions/fallback-run-gpt-4o-restart')).status, 200);
});

test('CSV export only includes runs owned by the caller for non-admins', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const result = JSON.stringify({ durationMs: 1000, turnsUsed: 2, success: true, tokenUsage: { prompt: 10, completion: 5 }, costUsd: 0.25 });
  for (const run of [runFixture('csv-owned-by-viewer1', TEST_VIEWER.username, h.tmpDir), runFixture('csv-owned-by-alice', 'alice', h.tmpDir)]) {
    fs.writeFileSync(run.perModel[0]!.resultPath, result);
    await upsertRun(run);
  }

  const viewerRes = await authedGet(h.base, h.viewerToken!, '/api/export/csv');
  assert.equal(viewerRes.status, 200);
  const viewerCsv = await viewerRes.text();
  assert.ok(viewerCsv.includes('csv-owned-by-viewer1'), 'owner run is exported');
  assert.ok(!viewerCsv.includes('csv-owned-by-alice'), 'other owner run is not exported');

  const adminRes = await authedGet(h.base, h.adminToken, '/api/export/csv');
  assert.equal(adminRes.status, 200);
  const adminCsv = await adminRes.text();
  assert.ok(adminCsv.includes('csv-owned-by-viewer1') && adminCsv.includes('csv-owned-by-alice'), 'admin export keeps every run');
});

test('anomaly detail checks run ownership before returning traces', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  await upsertRun(runFixture('anomaly-run-alice', 'alice', h.tmpDir));
  const anomaly = await insertAnomaly({
    run_id: 'anomaly-run-alice', model: 'gpt-4o', type: 'error_rate', severity: 'high',
    description: 'trace contains captured prompt',
  });

  const denied = await authedGet(h.base, h.viewerToken!, `/api/anomalies/${anomaly.id}`);
  assert.equal(denied.status, 403);
  assert.ok(!(await denied.text()).includes('captured prompt'), 'anomaly payload must not leak to non-owners');

  const owner = await authedGet(h.base, signToken(loadAuthConfig(), 'alice', 'viewer'), `/api/anomalies/${anomaly.id}`);
  assert.equal(owner.status, 200);
  const ownerBody = (await owner.json()) as { anomaly: { id: number }; run: { runId: string } | null };
  assert.equal(ownerBody.anomaly.id, anomaly.id);
  assert.equal(ownerBody.run?.runId, 'anomaly-run-alice');

  const admin = await authedGet(h.base, h.adminToken, `/api/anomalies/${anomaly.id}`);
  assert.equal(admin.status, 200);
});

test('anomaly list filters to runs owned by the caller for non-admins', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  await upsertRun(runFixture('anomaly-list-viewer1', TEST_VIEWER.username, h.tmpDir));
  await upsertRun(runFixture('anomaly-list-alice', 'alice', h.tmpDir));
  await upsertRun(runFixture('anomaly-list-ownerless', undefined, h.tmpDir));
  const owned = await insertAnomaly({
    run_id: 'anomaly-list-viewer1', model: 'gpt-4o', type: 'latency', severity: 'low',
    description: 'owned anomaly',
  });
  const foreign = await insertAnomaly({
    run_id: 'anomaly-list-alice', model: 'gpt-4o', type: 'error_rate', severity: 'high',
    description: 'foreign anomaly description',
  });
  const ownerless = await insertAnomaly({
    run_id: 'anomaly-list-ownerless', model: 'gpt-4o', type: 'loop', severity: 'medium',
    description: 'ownerless anomaly',
  });
  const orphan = await insertAnomaly({
    run_id: 'anomaly-list-missing-run', model: 'gpt-4o', type: 'silent_failure', severity: 'high',
    description: 'orphan anomaly',
  });

  const viewerRes = await authedGet(h.base, h.viewerToken!, '/api/anomalies');
  assert.equal(viewerRes.status, 200);
  const viewerBody = (await viewerRes.json()) as { anomalies: Array<{ id: number; run_id: string }> };
  assert.deepEqual(viewerBody.anomalies.map((a) => a.id), [owned.id], 'viewer sees only owned anomalies');
  const raw = JSON.stringify(viewerBody);
  assert.ok(!raw.includes('foreign anomaly description'), 'foreign anomaly must not leak');
  assert.ok(!raw.includes('ownerless anomaly'), 'ownerless run anomaly must not leak');
  assert.ok(!raw.includes('orphan anomaly'), 'anomaly with no run record must not leak');

  const adminRes = await authedGet(h.base, h.adminToken, '/api/anomalies');
  assert.equal(adminRes.status, 200);
  const adminIds = ((await adminRes.json()) as { anomalies: Array<{ id: number }> }).anomalies.map((a) => a.id);
  for (const id of [owned.id, foreign.id, ownerless.id, orphan.id]) {
    assert.ok(adminIds.includes(id), `admin must keep seeing anomaly ${id}`);
  }
});

test('session list filters to sessions of owned runs and total reflects the filtered set', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await upsertRun(runFixture('session-list-viewer1', TEST_VIEWER.username, h.tmpDir));
  await upsertRun(runFixture('session-list-alice', 'alice', h.tmpDir));
  await upsertRun(runFixture('session-list-ownerless', undefined, h.tmpDir));
  const rows = [
    { id: 'session-list-viewer1-gpt-4o', model: 'gpt-4o' },
    { id: 'session-list-alice-gpt-4o', model: 'gpt-4o' },
    { id: 'session-list-ownerless-gpt-4o', model: 'gpt-4o' },
    { id: 'session-list-viewer1-ghost-model', model: 'ghost-model' },
    { id: 'session-list-orphan-session', model: 'gpt-4o' },
  ];
  for (const row of rows) {
    await db.insert(sessions).values({ id: row.id, model: row.model, status: 'active', created_at: now, updated_at: now });
  }

  const viewerRes = await authedGet(h.base, h.viewerToken!, '/api/sessions');
  assert.equal(viewerRes.status, 200);
  const viewerBody = (await viewerRes.json()) as { sessions: Array<{ id: string }>; total: number; limit: number; offset: number };
  assert.deepEqual(viewerBody.sessions.map((s) => s.id), ['session-list-viewer1-gpt-4o']);
  assert.equal(viewerBody.total, 1, 'total counts only the visible sessions');
  const raw = JSON.stringify(viewerBody);
  assert.ok(!raw.includes('session-list-alice'), 'foreign session must not leak');
  assert.ok(!raw.includes('session-list-ownerless'), 'ownerless session must not leak');
  assert.ok(!raw.includes('ghost-model'), 'session whose model is not in the run must not leak');
  assert.ok(!raw.includes('session-list-orphan-session'), 'session with no run must not leak');

  const viewerPage2 = await authedGet(h.base, h.viewerToken!, '/api/sessions?limit=1&offset=1');
  const page2Body = (await viewerPage2.json()) as { sessions: unknown[]; total: number };
  assert.equal(page2Body.sessions.length, 0, 'offset applies to the filtered set');
  assert.equal(page2Body.total, 1);

  const adminRes = await authedGet(h.base, h.adminToken, '/api/sessions');
  assert.equal(adminRes.status, 200);
  const adminBody = (await adminRes.json()) as { sessions: Array<{ id: string }>; total: number };
  assert.equal(adminBody.total, rows.length, 'admin total stays unfiltered');
  const adminIds = adminBody.sessions.map((s) => s.id);
  for (const row of rows) {
    assert.ok(adminIds.includes(row.id), `admin must keep seeing ${row.id}`);
  }
});

test('session fast path requires the run to have actually run the session model', async (t) => {
  const h = await boot(t, { seedViewerUser: true });
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await upsertRun(runFixture('membership-run', 'alice', h.tmpDir));
  await db.insert(sessions).values({
    id: 'membership-run-claude-3', model: 'claude-3', status: 'active', created_at: now, updated_at: now,
  });

  const aliceToken = signToken(loadAuthConfig(), 'alice', 'viewer');
  const denied = await authedGet(h.base, aliceToken, '/api/sessions/membership-run-claude-3');
  assert.equal(denied.status, 403, 'a run must not own a session for a model it never ran');
  assert.equal((await authedGet(h.base, h.adminToken, '/api/sessions/membership-run-claude-3')).status, 200);

  const list = await authedGet(h.base, aliceToken, '/api/sessions');
  const listBody = (await list.json()) as { sessions: Array<{ id: string }>; total: number };
  assert.equal(listBody.total, 0, 'the mismatched session must not appear in the owner list');
});

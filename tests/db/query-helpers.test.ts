import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import {
  listUsersWithRoles, countUserRoles, getUserRolesByUserId,
  listCatalogModels, getModelDetail, getCostSummary,
  queryModelRuntimeStats, listPromptsWithLatestVersion,
  queryTpsLeaderboard, queryCacheLeaderboard,
} from '../../src/db/query.js';
import {
  insertUser, insertRole, assignUserRole,
  insertPrompt, insertPromptVersion,
  insertCostLedgerEntry,
} from '../../src/db/query.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': {
      id: 'gpt-4o', name: 'GPT-4o',
      attachment: true, reasoning: false, temperature: true, tool_call: true,
      cost: { input: 2.5, output: 10, cache_read: 1.25 },
      limit: { context: 128000, output: 16384 },
    },
  } },
};

function freshDb(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-qh-'));
  initDb(path.join(tmp, 'test.db'));
  return tmp;
}

async function seedCatalog(): Promise<void> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => MODELS_DEV,
    text: async () => JSON.stringify(MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } finally {
    globalThis.fetch = origFetch;
  }
}

test('listUsersWithRoles returns comma-joined roles per user', async () => {
  const tmp = freshDb();
  try {
    await insertRole({ id: 'viewer', description: 'view' });
    await insertRole({ id: 'admin', description: 'admin' });
    await insertUser({ id: 'u1', username: 'alice', passwordHash: 'h', createdAt: new Date().toISOString() });
    await insertUser({ id: 'u2', username: 'bob', passwordHash: 'h', createdAt: new Date().toISOString() });
    await assignUserRole('u1', 'viewer');
    await assignUserRole('u1', 'admin');
    const users = await listUsersWithRoles();
    const alice = users.find((u: any) => u.username === 'alice');
    const bob = users.find((u: any) => u.username === 'bob');
    assert.ok(alice);
    assert.equal(alice.roles, 'admin,viewer');
    assert.equal(bob?.roles, '');
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('countUserRoles + getUserRolesByUserId honor role/user filters', async () => {
  const tmp = freshDb();
  try {
    await insertRole({ id: 'viewer', description: 'v' });
    await insertRole({ id: 'admin', description: 'a' });
    await insertUser({ id: 'u1', username: 'x', passwordHash: 'h', createdAt: new Date().toISOString() });
    await assignUserRole('u1', 'viewer');
    assert.equal(await countUserRoles(), 1);
    assert.equal(await countUserRoles('viewer'), 1);
    assert.equal(await countUserRoles('admin'), 0);
    assert.equal(await countUserRoles('viewer', 'u1'), 1);
    assert.equal(await countUserRoles('viewer', 'nope'), 0);
    const roles = await getUserRolesByUserId('u1');
    assert.deepEqual(roles.map((r: any) => r.id), ['viewer']);
    assert.deepEqual(await getUserRolesByUserId('nope'), []);
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('listCatalogModels filters + getModelDetail via Drizzle joins', async () => {
  const tmp = freshDb();
  try {
    await seedCatalog();
    const all = await listCatalogModels({});
    assert.equal(all.length, 1);
    assert.equal(all[0].name, 'GPT-4o');
    assert.equal(all[0].input, 2.5);

    const provider = await listCatalogModels({ provider: 'openai' });
    assert.equal(provider.length, 1);
    assert.equal((await listCatalogModels({ provider: 'anthropic' })).length, 0);
    assert.equal((await listCatalogModels({ toolCall: true })).length, 1);
    assert.equal((await listCatalogModels({ reasoning: true })).length, 0);
    assert.equal((await listCatalogModels({ minContext: 200000 })).length, 0);
    assert.equal((await listCatalogModels({ minContext: 1000 })).length, 1);
    assert.equal((await listCatalogModels({ q: 'gpt' })).length, 1);
    assert.equal((await listCatalogModels({ q: 'claude' })).length, 0);
    const byContext = await listCatalogModels({ sort: 'context' });
    assert.equal(byContext.length, 1);

    const detail = await getModelDetail('openai/gpt-4o');
    assert.equal(detail.length, 1);
    assert.equal(detail[0].name, 'GPT-4o');
    assert.equal(detail[0].input, 2.5);
    assert.equal((await getModelDetail('nope')).length, 0);
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('getCostSummary groups by model and by day', async () => {
  const tmp = freshDb();
  try {
    const now = new Date().toISOString();
    const db = getDb();
    for (const runId of ['r1', 'r2', 'r3']) {
      db.prepare(`INSERT INTO runs (run_id, scenario, models, started_at, status, source) VALUES (?, 's', '[]', ?, 'running', 'cli')`)
        .run(runId, now);
    }
    await insertCostLedgerEntry({ runId: 'r1', model: 'gpt-4o', costUsd: 1, inputTokens: 100, outputTokens: 10, recordedAt: now });
    await insertCostLedgerEntry({ runId: 'r2', model: 'gpt-4o', costUsd: 2, inputTokens: 200, outputTokens: 20, recordedAt: now });
    await insertCostLedgerEntry({ runId: 'r3', model: 'claude', costUsd: 5, inputTokens: 500, outputTokens: 50, recordedAt: now });

    const byModel = await getCostSummary('model');
    assert.equal(byModel.length, 2);
    const gpt = byModel.find((r: any) => r.model === 'gpt-4o');
    assert.equal(Number(gpt.total_cost), 3);
    assert.equal(Number(gpt.entry_count), 2);

    const filtered = await getCostSummary('model', 'gpt-4o');
    assert.equal(filtered.length, 1);
    assert.equal(Number(filtered[0].total_cost), 3);

    const byDay = await getCostSummary('day');
    assert.equal(byDay.length, 2);
    assert.ok(byDay.every((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(r.period)));

    const dayFiltered = await getCostSummary('day', 'claude');
    assert.equal(dayFiltered.length, 1);
    assert.equal(dayFiltered[0].model, 'claude');
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('queryModelRuntimeStats filters and limits', async () => {
  const tmp = freshDb();
  try {
    await seedCatalog();
    const db = getDb();
    const base = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO model_runtime_stats (model_id, run_id, tps, success, measured_at) VALUES (?, ?, ?, 1, ?)`)
        .run('openai/gpt-4o', `run-${i}`, i + 1, new Date(Date.now() - i * 60000).toISOString());
    }
    const all = await queryModelRuntimeStats({ limit: 3 });
    assert.equal(all.length, 3);
    const byModel = await queryModelRuntimeStats({ modelId: 'openai/gpt-4o' });
    assert.equal(byModel.length, 5);
    const filtered = await queryModelRuntimeStats({ modelId: 'nope' });
    assert.equal(filtered.length, 0);
    const timeBoxed = await queryModelRuntimeStats({ from: new Date(Date.now() - 120000).toISOString(), to: new Date().toISOString() });
    assert.ok(timeBoxed.length >= 1);
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('queryTpsLeaderboard + queryCacheLeaderboard aggregate via Drizzle', async () => {
  const tmp = freshDb();
  try {
    await seedCatalog();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO model_runtime_stats (model_id, run_id, tps, latency_p50_ms, cache_hit_rate, success, measured_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('openai/gpt-4o', 'run-1', 10, 100, 0.5, now);
    db.prepare(`INSERT INTO model_runtime_stats (model_id, run_id, tps, latency_p50_ms, cache_hit_rate, success, measured_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('openai/gpt-4o', 'run-2', 20, 200, 0.6, now);

    const tps = await queryTpsLeaderboard();
    assert.equal(tps.length, 1);
    assert.equal(tps[0].model_id, 'openai/gpt-4o');
    assert.equal(Number(tps[0].avg_tps), 15);
    assert.equal(Number(tps[0].max_tps), 20);
    assert.equal(Number(tps[0].run_count), 2);

    const lb = await queryCacheLeaderboard();
    assert.equal(lb.length, 1);
    assert.equal(lb[0].name, 'GPT-4o');
    assert.equal(lb[0].input, 2.5);
    assert.equal(Number(lb[0].arena_tps), 15);
    assert.equal(Number(lb[0].arena_runs), 2);
    assert.equal(lb[0].intelligence, null);
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('listPromptsWithLatestVersion merges latest version per prompt', async () => {
  const tmp = freshDb();
  try {
    const now = new Date().toISOString();
    assert.deepEqual(await listPromptsWithLatestVersion(), []);
    await insertPrompt({ id: 'p1', name: 'alpha', description: 'd', createdAt: now, updatedAt: now });
    await insertPromptVersion({ id: 'v1', promptId: 'p1', version: 1, systemPrompt: 's', task: 't', config: null, tag: 'v1', createdAt: now, createdBy: 'u' });
    await insertPromptVersion({ id: 'v2', promptId: 'p1', version: 2, systemPrompt: 's', task: 't', config: null, tag: 'v2', createdAt: now, createdBy: 'u' });
    const rows = await listPromptsWithLatestVersion();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'alpha');
    assert.equal(rows[0].latest_version, 2);
    assert.equal(rows[0].latest_tag, 'v2');
  } finally { closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

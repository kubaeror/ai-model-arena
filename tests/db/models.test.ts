import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../../src/db/client.js';

const PROVIDER_SQL = "INSERT OR REPLACE INTO providers (id, name, api_base, auth_scheme, adapter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))";

const MODEL_SQL = `
  INSERT OR REPLACE INTO models (id, name, provider_id, reasoning, tool_call, context_limit, output_limit, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
`;

test('models table: CRUD round-trips', () => {
  initDb(':memory:');
  const db = getDb();

  db.prepare(PROVIDER_SQL).run('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'bearer', 'openai-compat');
  db.prepare(MODEL_SQL).run('gpt-4o', 'GPT-4o', 'openrouter', 1, 1, 128000, 16384);

  const row = db.prepare(`
    SELECT m.id, m.name, m.provider_id, m.tool_call, p.name as provider_name
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get('gpt-4o') as Record<string, unknown> | undefined;
  assert.ok(row);
  assert.equal(row.name, 'GPT-4o');
  assert.equal(row.provider_name, 'OpenRouter');
  assert.equal(row.tool_call, 1);

  db.prepare("UPDATE models SET output_limit = 32768 WHERE id = 'gpt-4o'").run();
  const updated = db.prepare('SELECT output_limit FROM models WHERE id = ?').get('gpt-4o') as Record<string, unknown>;
  assert.equal(updated.output_limit, 32768);

  closeDb();
});

test('pricing table: associate pricing with model', () => {
  initDb(':memory:');
  const db = getDb();

  db.prepare(PROVIDER_SQL).run('openai', 'OpenAI', null, 'bearer', 'openai-compat');
  db.prepare(MODEL_SQL).run('gpt-4o', 'GPT-4o', 'openai', 1, 1, 128000, 16384);
  db.prepare("INSERT OR REPLACE INTO pricing (model_id, input, output, cache_read, cache_write, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run('gpt-4o', 2.50, 10.00, 1.50, 0.50);

  const row = db.prepare('SELECT input, output, cache_read FROM pricing WHERE model_id = ?').get('gpt-4o') as Record<string, unknown>;
  assert.equal(row.input, 2.50);
  assert.equal(row.output, 10.00);

  closeDb();
});

test('models table: list all models with provider join', () => {
  initDb(':memory:');
  const db = getDb();

  db.prepare(PROVIDER_SQL).run('openai', 'OpenAI', null, 'bearer', 'openai-compat');
  db.prepare(PROVIDER_SQL).run('anthropic', 'Anthropic', null, 'bearer', 'anthropic');
  db.prepare(MODEL_SQL).run('gpt-4o', 'GPT-4o', 'openai', 1, 1, 128000, 16384);
  db.prepare(MODEL_SQL).run('claude-3', 'Claude 3', 'anthropic', 0, 1, 200000, 4096);

  const rows = db.prepare('SELECT m.id, m.name, p.name as provider FROM models m JOIN providers p ON p.id = m.provider_id ORDER BY m.name').all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.name, 'Claude 3');
  assert.equal(rows[1]!.name, 'GPT-4o');
  assert.equal(rows[1]!.provider, 'OpenAI');

  closeDb();
});

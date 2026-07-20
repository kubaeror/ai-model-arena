import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertCustomProvider, listCustomProviders, deleteCustomProvider } from '../../src/providers/custom.js';

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-custom-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('upsertCustomProvider inserts a new custom provider row', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), {
      id: 'my-endpoint', name: 'My Endpoint', apiBase: 'http://localhost:8080/v1',
      authScheme: 'bearer', envVar: 'MY_KEY', adapter: 'openai-compat',
    });
    const list = listCustomProviders(getDb());
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'my-endpoint');
    assert.equal(list[0].is_builtin, 0);
  } finally {
    closeDb();
    cleanup();
  }
});

test('upsertCustomProvider updates existing by id', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), { id: 'p1', name: 'Old', adapter: 'openai-compat', authScheme: 'bearer' });
    upsertCustomProvider(getDb(), { id: 'p1', name: 'New', apiBase: 'http://x/v1', adapter: 'openai-compat', authScheme: 'bearer' });
    const list = listCustomProviders(getDb());
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'New');
    assert.equal(list[0].api_base, 'http://x/v1');
  } finally {
    closeDb();
    cleanup();
  }
});

test('deleteCustomProvider removes a row', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), { id: 'p1', name: 'A', adapter: 'openai-compat', authScheme: 'bearer' });
    deleteCustomProvider(getDb(), 'p1');
    assert.equal(listCustomProviders(getDb()).length, 0);
  } finally {
    closeDb();
    cleanup();
  }
});

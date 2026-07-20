import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { isStale, getCacheStates } from '../../src/catalog/cache.js';

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cache-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('isStale returns true when no cache_state row exists', () => {
  const cleanup = freshDb();
  try {
    assert.equal(isStale(getDb(), 'models.dev'), true);
  } finally {
    closeDb();
    cleanup();
  }
});

test('isStale returns false when next_refresh is in the future', () => {
  const cleanup = freshDb();
  try {
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now.toISOString(), 'ok', future);
    assert.equal(isStale(getDb(), 'models.dev'), false);
  } finally {
    closeDb();
    cleanup();
  }
});

test('isStale returns true when next_refresh is in the past', () => {
  const cleanup = freshDb();
  try {
    const now = new Date();
    const past = new Date(now.getTime() - 1000).toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now.toISOString(), 'ok', past);
    assert.equal(isStale(getDb(), 'models.dev'), true);
  } finally {
    closeDb();
    cleanup();
  }
});

test('getCacheStates returns all cache rows', () => {
  const cleanup = freshDb();
  try {
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now, 'ok', now);
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('modelbench', now, 'ok', now);
    const states = getCacheStates(getDb());
    assert.equal(states.length, 2);
    assert.ok(states.some(s => s.source === 'models.dev'));
    assert.ok(states.some(s => s.source === 'modelbench'));
  } finally {
    closeDb();
    cleanup();
  }
});

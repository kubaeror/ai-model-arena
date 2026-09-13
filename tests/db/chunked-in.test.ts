import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDrizzleDb } from '../../src/db/index.js';
import { chunkedIn } from '../../src/db/query/chunked.js';
import { files } from '../../src/db/schema.js';
import { insertFile } from '../../src/db/query.js';

function insert(id: string): Promise<void> {
  return insertFile({
    id, runId: 'run-1', path: `/out/${id}.json`, model: 'gpt-4o',
    producedAt: '2026-08-03T00:00:00.000Z', producedByTool: 'write',
  });
}

test('chunkedIn splits an id set into multiple IN clauses at the chunk boundary', () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const compiled = db.select().from(files)
    .where(chunkedIn(files.id, ['a', 'b', 'c', 'd', 'e'], 2))
    .toSQL();
  assert.equal((compiled.sql.match(/ in /gi) ?? []).length, 3, 'five ids at size two span three IN clauses');
  assert.equal(compiled.params.length, 5);
  closeDb();
});

test('chunkedIn emits a single IN clause for a single chunk', () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const compiled = db.select().from(files)
    .where(chunkedIn(files.id, ['a', 'b'], 2))
    .toSQL();
  assert.equal((compiled.sql.match(/ in /gi) ?? []).length, 1);
  assert.equal(compiled.params.length, 2);
  closeDb();
});

test('chunkedIn with an empty id set matches nothing', async () => {
  initDb(':memory:');
  await insert('a');
  const db = getDrizzleDb();
  const rows = await db.select().from(files).where(chunkedIn(files.id, []));
  assert.equal(rows.length, 0);
  closeDb();
});

test('chunkedIn returns every matching row across chunk boundaries', async () => {
  initDb(':memory:');
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (const id of ids) await insert(id);
  const db = getDrizzleDb();
  const rows = await db.select().from(files).where(chunkedIn(files.id, ids, 3)) as Array<{ id: string }>;
  assert.deepEqual(rows.map((r) => r.id).sort(), [...ids].sort());
  closeDb();
});

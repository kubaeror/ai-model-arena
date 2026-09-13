import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('chunkedIn splits an id set into multiple IN clauses at the chunk boundary', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const compiled = db.select().from(files)
    .where(chunkedIn(files.id, ['a', 'b', 'c', 'd', 'e'], 2))
    .toSQL();
  assert.equal((compiled.sql.match(/ in /gi) ?? []).length, 3, 'five ids at size two span three IN clauses');
  assert.equal(compiled.params.length, 5);
  await closeDb();
});

test('chunkedIn emits a single IN clause for a single chunk', async () => {
  initDb(':memory:');
  const db = getDrizzleDb();
  const compiled = db.select().from(files)
    .where(chunkedIn(files.id, ['a', 'b'], 2))
    .toSQL();
  assert.equal((compiled.sql.match(/ in /gi) ?? []).length, 1);
  assert.equal(compiled.params.length, 2);
  await closeDb();
});

test('chunkedIn with an empty id set matches nothing', async () => {
  initDb(':memory:');
  await insert('a');
  const db = getDrizzleDb();
  const rows = await db.select().from(files).where(chunkedIn(files.id, []));
  assert.equal(rows.length, 0);
  await closeDb();
});

test('chunkedIn returns every matching row across chunk boundaries', async () => {
  initDb(':memory:');
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (const id of ids) await insert(id);
  const db = getDrizzleDb();
  const rows = await db.select().from(files).where(chunkedIn(files.id, ids, 3)) as Array<{ id: string }>;
  assert.deepEqual(rows.map((r) => r.id).sort(), [...ids].sort());
  await closeDb();
});

test('chunkedIn clamps a fractional size instead of looping forever', () => {
  // A fractional size floors to 0 and the `i += chunkSize` loop never
  // advances; run in a child so the hang is killed by the timeout instead of
  // stalling the test runner.
  const code = `Promise.all([
    import(${JSON.stringify(new URL('../../src/db/query/chunked.ts', import.meta.url).href)}),
    import(${JSON.stringify(new URL('../../src/db/schema.ts', import.meta.url).href)}),
  ]).then(([m, s]) => { m.chunkedIn(s.files.id, ['a', 'b', 'c'], 0.5); console.log('OK'); });`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined, `chunkedIn must not hang: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? ''}`);
  assert.equal(result.status, 0, `expected status 0: ${result.stderr}`);
  assert.match(result.stdout, /OK/);
});

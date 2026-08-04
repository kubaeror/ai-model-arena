import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { initDb, closeDb } from '../../src/db/index.js';
import { paginate, insertFile } from '../../src/db/query.js';
import { files } from '../../src/db/schema.js';

const fileColumns = {
  id: files.id,
  run_id: files.run_id,
  model: files.model,
  produced_at: files.produced_at,
  produced_by_tool: files.produced_by_tool,
};

afterEach(async () => {
  await closeDb();
});

async function seed(count: number, model = 'gpt-4o', base = 0): Promise<void> {
  for (let i = 0; i < count; i++) {
    const n = base + i;
    await insertFile({
      id: `f-${String(n).padStart(3, '0')}`,
      runId: 'run-1',
      path: `/out/f-${String(n).padStart(3, '0')}.json`,
      model,
      producedAt: `2026-08-03T00:00:${String(n).padStart(2, '0')}.000Z`,
      producedByTool: 'write',
    });
  }
}

test('paginate orders rows ascending with total count', async () => {
  initDb(':memory:');
  await seed(25);
  const page = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', page: 1, pageSize: 10 });
  assert.equal(page.total, 25);
  assert.equal(page.rows.length, 10);
  assert.equal(page.rows[0]!.id, 'f-000');
  assert.equal(page.rows[9]!.id, 'f-009');
});

test('paginate orders rows descending', async () => {
  initDb(':memory:');
  await seed(25);
  const page = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'desc', page: 1, pageSize: 10 });
  assert.equal(page.rows[0]!.id, 'f-024');
  assert.equal(page.rows[9]!.id, 'f-015');
});

test('paginate offsets across pages via page/pageSize', async () => {
  initDb(':memory:');
  await seed(25);
  const p2 = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', page: 2, pageSize: 10 });
  assert.equal(p2.rows[0]!.id, 'f-010');
  const p3 = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', page: 3, pageSize: 10 });
  assert.equal(p3.rows.length, 5);
  assert.equal(p3.rows[4]!.id, 'f-024');
});

test('paginate accepts an explicit offset (route-style limit/offset)', async () => {
  initDb(':memory:');
  await seed(25);
  const off = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', pageSize: 10, offset: 20 });
  assert.equal(off.rows.length, 5);
  assert.equal(off.rows[0]!.id, 'f-020');
  assert.equal(off.total, 25);
});

test('paginate handles pageSize larger than the row count', async () => {
  initDb(':memory:');
  await seed(25);
  const all = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', pageSize: 100 });
  assert.equal(all.rows.length, 25);
  assert.equal(all.total, 25);
});

test('paginate falls back to the first column when orderBy is omitted', async () => {
  initDb(':memory:');
  await seed(25);
  const page = await paginate(files, fileColumns, { pageSize: 10 });
  assert.equal(page.total, 25);
  assert.equal(page.rows.length, 10);
  assert.equal(page.rows[0]!.id, 'f-000');
});

test('paginate applies a where filter to rows and total', async () => {
  initDb(':memory:');
  await seed(5, 'gpt-4o');
  await seed(3, 'claude-3', 100);
  const page = await paginate(files, fileColumns, { orderBy: 'produced_at', dir: 'asc', where: eq(files.model, 'claude-3'), pageSize: 10 });
  assert.equal(page.total, 3);
  assert.equal(page.rows.length, 3);
  assert.equal(page.rows[0]!.model, 'claude-3');
});

test('paginate rejects orderBy keys outside the column map (no SQL injection)', async () => {
  initDb(':memory:');
  await seed(3);
  await assert.rejects(
    async () => paginate(files, fileColumns, { orderBy: 'id; DROP TABLE files', pageSize: 10 }),
    /unknown column/,
  );
});

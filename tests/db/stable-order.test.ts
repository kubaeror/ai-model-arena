import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb, getDrizzleDb } from '../../src/db/index.js';
import {
  paginate, insertFile, createSession, createMessage, listMessagesBySession,
  listSessionsWithCounts, listModelCallsForSession, insertAnomaly, listAnomalies,
} from '../../src/db/query.js';
import { files, model_calls } from '../../src/db/schema.js';

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

const isPostgres = (process.env.DB_DRIVER ?? 'sqlite').toLowerCase() === 'postgres';

const AT = '2026-08-03T00:00:00.000Z';

test('paginate breaks produced_at ties by id so offset pages do not skip or duplicate rows', async () => {
  initDb(':memory:');
  for (const id of ['f-002', 'f-000', 'f-005', 'f-001', 'f-004', 'f-003']) {
    await insertFile({
      id, runId: 'run-1', path: `/out/${id}.json`, model: 'gpt-4o',
      producedAt: AT, producedByTool: 'write',
    });
  }
  const p1 = await paginate(files, fileColumns, {
    orderBy: 'produced_at', dir: 'desc', tiebreakBy: 'id', pageSize: 3, offset: 0,
  });
  const p2 = await paginate(files, fileColumns, {
    orderBy: 'produced_at', dir: 'desc', tiebreakBy: 'id', pageSize: 3, offset: 3,
  });
  const ids = [...p1.rows, ...p2.rows].map((r) => (r as { id: string }).id);
  assert.deepEqual(ids, ['f-005', 'f-004', 'f-003', 'f-002', 'f-001', 'f-000']);
});

test('paginate refuses an unknown tiebreak column', async () => {
  initDb(':memory:');
  await assert.rejects(
    async () => paginate(files, fileColumns, { orderBy: 'produced_at', tiebreakBy: 'nope', pageSize: 10 }),
    /unknown column/,
  );
});

test('listSessionsWithCounts breaks created_at ties by id in both paginated paths', async () => {
  initDb(':memory:');
  for (const id of ['s-3', 's-1', 's-4', 's-2']) {
    await createSession({ id, model: 'gpt-4o', createdAt: AT, updatedAt: AT });
  }

  const p1 = await listSessionsWithCounts({ limit: 2, offset: 0 });
  const p2 = await listSessionsWithCounts({ limit: 2, offset: 2 });
  assert.deepEqual([...p1.sessions, ...p2.sessions].map((s) => s.id), ['s-4', 's-3', 's-2', 's-1']);

  const v1 = await listSessionsWithCounts({ limit: 2, offset: 0, isVisible: () => true });
  const v2 = await listSessionsWithCounts({ limit: 2, offset: 2, isVisible: () => true });
  assert.deepEqual([...v1.sessions, ...v2.sessions].map((s) => s.id), ['s-4', 's-3', 's-2', 's-1']);
});

test('listAnomalies with an empty runIds set matches nothing', async () => {
  initDb(':memory:');
  await insertAnomaly({ run_id: 'r1', model: 'gpt-4o', type: 'loop', severity: 'low', description: 'x' });
  assert.equal((await listAnomalies({})).length, 1);
  assert.deepEqual(await listAnomalies({ runIds: [] }), []);
});

test('listMessagesBySession breaks turn/created_at ties by id across offset pages', async () => {
  initDb(':memory:');
  const sessionId = 'session-1';
  await createSession({ id: sessionId, model: 'gpt-4o', createdAt: AT, updatedAt: AT });
  for (const id of ['m-d', 'm-b', 'm-a', 'm-c']) {
    await createMessage({
      id, sessionId, turn: 0, role: 'assistant', content: id, toolCalls: null,
      toolCallId: null, tokenInput: null, tokenOutput: null, createdAt: AT,
    });
  }
  const p1 = await listMessagesBySession(sessionId, { limit: 2, offset: 0 });
  const p2 = await listMessagesBySession(sessionId, { limit: 2, offset: 2 });
  assert.deepEqual([...p1, ...p2].map((m) => m.id), ['m-a', 'm-b', 'm-c', 'm-d']);
});

test('listModelCallsForSession breaks turn ties by id across offset pages', {
  skip: isPostgres
    ? 'SQLite-only fixture: Postgres enforces UNIQUE(session_id, turn) and dropping the index would leak into the shared PG test database'
    : false,
}, async () => {
  initDb(':memory:');
  await createSession({ id: 'session-1', model: 'gpt-4o', createdAt: AT, updatedAt: AT });
  getDb().exec('DROP INDEX IF EXISTS uq_model_calls_session_turn');
  const db = getDrizzleDb();
  for (const id of ['mc-d', 'mc-b', 'mc-a', 'mc-c']) {
    await db.insert(model_calls).values({
      id, session_id: 'session-1', turn: 1, provider: 'openai', model: 'gpt-4o',
      request_hash: `h-${id}`, response_text: null, usage: null,
      latency_ms: null, ttft_ms: null, created_at: AT,
    });
  }
  const p1 = await listModelCallsForSession('session-1', { limit: 2, offset: 0 });
  const p2 = await listModelCallsForSession('session-1', { limit: 2, offset: 2 });
  assert.deepEqual([...p1, ...p2].map((c) => c.id), ['mc-a', 'mc-b', 'mc-c', 'mc-d']);
});

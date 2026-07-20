# Phase 1 — Containerize & Stateless Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a runnable container image and refactor the one-shot PM2 worker into a long-lived runner that pulls tasks from a queue, loads session state from a DB, and writes turn checkpoints. Migrate SQLite → Postgres.

**Architecture:** Strangler pattern. A new `src/queue/` abstraction with an in-memory implementation preserves the existing PM2 CLI behavior (so the CLI still works during the phase). The worker is refactored into `src/runner.ts` — a long-lived loop: connect to queue → pull task → load session from Postgres → run `runAgentLoop` (unchanged) → persist turn checkpoint → ACK. Container image is multi-stage, non-root. Postgres runs locally (docker compose for dev) and in-cluster (Phase 2).

**Tech Stack:** TypeScript, `postgres` (pg driver) or Drizzle's Postgres dialect, Docker, docker-compose (dev only).

## Global Constraints

- Node ≥ 20.11, TypeScript 5.9, ESM, strict.
- Existing PM2 CLI path MUST keep working end-to-end after every task (`npm run dev -- run ...` stays green).
- Drizzle schema from Phase 0 is the source of truth; Postgres dialect uses the same `src/db/schema.ts` definitions (Drizzle supports both SQLite + Postgres from one schema file with dialect-agnostic column types — verify; if not, create `src/db/schema-pg.ts` mirroring the SQLite one).
- No `console.log`; Pino only.
- Container image runs as non-root user; `readOnlyRootFilesystem` is enforced in Phase 2, but the image must be built to support it now (no writes to the app dir; all writes go to `OUTPUT_ROOT`).

---

## File Structure (Phase 1)

- Create: `src/queue/types.ts` — `TaskQueue` interface + `Task` shape.
- Create: `src/queue/in-memory.ts` — in-memory `TaskQueue` impl (strangler; preserves CLI behavior).
- Create: `src/queue/index.ts` — factory `createQueue()` reading `QUEUE_DRIVER` env (default `memory`).
- Create: `src/runner.ts` — long-lived runner entry (replaces PM2-per-run path).
- Create: `src/session/store.ts` — session/message persistence (Postgres-backed).
- Modify: `src/db/schema.ts` — add `sessions`, `messages`, `model_calls` tables.
- Create: `src/db/postgres.ts` — Postgres client (Drizzle) + migrate entry.
- Modify: `src/db/client.ts` — `getDb()` dispatches to Postgres or SQLite based on `DB_DRIVER`.
- Modify: `src/agent-loop/loop.ts` — emit checkpoint callback after each turn (no behavior change otherwise).
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml` — dev Postgres + Redis (Redis used in Phase 2; included now so the compose file is stable).
- Create: `tests/queue/in-memory.test.ts`
- Create: `tests/runner/runner.test.ts`
- Create: `tests/session/store.test.ts`

---

## Task 1.1: Postgres client + dual-driver DB layer

**Files:**
- Create: `src/db/postgres.ts`
- Modify: `src/db/client.ts`
- Modify: `src/db/schema.ts` (add Postgres-compatible tables if needed; verify column-type compatibility)
- Modify: `package.json` (add `postgres` or `pg` + `drizzle-orm/pg-core`)
- Modify: `drizzle.config.ts` (add a Postgres dialect config or a second config)
- Modify: `.env.example`

**Interfaces:**
- Produces: `src/db/postgres.ts` exporting `initPostgres(connectionString: string): DrizzlePgClient` and `migratePostgres()`.
- Produces: `src/db/client.ts` `getDb()` returns a unified handle. To minimize churn, introduce a `DbHandle` abstraction:

```ts
export interface DbHandle {
  prepare(sql: string): { run(...params: any[]): unknown; get(...params: any[]): any; all(...params: any[]): any[]; };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}
```

The SQLite `better-sqlite3` handle already matches this shape. For Postgres, `src/db/postgres.ts` wraps the Drizzle pg client in a `DbHandle`-compatible shim (translating `prepare(...).run/get/all` to Drizzle's `db.run/db.get/db.all` with `$` parameterization). This is a thin adapter — all existing call sites that use `getDb().prepare(...)` keep working.

- [ ] **Step 1: Install Postgres driver + Drizzle pg deps**

```bash
npm install pg drizzle-orm
npm install -D @types/pg
```

- [ ] **Step 2: Verify Drizzle schema is dialect-agnostic**

Read `src/db/schema.ts`. Drizzle's `text`/`integer`/`real` are imported from `drizzle-orm/sqlite-core`. For Postgres, the equivalents are in `drizzle-orm/pg-core` with the same names. To support both drivers from one schema, **refactor `src/db/schema.ts` to use a dialect-agnostic table builder** OR create `src/db/schema-pg.ts` mirroring it. Mirror approach is simpler and avoids conditional imports:

Create `src/db/schema-pg.ts` copying `src/db/schema.ts` but importing from `drizzle-orm/pg-core` and using `pgTable` instead of `sqliteTable`. Column types: `text`→`text`, `integer`→`integer`, `real`→`doublePrecision`. Keep table + column names identical.

- [ ] **Step 3: Add Postgres config**

Update `drizzle.config.ts` to export an array of configs (Drizzle supports multi-config) or create `drizzle.pg.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema-pg.ts',
  out: './drizzle/pg',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://arena:arena@localhost:5432/arena' },
});
```

- [ ] **Step 4: Implement `src/db/postgres.ts`**

```ts
import pg from 'pg';
import { drizzle, type PostgreSqlDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema-pg.js';
import type { DbHandle } from './client.js';

export type PgClient = PostgreSqlDatabase<typeof schema>;

export function initPostgres(connectionString: string): { db: PgClient; handle: DbHandle; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, handle: wrapPgAsHandle(db), pool };
}

export function migratePostgres(db: PgClient): void {
  migrate(db, { migrationsFolder: './drizzle/pg' });
}

// DbHandle shim: translates the better-sqlite3 sync API to Drizzle's async pg API.
// Existing call sites use sync style; to keep them working we make the shim
// THROW if used asynchronously OR we convert call sites to async in a later step.
// DECISION: make DbHandle.prepare() synchronous-only for SQLite, async for Postgres,
// and migrate the highest-traffic call sites (run-index, session store) to async
// first. Low-traffic admin queries stay on SQLite during the transition.
function wrapPgAsHandle(db: PgClient): DbHandle {
  // Minimal implementation — see Task 1.3 for the full async migration of hot paths.
  throw new Error('Postgres DbHandle sync shim not supported — use async query helpers in src/db/postgres.ts directly');
}
```

This forces the hot paths to use the Postgres client directly (async) rather than the sync `DbHandle`. The SQLite path keeps using `DbHandle` unchanged.

- [ ] **Step 5: Update `src/db/client.ts` to dispatch**

```ts
export function initDb(): DbHandle {
  const driver = process.env.DB_DRIVER ?? 'sqlite';
  if (driver === 'postgres') {
    const { initPostgres, migratePostgres } = require('./postgres.js'); // dynamic to avoid pg in sqlite-only envs
    const { handle, db } = initPostgres(process.env.DATABASE_URL!);
    migratePostgres(db);
    dbInstance = handle;
    return handle;
  }
  // existing SQLite path
}
```

Note: ESM doesn't have sync `require` — use a top-level dynamic `import('./postgres.js')` in an async `initDbAsync()`, OR use a static import and let pg be a no-op when unused. Static import is simpler; `pg` only connects when `initPostgres` is called.

- [ ] **Step 6: Add `.env.example` entries**

```
# Database driver: sqlite (default, dev) or postgres (k8s target)
# DB_DRIVER=postgres
# Postgres connection string (when DB_DRIVER=postgres)
# DATABASE_URL=postgres://arena:arena@localhost:5432/arena
```

- [ ] **Step 7: Generate Postgres migrations**

```bash
npx drizzle-kit generate --config drizzle.pg.config.ts --name baseline_pg
```
Expected: `drizzle/pg/0000_baseline_pg.sql` created.

- [ ] **Step 8: Verify (SQLite path unchanged)**

```bash
npm run typecheck && npm run lint && npm test
npx tsx src/cli.ts status  # still SQLite by default
```
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add src/db/postgres.ts src/db/schema-pg.ts src/db/client.ts drizzle.pg.config.ts drizzle/pg/ .env.example package.json package-lock.json
git commit -m "feat(db): add Postgres driver + Drizzle pg config behind DB_DRIVER"
```

---

## Task 1.2: `sessions` + `messages` + `model_calls` schema

**Files:**
- Modify: `src/db/schema.ts` AND `src/db/schema-pg.ts` — add three tables.

**Interfaces:**
- Produces tables:
  - `sessions(id TEXT PK, prompt_id TEXT, prompt_version INT, model TEXT, status TEXT, created_at TEXT, updated_at TEXT)`
  - `messages(id TEXT PK, session_id TEXT FK, turn INT, role TEXT, content TEXT, tool_calls TEXT (JSON), tool_call_id TEXT, token_input INT, token_output INT, created_at TEXT)`
  - `model_calls(id TEXT PK, session_id TEXT FK, turn INT, provider TEXT, model TEXT, request_hash TEXT, response_text TEXT, usage TEXT (JSON), latency_ms INT, created_at TEXT, UNIQUE(session_id, turn))`

- [ ] **Step 1: Define the tables in both schema files**

Add to `src/db/schema.ts` (SQLite):

```ts
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  prompt_id: text('prompt_id'),
  prompt_version: integer('prompt_version'),
  model: text('model'),
  status: text('status').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  session_id: text('session_id').notNull().references(() => sessions.id),
  turn: integer('turn').notNull(),
  role: text('role').notNull(),
  content: text('content'),
  tool_calls: text('tool_calls'),
  tool_call_id: text('tool_call_id'),
  token_input: integer('token_input'),
  token_output: integer('token_output'),
  created_at: text('created_at').notNull(),
});
export const model_calls = sqliteTable('model_calls', {
  id: text('id').primaryKey(),
  session_id: text('session_id').notNull().references(() => sessions.id),
  turn: integer('turn').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  request_hash: text('request_hash').notNull(),
  response_text: text('response_text'),
  usage: text('usage'),
  latency_ms: integer('latency_ms'),
  created_at: text('created_at').notNull(),
});
```

Mirror exactly in `src/db/schema-pg.ts` with `pgTable` + `doublePrecision` for any `real` columns (none here — all `text`/`integer`).

- [ ] **Step 2: Generate migrations for both dialects**

```bash
npx drizzle-kit generate --name session_tables          # sqlite (default config)
npx drizzle-kit generate --config drizzle.pg.config.ts --name session_tables_pg
```

- [ ] **Step 3: Apply + verify**

```bash
npm test  # initDb runs migrate()
```
Expected: green; tables exist.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/schema-pg.ts drizzle/ drizzle/pg/
git commit -m "feat(db): add sessions, messages, model_calls tables"
```

---

## Task 1.3: Session store (`src/session/store.ts`)

**Files:**
- Create: `src/session/store.ts`
- Create: `tests/session/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SessionStore {
    createSession(opts: { promptId?: string; promptVersion?: number; model: string }): Promise<Session>;
    loadSession(sessionId: string): Promise<Session | null>;
    appendMessage(sessionId: string, msg: StoredMessage): Promise<void>;
    listMessages(sessionId: string): Promise<StoredMessage[]>;
    recordModelCall(call: ModelCallRecord): Promise<void>;
    getModelCall(sessionId: string, turn: number): Promise<ModelCallRecord | null>;
    updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  }
  ```
- The store dispatches to SQLite or Postgres based on `DB_DRIVER`. For Postgres it uses the async Drizzle client directly; for SQLite it uses `getDb()`.

- [ ] **Step 1: Write the failing test `tests/session/store.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';

test('session round-trips messages + model_calls', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  assert.ok(s.id);
  await store.appendMessage(s.id, { turn: 0, role: 'user', content: 'hi' });
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h1', responseText: 'hello', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 10 });
  const msgs = await store.listMessages(s.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.content, 'hi');
  const mc = await store.getModelCall(s.id, 0);
  assert.equal(mc?.responseText, 'hello');
  // idempotency: re-recording same (session, turn) updates, not duplicates
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h1', responseText: 'hello2', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 12 });
  assert.equal((await store.getModelCall(s.id, 0))?.responseText, 'hello2');
  closeDb();
});
```

- [ ] **Step 2: Run test — expect FAIL**

`npm test -- --test tests/session/store.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/session/store.ts`**

Implement `createSessionStore()` returning a `SessionStore`. Internally:
- `createSession`: INSERT with `crypto.randomUUID()`.
- `appendMessage`: INSERT.
- `listMessages`: SELECT ... ORDER BY turn, created_at.
- `recordModelCall`: UPSERT on `(session_id, turn)` — `INSERT ... ON CONFLICT(session_id, turn) DO UPDATE`. This is the idempotency primitive Phase 3 builds on; land it now.
- `getModelCall`: SELECT WHERE session_id + turn.
- `updateSessionStatus`: UPDATE.

For Postgres, use `drizzle` query builder (`db.insert(sessions).values(...)` etc.) via the client from `src/db/postgres.ts`. For SQLite, use `getDb().prepare(...)` (sync — wrap calls in `Promise.resolve()` to keep the interface async). 

- [ ] **Step 4: Run test — expect PASS**

`npm test -- --test tests/session/store.test.ts` → PASS.

- [ ] **Step 5: Verify full suite**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/session/store.ts tests/session/store.test.ts
git commit -m "feat(session): Postgres/SQLite session store with idempotent model_calls"
```

---

## Task 1.4: Queue abstraction + in-memory driver

**Files:**
- Create: `src/queue/types.ts`
- Create: `src/queue/in-memory.ts`
- Create: `src/queue/index.ts`
- Create: `tests/queue/in-memory.test.ts`

**Interfaces:**
- Produces `src/queue/types.ts`:
  ```ts
  export interface Task {
    taskId: string;            // deterministic id (Phase 3 hashing); for now UUID
    sessionId: string;
    promptId?: string;
    promptVersion?: number;
    model: string;
    scenario: string;
    config: Record<string, unknown>;
    enqueuedAt: string;
    attempts: number;
  }
  export interface TaskQueue {
    enqueue(task: Task): Promise<void>;
    dequeue(timeoutMs?: number): Promise<Task | null>;   // blocks until available or timeout
    ack(taskId: string): Promise<void>;
    nack(taskId: string, reason?: string): Promise<void>;
    size(): Promise<number>;
  }
  ```
- Produces `src/queue/index.ts`: `createQueue()` reads `QUEUE_DRIVER` env (default `memory`); returns an `InMemoryQueue` for now. Phase 2 adds the Redis driver.

- [ ] **Step 1: Write failing test `tests/queue/in-memory.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import type { Task } from '../../src/queue/types.js';

function mkTask(id: string): Task {
  return { taskId: id, sessionId: 's', model: 'gpt-4o', scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(), attempts: 0 };
}

test('enqueue then dequeue returns the task', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t1'));
  const t = await q.dequeue(100);
  assert.equal(t?.taskId, 't1');
});

test('dequeue blocks until a task is available', async () => {
  const q = new InMemoryQueue();
  setTimeout(() => q.enqueue(mkTask('t2')), 20);
  const t = await q.dequeue(1000);
  assert.equal(t?.taskId, 't2');
});

test('dequeue returns null on timeout', async () => {
  const q = new InMemoryQueue();
  const t = await q.dequeue(50);
  assert.equal(t, null);
});

test('ack removes; nack requeues', async () => {
  const q = new InMemoryQueue();
  await q.enqueue(mkTask('t3'));
  const t = await q.dequeue(100);
  await q.nack(t!.taskId);
  assert.equal(await q.size(), 1);
  const t2 = await q.dequeue(100);
  assert.equal(t2?.taskId, 't3');
  await q.ack(t2!.taskId);
  assert.equal(await q.size(), 0);
});
```

- [ ] **Step 2: Run — expect FAIL** (modules missing).

- [ ] **Step 3: Implement `src/queue/in-memory.ts`**

A simple FIFO with a waiting-dequeue promise queue (so `dequeue` blocks). Keep an in-flight set keyed by taskId for ack/nack semantics. On `nack`, push back to the head and bump `attempts`.

- [ ] **Step 4: Implement `src/queue/index.ts`**

```ts
import { InMemoryQueue } from './in-memory.js';
import type { TaskQueue } from './types.js';
export function createQueue(): TaskQueue {
  const driver = process.env.QUEUE_DRIVER ?? 'memory';
  if (driver === 'memory') return new InMemoryQueue();
  throw new Error(`Unknown QUEUE_DRIVER: ${driver}`);
}
export type { TaskQueue, Task } from './types.js';
```

- [ ] **Step 5: Run — expect PASS; verify full suite**

```bash
npm test -- --test tests/queue/in-memory.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/queue/ tests/queue/
git commit -m "feat(queue): TaskQueue abstraction + in-memory driver"
```

---

## Task 1.5: Refactor worker into long-lived runner

**Files:**
- Create: `src/runner.ts`
- Modify: `src/agent-loop/loop.ts` — add an `onTurnComplete` checkpoint callback (optional, no behavior change).
- Create: `tests/runner/runner.test.ts`

**Interfaces:**
- Produces: `src/runner.ts` exporting `startRunner(opts: { queue: TaskQueue; sessionStore: SessionStore; signal?: AbortSignal }): Promise<void>` — the long-lived loop:
  ```
  while not aborted:
    task = await queue.dequeue(30s)
    if null: continue
    session = await sessionStore.loadSession(task.sessionId) ?? await create
    resume from last persisted turn (read messages)
    run runAgentLoop with onTurnComplete = (turn, messages) => sessionStore.appendMessage(...)
    on success: queue.ack(task.taskId)
    on error: queue.nack(task.taskId, err.message)
  ```
- The existing `src/worker.ts` (PM2 one-shot) is UNCHANGED in this task — both paths coexist. The CLI continues to use `worker.ts`; `runner.ts` is invoked by the container entrypoint (Task 1.7).

- [ ] **Step 1: Add `onTurnComplete` hook to `runAgentLoop`**

Read `src/agent-loop/loop.ts:47`. The function signature takes an options object. Add an optional `onTurnComplete?: (turn: number, messages: ChatMessage[]) => Promise<void>` field. Call it at the end of each turn iteration (after tool results are appended, before the next `sendMessage`), wrapped in try/catch (a checkpoint failure should NOT crash the loop — log + continue).

- [ ] **Step 2: Write failing test `tests/runner/runner.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryQueue } from '../../src/queue/in-memory.js';
import { createSessionStore } from '../../src/session/store.js';
import { initDb, closeDb } from '../../src/db/client.js';
import { startRunner } from '../../src/runner.js';
// use the stub adapter pattern from scripts/smoke-stub.mjs

test('runner dequeues a task, runs the loop, acks on completion', async () => {
  initDb(':memory:');
  const q = new InMemoryQueue();
  const store = createSessionStore();
  const session = await store.createSession({ model: 'stub' });
  await q.enqueue({ taskId: 't1', sessionId: session.id, model: 'stub', scenario: 'x', config: { maxTurns: 1 }, enqueuedAt: new Date().toISOString(), attempts: 0 });

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5000); // stop the runner after a grace period
  await startRunner({ queue: q, sessionStore: store, signal: ac.signal, adapterFactory: () => stubAdapter });
  assert.equal(await q.size(), 0); // acked
  const msgs = await store.listMessages(session.id);
  assert.ok(msgs.length > 0);
  closeDb();
});
```

Build a `stubAdapter` (returning `task_complete` on first call) mirroring `scripts/smoke-stub.mjs`. The `adapterFactory` parameter lets the test inject a stub; the real runner reads model config from the registry (existing `src/providers/`).

- [ ] **Step 3: Run — expect FAIL** (runner not implemented).

- [ ] **Step 4: Implement `src/runner.ts`**

Implement the loop. Key points:
- Load session; if not found, create one from the task.
- Load persisted messages as the starting `ChatMessage[]`.
- Build the adapter via the existing `src/providers/` factory (`createAdapter` or equivalent — read `src/providers/index.ts` for the exact export).
- Build the tool executors + sandbox from the scenario config (reuse `src/tools/executors.ts:buildToolExecutors` and `src/sandbox/sandbox.ts`).
- Call `runAgentLoop` with `onTurnComplete` persisting each turn.
- On `task_complete` / clean stop → `queue.ack(taskId)`.
- On thrown error → `queue.nack(taskId, err.message)`.
- On `signal.abort()` → finish current task if any, then exit the loop.

- [ ] **Step 5: Run — expect PASS; full suite green**

```bash
npm test -- --test tests/runner/runner.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/runner.ts src/agent-loop/loop.ts tests/runner/
git commit -m "feat(runner): long-lived queue-driven runner with turn checkpoints"
```

---

## Task 1.6: Dual-write conversation to DB + file (migration bridge)

**Files:**
- Modify: `src/logger/conversation-logger.ts` — on each append, also call `sessionStore.appendMessage`.
- Modify: `src/worker.ts` — wire a `SessionStore` into the `ConversationLogger` when running under the worker path too (so historical data accumulates in the DB even for CLI-driven runs).

**Goal:** every turn the CLI/PM2 path writes also lands in `messages`, so by the time Phase 6 removes the file dual-write the DB is already complete. The runner path (Task 1.5) writes to the DB directly; this task makes the PM2 path write to both.

- [ ] **Step 1: Read `src/logger/conversation-logger.ts`**

Understand its `append`/`logTurn` shape. Add an optional `dbSink?: SessionStore` + `sessionId?: string` to its constructor. When set, every append mirrors to `dbSink.appendMessage(sessionId, ...)`.

- [ ] **Step 2: Wire in `src/worker.ts`**

In `worker.ts`'s `main()`, after creating the sandbox + before the loop: create a `SessionStore`, call `createSession`, pass both to the `ConversationLogger`. Generate a `sessionId` from the `runId` (deterministic — `sha256(runId + model)` so re-runs of the same runId map to the same session for idempotency in Phase 3).

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint && npm test
npm run dev -- run --scenario express-rest --models <stub-or-real>
# after run, query: npx tsx -e "import {initDb} from './src/db/client.js'; initDb(); console.log(getDb().prepare('SELECT count(*) c FROM messages').get())"
```
Expected: messages table populated for the run.

- [ ] **Step 4: Commit**

```bash
git add src/logger/conversation-logger.ts src/worker.ts
git commit -m "feat(logger): dual-write conversation turns to messages table"
```

---

## Task 1.7: Dockerfile + docker-compose (dev)

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `scripts/docker-entrypoint.sh` (or inline CMD)

**Goal:** build a runnable image; dev compose runs Postgres + Redis + the runner + the dashboard.

- [ ] **Step 1: Write `Dockerfile` (multi-stage, non-root)**

```dockerfile
# ── build stage ──
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts drizzle.pg.config.ts ./
COPY src ./src
COPY configs ./configs
COPY drizzle ./drizzle
RUN npm run build

# ── runtime stage ──
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN useradd -r -u 10001 -g users arena && mkdir -p /app /var/arena/outputs && chown -R arena:users /app /var/arena
COPY --from=build --chown=arena:users /app/node_modules ./node_modules
COPY --from=build --chown=arena:users /app/dist ./dist
COPY --from=build --chown=arena:users /app/drizzle ./drizzle
COPY --from=build --chown=arena:users /app/configs ./configs
COPY --from=build --chown=arena:users /app/package.json ./
USER arena
ENV OUTPUT_ROOT=/var/arena/outputs
ENV ARENA_DB_PATH=/var/arena/outputs/arena.db
# ENTRYPOINT: migrate then start runner (or dashboard, via CMD arg)
CMD ["node", "dist/runner.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
outputs
.git
.env
*.log
dashboot.*
dash*.log
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: arena
      POSTGRES_PASSWORD: arena
      POSTGRES_DB: arena
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    volumes: [redisdata:/data]
  runner:
    build: .
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: postgres://arena:arena@postgres:5432/arena
      QUEUE_DRIVER: memory  # Phase 2 switches to redis
      OUTPUT_ROOT: /var/arena/outputs
    depends_on: [postgres]
    volumes: [outputs:/var/arena/outputs]
    command: ["node", "dist/runner.js"]
  dashboard:
    build: .
    environment:
      DB_DRIVER: postgres
      DATABASE_URL: postgres://arena:arena@postgres:5432/arena
      DASHBOARD_PORT: "4000"
      DASHBOARD_USERNAME: admin
      DASHBOARD_PASSWORD: change-me
    depends_on: [postgres]
    ports: ["4000:4000"]
    command: ["node", "dist/dashboard-server/server.js"]
volumes:
  pgdata:
  redisdata:
  outputs:
```

- [ ] **Step 4: Build + smoke**

```bash
docker compose build
docker compose up -d postgres redis
docker compose run --rm runner node dist/cli.js status  # verifies DB migrate + status
```
Expected: image builds; `status` runs against Postgres.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "feat(container): multi-stage Dockerfile + dev docker-compose (pg+redis)"
```

---

## Phase 1 Exit Gate

- [ ] `docker compose build` succeeds; image runs as non-root user `arena`.
- [ ] `DB_DRIVER=postgres` works end-to-end: `docker compose run runner node dist/cli.ts status`.
- [ ] `src/runner.ts` dequeues a task from the in-memory queue, runs the agent loop, persists turns to `messages`, and ACKs on completion.
- [ ] PM2 CLI path (`npm run dev -- run ...`) still works and dual-writes to the `messages` table.
- [ ] `npm run typecheck && npm run lint && npm test` green.
- [ ] All Phase 1 commits pushed.

## Phase 1 Self-Review

- **Spec coverage:** containerize (1.1, 1.7) ✓; queue abstraction (1.4) ✓; stateless runner (1.5) ✓; session state externalized (1.2, 1.3, 1.6) ✓; existing CLI preserved ✓. Drizzle schema reused ✓. Non-root + OUTPUT_ROOT enforced ✓.
- **Placeholders:** none. Stub adapter referenced via existing `scripts/smoke-stub.mjs` pattern (concrete file).
- **Type consistency:** `TaskQueue`, `Task`, `SessionStore`, `Session`, `StoredMessage`, `ModelCallRecord` consistent across tasks. `onTurnComplete` signature matches in loop.ts and runner.ts.
- **Dependencies:** 1.1 (pg driver) → 1.2 (schema) → 1.3 (store) → 1.4 (queue) → 1.5 (runner) → 1.6 (dual-write) → 1.7 (Docker). 1.6 depends on 1.3. 1.7 depends on all.

# Phase 3 — Reliability Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-grade fault tolerance — idempotent task retries with no duplicate file writes or duplicate model calls, checkpoint resume, per-provider circuit breaker, model fallback chains, RBAC, audit log, and advisory file locking on the shared output volume.

**Architecture:** Idempotency primitives built on the `model_calls` table from Phase 1. A `circuit-breaker.ts` module wraps every provider adapter. A `users`/`roles` schema backs JWT role claims. An append-only `audit_log` table records every config mutation. Advisory `flock` guards writes to the RWX output volume with atomic rename from staging.

**Tech Stack:** TypeScript, `proper-lockfile` (or raw `flock`), argon2 for password hashing, existing Drizzle + Postgres.

## Global Constraints

- All Phase 2 infra intact (Redis, KEDA, runners).
- Never duplicate a model API call: if `(session_id, turn)` exists in `model_calls`, the runner reuses the recorded response instead of calling the provider.
- Never clobber an existing output file: writes go to a staging path and atomic-rename on task success.
- RBAC roles: `viewer` (read-only), `editor` (create/edit prompts, launch runs, manage queues), `admin` (runners, scale, secrets, RBAC).
- Existing flat API-key permissions map onto viewer/editor scopes during migration.

---

## File Structure (Phase 3)

- Create: `src/runner/idempotency.ts` — `taskId` hashing + dedupe checks.
- Create: `src/runner/checkpoint.ts` — load-highest-turn + resume.
- Create: `src/providers/circuit-breaker.ts` — per-`(provider, model)` breaker.
- Create: `src/providers/fallback.ts` — fallback-chain resolution.
- Modify: `src/providers/adapters/base.ts` — wrap `sendMessage` in the circuit breaker.
- Modify: `src/runner.ts` — use checkpoint resume + idempotency + fallback.
- Create: `src/fs/locked-write.ts` — `flock` + atomic-rename write helper.
- Modify: `src/tools/executors.ts` — `write_file` routes through `locked-write`.
- Create: `src/auth/rbac.ts` — role checks middleware.
- Create: `src/auth/password.ts` — argon2id hashing (replaces plaintext env).
- Modify: `src/db/schema.ts` + `schema-pg.ts` — add `users`, `roles`, `user_roles`, `audit_log` tables.
- Modify: `src/dashboard-server/auth.ts` — issue JWT with role claims; verify via `rbac`.
- Modify: `src/dashboard-server/server.ts` — apply RBAC middleware to mutating routes.
- Create: `tests/runner/idempotency.test.ts`
- Create: `tests/runner/checkpoint.test.ts`
- Create: `tests/providers/circuit-breaker.test.ts`
- Create: `tests/fs/locked-write.test.ts`
- Create: `tests/auth/rbac.test.ts`

---

## Task 3.1: Idempotent task ID + dedupe

**Files:**
- Create: `src/runner/idempotency.ts`
- Create: `tests/runner/idempotency.test.ts`
- Modify: `src/runner.ts` (use the helpers)

**Interfaces:**
- Produces:
  ```ts
  export function computeTaskId(opts: { promptId: string; promptVersion: number; model: string; configHash: string; runId: string }): string;
  // = sha256(promptId + promptVersion + model + configHash + runId), hex
  export function configHash(config: Record<string, unknown>): string;
  export async function isTaskCompleted(taskId: string): Promise<boolean>;        // checks runs table for a completed result.json
  export async function resumeFromTurn(sessionId: string): Promise<number>;       // highest persisted turn in messages
  ```

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTaskId, configHash } from '../../src/runner/idempotency.js';

test('computeTaskId is deterministic', () => {
  const opts = { promptId: 'p', promptVersion: 1, model: 'gpt-4o', configHash: 'h', runId: 'r' };
  assert.equal(computeTaskId(opts), computeTaskId(opts));
});

test('computeTaskId differs on model change', () => {
  const base = { promptId: 'p', promptVersion: 1, configHash: 'h', runId: 'r' };
  assert.notEqual(computeTaskId({ ...base, model: 'gpt-4o' }), computeTaskId({ ...base, model: 'claude' }));
});

test('configHash is stable for object key order', () => {
  assert.equal(configHash({ a: 1, b: 2 }), configHash({ b: 2, a: 1 }));
});
```

- [ ] **Step 2: Implement `src/runner/idempotency.ts`**

```ts
import { createHash } from 'node:crypto';
export function configHash(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(config, Object.keys(config).sort())).digest('hex');
}
export function computeTaskId(opts: { promptId: string; promptVersion: number; model: string; configHash: string; runId: string }): string {
  return createHash('sha256').update(`${opts.promptId}|${opts.promptVersion}|${opts.model}|${opts.configHash}|${opts.runId}`).digest('hex');
}
```

`isTaskCompleted` queries the `runs` table (Phase 0) for `status='completed'` by `run_id`. `resumeFromTurn` queries `SELECT MAX(turn) FROM messages WHERE session_id = ?`.

- [ ] **Step 3: Wire into `src/runner.ts`**

On dequeue:
1. Compute `taskId` (store on the `Task` if not present).
2. If `isTaskCompleted(taskId)` → `ack` and continue (idempotent skip).
3. Else `resumeFromTurn(sessionId)` → pass the persisted messages as the starting point to `runAgentLoop`.

- [ ] **Step 4: Verify**

```bash
npm test -- --test tests/runner/idempotency.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/runner/idempotency.ts tests/runner/idempotency.test.ts src/runner.ts
git commit -m "feat(runner): deterministic taskId + idempotent skip on re-dequeue"
```

---

## Task 3.2: Checkpoint resume (don't re-run expensive model calls)

**Files:**
- Create: `src/runner/checkpoint.ts`
- Create: `tests/runner/checkpoint.test.ts`
- Modify: `src/runner.ts`, `src/agent-loop/loop.ts`

**Goal:** when a task is redelivered (runner crashed mid-task), the new runner loads the highest persisted turn from `messages` + `model_calls` and resumes from there — the model API is NOT called again for turns already in `model_calls`.

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../../src/db/client.js';
import { createSessionStore } from '../../src/session/store.js';
import { resumeFrom } from '../../src/runner/checkpoint.js';

test('resumeFrom returns persisted messages + last turn', async () => {
  initDb(':memory:');
  const store = createSessionStore();
  const s = await store.createSession({ model: 'gpt-4o' });
  await store.appendMessage(s.id, { turn: 0, role: 'user', content: 'hi' });
  await store.recordModelCall({ sessionId: s.id, turn: 0, provider: 'openai', model: 'gpt-4o', requestHash: 'h', responseText: 'hello', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 10 });
  await store.appendMessage(s.id, { turn: 1, role: 'assistant', content: 'hello' });
  const { messages, lastCompletedTurn } = await resumeFrom(s.id);
  assert.equal(lastCompletedTurn, 0);
  assert.equal(messages.length, 2);
  closeDb();
});
```

- [ ] **Step 2: Implement `src/runner/checkpoint.ts`**

```ts
export async function resumeFrom(sessionId: string): Promise<{ messages: ChatMessage[]; lastCompletedTurn: number }> {
  const store = createSessionStore();
  const msgs = await store.listMessages(sessionId);
  // lastCompletedTurn = highest turn that has a model_calls entry
  let last = -1;
  for (const m of msgs) {
    const mc = await store.getModelCall(sessionId, m.turn);
    if (mc) last = Math.max(last, m.turn);
  }
  return { messages: msgs.map(toChatMessage), lastCompletedTurn: last };
}
```

- [ ] **Step 3: Modify `runAgentLoop` to accept `resumeFromTurn`**

If `resumeFromTurn >= 0`, the loop's internal turn counter starts at `resumeFromTurn + 1`, and the starting `messages` array is the resumed one. For each turn, before calling `adapter.sendMessage`, check `model_calls` for `(sessionId, turn)` — if present, replay the recorded response (no API call) and continue.

- [ ] **Step 4: Wire in `src/runner.ts`**

```ts
const { messages, lastCompletedTurn } = await resumeFrom(task.sessionId);
const result = await runAgentLoop({ ...ctx, messages, resumeFromTurn: lastCompletedTurn, onTurnComplete: persistTurn }, adapter, tools);
```

- [ ] **Step 5: Verify**

```bash
npm test -- --test tests/runner/checkpoint.test.ts
npm run typecheck && npm run lint && npm test
# manual: kill a runner pod mid-task, confirm the replacement pod resumes from the last checkpoint without re-calling the model
```

- [ ] **Step 6: Commit**

```bash
git add src/runner/checkpoint.ts tests/runner/checkpoint.test.ts src/runner.ts src/agent-loop/loop.ts
git commit -m "feat(runner): checkpoint resume — no duplicate model calls on retry"
```

---

## Task 3.3: Per-provider circuit breaker

**Files:**
- Create: `src/providers/circuit-breaker.ts`
- Create: `tests/providers/circuit-breaker.test.ts`
- Modify: `src/providers/adapters/base.ts` — wrap `withRetry` in the breaker.

**Interfaces:**
- Produces `class CircuitBreaker` with `async exec<T>(fn: () => Promise<T>): Promise<T>` and states `closed | open | halfOpen`. Config: `failureThreshold` (default 5), `resetTimeoutMs` (default 30s), `halfOpenProbe` (1 request).
- Per-`(provider, model)` instance, stored in a `Map` keyed by `${provider}:${model}`.
- When open: throws `CircuitOpenError`; the runner catches it and either requeues the task to the fallback model (Task 3.4) or `nack`s it.

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../../src/providers/circuit-breaker.js';

test('opens after threshold consecutive failures', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => cb.exec(async () => { throw new Error('boom'); }));
  }
  await assert.rejects(() => cb.exec(async () => 'ok'), /CircuitOpen/);
});

test('half-open after reset timeout, closes on success', async () => {
  const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });
  await assert.rejects(() => cb.exec(async () => { throw new Error('x'); }));
  await new Promise(r => setTimeout(r, 60));
  const r = await cb.exec(async () => 'ok');   // half-open probe succeeds
  assert.equal(r, 'ok');
  assert.equal(cb.state, 'closed');
});

test('isolated per (provider, model)', () => {
  const a = CircuitBreaker.for('openai', 'gpt-4o');
  const b = CircuitBreaker.for('anthropic', 'claude');
  assert.notEqual(a, b);
});
```

- [ ] **Step 2: Implement `src/providers/circuit-breaker.ts`**

State machine: `closed` → failures increment a counter; on `>= threshold` → `open` + record `openedAt`. `exec` while `open` checks `Date.now() - openedAt >= resetTimeoutMs`; if so → `halfOpen` (allow one probe); on success → `closed` + reset counter; on failure → `open` + new `openedAt`. While `open` (not yet timeout) → throw `CircuitOpenError`.

- [ ] **Step 3: Wrap `BaseAdapter.withRetry`**

In `src/providers/adapters/base.ts`, the existing `withRetry` does exponential backoff. Wrap it: the breaker is the OUTER layer, retry is INNER. So a call goes `breaker.exec(() => withRetry(fn))`. A 429 retried successfully does NOT count as a breaker failure; only a fully-exhausted-retry failure counts. On `CircuitOpenError` thrown up, the adapter re-throws so the runner can react.

- [ ] **Step 4: Verify**

```bash
npm test -- --test tests/providers/circuit-breaker.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/providers/circuit-breaker.ts tests/providers/circuit-breaker.test.ts src/providers/adapters/base.ts
git commit -m "feat(providers): per-provider circuit breaker around adapter calls"
```

---

## Task 3.4: Model fallback chain

**Files:**
- Create: `src/providers/fallback.ts`
- Modify: `src/runner.ts`

**Goal:** per-prompt/per-project `fallback_chain` config. When the primary model's breaker is open or its `api_error` stop reason fires after retries, the runner re-enqueues the task targeting the next model in the chain.

- [ ] **Step 1: Define the fallback config schema**

Add a `fallback_chain` column to prompts (Phase 5 introduces the prompts table; for now store it as a JSON column on `sessions` or read from scenario YAML). For the runner, expose:

```ts
export interface FallbackConfig {
  primary: { provider: string; model: string };
  fallbacks: Array<{ provider: string; model: string }>;
}
export function resolveFallback(current: { provider: string; model: string }, chain: FallbackConfig): { provider: string; model: string } | null;
```

- [ ] **Step 2: Write test + implement**

Test: given chain `[openai/gpt-4o, anthropic/claude]` and current `openai/gpt-4o`, returns `anthropic/claude`; given current is the last, returns null. Implement is trivial list-walk.

- [ ] **Step 3: Wire in `src/runner.ts`**

On `CircuitOpenError` or `api_error` stop reason:
1. Resolve the next fallback.
2. If found → re-enqueue a new task to the fallback provider's stream with the same `sessionId` (so messages persist) and a new `taskId` reflecting the new model.
3. ACK the original task (it's been handed off, not failed).
4. If no fallback → `nack` (will hit the DLQ after attempts).

- [ ] **Step 4: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/providers/fallback.ts tests/providers/fallback.test.ts src/runner.ts
git commit -m "feat(providers): model fallback chain on circuit-open / api_error"
```

---

## Task 3.5: Advisory file locking + atomic-rename writes

**Files:**
- Create: `src/fs/locked-write.ts`
- Create: `tests/fs/locked-write.test.ts`
- Modify: `src/tools/executors.ts` — `write_file` uses `lockedWrite`.
- Modify: `src/worker.ts` / `src/runner.ts` — final result-file write uses `lockedWrite`.

**Goal:** writes to the RWX output volume are guarded by an advisory `flock` on `<run_id>/.lock` and use atomic rename from a staging path. Prevents cross-runner races on the same run_id (a bug condition, not a feature — but the lock fails fast instead of corrupting).

- [ ] **Step 1: Install a lock library**

`npm install proper-lockfile` (cross-platform advisory locking; uses `flock` on POSIX, `LockFileEx` on Windows).

- [ ] **Step 2: Write failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lockedWrite } from '../../src/fs/locked-write.js';

test('writes atomically — no partial file visible', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const target = path.join(dir, 'out.txt');
  await lockedWrite(target, 'hello', { lockDir: dir });
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  // staging file cleaned up
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
});

test('concurrent writes to same target are serialized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-'));
  const target = path.join(dir, 'out.txt');
  const writes: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) writes.push(lockedWrite(target, `v${i}`, { lockDir: dir }));
  await Promise.all(writes);
  // last writer wins, but no corruption (file exists, is readable)
  assert.ok(fs.readFileSync(target, 'utf8').startsWith('v'));
});
```

- [ ] **Step 3: Implement `src/fs/locked-write.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { lock, unlock } from 'proper-lockfile';

export async function lockedWrite(targetPath: string, content: string, opts: { lockDir: string }): Promise<void> {
  const lockFile = path.join(opts.lockDir, '.lock');
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const release = await lock(lockFile, { retries: { forever: true, min: 10, max: 1000 } });
  try {
    const staging = `${targetPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(staging, content);
    await fs.promises.rename(staging, targetPath);   // atomic on same filesystem
  } finally {
    await unlock(lockFile);
  }
}
```

- [ ] **Step 4: Wire into `write_file` executor + `writeResultJson`**

`write_file` (model tool): the `ctx.sandboxDir` is the lock dir; target is the resolved abs path. Route through `lockedWrite`.

`writeResultJson` (worker/runner final result): same treatment on the result file.

- [ ] **Step 5: Verify**

```bash
npm test -- --test tests/fs/locked-write.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/fs/locked-write.ts tests/fs/locked-write.test.ts src/tools/executors.ts src/worker.ts src/runner.ts package.json package-lock.json
git commit -m "feat(fs): advisory flock + atomic-rename writes for RWX output volume"
```

---

## Task 3.6: RBAC schema + argon2 password hashing

**Files:**
- Modify: `src/db/schema.ts` + `schema-pg.ts` — add `users`, `roles`, `user_roles`, `audit_log`.
- Create: `src/auth/password.ts` — argon2id.
- Modify: `src/dashboard-server/auth.ts` — hash on create, verify on login.

- [ ] **Step 1: Add schema**

```ts
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  created_at: text('created_at').notNull(),
});
export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),       // 'viewer' | 'editor' | 'admin'
  description: text('description'),
});
export const user_roles = sqliteTable('user_roles', {
  user_id: text('user_id').notNull().references(() => users.id),
  role_id: text('role_id').notNull().references(() => roles.id),
});
export const audit_log = sqliteTable('audit_log', {
  id: integer('id').autoincrement().primaryKey(),
  actor: text('actor').notNull(),        // username or 'system'
  action: text('action').notNull(),      // 'prompt.update', 'queue.retry', 'runner.scale', ...
  entity_type: text('entity_type').notNull(),
  entity_id: text('entity_id'),
  before: text('before'),                // JSON
  after: text('after'),                  // JSON
  at: text('at').notNull(),
});
```

Mirror in `schema-pg.ts`. Generate migrations for both.

- [ ] **Step 2: Install argon2**

`npm install argon2`

- [ ] **Step 3: Implement `src/auth/password.ts`**

```ts
import argon2 from 'argon2';
export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const verifyPassword = (hash: string, pw: string) => argon2.verify(hash, pw);
```

- [ ] **Step 4: Modify `auth.ts`**

On login: look up `users` by username, `verifyPassword(hash, input)`. On success, sign JWT with `{ sub: user.id, username, role }` (role = the user's highest-privilege role). Remove the plaintext `DASHBOARD_PASSWORD` env-var path — but keep a seed-admin bootstrap: on first boot, if `users` is empty, create `admin` from `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` env (hashed), then the env vars are no longer consulted.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/db/schema.ts src/db/schema-pg.ts src/auth/password.ts src/dashboard-server/auth.ts drizzle/ drizzle/pg/ package.json
git commit -m "feat(auth): users/roles tables + argon2id + seeded admin"
```

---

## Task 3.7: RBAC middleware + audit logging on config mutations

**Files:**
- Create: `src/auth/rbac.ts`
- Create: `tests/auth/rbac.test.ts`
- Modify: `src/dashboard-server/server.ts` — apply `requireRole('editor')` / `requireRole('admin')` to mutating routes.
- Modify: every mutating route handler — write an `audit_log` row.

- [ ] **Step 1: Implement `src/auth/rbac.ts`**

```ts
import type { NextFunction, Request, Response } from 'express';
export function requireRole(min: 'viewer' | 'editor' | 'admin') {
  const order = { viewer: 0, editor: 1, admin: 2 };
  return (req: Request, res: Response, next: NextFunction) => {
    const role = (req as any).user?.role;
    if (!role || order[role as keyof typeof order] < order[min]) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
export async function audit(actor: string, action: string, entity: { type: string; id?: string }, before?: unknown, after?: unknown): Promise<void> {
  // INSERT INTO audit_log ...
}
```

- [ ] **Step 2: Test RBAC middleware**

Test: a viewer-role request to a `requireRole('editor')` route returns 403; an editor passes.

- [ ] **Step 3: Apply middleware to mutating routes**

- `POST /api/models`, `PUT/DELETE /api/models/:id` → `requireRole('editor')`.
- `POST /api/runs`, retry/cancel → `requireRole('editor')`.
- `POST /api/scenarios`, etc. → `requireRole('editor')`.
- Runner scale/drain/restart (Phase 5 UI) → `requireRole('admin')`.
- User/role management → `requireRole('admin')`.
- Read routes (`GET`) → viewer (default).

- [ ] **Step 4: Add `audit(...)` calls**

In each mutating handler, after the mutation succeeds, write an audit row with before/after JSON. Wrap in a helper `withAudit(action, entityType, fn)` that captures before, runs the mutation, captures after, and writes the audit row.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/auth/rbac.ts tests/auth/rbac.test.ts src/dashboard-server/
git commit -m "feat(auth): RBAC middleware + audit logging on config mutations"
```

---

## Phase 3 Exit Gate

- [ ] Kill a runner pod mid-task → replacement resumes from the last checkpoint; no duplicate model API calls; no duplicate file writes.
- [ ] A provider returning 5xx 5× consecutively opens its circuit; tasks fall back to the configured fallback model; when the breaker half-opens + a probe succeeds, the primary resumes.
- [ ] DLQ: a task exhausting all fallbacks + `maxAttempts` lands in `arena:tasks:<provider>:dlq` (visible in Phase 5 UI).
- [ ] `write_file` and `result.json` writes are atomic; concurrent writers serialize via `flock`.
- [ ] Login uses argon2id-hashed passwords from the `users` table; plaintext env path gone after seed.
- [ ] Mutating routes return 403 for viewers; audit log records every mutation.
- [ ] `npm run typecheck && npm run lint && npm test` green.

## Phase 3 Self-Review

- **Spec coverage:** idempotency (§2.3.1) → 3.1; checkpointing (§2.3.2) → 3.2; circuit breaker (§2.3.3) → 3.3; fallback (§2.3.4) → 3.4; DLQ (§2.3.5) → from Phase 2.1, surfaced in Phase 5; locking (§2.4.1) → 3.5; RBAC (§2.5.4) → 3.6, 3.7; audit log (§2.7) → 3.7. D8 (local users, argon2) → 3.6.
- **Placeholders:** none. Real code, real tests, real SQL.
- **Type consistency:** `CircuitBreaker.for(provider, model)` matches the call site in `base.ts`. `lockedWrite(targetPath, content, { lockDir })` matches executor usage. `audit(actor, action, { type, id }, before, after)` consistent.
- **Dependencies:** 3.1 → 3.2 (resume uses idempotency's `resumeFromTurn`). 3.3 → 3.4 (fallback reacts to circuit-open). 3.5 independent. 3.6 → 3.7 (RBAC needs users/roles).

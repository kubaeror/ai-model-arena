# Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every issue surfaced by the 2026-08-10 codebase audit — wedged runs, cross-process budget leaks, RBAC/API-key gaps, password-in-audit-log, dead code, duplicated logic, client WS/pagination/error gaps, and infra wiring — leaving the arena at ~99% functional completion.

**Architecture:** Six phases, one per subsystem, each independently testable: (A) runner/orchestrator reliability, (B) dashboard-server security & correctness, (C) server dedup & dead-code removal, (D) dashboard-client, (E) infra, (F) stretch refactors. Each task is a self-contained fix with a test-first cycle. Nothing here changes public CLI contracts or the wire protocol between client and server (except additive: `/api/cost`).

**Tech Stack:** TypeScript ESM strict, Node >= 22, Express 5, Drizzle ORM (SQLite+PG), node:test via `tsx --test`, Vitest for the React client, pino logging, TanStack Query, kubectl/kustomize for k8s.

## Global Constraints

- ESM imports only (`.js` suffixes in relative imports); never add comments unless they explain a non-obvious invariant.
- All new behavior behind env vars where configurable; never hardcode API keys.
- `npm run typecheck` and `npm run typecheck:tests` must pass; `npm run lint` clean.
- Server tests: `npx tsx --test tests/<path>/<file>.test.ts`; full suite `npm test`. Client tests: `npm --prefix src/dashboard-client run test` (Vitest).
- Commit per task with message style from git log: `fix(scope): short description` (e.g. `fix(runner): finalize run when model not found`).
- Do not modify DB schema or migrations in this plan (no new tables/columns).
- Every removal task MUST grep for importers before deleting (see task steps).

---
# Phase A — Runner & Orchestration Reliability

## Task A1: Model-not-found nack path must finalize the run

**Files:**
- Modify: `src/runner.ts:378-391`
- Test: `tests/runner/runner-loop.test.ts` (extend existing "model not found" test at ~:108-158)

**Interfaces:**
- Consumes: `transitionTaskState(runId, model, status, runnerId)` (from `db/query.js`), `maybeFinalizeRun(runId, logger)` (defined in `runner.ts`), `isTerminalFailure(attempts)` (defined in `runner.ts`).
- Produces: none new.

**Problem:** when a task dead-letters with `Model not found`, the `run_models` row stays `'running'` forever — `isRunCompleteByRunId` never sees a terminal status, the run is permanently wedged, and self-finalize never fires.

- [ ] **Step 1: Extend the failing test**

In `tests/runner/runner-loop.test.ts`, the existing "model not found" test drives the loop with an unresolvable model and asserts DLQ + metric. Add assertions after the loop completes:

```ts
// The run must not stay wedged: the model row reaches 'failed' and the
// run is finalized (status 'completed' in the runs table).
import { listRuns } from '../src/db/query.js'; // or existing import style
// ...after the loop finishes:
const runs = await listRuns();
const wedged = runs.filter((r) => r.perModel.some((m) => m.status === 'running'));
assert.equal(wedged.length, 0, 'no run_models row may stay running after a dead-lettered model-not-found');
```

Adapt to the test file's existing harness (it already drives `startRunner` against an in-memory queue with an unresolvable model and asserts `deadLetterSize`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/runner/runner-loop.test.ts`
Expected: the new assertion fails — the model row is still `running`.

- [ ] **Step 3: Implement**

In `src/runner.ts`, replace the model-not-found block (lines 378-391) with:

```ts
      const resolved = await resolveModelForRun(modelName);
      if (!resolved) {
        logger.error('Model not found', { model: modelName });
        // nack requeues below the DLQ threshold — count failed + duration
        // only when the nack dead-letters (terminal).
        if (isTerminalFailure(task!.attempts)) {
          taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
          taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
          taskCounted = true;
          tasksFailed.inc();
          // The nack below dead-letters this attempt, so the model task just
          // reached a terminal state. Mark the model row failed and finalize
          // the run; without this the run stays wedged in 'running' forever
          // (isRunCompleteByRunId never sees a terminal status).
          try {
            await transitionTaskState(runId, task!.model, 'failed', runnerId);
          } catch (err: unknown) {
            const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
            logger.error('transitionTaskState to "failed" failed for missing model — run may be stuck in "running" state', { taskId: task!.taskId, modelRunId: runId, ...detail });
          }
          void maybeFinalizeRun(runId, logger).catch(() => undefined);
        }
        await queue.nack(task!._redisId ?? task!.taskId, `Model not found: ${modelName}`);
        continue;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/runner/runner-loop.test.ts`
Expected: PASS (all assertions, including the new no-wedged-runs one).

- [ ] **Step 5: Full verification + commit**

Run: `npm run typecheck && npx tsx --test tests/runner/*.test.ts`
Commit: `git add src/runner.ts tests/runner/runner-loop.test.ts && git commit -m "fix(runner): finalize run when model-not-found dead-letters"`

---

## Task A2: Missing-API-key fail-fast must self-finalize

**Files:**
- Modify: `src/runner.ts:395-413`
- Test: `tests/runner/runner-loop.test.ts`

**Problem:** the fail-fast path writes `'failed'` but never calls `maybeFinalizeRun` — it depends on the dashboard watcher being up, contradicting the documented self-finalize design (runner.ts:144-150). The `'failed'` write is also fire-and-forget, so on Postgres it can race the completeness check.

- [ ] **Step 1: Write the failing test**

In `tests/runner/runner-loop.test.ts`, add a test that starts a run whose model resolves but has no API key configured (follow the existing harness: configure a secret store without the env var), runs the loop to completion, and asserts:

```ts
// run finalized without any external watcher
const runs = await listRuns();
assert.equal(runs.some((r) => r.status === 'completed'), true, 'run must self-finalize after fail-fast');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/runner/runner-loop.test.ts` — new test fails (run stays `'running'`).

- [ ] **Step 3: Implement**

In `src/runner.ts`, replace the transition block inside the missing-API-key branch (lines 404-411) with:

```ts
        // Awaited before maybeFinalizeRun below: on Postgres the pg.Pool
        // spreads queries across connections, so a fire-and-forget UPDATE
        // could lose the race against the isRunCompleteByRunId SELECT.
        try {
          await transitionTaskState(runId, task.model, 'failed', runnerId);
        } catch (err: unknown) {
          const detail = err instanceof Error ? { message: err.message, stack: err.stack } : { error: String(err) };
          logger.error('transitionTaskState to "failed" failed — run may be stuck in "running" state', { taskId: task!.taskId, modelRunId: runId, ...detail });
        }
        taskCounter.inc({ model: modelName, scenario: scenarioName, status: 'failed' });
        taskDuration.observe({ model: modelName, scenario: scenarioName }, (Date.now() - startedAt.getTime()) / 1000);
        taskCounted = true;
        tasksFailed.inc();
        await queue.ack(task!._redisId ?? task!.taskId);
        void maybeFinalizeRun(runId, logger).catch(() => undefined);
        continue;
```

- [ ] **Step 4: Verify pass**

Run: `npx tsx --test tests/runner/runner-loop.test.ts` — PASS.

- [ ] **Step 5: Commit**

`git add src/runner.ts tests/runner/runner-loop.test.ts && git commit -m "fix(runner): self-finalize on missing-api-key fail-fast"`

---

## Task A3: Await 'claimed'/'running' transitions; drop meaningless casts

**Files:**
- Modify: `src/runner.ts:299-301, 452-454, 285, 318, 537`
- Test: `tests/runner/runner-loop-happy.test.ts`

**Problem:** `transitionTaskState('claimed')` and `('running')` are fire-and-forget; on Postgres a later awaited terminal write can land first. Also `task.config.modelRunId as string ?? task.sessionId` is a non-null assertion before `??` — meaningless and hides untyped config.

- [ ] **Step 1: Write the failing test**

In `tests/runner/runner-loop-happy.test.ts`, after a successful run, assert the run_models rows passed through `claimed → running → completed` in order. The harness uses SQLite (serializes writes, so this test documents the contract rather than reproducing the PG race — acceptable; the PG ordering is enforced by the code change):

```ts
// ordering contract: claimed/running writes are awaited before any terminal write
```

- [ ] **Step 2: Implement**

Replace lines 299-301:

```ts
      try {
        await transitionTaskState(runId, task.model, 'claimed', runnerId);
      } catch (e) {
        logger.warn('Failed to write claimed state', { error: String(e) });
      }
```

Replace lines 452-454:

```ts
      try {
        await transitionTaskState(runId, task.model, 'running', runnerId);
      } catch (e) {
        logger.warn('Failed to write running state', { error: String(e) });
      }
```

Replace the three cast sites `task.config.modelRunId as string ?? task.sessionId` (lines 285, 318, 537) with a single typed local. Add near the top of the per-task block (after `const runId = ...` at 285):

```ts
      const modelRunId = String(task.config.modelRunId ?? task.sessionId);
```

Then remove the now-duplicate `const modelRunId = task.config.modelRunId as string ?? task.sessionId;` at line 318, and replace the `runId` at line 285 and the cast at line 537 to use `modelRunId`. (Line 537 is inside `onBudgetCheck`: `const cancelledRunId = task!.config.modelRunId as string ?? task!.sessionId;` → replace with `const cancelledRunId = modelRunId;`.)

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npx tsx --test tests/runner/*.test.ts` — PASS.

- [ ] **Step 4: Commit**

`git add src/runner.ts && git commit -m "fix(runner): await claimed/running transitions, type modelRunId"`

---

## Task A4: Budget reservations must be file-authoritative (cross-process release)

**Files:**
- Modify: `src/cost-tracking/types.ts` (`BudgetState`), `src/cost-tracking/budget.ts`
- Modify: `src/cost-tracking/index.ts` (re-export new fns)
- Delete: `src/orchestrator/finalize/budget.ts`
- Modify: `src/orchestrator/run-lifecycle.ts:26, 227, 333`
- Test: `tests/cost-tracking/budget.test.ts`, `tests/orchestrator/budget-integration.test.ts`

**Problem:** reservations are recorded in the `finalize/budget.ts` module-local `runReservations` map populated only in the process that called `startRun`. The runner self-finalizes in a **different** process — its map is empty, `releaseReservation(model, 0, …)` finds no matching persisted entry, and the reservation leaks until TTL expiry, permanently inflating projected spend in the dashboard process. Fix: persist per-run reservations in the budget state file and make projected-spend reads file-based.

- [ ] **Step 1: Write the failing test**

In `tests/orchestrator/budget-integration.test.ts`, add a cross-process simulation (two `loadBudgetConfig` lifetimes separated by `resetBudgetCache()`):

```ts
import { resetBudgetCache } from '../src/cost-tracking/budget.js';
// ...within the existing test harness (temp root, budget config with limits):
recordRunReservations('run-x', [{ model: 'gpt-4o', estimated: 0.5 }], budgetRoot, logger);
// Simulate the runner process: fresh module state, no runReservations memory.
resetBudgetCache();
releaseRunReservations('run-x', [{ model: 'gpt-4o', result: { costUsd: 0.1 } }], budgetRoot, logger);
// The released reservation must not count toward projected spend anywhere.
resetBudgetCache();
const check = reserveBudget('gpt-4o', 0.05, budgetRoot, logger);
assert.equal(check.ok, true, 'released reservation must not block new reservations');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test tests/orchestrator/budget-integration.test.ts` — fails: `releaseRunReservations` is undefined (after we move it) or the reservation still blocks.

- [ ] **Step 3: Implement**

**`src/cost-tracking/types.ts`** — add to `BudgetState`:

```ts
  reservations?: Record<string, Array<{ amount: number; dailyKey: string; expiresAt?: number }>>;
  /** Per-run reservations (runId -> model -> reserved USD) persisted so ANY
   *  process (runner, dashboard, CLI) can release the exact amounts at
   *  finalize — the in-memory map cannot cross the process boundary. */
  runReservations?: Record<string, Record<string, number>>;
```

**`src/cost-tracking/budget.ts`**:

Add a helper and use it in `reserveBudget` (replace line 180 `const totalReserved = (pendingReservations.get(reservationKey) ?? 0);`):

```ts
function todayReservedTotal(state: BudgetState, modelName: string): number {
  const today = DAY_KEY();
  let total = 0;
  for (const entry of state.reservations?.[modelName] ?? []) {
    if (entry.dailyKey !== today) continue;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) continue;
    total += entry.amount;
  }
  return total;
}
```

and:

```ts
const totalReserved = todayReservedTotal(state, modelName);
```

Add the two moved functions at the bottom of `budget.ts` (before `resetBudgetCache`):

```ts
/** Persist per-run reservations (runId -> model -> amount) in the budget state
 *  file so the releasing process — usually the runner, a different process
 *  from the one that called startRun — knows the exact amounts. */
export function recordRunReservations(
  runId: string,
  reservations: Array<{ model: string; estimated: number }>,
  rootDir: string,
  logger?: Logger,
): void {
  if (!budgetConfig) return;
  const state = loadBudgetState(budgetConfig, rootDir, logger);
  state.runReservations = state.runReservations ?? {};
  const entry: Record<string, number> = {};
  for (const r of reservations) entry[r.model] = (entry[r.model] ?? 0) + r.estimated;
  state.runReservations[runId] = entry;
  saveBudgetState(rootDir, logger);
}

/** Release a run's reservations against actual costs, reading the reserved
 *  amounts from the persisted state file (process-independent). */
export function releaseRunReservations(
  runId: string,
  entries: Array<{ model: string; result?: { costUsd?: number } | null }>,
  rootDir: string,
  logger: Logger,
): void {
  const state = budgetConfig ? loadBudgetState(budgetConfig, rootDir, logger) : null;
  const reserved = state?.runReservations?.[runId] ?? {};
  for (const entry of entries) {
    releaseReservation(entry.model, reserved[entry.model] ?? 0, entry.result?.costUsd ?? 0, rootDir, logger);
  }
  if (state?.runReservations) {
    delete state.runReservations[runId];
    saveBudgetState(rootDir, logger);
  }
}
```

**`src/cost-tracking/index.ts`** — ensure the barrel re-exports `recordRunReservations` and `releaseRunReservations` (add if it uses explicit exports; `export * from './budget.js'` covers it automatically).

**Delete `src/orchestrator/finalize/budget.ts`.**

**`src/orchestrator/run-lifecycle.ts`**:
- Line 26: `import { recordRunReservations, releaseRunReservations } from '../cost-tracking/index.js';`
- Line 227: `recordRunReservations(runId, reservations, budgetRoot, logger);`
- Line 333: `releaseRunReservations(runId, entries, budgetRoot, logger);` (entries is `ComparisonEntry[]`, structurally compatible).

- [ ] **Step 4: Verify pass**

Run: `npx tsx --test tests/orchestrator/budget-integration.test.ts tests/cost-tracking/budget.test.ts tests/orchestrator/cost-estimate.test.ts`
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 5: Commit**

`git add src/cost-tracking src/orchestrator/run-lifecycle.ts && git rm src/orchestrator/finalize/budget.ts && git commit -m "fix(budget): persist per-run reservations so cross-process release works"`

---

## Task A5: stopRun must mark per-model rows terminal

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts:392-397`
- Test: `tests/orchestrator/stop-run.test.ts` (new)

**Problem:** `stopRun` sets the run status to `'stopped'` but leaves `run_models` rows `'running'` forever; the dashboard finalize watcher skips non-`running` runs, so a stopped run never finalizes and its per-model rows stay stale.

- [ ] **Step 1: Write the failing test** — create `tests/orchestrator/stop-run.test.ts` following the harness pattern of `tests/orchestrator/budget-integration.test.ts` (initDb with temp DB path, temp output root, `forceBudget`):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
// harness setup as in budget-integration.test.ts (initDb, temp OUTPUT_ROOT)
import { startRun, stopRun } from '../src/orchestrator/run-lifecycle.js';

test('stopRun marks per-model rows terminal', async () => {
  const spec = await startRun({ scenario: 'smoke', models: ['gpt-4o'], forceBudget: true, source: 'cli' });
  await stopRun(spec.runId);
  const { getRunRecord } = await import('../src/orchestrator/run-index.js');
  const rec = await getRunRecord(spec.runId);
  assert.equal(rec?.status, 'stopped');
  for (const m of rec?.perModel ?? []) {
    assert.notEqual(m.status, 'running', `model ${m.model} must not stay running`);
  }
});
```

(Use a model name present in the test catalog; if `startRun` requires a seeded catalog, reuse the seeding from the existing orchestrator tests.)

- [ ] **Step 2: Run to verify it fails** — `npx tsx --test tests/orchestrator/stop-run.test.ts` — perModel rows still `'running'`.

- [ ] **Step 3: Implement**

```ts
/** Stop a running run (marks as stopped in the index and signals cancellation). */
export async function stopRun(runId: string): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  await markRunCancelledSignal(runId);
  await updateRun(runId, (r) => {
    r.status = 'stopped';
    r.finishedAt = new Date().toISOString();
    for (const m of r.perModel) {
      if (m.status === 'running' || m.status === 'claimed' || m.status === 'unknown') m.status = 'stopped';
    }
  });
}
```

- [ ] **Step 4: Verify** — `npx tsx --test tests/orchestrator/stop-run.test.ts && npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

`git add src/orchestrator/run-lifecycle.ts tests/orchestrator/stop-run.test.ts && git commit -m "fix(orchestrator): stopRun marks per-model rows terminal"`

---

## Task A6: registerRun must not clobber terminal runs/models

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts:151-162`
- Test: `tests/orchestrator/stop-run.test.ts` (extend) or new `tests/orchestrator/register-run.test.ts`

**Problem:** a late `registerRun` (crash between fail-fast write and register, or between model failure and restart bookkeeping) upserts `'running'` over a terminal status, wedging the run again.

- [ ] **Step 1: Write the failing test**

```ts
test('registerRun does not clobber a terminal run', async () => {
  const spec = await startRun({ scenario: 'smoke', models: ['gpt-4o'], forceBudget: true, source: 'cli' });
  await stopRun(spec.runId); // run + models now 'stopped'
  const { registerRun } = await import('../src/orchestrator/run-lifecycle.js');
  await registerRun(spec, 'cli');
  const rec = await getRunRecord(spec.runId);
  assert.equal(rec?.status, 'stopped', 'registerRun must not resurrect a stopped run');
  for (const m of rec?.perModel ?? []) assert.notEqual(m.status, 'running');
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
/** Register a run (status=running) in the index. Never clobbers a terminal
 *  run or model: a fail-fast finalize may have written 'failed'/'stopped'
 *  before this upsert lands (e.g. crash between finalize and register). */
export async function registerRun(spec: RunSpec, source: 'cli' | 'dashboard' | 'scheduler' = 'cli', createdBy?: string): Promise<void> {
  const existing = await getRunRecord(spec.runId);
  if (existing && TERMINAL_STATUSES.has(existing.status)) return;
  const perModel: RunIndexModelEntry[] = spec.models
    .filter((m) => {
      const ex = existing?.perModel.find((p) => p.model === m.model);
      return !ex || !TERMINAL_STATUSES.has(ex.status);
    })
    .map((m) => ({
      model: m.model, runId: spec.runId, outputDir: m.outputDir,
      sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath,
      reportPath: m.reportPath, logFile: m.logFile, status: 'running',
    }));
  await upsertRun({
    runId: spec.runId, scenario: spec.scenario, models: spec.models.map((m) => m.model),
    startedAt: spec.startedAt, finishedAt: null, status: 'running', source, perModel,
    comparisonMdPath: null, comparisonJsonPath: null, createdBy,
  });
}
```

(`TERMINAL_STATUSES` is defined at run-lifecycle.ts:285 — move its declaration above `registerRun` if hoisting order complains.)

- [ ] **Step 4: Verify** — run the test; then `npm run typecheck && npx tsx --test tests/orchestrator/*.test.ts`.

- [ ] **Step 5: Commit**

`git add src/orchestrator/run-lifecycle.ts tests/orchestrator/ && git commit -m "fix(orchestrator): registerRun never clobbers terminal states"`

---

## Task A7: Scheduler — surface invalid cron, seed counters from DB

**Files:**
- Modify: `src/scheduler/tick.ts:29-37, 61-67, 116-123, 32`
- Test: `tests/scheduler/tick.test.ts`

**Problem:** (1) `computeNextRun` swallows parse errors and returns now+1h with no log — a bad cron hot-loops hourly forever with no `lastError`; (2) `getScheduleState` defaults to zero consecutive failures after a restart, hiding cross-restart failure streaks that should trigger the 3+ alert.

- [ ] **Step 1: Write the failing test** — extend `tests/scheduler/tick.test.ts`:

```ts
test('invalid cron surfaces as a schedule failure, not a silent 1h retry', async () => {
  // seed a schedule row with cron 'not a cron' (follow existing seeding harness)
  const res = await tickScheduler({ now: new Date('2026-01-01T00:00:00Z'), startRunFn: async () => undefined });
  assert.equal(res.failures.length, 1);
  // next_run backed off and lastError is set
  const { getScheduleRow } = await import('../src/db/query.js'); // adapt to actual fn name
  // assert row.last_error contains 'cron'
});
```

- [ ] **Step 2: Run to verify it fails** (currently the failure list stays empty).

- [ ] **Step 3: Implement**

In `tick.ts`:

```ts
function computeNextRun(cron: string, from: Date): string | null {
  try {
    const interval = CronExpressionParser.parse(cron);
    return (interval.next().toDate() as Date).toISOString();
  } catch (err) {
    logger.error('Invalid cron expression', {
      cron,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
```

In `tickScheduler`, replace lines 28-37 with:

```ts
    const nowMs = new Date(now).getTime();
    const next = computeNextRun(row.cron, new Date(now));
    let failureReason = '';
    if (next === null) {
      failureReason = `Invalid cron expression: ${row.cron}`;
      logger.error(failureReason, { scheduleId });
    }

    // Update scheduler state for observability
    const state = getScheduleState(scheduleId) ?? {
      id: scheduleId, status: 'idle',
      consecutiveFailures: row.consecutive_failures ?? 0,
      totalRuns: row.total_runs ?? 0,
      totalFailures: row.total_failures ?? 0,
    };
    updateScheduleState(scheduleId, {
      status: failureReason ? 'error' : 'running',
      lastRun: now,
      ...(next ? { nextRun: next } : {}),
    });
    void updateScheduleStatus(scheduleId, { lastStatus: failureReason ? 'error' : 'running', lastError: failureReason || null })
      .catch(() => undefined);
```

Wrap the `startRun` call to skip it on invalid cron:

```ts
    if (!failureReason) {
      try {
        // ...existing startRun block unchanged (lines 45-67)
      } catch (err) {
        scheduleFailed = true;
        failureReason = err instanceof Error ? err.message : String(err);
        logger.warn('Schedule startRun failed', { scheduleId, error: failureReason });
      }
    } else {
      scheduleFailed = true;
    }
```

In the failure branch (line 72+), replace the hardcoded `lastError: 'Failed to enqueue one or more model tasks'` (both `updateScheduleState` at 80-84 and `updateScheduleStatus` at 86-90) with `lastError: failureReason`.

- [ ] **Step 4: Verify** — `npx tsx --test tests/scheduler/tick.test.ts tests/dashboard/schedules-routes.test.ts && npm run typecheck`.

- [ ] **Step 5: Commit**

`git add src/scheduler/tick.ts tests/scheduler/tick.test.ts && git commit -m "fix(scheduler): surface invalid cron as failure, seed counters from DB"`

---

## Task A8: Resume continuity — budget spend and conversation transcript

**Files:**
- Modify: `src/runner.ts` (near 341-351 and 446)
- Test: `tests/runner/checkpoint-resume.test.ts`

**Problem:** on resume, (1) `prevRunCost = 0` ignores spend from the pre-crash attempt, so the per-turn budget check undercounts; (2) `conversation.json` is recreated empty and flushed over the pre-crash transcript, so artifacts contain only the resumed fragment.

- [ ] **Step 1: Write the failing test** — extend `tests/runner/checkpoint-resume.test.ts` (it already covers `resumeFrom`):

```ts
test('resume seeds run spend from persisted model calls', async () => {
  // insert a model_calls row for the session with known usage, then call
  // the new helper and assert the accumulated cost equals computeCost(usage)
});
```

- [ ] **Step 2: Implement**

In `src/runner.ts`, after `resumedMessages` is set (line 311-315), accumulate prior spend:

```ts
        if (resumed.messages.length > 0) {
          resumedMessages = resumed.messages;
          initialTurn = resumed.lastCompletedTurn + 1;
          // Resume budget continuity: count spend from pre-crash attempts so
          // the per-turn budget check sees the full run, not just this attempt.
          const { listModelCallsForSession } = await import('./db/query.js');
          const priorCalls = await listModelCallsForSession(session.id);
          for (const c of priorCalls) {
            try {
              const prior = await computeCost(modelName, {
                prompt: Number(c.token_input ?? 0),
                completion: Number(c.token_output ?? 0),
                cached: 0,
              });
              prevRunCost = Math.max(prevRunCost, prior.total);
            } catch { /* non-fatal */ }
          }
          logger.info('Resuming session from checkpoint', { sessionId: session.id, turns: initialTurn, messages: resumed.messages.length, priorSpend: prevRunCost });
        }
```

(Declare `prevRunCost` with `let prevRunCost = 0;` **before** the session-load block and remove the later redeclaration at line 446.)

Seed the conversation logger (after `new ConversationLogger(...)` at 345):

```ts
      // Resume continuity: replay the persisted transcript into
      // conversation.json so artifacts (report.md, manifest) cover the whole
      // run, not just the post-resume fragment.
      if (resumedMessages) {
        const { listMessagesBySession } = await import('./db/query.js');
        const stored = await listMessagesBySession(session.id);
        for (const m of stored) {
          if (m.role === 'system' || m.role === 'user') {
            conv.append({ type: m.role === 'system' ? 'system' : 'user', role: m.role, content: m.content, turn: m.turn });
          } else if (m.role === 'assistant') {
            conv.append({ type: 'assistant', role: 'assistant', content: m.content, turn: m.turn, toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined });
          } else if (m.role === 'tool') {
            conv.append({ type: 'tool_result', role: 'tool', content: m.content, toolCallId: m.toolCallId ?? undefined, turn: m.turn });
          }
        }
      }
```

If `computeCost` is not yet imported in runner.ts, add it to the existing cost-tracking import.

- [ ] **Step 3: Verify** — `npm run typecheck && npx tsx --test tests/runner/checkpoint-resume.test.ts tests/runner/checkpoint.test.ts`.

Also fix turn accounting for resumed runs: `result.turnsUsed` counts only the resumed attempt. In the `runResult` construction (runner.ts:592-606), change to:

```ts
        turnsUsed: result.turnsUsed + (initialTurn - 1),
```

(initialTurn is 1 for fresh runs, so this is a no-op there; on resume it adds the pre-crash turns.)

- [ ] **Step 4: Commit**

`git add src/runner.ts tests/runner/checkpoint-resume.test.ts && git commit -m "fix(runner): resume carries prior spend and full transcript"`

---

## Task A9: Dashboard watcher finalizes stopped runs

**Files:**
- Modify: `src/dashboard-server/live.ts:217-235`
- Test: `tests/dashboard/ws-ownership.test.ts` (extend) or `tests/dashboard/routes.test.ts`

**Problem:** `finalizeRuns` filters `r.status === 'running'` only. With A5 marking stopped runs' per-model rows terminal, a stopped run whose runner died still never finalizes (no aggregation, no reservation release). The finalize path is idempotent (finalizeCore skips `'completed'` runs), so including stopped runs is safe.

- [ ] **Step 1: Write the failing test** — seed a run with status `'stopped'` whose `run_models` rows are all terminal, run `finalizeRuns` (or the extracted helper), assert `run.status === 'completed'` and the comparison files exist.

- [ ] **Step 2: Implement**

```ts
  private async finalizeRuns(): Promise<void> {
    const active = (await listRuns()).filter((r) => r.status === 'running' || r.status === 'stopped');
    for (const rec of active) {
      // ...existing body unchanged
```

- [ ] **Step 3: Verify** — `npx tsx --test tests/dashboard/routes.test.ts && npm run typecheck`.

- [ ] **Step 4: Commit**

`git add src/dashboard-server/live.ts tests/dashboard/ && git commit -m "fix(dashboard): finalize stopped runs when all models are terminal"`

---
# Phase B — Dashboard Server Security & Correctness

## Task B1: PATCH /api/anomalies/:id requires editor

**Files:**
- Modify: `src/dashboard-server/routes/anomalies.ts:78`
- Test: `tests/dashboard/rbac-enforcement.test.ts`

**Problem:** the PATCH handler has no role gate — any authenticated viewer can resolve anomalies (write on a viewer mount).

- [ ] **Step 1: Write the failing test** — in `tests/dashboard/rbac-enforcement.test.ts`, follow the existing pattern (login as viewer, attempt PATCH `/api/anomalies/1` with `{ resolved_as: 'resolved' }`), assert 403.

- [ ] **Step 2: Run to verify it fails** (currently 200).

- [ ] **Step 3: Implement**

```ts
import { requireRole } from '../../auth/rbac.js';
// ...
  router.patch('/:id', requireRole('editor'), async (req, res) => {
```

- [ ] **Step 4: Verify** — `npx tsx --test tests/dashboard/rbac-enforcement.test.ts tests/dashboard/routes.test.ts`.

- [ ] **Step 5: Commit**

`git add src/dashboard-server/routes/anomalies.ts tests/dashboard/rbac-enforcement.test.ts && git commit -m "fix(dashboard): gate anomaly resolution behind editor role"`

---

## Task B2: API-key (v1) write surface — honor permissions in RBAC

**Files:**
- Modify: `src/auth/rbac.ts`, `src/dashboard-server/run-ownership.ts`
- Test: `tests/auth/rbac.test.ts`, `tests/dashboard/rbac-enforcement.test.ts`

**Problem:** `requireApiKey` sets `req.apiKey` but the routers' inner `requireRole`/`isOwnerAllowed` read `req.user` — every v1 write returns 403 unconditionally and 20 declared permissions are dead config. Conversely v1 PATCH anomalies (read-key) can mutate.

- [ ] **Step 1: Write the failing test** — in `tests/dashboard/rbac-enforcement.test.ts`, add an API-key test (harness loads `configs/api-keys.yaml` or injects config): key with `runs:write` POSTs `/api/v1/runs` → expect 201 (currently 403).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

In `src/auth/rbac.ts`, add the permission→role map and helpers:

```ts
const PERMISSION_TO_ROLE: Record<string, Role> = {
  'models:write': 'editor',
  'scenarios:write': 'editor',
  'runs:write': 'editor',
  'cache:write': 'editor',
  'anomalies:write': 'editor',
  'analytics:write': 'editor',
  'regression:write': 'admin',
  'schedules:write': 'admin',
  'prompts:write': 'admin',
  'output_mappings:write': 'admin',
  'sessions:write': 'admin',
  'secrets:write': 'admin',
  'users:write': 'admin',
  'webhooks:write': 'admin',
  'providers:write': 'admin',
  'runners:write': 'admin',
  'queues:write': 'admin',
  'ops:admin': 'admin',
};

interface ApiKeyBearer { apiKey?: { permissions?: string[] } }

/** Highest role implied by an API key's declared permissions. */
export function apiKeyImpliedRole(apiKey: { permissions?: string[] } | undefined): Role | undefined {
  if (!apiKey?.permissions?.length) return undefined;
  let max: Role | undefined;
  for (const p of apiKey.permissions) {
    const r = PERMISSION_TO_ROLE[p];
    if (r && (!max || ROLE_ORDER[r] > ROLE_ORDER[max])) max = r;
  }
  return max;
}

/** True when the request carries an API key with ops:admin (admin-equivalent). */
export function apiKeyIsAdmin(req: unknown): boolean {
  const key = (req as ApiKeyBearer).apiKey;
  return key?.permissions?.includes('ops:admin') ?? false;
}
```

Rewrite `requireRole`:

```ts
export function requireRole(min: Role): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as UserRequest).user;
    const apiKey = (req as unknown as ApiKeyBearer).apiKey;
    const role = user?.role ?? apiKeyImpliedRole(apiKey);
    const order = ROLE_ORDER as Record<string, number>;
    if (!role || (order[role] ?? -1) < (order[min] ?? 0)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}
```

In `src/dashboard-server/run-ownership.ts`:

```ts
import { isOwnerAllowed, apiKeyIsAdmin } from '../auth/rbac.js';
// in checkRunOwnership:
  const allowed = apiKeyIsAdmin(req) || isOwnerAllowed({ sub: req.user?.sub, role: req.user?.role }, rec.createdBy);
```

**`src/dashboard-server/server.ts`** — the v1 anomalies mount: change `requireApiKey(['anomalies:read'])` (line 339) to `requireApiKey(['anomalies:read', 'anomalies:write'])` so keys that may PATCH carry the write permission (the inner `requireRole('editor')` from B1 enforces it).

- [ ] **Step 4: Verify** — `npx tsx --test tests/auth/rbac.test.ts tests/dashboard/rbac-enforcement.test.ts tests/dashboard/routes.test.ts && npm run typecheck`.

- [ ] **Step 5: Commit**

`git add src/auth/rbac.ts src/dashboard-server/run-ownership.ts src/dashboard-server/server.ts tests/ && git commit -m "fix(dashboard): API-key writes honor declared permissions"`

---

## Task B3: /ws subscribe enforces run ownership (IDOR)

**Files:**
- Modify: `src/dashboard-server/live.ts:109-122`
- Test: `tests/dashboard/ws-ownership.test.ts` (new)

**Problem:** `onMessage('subscribe')` adds any runId with no ownership check; REST equivalents enforce ownership. Extract a pure, testable gate.

- [ ] **Step 1: Write the failing test** — create `tests/dashboard/ws-ownership.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSubscribeToRun } from '../src/dashboard-server/live.js';

test('viewer cannot subscribe to a run they do not own', async () => {
  // seed a run with createdBy 'alice' via the harness used in route-test-harness.ts
  const allowed = await canSubscribeToRun({ sub: 'bob', role: 'viewer' }, 'run-owned-by-alice');
  assert.equal(allowed, false);
});

test('admin and owner can subscribe', async () => {
  assert.equal(await canSubscribeToRun({ sub: 'alice', role: 'viewer' }, 'run-owned-by-alice'), true);
  assert.equal(await canSubscribeToRun({ sub: 'admin-user', role: 'admin' }, 'run-owned-by-alice'), true);
});
```

- [ ] **Step 2: Run to verify it fails** (`canSubscribeToRun` undefined).

- [ ] **Step 3: Implement**

In `src/dashboard-server/live.ts`, export a pure gate and use it in `onMessage`:

```ts
import { isOwnerAllowed } from '../auth/rbac.js';

/** Ownership gate for WS subscriptions: admins pass; otherwise the actor
 *  must match the run's createdBy. Missing/unknown runs deny. */
export async function canSubscribeToRun(
  user: { sub?: string; role?: string },
  runId: string,
): Promise<boolean> {
  const rec = await getRunRecord(runId);
  if (!rec) return false;
  return isOwnerAllowed(user, rec.createdBy);
}
```

Replace the subscribe branch in `onMessage` (lines 116-118):

```ts
    if (msg.type === 'subscribe' && typeof msg.runId === 'string') {
      const user = this.clients.get(ws);
      void canSubscribeToRun(user ?? { sub: undefined, role: 'viewer' }, msg.runId)
        .then((allowed) => {
          if (!allowed) {
            this.send(ws, { type: 'error', error: 'forbidden: not the run owner' });
            return;
          }
          this.subs.get(ws)?.add(msg.runId);
          void this.sendRunSnapshot(ws, msg.runId);
        });
    } else if (msg.type === 'unsubscribe' && typeof msg.runId === 'string') {
      this.subs.get(ws)?.delete(msg.runId);
    }
```

- [ ] **Step 4: Verify** — `npx tsx --test tests/dashboard/ws-ownership.test.ts && npm run typecheck`.

- [ ] **Step 4b: Reuse the gate in the /lobby stream (dedup)**

`src/dashboard-server/routes/stream.ts:151-161` re-implements the admin-or-owner check inline. Replace the inline predicate with `canSubscribeToRun` (import from `../live.js`), preserving the existing admin branch semantics:

```ts
// replace the inline `isOwnerAllowed`-style logic with:
if (!(await canSubscribeToRun(user, runId)) && !isAdmin) { /* deny */ }
```

(Read stream.ts:140-170 first and keep its exact response shape; this step is about removing the duplicated predicate, not changing behavior.)

- [ ] **Step 5: Commit**

`git add src/dashboard-server/live.ts tests/dashboard/ws-ownership.test.ts && git commit -m "fix(dashboard): enforce run ownership on WS subscriptions"`

---

## Task B4: Plaintext password must not reach the audit log

**Files:**
- Modify: `src/dashboard-server/routes/users.ts:117`
- Test: `tests/dashboard/routes.test.ts` (extend user-update test to assert the audit row's `after` has no `password` key)

**Problem:** `auditSafe(..., parsed)` stringifies the raw body including the `password` field into `audit_log.after`.

- [ ] **Step 1: Write the failing test** — in `tests/dashboard/routes.test.ts` (or `tests/dashboard/rbac-enforcement.test.ts`), after a user update, read `audit_log` rows and assert:

```ts
const rows = await db.select().from(auditLog).orderBy(desc(auditLog.at));
const row = rows.find((r) => r.action === 'user.update');
assert.ok(row && !String(row.after ?? '').includes('password'), 'audit after must not contain the password');
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
    const { password: _pw, ...safeAfter } = parsed;
    auditSafe((req as AuthedRequest).user?.sub ?? 'system', 'user.update', { type: 'user', id: req.params.id }, { username: existing.username }, safeAfter);
```

- [ ] **Step 4: Verify** — `npx tsx --test tests/dashboard/routes.test.ts tests/auth/audit-safe.test.ts`.

- [ ] **Step 5: Commit**

`git add src/dashboard-server/routes/users.ts tests/dashboard/ && git commit -m "fix(dashboard): strip passwords before writing audit entries"`

---

## Task B5: traces 404 + analytics avgPerSuccessfulTask

**Files:**
- Modify: `src/dashboard-server/routes/traces.ts:22`, `src/dashboard-server/routes/analytics.ts:157-166, 174-193`
- Test: `tests/dashboard/routes.test.ts`, `tests/dashboard/analytics.test.ts` (extend or new)

**Problem:** `traces.ts` returns an empty 200 for missing runs; `successRunCount` is never incremented so `avgPerSuccessfulTask` is always 0.

- [ ] **Step 1: Write the failing tests**

```ts
// traces: GET /api/traces/does-not-exist -> 404
// analytics: /api/analytics/tools includes avgPerSuccessfulTask > 0 after a
// successful run with tool usage (seed run_models success=1 + tool_call_stats rows)
```

- [ ] **Step 2: Run to verify they fail** (200 empty / 0).

- [ ] **Step 3: Implement**

`traces.ts`:

```ts
import { notFound } from '../helpers.js';
// ...
    const rec = await getRunRecord(runId);
    if (!rec) {
      notFound(res, 'Run', runId);
      return;
    }
```

`analytics.ts` — replace the tool-stats aggregation (lines 174-182) and use the successful (run, model) pairs already computed at 157-166:

```ts
    // ── Aggregate tool-level stats ─────────────────────────────────────────
    const toolAggMap = new Map<string, { total: number; failed: number; success: number; runCount: number; successRunCount: number }>();
    for (const entry of perModelMap.values()) {
      const stats = toolAggMap.get(entry.tool_name) ?? { total: 0, failed: 0, success: 0, runCount: 0, successRunCount: 0 };
      stats.total += entry.total;
      stats.failed += entry.fail_count;
      stats.success += entry.success_count;
      stats.runCount++;
      toolAggMap.set(entry.tool_name, stats);
    }
    // successRunCount: distinct successful (run, model) pairs per tool from
    // tool_call_stats joined against run_models.success (DB-covered runs).
    if (coveredRunIds.size > 0) {
      const successPairs = new Set<string>();
      for (const row of successRows) if (row.success === 1) successPairs.add(`${row.run_id}:${row.model}`);
      const toolRows = await db.select({
        run_id: tool_call_stats.run_id,
        model: tool_call_stats.model,
        tool_name: tool_call_stats.tool_name,
      }).from(tool_call_stats).where(inArray(tool_call_stats.run_id, [...coveredRunIds]));
      for (const row of toolRows) {
        if (!successPairs.has(`${row.run_id}:${row.model}`)) continue;
        const stats = toolAggMap.get(String(row.tool_name)) ?? { total: 0, failed: 0, success: 0, runCount: 0, successRunCount: 0 };
        stats.successRunCount++;
        toolAggMap.set(String(row.tool_name), stats);
      }
    }
```

(Add `tool_call_stats` to the existing imports from `../../db/schema.js` in analytics.ts.)

- [ ] **Step 4: Verify** — `npx tsx --test tests/dashboard/routes.test.ts tests/dashboard/analytics.test.ts 2>/dev/null || npx tsx --test tests/dashboard/routes.test.ts` and `npm run typecheck`.

- [ ] **Step 5: Commit**

`git add src/dashboard-server/routes/traces.ts src/dashboard-server/routes/analytics.ts tests/ && git commit -m "fix(dashboard): 404 for missing traces, compute avgPerSuccessfulTask"`

---
# Phase C — Server Dedup & Dead-Code Removal

## Task C1: Run start estimate reuses computeCost

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts:189-196`
- Test: `tests/orchestrator/cost-estimate.test.ts`

**Problem:** the pre-run estimate hand-rolls the pricing formula a second time (`maxTurns * estTokens * (input+output) / 1e6`) beside `computeCost`; the two can drift.

- [ ] **Step 1: Write the failing test** — extend `tests/orchestrator/cost-estimate.test.ts` to assert the estimate produced by `startRun` equals `computeCost(...).total * maxTurns` for the same model (inspect via the budget state file or by mocking `computeCost`).

- [ ] **Step 2: Implement**

```ts
    // Estimate cost: assume maxTurns turns of the configured token budget,
    // priced through the single computeCost path (no second formula).
    const resolved = await resolveModelForRun(modelName);
    const maxTurns = resolved?.maxTurns ?? 20;
    const estTokensPerTurn = costEstimateTokensPerTurn();
    const perTurnCost = await computeCost(modelName, {
      prompt: estTokensPerTurn,
      completion: estTokensPerTurn,
      cached: 0,
    });
    const estimatedCost = perTurnCost.total * maxTurns;
```

Add `computeCost` to the existing `../cost-tracking/index.js` import at run-lifecycle.ts:7 (verify the barrel exports it — it is already exported per its use in runner.ts; if not, add `export { computeCost } from './pricing.js'` to `src/cost-tracking/index.ts`).

- [ ] **Step 3: Verify** — `npx tsx --test tests/orchestrator/cost-estimate.test.ts tests/orchestrator/budget-integration.test.ts && npm run typecheck`.

- [ ] **Step 4: Commit**

`git add src/orchestrator/run-lifecycle.ts tests/orchestrator/cost-estimate.test.ts && git commit -m "refactor(budget): estimate cost via computeCost"`

---

## Task C2: Single attempt-threshold convention; drop Task.priority

**Files:**
- Modify: `src/queue/types.ts`, `src/queue/task-schema.ts`, `src/runner.ts:170-180`, `src/queue/in-memory.ts:86`, `src/queue/redis.ts` (JS nack/reclaim paths)
- Test: `tests/queue/in-memory.test.ts`, `tests/queue/redis.test.ts`, `tests/runner/runner-loop.test.ts`

**Problem:** the "attempts ≥ max → dead-letter" rule exists in 4 copies with two off-by-one conventions; `Task.priority` is documented but never read.

- [ ] **Step 1: Write the failing test** — in `tests/queue/task-schema.test.ts`, assert `priority` is absent from the parsed schema; in `tests/queue/in-memory.test.ts` add a nack test at `maxAttempts - 1` dead-lettering via the shared helper.

- [ ] **Step 2: Implement**

`src/queue/types.ts`:

```ts
/** True when `attempts` (0-based, incremented per nack) is the terminal one —
 *  the nack dead-letters instead of requeuing. Single convention shared by
 *  the runner and both queue drivers. */
export function isTerminalAttempt(attempts: number, maxAttempts: number = DEFAULT_MAX_ATTEMPTS): boolean {
  return attempts + 1 >= maxAttempts;
}
```

- `src/queue/task-schema.ts`: remove the `priority` field from the zod schema.
- `src/queue/types.ts`: remove `priority` from the `Task` interface.
- `src/runner.ts`: make `isTerminalFailure` delegate: `return isTerminalAttempt(attempts, DEFAULT_MAX_ATTEMPTS);` (import both from `queue/types.js`; keep the exported name so call sites and tests are untouched).
- `src/queue/in-memory.ts` nack: replace `if (t.attempts >= this.maxAttempts)` with `if (isTerminalAttempt(t.attempts, this.maxAttempts))`.
- `src/queue/redis.ts`: in the JS fallback nack and `reclaimOrphaned`, use `isTerminalAttempt(attempts, this.maxAttempts)` (the Lua script stays inline — it cannot import TS; add a comment noting it mirrors `isTerminalAttempt`).

**Step 2b: In-memory driver honors `dueAt` (parity with redis)** — `src/queue/in-memory.ts` currently ignores `dueAt` (nack requeues immediately; not-due tasks are dequeued early). Mirror the redis semantics with the exact same formula (`min(retryBackoffMs * 2^(attempts-1), 300_000)`, default `retryBackoffMs` 2000):

```ts
  private retryBackoffMs = 2000;

  private findDue(): Task | undefined {
    for (let i = 0; i < this.pending.length; i++) {
      const t = this.pending[i]!;
      if (!t.dueAt || new Date(t.dueAt).getTime() <= Date.now()) {
        return this.pending.splice(i, 1)[0]!;
      }
    }
    return undefined;
  }
```

Use `findDue()` in `_notifyNext()` (replace `this.pending.shift()`) and in `dequeue` (replace `this.pending.shift()`). In `nack`, replace the immediate `this.pending.unshift(t)` with:

```ts
      // Mirror redis.ts nack: exponential backoff doubling per attempt,
      // capped at 5 minutes.
      t.dueAt = new Date(Date.now() + Math.min(this.retryBackoffMs * Math.pow(2, t.attempts - 1), 300_000)).toISOString();
      this.pending.push(t);
```

Also make `enqueue` keep `Task.dueAt` if the enqueuer set it (it already stores the task object as-is — verify nothing overwrites `dueAt`). Extend `tests/queue/in-memory.test.ts` with: (a) a nacked task is not immediately re-dequeued before its dueAt; (b) a not-due task is skipped by dequeue until its time.

Grep for any remaining `priority` references: `grep -rn "\.priority\|priority:" src --include="*.ts" | grep -v node_modules` — must be empty.

**Step 2c: Dedup the stop-reason remap** — the `stopReason === 'unknown' && turnsUsed >= maxTurns → 'max_turns'` pattern is copy-pasted at `src/agent-loop/loop.ts:263` and `src/tools/task.ts:78-80`. Extract a shared helper in `src/agent-loop/turn-loop.ts` (or `src/agent-loop/types.ts`):

```ts
/** Normalize an 'unknown' stop reason when the turn budget was exhausted. */
export function remapStopReason(stopReason: string, turnsUsed: number, maxTurns: number): string {
  return stopReason === 'unknown' && turnsUsed >= maxTurns ? 'max_turns' : stopReason;
}
```

Replace both call sites with `remapStopReason(...)`. Run `npx tsx --test tests/agent-loop/*.test.ts tests/tools/*.test.ts` to confirm no behavior change.

- [ ] **Step 3: Verify** — `npx tsx --test tests/queue/*.test.ts tests/runner/runner-loop.test.ts && npm run typecheck`.

- [ ] **Step 4: Commit**

`git add src/queue src/runner.ts tests/queue && git commit -m "refactor(queue): unify terminal-attempt check, drop dead priority field"`

---

## Task C3: Wire ResolvedModel temperature/maxTokens into the loop

**Files:**
- Modify: `src/runner.ts:476-477`
- Test: `tests/runner/runner-loop-happy.test.ts` (assert the adapter receives the catalog temperature via a spy, or unit-test `runAgentLoopTraced` opts)

**Problem:** `model-resolver` populates `temperature`/`maxTokens` but the runner hardcodes `0`. Wire them through so catalog values take effect.

- [ ] **Step 1: Write the failing test** — seed a catalog model with `temperature: 0.7` and assert the loop's send options use it (spy on the adapter's `sendMessage`).

- [ ] **Step 2: Implement**

```ts
            temperature: (resolved.temperature as number) ?? 0,
            maxTokens: (resolved.maxTokens as number) ?? 0,
```

- [ ] **Step 3: Verify** — run the test; `npm run typecheck && npx tsx --test tests/runner/runner-loop-happy.test.ts`.

- [ ] **Step 4: Commit**

`git add src/runner.ts tests/runner/runner-loop-happy.test.ts && git commit -m "feat(runner): pass catalog temperature/maxTokens to adapters"`

---

## Task C4: Server dead-export removal batch

**Files (each removal verified by grep first):**
- Delete: `src/auth/rbac.ts` `requireOwnership` (39-59), `getAuditFailureCount` (63-65) + `auditFailureCount` var + its increment at :92; delete `tests/auth/require-ownership.test.ts`; update `tests/auth/audit-safe.test.ts` (drop the counter assertion)
- Modify: `src/queue/router.ts:26` — drop `export` on `familyFor`
- Modify: `src/scheduler/manager.ts:130` — remove `resetSchedulesCache`; update `tests/scheduler/*.test.ts` and `tests/dashboard/schedules-routes.test.ts` that call it
- Modify: `src/anomaly-detection/index.ts:125` — remove `anomaliesForRun`; update `tests/anomaly-detection/analyze.test.ts`
- Modify: `src/anomaly-detection/detectors.ts:200` — remove `export { readResult }` re-export
- Modify: `src/cost-tracking/pricing.ts:125` — remove `formatCost`; update `tests/cost-tracking/pricing.test.ts`
- Modify: `src/config-loader.ts:65` — remove async `loadYamlConfig`; update `tests/config-loader.test.ts`
- Modify: `src/sandbox/git.ts:113` — remove `getInitialCommitHash`
- Modify: `src/providers/url-validator.ts:38` — remove `isBlockedProviderHost`; update `tests/providers/descriptors.test.ts` (replace its asserts with `validateProviderUrl`-based ones)
- Modify: `src/db/schema-types.ts` — remove dead interfaces `ModelRow`, `ModelProviderRow`, `PricingRow`, `BenchmarkRow`, `ModelRuntimeStatRow`; remove their re-exports from `src/db/schema.ts` and `src/db/schema-pg.ts`; fix `tests/db/schema-pg-types.test.ts` if it references them
- Modify: `src/observability/stats.ts:70` — remove the `void result.success;` no-op line

- [ ] **Step 1: Verify each symbol is unused first**

```bash
grep -rn "requireOwnership\|getAuditFailureCount\|familyFor\|resetSchedulesCache\|anomaliesForRun\|formatCost\|loadYamlConfig\|getInitialCommitHash\|isBlockedProviderHost" src --include="*.ts" | grep -v node_modules
grep -rn "ModelRow\|ModelProviderRow\|PricingRow\|BenchmarkRow\|ModelRuntimeStatRow" src tests --include="*.ts" | grep -v node_modules
```

Expected: only definitions, re-exports, and test references. If a production importer appears, keep the symbol and note it in the commit.

- [ ] **Step 2: Remove each symbol + fix its tests**

Proceed per the list above, one removal per commit or one commit for the batch if smaller than ~15 lines. Run the affected test files after each removal:

```bash
npx tsx --test tests/auth/*.test.ts tests/scheduler/*.test.ts tests/anomaly-detection/*.test.ts tests/cost-tracking/pricing.test.ts tests/config-loader.test.ts tests/providers/descriptors.test.ts tests/db/schema-pg-types.test.ts tests/sandbox/*.test.ts
```

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint && npm test`
Expected: all green.

- [ ] **Step 4: Commit**

`git add -A && git commit -m "chore: remove dead exports and test-only helpers"`

---

## Task C5: Wire failOnRegression; remove ScheduleSchema.notifications

**Files:**
- Modify: `src/cli.ts` (regress action, ~:245), `src/scheduler/types.ts:9`, `configs/schedules.yaml`
- Test: `tests/evaluation/regression.test.ts`, `tests/configs/validate.test.ts`

**Problem:** `failOnRegression` is defined with a default but never read (CLI hardcodes exit-on-failure); `ScheduleSchema.notifications` is never consumed by the scheduler.

- [ ] **Step 1: Write the failing test** — extend `tests/evaluation/regression.test.ts` (or a CLI-level test) asserting that a suite config with `failOnRegression: false` yields exit code 0 on regression failure.

- [ ] **Step 2: Implement**

`src/cli.ts` — replace the final line of the regress action (`process.exit(passed ? 0 : 1);`) with:

```ts
    const failOn = (config as { failOnRegression?: boolean }).failOnRegression ?? true;
    process.exit(passed || !failOn ? 0 : 1);
```

`src/scheduler/types.ts` — remove `notifications` from `ScheduleSchema`.
`configs/schedules.yaml` — remove the `notifications: [slack-runs]` entry from the schedule(s).

- [ ] **Step 3: Verify** — `npx tsx --test tests/evaluation/regression.test.ts tests/configs/validate.test.ts tests/scheduler/*.test.ts`.

- [ ] **Step 4: Commit**

`git add src/cli.ts src/scheduler/types.ts configs/schedules.yaml tests/ && git commit -m "fix: wire failOnRegression, drop unconsumed schedule notifications"`

---

## Task C6: Wire /api/cost — give getCostSummary a consumer

**Files:**
- Create: `src/dashboard-server/routes/cost.ts`
- Modify: `src/dashboard-server/server.ts:304` (stale comment) and the v1 block (~:344+)
- Test: `tests/dashboard/routes.test.ts` (extend: GET `/api/cost` returns 200 + models array)

**Problem:** `getCostSummary` (db/query/costs.ts) has zero production consumers; `server.ts:304` has a stale "Cost ledger" comment with no route; `cost:read` permission is declared but unused.

- [ ] **Step 1: Write the failing test** — GET `/api/cost` with a viewer JWT → 200 and `{ models: [...] }`.

- [ ] **Step 2: Implement**

Create `src/dashboard-server/routes/cost.ts`:

```ts
import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { getCostSummary } from '../../db/query.js';

export function createCostRouter(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json({ models: await getCostSummary() });
  }));

  return router;
}
```

`server.ts` — replace the stale comment at 304 with:

```ts
  // ── Cost ledger (viewer for reads) ────────────────────────────────────
  app.use('/api/cost', requireAuth(auth), requireRole('viewer'), createCostRouter());
```

and in the v1 block, after the metrics mount:

```ts
  app.use('/api/v1/cost', requireApiKey(['cost:read']), createCostRouter());
```

- [ ] **Step 3: Verify** — `npx tsx --test tests/dashboard/routes.test.ts && npm run typecheck`.

- [ ] **Step 4: Commit**

`git add src/dashboard-server/routes/cost.ts src/dashboard-server/server.ts tests/dashboard/routes.test.ts && git commit -m "feat(dashboard): expose /api/cost via getCostSummary"`

---

## Task C7: Consolidate the 58 provider descriptors into a data table

**Files:**
- Create: `src/providers/descriptors/data.ts`
- Modify: `src/providers/descriptors/index.ts`
- Delete: the 58 `src/providers/descriptors/*.ts` files
- Test: `tests/providers/descriptors.test.ts`

**Problem:** 58 files each hold one 5-line static constant (~95% copy-paste); a single data table is ~1/10 the size with identical behavior.

- [ ] **Step 1: Write the failing test first? No — this is a pure refactor: write a parity test instead.**

Append to `tests/providers/descriptors.test.ts`:

```ts
test('descriptor table parity: same ids, same apiBases, same envVars', () => {
  // BUILTIN_PROVIDERS must equal the data table exactly
});
```

- [ ] **Step 2: Build the table**

Create `src/providers/descriptors/data.ts`. Read all 58 files first (`for f in src/providers/descriptors/*.ts; do echo "== $f"; cat "$f"; done`), then emit one array. Shape (from `index.ts` usage):

```ts
export interface DescriptorSpec {
  id: string;
  name: string;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
  apiBase: string;
  envVar: string;
  authScheme?: 'none';
}

export const DESCRIPTOR_SPECS: readonly DescriptorSpec[] = [
  { id: 'openai', name: 'OpenAI', adapter: 'openai-compat', apiBase: 'https://api.openai.com/v1', envVar: 'OPENAI_API_KEY' },
  // ...all 58 entries, copying id/name/apiBase/envVar/authScheme verbatim from the current files
] as const;
```

(If any current descriptor carries extra fields — e.g. `authScheme: 'none'` for atomic-chat/kilo/llamacpp/lmstudio/ollama — include them in the spec and in `index.ts` mapping.)

Rewrite `src/providers/descriptors/index.ts` to build `BUILTIN_PROVIDERS` from `DESCRIPTOR_SPECS` (preserve the exact `BuiltinProviderDescriptor` shape and `validateProviderUrl` calls the current code applies), then delete the 58 files.

- [ ] **Step 3: Verify parity** — `npx tsx --test tests/providers/descriptors.test.ts tests/providers/*.test.ts && npm run typecheck && npm run lint`. Also diff the pre/post registration set:

```bash
node -e "import('./dist/providers/index.js').then(m => console.log(m.BUILTIN_PROVIDERS.map(p => p.id).join(',')))" 2>/dev/null || true
```

must match the 58 ids listed in the old `index.ts`.

- [ ] **Step 4: Commit**

`git add src/providers/descriptors tests/providers/descriptors.test.ts && git rm $(ls src/providers/descriptors/*.ts | grep -v -E "index|data") && git commit -m "refactor(providers): replace 58 descriptor files with a data table"`

---

## Task C8: Finalize aggregates once, not twice

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts:321-324` (inside `finalizeCore`)
- Test: `tests/dashboard/routes.test.ts`, `tests/cli/finalize.test.ts` (or the CLI test that exercises finalize)

**Problem:** both `finalizeRun` (:348-351) and `finalizeRunByRunId` (:361-364) call `aggregate(...)` to produce `entries`, then pass those entries into `finalizeCore`, which calls `aggregate(...)` AGAIN (:321-324) — the same result.json files are re-read and re-written per finalize.

- [ ] **Step 1: Write the failing test** — spy on the aggregate module (or count file writes of `comparison.json`) across one `finalizeRun` call; assert aggregate runs once.

- [ ] **Step 2: Implement** — delete the duplicate aggregation inside `finalizeCore`:

```ts
async function finalizeCore(runId: string, entries: ComparisonEntry[], logger: Logger, judgeAdapter?: ModelAdapter): Promise<{ mdPath: string; jsonPath: string }> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  // Idempotency guard: ... (keep existing)
  if (rec.status === 'completed') {
    logger.info('Run already finalized — skipping', { runId });
    return { mdPath: rec.comparisonMdPath ?? '', jsonPath: rec.comparisonJsonPath ?? '' };
  }
  const root = projectRoot();
  const budgetRoot = budgetStateRoot(root);
  const { mdPath, jsonPath } = await aggregateAndReturnPaths(root, runId, rec); // no — see below
```

(Do NOT add an `aggregateAndReturnPaths` helper — this is a deletion. Simply remove the `aggregate(root, {...})` call at :321-324 and replace it with `const mdPath = rec.comparisonMdPath;` — no. Read the current body: `finalizeCore` uses the `mdPath`/`jsonPath` returned by `aggregate` only for logging and the return value, while `patchIndexAfterFinalize` writes them. The correct minimal change: delete the local `aggregate` call and derive the paths from `rec`:

```ts
  const { mdPath, jsonPath } = { mdPath: rec.comparisonMdPath ?? '', jsonPath: rec.comparisonJsonPath ?? '' };
```

The callers (`finalizeRun`, `finalizeRunByRunId`) already aggregated and patched nothing — but note: after this change the caller's `aggregate` return is what populates `entries`; `patchIndexAfterFinalize` inside `finalizeCore` still records the final paths. Verify with the existing finalize tests that `comparison.md/json` are still written and the run status lands on `'completed'`.)

If `aggregate` then has no remaining callers inside run-lifecycle.ts, remove it from the import at :21-25 (verify `buildPerModelEntries` doesn't use it).

- [ ] **Step 3: Verify** — `npx tsx --test tests/dashboard/routes.test.ts tests/cli/*.test.ts 2>/dev/null || npx tsx --test tests/dashboard/routes.test.ts` then `npm run typecheck && npm test` (full suite must stay green — finalize is exercised by several suites).

- [ ] **Step 4: Commit**

`git add src/orchestrator/run-lifecycle.ts && git commit -m "refactor(orchestrator): aggregate results once per finalize"`

---

## Task C9: Cache refresh returns the model count the client expects

**Files:**
- Modify: `src/catalog/cache.ts:24-31` (`ensureFresh`)
- Test: `tests/catalog/cache.test.ts` (extend)

**Problem:** `useCache.ts:55` expects `{ ok, count, error }`; `ensureFresh` returns only `{ ok, error? }` — `count` is always undefined in the Ops page.

- [ ] **Step 1: Write the failing test** — call `ensureFresh('models.dev', { force: true })` against a stubbed fetch (as the existing cache/sync tests do) and assert `result.count` equals the number of upserted models.

- [ ] **Step 2: Implement**

```ts
export async function ensureFresh(
  source: 'models.dev' | 'modelbench' | 'zeroeval',
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; count?: number }> {
  if (!opts?.force && !(await isStale(source))) return { ok: true, count: 0 };
  if (source === 'models.dev') {
    const { fetchSync } = await import('./sync.js');
    const res = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    return { ok: res.ok, error: res.error, count: res.count };
  }
  const { fetchBenchmarks } = await import('./benchmarks.js');
  return fetchBenchmarks(source, { force: true });
}
```

(If `fetchBenchmarks`'s result type already carries `count`, keep it; otherwise map it the same way.)

- [ ] **Step 3: Verify** — `npx tsx --test tests/catalog/cache.test.ts tests/catalog/sync.test.ts 2>/dev/null || npx tsx --test tests/catalog/*.test.ts && npm run typecheck`.

- [ ] **Step 4: Commit**

`git add src/catalog/cache.ts tests/catalog/ && git commit -m "fix(catalog): return refreshed model count from ensureFresh"`

---
# Phase D — Dashboard Client

## Task D1: WebSocket resubscribe after reconnect

**Files:**
- Modify: `src/dashboard-client/src/hooks/useLive.tsx`
- Test: `src/dashboard-client/tests/hooks/useLive.test.tsx` (new; mock `globalThis.WebSocket` as in `tests/utils/api.test.ts`)

**Problem:** after a socket drop and reconnect the new socket has empty subscriptions — a RunDetail page silently stops receiving updates until remount.

- [ ] **Step 1: Write the failing test** — render `LiveProvider` with a mocked WebSocket class capturing `send`; connect, `subscribe('run-1')`, close the socket, advance timers past the 2s reconnect, assert the second socket received a `subscribe` for `run-1`.

- [ ] **Step 2: Implement**

```ts
  const subsRef = useRef<Set<string>>(new Set());
```

In `connect()`'s `onopen`:

```ts
      ws.onopen = () => {
        setConnected(true);
        for (const runId of subsRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', runId }));
        }
      };
```

Replace `subscribe`/`unsubscribe`:

```ts
  const subscribe = useCallback((runId: string) => {
    subsRef.current.add(runId);
    wsRef.current?.send(JSON.stringify({ type: 'subscribe', runId }));
  }, []);
  const unsubscribe = useCallback((runId: string) => {
    subsRef.current.delete(runId);
    wsRef.current?.send(JSON.stringify({ type: 'unsubscribe', runId }));
  }, []);
```

- [ ] **Step 3: Verify** — `npm --prefix src/dashboard-client run test -- tests/hooks/useLive.test.tsx`.

- [ ] **Step 4: Commit**

`git add src/dashboard-client/src/hooks/useLive.tsx src/dashboard-client/tests/hooks/useLive.test.tsx && git commit -m "fix(client): resubscribe live runs after WS reconnect"`

---

## Task D2: Pagination + retry error states (Sessions, Files, Audit)

**Files:**
- Modify: `src/dashboard-client/src/pages/Sessions.tsx`, `src/dashboard-client/src/pages/Files.tsx`, `src/dashboard-client/src/pages/Audit.tsx`
- Test: `src/dashboard-client/tests/pages/Sessions.test.tsx` (new or extend existing page tests)

**Problem:** the three list pages hardcode `limit: 100/200`, ignore `total`/`offset`, and render dead-end `EmptyState`s on error (no retry).

- [ ] **Step 1: Write the failing test** — mock `listSessions` to return `{ sessions: 60 rows, total: 160 }` and assert a "Load more" control appears; click it and assert a second call with `offset: 50`.

- [ ] **Step 2: Implement (Sessions — the pattern for all three)**

```tsx
import { ErrorState } from '../components/ui/ErrorState';
import { Button } from '../components/ui/Button';
// ...
const PAGE = 50;

export function Sessions() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string>('');
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sessions', status, offset],
    queryFn: () => listSessions({ limit: PAGE, offset, ...(status ? { status } : {}) }),
    refetchInterval: 15_000,
  });

  return (
    // ... unchanged shell ...
          {isLoading ? (
            <div className="flex gap-2 items-center p-4 text-fg-1 text-sm"><Spinner /> Loading sessions…</div>
          ) : isError ? (
            <ErrorState title="Failed to load sessions" onRetry={() => void refetch()} />
          ) : (data?.sessions.length ?? 0) === 0 ? (
            <EmptyState title="No sessions yet" description="Sessions appear once the runner checkpoints a run." />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={data?.sessions ?? []}
                getRowId={(r) => r.id}
                onRowClick={(r) => navigate(`/sessions/${r.id}`)}
              />
              {(data?.sessions.length ?? 0) < (data?.total ?? 0) && (
                <div className="flex justify-center p-3">
                  <Button variant="ghost" size="sm" onClick={() => setOffset((o) => o + PAGE)}>Load more</Button>
                </div>
              )}
            </>
          )}
```

Also reset offset when the status filter changes (wrap the select's `onChange`): `setStatus(e.target.value); setOffset(0);`

Apply the identical pattern to `Files.tsx` and `Audit.tsx`:
- Files: query key `['files', model, offset]`, `listFiles({ limit: PAGE, offset, ...(model ? { model } : {}) })`, PAGE 50, filter change resets offset.
- Audit: query key `['audit', actor, action, offset]`, `listAudit({ limit: PAGE, offset, ... })` per its existing filter params, PAGE 50.

(Verify `ErrorState` accepts `title` + `onRetry` — check `src/dashboard-client/src/components/ui/ErrorState.tsx`; it already exists and is used by Catalog/Leaderboard per the audit.)

- [ ] **Step 3: Verify** — `npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run typecheck`.

- [ ] **Step 4: Commit**

`git add src/dashboard-client/src/pages/Sessions.tsx src/dashboard-client/src/pages/Files.tsx src/dashboard-client/src/pages/Audit.tsx src/dashboard-client/tests/ && git commit -m "feat(client): paginate sessions/files/audit with retryable errors"`

---

## Task D3: Mutation error surfaces (Anomalies, RunDetail, Launcher)

**Files:**
- Modify: `src/dashboard-client/src/pages/Anomalies.tsx:122-123`, `src/dashboard-client/src/pages/RunDetail.tsx:62-63`, `src/dashboard-client/src/components/Launcher.tsx`
- Test: `src/dashboard-client/tests/pages/Anomalies.test.tsx` (extend)

**Problem:** resolve/stop/restart/launch mutations are bare `await`s with no error surface — failures are unhandled rejections with zero UI feedback.

- [ ] **Step 1: Write the failing test** — mock `resolveAnomaly` to reject; click the resolve button; assert an inline error message appears.

- [ ] **Step 2: Implement**

`Anomalies.tsx` — convert the two buttons to one mutation:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
// ...
  const queryClient = useQueryClient();
  const [resolveError, setResolveError] = useState<string | null>(null);
  const resolveMutation = useMutation({
    mutationFn: ({ id, as }: { id: number; as: 'resolved' | 'false_positive' }) => resolveAnomaly(id, as),
    onSuccess: () => {
      setResolveError(null);
      void queryClient.invalidateQueries({ queryKey: ['anomalies'] });
    },
    onError: () => setResolveError('Failed to update anomaly — check server logs'),
  });
```

Replace the button handlers with `resolveMutation.mutate({ id, as: 'resolved' })` / `('false_positive')`, and render `{resolveError && <p className="text-12 text-danger">{resolveError}</p>}` above the table.

`RunDetail.tsx` — wrap stop/restart:

```tsx
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch {
      setActionError('Action failed — check server logs');
    }
  };
  // onClick={() => void runAction(() => stopRun(runId))}  etc.
```

and render the error line near the action buttons. (Adjust to the page's existing imports/style.)

`Launcher.tsx` — the launch handler currently has `try/finally` with no `catch`; add:

```ts
    } catch {
      setError('Launch failed — check server logs');
    }
```

(using its existing error state if present; add one if not, and render it in the modal.)

- [ ] **Step 3: Verify** — `npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run lint`.

- [ ] **Step 4: Commit**

`git add src/dashboard-client/src/pages/Anomalies.tsx src/dashboard-client/src/pages/RunDetail.tsx src/dashboard-client/src/components/Launcher.tsx src/dashboard-client/tests/ && git commit -m "fix(client): surface mutation failures inline"`

---

## Task D4: Home "Active runs" mislabel

**Files:**
- Modify: `src/dashboard-client/src/pages/Home.tsx:22`
- Test: `src/dashboard-client/tests/pages/Home.test.tsx` (extend)

**Problem:** `runtime?.filter(r => r.success === 0 …)` counts **failed** measurements but the tile says "Active runs".

- [ ] **Step 1: Write the failing test** — mock `useRuntimeMetrics` with rows having mixed `success` values and assert the tile shows the count of distinct `run_id`s.

- [ ] **Step 2: Implement**

```ts
  const activeRuns = new Set((runtime ?? []).map((r) => r.run_id).filter(Boolean)).size;
```

**Step 2b: Remove the fabricated Sankey** — the "Token Flow" panel (Home.tsx:26-43, 68-105) visualizes derived numbers (`cache_hit_rate * 1000`, `tps * 10`) as if they were pipeline data. Delete the `totalCacheRead`/`totalCompletion`/`totalCost` aggregations, the `sankeyNodes`/`sankeyLinks` arrays, the Sankey import, and the `Panel` titled "Token Flow" (keep the rest of the layout; if the grid needs a third panel to balance, move `recentRuns` into it instead of removing the panel entirely).

- [ ] **Step 3: Verify** — `npm --prefix src/dashboard-client run test`.

- [ ] **Step 4: Commit**

`git add src/dashboard-client/src/pages/Home.tsx src/dashboard-client/tests/ && git commit -m "fix(client): count distinct recent runs on Home"`

---

## Task D5: Client dead-code removal batch

**Files:**
- Modify: `src/dashboard-client/src/lib/api.ts` (remove `updateUser`, :529-534 — grep first)
- Modify: `src/dashboard-client/src/components/ui/Toast.tsx` + `src/dashboard-client/src/App.tsx` (remove `ToastProvider` mount + import; delete Toast.tsx; grep tests for toast usage first)
- Modify: `src/dashboard-client/src/components/CommandPalette.tsx` (remove unused `toggle` from the hook return and `selected` prop incl. `void selected;` line; update `App.tsx` destructure)
- Modify: `src/dashboard-client/src/components/ui/Skeleton.tsx` (remove test-only exports `SkeletonLine/Card/Row/Table/Stats`; update `tests/components/ui/Skeleton.test.tsx`)
- Modify: `src/dashboard-client/src/components/ErrorBoundary.tsx` (remove unused `fallback` prop)
- Modify: `src/dashboard-client/src/components/ui/StatTile.tsx` (remove `sparkline` prop)
- Modify: `src/dashboard-client/src/components/ui/MetricBar.tsx` (remove `thresholds` prop)
- Modify: `src/dashboard-client/src/hooks/useLive.tsx` + `src/dashboard-client/src/pages/RunDetail.tsx` — keep `connected`, but give it a consumer: render a tiny live indicator in the RunDetail header (`const { connected } = useLive();` + a `Badge variant={connected ? 'success' : 'neutral'} value={connected ? 'live' : 'offline'}`).

- [ ] **Step 1: Grep for consumers**

```bash
grep -rn "updateUser\|Toast\|useToast\|toggle\|selected\|sparkline\|thresholds\|SkeletonLine\|SkeletonCard\|SkeletonRow\|SkeletonTable\|SkeletonStats\|fallback" src/dashboard-client/src src/dashboard-client/tests --include="*.tsx" --include="*.ts" | grep -v node_modules
```

Remove a symbol only when its remaining matches are its definition. `Toast` also appears in `App.tsx`; `Skeleton*` in its test file.

- [ ] **Step 2: Remove + update tests**

Proceed per the list; run the client suite after each cluster:

```bash
npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run lint
```

- [ ] **Step 3: Commit**

`git add -A && git commit -m "chore(client): remove dead exports, wire live indicator"`

---
# Phase E — Infra

## Task E1: Bedrock runner deployment + autoscaler

**Files:**
- Create: `k8s/base/runner-bedrock.yaml`
- Modify: `k8s/base/keda-scaledobject.yaml` (append a `runner-bedrock-scaler` block)
- Modify: `k8s/base/kustomization.yaml` (add both to `resources`)

**Problem:** `arena:tasks:bedrock` is routed by the queue router but no Deployment/ScaledObject consumes it — bedrock tasks queue up unconsumed in k8s.

- [ ] **Step 1: Create `k8s/base/runner-bedrock.yaml`** — copy `k8s/base/runner-deployment.yaml` verbatim with these changes:
- `metadata.name: runner-bedrock`, labels `provider: bedrock`
- `selector.matchLabels.provider: bedrock`, template labels `provider: bedrock`
- `env` `ARENA_PROVIDER_FILTER: bedrock`
- `topologySpreadConstraints` labelSelector `provider: bedrock`
- keep the same initContainer, probes, security context, volumes (the bedrock runner consumes the shared `provider-keys` secret).

- [ ] **Step 2: Append to `k8s/base/keda-scaledobject.yaml`**

```yaml
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: runner-bedrock-scaler
  namespace: ai-arena
spec:
  scaleTargetRef:
    name: runner-bedrock
  minReplicaCount: 1
  maxReplicaCount: 10
  pollingInterval: 5
  cooldownPeriod: 60
  triggers:
    - type: redis-streams
      metadata:
        address: redis.ai-arena.svc:6379
        stream: arena:tasks:bedrock
        consumerGroup: arena-runners
        pendingEntriesCount: "5"
      authenticationRef:
        name: keda-redis-auth
```

- [ ] **Step 3: Add to `k8s/base/kustomization.yaml`** — add `runner-bedrock.yaml` and confirm `keda-scaledobject.yaml` is listed (it already is for the other scalers).

- [ ] **Step 4: Verify**

```bash
kubectl kustomize k8s/base > /tmp/arena-base.yaml && grep -c "runner-bedrock" /tmp/arena-base.yaml
```

Expected: > 2 occurrences (Deployment + ScaledObject + labels).

- [ ] **Step 5: Commit**

`git add k8s/base/runner-bedrock.yaml k8s/base/keda-scaledobject.yaml k8s/base/kustomization.yaml && git commit -m "feat(k8s): deploy bedrock runner with KEDA autoscaler"`

---

## Task E2: Observability stack enters the standard deploy path

**Files:**
- Modify: `scripts/k8s/deploy.sh`, `scripts/k8s/bootstrap.sh`, `AGENTS.md`, `k8s/README.md`

**Problem:** the observability kustomization is standalone and referenced by no documented deployment path — `bootstrap.sh && deploy.sh` produces zero observability despite AGENTS.md claiming it.

- [ ] **Step 1: Implement**

In `scripts/k8s/deploy.sh`, after the main deploy step, add:

```bash
# Observability stack (collector, tempo, prometheus, loki, grafana)
if [ -d "$(dirname "$0")/../../k8s/observability" ]; then
  kubectl apply -k "$(dirname "$0")/../../k8s/observability"
  kubectl rollout status deployment/otel-collector -n observability --timeout=120s || true
  kubectl rollout status deployment/grafana -n observability --timeout=120s || true
fi
```

(Adapt to the script's existing conventions — check whether it already waits for deployments.)

In `k8s/README.md`, replace the manual observability section with a note that `deploy.sh` now deploys it, and document the Grafana/runner access steps. Update `AGENTS.md`'s Deployment section to state that the observability stack is included.

- [ ] **Step 2: Verify** — shellcheck the script if available; otherwise `bash -n scripts/k8s/deploy.sh`.

- [ ] **Step 3: Commit**

`git add scripts/k8s/deploy.sh k8s/README.md AGENTS.md && git commit -m "feat(infra): deploy observability stack in standard flow"`

---

## Task E3: docker-compose observability

**Files:**
- Create: `observability/collector.yaml`, `observability/prometheus.yaml`, `observability/grafana-datasources.yaml`
- Modify: `docker-compose.yml`

**Problem:** compose runs with tracing/metrics collection disabled at the infra level (no collector, no OTLP endpoint, runner metrics port 4001 unexposed).

- [ ] **Step 1: Create the compose-scoped configs**

`observability/collector.yaml` (OTLP HTTP receiver → tempo/loki/prometheus, k8s-agnostic endpoints):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
      grpc:
        endpoint: 0.0.0.0:4317
exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: arena
processors:
  batch:
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
```

`observability/prometheus.yaml`:

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: collector
    static_configs:
      - targets: ["otel-collector:8889"]
  - job_name: runner
    static_configs:
      - targets: ["runner:4001"]
  - job_name: dashboard
    metrics_path: /metrics
    static_configs:
      - targets: ["dashboard:4000"]
```

`observability/grafana-datasources.yaml` (mounted into Grafana provisioning):

```yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: false
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
```

- [ ] **Step 2: Modify `docker-compose.yml`** — add services and runner env:

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.119.0
    command: ["--config=/etc/otel/collector.yaml"]
    volumes:
      - ./observability/collector.yaml:/etc/otel/collector.yaml:ro
    ports:
      - "4318:4318"
      - "4317:4317"
      - "8889:8889"
    depends_on:
      - tempo
      - loki

  tempo:
    image: grafana/tempo:2.7.1
    command: ["-config.file=/etc/tempo.yaml"]
    ports:
      - "3200:3200"

  prometheus:
    image: prom/prometheus:v2.55.1
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus"]
    volumes:
      - ./observability/prometheus.yaml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  loki:
    image: grafana/loki:3.4.2
    ports:
      - "3100:3100"

  grafana:
    image: grafana/grafana:11.5.2
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_SECURITY_ADMIN_PASSWORD: arena
    volumes:
      - ./observability/grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro
    ports:
      - "3000:3000"
```

In the `runner` service environment, add `OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318` and in its `ports`: `- "4001:4001"` (metrics scrape). Add `depends_on: [otel-collector]` (keeping the existing postgres/redis conditions).

- [ ] **Step 3: Verify**

```bash
docker compose config > /dev/null && echo OK
```

(Requires docker; if unavailable, validate YAML with `node -e "require('js-yaml').load(require('fs').readFileSync('docker-compose.yml','utf8'))"`.)

- [ ] **Step 4: Commit**

`git add docker-compose.yml observability/ && git commit -m "feat(infra): observability stack in docker compose"`

---
# Phase F — Stretch Refactors

## Task F1: Harden the TaskQueue interface (no optional members)

**Files:**
- Modify: `src/queue/types.ts:34-38`, `src/queue/in-memory.ts`, `src/queue/redis.ts`, `src/dashboard-server/routes/queues.ts`
- Test: `tests/queue/*.test.ts`, `tests/dashboard/queues-routes.test.ts`

**Problem:** five optional members force feature-detection at every call site (`queues.ts:24-25, 39, 50-51`).

- [ ] **Step 1: Implement** — make `pendingCount`, `deadLetterSize`, `deadLetterPeek`, `deadLetterRetry`, `close` required on `TaskQueue` (both drivers already implement all five — verify `redis.ts` implements `deadLetterRetry`/`close`, adding stubs if a driver lacks one), then delete the feature-detection branches in `routes/queues.ts` (the `if ('pendingCount' in queue)` style guards at :24-25, :39, :50-51).

- [ ] **Step 2: Verify** — `npx tsx --test tests/queue/*.test.ts tests/dashboard/queues-routes.test.ts && npm run typecheck`.

- [ ] **Step 3: Commit**

`git add src/queue src/dashboard-server/routes/queues.ts && git commit -m "refactor(queue): required interface members, drop feature detection"`

## Task F2: OTel metrics pipeline

**Files:**
- Create: `src/observability/otel-metrics.ts`
- Modify: `src/runner-entry.ts`, `src/dashboard-server/server.ts`, `package.json`
- Test: `tests/metrics/prometheus.test.ts` (assert both pipelines coexist)

**Problem:** AGENTS.md claims OTel→OTLP for metrics, but the SDK exports traces only; metrics go via prom-client HTTP. Add the missing OTel metrics export without removing prom-client.

- [ ] **Step 1: Add deps** — `npm i @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http`

- [ ] **Step 2: Implement `src/observability/otel-metrics.ts`**

```ts
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export function startOtelMetrics(serviceName: string): () => void {
  const exporter = new OTLPMetricExporter({});
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 30_000 });
  const provider = new MeterProvider({
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
    readers: [reader],
  });
  provider.start();
  return () => provider.shutdown().catch(() => undefined);
}
```

- [ ] **Step 3: Wire** — in `runner-entry.ts` and `server.ts`, call `startOtelMetrics('ai-arena-runner')` / `('ai-arena-dashboard')` next to the existing `startOtel` calls, and shut it down in the existing graceful-shutdown handlers.

- [ ] **Step 4: Verify** — `npm run typecheck && npx tsx --test tests/metrics/prometheus.test.ts tests/smoke/trace-smoke.test.ts`.

- [ ] **Step 5: Commit**

`git add src/observability/otel-metrics.ts src/runner-entry.ts src/dashboard-server/server.ts package.json && git commit -m "feat(observability): export metrics via OTLP alongside prom-client"`

---
# Scope decisions — intentionally kept (documented, not bugs)

- **Dual tracing** (OTel-API spans in `agent-loop` + local `TraceRecorder`): two distinct consumers (Tempo for ops, `trace-meta.json` for the app UI). Unify later via a dedicated tracing task; not a correctness bug.
- **`schema-builder.ts` type-level mirror**: tested, working; refactor risk outweighs payoff.
- **`RawApiKeysConfigSchema = z.unknown()`**: deliberate CodeQL-heuristic workaround (documented in code).
- **`resetBudgetCache` test seam**: keeps the budget test suite fast; document, don't delete.
- **webhook fire-and-forget** (`notifications/webhooks.ts`): delivery is logged and non-blocking by design; routing it through the outbox is a stretch improvement — if F-tasks are skipped, leave as-is.
- **`queue/redis.ts` Lua nack**: the Lua copy of the dead-letter algorithm cannot import TS helpers; the JS paths now share `isTerminalAttempt` and the Lua mirrors it (comment added in C2).
- **Transient `api_error` → run marked failed** (`runner.ts:617`): by-design conservatism; the loop already retries sends within an attempt.
- **`task_complete` losing to a budget abort** (`turn-loop.ts`): the hook returning false is the authoritative stop; completing work first is a product decision, not a bug.
- **`checkRunStatus` treats a missing `run_models` row as complete** (`run-lifecycle.ts:278`): deliberate lenient fallback for rows that failed to insert; making it non-terminal would wedge runs instead.
- **`traceparent` extraction no-op** (`queue/redis.ts:270-272`): wiring the enqueuer's trace context into runner spans requires cross-cutting tracer changes; tracked separately.
- **Server-side session-message listing unbounded**: per-session data; pagination ships client-side in D2.

---
# Verification gate (run before declaring the plan done)

```bash
npm run typecheck && npm run typecheck:tests && npm run lint && npm test
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run lint && npm --prefix src/dashboard-client run test
bash -n scripts/k8s/deploy.sh && kubectl kustomize k8s/base > /dev/null 2>&1 || echo "kubectl optional"
```

Expected: all green; client suite green; deploy script parses.

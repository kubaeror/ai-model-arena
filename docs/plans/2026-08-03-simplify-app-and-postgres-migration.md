# Simplify App + Full Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete ~2,500 lines of dead/overengineered code, wire the "exists-but-broke" features (judge scoring, notifications, webhooks, Prometheus counters, scheduler DB-tick), and make Postgres a fully-supported production database by removing all SQLite-only raw-SQL and driver shims.

**Architecture:** Five phases. (0) lock green baseline, (1) dead-code sweep + port orphaned worker features into the live `runner.ts`, (2) wire feature stubs per user decisions, (3) consolidate duplicate/overengineered modules (Drizzle pagination, adapter base, fs walkers, loop detection, model/catalog routes, secret masking), (4) make Postgres parity-complete (schema-pg drift, raw SQL → Drizzle, drop SQLite-shim in `postgres.ts`, CI test against PG). Every phase ends green on `npm run typecheck && npm run lint && npm test`.

**Tech Stack:** Node ≥22, TypeScript ESM strict, Drizzle ORM (SQLite + PG dialects), Express 5, node:test + tsx, c8 coverage, cron-parser, prom-client, prometheus.

## Global Constraints

- Node engine floor >= 22 (`package.json` `engines`) — `fs.globSync` available. (update README/package comment when `glob-matcher.ts` removed)
- ESM only; all imports end `.js`.
- Pino structured logging, not `console.log` (bare entrypoints excluded).
- DB access via Drizzle only — no raw SQL string interpolation after Phase 4.2.
- Never hardcode API keys. All config via env.
- Sandbox path escape prevention must stay intact.
- Coverage gate remains `--lines 45 --functions 30 --branches 75 --statements 45` and must pass at each phase end.
- Keep `finalizeRun(spec, logger)` and `finalizeRunByRunId(runId, logger)` public signatures; only internals merge.
- User decisions (locked): wire silent_failure, wire judge end-to-end, wire onRunCompleted+onRegressionFailed notifications, wire all 3 webhook events, wire all Prometheus counters, delete rollback config, delete webhooks.yaml, scheduler = DB-tick with populated table, merge finalize fns, remove adapter streaming, keep dual OTel+TraceRecorder instrumentation.

---

# Phase 0 — Green baseline

### Task 0.1: Record baseline

**Files:** none

- [ ] **Step 1: Run the CI suite**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: typecheck exits 0, lint 0 errors (103 `no-explicit-any` warnings are tolerated — do not expand scope), tests all pass.

- [ ] **Step 2: Verify coverage gate is green**

```bash
npm run test:coverage
```

Expected: c8 exits 0 (current snapshot: lines ~48.5%, functions ~38.9%).

- [ ] **Step 3: Record baseline commit**

```bash
git commit -am "chore: record pre-refactor baseline" --allow-empty
```

---

# Phase 1 — Dead code sweep

### Task 1.1: Delete dead files (no behavior loss)

**Files:**
- Delete: `src/providers/model-router.ts`, `src/providers/health-probe.ts`
- Delete: `src/sandbox/signing.ts`
- Delete: `src/security/approvals.ts`
- Delete: `src/evaluation/tournament.ts`, `src/evaluation/metrics.ts`
- Delete: `src/cost-tracking/forecast.ts`, `src/cost-tracking/index.ts` (token helpers live elsewhere — verify before delete, see Step 2)
- Delete: `src/catalog/deprecation.ts`
- Delete: `src/observability/tracing.ts`
- Delete: `src/fs/locked-write.ts`, `tests/fs/locked-write.test.ts`
- Delete: `src/queue/admission.ts`
- Delete: `src/scheduler/index.ts`
- Delete: `src/lineage/writer.ts`, `tests/lineage/writer.test.ts`
- Delete: `src/dashboard-client/src/pages/Launcher.tsx`
- Delete: `docs/plans/secrets-management.md` only if referenced nowhere (KEEP — it is a live reference doc; skip this bullet)

**Interfaces:**
- Consumes: nothing.
- Produces: after this task `evaluation/index.ts` may be empty or dead — delete it too, then fix the import in `tests/`/`src` (Step 3).

- [ ] **Step 1: Confirm every file has zero importers first**

```bash
for f in src/providers/model-router src/providers/health-probe src/sandbox/signing src/security/approvals src/evaluation/tournament src/evaluation/metrics src/cost-tracking/forecast src/catalog/deprecation src/observability/tracing src/fs/locked-write src/queue/admission src/scheduler/index src/lineage/writer; do echo "== $f =="; grep -rn "$(basename $f)" src tests --include='*.ts' --include='*.tsx' | grep -v "^src/$f"; done
```

Expected: only self-references and re-export comments remain. `metrics.ts` (evaluation) may be re-exported by `src/evaluation/index.ts` — that barrel is itself dead (no `evaluation/index` importers); it dies in Step 3.

- [ ] **Step 2: Check `src/cost-tracking/index.ts` re-exports before deleting**

```bash
cat src/cost-tracking/index.ts
```

Only the three exports `tokenUsageFromPartial`, `sumTokenUsage`, `ensureTokenUsage` (no importers) may be removed. If `index.ts` also re-exports `computeCost`, `loadBudgetConfig`, `checkBudget`, `reserveBudget`, `releaseReservation`, `addSpend` (live — used by runner/run-lifecycle/worker), do NOT delete the barrel; only delete the three dead token helpers from it and delete `forecast.ts`.

- [ ] **Step 3: Delete the batch**

```bash
rm src/providers/model-router.ts src/providers/health-probe.ts \
   src/sandbox/signing.ts src/security/approvals.ts \
   src/evaluation/tournament.ts src/evaluation/metrics.ts \
   src/evaluation/index.ts \
   src/cost-tracking/forecast.ts \
   src/catalog/deprecation.ts \
   src/observability/tracing.ts \
   src/fs/locked-write.ts tests/fs/locked-write.test.ts \
   src/queue/admission.ts src/scheduler/index.ts \
   src/lineage/writer.ts tests/lineage/writer.test.ts \
   src/dashboard-client/src/pages/Launcher.tsx
```

- [ ] **Step 4: Fix any dangling imports surfaced by `npm run typecheck`** (names of files that imported freshly-deleted modules; e.g. `dashboard-server/routes/observability.ts` imports `dbPath` compat from `anomaly-detection/db.js` — that is fine, unaffected). Fix by removing the import + its call site, not by resurrecting files.

- [ ] **Step 4b: Delete rollback config (user decision)** — remove the `rollback:` block from `configs/evaluation.yaml`, and delete `RollbackConfigSchema` from `src/evaluation/types.ts:27-30` plus the `rollback` field from `EvaluationConfigSchema` (`types.ts:36`). Confirm nothing references it: `grep -rn "rollback\|failPrompt" src tests --include='*.ts'` → zero hits after edit.

- [ ] **Step 5: Remove dead exports from `sandbox/artifact-manifest.ts`** (`verifyManifest`, `validateManifest`, `loadManifest`, and the `quarantined` flag logic at `generateManifest` lines 37/44 — always set `quarantined: false`), and the dead `Sandbox.resolvePath` method in `src/sandbox/sandbox.ts:32-34`, and `getLog`/`commitTurn` dead methods later in Task 1.2 with git port.

- [ ] **Step 6: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 7: Commit** `git commit -am "chore: delete dead code (signing, approvals, tournament, forecast, deps, admission, lineage, Launcher)"`

### Task 1.2: Port orphaned worker features into runner, then delete worker.ts

**Rationale:** `src/worker.ts` (430L) is the legacy PM2 path with zero importers, but it holds 4 features the live `runner.ts` dropped: success-criteria validation, git diff artifact, `result.json`/`report.md` writers, and the early API-key check. Port them, then delete.

**Files:**
- Modify: `src/runner.ts`
- Modify: `src/sandbox/git.ts` (delete `getLog` if truly uncalled after port — verify)
- Delete: `src/worker.ts`

**Interfaces:**
- Consumes: `src/worker.ts` `runSuccessCriteria` (worker.ts:69-129), `SandboxGit.init/commitFinal/generateDiff` (`src/sandbox/git.ts`), `writeDiffPatch`, `writeResultJson`/`writeReport` (`src/logger/result-logger.js`, `src/logger/report-logger.js`), `computeCost` (`src/cost-tracking/index.js`).
- Produces: `runSuccessCriteria(scenario, sandboxDir, ctx)` and `finalizeArtifacts(...)` helpers exported or module-local in `runner.ts`; a task that runs the loop AND writes `result.json`, `report.md`, `diff.patch`, `judge_score.json` gap closed.

- [ ] **Step 1: Copy `runSuccessCriteria` into `runner.ts`**

Add the function verbatim (worker.ts:58-129) at module scope in `runner.ts`, importing `SHELL_METACHAR_RE` from `./sandbox/shell-policy.js` and `sandboxEnv` from `./sandbox/sandbox.js`, plus `execFile` from `node:child_process`.

- [ ] **Step 2: Add git + artifact writing to the run's completion block**

In `runner.ts`, after the agent loop (after `finalStatus` transition, before `queue.ack`), add:

```ts
// Ported from worker.ts: git diff + result/report artifacts + success criteria.
let success = result.stopReason === 'task_complete';
let successOutcome: Awaited<ReturnType<typeof runSuccessCriteria>> | undefined;
try {
  successOutcome = await runSuccessCriteria(scenario, sandboxDir, toolCtx);
  success = successOutcome ? successOutcome.passed : success;
} catch { /* non-fatal */ }

const costBreakdown = await computeCost(modelName, {
  prompt: result.tokenUsage.prompt ?? 0,
  completion: result.tokenUsage.completion ?? 0,
  cached: result.tokenUsage.cacheReadTokens ?? 0,
});

const sandboxGit = new SandboxGit({ sandboxDir, modelName, logger });
await sandboxGit.init();
await sandboxGit.commitFinal(success ? 'Task completed successfully' : 'Task failed or incomplete');
const diff = await sandboxGit.generateDiff();
if (diff) await writeDiffPatch(runOutputDir, diff, logger);

const runResult: RunResult = {
  model: modelName, scenario: scenarioName, runId: modelRunId,
  startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
  durationMs: 0, turnsUsed: result.turnsUsed, maxTurns: result.maxTurns,
  totalToolCalls: result.totalToolCalls, toolsCalled: result.toolsCalled,
  tokenUsage: result.tokenUsage, stopReason: result.stopReason,
  errors: result.errors, success, costUsd: costBreakdown.total,
  toolSuccessRates: result.toolSuccessRates,
  successCriteria: successOutcome ? {
    command: successOutcome.command, expectedExitCode: successOutcome.expectedExitCode,
    exitCode: successOutcome.exitCode, output: successOutcome.output,
    outputContainsPassed: successOutcome.outputContainsPassed, passed: successOutcome.passed,
  } : undefined,
};
writeResultJson(path.join(runOutputDir, 'result.json'), runResult);
conv.setEnded(runResult.finishedAt as string);
try {
  const convFile = JSON.parse(fs.readFileSync(path.join(runOutputDir, 'conversation.json'), 'utf8'));
  writeReport(path.join(runOutputDir, 'report.md'), runResult, convFile);
} catch { /* best-effort */ }
```

Add a `const startedAt = new Date();` before the loop and set `durationMs: new Date().getTime() - startedAt.getTime()` in `runResult`. Add imports: `SandboxGit`, `writeDiffPatch`, `writeResultJson + RunResult`, `writeReport`, `computeCost`, `writeManifest` already imported. The existing `transitionTaskState(..., finalStatus ...)` call now determines `finalStatus` from the ported `success` value instead of `result.errors.length`. Update `store.updateSessionStatus` accordingly.

- [ ] **Step 3: Wire run-level metrics (first metrics wiring — see Task 2.5 for the rest)**

Wrap with `activeTasks.inc()` after successful dequeue and `activeTasks.dec()` in the `finally` block; add `taskCounter.inc({ model: modelName, scenario: scenarioName, status: finalStatus })` and `taskDuration.observe(durationSeconds)` at completion. Import from `./observability/metrics.js`.

- [ ] **Step 4: Delete `src/worker.ts`** and verify nothing imports it (`tests/worker/adapter-wiring.test.ts` does NOT import it; it stays).

- [ ] **Step 5: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit** `git commit -am "refactor: port worker success-criteria/git/artifacts into runner; remove worker.ts"`

### Task 1.3: Remove dead exports in db/query.ts + dead orchestrator path

**Files:**
- Modify: `src/db/query.ts` (delete dead exports: `queryTable`, `getAnomalyById`, `listAnomaliesByRun`, `resolveAnomalyQuery`, `getWebhookById`, `deleteWebhookById`, `upsertModelRuntimeStat`, `insertToolCallStat`, `getPricingByModelId`, `listRuns`, `upsertRun`, `getRunById` — the live ones live in `db/runs.ts`. DO NOT delete `providersTable()` — it is used by `getModelByNameOrId` at `query.ts:454-455`)
- Delete: `src/runner/idempotency.ts` (its only import is `getRunById`, runtime-dead — only `tests/runner/*` reach it) + `tests/runner/idempotency.test.ts`
- Modify: `src/orchestrator/run-lifecycle.ts` (delete `spawnRunWorkers`, `getLatestPricingVersion` — replace call sites with `query.ts:getLatestPricingVersion` directly, delete `tailLogs` in `orchestrator.ts`, `saveRunIndex`/`indexPath` in `db/runs.ts`, `ensureBuilt` if reducer confirms sole caller now inline)
- Modify: `src/tools/schema.ts` (delete `MCP_TOOLS` + its comment)
- Delete: `src/db/schema.ts` `tool_call_stats` TABLE will be removed in Phase 4.2 (NOT now — keep until raw SQL dies)

**Interfaces:**
- Consumes: current `query.ts` exports.
- Produces: leaner `query.ts`. Any importer of the removed exports must switch to `db/runs.ts` or `anomaly-detection/db.ts` (the live twins).

- [ ] **Step 1: Confirm zero references for each targeted export**

```bash
for fn in queryTable getAnomalyById listAnomaliesByRun resolveAnomalyQuery getWebhookById deleteWebhookById upsertModelRuntimeStat insertToolCallStat getPricingByModelId providersTable; do echo "== $fn =="; grep -rn "$fn" src tests --include='*.ts'; done
```

Expected: only `query.ts` self references and the targeted dead code.

- [ ] **Step 2: Delete exports + their validate-* helpers**

Delete `queryTable`, `paginatedQuery` is NOT deleted here (Phase 3.2 replaces it with Drizzle). Delete `validateSqlIdentifier`/`validateOrderByClause`/`validateWhereClause` only if `queryTable`/`paginatedQuery` are their sole consumers — verify first: if `paginatedQuery` (kept until 3.2) uses `validateOrderByClause`, keep that validator until 3.2.

- [ ] **Step 3: Delete `spawnRunWorkers`, ensureBuilt plumbing, tailLogs, saveRunIndex, indexPath**

- [ ] **Step 4: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 5: Commit** `git commit -am "chore: remove dead db/query exports, PM2 spawn path, orchestrator stubs"`

### Task 1.4: Stale script pairs + fix npm db:migrate

**Files:**
- Delete: `scripts/scheduler-tick.ts`, `scripts/db-migrate.ts`
- Modify: `package.json` (`db:migrate` → `tsx src/scripts/db-migrate.ts`)

- [ ] **Step 1: Confirm `src/scripts/` copies are the compiled/k8s-used ones**

```bash
ls src/scripts/ scripts/
grep -rn "scripts/.*tick\|scripts/.*migrate" k8s/ --include='*.yaml'
```

Expected: `k8s/base/scheduler-cronjob.yaml` runs `dist/scripts/scheduler-tick.js`; initContainers run `dist/scripts/db-migrate.js`.

- [ ] **Step 2: Delete root stale copies, repoint npm script**

```bash
rm scripts/scheduler-tick.ts scripts/db-migrate.ts
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.scripts['db:migrate']='tsx src/scripts/db-migrate.ts';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
```

- [ ] **Step 3: Verify** `npm run typecheck && npm test` (db tests touch `db:migrate` indirectly via migrations test)

- [ ] **Step 4: Commit** `git commit -am "chore: drop stale root scripts, point db:migrate at src/scripts"`

### Task 1.5: Remove adapter streaming surface

**Files:**
- Modify: `src/providers/adapters/base.ts` (remove `StreamChunk`, `sendMessageStream`, `buildCacheBreakpoints` from the interface)
- Modify: `src/providers/adapters/openai-compat.ts` (remove `sendMessageStream` L55-98 + SSE parsing + `buildCacheBreakpoints` L37-40 + `reasoning_effort` sugar L117-119)
- Modify: `src/providers/adapters/anthropic.ts` (remove `sendMessageStream`, `buildCacheBreakpoints` L31-34; keep cache_control logic in `sendMessage`)
- Modify: `src/providers/adapters/google.ts` (remove `sendMessageStream`, add `AbortSignal.timeout(60_000)` to the 2 active `fetch` calls L36/L49)
- Modify: `src/providers/adapters/bedrock.ts` (remove `sendViaGateway`? NO — keep gateway for gateway-mode Bedrock until Phase 3.4; remove `supportsStreaming()` returning true → false, since no impl exists)
- Modify: `src/observability/instrument-loop.ts` (breakpoints wiring only if it refuses to compile; the loop never calls `sendMessageStream` so the wrap is dead — remove block)

**Interfaces:**
- Consumes: ProviderAdapter interface today.
- Produces: `ProviderAdapter` = `{ sendMessage, supportsStreaming? -> false }`. Streaming removed from types in `src/providers/adapters/base.ts`.

- [ ] **Step 1: Grep streaming usage to confirm nothing calls it**

```bash
grep -rn "sendMessageStream\|buildCacheBreakpoints\|StreamChunk" src tests --include='*.ts'
```

Expected: definitions + tests only (if tests exist for streaming, delete those test cases too).

- [ ] **Step 2: Remove per your Files list; set `supportsStreaming()` → `false` in base default and all adapters.**

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "refactor: remove unused adapter streaming surface; google adapter gets request timeout"`

---

# Phase 2 — Wire the exists-but-broke features

### Task 2.1: Fix silent_failure detector (read correct judge key)

**Files:**
- Modify: `src/anomaly-detection/detectors.ts` (`readJudgeScore` L27-37 → delegate to `readJudgeResult`; delete local JSON parse)

**Interfaces:**
- Consumes: `readJudgeResult` from `src/evaluation/judge.js`.
- Produces: `readJudgeScore(outputDir): number | null` reads `JudgeResult.averageScore`.

- [ ] **Step 1: Replace `readJudgeScore`**

```ts
import { readJudgeResult } from '../evaluation/judge.js';

/** Read the judge score (0-100) for a run, if judge_score.json exists. */
export function readJudgeScore(outputDir: string): number | null {
  const r = readJudgeResult(outputDir);
  return r ? r.averageScore : null;
}
```

- [ ] **Step 2: Write test** — extend or add `tests/anomaly-detection/silent-failure.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJudgeScore } from '../../src/anomaly-detection/detectors.js';

test('readJudgeScore reads averageScore from judge_score.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-judge-'));
  fs.writeFileSync(path.join(dir, 'judge_score.json'), JSON.stringify({ averageScore: 88.5, scores: [], summary: '', judgedAt: '', judgeModel: 'x', model: 'm', runId: 'r' }));
  assert.equal(readJudgeScore(dir), 88.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJudgeScore returns null when file missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-judge-miss-'));
  assert.equal(readJudgeScore(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Add `tests/anomaly-detection` to `.c8-test-list.txt`** (append `tests/anomaly-detection/*.test.ts`) so coverage counts it.

- [ ] **Step 4: Verify** `npm run test` (run the new file) then `npm run typecheck && npm run lint`

- [ ] **Step 5: Commit** `git commit -am "fix: silent_failure detector reads judge averageScore"`

### Task 2.2: Wire judge scoring end-to-end (merged into Task 2.7 by design — this task is the judge-side only)

**Files:**
- Modify: `src/evaluation/judge.ts` — remove module-level `evalConfig` cache (L10, L13) so config edits apply; add clamp `averageScore = Math.min(100, Math.max(0, averageScore))`.
- Verify-only: `loaderEvaluationConfig` defaults.

- [ ] **Step 1: De-cache judge config**

```ts
export function loadEvaluationConfig(configPath: string, logger?: Logger): EvaluationConfig {
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = EvaluationConfigSchema.parse({});
    logger?.warn(`Evaluation config not found at ${resolvedPath}, using defaults`);
    return fallback;
  }
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = load(content);
  return EvaluationConfigSchema.parse(parsed);
}
```

- [ ] **Step 2: Clamp average** after `averageScore` computation in `runJudgeScoring`:

```ts
const averageScore = Math.min(100, Math.max(0,
  scores.reduce((sum: number, s: JudgeScore) => sum + s.score, 0) / Math.max(scores.length, 1)));
```

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "fix: judge config no stale cache; clamp averageScore"`

### Task 2.3: Notifications — payload fix, anomaly case, run-completed + regression dispatch

**Files:**
- Modify: `src/notifications/slack.ts` (budget formatter keys; add `onAnomalyDetected` case; keep run-completed formatter)
- Modify: `src/notifications/discord.ts` (same as slack)
- Modify: `src/orchestrator/run-lifecycle.ts` (dispatch `onRunCompleted` in merged finalize — done in Task 2.7; here only if 2.7 not yet merged)
- Modify: `src/evaluation/regression.ts` (dispatch `onRegressionFailed`)
- Add test: `tests/notifications/format.test.ts`

**Interfaces:**
- Consumes: `dispatchNotification` (run-lifecycle-style dynamic import), `DispatchEventType` from `src/notifications/index.js`.
- Produces: canonical budget payload keys `{ model, spentUsd, limitUsd, percentUsed }` read by formatters; `onAnomalyDetected` formatted case.

- [ ] **Step 1: Fix budget formatter in slack.ts + discord.ts**

In each `onBudgetThreshold` case, replace `data.spent ?? 0` → `data.spentUsd ?? data.spent ?? 0` and `data.limit ?? 0` → `data.limitUsd ?? data.limit ?? 0`; replace `data.threshold === '100%'` with `Number(data.percentUsed ?? 0) >= 100`.

- [ ] **Step 2: Add `onAnomalyDetected` case to both formatters**

```ts
case 'onAnomalyDetected': {
  return {
    text: '⚠️ Anomaly Detected',
    attachments: [{
      color: 'warning',
      fields: [
        { title: 'Type', value: String(data.type ?? 'n/a'), short: true },
        { title: 'Severity', value: String(data.severity ?? 'n/a'), short: true },
        { title: 'Model', value: String(data.model ?? 'n/a'), short: true },
        { title: 'Run', value: String(data.runId ?? 'n/a'), short: false },
        { title: 'Description', value: String(data.description ?? 'n/a'), short: false },
      ],
    }],
  };
}
```

- [ ] **Step 3: Dispatch `onRegressionFailed` in regression.ts**

In `runRegressionSuite` (`src/evaluation/regression.ts`), after a regression is detected where `failOnRegression` and a suite/config exists, fire-and-forget:

```ts
import type { Logger } from '../types.js';
// inside failure branch:
void (async () => {
  try {
    const { dispatchNotification, DispatchEventType } = await import('../notifications/index.js');
    const { loadNotificationConfig } = await import('../notifications/index.js');
    loadNotificationConfig(configFilePath, logger);
    await dispatchNotification({ type: DispatchEventType.onRegressionFailed, data: { suite, model, regressions }, timestamp: new Date().toISOString() }, logger);
  } catch { /* non-blocking */ }
})();
```

Wire the exact variable names to the existing loop (`suite` from the loop, `model` per model, `regressions` = failed entries array).

- [ ] **Step 4: Write `tests/notifications/format.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPayloadForTest } from '../../src/notifications/slack.js';
```

If `formatPayload` is not exported, export it from `slack.ts` (rename existing inner function to `export function formatSlackPayload(evt)` and reuse it inside `sendSlackNotification`). Test budget keys map (`spentUsd` → Spent) and anomaly case exists.

- [ ] **Step 5: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit** `git commit -am "fix: budget notification payload, anomaly formatter, regression-failed dispatch"`

### Task 2.4: Webhooks — wire run_completed + budget_exceeded

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts` (merged finalize — see Task 2.7 — fires `run_completed`; `startRun` fires `budget_exceeded`)
- Add test: `tests/notifications/webhooks-dispatch.test.ts`

**Interfaces:**
- Consumes: `dispatchWebhooks(event, payload, logger)` from `src/notifications/webhooks.js`.
- Produces: webhook events for all 3 advertised types.

- [ ] **Step 1: Fire `budget_exceeded` in `startRun`**

In `startRun`, where a model is blocked (`budgetCheck.allowed === false` throws `Budget exceeded`) — replace the hard throw path with: dispatch webhook first (non-blocking), then throw:

```ts
if (!budgetCheck.allowed) {
  const reason = budgetCheck.reason ?? `Budget exceeded for ${modelName}`;
  void (async () => {
    try {
      const { dispatchWebhooks } = await import('../notifications/webhooks.js');
      await dispatchWebhooks('budget_exceeded', { model: modelName, spentUsd: budgetCheck.spentUsd, limitUsd: budgetCheck.limitUsd, percentUsed: budgetCheck.percentUsed, reason }, logger);
    } catch { /* non-blocking */ }
  })();
  throw new Error(reason);
}
```

- [ ] **Step 2: Fire `run_completed` in the merged finalize (Task 2.7)** — no action here; referenced for ordering. If 2.7 lands first, this task reduces to budget_exceeded only.

- [ ] **Step 3: Write `tests/notifications/webhooks-dispatch.test.ts`**

Mock `webhooksForEvent`/`getWebhookSecret` from `anomaly-detection/db.js` (monkeypatch via dependency pattern), assert `fetch` called with `x-arena-signature` header when a secret is returned and no fetch when `webhooksForEvent` returns `[]`.

- [ ] **Step 4: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 5: Commit** `git commit -am "feat: wire budget_exceeded webhook dispatch"`

### Task 2.5: Wire Prometheus counters

**Files:**
- Modify: `src/runner.ts` (taskCounter, taskDuration, activeTasks — largely in Task 1.2)
- Modify: `src/queue/redis.ts` + `src/queue/in-memory.ts` (queueDepth)
- Modify: `src/scheduler/tick.ts` (scheduleFailures)
- Modify: `src/dashboard-server/routes/queues.ts` (optional: surface queueDepth for ops)

**Interfaces:**
- Consumes: `taskCounter`, `taskDuration`, `activeTasks`, `queueDepth`, `scheduleFailures` from `src/observability/metrics.js`.
- Produces: all 6 `arena_*` metrics actually mutated.

- [ ] **Step 1: runner.ts** — from Task 1.2 Step 3 (already wired there). Verify presence of all four mutations; add missing `activeTasks.dec()` in `finally` if absent.

- [ ] **Step 2: queue/redis.ts** — after each `enqueue`, `ack`, `nack`, and `deadLetterRetry`, read current stream length and set gauge:

```ts
import { queueDepth } from '../observability/metrics.js';
// inside a private helper after state-changing ops:
export async function setQueueDepthGauge(runIdKey: string): Promise<void> {
  try { queueDepth.set({ provider: runIdKey }, await this.streamClient.xlen(this.queueKey)); } catch { /* best-effort */ }
}
```

Adapt to the existing method names/fields (fields `streamClient`, `queueKey`, `consumerGroup` per `redis.ts`). Keep failure non-fatal.

- [ ] **Step 3: queue/in-memory.ts** — inside `enqueue`/`dequeue`/`ack`/`nack`, `queueDepth.set({ provider: 'in-memory' }, this.tasks.length)`.

- [ ] **Step 4: scheduler/tick.ts** — in the `scheduleFailed` branch:

```ts
import { scheduleFailures } from '../observability/metrics.js';
scheduleFailures.inc({ schedule_id: scheduleId });
```

- [ ] **Step 5: Add a smoke test** `tests/metrics/prometheus.test.ts` already exists — extend it: import the counters, `.inc()`, then assert `metricsHandler` output contains `arena_tasks_total` and `arena_queue_depth`.

- [ ] **Step 6: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 7: Commit** `git commit -am "feat: wire Prometheus task/queue/depth/schedule counters"`

### Task 2.6: Scheduler — populate DB table, DB-tick becomes functional

**Files:**
- Modify: `src/db/query.ts` (add `insertSchedule`, `deleteSchedule`, `listSchedules`)
- Modify: `src/scheduler/manager.ts` (add `syncSchedulesToDb`; call from `addSchedule`/`removeSchedule`)
- Modify: `src/dashboard-server/server.ts` (boot-time `syncSchedulesToDb`)
- Modify: `src/scheduler/tick.ts` (wire `scheduleFailures` — Task 2.5; no logic change otherwise)
- Delete: `configs/webhooks.yaml` (user decision — remove file + add to `.gitignore`? No: delete; also comment references in README if any)

**Interfaces:**
- Consumes: `schedules` table (schema.ts L349 + schema-pg.ts L312), Drizzle `db` from `getDrizzleDb()`.
- Produces: `insertSchedule(s: DbScheduleInput): Promise<void>`, `deleteSchedule(id: string): Promise<void>`, `listSchedules(): Promise<DbSchedule[]>`; `syncSchedulesToDb(configPath, logger?): Promise<void>` idempotent.

- [ ] **Step 1: Add DB functions to query.ts after `updateScheduleRun` (L428):**

```ts
export interface ScheduleInput {
  id: string; scenario: string; models: string[]; cron: string; enabled: boolean; createdAt?: string;
}
export async function insertSchedule(s: ScheduleInput): Promise<void> {
  const db = getDrizzleDb();
  const existing = await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, s.id)).limit(1);
  if (existing.length > 0) return;
  await db.insert(schedules).values({
    id: s.id, scenario: s.scenario, models: JSON.stringify(s.models),
    cron: s.cron, enabled: s.enabled ? 1 : 0, created_at: s.createdAt ?? new Date().toISOString(),
  });
}
export async function deleteSchedule(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(schedules).where(eq(schedules.id, id));
}
export async function listSchedules(): Promise<DbSchedule[]> {
  const db = getDrizzleDb();
  return db.select().from(schedules) as any;
}
```

- [ ] **Step 2: Add `syncSchedulesToDb` to manager.ts**

```ts
export async function syncSchedulesToDb(configPath: string, logger?: Logger): Promise<void> {
  try {
    const config = loadSchedulesConfig(configPath, logger);
    const { insertSchedule } = await import('../db/query.js');
    for (const s of config.schedules) {
      await insertSchedule({ id: s.id, scenario: s.scenario, models: s.models, cron: s.cron, enabled: s.enabled ?? true });
    }
  } catch (err) {
    logger?.warn('syncSchedulesToDb failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  }
}
```

- [ ] **Step 3: Call it.** `addSchedule` (after writing YAML) — add `await syncSchedulesToDb(configPath, logger).catch(() => undefined);` (make `addSchedule` async; update `cli.ts` `schedule create` and `routes/schedules.ts` POST to `await addSchedule(...)`). Same in `removeSchedule` (call `deleteSchedule` for the removed id; make async; update cli/routes).

- [ ] **Step 4: Boot-time sync in server.ts** — inside the dashboard boot sequence (near other async initializers, e.g. after `server.ts:76-84` catalog sync), add:

```ts
const { syncSchedulesToDb } = await import('./scheduler/manager.js');
await syncSchedulesToDb(path.join(rootDir, 'configs', 'schedules.yaml'));
```

- [ ] **Step 5: Delete `configs/webhooks.yaml`** and any loader reference (grep `webhooks.yaml` — there is none in code; README mentions webhooks.yaml? README line 256 lists `api-keys.yaml` only — no webhooks.yaml reference; just delete).

- [ ] **Step 6: Test** — add `tests/db/schedules.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { initDb, closeDb } from '../../src/db/index.js';
import { insertSchedule, listSchedules, deleteSchedule, listDueSchedules } from '../../src/db/query.js';

test.afterEach(async () => { await closeDb(); });

test('schedules: insert/idempotent/list/delete + due', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sched-'));
  initDb(path.join(dir, 'arena.db'));
  await insertSchedule({ id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true });
  await insertSchedule({ id: 's1', scenario: 'x', models: ['gpt-4o'], cron: '0 3 * * *', enabled: true });
  assert.equal((await listSchedules()).length, 1);
  assert.equal((await listDueSchedules(new Date().toISOString())).length, 1);
  await deleteSchedule('s1');
  assert.equal((await listSchedules()).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

Add to `.c8-test-list.txt`.

- [ ] **Step 7: Verify** `npm run test:db && npm run typecheck && npm run lint`

- [ ] **Step 8: Commit** `git commit -am "feat: populate schedules DB for functional DB-tick; delete webhooks.yaml"`

### Task 2.7: Merge finalize functions (CLI alignment + judger wiring + notifications + webhooks in one core)

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts` (replace `finalizeRun` + `finalizeRunByRunId` with a single `finalizeCore`; keep both public wrappers)
- Modify: caller of `writeRelative` if any (none expected)

**Interfaces:**
- Consumes: existing helpers `aggregate`, `patchIndexAfterFinalize`, `addSpend`, `insertCostLedgerEntry`, `analyzeRun`, `writeRunStats`, `runJudgeScoring`, `writeJudgeResult`.
- Produces:
```ts
async function finalizeCore(runId: string, entries: ComparisonEntry[], logger: Logger): Promise<{ mdPath: string; jsonPath: string }>
export async function finalizeRun(spec: RunSpec, logger: Logger): Promise<{ entries: ComparisonEntry[]; mdPath: string; jsonPath: string }>
export async function finalizeRunByRunId(runId: string, logger: Logger): Promise<void>
```
Behavior: merged version must now fire `onRunCompleted` notification + `run_completed` webhook; call `writeJudgeResult` after `runJudgeScoring` returns non-null.

- [ ] **Step 1: Extract per-model entry builder**

Replace the duplicated `perModel` mapping (L381-391 vs L442-472) with one helper:

```ts
async function buildPerModelEntries(runId: string, rec: Awaited<ReturnType<typeof getRunRecord>>, entries: ComparisonEntry[]): Promise<RunIndexModelEntry[]> {
  const perModel: RunIndexModelEntry[] = await Promise.all(rec!.perModel.map(async (m) => {
    const r = entries.find((x) => x.model === m.model)?.result;
    const base = { model: m.model, runId, procName: m.procName, outputDir: m.outputDir, sandboxDir: m.sandboxDir, resultPath: m.resultPath, conversationPath: m.conversationPath, reportPath: m.reportPath, logFile: m.logFile };
    if (!r) return { ...base, status: 'errored' };
    if (typeof r.costUsd === 'number' && r.costUsd > 0) {
      void addSpend(m.model, r.costUsd, pm2h.projectRoot(), logger);
      try {
        const { insertCostLedgerEntry } = await import('../db/query.js');
        const tokens = (r as Record<string, unknown>).tokenUsage as Record<string, number> | undefined ?? {};
        await insertCostLedgerEntry({ runId, model: m.model, costUsd: r.costUsd, inputTokens: tokens.prompt ?? null, outputTokens: tokens.completion ?? null, cacheReadTokens: tokens.cacheReadTokens ?? null, totalTokens: tokens.total ?? null, pricingVersion: null, recordedAt: new Date().toISOString() });
      } catch (e) { logger.warn('cost ledger write failed (non-fatal)', { runId, model: m.model, err: String(e) }); }
    }
    return { ...base, status: 'completed', success: r.success, turnsUsed: r.turnsUsed, totalToolCalls: r.totalToolCalls, stopReason: r.stopReason, durationMs: r.durationMs };
  }));
  return perModel;
}
```

- [ ] **Step 2: Implement `finalizeCore`**

```ts
async function finalizeCore(runId: string, entries: ComparisonEntry[], logger: Logger): Promise<{ mdPath: string; jsonPath: string }> {
  const rec = await getRunRecord(runId);
  if (!rec) throw new Error(`Run not found: ${runId}`);
  const root = pm2h.projectRoot();
  const { mdPath, jsonPath } = aggregate(root, { runId, scenario: rec.scenario, startedAt: rec.startedAt, models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })) });
  const perModel = await buildPerModelEntries(runId, rec, entries);
  await patchIndexAfterFinalize(runId, mdPath, jsonPath, perModel);
  const allSuccess = perModel.every((m) => m.status === 'completed' && m.success !== false);
  logger.info('Run finalized', { runId, md: mdPath, status: allSuccess ? 'success' : 'failed' });

  // Release budget reservations with actual costs (from FAT.min ledger costs)
  for (const entry of entries) {
    const actualCost = entry.result?.costUsd ?? 0;
    const estimatedCost = actualCost > 0 ? actualCost * 2 : 1;
    releaseReservation(entry.model, estimatedCost, actualCost, root, logger);
  }

  void analyzeRun(runId, logger).catch((e) => { anomalyAnalysisFailures++; logger.warn('Anomaly analysis failed', { runId, error: String(e) }); });
  void writeRunStats(runId, root).catch((e) => { statsWritebackFailures++; logger.warn('writeRunStats failed (non-fatal)', { runId, err: String(e) }); });

  // LLM judge scoring + persist judge_score.json (feeds silent_failure detector + regression baselines)
  void (async () => {
    try {
      const evalCfg = loadEvaluationConfig(path.join(root, 'configs', 'evaluation.yaml'), logger);
      if (evalCfg.judge?.enabled) {
        for (const m of rec.perModel) {
          if (!fs.existsSync(m.resultPath)) continue;
          const scenarioPath = path.join(root, 'configs', 'scenarios', `${rec.scenario}.yaml`);
          const scenarioCfg = fs.existsSync(scenarioPath) ? (load(fs.readFileSync(scenarioPath, 'utf8')) as Record<string, unknown>) : null;
          const task = (scenarioCfg?.task as string) ?? '';
          const files: Record<string, string> = {};
          try {
            for (const f of fs.readdirSync(m.sandboxDir, { withFileTypes: true }).filter((e) => e.isFile())) files[f.name] = fs.readFileSync(path.join(m.sandboxDir, f.name), 'utf8').slice(0, 4000);
          } catch { /* sandbox may not exist */ }
          const verdict = await runJudgeScoring(m.model, runId, task, files, evalCfg, logger);
          if (verdict) writeJudgeResult(m.outputDir, verdict, logger);
        }
      }
    } catch (e) { logger.warn('judge scoring failed (non-fatal)', { runId, err: String(e) }); }
  })();

  // Notifications + webhooks: single dispatch point for run completion
  void (async () => {
    try {
      const { loadNotificationConfig, dispatchNotification, dispatchWebhooks, DispatchEventType } = await import('../notifications/index.js');
      loadNotificationConfig(path.join(root, 'configs', 'notifications.yaml'), logger);
      const data = { runId, scenario: rec.scenario, models: rec.perModel.map((m) => m.model), status: allSuccess ? 'success' : 'failed' };
      await dispatchNotification({ type: DispatchEventType.onRunCompleted, data, timestamp: new Date().toISOString() }, logger);
      await dispatchWebhooks('run_completed', data, logger);
    } catch { /* non-blocking */ }
  })();

  return { mdPath, jsonPath };
}
```

- [ ] **Step 3: Rewire the two public wrappers**

```ts
export async function finalizeRun(spec: RunSpec, logger: Logger): Promise<{ entries: ComparisonEntry[]; mdPath: string; jsonPath: string }> {
  const { entries, mdPath, jsonPath } = aggregate(spec.root!, { runId: spec.runId, scenario: spec.scenario, startedAt: spec.startedAt, models: spec.models.map((m) => ({ model: m.model, resultPath: m.resultPath })) });
  const core = await finalizeCore(spec.runId, entries, logger);
  return { entries, mdPath: core.mdPath, jsonPath: core.jsonPath };
}

export async function finalizeRunByRunId(runId: string, logger: Logger): Promise<void> {
  const rec = await getRunRecord(runId);
  if (!rec) return;
  const root = pm2h.projectRoot();
  const { entries } = aggregate(root, { runId, scenario: rec.scenario, startedAt: rec.startedAt, models: rec.perModel.map((m) => ({ model: m.model, resultPath: m.resultPath })) });
  await finalizeCore(runId, entries, logger);
}
```

Note: `aggregate` is called twice inside `finalizeRun` — acceptable (idempotent read + writeComparison overwrite). Remove now-unused `anomalyAnalysisFailures`/`statsWritebackFailures` counters if moved into `finalizeCore` (keep them module-scoped).

- [ ] **Step 4: Test** — extend `tests/orchestrator/budget-integration.test.ts` or add per-model compare behavior; assert `judge_score.json` is NOT required for existing tests (judge disabled in CI by default config). Verify CLI path still returns `{ entries, mdPath, jsonPath }`.

- [ ] **Step 5: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit** `git commit -am "refactor: merge finalize paths; persist judge_score.json; dispatch run_completed"`

---

# Phase 3 — Consolidation & simplification

### Task 3.1: Shared fs walk util

**Files:**
- Create: `src/fs/walk.ts` (export `walkFiles(root, opts)`).
- Modify: `src/tools/executors.ts` (`walkFiles` L50-68 → import), `src/sandbox/artifact-manifest.ts` (`walkAndHash` → use util), `src/dashboard-server/routes/runs.ts` (`walkSandbox` → use util), `src/dashboard-server/routes/scenarios.ts` (`listStarterFiles` → use util).

**Interfaces:**
- Produces: `walkFiles(root: string, opts?: { dirs?: boolean; exclude?: string[]; followSymlinks?: boolean }): Promise<string[]>` returning absolute paths excluding `node_modules`, `.git`.
- Consumes: existing walkers’ semantics (depth-first, exclude node_modules/.git).

- [ ] **Step 1: Write `src/fs/walk.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDE = new Set(['node_modules', '.git']);

export interface WalkOptions {
  dirs?: boolean;
  exclude?: string[];
}

export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const exclude = new Set([...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])]);
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (exclude.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { visit(p); if (opts.dirs) out.push(p); }
      else out.push(p);
    }
  };
  visit(root);
  return out;
}
```

- [ ] **Step 2: Replace the 4 walkers with `walkFiles(...)`** and delete their local implementations. Preserve each call site’s own filtering (e.g. runs.ts ignore-dirs pass as `exclude`).

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "refactor: single fs walk util replaces 4 duplicated walkers"`

### Task 3.2: Drizzle-based pagination (kills raw SQL + validators + PG shim dependency)

**Files:**
- Modify: `src/db/query.ts` (replace `paginatedQuery` L747-776 + `queryTable` (already deleted) + validators `validateOrderByClause`/`validateWhereClause` if still used, `transitionTaskState` L230-234, `assignUserRole`/`insertRole` `INSERT OR IGNORE`, `listSessionsWithCounts` L999-1019)
- Modify: `src/dashboard-server/routes/{audit,cost,files,catalog}.ts` (use new helper)
- Modify: `src/db/postgres.ts` (drop regex translation once raw SQL is gone — Phase 4.3)
- Add test: `tests/db/pagination.test.ts`

**Interfaces:**
- Produces: `paginate<T>(table, q: { page; pageSize; orderBy?: string; where?: Record<string, unknown> }): Promise<{ rows: T[]; total: number }>` using Drizzle `.orderBy()` with a whitelist of columns per table and `.where()` via `and(eq(...))`.
- Transition: `transitionTaskState` → `db.update(run_models).set(updates).where(and(eq(run_models.run_id,...), eq(run_models.model,...)))`.
- `assignUserRole`/`insertRole` → `db.insert(...).values(...).onConflictDoNothing()` (Drizzle supports both dialects).

- [ ] **Step 1: Rewrite `transitionTaskState` with Drizzle update (remove UPDATE string + the postgres.ts `INSERT OR IGNORE` regex need).**

```ts
import { run_models } from './schema.js';
// in transitionTaskState:
const db = getDrizzleDb();
await db.update(run_models).set(updates).where(and(eq(run_models.run_id, runId), eq(run_models.model, model)));
```

Verify `run_models` column names match `updates` keys (`status`, `claimed_at`, `started_at`, `completed_at`, `runner_id`) in both dialects — the PG schema currently lacks 4 of them; fix in Task 4.1 before this flips on PG. For this task, generate against SQLite (default).

- [ ] **Step 2: Replace `INSERT OR IGNORE` in `assignUserRole` (L889) and `insertRole` (L911).**

```ts
await db.insert(user_roles).values({ user_email, role }).onConflictDoNothing();
```

- [ ] **Step 3: Add `paginate` helper (whitelist-based Drizzle orderBy).**

```ts
export async function paginate<T extends Record<string, unknown>>(
  table: any, columns: Record<string, unknown>,
  q: { page: number; pageSize: number; orderBy?: string; dir?: 'asc' | 'desc' },
  tableName?: any,
): Promise<{ rows: T[]; total: number }> {
  const db = getDrizzleDb();
  const total = (await db.select({ count: sql`count(*)`.mapWith(Number) }).from(table))[0]?.count ?? 0;
  const key = q.orderBy && q.orderBy in columns ? q.orderBy : 'id';
  const dir = q.dir === 'desc' ? desc : asc;
  const rows = await db.select().from(table).orderBy(dir(columns[key])).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return { rows, total };
}
```

Route callers adapt (audit/cost/files/catalog currently use `paginatedQuery` — swap to `paginate(table, columnsForTable, {...})` with explicit per-table column maps).

- [ ] **Step 4: Update `listSessionsWithCounts`** to use `paginate` for its COUNT+select.

- [ ] **Step 5: Test** `tests/db/pagination.test.ts` — SQLite init, insert rows, assert order/total/offsets; add `tests/db` exists in `.c8-test-list.txt`.

- [ ] **Step 6: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 7: Commit** `git commit -am "refactor: Drizzle pagination + update/insert ops, remove raw SQL strings"`

### Task 3.3: Replace glob-matcher with fs.globSync

**Files:**
- Delete: `src/tools/glob-matcher.ts`
- Modify: `src/tools/executors.ts` (glob tool → `fs.globSync` respecting `node_modules`/`.git` exclusion)

**Interfaces:**
- Produces: glob tool uses `fs.globSync(pattern, { cwd: sandboxDir, exclude: EXCLUDE_GLOB })` (Node ≥22).

- [ ] **Step 1: Rewrite the glob executor**

```ts
const EXCLUDE_GLOBS = ['**/node_modules/**', '**/.git/**'];
// within glob executor:
const matches = fs.globSync(pattern, { cwd: sandboxDir, exclude: EXCLUDE_GLOBS } as any).map((p) => path.resolve(sandboxDir, p));
```

Adapt to current signatures (the executor builds regex and passes through `walkFiles`). Ensure `{a,b}` braced patterns that old matcher supported still pass: polyfill only brace-expansion by expanding `{a,b}` into a shared alternation set before calling `fs.globSync`, or accept behavior change — keep a brace-expansion helper in executors if needed (20 lines) so tool users aren’t surprised.

- [ ] **Step 2: Migrate glob tests** from `tests/tools/executors.test.ts` globToRegex describe block to against the new implementation; delete now-failing `globToRegex` unit asserts.

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "refactor: stdlib fs.globSync replaces homegrown glob-matcher"`

### Task 3.4: Adapter shared HTTP base (dedupe fetch/retry/SSE repetition)

**Files:**
- Create: `src/providers/adapters/http-base.ts` (`post()`, retry, `HttpError`, SSE lines iterator)
- Modify: `src/providers/adapters/{openai-compat,anthropic,google}.ts` and `bedrock.ts` (`sendViaGateway` reuses openai-compat path)

**Interfaces:**
- Produces:
```ts
export class HttpChatBase {
  constructor(opts: { apiKey?: string; baseUrl: string; headers?: Record<string, string>; logger?: Logger; timeoutMs?: number });
  async post<T>(path: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  static sseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string>;
}
export class HttpError extends Error { constructor(public status: number, public body: string) { super(`HTTP ${status}: ${body.slice(0, 200)}`); } }
```
- Consumes: existing per-wire serialization (`buildBody`/`parseResponse`) stays in each adapter.

- [ ] **Step 1: Write http-base.ts.**

```ts
import type { Logger } from '../../types.js';

export class HttpError extends Error {
  constructor(public status: number, public body: string) { super(`HTTP ${status}: ${body.slice(0, 200)}`); }
}

export class HttpChatBase {
  private headers: Record<string, string>;
  private logger?: Logger;
  private timeoutMs: number;
  constructor(opts: { apiKey?: string; baseUrl: string; headers?: Record<string, string>; logger?: Logger; timeoutMs?: number }) {
    this.headers = { 'content-type': 'application/json', ...(opts.apiKey ? this.authHeader(opts.apiKey) : {}), ...(opts.headers ?? {}) };
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    void opts.baseUrl;
  }
  private authHeader(_apiKey: string): Record<string, string> { throw new Error('override authHeader()'); }
  async post<T>(url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { ...this.headers, ...extraHeaders }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return (await res.json()) as T;
  }
  static async *sseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
}
```

Each adapter subclass provides `authHeader(key)` (Authorization Bearer / `x-api-key` / `x-goog-api-key`). Do NOT use a router/middleware — keep super minimal (YAGNI). Wire adapters’ `sendMessage` to `this.post(url, body)`, keeping their response parsing local.

- [ ] **Step 2: Refactor 4 adapters** to extend `HttpChatBase`, deleting duplicated fetch/HttpError/SSE blocks. Preserve Anthropic wire translation and cache_control placement in `buildBody`; Google gets its missing timeout automatically via the base.

- [ ] **Step 3: Verify adapter tests pass** `npm test` (providers tests exist: openai-compat, anthropic, google, bedrock).

- [ ] **Step 4: Commit** `git commit -am "refactor: shared HTTP base for provider adapters"`

### Task 3.5: Consolidate loop detection into conversation-parser

**Files:**
- Modify: `src/logger/conversation-parser.ts` (add canonical `detectLoops(toolCalls, min)` + `computeObjectiveMetrics`)
- Modify: `src/anomaly-detection/detectors.ts` (loopDetector uses canonical)
- Modify: `src/dashboard-server/routes/analytics.ts` (delete local `detectLoopsInConversation`, import canonical)

**Interfaces:**
- Produces: `detectLoops(toolCalls: ToolCallEntry[], minConsecutive: number): { tool: string; consecutive: number } | null`.
- Consumes: existing `detectLoopsInConversation` behavior from analytics.ts (keep its richer turn/tool shape — see migration).

- [ ] **Step 1: Implement canonical, port analytics semantics.**

```ts
export function detectLoops(toolCalls: ToolCallEntry[], minConsecutive: number): { tool: string; consecutive: number; turns: number[] } | null {
  for (let i = 0; i <= toolCalls.length - minConsecutive; i++) {
    const key = `${toolCalls[i]!.name}:${JSON.stringify(toolCalls[i]!.arguments)}`;
    let n = 1; const turns = [toolCalls[i]!.turn];
    for (let j = i + 1; j < toolCalls.length; j++) {
      if (`${toolCalls[j]!.name}:${JSON.stringify(toolCalls[j]!.arguments)}` === key) { n++; turns.push(toolCalls[j]!.turn); }
      else break;
    }
    if (n >= minConsecutive) return { tool: toolCalls[i]!.name, consecutive: n, turns };
  }
  return null;
}
```

- [ ] **Step 2: Wire** `detectors.loopDetector` to call it; `analytics.ts` map canonical to its `LoopDetection`/render shape.

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "refactor: single loop-detection implementation"`

### Task 3.6: Consolidate model/catalog/providers routes + fix frontend wiring

**Files:**
- Modify: `src/dashboard-server/routes/models.ts` (support `provider`/`sort`/`q`/`reasoning`/`tool_call` filters; return `{ data: [...] }` to match `useCatalog.ts`; drop/delegate custom-provider POST/DELETE to providers route)
- Modify: `src/dashboard-server/server.ts` (mount `catalog.pricing` also at `/api/pricing` OR point client at `/api/catalog/pricing`; pick client fix)
- Modify: `src/dashboard-client/src/hooks/useCatalog.ts` (expect the fixed response shape; use `/api/catalog/pricing`)
- Modify: `src/dashboard-server/routes/catalog.ts` (remove per-handler `await import('../../db/query.js')` — hoist one static import; keep benchmark routes)

**Interfaces:**
- Produces: `GET /api/models` returns `{ data: CatalogModel[] }` with applied filters; pricing loaded from `/api/catalog/pricing`.

- [ ] **Step 1: Confirm current shapes** `cat src/dashboard-server/routes/models.ts` (should return `{ models }` ignoring filters) and `grep -n "data\|models" src/dashboard-client/src/hooks/useCatalog.ts` (expects `{ data }`).

- [ ] **Step 2: Rewrite `models.ts` GET** to filter by `provider`, `reasoning`, `tool_call`, `min_context`, `q` (substring on name), `sort` (name|context), return `{ data: rows }`.

- [ ] **Step 3: Client** — `useCatalog.ts`: `res.data` stays; `apiFetchJson<{ data: CatalogModel[] }>(`/api/models?...`)` valid after Step 2; pricing hook switch `/api/pricing` → `/api/catalog/pricing`.

- [ ] **Step 4: De-duplicate custom-provider CRUD** — point models.ts POST/DELETE to `routes/providers.ts` handlers (or delete models POST/DELETE and rely on providers) so one code path manages custom providers.

- [ ] **Step 5: Catalog route static imports** — remove `await import('../../db/query.js')` occurrences (4).

- [ ] **Step 6: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 7: Commit** `git commit -am "fix: catalog/models client wiring; dedupe custom-provider routes"`

### Task 3.7: Fix maskSecrets over-masking

**Files:**
- Modify: `src/dashboard-server/secrets.ts` (word-boundary `token`)

**Interfaces:**
- Produces: only keys literally named `apiKey`/`api_key`/`secret`/`password`/`token`/`auth(.)`/`credential` masked; `tokenUsage`/`tokenCount`/`tokens` untouched.

- [ ] **Step 1: Tighten regex**

```ts
const SENSITIVE_KEYS = /^(api_?key|secret|password|token|authorization|credential)$/i;
```

- [ ] **Step 2: Add regression test** `tests/dashboard/mask-secrets.test.ts` asserting `maskSecrets({ tokenUsage: 123 })` → `{ tokenUsage: 123 }` and `maskSecrets({ api_key: 'x' })` → `{ api_key: '***' }`. Add file to `.c8-test-list.txt`.

- [ ] **Step 3: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 4: Commit** `git commit -am "fix: maskSecrets no longer mangles tokenUsage fields"`

### Task 3.8: Security pass — async requireOwnership + close IDOR gaps

**Files:**
- Modify: `src/auth/rbac.ts` (requireOwnership → async + generic resolver)
- Modify: `src/dashboard-server/routes/runs.ts` (reuse helper for `GET /:runId` + models/* + logs/diff, replacing `checkRunOwnership`/`allowIfRunOwner` where trivially possible — keep default-deny)
- Modify: `src/dashboard-server/routes/traces.ts`, `routes/export.ts` (`/runs/:runId/csv`), `routes/sessions.ts` (GETs) — add ownership gate
- Modify: `src/dashboard-server/routes/scenarios.ts` + `routes/models.ts` — owner-scoped past editors (per audit report F-023 recommendation)

**Interfaces:**
- Produces:
```ts
export async function requireOwnership(
  req: ReqWithAuth,
  getOwnerId: (req: ReqWithAuth) => Promise<string | null | undefined>,
): Promise<boolean>
```
Semantics: if resource has no owner → deny (default-deny, current audit-remediation default); if requester is admin or owner → allow.

- [ ] **Step 1: Make `requireOwnership` async with resolver function** (update `tests/auth/require-ownership.test.ts` accordingly).

- [ ] **Step 2: runs.ts** — swap local sync ownership path to the async helper for the resource-keyed GET/`models/*`/`logs`/`diff` handlers; keep the existing explicit allow-list behavior identical (test via existing dashboard auth tests + add IDOR tests if missing).

- [ ] **Step 3: traces.ts + export.ts + sessions.ts** — gate `/runs/:runId` (traces), `/runs/:runId/csv` (export), session GETs with the helper where a `createdBy`/owner field exists on the row; add `tests/dashboard/ownership-routes.test.ts` asserting cross-user 403.

- [ ] **Step 4: scenarios/models mutations** — role `editor` required (unchanged) + ownership gate when a record carries `createdBy`; when `createdBy` is null default-denies per project rule — except seeded built-in scenarios/models which are admin-managed; document this exception inline.

- [ ] **Step 5: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit** `git commit -am "security: async requireOwnership wired into runs/traces/export/sessions/scenarios/models"`

### Task 3.9: Dedupe roles handlers + WebSocket auth + relative cleanup

**Files:**
- Modify: `src/dashboard-server/server.ts` (remove inline `/api/roles` at L244, keep `users.ts` `/roles`; keep killswitch inline or move to route — optional)
- Modify: `src/dashboard-server/live.ts` + `stream.ts` (shared `verifyWsRequest` util)
- Create: `src/dashboard-server/ws-auth.ts`
- Modify: `src/dashboard-server/routes/cost.ts` + `routes/analytics.ts` (make analytics `/cost` read `cost_ledger`; delete `routes/cost.ts`)

**Interfaces:**
- Produces: `verifyWsRequest(req): { ok: boolean; user?: ...; error?: string }` used by both WS servers; single `/cost` implementation.

- [ ] **Step 1: Extract WS auth** — move `verifyWsRequest`/`LiveHub.verifyUser` protocol parsing into `ws-auth.ts`, parameterized by `{ useQueryToken?: boolean }`; delete the second copies (live.ts:65-79, stream.ts:59-88).

- [ ] **Step 2: Collapse `/cost`** — port `analytics.ts /cost` query to read `cost_ledger` (columns from `getCostSummary`), delete `routes/cost.ts`, repoint any consumer (grep `routes/cost` mount in server.ts).

- [ ] **Step 3: Roles** — drop inline `/api/roles`; ensure `users.ts GET /roles` mounted at `/api/roles` in server.ts.

- [ ] **Step 4: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 5: Commit** `git commit -am "refactor: shared WS auth, single roles+cost endpoints"`

---

# Phase 4 — Full Postgres migration

### Task 4.1: Fix schema-pg drift (parity with schema.ts)

**Files:**
- Modify: `src/db/schema-pg.ts`

**Interfaces:**
- Produces: maximal column parity between `schema.ts` and `schema-pg.ts` for: `run_models` (`claimed_at`, `started_at`, `completed_at`, `runner_id` missing today), `provider_versions` (missing in PG), `tool_call_stats` (missing in PG). Keep dialect-appropriate types (`integer` bools, `timestamp` vs `text`).

- [ ] **Step 1: Diff the two schemas**

```bash
grep -n "run_models\|provider_versions\|tool_call_stats\|claimed_at\|Q: started_at\|next_run" src/db/schema-pg.ts
```

- [ ] **Step 2: Add missing columns/tables to `schema-pg.ts`** mirroring `schema.ts` definitions (run_models: `claimed_at text`, `started_at text`, `completed_at text`, `runner_id text`; `provider_versions` table; `tool_call_stats` table). Add the `DbProvider`/`DbModel`/`DbPricing` row interfaces if PG consumers import them (they import from `schema.js` today — add `DbX` InferSelectModel exports to schema-pg for parity only if imported).

- [ ] **Step 3: Generate + apply migration for both dialects**

```bash
npm run db:generate
npm run db:migrate   # sqlite local
DB_DRIVER=postgres DATABASE_URL=postgres://arena:arena@localhost:5432/arena npm run db:migrate
```

Expected: both apply clean. If drizzle-kit refuses multi-dialect in one project, document and apply PG DDL from generated output manually.

- [ ] **Step 4: Add model test** extending `tests/db/migrations.test.ts` to assert PG run_models has the 4 columns (skip if no PG in CI — then move to Task 4.4 CI step).

- [ ] **Step 5: Verify** `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit** `git commit -am "fix: schema-pg parity for run_models/provider_versions/tool_call_stats"`

### Task 4.2: Remove remaining SQLite-only raw SQL

**Files:**
- Modify: `src/db/query.ts` (the last raw SQL sites: `assignUserRole`, `insertRole` — already Drizzle in 3.2; verify `getCostSummary` L949, `queryCacheLeaderboard` L1046, `transitionTaskState` — done in 3.2; audit remaining `sql.raw`/string concat)
- Modify: `src/sandbox/...` none; `src/db/client.ts` (`applyRuntimeIndices` raw DDL → Drizzle migration; `tool_call_stats` hand DDL removed)
- Add test: `tests/db/postgres-parity.test.ts`

**Interfaces:**
- Produces: zero string-built SQL in `src/db/`; `tool_call_stats` declared exactly once (Drizzle schema).

- [ ] **Step 1: Sweep `sql.raw`/concatenated SQL**

```bash
grep -rn "sql.raw\|INSERT OR IGNORE\|\`SELECT\|\`UPDATE\|\`INSERT" src/db --include='*.ts'
```

- [ ] **Step 2: Convert each hit to Drizzle** (dynamic `set()`/`where()`, `onConflictDoNothing`, `orderBy({ column: 'asc' })`). For `getCostSummary`/`queryCacheLeaderboard`, use Drizzle `groupBy` + `sum`/`count` aggregates wherever the dialect lets you express it; where PG/SQLite differ in aggregate syntax, prefer Drizzle-generated SQL and verify both.

- [ ] **Step 3: `client.ts applyRuntimeIndices`** — move the 8 DDL statements + `tool_call_stats` CREATE TABLE into a real Drizzle migration under `drizzle/`; delete the `applyRuntimeIndices` block and the comment "created here until a proper migration is added."

- [ ] **Step 4: Verify** `npm run typecheck && npm run lint && npm test && npm run test:db`

- [ ] **Step 5: Commit** `git commit -am "refactor: final raw SQL → Drizzle; migrate runtime indices"`

### Task 4.3: Drop the SQLite→Postgres shim in postgres.ts

**Files:**
- Modify: `src/db/postgres.ts` (remove `doRawQuery` regex translation L23-61; `all()`/`run()` now execute parameterized native PG via pg + drizzle only)
- Modify: `src/db/index.ts` (remove the throwing Proxy for SQLite-isms; all consumers Postgres-ready)

**Interfaces:**
- Produces: `postgres.ts` exports `postgresDb` (Drizzle), `runRaw`/`allRaw` (parameterized `?`→ indexed args ONLY for any remaining legitimate dynamic SQL, no string rewriting), no regex manipulation of SQL.

- [ ] **Step 1: Rewrite `doRawQuery`** — replace regex translation with parameterized `client.query(sqlText, args.map((a, i) => ({ ... })))` where `?` placeholders bind positionally (identity transform). Delete the `INSERT OR IGNORE → ON CONFLICT` special-case (no longer produced after 4.2).

- [ ] **Step 2: index.ts** — delete the Proxy/throw path; ensure `DB_DRIVER=postgres` supported path covers every exported query-store function used by routes/tests.

- [ ] **Step 3: Verify** — extend `tests/db/postgres-parity.test.ts` to run against a live PG (docker service from 4.4) exercising: transitions, anomaly insert, ledger insert, pagination, schedules. If no PG container available locally yet, mark test skip via env guard and enable in 4.4.

- [ ] **Step 4: Commit** `git commit -am "refactor: postgres.ts no SQLite shim; parameterized queries only"`

### Task 4.4: CI/dev Postgres coverage

**Files:**
- Modify: `.github/workflows/build-deploy.yaml` (add postgres service for `test:db-pg`)
- Modify: `package.json` (add `test:db-pg`: `DB_DRIVER=postgres DATABASE_URL=postgres://... npm run test:db`)
- Modify: `docker-compose.yml` (already has postgres; ensure `arena` user/db defaults match)
- Modify: `docs/runbooks.md` + `README.md` (Postgres is production-first; note SQLite dev-only)

**Interfaces:**
- Produces: repo CI proves Postgres parity end-to-end.

- [ ] **Step 1: Add service block** in build-deploy.yaml:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: arena
      POSTGRES_PASSWORD: arena
      POSTGRES_DB: arena
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U arena"
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

then a step: `npm run test:db-pg` after environments set `DATABASE_URL=postgres://arena:arena@localhost:5432/arena`.

- [ ] **Step 2: Add `test:db-pg` script** to package.json running migrations against PG then `tests/db/**`, `tests/catalog/**`, `tests/session/**`, `tests/runner/checkpoint*`, `tests/worker/**`.

- [ ] **Step 3: Run locally once**

```bash
docker compose up -d postgres
npm run db:migrate -- --driver postgres   # or DB_DRIVER=postgres npm run db:migrate
npm run test:db-pg
```

Fix any dialect-specific breakages surfaced (column type mismatches, bool 0/1 handling, text vs JSON columns).

- [ ] **Step 4: Update docs** — README "Development" section: `npm run test:db-pg`; runbooks: PG subjects (DDL cycles, index guidance). Add Postgres as first-class in `docs/audit-report-2026-07-22.md`? No — that’s historical; add note in runbooks.

- [ ] **Step 5: Commit** `git commit -am "ci: Postgres-backed test:db + migration parity"`

---

# Phase 5 — Verification, coverage, docs

### Task 5.1: Full regression + coverage lift

**Files:**
- Modify: `.c8-test-list.txt` (housekeeping — ensure every kept test file with real assertions is in the list; the coverage gate misread (48.5%) came partly from excluded files)
- Modify: `README.md` (feature claims now true: judge wire end-to-end, scheduler functional, Postgres parity, ws rate-limit note if added)

- [ ] **Step 1: Update `.c8-test-list.txt`** — append every existing test file except true smoke/DB-live ones you intentionally exclude; rerun `npm run test:coverage` and record new numbers (target ≥55% lines).

- [ ] **Step 2: Full sweep** `npm run typecheck && npm run lint && npm test && npm run test:coverage && npm run test:db`

- [ ] **Step 3: Grep for leftover dead-code signals** `grep -rn "sendMessageStream\|MCP_TOOLS\|spawnRunWorkers\|queryTable\|lockFile\|createFallbackRouter\|probeProviderHealth\|signArtifacts" src --include='*.ts'` → expect zero results.

- [ ] **Step 4: Commit** `git commit -am "docs+ci: coverage list cleanup, README truth, final sweep"`

---

## Execution Handoff

Plan saved. Two execution options per writing-plans skill — choose in next message.

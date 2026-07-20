# Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 27 issues identified in the 2026-07-20 architectural audit of `ai-model-arena`.

**Architecture:** Issues are grouped into 10 independent tasks by subsystem. Tasks 1 and 2 (circular dependency and cost bug) must land first as they affect every subsequent build. Tasks 3-10 are independent and can be executed in any order after that.

**Tech Stack:** Node.js >= 20.11, TypeScript 5.6 (ESM strict), Express 4, ws 8, better-sqlite3 12, Zod 3, tsx (test runner via `npm test`).

## Global Constraints

- ESM imports only — all imports use `.js` extensions even for `.ts` source files.
- `npm run typecheck` must pass after every task.
- `npm test` must pass after every task.
- No hardcoded API keys, passwords, or secrets.
- All new exported functions must be typed; no `any` or `@ts-ignore`.
- Workers always `process.exit(0)` — real failures in `result.json`.
- Pino structured logging — no `console.log` in production code paths.

---

## Task 1: Extract `resolveModelForRun` — fix circular dependency

**Issues fixed:** #1 (CRITICAL)

**Files:**
- Create: `src/db/model-resolver.ts`
- Modify: `src/worker.ts` — remove `export function resolveModelForRun` and its `ResolvedModel` interface
- Modify: `src/orchestrator/run-lifecycle.ts:11` — update import
- Modify: `src/evaluation/judge.ts:7` — update import

**Interfaces:**
- Produces: `resolveModelForRun(friendlyName: string): ResolvedModel | null` and `export interface ResolvedModel` from `src/db/model-resolver.ts`

- [ ] **Step 1: Create `src/db/model-resolver.ts`**

```typescript
import type { ProviderRow } from './schema.js';
import { getDb } from './client.js';
import type { ModelRow } from './schema.js';

export interface ResolvedModel {
  canonicalId: string;
  providerId: string;
  apiModelId: string;
  adapterKind: ProviderRow['adapter'];
  envVar: string | null;
  contextLimit: number | null;
  maxTurns: number;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_TEMPERATURE = 0.2;

export function resolveModelForRun(friendlyName: string): ResolvedModel | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.*, mp.api_model_id, p.env_var, p.adapter as provider_adapter
    FROM models m
    JOIN model_providers mp ON mp.model_id = m.id
    JOIN providers p ON p.id = m.provider_id
    WHERE m.name = ? OR m.id = ?
    LIMIT 1
  `).get(friendlyName, friendlyName) as (ModelRow & { api_model_id: string; env_var: string | null; provider_adapter: string }) | undefined;
  if (!row) return null;
  return {
    canonicalId: row.id,
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    adapterKind: row.provider_adapter as ProviderRow['adapter'],
    envVar: row.env_var,
    contextLimit: row.context_limit,
    maxTurns: DEFAULT_MAX_TURNS,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: row.output_limit ?? 4096,
  };
}
```

- [ ] **Step 2: Update `src/worker.ts`** — remove the local `ResolvedModel` interface (lines ~54-65) and `export function resolveModelForRun` (lines ~67-89). Add import:

```typescript
import { resolveModelForRun, DEFAULT_MAX_TURNS, DEFAULT_TEMPERATURE, type ResolvedModel } from './db/model-resolver.js';
```

Replace all local references to the type/function with the imported ones.

- [ ] **Step 3: Update `src/orchestrator/run-lifecycle.ts`** — change line 11:

```typescript
// before
import { resolveModelForRun } from '../worker.js';
// after
import { resolveModelForRun } from '../db/model-resolver.js';
```

- [ ] **Step 4: Update `src/evaluation/judge.ts`** — change line 7:

```typescript
// before
import { resolveModelForRun } from '../worker.js';
// after
import { resolveModelForRun } from '../db/model-resolver.js';
```

- [ ] **Step 5: Run typecheck**

```
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```
git add src/db/model-resolver.ts src/worker.ts src/orchestrator/run-lifecycle.ts src/evaluation/judge.ts
git commit -m "refactor: extract resolveModelForRun to src/db/model-resolver.ts -- fix circular dep"
```

---

## Task 2: Fix cost calculation — `total` -> `cacheReadTokens`

**Issues fixed:** #2 (CRITICAL), #27 (LOW)

**Files:**
- Modify: `src/worker.ts` — fix the cached token argument in `computeCost` call
- Modify: `src/cost-tracking/pricing.ts:50-52` — add `?? 0` guards on prompt/completion

- [ ] **Step 1: Add `?? 0` guards in `src/cost-tracking/pricing.ts`**

Replace lines 50-52:
```typescript
// before
const inputCost = (usage.prompt / 1000) * pricing.input;
const outputCost = (usage.completion / 1000) * pricing.output;
const cachedCost = ((usage.cached ?? 0) / 1000) * (pricing.cached ?? 0);

// after
const inputCost = ((usage.prompt ?? 0) / 1000) * pricing.input;
const outputCost = ((usage.completion ?? 0) / 1000) * pricing.output;
const cachedCost = ((usage.cached ?? 0) / 1000) * (pricing.cached ?? 0);
```

- [ ] **Step 2: Fix the `computeCost` call in `src/worker.ts`** (around line 335-339):

```typescript
// before
const costBreakdown = computeCost(modelName, {
  prompt: loopResult.tokenUsage.prompt ?? 0,
  completion: loopResult.tokenUsage.completion ?? 0,
  cached: loopResult.tokenUsage.total ?? 0,   // BUG: total is the full token count
});

// after
const costBreakdown = computeCost(modelName, {
  prompt: loopResult.tokenUsage.prompt ?? 0,
  completion: loopResult.tokenUsage.completion ?? 0,
  cached: loopResult.tokenUsage.cacheReadTokens ?? 0,
});
```

- [ ] **Step 3: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 4: Commit**

```
git add src/worker.ts src/cost-tracking/pricing.ts
git commit -m "fix: pass cacheReadTokens (not total) to computeCost -- correct cost calculation"
```

---

## Task 3: Wire the `regress` CLI command

**Issues fixed:** #5 (HIGH)

**Files:**
- Create: `src/evaluation/regression-config.ts`
- Modify: `src/cli.ts` — implement the regress action

- [ ] **Step 1: Create `src/evaluation/regression-config.ts`**

```typescript
import { z } from 'zod';

export const RegressionSuiteConfigSchema = z.object({
  models: z.array(z.string()).min(1),
  scenarios: z.array(z.string()).min(1),
  baselineDir: z.string().default('outputs/baselines'),
  thresholds: z.object({
    scoreDrop: z.number().default(1.0),
    tokenIncrease: z.number().default(0.5),
    timeIncrease: z.number().default(0.5),
  }).default({}),
});
export type RegressionSuiteConfig = z.infer<typeof RegressionSuiteConfigSchema>;
```

- [ ] **Step 2: Implement the `regress` action in `src/cli.ts`**

First check the top of `cli.ts` to confirm that `fs`, `path`, `yaml`, `createLogger`, `initDb`, `listRuns` are already imported or add them.

Replace lines 134-137 (the stub action):
```typescript
.action(async (opts: { suite: string; model?: string; updateBaseline: boolean }) => {
  const { suite, model: filterModel, updateBaseline } = opts;
  const root = rootDir();
  const configPath = path.join(root, 'configs', 'regression', `${suite}.yaml`);
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`\nError: Regression suite config not found: ${configPath}\n`);
    process.exit(1);
  }
  const { RegressionSuiteConfigSchema } = await import('./evaluation/regression-config.js');
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const config = RegressionSuiteConfigSchema.parse(raw);
  const models = filterModel ? config.models.filter((m) => m === filterModel) : config.models;
  if (models.length === 0) {
    process.stderr.write(`\nError: No matching models (filter: ${filterModel ?? 'none'})\n`);
    process.exit(1);
  }

  const baselineDir = path.resolve(root, config.baselineDir);
  const logger = createLogger('ai-arena:regress');
  initDb(path.join(root, 'outputs', 'arena.db'));

  const { runRegressionSuite, createBaselineSnapshot, saveBaselineSnapshot, getBaselinePath } =
    await import('./evaluation/regression.js');
  const { readJudgeResult } = await import('./evaluation/judge.js');
  void readJudgeResult; // used in getCurrentRunResult below

  const result = await runRegressionSuite(
    suite,
    models,
    config.scenarios,
    baselineDir,
    config.thresholds,
    async (mdl, scenario) => {
      const runs = listRuns().filter(
        (r) => r.scenario === scenario && r.models.includes(mdl) && r.status === 'completed',
      );
      if (runs.length === 0) return null;
      const rec = runs[0]!;
      const perModel = rec.perModel.find((m) => m.model === mdl);
      if (!perModel) return null;
      try {
        return JSON.parse(fs.readFileSync(perModel.resultPath, 'utf8'));
      } catch {
        return null;
      }
    },
    logger,
  );

  if (updateBaseline) {
    for (const sr of result.scenarioResults) {
      if (sr.success && sr.current) {
        const snap = createBaselineSnapshot(sr.current, sr.judge ?? null);
        const bPath = getBaselinePath(baselineDir, sr.current.model, sr.scenario);
        saveBaselineSnapshot(bPath, snap, logger);
      }
    }
    console.log('\nBaselines updated.');
  }

  const passed = result.passed;
  const failedCount = result.scenarioResults.filter(
    (sr) => sr.regression && !sr.regression.passed,
  ).length;
  console.log(`\nRegression suite: ${suite}`);
  console.log(`Status: ${passed ? 'PASSED' : `FAILED -- ${failedCount} regression(s)`}`);
  for (const sr of result.scenarioResults) {
    const icon = sr.regression?.passed === false ? 'FAIL' : 'PASS';
    console.log(`  [${icon}] ${sr.scenario}`);
    for (const reg of sr.regression?.regressions ?? []) {
      console.log(`    ${reg.metric}: ${reg.baseline} -> ${reg.current} (delta ${reg.change.toFixed(2)}, threshold ${reg.threshold})`);
    }
  }
  process.exit(passed ? 0 : 1);
});
```

You will also need `listRuns` imported. Check what is already imported from `'./orchestrator/orchestrator.js'` and add `listRuns` if missing.

- [ ] **Step 3: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 4: Commit**

```
git add src/cli.ts src/evaluation/regression-config.ts
git commit -m "feat: wire regress CLI command to runRegressionSuite"
```

---

## Task 4: Async I/O in dashboard routes + fix `readDiffPatch`

**Issues fixed:** #4 (HIGH), #7 (HIGH), #16 (MEDIUM)

**Files:**
- Modify: `src/dashboard-server/routes/analytics.ts`
- Modify: `src/dashboard-server/routes/runs.ts`
- Modify: `src/dashboard-server/routes/export.ts`
- Modify: `src/sandbox/git.ts`

- [ ] **Step 1: Make `readDiffPatch` genuinely async in `src/sandbox/git.ts`**

Replace the function body (lines 169-173):
```typescript
export async function readDiffPatch(outputDir: string): Promise<string | null> {
  const patchPath = path.join(outputDir, 'diff.patch');
  try {
    return await fs.promises.readFile(patchPath, 'utf8');
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Add 30s analytics cache + async reads in `src/dashboard-server/routes/analytics.ts`**

Add at module top (after imports):
```typescript
import { promises as fsp } from 'node:fs';

interface AnalyticsToolsCache { key: string; data: ToolAnalyticsResponse; ts: number; }
let analyticsToolsCache: AnalyticsToolsCache | null = null;
const ANALYTICS_TTL_MS = 30_000;
```

Replace the two sync helper functions with async versions:
```typescript
async function readResultFile(resultPath: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fsp.readFile(resultPath, 'utf8')); } catch { return null; }
}
async function readConversationFile(convPath: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fsp.readFile(convPath, 'utf8')); } catch { return null; }
}
```

Change the `/tools` route to `async`, add cache check at the start, `await` both reads inside the loop, and store the result in the cache before returning.

Change the `/cost` route to `async` and `await readResultFile(...)`.

- [ ] **Step 3: Make all file reads async in `src/dashboard-server/routes/runs.ts`**

Add at top: `import { promises as fsp } from 'node:fs';`

Replace `readTail`:
```typescript
async function readTail(filePath: string, lines = 400): Promise<string> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}
```

Make the conversation endpoint async:
```typescript
router.get('/:runId/models/:model/conversation', async (req, res) => {
  const entry = findEntry(req.params.runId, req.params.model);
  if (!entry) { res.status(404).json({ error: 'Run or model not found' }); return; }
  try {
    const raw = await fsp.readFile(entry.conversationPath, 'utf8');
    res.json({ model: req.params.model, conversation: JSON.parse(raw) });
  } catch {
    res.json({ model: req.params.model, conversation: { entries: [] } });
  }
});
```

Make the sandbox file read endpoint async:
```typescript
router.get('/:runId/models/:model/files/*', async (req, res) => {
  const entry = findEntry(req.params.runId, req.params.model);
  if (!entry) { res.status(404).json({ error: 'Run or model not found' }); return; }
  const prefix = `/api/runs/${req.params.runId}/models/${req.params.model}/files/`;
  const relRaw = req.path.startsWith(prefix) ? req.path.slice(prefix.length) : '';
  let abs: string;
  try { abs = safeResolve(entry.sandboxDir, decodeURIComponent(relRaw)); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); return; }
  try {
    const content = await fsp.readFile(abs, 'utf8');
    res.type('text/plain').send(content);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});
```

Make the logs and report endpoints async (they call `readTail`):
```typescript
router.get('/:runId/models/:model/logs', async (req, res) => { ... res.type('text/plain').send(await readTail(entry.logFile, 400)); });
router.get('/:runId/models/:model/report', async (req, res) => { ... res.type('text/markdown').send(await readTail(entry.reportPath, 100000) || '(report not available yet)'); });
```

- [ ] **Step 4: Make reads async in `src/dashboard-server/routes/export.ts`**

Add `import { promises as fsp } from 'node:fs';` and replace the two `JSON.parse(fs.readFileSync(...))` helper functions with async versions. Make all route handlers that call them `async`.

- [ ] **Step 5: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 6: Commit**

```
git add src/dashboard-server/routes/analytics.ts src/dashboard-server/routes/runs.ts src/dashboard-server/routes/export.ts src/sandbox/git.ts
git commit -m "perf: async file reads in dashboard routes + 30s analytics cache + readDiffPatch async"
```

---

## Task 5: Fix `LiveHub` polling overlap — back-pressure

**Issues fixed:** #9 (MEDIUM)

**Files:**
- Modify: `src/dashboard-server/live.ts`

- [ ] **Step 1: Add `pollTimer` field and `schedulePoll` method**

In the class body, add the field:
```typescript
private pollTimer: NodeJS.Timeout | null = null;
```

Add the method:
```typescript
private schedulePoll(): void {
  this.pollTimer = setTimeout(() => {
    Promise.all([
      this.pollConversationsAsync().catch((e) =>
        this.logger.warn('pollConversations error', { error: String(e) }),
      ),
      this.pollLogsAsync().catch((e) =>
        this.logger.warn('pollLogs error', { error: String(e) }),
      ),
    ]).finally(() => {
      if (this.pollTimer !== null) this.schedulePoll();
    });
  }, 1000);
}
```

- [ ] **Step 2: Replace the `setInterval` for conversations/logs in `start()`**

Remove lines:
```typescript
this.timers.push(setInterval(() => {
  void this.pollConversationsAsync()
    .catch((e) => this.logger.warn('pollConversations error', { error: String(e) }));
  void this.pollLogsAsync()
    .catch((e) => this.logger.warn('pollLogs error', { error: String(e) }));
}, 1000));
```

Replace with:
```typescript
this.schedulePoll();
```

- [ ] **Step 3: Clean up `pollTimer` in `close()`**

Add before `this.wss.close()`:
```typescript
if (this.pollTimer !== null) {
  clearTimeout(this.pollTimer);
  this.pollTimer = null;
}
```

- [ ] **Step 4: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 5: Commit**

```
git add src/dashboard-server/live.ts
git commit -m "fix: replace setInterval poll with back-pressure setTimeout in LiveHub"
```

---

## Task 6: Security hardening

**Issues fixed:** #8 (HIGH), #12 (MEDIUM), #13 (MEDIUM), #15 (MEDIUM), #21 (LOW), #26 (LOW)

**Files:**
- Modify: `.env.example`
- Modify: `src/dashboard-server/auth.ts`
- Modify: `src/dashboard-server/auth-api.ts`
- Modify: `src/sandbox/git.ts`
- Modify: `src/sandbox/sandbox.ts`

- [ ] **Step 1: Update `.env.example`** — add these lines before the `ARENA_API_KEY` section:

```
# Dashboard web UI authentication
# Generate JWT secret with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=
DASHBOARD_JWT_SECRET=
DASHBOARD_JWT_EXPIRES_IN=12h
```

- [ ] **Step 2: Fix `timingSafeEqual` in `src/dashboard-server/auth.ts`**

Replace lines 37-45:
```typescript
function timingSafeEqual(a: string, b: string): boolean {
  // Hash both inputs to a fixed-length digest so comparison time is
  // independent of input length and content.
  const key = Buffer.alloc(32, 0);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
```

- [ ] **Step 3: Add timing-safe key lookup + fix interval leak in `src/dashboard-server/auth-api.ts`**

Add `import crypto from 'node:crypto';` at top if not present.

Add a module-level `timingSafeEqualStr` helper:
```typescript
function timingSafeEqualStr(a: string, b: string): boolean {
  const key = Buffer.alloc(32, 0);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
```

Add `let apiKeyMap: Map<string, RequestContext> | null = null;` alongside the other module-level vars.

Add `let rateLimitPrunerHandle: NodeJS.Timeout | null = null;` alongside `rateLimitPrunerStarted`.

In `loadApiKeysConfig`, after `apiKeysConfig = validated;`, populate the map:
```typescript
apiKeyMap = new Map(
  validated.apiKeys.map((k) => [k.key, {
    keyName: k.name,
    permissions: k.permissions,
    rateLimit: k.rateLimit,
  }]),
);
```

Update the `setInterval` storage:
```typescript
if (!rateLimitPrunerStarted) {
  rateLimitPrunerStarted = true;
  rateLimitPrunerHandle = setInterval(() => {
    const currentBucket = Math.floor(Date.now() / 60_000);
    for (const key of rateLimitStore.keys()) {
      const parts = key.split(':');
      const bucket = Number(parts[parts.length - 1]);
      if (bucket < currentBucket - 2) rateLimitStore.delete(key);
    }
  }, 120_000);
  rateLimitPrunerHandle.unref();
}
```

Replace `findApiKey`:
```typescript
function findApiKey(key: string): RequestContext | null {
  if (!apiKeyMap) return null;
  let found: RequestContext | null = null;
  // Always iterate all entries for timing-safety (no early-exit on match).
  for (const [storedKey, ctx] of apiKeyMap) {
    if (timingSafeEqualStr(key, storedKey)) found = ctx;
  }
  return found;
}
```

Update `resetApiKeysCache`:
```typescript
export function resetApiKeysCache(): void {
  apiKeysConfig = null;
  apiKeyMap = null;
  rateLimitStore.clear();
  rateLimitPrunerStarted = false;
  if (rateLimitPrunerHandle) {
    clearInterval(rateLimitPrunerHandle);
    rateLimitPrunerHandle = null;
  }
}
```

- [ ] **Step 4: Fix `SandboxGit.git()` in `src/sandbox/git.ts`**

Add import at top:
```typescript
import { sandboxEnv } from './sandbox.js';
```

In the `git()` method, replace `...process.env` with `...sandboxEnv()`:
```typescript
env: {
  ...sandboxEnv(),
  GIT_AUTHOR_NAME: `ai-arena:${this.modelName}`,
  GIT_AUTHOR_EMAIL: `ai-arena-${this.modelName}@localhost`,
  GIT_COMMITTER_NAME: `ai-arena:${this.modelName}`,
  GIT_COMMITTER_EMAIL: `ai-arena-${this.modelName}@localhost`,
},
```

- [ ] **Step 5: Improve `BLOCKED_ENV_PREFIXES` documentation in `src/sandbox/sandbox.ts`**

Replace the comment above the array:
```typescript
/**
 * Sensitive environment variable names/prefixes stripped from sandboxed commands.
 *
 * Matching: `key === prefix` (exact) OR `key.startsWith(prefix)` (prefix).
 * Entries without a trailing `_` act as both exact names AND prefixes — i.e.,
 * OPENAI_API_KEY blocks OPENAI_API_KEY itself and OPENAI_API_KEY_2, etc.
 * ARENA_API_KEY_ (with trailing `_`) blocks ARENA_API_KEY_CI, ARENA_API_KEY_READONLY, etc.
 * DASHBOARD_JWT_SECRET and DASHBOARD_PASSWORD are exact names that also cover
 * any variable starting with those strings.
 *
 * To add a new secret family, append the common prefix here.
 */
```

- [ ] **Step 6: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 7: Commit**

```
git add .env.example src/dashboard-server/auth.ts src/dashboard-server/auth-api.ts src/sandbox/git.ts src/sandbox/sandbox.ts
git commit -m "fix: timing-safe key lookup, interval leak, git sandboxEnv, env.example, BLOCKED_ENV_PREFIXES"
```

---

## Task 7: Scenario name validation

**Issues fixed:** #17 (MEDIUM)

**Files:**
- Modify: `src/dashboard-server/routes/scenarios.ts`

- [ ] **Step 1: Replace `resolveAndValidate`**

```typescript
function resolveAndValidate(name: string): string | null {
  // Allow only simple alphanumeric names — no path separators or shell chars.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  const resolved = resolveScenarioPath(scenariosDir(), name);
  // Defence in depth: confirm resolved path is within scenariosDir.
  if (!isWithin(scenariosDir(), resolved)) return null;
  return resolved;
}
```

- [ ] **Step 2: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 3: Commit**

```
git add src/dashboard-server/routes/scenarios.ts
git commit -m "fix: restrict scenario names to [a-zA-Z0-9_-] to prevent path traversal"
```

---

## Task 8: Remove `loadPricingConfig` no-op + parallel notifications

**Issues fixed:** #6 (HIGH), #18 (MEDIUM)

**Files:**
- Modify: `src/cost-tracking/pricing.ts`
- Modify: `src/cost-tracking/index.ts`
- Modify: `src/notifications/index.ts`
- Grep and update any callers of `loadPricingConfig`

- [ ] **Step 1: Find all callers**

```powershell
Select-String -Path "src/**/*.ts" -Pattern "loadPricingConfig" -Recurse
```

For each caller file, remove the import and the call to `loadPricingConfig(...)`.

- [ ] **Step 2: Remove from `src/cost-tracking/pricing.ts`**

Delete:
- The `pricingConfig` singleton (line 5)
- The entire `loadPricingConfig` function (lines 7-16)
- Update `resetPricingCache` to a no-op (it previously only reset `pricingConfig`):

```typescript
/** No-op — pricing is sourced exclusively from SQLite. Retained for import compatibility. */
export function resetPricingCache(): void {}
```

- [ ] **Step 3: Remove from `src/cost-tracking/index.ts`**

Remove `loadPricingConfig` from the re-export. Keep `resetPricingCache` (now a no-op).

- [ ] **Step 4: Fix notification dispatch in `src/notifications/index.ts`**

Replace the sequential `for` loop (lines 86-92):
```typescript
const settled = await Promise.allSettled(
  channelNames.map((name) => sendNotification(name, event, logger)),
);
for (const outcome of settled) {
  results.push(
    outcome.status === 'fulfilled'
      ? outcome.value
      : { channel: 'unknown', success: false, error: String(outcome.reason), timestamp: new Date().toISOString() },
  );
}
```

- [ ] **Step 5: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 6: Commit**

```
git add src/cost-tracking/pricing.ts src/cost-tracking/index.ts src/notifications/index.ts
git commit -m "fix: remove loadPricingConfig no-op; parallel notification dispatch"
```

---

## Task 9: Catalog config env vars + async `ensureBuilt`

**Issues fixed:** #19 (LOW), #20 (LOW), #23 (LOW)

**Files:**
- Modify: `src/catalog/sync.ts`
- Modify: `src/orchestrator/run-lifecycle.ts`
- Modify: `.env.example`

- [ ] **Step 1: Replace hardcoded constants in `src/catalog/sync.ts`**

Remove lines 26-27 and replace with helper functions:
```typescript
function getApiUrl(): string {
  return process.env.MODELS_DEV_API_URL ?? 'https://models.dev/api.json';
}
function getRefreshIntervalMs(): number {
  const days = Number(process.env.CATALOG_REFRESH_INTERVAL_DAYS ?? '30');
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;
}
```

Update `fetchSync` default argument:
```typescript
export async function fetchSync(source: 'models.dev', opts: SyncOpts = { apiUrl: getApiUrl() }): Promise<SyncResult> {
```

Update `updateCacheState` call to use `getRefreshIntervalMs()` instead of `REFRESH_INTERVAL_MS`.

- [ ] **Step 2: Append to `.env.example`**

```
# Catalog (models.dev) sync
# MODELS_DEV_API_URL=https://models.dev/api.json
# CATALOG_REFRESH_INTERVAL_DAYS=30
```

- [ ] **Step 3: Make `ensureBuilt` async in `src/orchestrator/run-lifecycle.ts`**

Replace `import { execFileSync } from 'node:child_process'` with:
```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
```

Replace the body of `ensureBuilt`:
```typescript
export async function ensureBuilt(root: string, logger: Logger): Promise<void> {
  const worker = pm2h.workerScriptPath(root);
  if (fs.existsSync(worker)) return;
  logger.info('Compiled worker not found -- building project (npm run build)...');
  try {
    await execFileAsync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build'],
      { cwd: root, shell: process.platform === 'win32' },
    );
  } catch (err) {
    throw new Error(
      `Failed to build automatically. Run "npm run build" first. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}
```

- [ ] **Step 4: Run typecheck**

```
npm run typecheck
```

- [ ] **Step 5: Commit**

```
git add src/catalog/sync.ts src/orchestrator/run-lifecycle.ts .env.example
git commit -m "feat: configurable catalog URL/interval; async ensureBuilt"
```

---

## Task 10: Low-severity fixes — fire-and-forget counters, singleton docs, deduplication

**Issues fixed:** #3 (doc), #11 (named constants), #14 (dedup conversation parser), #22 (LOW)

**Files:**
- Modify: `src/orchestrator/run-lifecycle.ts` — failure counters
- Modify: `src/db/client.ts` — JSDoc singleton warning
- Create: `src/logger/conversation-parser.ts` — shared conversation parser
- Modify: `src/dashboard-server/routes/analytics.ts` — use shared parser
- Modify: `src/anomaly-detection/detectors.ts` — use shared parser

- [ ] **Step 1: Create `src/logger/conversation-parser.ts`** — the canonical, deduplicated implementation

```typescript
export interface ToolCallEntry {
  name: string;
  turn: number;
  success: boolean;
  arguments?: Record<string, unknown>;
}

/**
 * Extract ordered tool calls (with success/failure) from a conversation.json
 * `entries` array. This is the single canonical parser — do not duplicate.
 */
export function extractToolCallsFromConversation(
  conv: Record<string, unknown>,
): ToolCallEntry[] {
  const entries = (conv.entries as Array<Record<string, unknown>>) ?? [];
  const calls: ToolCallEntry[] = [];
  let currentTurn = 0;
  for (const entry of entries) {
    const type = entry.type as string;
    if (type === 'assistant') {
      currentTurn = typeof entry.turn === 'number' ? entry.turn : currentTurn + 1;
    } else if (type === 'tool_call') {
      calls.push({
        name: String(entry.toolName ?? ''),
        turn: currentTurn,
        success: true,
        arguments: ((entry.meta as Record<string, unknown>)?.args as Record<string, unknown>) ?? {},
      });
    } else if (type === 'tool_result') {
      const name = String(entry.toolName ?? '');
      const isError = Boolean(entry.isError);
      // Find the last matching call in the current turn and update success.
      const last = [...calls].reverse().find((c) => c.turn === currentTurn && c.name === name);
      if (last) last.success = !isError;
    }
  }
  return calls;
}
```

- [ ] **Step 2: Update `src/dashboard-server/routes/analytics.ts`** — replace the local `extractToolCallsFromConversation` with the shared one:

Remove the local function definition. Add import:
```typescript
import { extractToolCallsFromConversation } from '../../logger/conversation-parser.js';
```
Adjust the call sites to match the new `ToolCallEntry` interface (`name`, `turn`, `success`).

- [ ] **Step 3: Update `src/anomaly-detection/detectors.ts`** — replace the local `extractToolCallsFromConversation` with the shared one:

Remove the local function definition (lines 31-60). Add import:
```typescript
import { extractToolCallsFromConversation } from '../logger/conversation-parser.js';
```
The `ToolCallRow` type in `detectors.ts` should match `ToolCallEntry` — update accordingly. Rename `ToolCallRow` usages in this file to use `ToolCallEntry` if they are equivalent.

- [ ] **Step 4: Add failure counters in `src/orchestrator/run-lifecycle.ts`**

At module scope:
```typescript
let anomalyAnalysisFailures = 0;
let statsWritebackFailures = 0;

/** Returns counts of post-run background task failures (non-fatal). */
export function getPostRunFailureCounts(): { anomalyAnalysis: number; statsWriteback: number } {
  return { anomalyAnalysis: anomalyAnalysisFailures, statsWriteback: statsWritebackFailures };
}
```

Update the two `void ... .catch(...)` calls in `finalizeRunByRunId` to increment counters:
```typescript
void analyzeRun(runId, logger).catch((e) => {
  anomalyAnalysisFailures++;
  logger.warn('Anomaly analysis failed', { runId, error: e instanceof Error ? e.message : String(e), totalFailures: anomalyAnalysisFailures });
});
void writeRunStats(runId, root).catch((e) => {
  statsWritebackFailures++;
  logger.warn('writeRunStats failed (non-fatal)', { runId, err: e instanceof Error ? e.message : String(e), totalFailures: statsWritebackFailures });
});
```

Also update the `analyzeRun` call in `finalizeRun` (the CLI path).

- [ ] **Step 5: Add JSDoc singleton warning to `src/db/client.ts`**

Above `export function initDb`:
```typescript
/**
 * Initialise (or return) the shared SQLite database singleton.
 *
 * WARNING — SINGLETON: Only the first call with a given path is honoured.
 * Subsequent calls with a *different* path are silently ignored. In automated
 * tests, call `closeDb()` between test suites to reset the singleton, or use
 * an in-memory database (`:memory:`).
 */
```

- [ ] **Step 6: Run typecheck and tests**

```
npm run typecheck
npm test
```

- [ ] **Step 7: Commit**

```
git add src/orchestrator/run-lifecycle.ts src/db/client.ts src/logger/conversation-parser.ts src/dashboard-server/routes/analytics.ts src/anomaly-detection/detectors.ts
git commit -m "fix: deduplicate conversation parser; failure counters; singleton doc"
```

---

## Verification Plan

### Automated
```powershell
npm run typecheck    # must show zero errors
npm test             # must show zero failures
npm run lint         # must show zero lint errors
```

### Manual
- Start the dashboard: `npm run dashboard:dev` — confirm it loads.
- Check `GET /api/runs` returns data and does not hang.
- Run `npx tsx src/cli.ts regress --help` — must print options without error.
- Confirm `grep -rn "from '../worker.js'" src/orchestrator src/evaluation` returns no matches.
- Confirm `.env.example` documents `DASHBOARD_JWT_SECRET` and `DASHBOARD_PASSWORD`.

---

## Future Work (not in this plan)

- **Issue #3 / #10 (fully):** Migrate `runs-index.json` to SQLite and replace module-level singletons with DI — large cross-cutting refactor, warranting its own plan.
- **Issue #10 (pagination):** Add `LIMIT/OFFSET` to `GET /api/runs` — depends on SQLite migration above.
- **Issue #24 (loadApiKeysConfig):** Move to class/factory pattern — depends on broader DI refactor.
- **Issue #25 (ws verifyClient):** Move auth to `connection` handler — warrants its own targeted change when ws@9 is adopted.

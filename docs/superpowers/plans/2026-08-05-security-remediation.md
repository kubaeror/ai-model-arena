# Security Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real vulnerabilities found in the deep code-scanning review — scenario `starterFiles` traversal (critical), secret `envVar` injection (high), Bearer-regex ReDoS (medium), budget-ledger prototype pollution (medium), insecure readiness temp file (low) — plus CodeQL hygiene and dependabot PR housekeeping.

**Architecture:** All fixes are surgical, in-place changes to existing files. Defense-in-depth pattern already used in this codebase (`resolveAndValidate` + `isWithin` in `routes/scenarios.ts`, `resolveSuitePath` in `routes/regression.ts`) is extended to the remaining tainted flows. TDD: each task writes a failing test first, then the minimal fix, then commits. The final task is operational (GitHub CLI) and produces no commits.

**Tech Stack:** Node >= 22, TypeScript ESM strict, Express, node:test + tsx, zod v4, no new dependencies.

## Global Constraints

- ESM imports only (`import`/`export`, no `require`); files end in `.ts`, imports reference `.js` specifiers.
- Strict TypeScript — `npm run typecheck` (`tsc --noEmit`) and `npm run typecheck:tests` (`tsc --noEmit -p tsconfig.test.json`) must pass.
- ESLint (`npm run lint`) covers `src` and `scripts` only; new test files are exempt but must typecheck.
- All tests use `node:test` + `assert/strict` and run under `npx tsx --test <file>`; the full suite is `npm test` (globs `tests/**/*.test.ts`).
- No new runtime or dev dependencies.
- Logging via pino (`createLogger`), never `console.log` in `src/`.
- Existing tests must not break: `tests/secrets/store.test.ts` intentionally uses regex-special keys (`MY.KEY`, `MY$KEY`) — do NOT add key validation inside `SecretStore` itself; validation lives at the HTTP route layer.
- Commit style follows the repo: conventional commits (`fix(security):`, `ci(codeql):`, etc.).

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/dashboard-server/routes/scenarios.ts` | Validate `starterFiles` at write time; guard reads/deletes at use time | 1 |
| `tests/dashboard/scenarios-starterfiles-traversal.test.ts` | New: route tests for the traversal fix | 1 |
| `src/dashboard-server/routes/secrets.ts` | Reject unsafe `envVar` keys and newline-containing values | 2 |
| `tests/dashboard/secrets-envvar-validation.test.ts` | New: unit + route tests for envVar validation | 2 |
| `src/dashboard-server/auth.ts` | Export `extractBearerToken` (ReDoS-free parsing) | 3 |
| `src/dashboard-server/server.ts` | Use `extractBearerToken` in metrics + logout | 3 |
| `tests/dashboard/extract-bearer-token.test.ts` | New: token parsing tests | 3 |
| `src/cost-tracking/budget.ts` | Block prototype-polluting model names in the ledger | 4 |
| `tests/cost-tracking/budget.test.ts` | Extend: pollution tests | 4 |
| `src/runner.ts` | Export `markReady`/`unmarkReady` with symlink-safe creation | 5 |
| `tests/runner/readiness-file.test.ts` | New: readiness file tests | 5 |
| `.github/workflows/codeql.yml` + `.github/codeql/codeql-config.yml` | Bump actions to v4, add config excluding test dirs | 6 |
| GitHub PRs #49, #30, #28, #54, #26, #29 | Merge / close via `gh` | 7 |

---

### Task 1: Scenario `starterFiles` path traversal (CRITICAL)

**Context:** `ScenarioConfigSchema.starterFiles` is an unvalidated `z.string()` (src/config.ts:44). POST/PUT accept `body.starterFiles` verbatim (scenarios.ts:120-124, 170-173). Consequences: (a) GET `/:name` (viewer role) → `listStarterFiles` → `path.join(scenariosDir(), scenario.starterFiles)` → `walkFiles` + `fs.readFileSync` returns arbitrary file contents, including `.env` and `/etc/arena/secrets`; (b) DELETE (editor) → `fs.rmSync(path.join(scenariosDir(), scenario.starterFiles), { recursive: true, force: true })` (scenarios.ts:192) recursively deletes arbitrary directory trees (e.g. `starterFiles: "../../../src"`).

**Files:**

- Modify: `src/dashboard-server/routes/scenarios.ts`
- Create: `tests/dashboard/scenarios-starterfiles-traversal.test.ts`

**Interfaces:**

- Consumes: `route-test-harness.js` exports `boot(t)`, `authedGet(base, token, path)`, `postJson(base, token, path, body)`, `TEST_ADMIN`; harness fields `h.base`, `h.adminToken`, `h.tmpDir` (temp project root with `configs/scenarios`).
- Produces: no new exports; adds module-level const `TEMPLATE_PATH_RE` and write-time/read-time/delete-time guards in `createScenariosRouter`'s POST/PUT handlers, `listStarterFiles`, and DELETE handler.

- [ ] **Step 1: Write the failing route tests**

Create `tests/dashboard/scenarios-starterfiles-traversal.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, authedGet, postJson } from './route-test-harness.js';

// S6: scenario starterFiles path-traversal prevention.
//
// Before the fix, POST/PUT accepted body.starterFiles unvalidated, so an
// editor could set starterFiles: "../../../configs" and:
//   - any viewer could GET /api/scenarios/:name and read arbitrary file
//     contents via listStarterFiles();
//   - DELETE would fs.rmSync() that directory tree recursively.

test('POST /api/scenarios rejects a traversal starterFiles value', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'evil',
    systemPrompt: 'x',
    task: 'y',
    starterFiles: '../../../configs',
  });
  assert.equal(res.status, 400, 'traversal starterFiles must be rejected');
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /starterFiles/i);
});

test('PUT /api/scenarios/:name rejects a traversal starterFiles value', async (t) => {
  const h = await boot(t);
  const created = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'roundtrip',
    systemPrompt: 'x',
    task: 'y',
  });
  assert.equal(created.status, 201);
  const res = await fetch(`${h.base}/api/scenarios/roundtrip`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${h.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'roundtrip', starterFiles: '../../etc' }),
  });
  assert.equal(res.status, 400, 'traversal starterFiles on PUT must be rejected');
});

test('POST /api/scenarios accepts a well-formed templates/<name> starterFiles', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/scenarios', {
    name: 'good-tpl',
    systemPrompt: 'x',
    task: 'y',
    starterFiles: 'templates/my-tpl',
  });
  assert.equal(res.status, 201, 'templates/<name> starterFiles must be accepted');
});

test('GET /api/scenarios/:name refuses to serve files for a traversal starterFiles on disk', async (t) => {
  // Defense in depth: a YAML written before this fix (or by another writer)
  // may already carry a traversal starterFiles. The read path must refuse.
  const h = await boot(t);
  const evilYaml = path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml');
  fs.writeFileSync(
    evilYaml,
    'name: evil\nsystemPrompt: x\ntask: y\nstarterFiles: ../../../configs\n',
  );
  const res = await authedGet(h.base, h.adminToken, '/api/scenarios/evil');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { scenario: { name: string }; starterFiles: unknown[] };
  assert.equal(body.scenario.name, 'evil');
  assert.deepEqual(body.starterFiles, [], 'must not walk directories outside scenariosDir()');
});

test('DELETE /api/scenarios/:name must not remove directories outside scenariosDir()', async (t) => {
  const h = await boot(t);
  const configsDir = path.join(h.tmpDir, 'configs');
  const sentinel = path.join(configsDir, 'keep-me.txt');
  fs.writeFileSync(sentinel, 'still here');
  fs.writeFileSync(
    path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml'),
    'name: evil\nsystemPrompt: x\ntask: y\nstarterFiles: ../../../configs\n',
  );
  const res = await fetch(`${h.base}/api/scenarios/evil`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${h.adminToken}` },
  });
  assert.equal(res.status, 200, 'scenario file itself is deleted');
  assert.ok(!fs.existsSync(path.join(h.tmpDir, 'configs', 'scenarios', 'evil.yaml')));
  assert.ok(fs.existsSync(sentinel), 'configs/ contents must survive');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dashboard/scenarios-starterfiles-traversal.test.ts`
Expected: 4 FAIL, 1 PASS (`templates/<name>` is accepted by the current code). The POST 400, PUT 400, GET-empty, and DELETE-survival tests fail.

- [ ] **Step 3: Implement the fix in `src/dashboard-server/routes/scenarios.ts`**

Add the module-level const next to `MAX_STARTER_FILES` (after line 28):

```ts
/** starterFiles must reference a bare template dir under configs/scenarios/templates. */
const TEMPLATE_PATH_RE = /^templates\/[a-zA-Z0-9_-]+$/;
```

Guard the read path — replace the body of `listStarterFiles` (lines 55-63):

```ts
function listStarterFiles(scenario: ScenarioConfig): StarterFile[] {
  if (!scenario.starterFiles) return [];
  const dir = path.join(scenariosDir(), scenario.starterFiles);
  // Defense in depth: YAML written before write-time validation (or by any
  // other writer) may carry a traversal starterFiles. Never walk outside
  // scenariosDir().
  if (!isWithin(scenariosDir(), dir)) return [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return walkFiles(dir).map((full) => ({
    path: path.relative(dir, full).replace(/\\/g, '/'),
    content: fs.readFileSync(full, 'utf8'),
  }));
}
```

In the POST handler, after `const parsed = ScenarioConfigSchema.parse({ ...body, starterFiles });` (line 125) insert:

```ts
    if (parsed.starterFiles !== undefined && !TEMPLATE_PATH_RE.test(parsed.starterFiles)) {
      res.status(400).json({ error: 'Invalid starterFiles; must be templates/<bare-name>' });
      return;
    }
```

In the PUT handler, after `const parsed = ScenarioConfigSchema.parse({ ...existing, ...body, name: newName, starterFiles });` (line 174) insert:

```ts
    if (parsed.starterFiles !== undefined && !TEMPLATE_PATH_RE.test(parsed.starterFiles)) {
      res.status(400).json({ error: 'Invalid starterFiles; must be templates/<bare-name>' });
      return;
    }
```

In the DELETE handler, replace the removal block (lines 191-193):

```ts
    if (scenario.starterFiles) {
      const tplDir = path.join(scenariosDir(), scenario.starterFiles);
      // Never rm -rf outside scenariosDir() (see listStarterFiles note).
      if (isWithin(scenariosDir(), tplDir)) {
        fs.rmSync(tplDir, { recursive: true, force: true });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dashboard/scenarios-starterfiles-traversal.test.ts`
Expected: 5 PASS.

Then run the existing scenario round-trip and route tests to confirm no regression:
Run: `npx tsx --test tests/dashboard/routes.test.ts tests/dashboard/rbac-enforcement.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint`
Expected: clean.

```bash
git add src/dashboard-server/routes/scenarios.ts tests/dashboard/scenarios-starterfiles-traversal.test.ts
git commit -m "fix(security): validate scenario starterFiles paths to block traversal"
```

---

### Task 2: Secret `envVar` key/value validation (HIGH)

**Context:** `PUT /api/secrets/:envVar` (routes/secrets.ts:80-125) passes the URL param straight to `secretStore.set()` / the k8s API. In bare-metal mode `SecretStore.writeEnvFile` (store.ts:126-141) writes `` `${key}="${value}"` `` into `.env` and `process.env[envVar] = value` — a key containing `\n`, `=`, or whitespace injects arbitrary env lines (CodeQL alerts #32/39/40/82; k8s mode is safe because the k8s API validates keys). `SecretStore` itself must stay permissive (existing tests use `MY.KEY`/`MY$KEY`), so validation is added in the route.

**Files:**

- Modify: `src/dashboard-server/routes/secrets.ts`
- Create: `tests/dashboard/secrets-envvar-validation.test.ts`

**Interfaces:**

- Produces: exported `isValidEnvVarName(name: string): boolean` and `hasControlChars(value: string): boolean` from `src/dashboard-server/routes/secrets.js` (route modules exporting pure helpers is the established pattern — see `resolveSuitePath` in `routes/regression.ts`).
- Consumes: harness `boot(t)`, `postJson`; the k8s branch is skipped in tests (harness runs bare-metal), so only 400-path HTTP tests are used — the 200 path writes the repo-root `.env` and is intentionally not exercised over HTTP (store-level behavior is covered by `tests/secrets/store.test.ts`).

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard/secrets-envvar-validation.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, postJson } from './route-test-harness.js';
import { isValidEnvVarName, hasControlChars } from '../../src/dashboard-server/routes/secrets.js';

test('isValidEnvVarName accepts normal env var keys', () => {
  assert.equal(isValidEnvVarName('OPENAI_API_KEY'), true);
  assert.equal(isValidEnvVarName('MY-API-KEY'), true); // k8s-style keys stay settable
  assert.equal(isValidEnvVarName('MY.KEY'), true);     // store-level regex-special keys remain legal
});

test('isValidEnvVarName rejects keys that break .env parsing', () => {
  assert.equal(isValidEnvVarName(''), false);
  assert.equal(isValidEnvVarName('A B'), false);
  assert.equal(isValidEnvVarName('A\nB'), false);
  assert.equal(isValidEnvVarName('A\rB'), false);
  assert.equal(isValidEnvVarName('A\tB'), false);
  assert.equal(isValidEnvVarName('A=B'), false);
});

test('hasControlChars rejects newline-containing values', () => {
  assert.equal(hasControlChars('sk-abc123'), false);
  assert.equal(hasControlChars('line1\nline2'), true);
  assert.equal(hasControlChars('line1\r\nline2'), true);
});

test('PUT /api/secrets/:envVar rejects an envVar with a newline (env line injection)', async (t) => {
  const h = await boot(t);
  const res = await postJson(
    h.base,
    h.adminToken,
    `/api/secrets/${encodeURIComponent('FOO\nBAR=x')}`,
    { value: 'v' },
  );
  assert.equal(res.status, 400, 'newline in envVar must be rejected');
});

test('PUT /api/secrets/:envVar rejects an envVar with an equals sign', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/secrets/A%3DB', { value: 'v' });
  assert.equal(res.status, 400, 'equals sign in envVar must be rejected');
});

test('PUT /api/secrets/:envVar rejects a value containing newlines', async (t) => {
  const h = await boot(t);
  const res = await postJson(h.base, h.adminToken, '/api/secrets/SAFE_KEY', {
    value: 'line1\nEVIL=1',
  });
  assert.equal(res.status, 400, 'newline in secret value must be rejected');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dashboard/secrets-envvar-validation.test.ts`
Expected: 6 FAIL — `isValidEnvVarName`/`hasControlChars` are not defined, and the three HTTP tests get 200 instead of 400.

- [ ] **Step 3: Implement the fix in `src/dashboard-server/routes/secrets.ts`**

Add after the `mask` function (after line 16):

```ts
/**
 * Reject envVar keys that could break .env parsing or inject lines into the
 * file (bare-metal store). k8s API keys (alphanumeric, '-', '_', '.') and
 * regex-special store keys remain settable — only whitespace, '=' and empty
 * names are dangerous on the write path.
 */
export function isValidEnvVarName(name: string): boolean {
  return name.length > 0 && !/[\s=]/.test(name);
}

/** Secret values must not contain line breaks (would break .env quoting). */
export function hasControlChars(value: string): boolean {
  return /[\r\n]/.test(value);
}
```

In the PUT handler, after the existing 400 check (lines 84-87) insert:

```ts
    if (!isValidEnvVarName(envVar)) {
      res.status(400).json({ error: 'Invalid envVar; must not contain whitespace or "="' });
      return;
    }
    if (hasControlChars(value)) {
      res.status(400).json({ error: 'Secret value must not contain newlines' });
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dashboard/secrets-envvar-validation.test.ts tests/secrets/store.test.ts tests/dashboard/routes.test.ts`
Expected: all PASS (the GET /api/secrets route test at routes.test.ts:153 is unaffected).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint`
Expected: clean.

```bash
git add src/dashboard-server/routes/secrets.ts tests/dashboard/secrets-envvar-validation.test.ts
git commit -m "fix(security): validate secret envVar keys and values on the dashboard API"
```

---

### Task 3: Replace ReDoS-prone Bearer regexes (MEDIUM)

**Context:** `/^Bearer\s+(.+)$/i` is quadratic on `Authorization` headers with long space runs (CodeQL alerts #17 server.ts:255, #54 auth.ts:281, #66 server.ts:179). Parsing is trivially linear with string slicing.

**Files:**

- Modify: `src/dashboard-server/auth.ts`
- Modify: `src/dashboard-server/server.ts`
- Create: `tests/dashboard/extract-bearer-token.test.ts`

**Interfaces:**

- Produces: exported `extractBearerToken(authorization: string): string | null` from `src/dashboard-server/auth.js` — returns the trimmed token, or `null` when the header is missing/empty/wrong scheme. Scheme match is case-insensitive (RFC 7235); whitespace between scheme and token is trimmed.
- Consumes: `extractBearerToken` in `server.ts` metrics handler (line ~178) and logout handler (line ~254).

- [ ] **Step 1: Write the failing tests**

Create `tests/dashboard/extract-bearer-token.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken } from '../../src/dashboard-server/auth.js';

test('extractBearerToken parses a standard Bearer header', () => {
  assert.equal(extractBearerToken('Bearer eyJhbGciOiJIUzI1NiJ9'), 'eyJhbGciOiJIUzI1NiJ9');
});

test('extractBearerToken is case-insensitive on the scheme', () => {
  assert.equal(extractBearerToken('bearer token-abc'), 'token-abc');
  assert.equal(extractBearerToken('BEARER token-abc'), 'token-abc');
});

test('extractBearerToken tolerates spaces between scheme and token', () => {
  assert.equal(extractBearerToken('Bearer   token-abc'), 'token-abc');
});

test('extractBearerToken returns null for missing or malformed headers', () => {
  assert.equal(extractBearerToken(''), null);
  assert.equal(extractBearerToken('Basic dXNlcjpwYXNz'), null);
  assert.equal(extractBearerToken('Bearer'), null);
  assert.equal(extractBearerToken('Bearer '), null);
  assert.equal(extractBearerToken('Bearer   '), null);
});

test('extractBearerToken handles very long whitespace runs without pathological slowdown', () => {
  const spaces = ' '.repeat(100_000);
  const start = Date.now();
  const result = extractBearerToken(`Bearer ${spaces}`);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 5_000, `expected linear-time parse, took ${elapsed}ms`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/dashboard/extract-bearer-token.test.ts`
Expected: 6 FAIL — `extractBearerToken` is not exported.

- [ ] **Step 3: Implement the fix**

In `src/dashboard-server/auth.ts`, replace `extractToken`'s regex (lines 278-292) and add the exported helper above it:

```ts
const BEARER_PREFIX = 'Bearer ';

/**
 * Parse an Authorization header and return the bearer token, or null.
 * Linear-time string parsing — the previous /^Bearer\s+(.+)$/i regex was
 * quadratic on headers with long runs of whitespace (CodeQL js/polynomial-redos).
 */
export function extractBearerToken(authorization: string): string | null {
  if (authorization.length <= BEARER_PREFIX.length) return null;
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null;
  }
  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function extractToken(req: Request): string | null {
  // 1. Authorization: Bearer <token> header (standard)
  const token = extractBearerToken(req.headers.authorization ?? '');
  if (token) return token;
  // 2. httpOnly cookie (production — XSS-resistant)
  const cookies = req.headers.cookie ?? '';
  // Try __Host- prefixed first, then plain
  for (const name of [cookieName(), COOKIE_BASE]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cm = new RegExp('(?:^|;\\s*)' + escaped + '=([^;]+)').exec(cookies);
    if (cm?.[1]) return cm[1];
  }
  return null;
}
```

In `src/dashboard-server/server.ts`:

Add `extractBearerToken` to the existing auth import. Find the import line for `./auth.js` in server.ts (it already imports `requireAuth`, `verifyCredentials`, `signToken`, `setTokenCookie`, `clearTokenCookie`, `revokeToken`, `loadAuthConfig` — add `extractBearerToken` to that list).

Replace the metrics handler token check (lines 177-183):

```ts
      if (metricsToken) {
        const token = extractBearerToken(req.headers.authorization ?? '');
        if (!token || token !== metricsToken) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
      } else if (req.user?.role !== 'admin') {
```

Replace the logout handler (lines 253-261):

```ts
  app.post('/api/auth/logout', requireAuth(auth), async (req: AuthedRequest, res) => {
    const token = extractBearerToken(req.headers.authorization ?? '');
    if (token) {
      await revokeToken(token);
    }
    clearTokenCookie(res);
    res.json({ ok: true });
  });
```

Note: this trims the token before comparing against `METRICS_TOKEN`; an operator-configured token with leading/trailing spaces would no longer match — this is the intended hardening.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/dashboard/extract-bearer-token.test.ts tests/dashboard/auth.test.ts tests/dashboard/routes.test.ts`
Expected: all PASS (login/logout/RBAC still work).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint`
Expected: clean.

```bash
git add src/dashboard-server/auth.ts src/dashboard-server/server.ts tests/dashboard/extract-bearer-token.test.ts
git commit -m "fix(security): replace ReDoS-prone Bearer regexes with string parsing"
```

---

### Task 4: Guard budget ledger against prototype pollution (MEDIUM)

**Context:** `src/cost-tracking/budget.ts` writes `state.models[modelName]` (line 98) and `state.reservations[modelName]` (lines 179-180) with a modelName that flows from run/task specs (enqueueable by dashboard users). `modelName === "__proto__"` resolves to `Object.prototype`, so `addSpend` adds `Object.prototype.daily` and `reserveBudget` adds `Object.prototype.push` — process-wide prototype pollution (CodeQL alerts #65, #83).

**Files:**

- Modify: `src/cost-tracking/budget.ts`
- Modify: `tests/cost-tracking/budget.test.ts`

**Interfaces:**

- Consumes: existing test helpers in `tests/cost-tracking/budget.test.ts` — `setup()`, `writeState()`, and imports `loadBudgetConfig, checkBudget, reserveBudget, releaseReservation, resetBudgetCache` from `../../src/cost-tracking/budget.js`.
- Produces: module-level `safeLedgerModel(modelName: string): boolean` in `budget.ts`; no exported API change.

- [ ] **Step 1: Write the failing tests**

Append to `tests/cost-tracking/budget.test.ts` (extend the import block to include `addSpend`):

```ts
test('addSpend ignores prototype-polluting model names', async () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath } = setup();
  try {
    loadBudgetConfig(configPath);
    await addSpend('__proto__', 1, rootDir);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).daily, undefined,
      'Object.prototype must not gain a daily ledger');
    assert.equal((Object.prototype as unknown as Record<string, unknown>).monthly, undefined);
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reserveBudget ignores prototype-polluting model names', () => {
  resetBudgetCache();
  const { tmp, rootDir, configPath, statePath } = setup();
  try {
    loadBudgetConfig(configPath);
    writeState(statePath); // ensure the state file exists before assertions
    const result = reserveBudget('constructor', 1, rootDir);
    assert.equal(result.ok, true);
    assert.equal((Object.prototype as unknown as Record<string, unknown>).push, undefined,
      'Object.prototype must not gain array methods');
    assert.ok(!Object.prototype.hasOwnProperty.call(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).reservations ?? {}, 'constructor'),
      'state file must not contain a reserved-key reservation');
  } finally {
    resetBudgetCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/cost-tracking/budget.test.ts`
Expected: 2 FAIL — `addSpend('__proto__', ...)` sets `Object.prototype.daily`; `reserveBudget('constructor', ...)` sets `Object.prototype.push`.

- [ ] **Step 3: Implement the fix in `src/cost-tracking/budget.ts`**

Add after the `MONTH_KEY` const (line 14):

```ts
/** Object.prototype keys that a model name must never write through. */
const LEDGER_RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeLedgerModel(modelName: string): boolean {
  return !LEDGER_RESERVED_KEYS.has(modelName);
}
```

In `addSpend` (line 85), right after `if (!budgetConfig) return;` add:

```ts
    if (!safeLedgerModel(modelName)) {
      logger?.warn('Ignoring spend for unsafe model name', { modelName });
      return;
    }
```

In `reserveBudget` (line 133), right after `if (!budgetConfig) return { ok: true };` add:

```ts
  if (!safeLedgerModel(modelName)) {
    logger?.warn('Ignoring reservation for unsafe model name', { modelName });
    return { ok: true };
  }
```

In `releaseReservation` (line 197), change the persisted-state guard from:

```ts
  if (budgetConfig) {
    const state = loadBudgetState(budgetConfig, rootDir, logger);
```

to:

```ts
  if (budgetConfig && safeLedgerModel(modelName)) {
    const state = loadBudgetState(budgetConfig, rootDir, logger);
```

(`checkBudget` and `getBudgetStatus` only read ledger entries, so no guard is needed there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/cost-tracking/budget.test.ts`
Expected: all PASS (original suite + 2 new tests).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint`
Expected: clean.

```bash
git add src/cost-tracking/budget.ts tests/cost-tracking/budget.test.ts
git commit -m "fix(security): guard budget ledger against prototype pollution"
```

---

### Task 5: Symlink-safe runner readiness file (LOW)

**Context:** `src/runner.ts:48` writes `/tmp/runner-ready` with a predictable path and no `O_EXCL`, so a local attacker's pre-placed symlink would be followed (CodeQL alert #27 js/insecure-temporary-file). NOTE (deviation): the file was later relocated to `/var/arena/readiness/runner-ready` (per-pod emptyDir) because CodeQL also flags O_EXCL writes under /tmp.

**Files:**

- Modify: `src/runner.ts`
- Create: `tests/runner/readiness-file.test.ts`

**Interfaces:**

- Produces: exported `markReady(filePath: string = READINESS_FILE): void` and `unmarkReady(filePath: string = READINESS_FILE): void` from `src/runner.js`. Existing internal call sites (`markReady()`, `unmarkReady()`) keep working via the default argument.

- [ ] **Step 1: Write the failing tests**

Create `tests/runner/readiness-file.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markReady, unmarkReady } from '../../src/runner.js';

test('markReady writes a regular file with content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const f = path.join(dir, 'ready');
    markReady(f);
    assert.ok(fs.existsSync(f));
    assert.ok(!fs.lstatSync(f).isSymbolicLink(), 'readiness file must be a regular file');
    assert.ok(fs.statSync(f).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markReady does not follow a pre-existing symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const target = path.join(dir, 'victim');
    fs.writeFileSync(target, 'sentinel');
    const link = path.join(dir, 'ready');
    fs.symlinkSync(target, link);
    markReady(link);
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel', 'symlink target must never be written through');
    assert.ok(!fs.lstatSync(link).isSymbolicLink(), 'link path must be replaced with a regular file');
    assert.ok(fs.readFileSync(link, 'utf8').length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unmarkReady removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-ready-'));
  try {
    const f = path.join(dir, 'ready');
    markReady(f);
    unmarkReady(f);
    assert.ok(!fs.existsSync(f));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/runner/readiness-file.test.ts`
Expected: 3 FAIL — `markReady`/`unmarkReady` are not exported from `src/runner.js`.

- [ ] **Step 3: Implement the fix in `src/runner.ts`**

Replace the existing `markReady`/`unmarkReady` (lines 44-54):

```ts
const READINESS_FILE = '/var/arena/readiness/runner-ready';

/**
 * Write the readiness file. Created with O_EXCL ('wx') so a pre-placed
 * symlink is never followed: on EEXIST we unlink (which removes the link
 * itself, not its target) and re-create exclusively. Failures are
 * non-fatal — the k8s probe simply sees not-ready and retries.
 */
export function markReady(filePath: string = READINESS_FILE): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(filePath, Date.now().toString(), { flag: 'wx' });
    } catch {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      try { fs.writeFileSync(filePath, Date.now().toString(), { flag: 'wx' }); } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal — probe will retry */ }
}

export function unmarkReady(filePath: string = READINESS_FILE): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}
```

Verify the internal call sites still read `markReady()` / `unmarkReady()` with no arguments (defaults keep `/var/arena/readiness/runner-ready`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/runner/readiness-file.test.ts tests/runner/*.test.ts`
Expected: all PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run typecheck:tests && npm run lint`
Expected: clean.

```bash
git add src/runner.ts tests/runner/readiness-file.test.ts
git commit -m "fix(security): create runner readiness file without following symlinks"
```

---

### Task 6: CodeQL — bump actions to v4 and exclude test-only paths (LOW)

**Context:** 10 of the open alerts (`js/missing-rate-limiting` ×9 in `tests/dashboard/`, +1 rbac test) are false positives in test harnesses, plus 2 log-injection alerts in the dev-only `scripts/ws-smoke.mjs`. Open PRs #26/#29 (codeql-action v3.37.2 → v4.37.3 for init/analyze) are stale-branch dependabot artifacts that duplicate this change — this task supersedes them (they get closed in Task 7).

**Files:**

- Modify: `.github/workflows/codeql.yml`
- Create: `.github/codeql/codeql-config.yml`

**Interfaces:**

- Consumes: the exact v4.37.3 pinned SHAs from dependabot PRs #26 (init) and #29 (analyze) — fetch them in Step 1.
- Produces: a single coherent CodeQL workflow with v4 actions + a config file that excludes `tests/**` and `scripts/ws-smoke.mjs` from analysis.

- [ ] **Step 1: Fetch the v4.37.3 pinned SHAs**

Run:

```bash
gh pr diff 26 | grep '^\+.*init@'
gh pr diff 29 | grep '^\+.*analyze@'
```

Expected: two lines like `+        uses: github/codeql-action/init@<40-char-sha> # v4.37.3` and `+        uses: github/codeql-action/analyze@<40-char-sha> # v4.37.3`. Record both SHAs; they are used in Step 3. (If the diff output is empty, run `git fetch origin pull/26/head && git show FETCH_HEAD:.github/workflows/codeql.yml | grep init@`.)

- [ ] **Step 2: Write the failing check**

Create `.github/codeql/codeql-config.yml`:

```yaml
name: "Arena CodeQL config"

# Test harnesses and dev-only scripts are excluded from analysis: their
# alerts (e.g. js/missing-rate-limiting in route-test-harness.ts) are
# false positives by design and would otherwise keep the dashboard red.
paths-ignore:
  - 'tests/**'
  - '**/*.test.ts'
  - 'scripts/ws-smoke.mjs'
```

Verify: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/codeql/codeql-config.yml')); print('yaml ok')"`
Expected: prints `yaml ok`.

- [ ] **Step 3: Modify `.github/workflows/codeql.yml`**

Replace lines 29-35 with (substituting the two SHAs from Step 1 for `<INIT_SHA>` and `<ANALYZE_SHA>`):

```yaml
      - name: Initialize CodeQL
        uses: github/codeql-action/init@<INIT_SHA> # v4.37.3
        with:
          languages: ${{ matrix.language }}
          queries: security-extended
          config-file: .github/codeql/codeql-config.yml

      - name: Perform CodeQL Analysis
        uses: github/codeql-action/analyze@<ANALYZE_SHA> # v4.37.3
```

- [ ] **Step 4: Verify and commit**

Run: `git diff .github/workflows/codeql.yml` — confirm only the two `uses:` lines and the added `config-file` line changed. The workflow cannot be executed locally; correctness is verified by the CI run on the next push to main.

```bash
git add .github/workflows/codeql.yml .github/codeql/codeql-config.yml
git commit -m "ci(codeql): bump actions to v4.37.3 and ignore test-only paths"
```

---

### Task 7: PR housekeeping (operational, no commits)

**Context:** Remaining open PRs are all dependabot: #49 (jsdom 25→30, all checks pass), #30 (docker/login-action 3.3→4.6, all checks pass), #28 (hadolint-action 3.1→3.4, all checks pass), #54 (undici bump in `.agents/skills/kubernetes-skill/docs/` — vendored skill docs, not product code), #26/#29 (codeql-action bumps — superseded by Task 6).

- [ ] **Step 1: Merge the clean dependency PRs**

Run each and confirm the merge succeeded:

```bash
gh pr merge 49 --rebase
gh pr merge 30 --rebase
gh pr merge 28 --rebase
```

Expected: three "Pull request #NN has been merged" messages.

- [ ] **Step 2: Close the irrelevant and superseded PRs**

```bash
gh pr close 54 --comment "Vendored skill-docs lockfile only — not part of the product dependency tree. Closing as noise."
gh pr close 26 --comment "Superseded by Task 6 of the security remediation: codeql-action/init bumped to v4.37.3 in main with a shared config file."
gh pr close 29 --comment "Superseded by Task 6 of the security remediation: codeql-action/analyze bumped to v4.37.3 in main with a shared config file."
```

Expected: three "Closed" messages.

- [ ] **Step 3: Verify zero open PRs remain**

Run: `gh pr list --state open`
Expected: empty list (or only non-dependabot PRs if any appeared in the meantime).

- [ ] **Step 4: Verify the full CI + CodeQL state after push**

Run: `git push` (if the branch is not pushed), then `gh run list --branch main --limit 5`
Expected: the most recent run on main is green. CodeQL's next main run should show the analysis drop to the residual, intentionally-accepted alerts only (e.g. `js/file-system-race` TOCTOU warnings in `src/tools/executors.ts`, `js/insufficient-password-hash` HMAC compare in `auth.ts`/`auth-api.ts`, `js/incomplete-sanitization` in `secrets/store.ts` — all documented as low-risk in the deep-check review).

---

## Deferred Items (explicitly out of scope, tracked in the review)

The deep-check review also identified low-risk findings that this plan intentionally defers; each is documented, has no attacker-reachable impact today, and would be its own follow-up plan:

- **TOCTOU stat-then-read races** (CodeQL `js/file-system-race`: `src/tools/executors.ts` #26/45/46/47, `src/dashboard-server/live.ts` #22/24/64, `src/secrets/store.ts` #34/79/80) — reads inside a sandboxed single-agent workspace; the actor is the agent itself. Fix pattern (try/catch reads, open-then-fstat) is mechanical if desired later.
- **`stripHtml` entity double-decode** (`src/tools/web.ts` #41/42/43/44) — output is LLM text and React-escaped dashboard logs; no XSS sink exists. Harden with single-pass entity decoding if web tool output ever renders as HTML.
- **HMAC-with-zero-key timing compare** (`auth.ts` #4/#5, `auth-api.ts` #2/#3) — legitimate constant-time pattern; CodeQL flags it. Optional improvement: per-process random compare key.
- **Webhook URL SSRF** (`src/notifications/webhooks.ts` #62) — admin-only registration with signed payloads; accepted risk.

## Final Verification

- [ ] Run `npm run typecheck && npm run typecheck:tests && npm run lint && npm test` — all green.
- [ ] `gh pr list --state open` — empty.
- [ ] CodeQL re-scan on main shows no new alerts and the expected residual set.

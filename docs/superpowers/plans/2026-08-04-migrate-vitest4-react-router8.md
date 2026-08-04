# Migrate Vitest 2→4 and React Router 7→8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `src/dashboard-client` test infra from vitest 2.1.x to 4.1.x and routing from react-router-dom 7.18.x to react-router 8.3.x with zero behavior change, clearing two deferred items from `docs/superpowers/plans/2026-08-04-dependency-upgrade.md` (Addendum).

**Architecture:** Both migrations are confined to `src/dashboard-client` (its own package.json + lockfile + node_modules). The root repo uses node:test + tsx and is untouched except for the `engines` floor. Vitest first (test infra), then react-router (source + test imports) — each task ends with the existing 86-test suite green. Verified export surface research:
- `react-router-dom` has NO v8 (latest = 7.18.2). v8 ships as `react-router` (core) + `react-router/dom` (only `RouterProvider`, `HydratedRouter`, RSC internals — not used here). `BrowserRouter`, `Routes`, `Route`, `Link`, `NavLink`, `MemoryRouter`, `useNavigate`, `useLocation`, `useParams` are ALL in the core `react-router` entry (verified against react-router@8.3.0 `dist/production/index.d.ts` and `dom-export.d.ts`).
- vitest@4.1.10 peer-depends on `vite ^6 || ^7 || ^8` (project: vite 8.1.5 ✓), needs Node ≥ 20 (env: v26.5.0 ✓).

**Tech Stack:** npm 11+ (`allowScripts`), vitest 4 (jsdom env, globals, no coverage config), React 19.2.7, Vite 8.1.5, TypeScript 5.6 (dashboard tsconfig), ESM-only react-router 8.

## Global Constraints

- Exact target versions: `vitest ^4.1.10`, `@testing-library/jest-dom ^6.9.1` (stay on major 6 — proven with vitest 4; the 6→7 jest-dom bump stays deferred), `react-router ^8.3.0`, remove `react-router-dom`.
- Do NOT bump jsdom (stays `^25.0.0`) or TypeScript — held back per prior plan; only escalate if tests fail (contingency).
- No source behavior changes — pure dependency + import-specifier migration. No new tests needed: the existing 23-file/86-test suite is the verification (Nav/ScrollToTop/Catalog/Home/Login/RunDetail tests render through `MemoryRouter`, so they exercise the new router imports).
- Every task gate: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test`.
- Root repo code (`src/`) untouched; only root `package.json` `engines` floor changes.
- Baseline (verified 2026-08-04): `npm --prefix src/dashboard-client test` → 23 files, 86 tests, all pass.

---

### Task 1: Vitest 2 → 4 (deps + config + allowScripts)

**Files:**
- Modify: `src/dashboard-client/package.json` (devDependencies `vitest`, `@testing-library/jest-dom`; `allowScripts` esbuild entry)
- Modify: `src/dashboard-client/vitest.config.ts` (restore `dist` exclude — vitest 4 narrowed default excludes to `node_modules` + `.git` only)
- Test: `npm --prefix src/dashboard-client test`, `npm --prefix src/dashboard-client run typecheck`, `npm --prefix src/dashboard-client run build`

**Interfaces:**
- Consumes: current `vitest@2.1.9` (via `vite@5` + `esbuild@0.21.5` bundled), `@testing-library/jest-dom@6.x`, vite 8.1.5.
- Produces: `vitest@4.1.10` (bundles its own `vite@^6||^7||^8`; prunes esbuild 0.21.5), jest-dom 6.9.1, vitest 4 config with `configDefaults.exclude` + `**/dist/**`.

**Context:** No snapshot tests, no coverage config, no `vi.hoisted`/constructor spies, no third-arg test options — none of vitest 4's removed APIs are used. `vi.mock` factories and `vi.fn`/`vi.importActual` patterns in `tests/` are v4-compatible. No test code changes are expected.

- [ ] **Step 1: Bump vitest + jest-dom**

```bash
npm --prefix src/dashboard-client install -D vitest@^4.1.10 @testing-library/jest-dom@^6.9.1
```

Expected: install completes. If npm prompts to approve the install script of the newly resolved esbuild version (e.g. `esbuild@0.28.1`), add `"esbuild@<resolved-version>": true` to `allowScripts` in `src/dashboard-client/package.json`, remove the now-stale `"esbuild@0.21.5": true` entry, and re-run the install. Confirm with `npm --prefix src/dashboard-client ls esbuild` that exactly one esbuild (0.27.x or 0.28.x) remains.

- [ ] **Step 2: Update vitest.config.ts**

Replace the file content with (changes: `configDefaults` import + `exclude`):

```ts
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

- [ ] **Step 3: Verify the suite runs on vitest 4**

```bash
npm --prefix src/dashboard-client test
```

Expected: 23 files, 86 tests, all pass (vitest 4 banner in output).

- [ ] **Step 4: Verify typecheck + build**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build
```

Expected: both pass. If build/test throw jsdom-environment errors, bump `jsdom` `^25.0.0` → `^26.0.0` (vitest 4 peer is `jsdom: '*'`; escalate only if needed).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json src/dashboard-client/vitest.config.ts
git commit -m "chore(deps): vitest 2->4 (resolves esbuild advisory under bundled vite 5)"
```

---

### Task 2: react-router-dom 7 → react-router 8 (import swap + package swap)

**Files:**
- Modify: `src/dashboard-client/package.json` (remove `react-router-dom`, add `react-router`)
- Modify: 23 import lines across 14 source files + 9 test files (list below)
- Test: full suite (MemoryRouter-based tests are the migration check), typecheck, build

**Interfaces:**
- Consumes: current `react-router-dom@7.18.2` (re-exports from `react-router@7`).
- Produces: `react-router@8.3.0`; all imports now resolve to the core entry. Also clears deferred advisory GHSA-qwww-vcr4-c8h2 (high, affects react-router-dom 7.12.0–8.2.0; fixed in react-router 8.3.0).

**File list (all are a single import-line change `'react-router-dom'` → `'react-router'`):**

Source (named exports unchanged in v8 core):
1. `src/App.tsx` — `BrowserRouter, Routes, Route`
2. `src/components/Launcher.tsx` — `useNavigate`
3. `src/components/CommandPalette.tsx` — `useNavigate`
4. `src/components/Nav.tsx` — `NavLink`
5. `src/components/ScrollToTop.tsx` — `useLocation`
6. `src/components/ui/Breadcrumb.tsx` — `Link, useLocation`
7. `src/pages/Home.tsx` — `Link`
8. `src/pages/Comparisons.tsx` — `Link`
9. `src/pages/RunDetail.tsx` — `useParams`
10. `src/pages/Dashboard.tsx` — `Link`
11. `src/pages/ModelDetail.tsx` — `useParams`
12. `src/pages/NotFound.tsx` — `Link`
13. `src/pages/Catalog.tsx` — `useNavigate`
14. `src/pages/Login.tsx` — `useNavigate`

Tests:
15. `tests/pages/Catalog.test.tsx` — `MemoryRouter`
16. `tests/pages/Home.test.tsx` — `MemoryRouter`
17. `tests/pages/Login.test.tsx` — `MemoryRouter`
18. `tests/pages/RunDetail.test.tsx` — `MemoryRouter, Route, Routes`
19. `tests/pages/Scenarios.test.tsx` — `MemoryRouter`
20. `tests/components/ui/Nav.test.tsx` — `MemoryRouter`
21. `tests/components/ui/CommandPalette.test.tsx` — `MemoryRouter`
22. `tests/components/ui/PageShell.test.tsx` — `MemoryRouter`
23. `tests/components/ui/ScrollToTop.test.tsx` — `MemoryRouter`

- [ ] **Step 1: Swap the dependency**

```bash
npm --prefix src/dashboard-client uninstall react-router-dom
npm --prefix src/dashboard-client install react-router@^8.3.0
```

Expected: `react-router-dom` removed from package.json/lockfile; `react-router@8.3.0` added as a direct dependency.

- [ ] **Step 2: Swap all import specifiers**

```bash
grep -rl "react-router-dom" src tests | xargs sed -i "s/react-router-dom/react-router/g"
```

- [ ] **Step 3: Confirm zero stale references**

```bash
grep -rn "react-router-dom" src tests package.json || echo CLEAN
```

Expected: `CLEAN`. Also confirm the only import from `react-router/dom` would be `RouterProvider`/`HydratedRouter` — this app uses neither, so no `react-router/dom` imports should exist.

- [ ] **Step 4: Verify full gate**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: all pass — 23 files / 86 tests, including the 9 MemoryRouter-based tests that render the migrated router imports. If a type error appears, it is an API-surface drift in v8; fix the type, never cast to `any`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json src/dashboard-client/src src/dashboard-client/tests
git commit -m "chore(deps): react-router 8 — drop react-router-dom (clears GHSA-qwww-vcr4-c8h2)"
```

---

### Task 3: Bump engine floor for react-router 8

**Files:**
- Modify: `package.json` (root, `engines`)

**Interfaces:**
- Consumes: root `engines.node = ">=22.0.0"` (currently misleading — react-router 8 requires ≥ 22.22.0).
- Produces: `engines.node = ">=22.22.0"`.

**Context:** react-router 8 requires Node ≥ 22.22.0. Dev/CI already satisfy it: local node v26.5.0; GitHub Actions `node-version: 22` and `Dockerfile` `node:22-bookworm-slim` both float to the latest 22.x (≥ 22.22). No CI/Dockerfile changes needed — the floor bump makes the requirement explicit and blocks older local environments.

- [ ] **Step 1: Bump the engines field**

In root `package.json`:

```json
"engines": {
  "node": ">=22.22.0"
}
```

- [ ] **Step 2: Verify root still passes**

```bash
npm run typecheck && npm run lint
```

Expected: PASS (root `src/` is untouched by this migration).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump engines to >=22.22.0 (react-router 8 floor)"
```

---

### Task 4: Final full verification

**Files:** none modified.
**Test:** all gates.

- [ ] **Step 1: Dashboard gate (repeat for certainty after all commits)**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: all pass; 23 files / 86 tests green.

- [ ] **Step 2: Root gate**

```bash
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 3: Confirm resolved versions and stale deps**

```bash
npm --prefix src/dashboard-client ls vitest react-router react-router-dom esbuild
npm --prefix src/dashboard-client audit --audit-level=high
```

Expected: `vitest@4.1.10`, `react-router@8.3.0`, no `react-router-dom` line, single esbuild 0.27+/0.28+; audit shows no high-severity findings (the deferred esbuild/drizzle-kit chain in the ROOT lockfile remains documented-accepted; the dashboard's esbuild 0.21.5 chain is gone with vitest 2).

- [ ] **Step 4: Working tree clean**

```bash
git status --porcelain
```

Expected: clean (all lockfiles committed in their tasks).

---

## Self-Review

- **Spec coverage:** vitest 2→4 (Task 1), react-router 7→8 (Task 2), engine floor (Task 3), verification (Task 4). Both deferred addendum items addressed: esbuild moderate under vitest 2's bundled vite 5 resolved by Task 1; GHSA-qwww-vcr4-c8h2 resolved by Task 2. ✓
- **Placeholder scan:** No TBDs; every step has exact commands and expected output; vitest.config.ts is given in full. ✓
- **Type consistency:** All 14 source + 9 test files verified via grep for the exact `react-router-dom` import lines; every named export used (`BrowserRouter`, `Routes`, `Route`, `Link`, `NavLink`, `MemoryRouter`, `useNavigate`, `useLocation`, `useParams`) confirmed present in react-router@8.3.0 core entry from the published `dist/production/index.d.ts`; `react-router/dom` confirmed to contain only `RouterProvider`/`HydratedRouter`/RSC exports (none used). vitest@4.1.10 `vite` peer range `^6||^7||^8` verified against installed vite 8.1.5. jest-dom 6.9.1 chosen over 7.0.0 to honor the prior plan's "held back" decision while retaining vitest 4 support (proven combo — react-router's own devDeps). ✓

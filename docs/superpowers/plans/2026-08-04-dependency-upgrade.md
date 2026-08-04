# Dependency Upgrade + Security Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear all npm audit findings and bring every outdated package in the root and `src/dashboard-client` workspaces to latest, with majors handled deliberately.

**Architecture:** Two workspaces: root (Node/Express/queue/runner) and `src/dashboard-client` (React SPA, own package.json + package-lock.json, own node_modules). Root first, then dashboard. Each task: bump → install → verify (typecheck/lint/test/build/audit) → commit.

**Tech Stack:** npm (single workspace per dir — no npm workspaces config, but both dirs have independent lockfiles), Node >= 22, TypeScript strict, drizzle-kit, ioredis, OTel SDK, React 19 + Vite 8.

## Global Constraints

- Node >= 22.0.0, npm supports `overrides` (>= 8.3) and `allowScripts` (npm 11+).
- Every verification gate: `npm run typecheck && npm run lint && npm test && npm run build` at root, and `npm run typecheck && npm run build && npm test` in `src/dashboard-client`.
- `npm audit --audit-level=high --production` (root `audit` script) MUST pass at the end.
- OTel packages (`@opentelemetry/sdk-node`, `exporter-trace-otlp-http`, `instrumentation-http`) must be bumped in lockstep to `0.221.0`, and `@opentelemetry/resources` to `2.10.0` in the same commit.
- `drizzle-kit` stays on `0.31.10` (latest stable). Do NOT install `1.0.0-rc.x`. Do NOT accept npm audit's "downgrade to 0.18.1" suggestion — it is bogus (0.18.1 is an OLDER major).
- ioredis 6 upgrade MUST set `protocol: 2` in the constructor (RESP3 is the new default; we keep the v5 wire protocol for behavior parity). Revisit RESP3 later as a separate decision.
- All packages with build scripts (`argon2`, `better-sqlite3`, `esbuild`) need their new exact versions added to the `allowScripts` map in root `package.json` or installs will silently skip scripts.
- `npm audit` fix for `brace-expansion`/`ip-address` relies on semver ranges already permitting the fixed versions — plain `npm update` is sufficient; never force-install.
- Initial `npm install` in `src/dashboard-client` is required (node_modules not present).

---

### Task 1: Root in-range updates (fixes brace-expansion + ip-address vulnerabilities)

**Files:**
- Modify: `package.json` (only via npm, no hand edits)
- Modify: `package-lock.json` (via npm)
- Test: `npm audit`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`

**Interfaces:**
- Consumes: current root package.json (versions listed in Global Constraints context).
- Produces: updated lockfile where `brace-expansion` = 5.0.9, `ip-address` = 10.4.0; in-range bumps for: `@aws-sdk/client-bedrock-runtime` → 3.1102.0, `@aws-sdk/credential-provider-node` → 3.972.77, `argon2` → 0.45.1, `better-sqlite3` → 13.0.2, `cron-parser` → 5.7.0, `eslint` → 10.8.0, `express-rate-limit` → 8.6.1, `tsx` → 4.23.5, `ws` → 8.21.2, `@types/node` → 26.1.2, `@types/pg` → 8.20.3, `@typescript-eslint/*` → 8.66.0.

- [ ] **Step 1: Run npm update**

```bash
npm update
```

Expected: installs complete, lockfile updated. `brace-expansion` resolves to 5.0.9 (eslint → minimatch range `^5.0.8`), `ip-address` resolves to 10.4.0 (socks@2.8.9 `^10.1.1` and express-rate-limit `^10.2.0` both allow it).

- [ ] **Step 2: Update allowScripts for rebuilt native deps**

`better-sqlite3@13.0.1` → `13.0.2` and `argon2@0.45.0` → `0.45.1` in `package.json` `allowScripts`. If npm warns the old entries are stale, remove them.

```bash
npm pkg set 'allowScripts.better-sqlite3@13.0.2=true' 'allowScripts.argon2@0.45.1=true' --package-lock-only=false
```

- [ ] **Step 3: Verify audit cleared the two high-severity findings**

Run: `npm audit --audit-level=high`
Expected: no high-severity output. Remaining finding (if any) is only the moderate esbuild/drizzle-kit chain — handled in Task 2.

- [ ] **Step 4: Verify gates**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Expected: all pass. If `npm test` requires services (Redis/Postgres), run `npm run test:ci` or the sqlite-only subset and note skipped services.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): npm update — fix brace-expansion and ip-address advisories"
```

---

### Task 2: Resolve or accept the esbuild/drizzle-kit moderate advisory

**Files:**
- Modify: `package.json` (add `overrides` block; update `allowScripts`)
- Test: `npm audit`, `npm run db:generate`, `npm run typecheck`

**Interfaces:**
- Consumes: Task 1 lockfile.
- Produces: decision recorded — either (A) `overrides` forcing esbuild ≥ 0.25 under `@esbuild-kit/core-utils`, or (B) a documented accepted-risk entry in the commit message.

**Context:** `drizzle-kit@0.31.10` → `@esbuild-kit/esm-loader@2.6.5` → `@esbuild-kit/core-utils@3.3.2` (last publish, unmaintained) pins `esbuild ~0.18.20`. Advisory GHSA-67mh-4wv8-2f99 (<= 0.24.2) is a dev-server SSRF — only exploitable via esbuild's `--serve` mode, which nothing here runs (drizzle-kit uses esbuild's transform API to load TS migrations).

- [ ] **Step 1: Attempt the scoped override (Option A)**

Add to `package.json`:

```json
"overrides": {
  "@esbuild-kit/core-utils": {
    "esbuild": "^0.25.4"
  }
}
```

Then: `npm install`

- [ ] **Step 2: Verify drizzle-kit still works with the override**

```bash
npm run db:generate && npm audit --audit-level=moderate
```

Expected: `db:generate` produces no errors and audit is clean. Add `esbuild@0.25.4` (exact resolved version) to `allowScripts` if npm asks.

- [ ] **Step 3: Fallback — Option B if Step 2 fails (esbuild-kit incompatible)**

If `db:generate` errors under the override, remove the `overrides` block, `npm install`, and document in the commit:

```text
Accepted risk: GHSA-67mh-4wv8-2f99 (moderate, dev-only, esbuild dev server).
drizzle-kit@0.31.10 bundles esbuild 0.18.x via unmaintained @esbuild-kit;
esbuild --serve is never invoked; root `npm audit --production` script is unaffected.
Revisit when drizzle-kit 1.x stable lands (uses esbuild ^0.25.4 directly).
```

Verify `npm run db:generate` works again after rollback.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): pin esbuild >=0.25 under @esbuild-kit to clear moderate advisory (or document accepted risk)"
```

---

### Task 3: ioredis 5 → 6 (RESP3 default change)

**Files:**
- Modify: `package.json` (`"ioredis": "^5.11.1"` → `"^6.0.0"`)
- Modify: `src/queue/redis.ts:16` (add `protocol: 2` to constructor options)
- Test: `npm run typecheck`, `npm test`, `tests/queue/redis.test.ts`

**Interfaces:**
- Consumes: `RedisStreamQueue` constructor signature (unchanged).
- Produces: `new Redis(config.url, { ...options, protocol: 2 })`.

**Context:** ioredis 6.0.0 (2026-07-31): requires Node >= 20 (we're on 22 — OK), RESP3 by default. All command APIs are backward-compatible; `protocol: 2` retains the exact v5 wire behavior. Deps unchanged (debug, denque, redis-errors, cluster-key-slot, @ioredis/commands, standard-as-callback).

- [ ] **Step 1: Bump the version range**

```bash
npm install ioredis@^6.0.0
```

- [ ] **Step 2: Pin the wire protocol in the constructor**

In `src/queue/redis.ts`, find the constructor options object passed to `new Redis(config.url, { ... })` and add `protocol: 2,`. Example result:

```ts
this.redis = new Redis(config.url, {
  ...(baseOptions),
  protocol: 2,
});
```

(Adapt to the actual option object already present — do not change any other options.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm test
```

Expected: typecheck passes (ioredis ships its own types); `tests/queue/redis.test.ts` passes against a live Redis if available, otherwise full `npm run test:ci` minus the redis-dependent suite.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/queue/redis.ts
git commit -m "chore(deps): ioredis 6 — keep RESP2 wire protocol via protocol:2"
```

---

### Task 4: @types/better-sqlite3 7 → 9 (align with runtime 13.x)

**Files:**
- Modify: `package.json` (`"@types/better-sqlite3": "^7.6.13"` → `"^9.6.0"`)
- Test: `npm run typecheck`

**Interfaces:**
- Consumes: existing better-sqlite3 usage in `src/session/store.ts` etc.
- Produces: typecheck-clean result against types for runtime 13.x.

**Context:** `@types/better-sqlite3@9.6.0` realigns the types versioning with the runtime major (13.0.2 installed). Expect possible small signature changes (e.g., `Statement` generics, `Database.prototype.prepare`).

- [ ] **Step 1: Bump and install**

```bash
npm install -D @types/better-sqlite3@^9.6.0
```

- [ ] **Step 2: Typecheck and fix drift**

```bash
npm run typecheck
```

Expected: PASS. If errors appear, fix by adjusting types in the calling code (e.g., explicit generics on `prepare<T>()`), not by casting to `any`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): @types/better-sqlite3 9.x to match runtime 13"
```

---

### Task 5: OTel package lockstep bump to 0.221.0 / 2.10.0

**Files:**
- Modify: `package.json` — `@opentelemetry/exporter-trace-otlp-http` `^0.220.0` → `^0.221.0`, `@opentelemetry/instrumentation-http` `^0.220.0` → `^0.221.0`, `@opentelemetry/sdk-node` `^0.220.0` → `^0.221.0`, `@opentelemetry/resources` `^2.9.0` → `^2.10.0`
- Test: `npm run typecheck`, `npm run build`

**Interfaces:**
- Consumes: existing OTel init code (wherever `NodeSDK` is constructed).
- Produces: synchronized 0.221.0 stack (these packages must never mix versions).

- [ ] **Step 1: Bump all four in one install**

```bash
npm install @opentelemetry/exporter-trace-otlp-http@^0.221.0 @opentelemetry/instrumentation-http@^0.221.0 @opentelemetry/sdk-node@^0.221.0 @opentelemetry/resources@^2.10.0
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck && npm run build
```

Expected: PASS. Also confirm no other `@opentelemetry/*` 0.220.x remains: `npm ls @opentelemetry | grep 0.220` → no output.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump OTel SDK stack to 0.221.0 (resources 2.10.0)"
```

---

### Task 6: Dashboard client — install + in-range updates

**Files:**
- Modify: `src/dashboard-client/package.json` (via npm only)
- Modify: `src/dashboard-client/package-lock.json` (via npm)
- Test: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test`

**Interfaces:**
- Consumes: `src/dashboard-client/package.json` + existing lockfile; node_modules absent — must install first.
- Produces: fresh node_modules; in-range bumps: `@codemirror/lang-javascript` → 6.2.5, `@tanstack/react-query` → 5.101.4, `@uiw/react-codemirror` → 4.25.11, `class-variance-authority` → 0.7.1, `clsx` → 2.1.1, `tailwind-merge` → 3.6.0, `react`/`react-dom` → 19.2.8.

- [ ] **Step 1: Install from lockfile, then update**

```bash
npm --prefix src/dashboard-client ci && npm --prefix src/dashboard-client update
```

Expected: install + update complete with no peer conflicts (echarts-for-react peer range permits echarts ^6 — Task 7).

- [ ] **Step 2: Verify dashboard gates**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: all pass (vitest, jsdom).

- [ ] **Step 3: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): dashboard in-range updates (react 19.2.8, react-query 5.101.4)"
```

---

### Task 7: Dashboard — echarts 5 → 6

**Files:**
- Modify: `src/dashboard-client/package.json` (`"echarts": "^5.5.0"` → `"^6.1.0"`)
- Possibly fix: `src/dashboard-client/src/components/ui/{Heatmap,LineChart,Sankey,Sparkline,StackedBar}.tsx`
- Test: `npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test`

**Interfaces:**
- Consumes: `ReactECharts` from `echarts-for-react@3.0.6` (peer range `echarts: ^3||^4||^5||^6` — verified compatible).
- Produces: echarts 6.1.0 with all five chart components rendering (option API is stable; deprecated series/features removed).

**Context:** echarts 6 breaking changes are mostly removed deprecated APIs and the default import of individual charts (tree-shaking default unchanged for echarts-for-react full import). The 5 chart components use standard `series` options (`line`, `bar`, `heatmap`, `sankey`, `scatter`) — all retained in v6.

- [ ] **Step 1: Bump and install**

```bash
npm --prefix src/dashboard-client install echarts@^6.1.0
```

- [ ] **Step 2: Build + test**

```bash
npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: PASS. If a chart option type errors, fix the option literal (v6 tightened option typings) — do not add `any` casts.

- [ ] **Step 3: Manual smoke (optional but recommended)**

`npm --prefix src/dashboard-client run dev` and open the dashboard — confirm charts render on Dashboard / ModelDetail / RunDetail pages.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json src/dashboard-client/src
git commit -m "chore(deps): echarts 6 (supported by echarts-for-react 3)"
```

---

### Task 8: Dashboard — lucide-react 0.456 → 1.x

**Files:**
- Modify: `src/dashboard-client/package.json` (`"lucide-react": "^0.456.0"` → `"^1.28.0"`)
- Test: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build`

**Interfaces:**
- Consumes: icons in use — `ChevronDown, ChevronRight, Eye, EyeOff, Menu, X, Plus, Pencil, Trash2, Search` (all current names, stable in 1.x).
- Produces: lucide-react 1.28.0; build-time named-export validation catches any renamed icon.

- [ ] **Step 1: Bump and install**

```bash
npm --prefix src/dashboard-client install lucide-react@^1.28.0
```

- [ ] **Step 2: Verify all icon imports resolve**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build
```

Expected: PASS (rollup emits error for missing named exports; typecheck covers the import paths).

- [ ] **Step 3: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): lucide-react 1.x"
```

---

### Task 9: Dashboard — react-router-dom 6 → 7

**Files:**
- Modify: `src/dashboard-client/package.json` (`"react-router-dom": "^6.27.0"` → `"^7.18.2"`)
- Test: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test`

**Interfaces:**
- Consumes: API surface in use — `BrowserRouter, Routes, Route` (App.tsx), `useNavigate` (4 files), `Link` (5 files), `NavLink`, `useParams` (2), `useLocation` (2). All unchanged in v7 library mode.
- Produces: react-router-dom 7.18.2, no code changes expected.

**Context:** v7 library mode is a v6 continuation; breaking changes affect data-router features (loaders/actions) and removed `v6_*` future flags, none of which this SPA uses. Requires React >= 18 — we have 19.2.8.

- [ ] **Step 1: Bump and install**

```bash
npm --prefix src/dashboard-client install react-router-dom@^7.18.2
```

- [ ] **Step 2: Verify**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: all pass. If any import moved (e.g., a deprecated re-export), fix imports per v7 docs — expected surface is untouched.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): react-router-dom 7 (library mode, API surface unchanged)"
```

---

### Task 10: Final full verification

**Files:** none modified.
**Test:** all gates.

- [ ] **Step 1: Root audit — expect clean**

```bash
npm audit --audit-level=high && npm audit
```

Expected: zero high/critical; either zero total (if Task 2 Option A applied) or only the documented moderate esbuild/drizzle-kit dev chain (Option B).

- [ ] **Step 2: Root CI suite**

```bash
npm run test:ci
```

Expected: typecheck + lint + coverage + db tests all pass (needs local SQLite; Postgres smoke only if `docker compose up -d` running).

- [ ] **Step 3: Dashboard suite**

```bash
npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run build && npm --prefix src/dashboard-client test
```

Expected: all pass.

- [ ] **Step 4: Confirm nothing stale remains**

```bash
npm outdated && npm --prefix src/dashboard-client outdated
```

Expected: only `ioredis` (if pinned protocol accepted — actually should show nothing) — expected output: empty or only packages intentionally held back (list them).

- [ ] **Step 5: Final commit if any straggler files remain**

```bash
git status --porcelain
```

Expected: clean. If not, commit remaining lockfile diffs.

---

## Self-Review

- **Spec coverage:** All 6 audit findings addressed — brace-expansion + ip-address (Task 1), esbuild/drizzle-kit (Task 2), ioredis/OTel/types majors (Tasks 3–5), dashboard majors (Tasks 7–9), plus all 16 root + 12 dashboard outdated entries (Tasks 1, 5, 6). ✓
- **Placeholder scan:** No TBDs; every step has exact commands/expected output. The one code block (`src/queue/redis.ts`) is a partial snippet by necessity — it instructs adapting to the existing options object, with the exact property to add. ✓
- **Type consistency:** `protocol: 2` (ioredis 6 `RedisOptions.protocol` accepts `2 | 3`), `echarts-for-react@3.0.6` peer `^6.0.0` verified via registry, OTel versions verified as published (0.221.0 / 2.10.0), lucide icon names verified in source. ✓

---

## Addendum (execution findings)

- **Deferred (user decision):** `react-router-dom@7.18.2` is affected by GHSA-qwww-vcr4-c8h2 (high, RSC-mode CSRF bypass, affects 7.12.0–8.2.0). Fixed paths: downgrade to 7.11.0 or migrate imports to `react-router@8.3.0`. Skipped for now — the SPA uses library mode without RSC/actions, so it is not exploitable here. Revisit before any router-feature work.
- **Deferred (user decision):** esbuild moderate (GHSA-67mh-4wv8-2f99) nested under vitest@2.1.9's bundled vite@5 in `src/dashboard-client` — dev/test-only; esbuild `--serve` never invoked. Fix would require vitest 2→4 major. Accepted as documented dev-only risk.
- **Fixed in-execution:** pre-existing flaky dashboard test (`useApiMutation` `isSuccess` timing) de-flaked with `waitFor`.
- **Held back (out of scope):** dashboard dev-tooling majors — `vitest` 2.1.9→4.1.10, `jsdom` 25→30, `@testing-library/jest-dom` 6→7, `typescript` 5.9.3→7.0.2 (dashboard pins TS ^5.6.3; root already aliases 6/7 separately). All test-infra only; re-evaluate separately.

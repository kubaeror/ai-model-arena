# Dependency Refresh 2026-09 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every outdated dependency in the repo (npm root + dashboard client, GitHub Actions, Docker base image, compose/k8s infra images) to the newest available version, and supersede all 22 open Dependabot PRs with one consolidated branch.

**Architecture:** Single feature branch `chore/dependency-refresh-2026-09`, one commit per phase. Each phase ends with its own verification gate. Majors are isolated so any failure is revertable without losing the rest.

**Tech Stack:** npm (lockfiles at root + `src/dashboard-client`), GitHub Actions (SHA-pinned), Docker (multi-stage Dockerfile + compose), k8s manifests (kustomize), node:test + Vitest, Playwright e2e.

## Global Constraints

- Node floor: `engines.node >= 22.22.0` (root `package.json:33`). Local Node v24.20.0.
- Every version bump updates BOTH `package.json` AND its `package-lock.json` via `npm install` — never hand-edit lockfiles.
- `allowScripts` pins must stay in sync with resolved exact versions (esbuild override bump requires `allowScripts.esbuild@0.28.2`).
- Never touch: `configs/scenarios/templates/express-rest/` (benchmark content), `.agents/`, `.opencode/`, `node_modules`.
- Commit convention: `chore(deps): <scope> ...` / `ci: ...`.
- Dependabot SHAs: fetch from `gh pr diff <n>` or `gh api repos/<repo>/git/ref/tags/<tag>` — never guess.
- codeql `init` and `analyze` must always be bumped together to the same version.

---

### Task 0: Baseline verification

**Files:** none (read-only)

- [ ] **Step 1: Confirm root gates green before touching anything**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 2: Confirm dashboard gates green**

Run: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build`
Expected: all pass.

- [ ] **Step 3: Create the branch**

```bash
git checkout -b chore/dependency-refresh-2026-09
```

### Task 1: Root npm bumps (direct + transitive + esbuild override)

**Files:**
- Modify: `package.json` (dependencies + devDependencies + overrides + allowScripts)
- Modify: `package-lock.json` (via `npm install`)

**Bumps:**
- deps: `@kubernetes/client-node ^2.0.0`, `@opentelemetry/exporter-metrics-otlp-http ^0.222.0`, `@opentelemetry/exporter-trace-otlp-http ^0.222.0`, `@opentelemetry/instrumentation-http ^0.222.0`, `@opentelemetry/resources ^2.11.0`, `@opentelemetry/sdk-metrics ^2.11.0`, `@opentelemetry/sdk-node ^0.222.0`, `cron-parser ^5.10.1`, `js-yaml ^5.4.2`, `pg ^8.23.0`, `ws ^8.21.3`, `zod ^4.6.4`
- devDeps: `@playwright/test ^1.63.0`, `@types/node ^26.5.1`, `@typescript-eslint/eslint-plugin ^8.70.0`, `@typescript-eslint/parser ^8.70.0`, `concurrently ^10.0.5`, `eslint ^10.10.0`
- overrides: `esbuild 0.28.2`; allowScripts: replace `"esbuild@0.28.1": true` with `"esbuild@0.28.2": true`

- [ ] **Step 1: Edit `package.json` with the bumps above**
- [ ] **Step 2: Install + within-range transitive refresh**

Run: `npm install && npm update`
Expected: no ERESOLVE. If npm asks to approve a script for a new exact version (e.g. esbuild@0.28.2), add it to `allowScripts` and re-run.

- [ ] **Step 3: Verify `npm outdated` shows only the documented TS hold (root: none expected)**
- [ ] **Step 4: Gate: `npm run typecheck && npm run lint && npm test && npm run test:coverage && npm run test:db && npm run audit`**
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): refresh root npm deps (k8s client 2.0, otel 0.222/2.11, zod 4.6, esbuild override 0.28.2)"
```

### Task 2: Kubernetes client v2 route migration (only if typecheck requires)

**Files:**
- Modify (only if needed): `src/dashboard-server/routes/secrets.ts`, `src/dashboard-server/routes/runners.ts`
- Test: `tests/dashboard/**`

v2 breaking changes: node-fetch → undici, Node 18/20/23 dropped, regenerated for k8s 1.36. Usage is object-style `makeApiClient` / `readNamespaced*` / `patchNamespaced*` / `setHeaderOptions` — likely source-compatible.

- [ ] **Step 1: Run `npm run typecheck`. If it fails, fix the two route files minimally per the v2 type errors.**
- [ ] **Step 2: Gate: `npm test -- tests/dashboard/` (or full `npm test`) + `npm --prefix src/dashboard-client run test` if client types are affected**
- [ ] **Step 3: If changes were required, commit**

```bash
git add src/dashboard-server/routes/
git commit -m "fix(dashboard): adapt k8s routes to @kubernetes/client-node 2.0"
```

### Task 3: Dashboard client npm bumps

**Files:**
- Modify: `src/dashboard-client/package.json`
- Modify: `src/dashboard-client/package-lock.json`

**Bumps:**
- deps: `@tanstack/react-query ^5.102.8`, `react ^19.3.0`, `react-dom ^19.3.0`, `react-router ^8.3.1`, `tailwind-merge ^3.7.0`
- devDeps: `@testing-library/jest-dom ^7.0.1`, `@testing-library/react ^16.3.3`, `@testing-library/user-event ^14.6.7`, `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`, `@typescript-eslint/eslint-plugin ^8.70.0`, `@typescript-eslint/parser ^8.70.0`, `@vitejs/plugin-react ^6.1.1`, `eslint ^10.10.0`, `vitest ^5.0.0`
- Hold: `typescript ^5.6.3` (resolves 5.9.3; TS6/7 violates `@typescript-eslint@8` peer `<6.1.0`). Add a one-line comment? No comments in JSON — document in final report only.

- [ ] **Step 1: Edit `src/dashboard-client/package.json`**
- [ ] **Step 2: `npm install --prefix src/dashboard-client && npm update --prefix src/dashboard-client`**
- [ ] **Step 3: Gate: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run lint && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build`**
- [ ] **Step 4: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): refresh dashboard client deps (react 19.3, vitest 5, eslint 10.10)"
```

### Task 4: GitHub Actions bumps

**Files:**
- Modify: `.github/workflows/codeql.yml` (init + analyze together → 4.37.8; SHA `db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28` for both)
- Modify: `.github/workflows/build-deploy.yaml` (buildx, qemu, upload-artifact, sbom)
- Modify: `.github/workflows/release.yaml` (buildx, qemu, upload-artifact x2, download-artifact, sbom, slsa)
- Modify: `.github/workflows/nightly.yaml` (buildx, upload-artifact)
- Modify: `.github/workflows/pr-checks.yaml` (upload-artifact x4, download-artifact, hadolint)

**Targets:** setup-buildx `v4.3.0`, setup-qemu `v4.3.0`, upload-artifact `v7.0.1`, download-artifact `v8.0.1`, anchore/sbom-action `v0.24.2`, hadolint/hadolint-action `v3.5.0`, slsa generator `v2.1.0`.

- [ ] **Step 1: Collect exact SHAs** — `gh pr diff 95`, `gh pr diff 81`, `gh pr diff 80`; for qemu/upload/sbom/hadolint use `gh api repos/<repo>/git/ref/tags/<tag> --jq .object.sha` (deref annotated tags via `/git/tags/<sha>` if needed).
- [ ] **Step 2: Apply replacements in all workflows (update the `# vX.Y.Z` comments too).**
- [ ] **Step 3: Validate**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/*.yaml`
Expected: no new errors.

- [ ] **Step 4: Verify codeql init/analyze SHAs are identical.**
- [ ] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: bump actions (codeql 4.37.8 paired, upload 7, download 8, buildx/qemu 4.3, sbom 0.24.2, hadolint 3.5, slsa 2.1.0)"
```

### Task 5: Dockerfile base image

**Files:**
- Modify: `Dockerfile` (3 × `FROM node:26.7.0-bookworm-slim` → `26.8.1`)

- [ ] **Step 1: Replace in all 3 stages.**
- [ ] **Step 2: Build**

Run: `docker build -t ai-arena/runner:node26 .`
Expected: succeeds through `npm audit` gate and runtime stage (native modules + audit proof).

- [ ] **Step 3: Smoke**

Run: `docker run --rm ai-arena/runner:node26 node -e "const db=require('better-sqlite3')(':memory:'); console.log(process.version, db.prepare('select 1 as x').get().x === 1 ? 'ok' : 'fail')"`
Expected: `v26.8.1 ok`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore(deps): bump Dockerfile base image to node 26.8.1-bookworm-slim"
```

### Task 6: Infra image parity (compose + k8s + CI)

**Files:**
- Modify: `docker-compose.yml` (postgres `18.6-alpine`; collector `0.160.0`; tempo `2.9.5`; prometheus `v3.14.0`; loki `3.7.7`; grafana `13.2.1`)
- Modify: `.github/workflows/build-deploy.yaml:36`, `.github/workflows/nightly.yaml:32` (postgres `18.6-alpine`)
- Modify: `k8s/observability/collector.yaml` (`0.160.0`), `tempo.yaml` (`2.9.5`), `loki.yaml` (`3.7.7`), `grafana.yaml` (`13.2.1`), `prometheus.yaml` (`v3.14.0`)
- Leave: `k8s/base/postgres.yaml` `postgres:18`, `k8s/base/redis.yaml` `redis:8`, compose `redis:8.10-alpine` (already latest), `pr-checks.yaml` `postgres:18-alpine` (floating)

- [ ] **Step 1: Apply version bumps.**
- [ ] **Step 2: Validate**

Run: `docker compose config -q && kubectl kustomize k8s/base > /tmp/k8s-base.yaml && kubectl kustomize k8s/overlays/dev > /tmp/k8s-dev.yaml`
Expected: exit 0.

- [ ] **Step 3: Optional runtime smoke (if time permits): `docker compose up -d otel-collector tempo prometheus loki grafana` then curl health endpoints; `docker compose down`.**
- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml k8s/ .github/workflows/
git commit -m "chore(deps): align compose/k8s infra images (collector 0.160, grafana 13.2.1, prometheus 3.14, loki 3.7.7, tempo 2.9.5, pg 18.6)"
```

### Task 7: Dependabot config hardening

**Files:**
- Modify: `.github/dependabot.yml`

- [ ] **Step 1: Add `open-pull-requests-limit: 10` to the github-actions and docker ecosystems** (default 5 caused the missed upload-artifact/qemu/sbom/hadolint bumps).
- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci: raise dependabot PR limits for actions/docker ecosystems"
```

### Task 8: Final verification + PR

**Files:** none (fix-ups only if a gate fails)

- [ ] **Step 1: Full root gates: `npm run test:ci`**
- [ ] **Step 2: Postgres integration (docker): `docker compose up -d postgres && npm run test:db-pg; docker compose stop postgres`**
- [ ] **Step 3: Dashboard gates + e2e: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build && npm run e2e`**
- [ ] **Step 4: `npm outdated` and `npm outdated --prefix src/dashboard-client` — expect empty except dashboard `typescript` (held back, documented).**
- [ ] **Step 5: Review `git log --oneline main..HEAD` and `git diff main...HEAD --stat`; confirm no vendor/template files touched.**
- [ ] **Step 6: Push + open PR**

```bash
git push -u origin chore/dependency-refresh-2026-09
gh pr create --title "chore(deps): 2026-09 dependency refresh" --body "Supersedes Dependabot #76-#111. See docs/superpowers/plans/2026-09-13-dependency-refresh.md"
```

- [ ] **Step 7 (post-merge, separate): close Dependabot PRs #76–#111 with a "Superseded by #<PR>" comment.**

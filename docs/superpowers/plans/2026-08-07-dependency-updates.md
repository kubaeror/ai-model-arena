# Dependency Refresh 2026-08 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every dependency in the repo (npm root + dashboard client, GitHub Actions, Docker base image, infra container images) to the newest version available online, resolving the 7 open dependabot PRs in one branch.

**Architecture:** Single feature branch `chore/dependency-updates-2026-08` with one commit per phase (patch bumps → CI actions → Dockerfile → majors → infra images). Each phase ends with its own verification gate. Phases 5/6 (dashboard majors) are try-and-rollback: keep the upgrade only if verification passes.

**Tech Stack:** npm (lockfiles at root + `src/dashboard-client`), GitHub Actions, Docker (multi-stage Dockerfile), docker-compose, k8s manifests, node:test runner.

## Global Constraints

- Never hardcode API keys or secrets (none needed — version-only changes).
- Node version floor: `engines.node >= 22.22.0` (root `package.json:33`).
- All package version bumps must update BOTH `package.json` AND the corresponding `package-lock.json` (run `npm install`, not manual lockfile edits).
- `better-sqlite3` bump requires `allowScripts` pin sync in root `package.json:90`.
- Verbatim dependency spec ("newest online" as of 2026-08-07):
  - Actions: docker/build-push-action v7.3.0, docker/setup-qemu-action v4.2.0, anchore/sbom-action v0.24.0, docker/setup-buildx-action v4.2.0, github/codeql-action v4.37.6 (init AND analyze)
  - Docker base: `node:26.7.0-bookworm-slim` (all 3 stages)
  - npm root patches: `@aws-sdk/client-bedrock-runtime@3.1105.0`, `@aws-sdk/credential-provider-node@3.972.78`, `@types/pg@8.20.4`, `express-rate-limit@8.6.2`, `tsx@4.23.10`, `better-sqlite3@13.0.3`
  - npm dashboard patches: `lucide-react@1.30.0`, `vite@8.2.1`; majors: `eslint@10.8.0`, `typescript@7.0.2`, `@testing-library/jest-dom@7.0.0`
  - Infra: postgres `18.4-alpine`/`18`, redis `8.10-alpine`/`8`, otel-collector-contrib `0.158.0`, grafana `13.1.3`, loki `3.7.6`, promtail `3.6.11`, tempo `2.9.4`, prometheus `v3.13.2`
- Sandbox template `configs/scenarios/templates/express-rest/` is benchmark content — do NOT touch.
- Vendor dirs (`.agents/`, `.opencode/`, `.superpowers/`) and `node_modules` — never touched.
- Commit message convention: `chore(deps): <scope> bump X from A to B` / `chore(deps): <summary>`.

---
### Task 1: Root npm patch bumps

**Files:**
- Modify: `package.json` (dependencies + devDependencies + overrides + allowScripts)
- Modify: `package-lock.json` (via `npm install`)

**Interfaces:**
- Consumes: nothing
- Produces: green root typecheck/lint/tests as baseline for Tasks 4-6

- [ ] **Step 1: Verify baseline is green before touching anything**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass (evidence baseline was already green)

- [ ] **Step 2: Bump root dependency ranges in `package.json`**

Edit `package.json`:
- `"@aws-sdk/client-bedrock-runtime": "^3.1105.0"` (was `^3.1092.0`)
- `"@aws-sdk/credential-provider-node": "^3.972.78"` (was `^3.972.71`)
- `"better-sqlite3": "^13.0.3"` (was `^13.0.1`)
- `"express-rate-limit": "^8.6.2"` (was `^8.6.0`)
- devDeps: `"@types/pg": "^8.20.4"` (was `^8.20.0`), `"tsx": "^4.23.10"` (was `^4.19.2`)
- allowScripts: `"better-sqlite3@13.0.3": true` (was `better-sqlite3@13.0.2`)

- [ ] **Step 3: Install and sync lockfile**

Run: `npm install`
Expected: no errors; `npm outdated` for root reports empty list

- [ ] **Step 4: Verify root gates**

Run: `npm run typecheck && npm run lint && npm run test:coverage`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): bump root npm patches (aws-sdk, better-sqlite3, express-rate-limit, tsx, types)"
```

### Task 2: Dashboard client patch bumps + lockfile sync

**Files:**
- Modify: `src/dashboard-client/package.json`
- Modify: `src/dashboard-client/package-lock.json` (via `npm install --prefix`)

**Interfaces:**
- Consumes: nothing
- Produces: dashboard client green baseline; lockfile synced (fixes stale jsdom 25.0.1 node_modules vs `^30.0.1` range)

- [ ] **Step 1: Bump dashboard ranges in `package.json`**

Edit `src/dashboard-client/package.json`:
- `"lucide-react": "^1.30.0"` (was `^1.28.0`)
- devDeps: `"vite": "^8.2.1"` (was `^8.1.5`)

- [ ] **Step 2: Install and sync lockfile**

Run: `npm install --prefix src/dashboard-client`
Expected: no errors; `npm outdated --prefix src/dashboard-client` leaves only eslint/typescript/jest-dom (majors handled in Tasks 5-6)

- [ ] **Step 3: Verify dashboard gates**

Run: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): bump dashboard patches (lucide-react, vite) and sync lockfile"
```

### Task 3: GitHub Actions bumps (dependabot PRs #65, #66, #68, #69, #70)

**Files:**
- Modify: `.github/workflows/build-deploy.yaml` (lines 55-60, 73)
- Modify: `.github/workflows/release.yaml` (lines 42-47, 60)
- Modify: `.github/workflows/nightly.yaml` (line 67)
- Modify: `.github/workflows/codeql.yml` (lines 29, 36)

**Interfaces:**
- Consumes: nothing
- Produces: CI actions at newest tags; supercedes open dependabot PRs #65-#70 (they will be closed after merge)

- [ ] **Step 1: Bump docker/setup-qemu-action to v4.2.0**

In `build-deploy.yaml:55` and `release.yaml:42` replace:
`uses: docker/setup-qemu-action@4574d27a4764455b42196d70a065bc6853246a25 # v3.4.0`
with:
`uses: docker/setup-qemu-action@9c0ca1f2d18a7293e6c2978e994d1d85705d2bc5 # v4.2.0`
(Use the exact SHA Dependabot specifies in PR #66 if different from this placeholder — verify via `gh pr diff 66` before editing.)

- [ ] **Step 2: Bump docker/setup-buildx-action to v4.2.0**

In `build-deploy.yaml:57`, `release.yaml:44`, `nightly.yaml:67` replace:
`uses: docker/setup-buildx-action@b5ca514318bd6ebac0fb2aedd5d36ec1b5c232a2 # v3.10.0`
with the v4.2.0 SHA from `gh pr diff 70`.

- [ ] **Step 3: Bump docker/build-push-action to v7.3.0**

In `build-deploy.yaml:60` and `release.yaml:47` replace:
`uses: docker/build-push-action@4f58ea79222b3b9dc2c8bbdd6debcef730109a75 # v6.9.0`
with the v7.3.0 SHA from `gh pr diff 65`.

- [ ] **Step 4: Bump anchore/sbom-action to v0.24.0**

In `build-deploy.yaml:73` and `release.yaml:60` replace:
`uses: anchore/sbom-action@df80a981bc6edbc4e220a492d3cbe9f5547a6e75 # v0.17.9`
with the v0.24.0 SHA from `gh pr diff 68`.

- [ ] **Step 5: Bump github/codeql-action init AND analyze to v4.37.6**

In `codeql.yml:29` and `codeql.yml:36` replace:
`uses: github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81 # v4.37.3` (and the `analyze@` twin)
with the v4.37.6 SHA from `gh pr diff 69`.

- [ ] **Step 6: Validate workflow YAML**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest .github/workflows/*.yaml`
Expected: no errors (or only pre-existing style warnings)

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/
git commit -m "ci: bump GitHub Actions to newest tags (buildx 4.2.0, qemu 4.2.0, build-push 7.3.0, sbom 0.24.0, codeql 4.37.6)"
```

### Task 4: Dockerfile base image → node 26.7.0-bookworm-slim

**Files:**
- Modify: `Dockerfile` (lines 2, 19, 30)

**Interfaces:**
- Consumes: Task 1 (root lockfile used by build stage `npm ci`)
- Produces: image builds on newest Node; verifies native-module compile + in-image `npm audit` gate

- [ ] **Step 1: Replace base image in all 3 stages**

In `Dockerfile`, replace all three `FROM node:22-bookworm-slim AS <stage>` with `FROM node:26.7.0-bookworm-slim AS <stage>` (build, client-build, runtime). Bookworm apt pins (python3/make/g++/libargon2) remain valid on bookworm-slim.

- [ ] **Step 2: Build the image**

Run: `docker build -t ai-arena/runner:node26 .`
Expected: build succeeds through `npm audit` gate and runtime stage (this is the native-module + audit proof). Allow up to 10 min.

- [ ] **Step 3: Smoke the image**

Run: `docker run --rm ai-arena/runner:node26 node -e "console.log(process.version, require('better-sqlite3')().inMemory, 'ok')"`
Expected: prints `v26.x.x`, no errors (better-sqlite3 native binding loads on Node 26).

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "chore(deps): bump Dockerfile base image to node 26.7.0-bookworm-slim"
```

### Task 5: Dashboard eslint 9.39.5 → 10.8.0 (dependabot PR #67)

**Files:**
- Modify: `src/dashboard-client/package.json` (devDeps eslint range)
- Modify: `src/dashboard-client/package-lock.json` (via install)

**Interfaces:**
- Consumes: Task 2 baseline
- Produces: eslint 10 on dashboard; root already runs eslint 10 + typescript-eslint 8.64 flat config with 0 errors, so config should be compatible

- [ ] **Step 1: Bump eslint range**

Edit `src/dashboard-client/package.json`:
- devDeps: `"eslint": "^10.8.0"` (was `^9.39.5`)

- [ ] **Step 2: Install + sync lockfile**

Run: `npm install --prefix src/dashboard-client`
Expected: no errors (typescript-eslint 8.64.0 peer-supports eslint 10 — verify no ERESOLVE; if peer conflict appears, add `--legacy-peer-deps` once and note it)

- [ ] **Step 3: Verify lint + typecheck + tests**

Run: `npm --prefix src/dashboard-client run lint && npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test`
Expected: all pass. If lint fails on config deprecation, fix `src/dashboard-client/eslint.config.*` per eslint 10 flat-config guidance.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): bump eslint from 9.39.5 to 10.8.0 in dashboard client"
```

### Task 6: Dashboard majors — typescript 7.0.2 and jest-dom 7.0.0 (try + rollback)

**Files:**
- Modify: `src/dashboard-client/package.json` (devDeps typescript, @testing-library/jest-dom)
- Modify: `src/dashboard-client/package-lock.json` (via install)
- Modify: `src/dashboard-client/tsconfig.json` (ONLY if TS7 requires it — analyze first)

**Interfaces:**
- Consumes: Task 5 (eslint 10)
- Produces: either upgraded majors with green gates, or documented rollback (revert commit)

- [ ] **Step 1: Analyze breaking changes before installing**

Run: `npm view typescript@7.0.2 --json | head -50` and check `https://devblogs.microsoft.com/typescript/typescript-native-port/` + `@testing-library/jest-dom@7.0.0` release notes (v7 drops `@testing-library/jest-dom/jest-globals` auto-registration; requires explicit `import '@testing-library/jest-dom/vitest'` in test setup).
Also read `src/dashboard-client/tsconfig.json` and test setup file to predict required edits.

- [ ] **Step 2: Bump both ranges**

Edit `src/dashboard-client/package.json`:
- devDeps: `"typescript": "^7.0.2"` (was `^5.6.3`)
- devDeps: `"@testing-library/jest-dom": "^7.0.0"` (was `^6.9.1`)

- [ ] **Step 3: Install**

Run: `npm install --prefix src/dashboard-client`
Expected: install succeeds. Note: root `package.json` uses `@typescript/native: npm:typescript@^7.0.2` alias, confirming TS7 works on this toolchain (vite 8 + vitest 4).

- [ ] **Step 4: Run dashboard gates**

Run: `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build`
Expected: all pass.
- If typecheck fails on tsconfig options removed in TS7: edit `src/dashboard-client/tsconfig.json` per the TS7 migration (remove deprecated flags), then re-run.
- If tests fail on jest-dom matchers: update the test setup file to `import '@testing-library/jest-dom/vitest'` per v7 docs, then re-run.

- [ ] **Step 5: Commit or rollback**

If green:
```bash
git add src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): bump typescript to 7.0.2 and jest-dom to 7.0.0 in dashboard client"
```
If still red after one documented fix attempt:
```bash
git checkout -- src/dashboard-client/package.json src/dashboard-client/package-lock.json
git commit -m "chore(deps): revert dashboard majors (typescript 7, jest-dom 7) — gates failed"
```
State the outcome in the final report either way.

### Task 7: Infra images — postgres 18, redis 8, observability stack

**Files:**
- Modify: `docker-compose.yml` (lines 3, 19)
- Modify: `k8s/base/postgres.yaml:40`
- Modify: `k8s/base/redis.yaml:41`
- Modify: `k8s/observability/collector.yaml:94`, `grafana.yaml:29`, `loki.yaml:29`, `prometheus.yaml:29`, `promtail.yaml:29`, `tempo.yaml:29`
- Modify: `.github/workflows/build-deploy.yaml:36`, `nightly.yaml:32`, `pr-checks.yaml:102` (CI parity gates)

**Interfaces:**
- Consumes: nothing (independent of npm tasks)
- Produces: prod/dev/CI parity on postgres 18 + redis 8; newest observability images

- [ ] **Step 1: Bump postgres everywhere (dev, k8s, CI)**

- `docker-compose.yml:3`: `image: postgres:16.8-alpine` → `postgres:18.4-alpine`
- `k8s/base/postgres.yaml:40`: `image: postgres:16` → `postgres:18`
- `build-deploy.yaml:36` and `nightly.yaml:32`: `postgres:16.8-alpine` → `postgres:18.4-alpine`
- `pr-checks.yaml:102`: `image: postgres:16-alpine` → `postgres:18-alpine`

- [ ] **Step 2: Bump redis (dev + k8s)**

- `docker-compose.yml:19`: `image: redis:7.4-alpine` → `redis:8.10-alpine`
- `k8s/base/redis.yaml:41`: `image: redis:7` → `redis:8`

- [ ] **Step 3: Bump observability images in `k8s/observability/`**

- `collector.yaml:94`: `otel/opentelemetry-collector-contrib:0.117.0` → `0.158.0`
- `grafana.yaml:29`: `grafana/grafana:11.6.0` → `13.1.3`
- `loki.yaml:29`: `grafana/loki:3.2.0` → `3.7.6`
- `prometheus.yaml:29`: `prom/prometheus:v2.55.0` → `v3.13.2`
- `promtail.yaml:29`: `grafana/promtail:3.2.0` → `3.6.11`
- `tempo.yaml:29`: `grafana/tempo:2.6.1` → `2.9.4`

- [ ] **Step 4: Validate compose + kustomize render**

Run: `docker compose config -q && kubectl kustomize k8s/overlays/dev > /tmp/k8s-dev.yaml && kubectl kustomize k8s/base > /tmp/k8s-base.yaml`
Expected: exit 0, valid manifests. If Prometheus v3 config compat breaks (alerting/rules syntax), check `k8s/observability/prometheus.yaml` configmap args and adjust per Prometheus 3 migration notes.

- [ ] **Step 5: Postgres 18 migration parity (if local docker available)**

Run: `docker run -d --name pg18 -p 5432:5432 -e POSTGRES_USER=arena -e POSTGRES_PASSWORD=arena -e POSTGRES_DB=arena postgres:18.4-alpine && sleep 5 && npm run test:db-pg; docker rm -f pg18`
Expected: migrations apply, all pg tests pass (proves Drizzle schema + migrations on PG 18).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml k8s/ .github/workflows/
git commit -m "chore(deps): bump infra images — postgres 18, redis 8, observability stack, CI parity gates"
```

### Task 8: Final verification + dependabot PR cleanup

**Files:**
- No file changes unless a gate fails

**Interfaces:**
- Consumes: all Tasks 1-7

- [ ] **Step 1: Full repo gates**

Run: `npm run typecheck && npm run lint && npm run test && npm run test:coverage && npm run audit`
Expected: all pass. Also `npm --prefix src/dashboard-client run typecheck && npm --prefix src/dashboard-client run test && npm --prefix src/dashboard-client run build`.

- [ ] **Step 2: Confirm no remaining outdated deps**

Run: `npm outdated` and `npm outdated --prefix src/dashboard-client`
Expected: empty (majors either upgraded or intentionally reverted per Task 6 decision).

- [ ] **Step 3: Review the full diff**

Run: `git log --oneline main..HEAD` and `git diff main...HEAD --stat`
Expected: one commit per task, focused stats. Verify no vendor/ dirs or template package.json touched.

- [ ] **Step 4: Close the 7 superseded dependabot PRs**

For PRs 64-70, run: `gh pr close 64 --comment "Superseded by #<our-PR> (chore/dependency-updates-2026-08)."` (repeat for 65-70). If a PR merge keeps CI useful, prefer close-with-comment since changes are already in the branch.

- [ ] **Step 5: Final report**

Summarize: versions bumped per area, Task 6 outcome (upgraded or reverted, with reason), any Prometheus 3 config migration needed, and remaining risks.

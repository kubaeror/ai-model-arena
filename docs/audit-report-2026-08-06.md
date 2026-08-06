# Codebase Audit Report — Remediation of 2026-08-06 Findings

**Repository:** ai-model-arena
**Audit Date:** 2026-08-06
**Node.js:** >=22.22.0 (engines)
**TypeScript:** TypeScript 6.x (root), 5.6.3 (dashboard-client)
**Package Manager:** npm (lockfileVersion 3)
**Module System:** ESM
**Branch:** refactor/audit-remediation (baseline: main @ ea1790d)

---

## 1. Executive Summary

- **Audit date:** 2026-08-06. **Method:** static analysis of `src/` + `tests/` (lint baseline, dead-export scan, duplication scan, cross-process behavior review), with a written remediation plan executed as tasks 0–14.
- **Verdict:** All remediable findings from this audit are resolved. The two production-behavior bugs found (stale queue router map, cross-process kill switch / cancellation) are fixed. Lint went from 83 warnings to 0. Dead code was removed, all 17 deduplication findings in scope were resolved (H1–H3, M1–M6, L1–L9 minus deliberately-kept L5/L10 — 14 executed on this branch, L7/L9 verified already-clean, L8's shared query-string builder landed on main pre-branch), and Postgres driver parity is complete with CI coverage.
- **Final verification (this task):**
  - `npm run lint` → exit 0, 0 errors, 0 warnings (ESLint 10 prints no summary line when clean).
  - `npm run typecheck` and `npm run typecheck:tests` → pass.
  - `npm test` → 782 tests, 777 pass, 0 fail, 5 skipped.
  - `npm --prefix src/dashboard-client run typecheck` → pass; client tests → 39 files / 136 tests pass.
- **Deliberately not remediated** (documented in sections 8 and 9): overengineering artifacts (schema-builder type machinery, auth revocation stack, sandbox env denylist, readiness-file dance), the L5 session type-unification refactor, the L10 Redis nack Lua+JS fallback (deliberate Redis <7 support), unenforced profile knobs, and per-turn git commits.

---

## 2. Module Completion Table

Percentages as measured by the audit on 2026-08-06. "Remains" lists what is still incomplete **after** this remediation (see sections 8–9 for the deliberate exclusions).

| Module | % | Implemented | Remains | Tests |
| --- | --- | --- | --- | --- |
| runner / queue | 88 | Long-lived queue-driven runner, Redis Streams + in-memory queue, DLQ, kill switch + cancellation (fixed this branch), router derived from provider descriptors (fixed this branch) | No idempotency key / priority lanes; nack is Lua+JS dual-path (deliberate) | `tests/queue/*`, `tests/runner/*`, `tests/orchestrator/run-signals.test.ts` |
| agent-loop | 95 | send→tool→loop with budget intercept, onTurnComplete checkpoint, turn-loop shared with subagents | Streaming never used by the loop; no structured-output mode | `tests/agent-loop/*` |
| orchestrator | 82 | Run lifecycle, finalization, cost ledger, budget checks — now with working cross-process kill switch and run cancellation (fixed this branch) | Budget state is JSON-file based; tick scheduler still bypasses `startRun()` | `tests/orchestrator/*` |
| session | 90 | Session + message persistence (SQLite/Postgres via Drizzle) | `session/store` type names not unified with `Db*` aliases (L5 — kept) | `tests/session/*`, db query suite |
| tools | 93 | File ops, shell, search executors with schemas; task/todo tools | — | `tests/tools/*` |
| sandbox | 90 | Path-escape prevention, shell policy, git init/final commits, artifact manifest | No per-turn git commits; env denylist flagged as overengineering (kept) | `tests/sandbox/*` |
| providers | 90 | 58 builtin descriptors, 4 adapters (openai-compat / anthropic / google / bedrock), registry, fallback, circuit breaker, URL validation | Bedrock: no streaming, no model discovery; custom providers are openai-compat only | `tests/providers/*` |
| db | 78 | Drizzle ORM, SQLite + Postgres dialects, shared schema types (H1), query layer with concrete row types, `pingDb()` health check — now PG parity + CI (fixed this branch) | Multi-tenancy absent; pricing versioning partial; some FKs/PKs missing | `tests/db/*`, `test:db-pg` + CI `test-postgres` job |
| dashboard-server | 90 | Express API + WS, JWT + RBAC, ownership enforcement (M1/M2 this branch), analytics via query layer (M3 this branch) | JWT revocation stack flagged as overengineering (kept); no refresh flow | `tests/dashboard/*` |
| dashboard-client | 90 | React SPA, TanStack Query, shared qs builder + `apiFetch` (L8) | — | 39 files / 136 tests |
| catalog | 85 | models.dev/modelbench/zeroeval sync, benchmarks, single refresh dispatch `ensureFresh` (M6 this branch) | No pricing snapshot versioning | `tests/catalog/*` |
| cost-tracking | 88 | Pricing, budgets, spend tracking, ledger writes; driver-based pricing cache key (this branch) | `addSpend` file race (no lock); budget threshold notifications not wired | `tests/cost-tracking/*` |
| anomaly-detection | 85 | 6 detectors; query layer consolidated into `db/query` (H2/H3 this branch) | Silent-failure detector requires judge score; no z-score | `tests/anomaly-detection/*` |
| evaluation | 85 | Judge scoring (4-category rubric), objective metrics, regression runner | Judge-file scan shallow; no ensemble judging / calibration; regression suites empty | `tests/evaluation/*` |
| scheduler | 90 | In-process + DB-driven cron with DB-seeded counters; single tick path | Scheduler bypasses `startRun()` safety checks | `tests/scheduler/*` |
| notifications | 90 | Slack, Discord, webhooks, outbox with retry (`notifications/retry.ts` kept — imported) | Budget-threshold alerts not dispatched | `tests/notifications/*` |
| metrics | 90 | Writeback of runtime stats, percentile helpers, cache metrics (`cache-metrics.ts` kept — imported) | — | `tests/metrics/*` |
| observability | 85 | OTel SDK, TraceRecorder, Prometheus metrics endpoint | Log-to-Loki bridge missing; agent-loop traces not unified on OTel | — |
| auth | 95 | Argon2id, JWT, RBAC (viewer/editor/admin), API-key scoping, shared ownership predicate (M2 this branch) | JWT revocation stack flagged as overengineering (kept) | `tests/auth/*` |
| security | 90 | Sandbox containment, shell policy, prompt-injection detection, secret masking (L6 this branch) | Provider URL not re-validated on use | `tests/auth/audit-safe.test.ts` et al. |
| fs | 95 | Shared `readJsonFile` helper (L2 this branch), artifact manifest | Artifact cleanup (TTL cron) missing | `tests/fs/read-json.test.ts` |
| profiles | 70 | Profile definitions with cost/time/approval knobs | `maxCostUsd` / `maxExecutionSec` / `requiresApproval` defined but **unenforced** | — |
| secrets | 90 | Env-var based store, masking via shared `SENSITIVE_KEYS` regex (L6 this branch) | No rotation / external secret manager | `tests/secrets/store.test.ts` |
| env | 85 | Config via env vars, YAML config loader shared across six modules (L3 this branch) | — | `tests/config-loader.test.ts` |
| logger | 80 | Pino structured JSON logging | No Pino-level redaction config; no log-to-Loki bridge | — |

---

## 3. Lint Remediation

- **Before:** 83 warnings / 0 errors — every warning `@typescript-eslint/no-explicit-any`, across 23 files. `eslint src scripts` (tests excluded by design).
- **After:** 0 errors / 0 warnings, verified by `npm run lint` exit code 0 (ESLint 10 prints no summary line when clean).
- Fixes shipped in two commits: `fix(db): replace explicit any with concrete row types in query layer` (1312a5a — 15 files in `src/db/query/*` + `db/index.ts`) and `fix: replace remaining explicit any with concrete types` (7580936 — catalog, cost-tracking, dashboard routes, queue, providers, metrics, db/runs).
- **The single sanctioned disable:** `src/db/index.ts:62` — `// eslint-disable-next-line @typescript-eslint/no-explicit-any` above `export function getDrizzleDb(): any` (line 63). Justification: SQLite and Postgres Drizzle clients have incompatible TypeScript generics (dialect-union escape hatch); every call site annotates concrete row types. One disable, documented, nothing else.

---

## 4. Dead Code Removed

- `getAllScheduleStates()` in `src/scheduler/manager.ts` — zero references anywhere (incl. tests).
- `useApiMutation` hook + its test — the only production hook imported exclusively by its own test (`src/dashboard-client/src/hooks/useApiMutation.ts`, `tests/hooks/useApiMutation.test.tsx`).
- 18 unexported symbols across 13 files (interfaces/consts/types/functions only referenced in their own file), e.g. `TurnLoop*` interfaces, `RESERVATION_TTL_MS`, `PgClient`, `buildSqliteTable`/`buildPgTable` + schema-builder types, `NormalizedEvent`, `OutboxRow`, `ObservabilityStats`, `AggregateInput`, `OpenAIChoice`, `WebhookRecord`.
- 5 barrel re-export lines removed (`anomaly-detection/index.ts`, `notifications/index.ts`, `cost-tracking/index.ts`, `providers/index.ts`, `tools/index.ts`).
- **Investigated and KEPT (audit false positives):** `src/notifications/retry.ts` — imported by `src/notifications/format.ts` (`postWithRetry`); `src/metrics/cache-metrics.ts` — imported by `src/metrics/writeback.ts`. Both are production code; the audit-pass-1 claims they were dead are incorrect.
- Commit: `refactor: remove dead exports and unconsumed barrel re-exports` (789ba8a) and `refactor(client): remove unused useApiMutation hook` (16b8ccf).

---

## 5. Bugs Fixed

### 5.1 Queue router derivation (Redis/k8s: ~44 orphaned providers)

- **Before:** `src/queue/router.ts` hardcoded a 14-entry `PROVIDER_ADAPTER_FAMILIES` map. The catalog defines **58 builtin providers**; every provider not in that map fell back to a per-provider stream key and was absent from `knownProviders`. In Redis/k8s mode, runner deployments consume by adapter family filter (`ARENA_PROVIDER_FILTER=openai-compat|anthropic|google`), so the ~44 providers added to the catalog after the map was written routed to streams nobody consumed — tasks for those providers queued forever.
- **After:** the family map is **derived** from `BUILTIN_PROVIDERS` (single source of truth), with two explicit overrides (`bedrock` keeps its own stream — IAM auth; `ollama` shares `openai-compat`). New builtin providers automatically share their adapter family's stream. `knownProviders` now enumerates all 58 builtins. `familyFor(provider)` added; unknown/custom providers keep per-provider streams (unchanged behavior).
- Commits: `fix(queue): derive stream families from provider descriptors` (e4d293e) + `test(dashboard): derive queues route expectation from knownProviders` (e4e7205).

### 5.2 Cross-process kill switch + run cancellation

- **Before:** kill-switch flag and cancelled-run set were in-process module state in `src/orchestrator/run-lifecycle.ts`. The dashboard (which exposes the kill-switch routes) and the runner are **separate processes**, so `activateKillSwitch()` set a flag the runner never observed — a complete no-op in production; `stopRun()` likewise never reached an in-flight runner.
- **After:** new `src/orchestrator/run-signals.ts` — a `RunSignalStore` interface with two implementations: `RedisRunSignalStore` (keys `arena:killswitch`, `arena:cancel:<runId>` with 7-day TTL, lazy ioredis client) and `InMemoryRunSignalStore` (dev). Store selected by `QUEUE_DRIVER`; singleton functions + a test seam. `run-lifecycle.ts` keeps thin wrappers for dashboard compatibility; `runner.ts` now awaits `isKillSwitchActive()` / `isRunCancelled()` / `clearRunCancelled()` in the dequeue loop and cancel path; the dashboard kill-switch routes await the shared store.
- Commit: `fix(orchestrator): propagate kill switch and run cancellation across processes` (37bdfab), tests in `tests/orchestrator/run-signals.test.ts`.

---

## 6. Dedup Refactors

Executed on this branch unless noted:

| ID | Refactor | Result / location |
| --- | --- | --- |
| H1 | Shared schema types between dialect files | `src/db/schema-types.ts` (117 LOC shared: 7 legacy row interfaces + `Db*` aliases); `schema.ts` and `schema-pg.ts` re-export (8908d74) |
| H2/H3 | Anomaly query layer consolidated | CRUD moved into `src/db/query/anomalies.ts`; webhook CRUD into new `src/db/query/webhooks.ts`; the dead duplicate (`db/query/anomalies.ts` stub) and the old `anomalyCountsByModel` duplicate deleted; routes import from the query layer (53d6a04) |
| M1 | 7× route guard → helper | `getOwnedRunModelEntry()` in `src/dashboard-server/routes/runs.ts` collapses the repeated allowIfRunOwner + findEntry + notFound trio (43e6f13) |
| M2 | Shared ownership predicate | `isOwnerAllowed(actor, ownerId)` in `src/auth/rbac.ts`, used by `run-ownership.ts` and `requireOwnership` (43e6f13) |
| M3 | Analytics queries → query layer | `queryToolCallStats`, `queryDailyToolTrends`, `queryCostLeaderboard` in `src/db/query/metrics.ts`; route delegates (02afbb4) |
| M4 | `listModelsWithPricing` deleted | Callers repointed to `listCatalogModels({})` (72970d7) |
| M5 | Placeholder-URL check hoisted | `BaseAdapter` constructor (`src/providers/adapters/base.ts`) throws on `{` in baseUrl; duplicate checks removed from openai-compat + google adapters (72970d7) |
| M6 | Single catalog refresh dispatch | `ensureFresh(source, { force })` in `src/catalog/cache.ts`; `/api/cache/refresh` delegates (72970d7) |
| L1 | Double barrel collapsed | `src/db/query.ts` is now the single barrel; `src/db/query/index.ts` deleted (72970d7) |
| L2 | `readJsonFile` ×3 | `src/fs/read-json.ts` shared by analytics route, export route, anomaly baselines (02afbb4) |
| L3 | YAML loader ×6 | `src/config-loader.ts` (`loadYamlConfig`, `expandEnvVars`, `clearConfigCache`) used by budget, notifications, auth-api, anomaly config, config.ts, judge (466086e) |
| L4 | TaskSchema drift | `TaskSchema` gained `priority: z.number().int().min(0).max(255).optional()` — now validates the full `Task` interface (72970d7) |
| L6 | Sensitive-key regex shared | `SENSITIVE_KEYS` in `src/secrets/sensitive-keys.ts` used by `dashboard-server/secrets.ts` and `secrets/store.ts` (72970d7) |
| L7 | files.ts `replaceFilesForRun` | **Verified clean:** no duplicate file-replacement logic exists; `src/dashboard-server/routes/files.ts` is a single paginated route sharing the `paginate` helper |
| L8 | qs() in hooks | **Verified:** hooks share a query-string builder + `apiFetch` via `src/dashboard-client/src/lib/api.ts` (useCache, useCatalog, useMetrics). Fix landed on main pre-branch as cc6e7f8 and is included in this branch's history |
| L9 | Tick counter helper | **Verified clean:** single tick path in `src/scheduler/tick.ts` (counters seeded from DB rows, no duplicated helper) |
| L10 | Redis nack Lua+JS fallback | **Kept, deliberately:** Lua atomic nack with JS fallback is intentional Redis <7 support (see section 9 of the plan) |
| L5 | session/store camelCase→Db* unification | **Kept, deliberately:** high-churn, low value; `Db*` aliases already shared via H1 |

---

## 7. Postgres Parity

- **Before:** SQLite-first code leaked into Postgres paths: the dashboard health check used `getDrizzleDb().run('SELECT 1')` (better-sqlite3 API, throws under PG), and the pricing cache key was DB-instance-agnostic (stale cross-driver cache risk). `test:db-pg` covered a subset and no CI job ran the PG suite.
- **After (commit 8745ef3):**
  - `pingDb()` in `src/db/index.ts` — driver-aware `SELECT 1` (pg: `execute`, sqlite: `run`), used by the dashboard `/health` check.
  - Pricing cache key now includes the driver: `${getDriver()}|${modelId}` (`src/cost-tracking/pricing.ts`) — the last `getDb()` consumer is gone.
  - `test:db-pg` runs the full `test:db` suite list against Postgres (migrate first, `DB_DRIVER=postgres`, serial execution, `PG_TEST_RESET=1` helper).
  - New `test-postgres` CI job in `.github/workflows/pr-checks.yaml` (postgres:16-alpine service, SHA-pinned actions, `npm run test:db-pg`).

---

## 8. Overengineering (Documented, Not Fixed)

Identified by the audit; deliberately left in place — removing them would churn without user value:

- **Schema-builder type machinery** — `src/db/schema-builder.ts` per-dialect table builders with generic type params (largely unexported now; the codebase converged on plain Drizzle table definitions).
- **Auth revocation stack** — `src/dashboard-server/auth.ts` `revokeToken()`/`isRevoked()` with Redis fail-closed behavior; JWT expiry (12h) bounds the risk.
- **Sandbox env denylist** — `src/sandbox/sandbox.ts` sanitizes `process.env` (strips sensitive credential keys) when spawning LLM-controlled subprocesses.
- **Readiness-file dance** — `src/runner.ts:46` `READINESS_FILE` written with `O_EXCL` at startup for orchestrator detection.

---

## 9. Remaining Incomplete Features (Documented)

- **Profile knobs unenforced** — `maxCostUsd`, `maxExecutionSec`, `requiresApproval` are defined in `src/profiles/definitions.ts` (and profile schemas) but have no consumers; runs do not enforce per-profile cost/time/approval limits.
- **Per-turn git commits absent** — the README's sandbox "git integration" claim implies checkpointing; only `init` (initial commit) and `commitFinal` are implemented in `src/sandbox/git.ts`.
- **Judge-file scan shallow** — `src/evaluation/judge.ts` reads `judge_score.json` with a trailing-prose/embedded-JSON scan only; no deeper conversation-content validation.
- **Silent-failure detector requires judge** — `src/anomaly-detection/detectors.ts` `silentFailureDetector()` returns `[]` when `judgeScore == null`; runs without judge scoring are invisible to this detector.

---

## 10. Fixes Applied in This Work

All 14 commits on `refactor/audit-remediation` (main @ ea1790d..HEAD):

| SHA | Subject |
| --- | --- |
| 8745ef3 | feat(db): complete postgres parity with pingDb, driver-based cache keys, and CI |
| e4e7205 | test(dashboard): derive queues route expectation from knownProviders |
| 37bdfab | fix(orchestrator): propagate kill switch and run cancellation across processes |
| e4d293e | fix(queue): derive stream families from provider descriptors |
| 7580936 | fix: replace remaining explicit any with concrete types |
| 1312a5a | fix(db): replace explicit any with concrete row types in query layer |
| 43e6f13 | refactor(dashboard): share ownership predicate and collapse run route guards |
| 53d6a04 | refactor(db): consolidate anomaly and webhook queries into db/query |
| 8908d74 | refactor(db): share row types and Db aliases between dialects |
| 466086e | refactor: share YAML config loader across six modules |
| 02afbb4 | refactor: share readJsonFile and move analytics queries into db/query |
| 72970d7 | refactor: dedup models list, catalog refresh, url check, task schema, secret masking |
| 16b8ccf | refactor(client): remove unused useApiMutation hook |
| 789ba8a | refactor: remove dead exports and unconsumed barrel re-exports |

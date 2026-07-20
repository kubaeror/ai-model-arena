# Kubernetes Runner Migration — Architecture & Plan

> **Status:** Design / audit deliverable. No implementation in this pass.
> **Date:** 2026-07-20
> **Scope:** Migrate LLM chat handling and model file-output processing off the
> current PM2-per-run process model onto long-lived, horizontally-scalable
> Kubernetes runners, with a management dashboard.

---

## Part 1 — Current State Audit

### 1.1 What the system is today

`ai-model-arena` is a TypeScript/ESM (Node ≥ 20.11, strict) monolith that
spawns one PM2 worker process per (model × run). Each worker runs a
synchronous turn-based agent loop against an LLM provider, executes file/shell
tools inside a path-sandboxed workspace, and writes artifacts to a per-run
output folder. A separate Express + WebSocket dashboard (port 4000, JWT auth)
imports the orchestrator module in-process and exposes run/scenario/model
management plus a live transcript viewer.

Key entry points:
- CLI: `src/cli.ts`
- Orchestrator (PM2 spawn + lifecycle): `src/orchestrator/run-lifecycle.ts:143`
- Worker entry: `src/worker.ts:356` (always `process.exit(0)` at `:389`)
- Agent loop: `src/agent-loop/loop.ts:47` (`runAgentLoop`), async/await, **not streaming** (streaming method exists on the adapter interface but is never called)
- Provider adapters: `src/providers/adapters/{base,openai-compat,anthropic,google,bedrock}.ts`
- Tools: `src/tools/{schema,executors}.ts` — `read_file`, `write_file`, `list_files`, `run_shell_command`, `search_code`, `task_complete`
- Sandbox: `src/sandbox/sandbox.ts` — path-based only (`safeResolve`/`isWithin`, `:41,66`)

### 1.2 Tech stack & dependencies

- **Runtime:** Node ≥ 20.11, TypeScript 5.9, ESM, strict.
- **Web:** Express 4.21, `ws` 8.18, `helmet`, `express-rate-limit`, `cors`.
- **Auth:** `jsonwebtoken` 9 (JWT HS256), API-key layer with 20 flat permissions.
- **DB:** `better-sqlite3` 12 (WAL mode, foreign keys on) at `outputs/arena.db`.
- **Config:** `js-yaml` + `zod` runtime validation, YAML files in `configs/`.
- **Logging:** `pino` structured JSON.
- **Process:** `pm2` 7 programmatic API (`exec_mode: fork`, `autorestart: false`).
- **Observability:** **No OTel SDK dependency.** README claims OTel instrumentation but `src/observability/tracing.ts:1-5` explicitly states the SDK was removed. Spans are recorded to a local `trace-meta.json` per run only — no exporter, no OTLP, no external backend. All "observability" UI surfaces read local JSON + SQLite.
- **Dev tooling:** `tsx`, `concurrently`, ESLint 10, `typescript-eslint` 8.
- **Not present:** Redis, NATS, RabbitMQ, Kafka, Bull, Knex/Drizzle, Docker, Kubernetes, Helm, CI config, any `@opentelemetry/*` package. **Greenfield on the infra side.**

No deprecated-or-vulnerable dependencies were flagged by the audit; `npm audit`
was not run in this pass (open question Q9). Dependency hygiene is otherwise
clean — zero `TODO/FIXME/HACK/XXX` markers in `src/`.

### 1.3 Existing infrastructure

**Effectively greenfield for the target architecture.** There is:
- No `Dockerfile`, no `.dockerignore`, no `docker-compose.yml`. The README
  references `docker-compose.observability.yml` but the file is **not present**
  in the repo (stale doc).
- No Kubernetes manifests, no Helm chart, no `.github/` CI.
- No container registry, no KEDA, no Ingress definitions.
- Only deployment primitive: `ecosystem.config.cjs` for PM2 (dashboard only);
  workers are spawned dynamically via PM2 programmatic API and never declared.

### 1.4 File-output handling (current)

- Output root: `outputs/` at project root (hardcoded via `src/paths.ts`).
- Layout: `outputs/<model>/<scenario>_<timestamp>/{conversation.json, report.md, result.json, trace-meta.json, files/...}`.
- Per-run uniqueness via timestamp-based `runId` (`run-lifecycle.ts:112`), so
  re-runs never overwrite.
- `files/` is the model's sandbox workspace; git-initialized per run with
  per-turn commits and a final `diff.patch`.
- **Configurability:** scenario overrides via YAML (`starterFiles`,
  `successCriteria`, `maxTurns`, `shellTimeoutMs`, `maxShellOutputBytes`),
  but the **output root itself is not env-configurable** — it's resolved from
  the project root.
- **Path safety:** `safeResolve`/`isWithin` reject `..` traversal,
  drive-relative paths, and absolute-outside-sandbox. This applies to the
  model's `files/` tool surface.

### 1.5 State management (current)

| State | Location | Durable? | Multi-process safe? |
|---|---|---|---|
| Run metadata index | `outputs/runs-index.json` | file | **No** — in-process async write lock (`run-index.ts:22-34`); PM2 workers each hold their own lock; `fs.writeFileSync` direct, no flock, no atomic rename. **Highest corruption risk.** |
| Conversation transcript | `outputs/<model>/<runId>/conversation.json` | file, append-per-step | Per-worker only (safe — unique runId) |
| Result | `outputs/<model>/<runId>/result.json` | file | Per-worker only (safe) |
| Trace spans | `outputs/<model>/<runId>/trace-meta.json` | file | Per-worker only |
| Catalog (providers/models/pricing) | SQLite `arena.db` | DB | WAL on; tolerable |
| Run status / runtime stats | SQLite `arena.db` (`model_runtime_stats`) | DB | WAL on; tolerable |
| Anomalies + webhooks | SQLite `arena.db` | DB | **Two separate `better-sqlite3` singletons** on the same file (`src/db/client.ts:72` vs `src/anomaly-detection/db.ts:80`); neither coordinates migrations with the other. |
| Budget state | `outputs/budget-state.json` (path from `budget.ts:39`) | file, `writeFileSync` | **No** — in-memory singleton cache, no atomic write |
| Schedule runtime state | in-memory `Map` (`scheduler/manager.ts:9`) | **No** | n/a (lost on restart) |
| API-key rate-limit counters | in-memory `Map` (`auth-api.ts:88`) | **No** | n/a (lost on restart) |

**No session/chat-history DB table exists.** Chat history is file-only
(`conversation.json`). There is no resumable checkpoint — `ConversationLogger`
appends steps for auditability, but a crashed worker restart re-runs from
scratch (`restartRun` at `run-lifecycle.ts:383` overwrites the runId's outputs).

### 1.6 Security posture (current)

| Concern | Status |
|---|---|
| Dashboard auth | JWT HS256, secret ≥32 chars validated (`env.ts:7-10`). **Password stored plaintext in env var** (`DASHBOARD_PASSWORD`); timing-safe comparison (`auth.ts:37-44`). No RBAC roles — single user. API-key layer has 20 flat permissions but no role hierarchy. |
| Login brute-force | Rate-limited 15min/20req (`server.ts:86-92`). |
| API-key rate limit | In-memory `Map` — **lost on restart** (burst window resets on deploy). |
| Secrets management | Env vars via `dotenv` only. No vault. Keys referenced by name (`apiKeyEnv`) so raw values never appear in configs/UI — good. Shell `sandboxEnv()` (`sandbox.ts:88`) strips `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DASHBOARD_JWT_SECRET`, etc. from child-process env — good. |
| Path traversal (model tools) | Blocked by `safeResolve`/`isWithin` — recently hardened (`ba16b1a`). |
| **Shell injection by the model** | **Not defended.** `run_shell_command` (`executors.ts:97`) passes raw model-authored `command` to `cmd.exe`/`/bin/sh` with no metachar filtering. (Compare: the success-criteria evaluator at `worker.ts:43` *does* reject metachars via `SHELL_METACHAR_RE` — so the evaluator is harder than the agent itself.) |
| OS-level isolation | **None.** No containers, no chroot, no seccomp, no user namespaces. Sandboxing is path-based only. A model running `run_shell_command` can touch anything the Node process can. |
| Prompt-injection defense | None. Previously generated files fed back as context are trusted. |
| Data lineage (which prompt+model+config produced a file) | Partial — `result.json` captures config snapshot per run, but no per-file provenance graph. |
| Audit log of config changes | None. |

### 1.7 Observability (current)

- **Logs:** `pino` structured JSON to PM2 logs.
- **Metrics:** `model_runtime_stats` SQLite table; in-app Analytics page reads it.
- **Tracing:** Local-only `TraceRecorder` → `trace-meta.json` per run. README
  overstates this as "OpenTelemetry" — no OTel SDK, no exporter, no OTLP.
  In-app span waterfall reads the JSON. **No distributed tracing across
  processes/runs.**
- **Missing:** external trace backend, metrics scrape endpoint, alerting beyond
  anomaly-detection rules firing Slack/webhook.

### 1.8 Testing & docs

- 13 test files under `tests/`, all `node:test`. Coverage is **narrow and
  concentrated in the catalog/provider-rebuild subsystem** (adapters, registry,
  catalog sync, db migrations, metrics writeback).
- **Not tested:** `src/agent-loop/`, `src/sandbox/` (escape prevention),
  `src/dashboard-server/` (auth/JWT/API), `src/tools/executors.ts`,
  orchestrator/PM2 lifecycle, scheduler, anomaly detection, evaluation,
  notifications, worker concurrency.
- Smoke scripts only: `scripts/ws-smoke.mjs`, `scripts/trace-smoke-test.mjs`.
- Docs: `README.md` (700 lines, partially stale re: `models.yaml`/OTel),
  5 design/plan docs under `docs/superpowers/{specs,plans}/` dated 2026-07-20.
  **Missing:** CONTRIBUTING, CHANGELOG, standalone ARCHITECTURE, runbooks,
  deployment guide.
- Git: 52 commits last 3 months, single contributor (Kuba Konat). No open
  issues (issue tracker unused). Zero inline TODO/FIXME.

### 1.9 Database / schema (current)

- Engine: `better-sqlite3`, single file `outputs/arena.db`, WAL on.
- Migrations: ad-hoc `_migrations` table (`db/client.ts:6-85`); only one
  migration (`001_catalog_tables`) covers providers/models/pricing/benchmarks/
  model_runtime_stats/catalog_cache_state. Anomaly module runs its own
  `CREATE TABLE IF NOT EXISTS` block (`anomaly-detection/db.ts:44-77`)
  **outside** the migration tracker.
- No migration tool (no Knex/Drizzle/Prisma). No backup strategy (no
  `VACUUM INTO`, no `.backup()`, no snapshot, no rotation).

### 1.10 Audit gap summary

Gaps blocking the target architecture:

1. **No durable queue.** Everything is in-process `Map`s and `setTimeout`.
   KEDA-on-queue-depth scaling is impossible without one.
2. **No stateless runners.** Workers are one-shot PM2 processes bound to a
   single run; session state lives in process memory + per-run files. Restarts
   lose in-flight context.
3. **No session DB.** Chat history is file-only. A long-lived runner needs
   externalized session state to survive restarts mid-turn.
4. **`runs-index.json` is a single-writer race waiting to happen.** Multi-pod
   runners writing the same JSON file will corrupt it.
5. **No container images, no k8s, no CI/CD.** Pure greenfield on the infra
   side.
6. **No OS-level sandboxing** for model-generated code execution — a hard
   requirement for multi-tenant runners.
7. **No RBAC on the dashboard** — it controls API spend and prod infra; needs
   viewer/editor/admin roles.
8. **No real distributed tracing** — local per-run JSON only.
9. **No backup/restore drills.** SQLite file + JSON state + outputs volume all
   unbacked-up.
10. **No migration tooling** — schema changes are ad-hoc `CREATE TABLE IF NOT
    EXISTS` across two DB singletons.
11. **No stream consumption** — adapter interface has streaming but the loop
    never uses it; dashboard "live" view polls files instead of streaming
    tokens.
12. **Scheduler is non-durable** — restart drops in-flight schedules; missed
    firings are not caught up.
13. **Test coverage missing** on exactly the security-sensitive code that will
    move (sandbox, auth, agent loop, executors).

---

## Part 2 — Target Architecture

### 2.1 Architecture overview

```
                         ┌──────────────────────────────┐
                         │   Management Dashboard (SPA) │
                         │   React + Vite + TanStack     │
                         │   RBAC: viewer/editor/admin  │
                         └──────────────┬───────────────┘
                                        │ REST + WS (JWT)
                         ┌──────────────▼───────────────┐
                         │   Control Plane API (Express) │
                         │  • runners / prompts / queues  │
                         │  • audit log / RBAC / budgets  │
                         │  • KEDA ScaledObject mgmt      │
                         │  • emits task enqueues          │
                         └──────┬───────────────┬─────────┘
                                │               │
              enqueue task      │               │ read/broadcast session
                                │               │
                  ┌─────────────▼───┐  ┌────────▼─────────┐
                  │   Task Queue     │  │  Postgres         │
                  │   (Redis Streams │  │  • sessions       │
                  │    or NATS Jet-  │  │  • messages       │
                  │    Stream)       │  │  • prompts (v)    │
                  │   + DLQ per queue│  │  • runs            │
                  └────────┬─────────┘  │  • audit_log      │
                           │            │  • budgets        │
            KEDA scale on   │            │  • anomalies      │
            queue depth ────┼─────►      └────────┬──────────┘
                           │                     │
              ┌────────────▼─────────────────────▼────────┐
              │  Runner Deployment (long-lived, stateless) │
              │  replicas 1..N (KEDA), gVisor/Kata pod    │
              │  • pulls task from queue                   │
              │  • loads session from Postgres/Redis cache │
              │  • runs agent loop (existing src/agent-loop)│
              │  • streams tokens over WS back to control   │
              │  • writes files to RWX volume (locked)     │
              │  • checkpoints at task boundaries           │
              │  • emits OTel spans → OTLP collector        │
              └────────────┬───────────────────┬────────────┘
                           │                   │
              ┌────────────▼─────────┐   ┌─────▼──────────────┐
              │  RWX Output Volume    │   │  OTel Collector +    │
              │  (per-project subtree)│  │  backend (Tempo/Jae- │
              │  + path validator      │  │  ger, Prometheus,    │
              │  + advisory file lock  │  │  Loki)              │
              └───────────────────────┘   └─────────────────────┘
```

### 2.2 Runner layer

- **Deployment, not Job.** Runners are long-lived, stateless pods. A pod pulls
  work from the queue, processes one task at a time (configurable concurrency
  cap), ACKs on completion, pulls the next. Crash → KEDA/Deployment reschedules;
  the unacked message is redelivered by the queue after a visibility timeout.
- **Scaling signal = queue depth, not CPU.** KEDA `ScaledObject` on the queue's
  `approximate_message_count` (or NATS `AckPending`). LLM workloads are
  I/O-bound; CPU would never trigger. `cooldownPeriod`, `pollingInterval`,
  `minReplicaCount: 1`, `maxReplicaCount` per-queue-tied-to-model-provider.
- **Session state externalized.** Sessions/messages live in Postgres
  (`sessions`, `messages`); a Redis cache fronts the hot path so a runner
  resuming a session doesn't reload the full transcript from Postgres on every
  turn. On restart the new pod loads session by `session_id` and continues.
- **File-output handling:**
  - Env-configurable output root: `OUTPUT_ROOT` (PVC mount path).
  - Layout: `OUTPUT_ROOT/<project>/<prompt_version>/<model>/<run_id>/files/...`.
    Mapping (prompt/project → parent folder, per-model subfolder pattern) is
    stored in Postgres and editable from the dashboard with a folder-tree
    preview before save.
  - Path validation reuses `safeResolve`/`isWithin` but the allowed root is the
    run's assigned subtree, not the whole `OUTPUT_ROOT`. Any path resolving
    outside the assigned subtree is rejected and logged.

### 2.3 Reliability & fault tolerance

- **Idempotent task retries.** Every enqueue carries a deterministic
  `task_id = sha256(prompt_version + model + config_hash + run_id)`. File writes
  are staged to a temp dir (`.../<run_id>/.staging-<attempt>/`) and renamed
  atomically to the final path only on task success. A retried task detects a
  completed `result.json` and skips re-execution. Model API calls are gated by a
  `model_calls` table with `(task_id, turn)` uniqueness — a retry resumes from
  the highest persisted turn, not from turn 0.
- **Checkpointing at task boundaries.** Checkpoint = one completed turn
  (assistant message + tool results persisted to `messages` + `conversation.json`
  flushed). A retried task resumes from the last persisted turn. **Never**
  checkpoint mid-tool-execution (a partial `run_shell_command` result is not a
  checkpoint boundary). Expensive model calls are not re-run if their result is
  already in `model_calls`.
- **Circuit breaker per provider.** Per-provider `(provider, model)` circuit
  breaker: trips after N consecutive 5xx/timeouts in a window; while open,
  tasks for that provider are re-queued to a backup model (if configured) or
  parked in DLQ after the retry budget. Half-open state probes with one task.
- **Model fallback/failover.** Per-prompt/per-project `fallback_chain` config
  (e.g. primary `gpt-4o`, fallback `claude-3.7`). Fallback triggers on
  circuit-open, on `api_error` stop reason after retries, or on budget block.
- **DLQ policy.** Per-queue retry budget (default 5 attempts, exponential
  backoff). After threshold → moved to `<queue>_dlq` with the last error,
  attempt count, and original payload. DLQ items surface in the dashboard with
  retry/cancel/reprioritize controls and require manual review to clear.
- **RTO/RPO per task type, not blanket:**
  | Task class | RTO | RPO | Notes |
  |---|---|---|---|
  | Interactive chat turn | 30s | 0 (sync to Postgres) | User is waiting |
  | Batch prompt run | 5min | 1 turn (≤ ~30s of work) | Resumable from checkpoint |
  | Scheduled regression | 1h | 0 (idempotent re-run) | Can re-run from scratch |
  | Judge evaluation | 15min | 0 | Re-runnable |

### 2.4 Multi-runner coordination

- **Locking on shared output volumes.** RWX volume (NFS / CephFS / cloud file
  store) shared across runners. Writes to a run's subtree are guarded by an
  **advisory file lock** (`flock` on `<run_id>/.lock`) acquired before any write
  and held for the task duration. Concurrent attempts to write the same run_id
  (a bug, not a feature) fail fast. Per-file writes use atomic `rename` from a
  staging path.
- **Distributed tracing across handoffs.** Every task carries a `trace_id`
  (W3C traceparent). The control plane starts a span on enqueue; the runner
  continues it on dequeue; model calls and tool executions are child spans
  (existing `span-helpers.ts` shapes preserved). OTLP exporter → collector →
  Tempo/Jaeger. Cross-pod handoffs (enqueue → dequeue → model → tool → write)
  reconstruct into a single trace tree.

### 2.5 Security & governance

- **Sandboxed execution.** Runner pods run under **gVisor** (default) or **Kata
  Containers** (for runs needing a real kernel). Pod Security Admission
  `restricted`; `runAsNonRoot`, `readOnlyRootFilesystem` except the mounted
  output volume, dropped Linux capabilities, seccomp `RuntimeDefault`. The
  model's `run_shell_command` executes inside the sandboxed pod — no longer
  touching the host Node process.
- **Prompt-injection defense.** When previously generated files are fed back as
  context: (a) files are wrapped in a delimited `<arena_file path="...">` block
  with a system instruction that file contents are data, not instructions; (b)
  a heuristic filter flags control-flow tokens (`</system>`, `task_complete`
  inside file content) for review; (c) high-risk tool calls
  (`run_shell_command` whose command appears in a file the model previously
  wrote) require an explicit user/dasher confirmation in interactive mode.
- **Data lineage.** Every output file gets a sidecar `<file>.lineage.json`
  recording: `run_id`, `prompt_id` + `prompt_version`, `model` + `model_version`,
  `config_hash`, `task_id`, `trace_id`, `produced_at`, `produced_by_tool`. A
  `files` table in Postgres mirrors this for queryability. Dashboard can show
  lineage for any file.
- **RBAC on dashboard.** Three roles: `viewer` (read-only), `editor` (create/edit
  prompts, launch runs, manage queues), `admin` (manage runners, scale, secrets,
  RBAC itself). Roles stored in Postgres `users`/`roles` tables; JWT carries
  role claims. Existing flat API-key permissions map onto the viewer/editor
  scopes.
- **Secrets rotation.** Provider API keys in Kubernetes `Secret`s (one per
  provider), mounted as env or via `SecretsProvider`. Dashboard UI **masks**
  values (shows last 4 chars + last-rotated timestamp). Rotation = update Secret
  + restart runner Deployment (rolling). No raw key ever appears in the UI or
  API response. `apiKeyEnv` config convention is preserved.

### 2.6 Operational practices

- **Schema versioning.** Adopt **Prisma** (or Drizzle Kit) for migrations.
  Consolidate the two `better-sqlite3` singletons into one client. Migration
  files versioned in `db/migrations/`; `migrate` runs as an init container
  before the control plane and runners start. Anomaly module's ad-hoc
  `CREATE TABLE IF NOT EXISTS` is folded into the migration set.
- **Deployment strategy.** Runner updates use **canary** (e.g. 10% of replicas
  on the new image, observe error/latency for 15min, then ramp). Control-plane
  updates use **blue/green** via two Services + a selector flip, so active
  WebSocket sessions drain on the old version before cutover. KEDA's
  `minReplicaCount: 0` is NOT used for the canary — keep at least one warm.
- **Backup/restore.** Schedule:
  - Postgres: WAL archiving + daily base backup, 30-day retention, monthly
    restore drill into a scratch namespace.
  - Queue (Redis): AOF + RDB snapshots; if NATS JetStream, file-based stream
    snapshots. DLQs are **not** purged by backup rotation.
  - Output volume: cloud-provider snapshot of the RWX volume daily; restore
    drill quarterly.
  - Drill results recorded in the audit log.

### 2.7 Dashboard scope (additions to existing UI)

The existing dashboard already covers live PM2 cards, run detail transcript,
scenario/model CRUD, comparisons, cost, analytics, anomalies. The migration
**replaces** the PM2-card surface with runner management and **adds**:

- **Runner management:** list pods (name, status, current task, uptime, restarts,
  CPU/mem), manual scale/drain/restart controls, logs tail.
- **Statistics:** tasks per runner, per model, p50/p95/p99 latency, token usage
  + cost, queue-depth trends, success/failure rates over time.
- **Prompt management:** create/edit/version/tag prompts, diff versions, mark a
  version `stable`.
- **Queue management:** view/retry/cancel/reprioritize tasks, per-queue
  concurrency limits, DLQ visibility and manual review workflow.
- **Global output-location mapping:** prompt/project → parent folder, per-model
  subfolder pattern, folder-tree preview before saving.
- **Model comparison view:** side-by-side responses per prompt across models
  (existing comparison feature extended to live/interactive sessions, not just
  batch runs).
- **Cost/budget alerts:** per-model/per-provider budget with the existing
  80% warn / 100% block thresholds, plus configurable alert routing
  (Slack/email/webhook).
- **Audit log:** who changed which prompt/queue/output mapping/runner config,
  when, and the diff. Append-only `audit_log` table.
- **Notifications:** Slack/email on repeated task failures (N failures in M
  minutes per queue), runner crash loops, DLQ growth, budget threshold crossings.

---

## Part 3 — Phased Implementation Roadmap

Phases are ordered by dependency. Each phase is independently shippable and
leaves the existing PM2 path working (brownfield migration — never break the
working CLI during transition).

### Phase 0 — Foundation & hardening *(prerequisite, ~1–2 weeks)*

**Goal:** make the codebase safe to containerize and migrate state off files.

- 0.1 Adopt Prisma/Drizzle migrations; consolidate DB clients; fold anomaly
  tables under migration tracker.
- 0.2 Replace `runs-index.json` with a `runs` SQLite table (still local);
  backfill from existing JSON. Removes the highest corruption risk before any
  multi-pod work.
- 0.3 Make `OUTPUT_ROOT` env-configurable (`paths.ts`); move `outputs/` under it.
- 0.4 Add tests for `src/sandbox/` escape prevention, `src/agent-loop/` loop
  stop conditions, `src/tools/executors.ts` limits, dashboard auth/JWT.
- 0.5 Fix the asymmetric shell-injection defense: apply `SHELL_METACHAR_RE`
  filtering (or, better, an allow-listed command parser) to the model's
  `run_shell_command` too, not just the evaluator.

**Exit gate:** migration tooling in place; `runs-index.json` gone; tests green.

### Phase 1 — Containerize + stateless worker refactor *(~2–3 weeks)*

**Goal:** runnable container image; worker pulls task from a queue instead of
being spawned per-run.

- 1.1 Write `Dockerfile` (multi-stage: build → runtime; non-root user; distroless
  or node:slim base).
- 1.2 Introduce a queue abstraction (`src/queue/` interface) with an in-memory
  implementation that preserves current PM2 behavior (strangler pattern).
- 1.3 Refactor `worker.ts` into a long-lived `runner.ts`: connect to queue, pull
  task, load session from DB, run loop, persist turn checkpoints, ACK. Keep the
  existing `runAgentLoop` core unchanged.
- 1.4 Externalize session state: add Postgres (start with SQLite via Prisma for
  dev) `sessions` + `messages` tables; `ConversationLogger` writes to DB +
  file (dual-write during migration).
- 1.5 Containerize the dashboard too.

**Exit gate:** `docker run` a runner against the in-memory queue; existing CLI
unchanged.

### Phase 2 — Real queue + KEDA + k8s *(~2–3 weeks)*

**Goal:** runners scale on queue depth in a real cluster.

- 2.1 Pick + stand up the queue (see Q1). Implement the queue adapter for it.
- 2.2 k8s manifests (or Helm chart): Runners `Deployment`, Control Plane
  `Deployment` + `Service`, `Ingress`, `HorizontalPodAutoscaler` (or KEDA
  `ScaledObject`).
- 2.3 KEDA `ScaledObject` on queue depth; per-provider queue → per-provider
  Deployment so a failing provider doesn't block others.
- 2.4 DLQ topic/queue per provider; retry policy in the queue adapter.
- 2.5 gVisor `RuntimeClass`; Pod Security Admission `restricted`.
- 2.6 CI/CD pipeline: build image, push, deploy to a staging namespace.

**Exit gate:** staged canary deploy; queue depth drives replica count; failing
provider isolated.

### Phase 3 — Reliability features *(~2–3 weeks)*

**Goal:** production-grade fault tolerance.

- 3.1 Idempotency: `task_id` hashing, staging-dir + atomic-rename file writes,
  `model_calls` dedupe table.
- 3.2 Checkpoint resume: runner loads highest persisted turn on dequeue of a
  retried task.
- 3.3 Circuit breaker per provider (half-open probe, fallback chain wiring).
- 3.4 RBAC: `users`/`roles` tables, JWT role claims, dashboard role gates,
  migrate flat API-key permissions onto viewer/editor scopes.
- 3.5 Audit log table + UI surface for all config mutations.
- 3.6 Output-volume `flock` advisory locking + atomic-rename write path.

**Exit gate:** kill a runner mid-task → task resumes on another pod without
duplicate writes or duplicate model calls.

### Phase 4 — Observability + security hardening *(~2 weeks)*

- 4.1 Real OTel: add `@opentelemetry/*` SDK, OTLP exporter, collector
  deployment, Tempo/Jaeger backend, Prometheus metrics, Loki logs.
- 4.2 Cross-pod trace propagation through the queue (traceparent in message
  headers).
- 4.3 Prompt-injection defenses (delimited file blocks, heuristic filter,
  confirmation flow for risky tool calls).
- 4.4 Data lineage sidecars + `files` table + dashboard lineage view.
- 4.5 Secrets rotation runbook + masked UI; first rotation drill.
- 4.6 Backup + restore drills for Postgres, queue, and output volume.

**Exit gate:** a single trace covers enqueue → dequeue → model call → tool →
file write across pods; restore drill passes.

### Phase 5 — Dashboard + scheduler migration *(~2–3 weeks)*

- 5.1 Runner management UI (replaces PM2 cards), including drain/restart.
- 5.2 Prompt versioning UI (create/edit/version/tag/diff).
- 5.3 Queue management UI (retry/cancel/reprioritize/DLQ review).
- 5.4 Output-location mapping UI with folder-tree preview.
- 5.5 Cost/budget alerts per provider + Slack/email routing.
- 5.6 Migrate scheduler off in-process `setTimeout` to a durable scheduler
  (k8s `CronJob` emitting enqueues, or a durable cron library backed by
  Postgres); catch up missed firings.
- 5.7 Streaming tokens: wire `sendMessageStream` through WS to the dashboard
  live view (replaces file polling).

**Exit gate:** dashboard controls production runners; no PM2 references remain
in the runtime path.

### Phase 6 — Decommission *(~1 week)*

- 6.1 Remove PM2 dependency and `ecosystem.config.cjs`.
- 6.2 Remove the in-memory queue adapter.
- 6.3 Remove dual-write to `conversation.json` (DB becomes source of truth;
  file kept as export only).
- 6.4 Update README/AGENTS.md/deployment docs.

**Total rough estimate: 12–17 weeks** for a single engineer working
part-time; compressible with parallelization on Phases 4 and 5.

### Dependency graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 6
                                   │
                                   └─► Phase 4 ──► Phase 5 ──► Phase 6
```

Phase 0 is non-negotiable first (removes the `runs-index.json` corruption risk
and adds the safety tests that gate every later phase). Phases 3, 4, 5 can
overlap once Phase 2 lands. Phase 6 only after the dashboard fully controls
runners.

---

## Part 4 — Decisions (resolved 2026-07-20)

All open questions answered. Decisions below are binding for implementation.

### D1 — Queue technology: **Redis Streams** (self-hosted in-cluster)
Redis Streams + consumer groups. DLQ via dead-letter stream. KEDA Redis Streams
scaler. AOF + RDB snapshots for persistence. **Redis itself runs self-hosted in
the minikube cluster** — a Redis Deployment + `PersistentVolumeClaim` (or the
Bitnami `redis` Helm chart) inside the same cluster as the runners, not an
external managed service. Implications:
- Single-node minikube means Redis HA/failover semantics can't truly be
  tested (single pod, single PVC). That's acceptable for dev; revisit when
  promoting to a real cluster.
- Redis PVC uses the same minikube storage as the output volume (hostPath or
  `minikube mount`).
- AOF + daily RDB snapshot into the PVC; backup is `kubectl cp` / volume
  snapshot for now. Restore drill deferred to a real cluster.
- KEDA's Redis Streams scaler reads from the same in-cluster Redis.
- **Chosen over NATS/RabbitMQ/Kafka for operational simplicity; the same Redis
  instance is also used for session caching (D2).**

### D2 — Primary datastore: **Postgres**
Multi-pod writers need a real multi-writer DB. SQLite stays only for local dev
via Drizzle's SQLite provider behind the same schema. Migration happens in
Phase 1.

### D3 — Migration tooling: **Drizzle Kit**
TypeScript-native, matches existing `better-sqlite3` choice, migrates to
Postgres cleanly. Adopted in Phase 0.

### D4 — RWX storage backend: **minikube local**
Target cluster is local minikube. For dev: `minikube mount` or a `hostPath`
PVC with `ReadWriteMany` access mode (sufficient for single-node minikube).
Production storage backend deferred — revisit when promoting off minikube.
**(Implication: RWX semantics can't truly be tested until a real multi-node
cluster exists; flock + atomic-rename still implemented for correctness, but
multi-pod concurrent-write testing happens post-minikube.)**

### D5 — Target Kubernetes cluster: **local minikube**
Dev target is local minikube. Implications:
- gVisor/Kata available only if minikube is started with a container runtime
  that supports them (e.g. `--container-runtime=containerd` + gVisor addon, or
  `--driver=none` on a Linux host). On Windows (current dev env) gVisor is
  **not available** — sandboxing in minikube on Windows falls back to
  Pod Security Admission `restricted` + seccomp `RuntimeDefault` only.
  gVisor hardening is deferred until the workload runs on a Linux host/cluster.
- KEDA installed via Helm into minikube.
- No cloud Ingress; use `minikube tunnel` + `NodePort`/`LoadBalancer` for the
  dashboard.
- Single-node means horizontal scaling is simulated (multiple pods on one node).
- **Action item for Phase 2:** document the minikube startup flags and any
  platform-specific limitations in the deployment README.

### D6 — Container sandbox runtime: **gVisor (target), seccomp fallback (minikube/Windows)**
gVisor is the target sandbox runtime. On minikube on Windows where gVisor isn't
available, fall back to Pod Security Admission `restricted` + seccomp
`RuntimeDefault` + `runAsNonRoot` + `readOnlyRootFilesystem`. The runner image
and pod spec must work under both. The deployment README must call out which
hardening is active on which platform.

### D7 — Model providers: **all 70+ providers like opencode**
The current 5 adapters (OpenAI-compat, Anthropic, Google, Bedrock) are the
starting set. The provider registry must be extended to cover the same 70+
provider surface as opencode's configuration (per-provider base URL, auth,
model lists, capability flags). Provider configuration moves from YAML to
Postgres-backed registry (extending the existing `catalog` schema) with a
dashboard CRUD UI. Each provider gets its own queue + KEDA ScaledObject so a
failing provider is isolated. **Phasing:** OpenAI + Anthropic first in Phase 2
(stable path), full 70+ provider rollout happens across Phases 2–3 with a
per-provider adapter pattern + capability flags (streaming, tool-calling,
vision) gated by a `providers.capabilities` column.

### D8 — Dashboard auth: **local users in Postgres**
Local users + roles (`viewer`/`editor`/`admin`) in Postgres `users`/`roles`
tables. JWT carries role claims. No OIDC/SSO. Passwords hashed with
`argon2id` (replaces current plaintext env-var storage). Migrate existing
`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` env vars into the seed admin user
during Phase 3; remove the env-var path in Phase 6.

### D9 — Dependency audit (Q9): **clean**
`npm audit`: **0 vulnerabilities**. `npm outdated` shows major-version bumps
available (express 4→5, zod 3→4, commander 12→15, typescript 5→7, pino 9→10,
js-yaml 4→5, dotenv 16→17, concurrently 9→10). **These are not blockers** —
they are tracked as an optional Phase 0 hardening follow-up. Express 5 and Zod
4 are the only ones likely to need real migration work; both deferred until
the codebase is otherwise stable.

### D10 — Dashboard live view: **WebSocket streaming**
Runners stream tokens over WebSocket to the dashboard via the control plane.
The existing `sendMessageStream` adapter method is wired through. Replaces the
current file-polling live view. Backpressure handled by the WS library's
built-in flow control; runner drops tokens if the client falls behind more than
N seconds (configurable, default 30s) and the client re-syncs on reconnect.

### D11 — `outputs/` history migration: **backfill**
Existing `conversation.json` files are backfilled into the new `messages`
table as a one-time offline job, gated behind a feature flag
(`ARENA_BACKFILL_CONVERSATIONS=true`). Job is idempotent — re-runs skip already
imported `(runId, turnIndex)` pairs. Happens once Phase 1's `messages` table
exists; runs as a standalone CLI command `ai-arena backfill conversations`.

### D12 — API key rotation cadence: **none**
No formal rotation policy. Secrets rotation runbook (Phase 4.5) documents the
manual procedure (update K8s Secret + rolling restart) but no scheduled
rotation.

### D13 — Cost/budget alert routing: **in-dashboard only (for now)**
Cost/budget alerts surface in the dashboard's notification/audit-log surface
only. No Slack/email/webhook routing for budget alerts initially. Existing
Slack/Discord notification channels (for run completion, anomalies) remain
unchanged. Slack/email routing for budget alerts is a deferred follow-up —
leave a `notifications` config hook in place so it can be wired later without
schema changes.

---

## Appendix A — What does NOT change

To keep the migration scoped:
- The **agent loop core** (`src/agent-loop/loop.ts`) and **tool schemas**
  (`src/tools/schema.ts`) are preserved as-is. The runner is a new shell
  around them.
- **Provider adapter interface** (`ModelAdapter.sendMessage`) is unchanged;
  only the wiring (long-lived pull loop, streaming enablement) changes.
- **Scenario YAML format** and **starter-files convention** are unchanged.
- The **path-sandbox primitives** (`safeResolve`/`isWithin`) are reused; only
  the allowed-root configuration changes.
- The **OpenAPI spec** (`openapi.yaml`) is extended, not rewritten.

## Appendix B — Risks specific to this codebase

- **`runs-index.json` corruption** is the single biggest immediate risk. It
  should be retired in Phase 0 before any multi-pod work begins.
- **Two SQLite singletons** on the same DB file (`db/client.ts` and
  `anomaly-detection/db.ts`) will silently diverge under concurrent writes if
  not consolidated.
- **Scheduler non-durability** means any k8s rollout that restarts the control
  plane during a scheduled firing silently drops it — must be migrated before
  the PM2 path is removed.
- **README overstates OTel support.** Anyone planning observability work on the
  assumption that OTel is wired will be surprised; the design above treats it
  as greenfield (Phase 4.1).
- **Asymmetric shell-injection defense** (evaluator hardened, model tool not)
  is a latent security bug that must be fixed in Phase 0.5 before runners are
  exposed to untrusted model output in a shared cluster.

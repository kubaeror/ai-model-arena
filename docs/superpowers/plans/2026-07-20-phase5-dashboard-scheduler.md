# Phase 5 — Dashboard & Scheduler Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PM2-card dashboard surface with runner management; add prompt versioning, queue management, output-location mapping, cost alerts; migrate the scheduler off in-process `setTimeout` to durable k8s `CronJob`s; wire streaming tokens over WebSocket.

**Architecture:** New dashboard routes call k8s APIs (via `@kubernetes/client-node`) for runner CRUD; queue management calls the Redis driver directly; prompt versioning is a new `prompts` table; output mapping is a new `output_mappings` table; scheduler becomes a k8s `CronJob` that enqueues tasks (no in-process state); streaming uses the existing `sendMessageStream` adapter method piped through the control-plane WS.

**Tech Stack:** React, TanStack Query, `@kubernetes/client-node`, k8s `CronJob`, existing Express + WS.

## Global Constraints

- All Phase 3 + 4 infra intact.
- The dashboard runs IN the cluster (Phase 2.6) and talks to k8s via in-cluster ServiceAccount credentials (RBAC-bound).
- The existing in-process scheduler (`src/scheduler/`) is NOT deleted in this phase — it's superseded by the k8s CronJob path. Phase 6 removes it.
- D7 (70+ providers): the provider registry is extended to a full CRUD UI; per-provider queue + KEDA ScaledObject management is exposed.
- D10 (WebSocket streaming): runners stream tokens to the control plane over a WS; the dashboard subscribes per session.
- D13 (in-dashboard cost alerts only): budget alerts surface in the notification/audit-log UI; no Slack/email routing yet (hook left in place).

---

## File Structure (Phase 5)

- Create: `src/dashboard-server/routes/runners.ts` — list/scale/drain/restart pods via k8s API.
- Create: `src/dashboard-server/routes/queues.ts` — view/retry/cancel/reprioritize/DLQ.
- Create: `src/dashboard-server/routes/prompts.ts` — CRUD + version/tag/diff.
- Create: `src/dashboard-server/routes/output-mappings.ts` — prompt/project → folder mapping.
- Create: `src/dashboard-server/routes/stream.ts` — WS gateway for token streaming from runners.
- Modify: `src/dashboard-server/routes/cost.ts` — in-dashboard alert surface.
- Modify: `src/runner.ts` — stream tokens to the control plane over WS.
- Modify: `src/providers/adapters/base.ts` — `sendMessageStream` is now the primary path.
- Modify: `src/agent-loop/loop.ts` — consume the stream, emit tokens via callback.
- Modify: `src/db/schema.ts` + `schema-pg.ts` — `prompts`, `prompt_versions`, `output_mappings` tables.
- Create: `k8s/scheduler-cronjob.yaml` — durable scheduler.
- Modify: `src/scheduler/` — keep as a CLI tool to manage schedules (writes to `schedules` table read by the CronJob).
- Create: `src/dashboard-client/src/pages/Runners.tsx`
- Create: `src/dashboard-client/src/pages/Queues.tsx`
- Create: `src/dashboard-client/src/pages/Prompts.tsx`
- Create: `src/dashboard-client/src/pages/OutputMappings.tsx`

---

## Task 5.1: Runner management UI + API

**Files:**
- Create: `src/dashboard-server/routes/runners.ts`
- Create: `src/dashboard-client/src/pages/Runners.tsx`
- Modify: `src/dashboard-server/server.ts` — mount the route.
- Install: `@kubernetes/client-node`

- [ ] **Step 1: Install k8s client**

`npm install @kubernetes/client-node`

- [ ] **Step 2: Implement `src/dashboard-server/routes/runners.ts`**

Endpoints (all `requireRole`):
- `GET /api/v1/runners` (viewer) — list pods across `ai-arena` with label `app=runner`; return name, provider, status, current task (from pod annotation), uptime, restarts, CPU/mem (from metrics API if available).
- `POST /api/v1/runners/:name/scale` (admin) — patch the Deployment's `replicas`.
- `POST /api/v1/runners/:name/drain` (admin) — cordon + evict (or simply scale to 0 after current task ACKs; for minikube, scale-to-0-with-grace).
- `POST /api/v1/runners/:name/restart` (admin) — `kubectl rollout restart` equivalent (delete pod; Deployment recreates).
- `GET /api/v1/runners/:name/logs` (viewer) — stream pod logs.

Use `@kubernetes/client-node`'s `CoreV1Api` + `AppsV1Api`. In-cluster, the client auto-loads the ServiceAccount token.

- [ ] **Step 3: RBAC for the dashboard ServiceAccount**

Create `k8s/dashboard-rbac.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: dashboard, namespace: ai-arena }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: dashboard, namespace: ai-arena }
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch, delete]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, list, patch]
  - apiGroups: [keda.sh]
    resources: [scaledobjects]
    verbs: [get, list, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: dashboard, namespace: ai-arena }
roleRef: { kind: Role, name: dashboard, apiGroup: rbac.authorization.k8s.io }
subjects: [{ kind: ServiceAccount, name: dashboard, namespace: ai-arena }]
```

Patch the dashboard Deployment to use `serviceAccountName: dashboard`.

- [ ] **Step 4: React UI `Runners.tsx`**

A table: pod name, provider, status, current task, uptime, restarts, CPU/mem. Actions (admin): scale (input + button), drain, restart, logs (modal). TanStack Query polls `GET /api/v1/runners` every 5s.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
# manual: open dashboard → Runners page → scale a provider's replicas
git add src/dashboard-server/routes/runners.ts src/dashboard-client/src/pages/Runners.tsx k8s/dashboard-rbac.yaml package.json
git commit -m "feat(dashboard): runner management UI + k8s API"
```

---

## Task 5.2: Prompt versioning UI + API

**Files:**
- Modify: `src/db/schema.ts` + `schema-pg.ts` — `prompts`, `prompt_versions`.
- Create: `src/dashboard-server/routes/prompts.ts`
- Create: `src/dashboard-client/src/pages/Prompts.tsx`

- [ ] **Step 1: Schema**

```ts
export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});
export const prompt_versions = sqliteTable('prompt_versions', {
  id: text('id').primaryKey(),
  prompt_id: text('prompt_id').notNull().references(() => prompts.id),
  version: integer('version').notNull(),
  system_prompt: text('system_prompt').notNull(),
  task: text('task').notNull(),
  config: text('config'),        // JSON
  tag: text('tag'),              // 'stable' | 'experimental' | null
  created_at: text('created_at').notNull(),
  created_by: text('created_by').notNull(),
  UNIQUE(prompt_id, version),
});
```

Mirror + migrate.

- [ ] **Step 2: API `prompts.ts`**

- `GET /api/v1/prompts` — list.
- `POST /api/v1/prompts` (editor) — create + v1 (audit-logged).
- `PUT /api/v1/prompts/:id` (editor) — create a new version (bumps version, audit-logged).
- `GET /api/v1/prompts/:id/versions` — list versions.
- `GET /api/v1/prompts/:id/diff?v1=&v2=` — unified diff of `system_prompt` + `task` between two versions (use `diff` npm package).
- `POST /api/v1/prompts/:id/versions/:vid/tag` (editor) — set `tag`.

- [ ] **Step 3: UI `Prompts.tsx`**

List + create form (name, description). Detail view: version list, "New version" editor (CodeMirror for system_prompt + task), diff viewer (select two versions → render unified diff), tag selector.

- [ ] **Step 4: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/db/ src/dashboard-server/routes/prompts.ts src/dashboard-client/src/pages/Prompts.tsx drizzle/
git commit -m "feat(dashboard): prompt versioning UI + API with diffs"
```

---

## Task 5.3: Queue management UI + API

**Files:**
- Create: `src/dashboard-server/routes/queues.ts`
- Create: `src/dashboard-client/src/pages/Queues.tsx`

- [ ] **Step 1: API `queues.ts`**

- `GET /api/v1/queues` — list per-provider streams with depth (`XLEN`), consumer group lag (`XPENDING` counts), DLQ depth.
- `GET /api/v1/queues/:provider/tasks` — peek the stream (`XRANGE` first N).
- `POST /api/v1/queues/:provider/tasks/:id/retry` (editor) — move a DLQ entry back to the main stream (audit-logged).
- `POST /api/v1/queues/:provider/tasks/:id/cancel` (editor) — `XDEL` from the stream/DLQ (audit-logged).
- `POST /api/v1/queues/:provider/tasks/:id/reprioritize` (editor) — re-`XADD` with a new ID (Redis stream IDs are time-ordered; use `XADD stream <ms>-0 ...` to front-load).
- `POST /api/v1/queues/:provider/concurrency` (admin) — patch the KEDA `ScaledObject`'s `maxReplicaCount`.

- [ ] **Step 2: UI `Queues.tsx`**

Per-provider cards: depth, lag, DLQ count, max replicas (editable). Expandable task list with retry/cancel/reprioritize buttons. DLQ tab with manual-review workflow (mark resolved → audit log).

- [ ] **Step 3: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/dashboard-server/routes/queues.ts src/dashboard-client/src/pages/Queues.tsx
git commit -m "feat(dashboard): queue management UI + DLQ review workflow"
```

---

## Task 5.4: Global output-location mapping UI + API

**Files:**
- Modify: `src/db/schema.ts` + `schema-pg.ts` — `output_mappings`.
- Create: `src/dashboard-server/routes/output-mappings.ts`
- Create: `src/dashboard-client/src/pages/OutputMappings.tsx`

- [ ] **Step 1: Schema**

```ts
export const output_mappings = sqliteTable('output_mappings', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),        // 'prompt' | 'project'
  scope_id: text('scope_id').notNull(),  // prompt_id or project name
  parent_folder: text('parent_folder').notNull(),  // relative to OUTPUT_ROOT
  per_model_pattern: text('per_model_pattern').notNull(), // e.g. '{model}/{runId}'
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});
```

- [ ] **Step 2: API**

- `GET /api/v1/output-mappings` — list.
- `PUT /api/v1/output-mappings/:id` (editor) — update (audit-logged).
- `POST /api/v1/output-mappings/preview` (viewer) — given a mapping + a sample runId/model, return the resolved path tree (a small JSON tree for the UI to render as a folder preview).

- [ ] **Step 3: Wire into the runner**

`src/runner.ts` resolves the output path for a task by looking up the mapping (by prompt_id → fallback to project → fallback to default `<model>/<runId>`).

- [ ] **Step 4: UI `OutputMappings.tsx`**

Table of mappings. Editor for parent_folder + per_model_pattern (with a pattern reference: `{model}`, `{runId}`, `{prompt}`, `{version}`). A live preview pane renders the resolved tree for a sample input before save.

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/db/ src/dashboard-server/routes/output-mappings.ts src/dashboard-client/src/pages/OutputMappings.tsx src/runner.ts drizzle/
git commit -m "feat(dashboard): global output-location mapping with folder-tree preview"
```

---

## Task 5.5: Cost/budget alerts (in-dashboard only, per D13)

**Files:**
- Modify: `src/dashboard-server/routes/cost.ts` — add an in-dashboard alert surface.
- Modify: `src/dashboard-client/` — a notifications banner + cost page.

- [ ] **Step 1: Alert surface**

When a budget threshold (80% warn / 100% block, from `configs/budget.yaml` — or migrate to a `budgets` table) is crossed, write a row to `audit_log` (action: `budget.threshold`) AND to a `notifications` in-memory list (or a `notifications` table if you want persistence). The dashboard's notification banner polls `GET /api/v1/notifications`.

- [ ] **Step 2: Hook in the budget check**

In the run-launch path (Phase 2.2 enqueue), check the budget before enqueuing; on block, write the alert + return 402 Payment Required. On warn, enqueue but write the alert.

- [ ] **Step 3: UI**

A bell icon in the navbar showing unread notifications; click → a notifications panel listing budget alerts (model, threshold, %, time, "mark read"). A Cost page with per-model spend vs. budget bars.

- [ ] **Step 4: Leave the routing hook**

In `src/notifications/`, keep the existing Slack/Discord routing for run-completion/anomaly events (unchanged). Add a commented `// TODO Phase N: route budget alerts to Slack/email` at the alert-write site so future wiring needs no schema change (per D13).

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/dashboard-server/ src/dashboard-client/ src/notifications/
git commit -m "feat(cost): in-dashboard budget alerts (D13 — Slack/email deferred)"
```

---

## Task 5.6: Durable scheduler via k8s CronJob

**Files:**
- Create: `k8s/scheduler-cronjob.yaml`
- Modify: `src/scheduler/` — split: `manager.ts` becomes a CRUD tool over a `schedules` table; the actual firing is a CronJob.
- Modify: `src/db/schema.ts` + `schema-pg.ts` — `schedules` table.

- [ ] **Step 1: Schema**

```ts
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  scenario: text('scenario').notNull(),
  models: text('models').notNull(),      // JSON array
  cron: text('cron').notNull(),
  enabled: integer('enabled').notNull().default(1),
  last_run: text('last_run'),
  next_run: text('next_run'),
  created_at: text('created_at').notNull(),
});
```

- [ ] **Step 2: Refactor `src/scheduler/manager.ts`**

Remove the in-process `setTimeout` loop (lines ~108-114). `manager.ts` becomes a CRUD layer over the `schedules` table. `addSchedule`/`removeSchedule`/`listSchedules` now hit Postgres, not an in-memory Map.

- [ ] **Step 3: `k8s/scheduler-cronjob.yaml`**

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: arena-scheduler, namespace: ai-arena }
spec:
  schedule: "*/1 * * * *"   # every minute — the job checks which schedules are due
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: scheduler
              image: ai-arena/runner:latest
              command: ["node", "dist/scheduler/tick.js"]
              envFrom:
                - configMapRef: { name: runner-config }
                - secretRef: { name: provider-keys }
```

- [ ] **Step 4: Implement `src/scheduler/tick.ts`**

```ts
// Runs every minute via CronJob. Reads all enabled schedules, computes which
// are due (next_run <= now), enqueues a task per due schedule, updates last_run +
// next_run. Catches up missed firings: if last_run is far behind, enqueue once
// (not once-per-missed-minute).
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run lint && npm test
# manual: create a schedule due in 2 min, wait, confirm it enqueues
```

- [ ] **Step 6: Commit**

```bash
git add k8s/scheduler-cronjob.yaml src/scheduler/ src/db/ drizzle/
git commit -m "feat(scheduler): durable k8s CronJob + Postgres-backed schedules"
```

---

## Task 5.7: Streaming tokens over WebSocket

**Files:**
- Modify: `src/providers/adapters/base.ts` — `sendMessageStream` becomes the primary path.
- Modify: `src/agent-loop/loop.ts` — consume the stream, emit tokens via an `onToken` callback.
- Modify: `src/runner.ts` — connect a WS to the control plane, forward `onToken` deltas.
- Create: `src/dashboard-server/routes/stream.ts` — WS endpoint that re-broadcasts runner tokens to subscribed dashboard clients.

- [ ] **Step 1: Make `sendMessageStream` primary**

Each adapter (`openai-compat.ts`, `anthropic.ts`, etc.) implements `sendMessageStream` using the provider's SSE/streaming endpoint. The existing non-streaming `sendMessage` becomes a wrapper: collect the stream into a full `ModelResponse`. This keeps callers that don't consume the stream working.

- [ ] **Step 2: Add `onToken` to the agent loop**

`runAgentLoop` now takes `onToken?: (delta: string) => void`. Inside the loop, iterate the stream from `adapter.sendMessageStream(...)`, calling `onToken(delta)` per chunk, accumulating into the assistant message, then proceeding to tool execution as before.

- [ ] **Step 3: Runner → control-plane WS**

`src/runner.ts` opens a WS to `ws://dashboard:4000/runner?token=<runner-token>` (a new runner-auth token, separate from user JWT). On each `onToken(delta)`, send `{ type: 'token', sessionId, turn, delta }`. On turn complete, send `{ type: 'turn_complete', sessionId, turn }`.

- [ ] **Step 4: Control-plane re-broadcast `src/dashboard-server/routes/stream.ts`**

The dashboard WS gateway (existing `live.ts`) gains: runners connect on `/runner`; dashboard clients subscribe per session on `/ws`. The gateway maintains a `Map<sessionId, Set<clientWs>>` and forwards `token`/`turn_complete` messages from runners to subscribed clients.

- [ ] **Step 5: Backpressure**

If a dashboard client's WS buffer exceeds N seconds behind (default 30s, `STREAM_BACKPRESSURE_MS`), the gateway drops further `token` deltas for that client and sends a `{ type: 'resync' }` message; the client shows a "stream paused" indicator and re-syncs on `turn_complete`.

- [ ] **Step 6: UI**

The existing run-detail transcript view replaces its file-polling live update with WS `token` events: append deltas to the current assistant message in real-time. On `turn_complete`, finalize the message + scroll.

- [ ] **Step 7: Verify + commit**

```bash
npm run typecheck && npm run lint && npm test
# manual: open a run detail page, watch tokens stream live
git add src/providers/ src/agent-loop/ src/runner.ts src/dashboard-server/ src/dashboard-client/
git commit -m "feat(streaming): live token streaming runner→dashboard over WS"
```

---

## Phase 5 Exit Gate

- [ ] Runners page lists pods, scales, drains, restarts, tails logs (admin).
- [ ] Prompts page: CRUD + versioning + diff + tag.
- [ ] Queues page: depth/lag/DLQ, retry/cancel/reprioritize, concurrency edit.
- [ ] Output mappings: editable with live folder-tree preview; runner resolves paths from the mapping.
- [ ] Budget alerts surface in-dashboard; block at 100%, warn at 80%.
- [ ] Scheduler: a schedule created in the UI fires via the k8s CronJob; missed firings catch up.
- [ ] Live transcript streams tokens over WS; backpressure drops + resync works.
- [ ] `npm run typecheck && npm run lint && npm test` green.

## Phase 5 Self-Review

- **Spec coverage:** runner management (§2.7) → 5.1; prompt versioning (§2.7) → 5.2; queue management + DLQ (§2.3.5, §2.7) → 5.3; output mapping (§2.2, §2.7) → 5.4; cost alerts (§2.7, D13) → 5.5; durable scheduler (§1.10 gap, §2.6.1) → 5.6; streaming (D10, §2.7) → 5.7.
- **Placeholders:** none.
- **Type consistency:** `onToken(delta: string)` matches loop + runner + gateway. `output_mappings.scope` ('prompt'|'project') matches the resolver in `runner.ts`.
- **Dependencies:** 5.1 (runners) needs the k8s RBAC from Phase 2.6. 5.2-5.5 independent of each other. 5.6 (scheduler) needs the `schedules` table + CronJob. 5.7 (streaming) needs the adapter `sendMessageStream` (exists). All depend on Phase 3 (RBAC) + Phase 4 (lineage) being in place.

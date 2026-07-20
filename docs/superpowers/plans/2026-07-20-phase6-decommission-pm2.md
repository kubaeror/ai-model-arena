# Phase 6 — Decommission PM2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the PM2 dependency and the in-memory queue now that the dashboard fully controls production runners. The DB becomes the source of truth for chat history; `conversation.json` becomes an export-only artifact.

**Architecture:** Pure deletion + doc updates. No new code paths. The CLI is retained for local dev but now launches via the queue path (or directly invokes `runAgentLoop` in-process for a single-model quick-run) rather than spawning PM2 workers.

**Tech Stack:** TypeScript, Drizzle, existing.

## Global Constraints

- Only start this phase after Phase 5's exit gate passes (dashboard fully controls runners, scheduler is durable).
- Keep the CLI working end-to-end (`ai-arena run ...`) — it must NOT spawn PM2; it enqueues to the in-memory queue (for local dev) or Redis (if `REDIS_URL` set).
- Don't break the container image: `dist/worker.js` is no longer the entrypoint; `dist/runner.js` is. `dist/cli.js` stays.
- All historical data (`outputs/**/conversation.json`) is backfilled into `messages` (D11) before the file dual-write is removed.

---

## File Structure (Phase 6)

- Delete: `ecosystem.config.cjs`
- Delete: `ecosystem.config.js` (if present)
- Modify: `package.json` — remove `pm2` dep + PM2-related scripts.
- Modify: `src/cli.ts` — `run` command enqueues instead of `spawnRunWorkers`.
- Delete: `src/orchestrator/pm2-helpers.ts`
- Modify: `src/orchestrator/run-lifecycle.ts` — remove `spawnRunWorkers`, `finalizeRunByRunId` (PM2 polling), `restartRun` (PM2 restart). Keep the run-record creation + status updates.
- Delete: `src/types/pm2.d.ts`
- Modify: `src/logger/conversation-logger.ts` — remove the file dual-write (DB is source of truth).
- Modify: `src/worker.ts` — either delete (no PM2 entry needed) OR repurpose as a thin CLI helper that enqueues a single run. Repurpose is safer (keeps `npm run worker` script working for local single-run dev).
- Modify: `README.md`, `AGENTS.md` — remove PM2 references, document the k8s path.
- Delete: `scripts/smoke-stub.mjs`'s PM2 references (the smoke test stays; it just doesn't use PM2).
- Create: `scripts/backfill-conversations.ts` — the D11 one-shot backfill (gated by `ARENA_BACKFILL_CONVERSATIONS=true`).

---

## Task 6.1: Backfill historical `conversation.json` into `messages`

**Files:**
- Create: `scripts/backfill-conversations.ts`

**Goal:** D11 — existing `outputs/**/conversation.json` files imported into the `messages` table so removing the dual-write doesn't lose history.

- [ ] **Step 1: Implement the backfill script**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import { initDb, dbPath } from '../src/db/client.js';
import { createSessionStore } from '../src/session/store.js';
import { computeTaskId } from '../src/runner/idempotency.js';

async function main() {
  if (process.env.ARENA_BACKFILL_CONVERSATIONS !== 'true') {
    console.error('Set ARENA_BACKFILL_CONVERSATIONS=true to run the backfill.');
    process.exit(1);
  }
  initDb(dbPath());
  const store = createSessionStore();
  const root = process.env.OUTPUT_ROOT ?? path.join(process.cwd(), 'outputs');
  let count = 0;
  // walk outputs/<model>/<runId>/conversation.json
  for await (const file of findConversationFiles(root)) {
    const conv = JSON.parse(fs.readFileSync(file, 'utf8'));
    const runId = path.basename(path.dirname(file));
    const model = path.basename(path.dirname(path.dirname(file)));
    const sessionId = computeTaskId({ promptId: conv.promptId ?? 'legacy', promptVersion: conv.promptVersion ?? 0, model, configHash: 'legacy', runId });
    // idempotent: skip if session already has messages
    const existing = await store.listMessages(sessionId);
    if (existing.length > 0) continue;
    for (const turn of conv.turns ?? []) {
      await store.appendMessage(sessionId, { turn: turn.index, role: turn.role, content: turn.content, toolCalls: JSON.stringify(turn.toolCalls ?? []), toolCallId: turn.toolCallId, tokenInput: turn.usage?.inputTokens, tokenOutput: turn.usage?.outputTokens });
    }
    count++;
  }
  console.log(`Backfilled ${count} conversations.`);
}
main();
```

`findConversationFiles` walks `outputs/*/*/conversation.json`. Use `fs.readdirSync` recursively (existing `walkFiles` pattern from `executors.ts`).

- [ ] **Step 2: Run the backfill**

```bash
$env:ARENA_BACKFILL_CONVERSATIONS=true; npx tsx scripts/backfill-conversations.ts
```
Expected: prints "Backfilled N conversations." Re-running prints "Backfilled 0 conversations." (idempotent).

- [ ] **Step 3: Verify**

```bash
npx tsx -e "import {initDb, getDb, dbPath} from './src/db/client.js'; initDb(dbPath()); console.log(getDb().prepare('SELECT count(*) c FROM messages').get());"
```
Expected: count > 0 and matches the number of historical conversation files.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-conversations.ts
git commit -m "feat(backfill): one-shot conversation.json → messages import (D11)"
```

---

## Task 6.2: Remove the conversation file dual-write

**Files:**
- Modify: `src/logger/conversation-logger.ts` — remove the file-write path; the DB sink (Phase 1.6) is now the only sink.
- Modify: `src/worker.ts` / `src/runner.ts` — the `ConversationLogger` no longer writes `conversation.json`. (It may still write it as an EXPORT on demand via a future CLI command, but not on every turn.)

- [ ] **Step 1: Read `src/logger/conversation-logger.ts`**

Identify the file-write call (the `fs.appendFileSync` / `writeFileSync` to `conversationPath`). Remove it; keep the `dbSink.appendMessage(...)` call.

- [ ] **Step 2: Keep an export path (optional, low priority)**

Add a CLI command `ai-arena export conversation <runId> <model>` that reads `messages` for the session and writes a `conversation.json` to stdout or a file — for users who want the old artifact shape. This is a read-only export, not a live write.

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint && npm test
npm run dev -- run --scenario express-rest --models <stub>
# confirm: no conversation.json written; messages table populated
ls outputs/<model>/<runId>/   # no conversation.json
```

- [ ] **Step 4: Commit**

```bash
git add src/logger/conversation-logger.ts src/worker.ts src/runner.ts src/cli.ts
git commit -m "refactor(logger): remove conversation.json dual-write — DB is source of truth"
```

---

## Task 6.3: Remove PM2 dependency + ecosystem configs

**Files:**
- Delete: `ecosystem.config.cjs`
- Delete: `ecosystem.config.js` (if present)
- Modify: `package.json` — remove `pm2` from deps; remove PM2-related scripts (the dashboard PM2 script becomes `node dist/dashboard-server/server.js`).
- Delete: `src/types/pm2.d.ts`
- Delete: `src/orchestrator/pm2-helpers.ts`
- Modify: `src/orchestrator/run-lifecycle.ts` — remove `spawnRunWorkers`, `finalizeRunByRunId`, `restartRun` (PM2-based). Keep `createRun`, `updateRunStatus`, result-file writing.
- Modify: `src/cli.ts` — the `run` command now enqueues tasks (to the in-memory queue for local dev, or Redis if `REDIS_URL` set) and prints the runId. The `status`/`logs`/`cleanup` commands are reworked:
  - `status` → reads the `runs` table (already does since Phase 0.3).
  - `logs` → reads the DB messages + Pino logs (no PM2 log files). For a k8s context, `kubectl logs` is the path; the CLI can shell out if `KUBE_NAMESPACE` is set, else read the local Pino log file.
  - `cleanup` → cancels in-flight tasks in the queue (no PM2 processes to delete).

- [ ] **Step 1: Delete PM2 files**

```bash
git rm ecosystem.config.cjs
git rm src/types/pm2.d.ts
git rm src/orchestrator/pm2-helpers.ts
# ecosystem.config.js if present:
git rm ecosystem.config.js 2>$null
```

- [ ] **Step 2: Remove `pm2` from package.json**

Edit `package.json`: remove `"pm2": "^7.0.3"` from dependencies. Update the `dashboard:start` script to `node dist/dashboard-server/server.js` (no PM2 wrapper). Remove any PM2 references in scripts.

- [ ] **Step 3: Refactor `run-lifecycle.ts`**

Delete `spawnRunWorkers`, `finalizeRunByRunId`, `restartRun`. Keep the run-record creation (`createRun`) and status updates. The enqueue path (Phase 2.2) is now the only launch path. The `restartRun` CLI command becomes "re-enqueue the run's tasks" (creates new tasks with the same sessionId so checkpoint resume kicks in).

- [ ] **Step 4: Refactor `src/cli.ts`**

The `run` command:
- Creates a run record.
- For each model, creates a session + enqueues a task to the queue (in-memory or Redis).
- Polls the DB for run completion (or just prints the runId and exits, leaving the dashboard to show progress).

- [ ] **Step 5: `npm install` to regenerate lockfile without pm2**

```bash
npm install   # removes pm2 from node_modules
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm run lint && npm test
npm run dev -- run --scenario express-rest --models <stub>   # works without PM2
npm run dev -- status                                          # lists runs from DB
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove PM2 dependency + ecosystem configs (runners now k8s)"
```

---

## Task 6.4: Remove the in-memory queue driver (Redis is the only production path)

**Files:**
- Delete: `src/queue/in-memory.ts`
- Modify: `src/queue/index.ts` — `createQueue()` only supports `redis`.
- Delete: `tests/queue/in-memory.test.ts`
- Modify: `docker-compose.yml` — `QUEUE_DRIVER=redis` (already set in Phase 2).

**Note:** Keep the in-memory queue ONLY if unit tests still need it. If tests can use a real Redis (via testcontainers or a CI Redis), delete it. If not, keep `InMemoryQueue` as a test-only utility marked clearly. **Decision: keep it as a test-only helper** (moving it to `tests/helpers/in-memory-queue.ts`) so unit tests stay fast and Redis-free; production paths use Redis exclusively.

- [ ] **Step 1: Move `InMemoryQueue` to test helpers**

```bash
git mv src/queue/in-memory.ts tests/helpers/in-memory-queue.ts
git mv tests/queue/in-memory.test.ts tests/helpers/in-memory-queue.test.ts
```

- [ ] **Step 2: Update `src/queue/index.ts`**

```ts
import { RedisStreamQueue } from './redis.js';
import { loadRedisQueueConfig } from './redis-config.js';
export async function createQueue(): Promise<TaskQueue> {
  const driver = process.env.QUEUE_DRIVER ?? 'redis';
  if (driver === 'redis') return new RedisStreamQueue(loadRedisQueueConfig());
  throw new Error(`Unsupported QUEUE_DRIVER: ${driver} (only 'redis' is supported in production)`);
}
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(queue): in-memory queue demoted to test helper; Redis is the only prod path"
```

---

## Task 6.5: Documentation update

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `docs/deployment.md`

- [ ] **Step 1: README update**

- Remove the PM2 architecture section.
- Replace the architecture diagram with the k8s runner diagram from the design spec.
- Update setup: `npm install` (no PM2), `docker compose up` for local dev, `scripts/k8s/deploy.sh` for minikube.
- Remove stale OTel claims; describe the real OTel stack (Phase 4).
- Remove the `docker-compose.observability.yml` reference (file doesn't exist).
- Document `OUTPUT_ROOT`, `DATABASE_URL`, `REDIS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` env vars.

- [ ] **Step 2: AGENTS.md update**

- Remove PM2 references from "Process" section.
- Add k8s/Redis/Postgres/KEDA to the tech stack.
- Update "Development Commands" with the docker-compose + k8s deploy scripts.
- Note the runner entry is `src/runner.ts`, not `src/worker.ts`.

- [ ] **Step 3: `docs/deployment.md`**

A focused deployment guide:
- minikube start flags + platform caveats (gVisor unavailable on Windows).
- `scripts/k8s/bootstrap.sh` + `scripts/k8s/deploy.sh`.
- Provider key setup (k8s Secret).
- Backup/restore (`scripts/backup/`, `scripts/restore/`).
- Observability stack access (Grafana NodePort).
- Scaling tuning (KEDA `length` threshold).

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md docs/deployment.md
git commit -m "docs: post-migration README + AGENTS + deployment guide"
```

---

## Phase 6 Exit Gate

- [ ] `conversation.json` no longer written on new runs; `messages` table is the source of truth.
- [ ] Historical conversations backfilled (D11).
- [ ] `pm2` removed from `package.json`; `ecosystem.config.cjs` deleted; no `src/types/pm2.d.ts`.
- [ ] `npm run dev -- run ...` works without PM2 (enqueues to Redis, or in-memory for unit tests).
- [ ] In-memory queue is test-only; production uses Redis.
- [ ] README/AGENTS/docs reflect the k8s architecture.
- [ ] `npm run typecheck && npm run lint && npm test` green.
- [ ] All Phase 6 commits pushed.

## Phase 6 Self-Review

- **Spec coverage:** D11 (backfill) → 6.1; remove dual-write → 6.2; decommission PM2 (Phase 6 goal) → 6.3; Redis-only queue → 6.4; docs → 6.5.
- **Placeholders:** none.
- **Type consistency:** `createQueue()` is now async (returns `Promise<TaskQueue>`) — update callers (`src/runner.ts`) to await it.
- **Dependencies:** 6.1 (backfill) must run before 6.2 (remove dual-write) so no history is lost. 6.3 (remove PM2) after 6.2. 6.4 after 6.3. 6.5 anytime after 6.3.

---

## Cross-Phase Self-Review (all plans)

**Spec coverage (design doc Part 2 + Part 3):**
- §2.2 Runner layer → P1 (stateless runner), P2 (Deployment + KEDA).
- §2.3 Reliability → P3 (idempotency, checkpoints, circuit breaker, fallback, DLQ, flock).
- §2.4 Multi-runner coordination → P3.5 (flock), P4.2 (distributed tracing).
- §2.5 Security → P0.5 (shell-injection fix), P3.6-3.7 (RBAC + audit), P4.4 (prompt-injection), P4.5 (lineage), P4.6 (secrets masking).
- §2.6 Operations → P0.1 (Drizzle migrations), P2.3 (minikube), P4.7 (backup drills), P5.6 (durable scheduler), canary/blue-green noted in design doc (deferred to a real cluster — minikube is single-node).
- §2.7 Dashboard scope → P5 (runner mgmt, prompts, queues, output mapping, cost, streaming).
- Decisions D1-D13 all mapped (see per-phase self-reviews).

**Placeholder scan:** all plans use concrete files, code, commands. No "TBD"/"implement later".

**Type consistency across phases:** `Task` (gains `provider` in P2, `traceparent` in P4), `TaskQueue` (`createQueue` becomes async in P6), `SessionStore`, `CircuitBreaker.for(provider, model)`, `lockedWrite(target, content, { lockDir })`, `onToken(delta)`, `onTurnComplete(turn, messages)`, `computeTaskId`, `resumeFrom(sessionId)` — all consistent.

**Cross-phase dependency graph (from design Part 3):** honored — P0 → P1 → P2 → {P3, P4, P5} → P6.

**Open items deliberately deferred (not placeholders — documented decisions):**
- Canary/blue-green deployment strategy: noted in design doc as requiring a real multi-node cluster; minikube is single-node so rolling updates suffice for now.
- gVisor on Windows minikube: documented in P2.4 README; seccomp fallback active.
- Slack/email routing for budget alerts: D13 defers; hook left in P5.5.
- Provider key rotation cadence: D12 sets none; manual procedure documented in P4.6.
- Major dep upgrades (express 5, zod 4): noted in D9 as optional Phase 0 follow-up, not blocking.

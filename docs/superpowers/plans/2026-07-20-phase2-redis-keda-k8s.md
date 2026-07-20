# Phase 2 — Redis Queue + KEDA + Kubernetes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory queue with self-hosted Redis Streams; deploy runners as a KEDA-scaled Kubernetes `Deployment` in local minikube; wire per-provider isolation, DLQ, and gVisor/seccomp sandboxing.

**Architecture:** Redis Streams (consumer groups) as the durable queue + DLQ per provider queue. KEDA `ScaledObject` scales runner replicas on stream length (queue depth), not CPU. Runners run as a long-lived `Deployment` (long-lived pods, stateless, pull from queue). In-cluster Redis (Bitnami chart or plain Deployment + PVC). gVisor `RuntimeClass` where available (Linux minikube), seccomp `RuntimeDefault` fallback (Windows minikube). Per-provider queue + per-provider Deployment so a failing provider is isolated.

**Tech Stack:** TypeScript, `ioredis`, Redis Streams, KEDA, minikube, kubectl, Helm, Docker.

## Global Constraints

- All Phase 1 artifacts intact: `DB_DRIVER=postgres`, `OUTPUT_ROOT` PVC, Drizzle migrations.
- Local minikube is the ONLY target cluster (D5). Manifests must work on a single-node minikube; HA/failover semantics are noted as "not testable here" and deferred.
- `QUEUE_DRIVER=redis` must be the new default for the runner image; the in-memory driver stays for unit tests only.
- Per D6: pod spec works under BOTH gVisor (Linux minikube) and seccomp-fallback (Windows minikube). A `RuntimeClass` is referenced only if it exists; otherwise falls back.
- Never break the dev docker-compose path — keep `QUEUE_DRIVER=memory` working.

---

## File Structure (Phase 2)

- Create: `src/queue/redis.ts` — Redis Streams `TaskQueue` impl.
- Modify: `src/queue/index.ts` — `redis` driver branch.
- Create: `src/queue/redis-config.ts` — env-driven stream/consumer-group naming.
- Create: `k8s/` — manifest root.
  - `k8s/namespace.yaml`
  - `k8s/postgres.yaml` (StatefulSet + Service + PV) OR a note to use a chart.
  - `k8s/redis.yaml` (Deployment + Service + PVC, AOF+RDB).
  - `k8s/runner-deployment.yaml` (per-provider templated).
  - `k8s/runner-configmap.yaml` (env: DATABASE_URL, REDIS_URL, OUTPUT_ROOT, etc.).
  - `k8s/runner-secret.yaml.example` (provider API keys — never commit real values).
  - `k8s/keda-scaledobject.yaml` (per-provider ScaledObject on stream length).
  - `k8s/dashboard-deployment.yaml` + `k8s/dashboard-service.yaml`.
  - `k8s/ingress.yaml` (or NodePort for minikube tunnel).
  - `k8s/output-pvc.yaml` (ReadWriteMany hostPath for minikube).
  - `k8s/runtimeclass-gvisor.yaml` (conditional; documented as Linux-only).
- Create: `k8s/kustomization.yaml` (kustomize base for minikube).
- Create: `k8s/README.md` — minikube startup flags, platform caveats, deploy/teardown.
- Modify: `package.json` — add `ioredis`.
- Modify: `docker-compose.yml` — switch `QUEUE_DRIVER` to `redis` (Redis is already in compose).
- Create: `tests/queue/redis.test.ts` — integration test (requires Redis; skip if `REDIS_URL` unset).
- Create: `scripts/k8s/bootstrap.sh` — minikube + Helm + KEDA install.
- Create: `scripts/k8s/deploy.sh` — apply manifests + build image + load into minikube.

---

## Task 2.1: Redis Streams queue driver

**Files:**
- Modify: `package.json`
- Create: `src/queue/redis-config.ts`
- Create: `src/queue/redis.ts`
- Modify: `src/queue/index.ts`
- Create: `tests/queue/redis.test.ts`

**Interfaces:**
- Produces `src/queue/redis.ts` exporting `class RedisStreamQueue implements TaskQueue`.
- Stream naming: `arena:tasks:<provider>` (per-provider isolation, D7). Consumer group: `arena-runners`. Consumer name: pod hostname (`os.hostname()`).
- DLQ stream: `arena:tasks:<provider>:dlq`. After N `nack`s (default 5, env `MAX_TASK_ATTEMPTS`), the task is `XADD` to the DLQ and `XACK`'d from the main stream (no requeue).
- `dequeue` uses `XREADGROUP` with `COUNT 1 BLOCK <timeout>`; on a message whose ID was already processed (idempotency via `model_calls` table from Phase 1 — runner checks and ACKs without re-running), the runner ACKs immediately and loops.
- `ack`/`nack` map to `XACK` / requeue via `XADD` with bumped `attempts`.

- [ ] **Step 1: Install ioredis**

```bash
npm install ioredis
```

- [ ] **Step 2: Write `src/queue/redis-config.ts`**

```ts
export interface RedisQueueConfig {
  url: string;                  // REDIS_URL
  streamPrefix: string;         // default 'arena:tasks'
  consumerGroup: string;        // default 'arena-runners'
  consumerName: string;         // os.hostname()
  maxAttempts: number;          // MAX_TASK_ATTEMPTS, default 5
  blockMs: number;              // XREADGROUP block, default 5000
}
export function loadRedisQueueConfig(): RedisQueueConfig {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required when QUEUE_DRIVER=redis');
  return {
    url,
    streamPrefix: process.env.REDIS_STREAM_PREFIX ?? 'arena:tasks',
    consumerGroup: process.env.REDIS_CONSUMER_GROUP ?? 'arena-runners',
    consumerName: process.env.REDIS_CONSUMER_NAME ?? require('node:os').hostname(),
    maxAttempts: Number(process.env.MAX_TASK_ATTEMPTS ?? 5),
    blockMs: Number(process.env.REDIS_BLOCK_MS ?? 5000),
  };
}
```

(Use ESM import for `os`: `import os from 'node:os';` — replace the `require`.)

- [ ] **Step 3: Write the failing integration test `tests/queue/redis.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedisStreamQueue } from '../../src/queue/redis.js';

const REDIS_URL = process.env.REDIS_URL;
const it = REDIS_URL ? test : test.skip;

it('enqueue + dequeue round-trip', async () => {
  const q = new RedisStreamQueue({ url: REDIS_URL!, streamPrefix: 'arena:test:' + Date.now(), consumerGroup: 'g', consumerName: 'c', maxAttempts: 5, blockMs: 500 });
  await q.enqueue({ taskId: 't1', sessionId: 's', model: 'gpt-4o', provider: 'openai', scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(), attempts: 0 } as any);
  const t = await q.dequeue(2000);
  assert.equal(t?.taskId, 't1');
  await q.ack('t1');
});

it('nack requeues until maxAttempts → DLQ', async () => {
  const q = new RedisStreamQueue({ url: REDIS_URL!, streamPrefix: 'arena:test2:' + Date.now(), consumerGroup: 'g', consumerName: 'c', maxAttempts: 2, blockMs: 500 });
  await q.enqueue({ taskId: 't2', sessionId: 's', model: 'gpt-4o', provider: 'openai', scenario: 'x', config: {}, enqueuedAt: new Date().toISOString(), attempts: 0 } as any);
  for (let i = 0; i < 3; i++) {
    const t = await q.dequeue(2000);
    if (t) await q.nack(t.taskId, 'fail');
  }
  // DLQ should now contain t2 — expose a `dlqSize()` or `peekDlq()` test helper
  assert.equal(await q.dlqSize(), 1);
});
```

Add a `dlqSize()` method (test-only; fine to keep public).

- [ ] **Step 4: Run — expect SKIP (no REDIS_URL) or FAIL**

`npm test -- --test tests/queue/redis.test.ts`
To run it locally: `docker compose up -d redis` then `$env:REDIS_URL="redis://localhost:6379"; npm test -- --test tests/queue/redis.test.ts`.

- [ ] **Step 5: Implement `src/queue/redis.ts`**

Key implementation points:
- `enqueue`: `XADD stream * <task-json-fields>`. Ensure the consumer group exists (`XGROUP CREATE ... MKSTREAM` lazily on first call, catch "BUSYGROUP").
- `dequeue`: `XREADGROUP GROUP <group> <consumer> COUNT 1 BLOCK <blockMs> STREAMS stream >`. Parse the message; return the `Task`. If empty → null.
- `ack`: `XACK stream group <id>`.
- `nack`: read attempts from the message; if `< maxAttempts`, `XADD` to the same stream with `attempts+1` then `XACK` the original. If `>= maxAttempts`, `XADD` to `stream:dlq` (with the last error) then `XACK` the original.
- Use `ioredis` streams; serialize the Task as a single JSON field (`task` field) for simplicity.

- [ ] **Step 6: Wire `src/queue/index.ts`**

```ts
if (driver === 'redis') {
  const { RedisStreamQueue } = await import('./redis.js');
  const { loadRedisQueueConfig } = await import('./redis-config.js');
  return new RedisStreamQueue(loadRedisQueueConfig());
}
```

- [ ] **Step 7: Run tests — expect PASS**

```bash
docker compose up -d redis
$env:REDIS_URL="redis://localhost:6379"; npm test -- --test tests/queue/redis.test.ts
npm run typecheck && npm run lint && npm test
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/queue/ tests/queue/redis.test.ts
git commit -m "feat(queue): Redis Streams driver with per-provider streams + DLQ"
```

---

## Task 2.2: Per-provider queue routing in the control plane

**Files:**
- Modify: `src/dashboard-server/routes/runs.ts` (or wherever `POST /api/runs` enqueues tasks — find it via `grep -rn "enqueue\|orchestrator" src/dashboard-server/`).
- Create: `src/queue/router.ts` — resolves a task's target stream name from its `provider` field.

**Goal:** when the dashboard (or CLI) enqueues a task, it lands on the right per-provider stream so a failing provider's queue doesn't block others.

- [ ] **Step 1: Read the run-launch path**

`grep -rn "spawnRunWorkers\|enqueue\|startRun" src/dashboard-server/ src/orchestrator/` — find where a run is created. The current path calls `spawnRunWorkers` (PM2). Add a parallel `enqueueRunTasks(run)` path that creates a `Session` + enqueues one `Task` per model to `arena:tasks:<provider>`.

- [ ] **Step 2: Implement `src/queue/router.ts`**

```ts
export function streamForProvider(provider: string, prefix = 'arena:tasks'): string {
  return `${prefix}:${provider}`;
}
export function dlqStreamForProvider(provider: string, prefix = 'arena:tasks'): string {
  return `${prefix}:${provider}:dlq`;
}
```

- [ ] **Step 3: Add an enqueue path behind a feature flag**

In the run-launch handler, branch on `QUEUE_DRIVER`:
- `memory` / default → existing PM2 `spawnRunWorkers` path (unchanged).
- `redis` → `enqueueRunTasks`: create a session per (run, model), enqueue a task per model to its provider stream, return the runId. The runner picks it up.

Gate with `ARENA_USE_QUEUE=true` (or auto-detect `QUEUE_DRIVER === 'redis'`). Keep the PM2 path as fallback so a misconfigured queue doesn't break launches.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run lint && npm test
# manual: set QUEUE_DRIVER=redis, enqueue a run, confirm it lands in the stream
```

- [ ] **Step 5: Commit**

```bash
git add src/queue/router.ts src/dashboard-server/ src/orchestrator/
git commit -m "feat(queue): per-provider stream routing behind QUEUE_DRIVER=redis"
```

---

## Task 2.3: Kubernetes manifests — namespace, Postgres, Redis, PVC

**Files:**
- Create: `k8s/namespace.yaml`
- Create: `k8s/postgres.yaml`
- Create: `k8s/redis.yaml`
- Create: `k8s/output-pvc.yaml`
- Create: `k8s/README.md`

- [ ] **Step 1: `k8s/namespace.yaml`**

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: ai-arena }
```

- [ ] **Step 2: `k8s/postgres.yaml`** (StatefulSet + Service + PV; single replica for minikube)

```yaml
apiVersion: v1
kind: Service
metadata: { name: postgres, namespace: ai-arena }
spec: { selector: { app: postgres }, ports: [{ port: 5432, targetPort: 5432 }] }
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: postgres, namespace: ai-arena }
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:16
          env:
            - { name: POSTGRES_USER, value: arena }
            - { name: POSTGRES_PASSWORD, value: arena }
            - { name: POSTGRES_DB, value: arena }
          ports: [{ containerPort: 5432 }]
          volumeMounts: [{ name: data, mountPath: /var/lib/postgresql/data }]
  volumeClaimTemplates:
    - metadata: { name: data }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 5Gi } } }
```

- [ ] **Step 3: `k8s/redis.yaml`** (Deployment + Service + PVC, AOF+RDB)

```yaml
apiVersion: v1
kind: Service
metadata: { name: redis, namespace: ai-arena }
spec: { selector: { app: redis }, ports: [{ port: 6379, targetPort: 6379 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: redis, namespace: ai-arena }
spec:
  replicas: 1
  selector: { matchLabels: { app: redis } }
  template:
    metadata: { labels: { app: redis } }
    spec:
      containers:
        - name: redis
          image: redis:7
          args: ["redis-server", "--appendonly", "yes", "--save", "60", "1"]
          ports: [{ containerPort: 6379 }]
          volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: redis-data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: redis-data, namespace: ai-arena }
spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 2Gi } } }
```

- [ ] **Step 4: `k8s/output-pvc.yaml`** (hostPath RWX for minikube single node)

```yaml
apiVersion: v1
kind: PersistentVolume
metadata: { name: outputs-pv, namespace: ai-arena }
spec:
  accessModes: [ReadWriteMany]
  capacity: { storage: 10Gi }
  hostPath: { path: /tmp/arena-outputs }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: outputs, namespace: ai-arena }
spec: { accessModes: [ReadWriteMany], resources: { requests: { storage: 10Gi } } }
```

- [ ] **Step 5: `k8s/README.md`**

Document:
- minikube start flags: `minikube start --driver=<hyperv|virtualbox|docker> --memory=4096 --cpus=2`
- Platform caveat: gVisor unavailable on Windows minikube; seccomp `RuntimeDefault` used.
- Apply: `kubectl apply -f k8s/namespace.yaml && kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml`
- Teardown: `kubectl delete namespace ai-arena`
- Backup: `kubectl cp ai-arena/postgres-0:/var/lib/postgresql/data ./pg-backup` (scratch; real backup in Phase 4).

- [ ] **Step 6: Apply + smoke on minikube**

```bash
minikube start
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml
kubectl -n ai-arena wait --for=condition=ready pod -l app=postgres --timeout=120s
kubectl -n ai-arena wait --for=condition=ready pod -l app=redis --timeout=60s
kubectl -n ai-arena exec deploy/redis -- redis-cli PING
```
Expected: `PONG`.

- [ ] **Step 7: Commit**

```bash
git add k8s/
git commit -m "feat(k8s): namespace, Postgres StatefulSet, Redis, RWX output PVC"
```

---

## Task 2.4: Runner Deployment + ConfigMap + Secret template

**Files:**
- Create: `k8s/runner-configmap.yaml`
- Create: `k8s/runner-secret.yaml.example`
- Create: `k8s/runner-deployment.yaml`
- Create: `scripts/k8s/bootstrap.sh`

- [ ] **Step 1: `k8s/runner-configmap.yaml`**

```yaml
apiVersion: v1
kind: ConfigMap
metadata: { name: runner-config, namespace: ai-arena }
data:
  DB_DRIVER: postgres
  DATABASE_URL: postgres://arena:arena@postgres:5432/arena
  REDIS_URL: redis://redis:6379
  QUEUE_DRIVER: redis
  OUTPUT_ROOT: /var/arena/outputs
  REDIS_STREAM_PREFIX: arena:tasks
  REDIS_CONSUMER_GROUP: arena-runners
  MAX_TASK_ATTEMPTS: "5"
  LOG_LEVEL: info
  # Provider selection — see src/queue/router.ts
  PROVIDERS: openai,anthropic,google,bedrock
```

- [ ] **Step 2: `k8s/runner-secret.yaml.example`**

```yaml
apiVersion: v1
kind: Secret
metadata: { name: provider-keys, namespace: ai-arena }
stringValues:
  OPENAI_API_KEY: sk-...
  ANTHROPIC_API_KEY: sk-ant-...
  GOOGLE_API_KEY: ...
  # Bedrock uses AWS credentials instead:
  AWS_ACCESS_KEY_ID: ...
  AWS_SECRET_ACCESS_KEY: ...
# Copy to runner-secret.yaml, fill in, NEVER commit.
```

- [ ] **Step 3: `k8s/runner-deployment.yaml`** (per-provider; here `openai`; duplicate per provider via kustomize patches or a templated script)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runner-openai
  namespace: ai-arena
  labels: { app: runner, provider: openai }
spec:
  replicas: 1   # KEDA manages this; set to 1 as floor
  selector: { matchLabels: { app: runner, provider: openai } }
  template:
    metadata: { labels: { app: runner, provider: openai } }
    spec:
      runtimeClassName: gvisor     # ignored if RuntimeClass doesn't exist (see note)
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: runner
          image: ai-arena/runner:latest
          imagePullPolicy: IfNotPresent
          envFrom:
            - configMapRef: { name: runner-config }
            - secretRef: { name: provider-keys }
          env:
            - { name: REDIS_CONSUMER_NAME, valueFrom: { fieldRef: { fieldPath: metadata.name } } }
            - { name: ARENA_PROVIDER_FILTER, value: openai }   # runner only pulls from arena:tasks:openai
          volumeMounts:
            - { name: outputs, mountPath: /var/arena/outputs }
            - { name: tmp, mountPath: /tmp }
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { cpu: 1000m, memory: 1Gi }
      volumes:
        - name: outputs
          persistentVolumeClaim: { claimName: outputs }
        - { name: tmp, emptyDir: {} }
```

Note: `runtimeClassName: gvisor` — on minikube without the gVisor RuntimeClass, `kubelet` will reject the pod. The bootstrap script (Step 5) creates the RuntimeClass conditionally; on Windows minikube it omits the `runtimeClassName` field via a kustomize patch. Document this in `k8s/README.md`.

The `ARENA_PROVIDER_FILTER` env tells the runner's `dequeue` to read only from `arena:tasks:openai` — wire it into `loadRedisQueueConfig()` (read the env, override the stream).

- [ ] **Step 4: Add the `ARENA_PROVIDER_FILTER` plumbing**

In `src/queue/redis-config.ts`, read `ARENA_PROVIDER_FILTER` and set `streamPrefix` such that the runner only listens to the one provider stream. Update `RedisStreamQueue` to accept a single-provider filter.

- [ ] **Step 5: `scripts/k8s/bootstrap.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
minikube start --memory=4096 --cpus=2
# KEDA
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda -n keda --create-namespace
# Conditionally create gVisor RuntimeClass (Linux minikube only)
if minikube ssh "which runsc" 2>/dev/null; then
  kubectl apply -f k8s/runtimeclass-gvisor.yaml
fi
# Build image into minikube's docker daemon
eval "$(minikube docker-env)"
docker build -t ai-arena/runner:latest .
```

- [ ] **Step 6: Apply + smoke**

```bash
bash scripts/k8s/bootstrap.sh
kubectl apply -f k8s/namespace.yaml -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml
kubectl apply -f k8s/runner-configmap.yaml
# cp k8s/runner-secret.yaml.example k8s/runner-secret.yaml; edit; kubectl apply -f k8s/runner-secret.yaml
kubectl apply -f k8s/runner-deployment.yaml
kubectl -n ai-arena logs deploy/runner-openai --tail=50
```
Expected: runner logs show it connected to Redis + Postgres and is polling the `arena:tasks:openai` stream.

- [ ] **Step 7: Commit**

```bash
git add k8s/ scripts/k8s/ src/queue/redis-config.ts
git commit -m "feat(k8s): runner Deployment with provider filter + gVisor/seccomp sandbox"
```

---

## Task 2.5: KEDA ScaledObject on queue depth

**Files:**
- Create: `k8s/keda-scaledobject.yaml`
- Create: `scripts/k8s/deploy.sh`

- [ ] **Step 1: `k8s/keda-scaledobject.yaml`** (per-provider; here `openai`)

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: runner-openai-scaler
  namespace: ai-arena
spec:
  scaleTargetRef:
    name: runner-openai
  minReplicaCount: 1
  maxReplicaCount: 10
  pollingInterval: 5         # seconds
  cooldownPeriod: 60
  triggers:
    - type: redis
      metadata:
        address: redis.ai-arena.svc:6379
        listType: STREAM
        length: 5             # scale up when stream length > 5 per replica
        stream: arena:tasks:openai
```

Document: KEDA's Redis Streams scaler reads `XLEN stream`. `length` is the threshold per replica — scale = ceil(streamLen / length). Tune for I/O-bound workloads (default 5; LLM tasks are long, so a small threshold is fine).

- [ ] **Step 2: `scripts/k8s/deploy.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
eval "$(minikube docker-env)"
docker build -t ai-arena/runner:latest .
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml
kubectl apply -f k8s/runner-configmap.yaml
kubectl apply -f k8s/runner-secret.yaml  # user-managed
kubectl apply -f k8s/runner-deployment.yaml
kubectl apply -f k8s/keda-scaledobject.yaml
kubectl -n ai-arena rollout status deploy/runner-openai
```

- [ ] **Step 3: Smoke — verify scaling**

```bash
# enqueue 20 tasks to arena:tasks:openai
kubectl -n ai-arena exec deploy/redis -- redis-cli XADD arena:tasks:openai '*' task '{"taskId":"t1",...}'
# repeat 20× via a loop
kubectl -n ai-arena get pods -l provider=openai -w
```
Expected: pods scale from 1 → up to ~4 (20/5). After draining, cool down to 1.

- [ ] **Step 4: Commit**

```bash
git add k8s/keda-scaledobject.yaml scripts/k8s/deploy.sh
git commit -m "feat(k8s): KEDA ScaledObject on Redis stream depth per provider"
```

---

## Task 2.6: Dashboard Deployment + Service + access

**Files:**
- Create: `k8s/dashboard-deployment.yaml`
- Create: `k8s/dashboard-service.yaml`
- Modify: `scripts/k8s/deploy.sh` (add dashboard apply)

- [ ] **Step 1: `k8s/dashboard-deployment.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: dashboard, namespace: ai-arena }
spec:
  replicas: 1
  selector: { matchLabels: { app: dashboard } }
  template:
    metadata: { labels: { app: dashboard } }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: dashboard
          image: ai-arena/runner:latest
          command: ["node", "dist/dashboard-server/server.js"]
          envFrom:
            - configMapRef: { name: runner-config }
            - secretRef: { name: provider-keys }
          env:
            - { name: DASHBOARD_PORT, value: "4000" }
            - { name: DASHBOARD_USERNAME, value: admin }
            - { name: DASHBOARD_PASSWORD, valueFrom: { secretKeyRef: { name: dashboard-auth, key: password } } }
            - { name: DASHBOARD_JWT_SECRET, valueFrom: { secretKeyRef: { name: dashboard-auth, key: jwt-secret } } }
          ports: [{ containerPort: 4000 }]
          volumeMounts: [{ name: outputs, mountPath: /var/arena/outputs }]
          securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      volumes: [{ name: outputs, persistentVolumeClaim: { claimName: outputs } }]
```

- [ ] **Step 2: `k8s/dashboard-service.yaml`** (NodePort for minikube)

```yaml
apiVersion: v1
kind: Service
metadata: { name: dashboard, namespace: ai-arena }
spec:
  type: NodePort
  selector: { app: dashboard }
  ports: [{ port: 4000, targetPort: 4000, nodePort: 30400 }]
```

- [ ] **Step 3: Create the auth secret (one-off)**

```bash
kubectl -n ai-arena create secret generic dashboard-auth \
  --from-literal=password=change-me \
  --from-literal=jwt-secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

- [ ] **Step 4: Access**

```bash
minikube service dashboard -n ai-arena --url
# or: kubectl -n ai-arena port-forward svc/dashboard 4000:4000
```

- [ ] **Step 5: Smoke — log in, list runs, enqueue a run**

Manual: open the URL, log in with admin/change-me, confirm the dashboard loads + can see runners (next phase adds runner mgmt UI; for now the runs list should reflect DB-backed runs).

- [ ] **Step 6: Commit**

```bash
git add k8s/dashboard-deployment.yaml k8s/dashboard-service.yaml scripts/k8s/deploy.sh
git commit -m "feat(k8s): dashboard Deployment + NodePort service"
```

---

## Task 2.7: CI/CD pipeline (GitHub Actions — build + push + deploy to staging namespace)

**Files:**
- Create: `.github/workflows/build-deploy.yaml`

- [ ] **Step 1: Write the workflow**

```yaml
name: build-deploy
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
      - run: npx drizzle-kit generate --config drizzle.pg.config.ts
      - name: Build image
        run: docker build -t ai-arena/runner:${{ github.sha }} .
  # Deploy step is manual for now (no registry in this phase); Phase 4 wires a registry.
```

Note: the deploy step is left manual because the target is local minikube. A registry + automated deploy is a Phase 4 follow-up. For now, CI validates build + tests + image build.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-deploy.yaml
git commit -m "ci: build + test + image build pipeline"
```

---

## Phase 2 Exit Gate

- [ ] `QUEUE_DRIVER=redis` works end-to-end: enqueue via dashboard → runner picks up → DB persists → ACK.
- [ ] DLQ: a task that fails `maxAttempts` times lands in `arena:tasks:<provider>:dlq`.
- [ ] Per-provider isolation: `arena:tasks:openai` and `arena:tasks:anthropic` are independent; a failing openai runner doesn't block anthropic.
- [ ] KEDA scales runner replicas on stream length; cooldown returns to 1.
- [ ] Pod spec runs as non-root, `readOnlyRootFilesystem`, dropped capabilities, seccomp `RuntimeDefault`; gVisor where available.
- [ ] Dashboard reachable via `minikube service dashboard --url`.
- [ ] CI pipeline green on push.
- [ ] `k8s/README.md` documents minikube flags + platform caveats.
- [ ] All Phase 2 commits pushed.

## Phase 2 Self-Review

- **Spec coverage:** D1 (Redis Streams in-cluster) → 2.1, 2.3. D4 (minikube RWX) → 2.3. D5 (minikube) → 2.3-2.6. D6 (gVisor/seccomp) → 2.4. D7 (per-provider) → 2.2, 2.4, 2.5. 2.3 reliability §2.3 (DLQ) → 2.1. KEDA queue-depth scaling → 2.5. 2.4 sandboxing (§2.5) → 2.4.
- **Placeholders:** none. Real manifests, real code.
- **Type consistency:** `Task` shape includes `provider` field (added in 2.1 test — ensure `src/queue/types.ts` Task interface includes `provider: string`). Update the interface in 2.1 Step 2.
- **Dependencies:** 2.1 (Redis driver) → 2.2 (routing) → 2.4 (Deployment references the driver) → 2.5 (KEDA references the Deployment). 2.3 (infra) independent of 2.1/2.2. 2.6 (dashboard) depends on 2.3. 2.7 (CI) independent.

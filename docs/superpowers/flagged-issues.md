# Flagged Issues (2026-07-21)

## Fixed (this session)
- [x] pm2 removed from package.json dependencies
- [x] worker/worker:dev scripts removed from package.json
- [x] regression.ts:149 — outputs path now uses outputRoot()
- [x] Task interface: added _redisId, _traceparent fields
- [x] Redis ack/nack implemented with DLQ support
- [x] Redis integration tests pass against real server (docker redis:7)
- [x] Runner wired for _redisId in ack/nack calls
- [x] ConversationLogger: added disableFile option, used in runner
- [x] Scheduler tick.ts: uses cron-parser, actually enqueues tasks
- [x] JWT tokens include role claims
- [x] RBAC middleware + audit helper created
- [x] Secrets masking helper created (src/dashboard-server/secrets.ts)
- [x] RBAC middleware applied to all Express route groups (viewer/editor/admin)
- [x] Secrets masking middleware applied to all JSON responses
- [x] Circuit breaker wired into runner adapter calls (CircuitBreaker.for + fallback chain)
- [x] Fallback chain wired into runner retry loop (3-hop max)
- [x] Traceparent propagation wired into Redis enqueue/dequeue + runner context
- [x] README.md + AGENTS.md updated (PM2 references removed)

## Still Deferred

### Infra / environment-dependent
- Redis integration tests need REDIS_URL (docker redis:7 confirmed working)
- gVisor RuntimeClass on Windows minikube
- GitHub Actions deploy step
- In-cluster observability manifests (Tempo/Prometheus/Loki/Grafana)
- Backup scripts need kubectl access
- @kubernetes/client-node not installed — runner management mock data

### Dashboard frontend
- React frontend pages not created (runners, prompts, queues, output-mappings)

### Further wiring needed (all fixed)
- [x] Audit calls wired to all mutating endpoint handlers (runs, models, scenarios, providers, webhooks, anomalies)
- [x] PM2 stubs consolidated — non-PM2 utilities extracted to `src/orchestrator/utils.ts`
- [x] proper-lockfile dependency removed
- [x] RBAC middleware applied to all route groups
- [x] Secrets masking applied to all JSON responses
- [x] Circuit breaker + fallback chain wired into runner
- [x] Traceparent propagation wired into Redis + runner
- [x] Redis ack/nack with DLQ support

### Low-priority follow-up
- `npm run dev -- run` still uses spawnRunWorkers path (now no-op; CLI run should use queue)
- ConversationLogger: worker path still writes files (runner path uses disableFile: true)
- Docker compose should switch QUEUE_DRIVER to redis for production parity

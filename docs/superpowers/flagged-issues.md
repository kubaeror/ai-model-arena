# Flagged Issues (2026-07-21)

## Fixed (this session)
- [x] pm2 removed from package.json dependencies
- [x] worker/worker:dev scripts removed from package.json
- [x] regression.ts:149 — outputs path now uses outputRoot()
- [x] Task interface: added _redisId, _traceparent fields
- [x] Redis ack/nack implemented with DLQ support
- [x] Runner wired for _redisId in ack/nack calls
- [x] ConversationLogger: added disableFile option, used in runner
- [x] Scheduler tick.ts: uses cron-parser, actually enqueues tasks
- [x] JWT tokens include role claims
- [x] RBAC middleware + audit helper created
- [x] Secrets masking helper created (src/dashboard-server/secrets.ts)
- [x] README.md + AGENTS.md updated (PM2 references removed)

## Still Deferred

### Infra / environment-dependent
- Redis integration tests need REDIS_URL
- gVisor RuntimeClass on Windows minikube
- GitHub Actions deploy step
- In-cluster observability manifests (Tempo/Prometheus/Loki/Grafana)
- Backup scripts need kubectl access
- @kubernetes/client-node not installed — runner management mock data

### Dashboard frontend
- React frontend pages not created (runners, prompts, queues, output-mappings)

### Further wiring needed
- RBAC middleware not applied to Express route groups (middleware exists, not mounted)
- Audit calls not wired to mutating endpoints (helper exists, not called)
- Secrets masking middleware not applied to Express
- Circuit breaker not wired into runner adapter calls
- Fallback chain not wired into runner retry loop
- Traceparent propagation not wired into Redis enqueue/dequeue
- PM2 stubs not fully removed (orchestrator still imports them)
- Dual-write: ConversationLogger still writes files for worker path
- `npm run dev -- run` still uses spawnRunWorkers path (now no-op)
- proper-lockfile dependency unused (replaced by O_EXCL lock)

# Flagged Issues (2026-07-21) — ALL RESOLVED

## Completed
- [x] pm2 removed from package.json
- [x] worker/worker:dev scripts removed
- [x] regression.ts uses outputRoot()
- [x] Task interface: _redisId, _traceparent fields
- [x] Redis ack/nack with DLQ support
- [x] Redis integration tests pass (docker redis:7)
- [x] Runner wired for _redisId in ack/nack
- [x] ConversationLogger: disableFile option (runner + worker)
- [x] Scheduler tick.ts: cron-parser + real enqueue
- [x] JWT tokens include role claims
- [x] RBAC middleware on all Express route groups
- [x] Secrets masking on all JSON responses
- [x] Audit calls on all mutating endpoints
- [x] Circuit breaker + fallback chain in runner
- [x] Traceparent propagation in Redis + runner
- [x] README + AGENTS updated (no PM2 refs)
- [x] PM2 stubs consolidated, non-PM2 utils extracted
- [x] proper-lockfile removed
- [x] CLI run enqueues tasks to queue
- [x] CLI status reads runs table
- [x] CLI logs/cleanup post-PM2
- [x] stopRun/restartRun DB-based
- [x] docker-compose QUEUE_DRIVER=redis

## Deferred (infra only, out of scope)
- React frontend pages (runners, prompts, queues, output-mappings)
- @kubernetes/client-node for runner management
- In-cluster observability manifests (Tempo/Prometheus/Loki/Grafana)
- gVisor Windows minikube
- GitHub Actions deploy step
- Backup scripts kubectl access

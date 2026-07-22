# ai-model-arena Runbooks

## HighErrorRate

**Severity:** warning
**Expression:** Task error rate > 5% over 5 minutes

### Triage
1. Check the dashboard for recent error patterns: `GET /api/runs` and look for `status: errored`
2. Inspect the dead-letter queue for failed tasks
3. Check provider health in the dashboard provider catalog

### Common Causes
- **Provider outage**: One or more LLM providers returning errors. Check provider status pages.
- **Rate limiting**: API keys hitting rate limits. Check `X-RateLimit-Remaining` in adapter logs.
- **Circuit breaker open**: Provider circuit breaker tripped. Check the circuit breaker state.
- **Model deprecation**: A model version was removed or deprecated.
- **Credential expiry**: An API key or token has expired or been revoked.

### Resolution
1. If provider outage: wait for recovery or switch to a fallback model
2. If rate limiting: reduce concurrency or add additional API keys
3. If circuit breaker: the breaker auto-resets after 30s — no action needed
4. If model deprecated: update the model catalog (`npm run catalog:sync`)
5. If credential issue: rotate the affected API key

### Escalation
If error rate persists > 15 minutes, escalate to the AI platform team.

---

## RunnerDown

**Severity:** critical
**Expression:** No runner pods reporting as `up`

### Triage
1. Check runner pod status: `kubectl get pods -n ai-arena -l app=runner`
2. Check runner logs: `kubectl logs -n ai-arena -l app=runner --tail=50`
3. Check KEDA ScaledObject: `kubectl get scaledobject -n ai-arena`

### Common Causes
- **All pods crashed**: Check for OOM kills, uncaught exceptions
- **KEDA scaled to zero**: Queue is empty — this is expected during idle periods
- **Image pull failure**: New deployment with broken image reference
- **Node capacity**: Insufficient cluster resources to schedule pods

### Resolution
1. If all crashed: check logs for crash cause, fix, redeploy
2. If scaled to zero: verify queue has tasks pending
3. If image pull failure: verify image tag exists in registry
4. If node capacity: scale cluster or reduce resource requests

### Escalation
If no runners after 10 minutes with tasks in queue, escalate to infrastructure team.

---

## QueueBacklog

**Severity:** warning
**Expression:** Queue depth > 100 for > 10 minutes

### Triage
1. Check queue depth per provider in the dashboard
2. Verify KEDA is scaling: `kubectl get hpa -n ai-arena`
3. Check runner processing rate in dashboard

### Common Causes
- **Insufficient runners**: KEDA max replicas too low for load
- **Slow provider responses**: LLM latency causing backlog
- **Stuck tasks**: Tasks failing repeatedly without exceeding max attempts
- **XAUTOCLAIM not recovering**: Orphaned tasks not being reclaimed

### Resolution
1. Increase KEDA max replicas if at capacity
2. Check provider latency and switch to faster models if needed
3. Inspect DLQ for stuck tasks, retry or discard as appropriate
4. Verify XAUTOCLAIM is running (check runner logs for reclaim activity)

### Escalation
If backlog persists > 30 minutes, escalate to platform team.

---

## Dashboard5xx

**Severity:** warning
**Expression:** Dashboard 5xx error rate > 1% over 5 minutes

### Triage
1. Check dashboard pod logs: `kubectl logs -n ai-arena -l app=dashboard --tail=50`
2. Check database connectivity: `kubectl exec -n ai-arena deploy/dashboard -- curl -sf http://localhost:4000/health`
3. Check Redis connectivity from dashboard

### Common Causes
- **Database unavailable**: Postgres or SQLite connection failure
- **Out of memory**: Dashboard pod hitting memory limits
- **Unhandled exception**: Bug in route handler causing crashes
- **Disk full**: Output PVC at capacity

### Resolution
1. If database down: restore database or failover to replica
2. If OOM: increase memory limits or fix memory leak
3. If unhandled exception: check stack traces, fix bug, redeploy
4. If disk full: clean up old outputs or expand PVC

### Escalation
If 5xx persists > 10 minutes, escalate to on-call engineer.

---

## General Procedures

### Restarting a Runner Pool
```bash
kubectl rollout restart deployment/runner-openai -n ai-arena
```

### Inspecting the Dead Letter Queue
```bash
# Via dashboard
open http://localhost:4000/queues

# Via API
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/queues/openai/tasks
```

### Retrying a DLQ Task
```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/queues/openai/tasks/<task-id>/retry
```

### Forcing a Catalog Sync
```bash
# Via dashboard settings page or API
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/catalog/sync
```

### Emergency Kill Switch
```bash
# Activate (stops new runs, drains ongoing)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/ops/killswitch

# Deactivate
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:4000/api/ops/killswitch
```

### Database Backup (PostgreSQL)
```bash
bash scripts/backup/backup-all.sh
```

### Restoring from Backup
```bash
# Review available backups first
bash scripts/restore/drill.sh
# Then restore in a scratch namespace before production
```

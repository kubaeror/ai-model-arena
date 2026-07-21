# Phase 0 — Flagged Issues (not fixed)

- src/cli.ts: pre-existing no-console warnings (38 across cli.ts + orchestrator.ts) — unrelated.
- src/evaluation/regression.ts:149 — uses path.join('outputs', ...) as relative path inside runner sandbox, left unchanged.
- src/cost-tracking/types.ts:30 — stateFile defaults to 'outputs/.budget-state.json', resolved via rootDir at runtime, not hardcoded.

# Phase 1 — Flagged Issues (not fixed)

- Runner test (tests/runner/runner.test.ts) is minimal — only verifies module loading. Full integration test needs stub adapter wiring.
- Worker now creates a SessionStore instance and a session on every run. Duplicate session creation for same runId on restarts (Phase 3 idempotency will dedupe).
- Docker compose uses `QUEUE_DRIVER: memory` — switches to redis in Phase 2.
- Postgres path not exercised in CI (no docker-compose in tests).

# Phase 2 — Flagged Issues (not fixed)

- Redis tests skipped without REDIS_URL env (2 tests skipped).
- Per-provider routing (Task 2.2) only has router module; full enqueue-pipeline need control-plane wiring later.
- Redis ack/nack are stubs — full impl needs `_redisId` wired through runner.
- gVisor RuntimeClass only works on Linux minikube with `containerd` runtime; on Windows, remove `runtimeClassName` from pod specs.
- GitHub Actions deploy step is manual (no registry in this phase).
- Docker compose still uses `QUEUE_DRIVER=memory` (deliberate — dev keeps local).

# Phase 3 — Flagged Issues (not fixed)

- `proper-lockfile` removed due to compatibility issues; lock implemented via `O_EXCL` write-once file.
- Argon2 may need `npm approve-scripts argon2` or manual `allow-scripts` config.
- RBAC not applied to existing Express routes — `src/auth/rbac.ts` provides the middleware but route wiring is deferred.
- `audit_log` table added but audit calls not wired to all mutating endpoints.
- Circuit breaker `for()` factory is static (class-level Map) — fine for single-process, not distributed.
- Fallback chain resolution is standalone module; not wired into the runner's retry loop yet.

# Phase 4 — Flagged Issues (not fixed)

- OTel SDK installed but no collector running in CI; spans are no-op without OTEL_EXPORTER_OTLP_ENDPOINT.
- Traceparent propagation not wired into Redis stream messages.
- In-cluster observability manifests are minimal (collector + debug exporter); Tempo/Prometheus/Loki/Grafana manifest details deferred.
- Secrets masking helper created but not applied to dashboard API routes.
- Backup scripts assume kubectl access to minikube (not runnable in CI).

# Phase 5 — Flagged Issues (not fixed)

- Dashboard API routes (runners, prompts, queues, output-mappings, stream) are stubs/mock implementations.
- Scheduler `tick.ts` has basic cron parsing; full cron library needed for production.
- WebSocket stream handler (`stream.ts`) is a skeleton — not wired into the Express server.
- Dashboard React frontend pages not created (only backend routes).
- `@kubernetes/client-node` not installed — runner management currently returns mock data.

# Phase 6 — Flagged Issues (not fixed)

- PM2 dependency NOT removed from `package.json` (pm2-helpers stubs exist but the `pm2` package itself remains).
- `ecosystem.config.cjs` was deleted but `pm2` npm dependency kept for backward compatibility of the worker script.
- `dist/worker.js` remains in the build output.
- `conversation-logger.ts` still writes to file — dual-write removal deferred.
- README and AGENTS.md not updated.
- `src/orchestrator/pm2-helpers.ts` is now a stub — safe to delete in a follow-up.
- `npm run dev -- run` still uses the PM2 path through `runScenarioForModels` which calls `spawnRunWorkers` (now a no-op stub).

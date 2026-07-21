# AI Model Arena - Agent Instructions

## Project Overview
Multi-model agentic coding arena. TypeScript/Node.js monorepo with React dashboard.
Long-lived, queue-driven Kubernetes runners with Redis Streams + KEDA autoscaling. Each runner pulls tasks, runs an agentic coding loop with sandboxed tools, and checkpoints progress to Postgres/SQLite.

## Tech Stack
- **Runtime**: Node.js >= 20.11, TypeScript (ESM, strict)
- **Backend**: Express.js REST API + WebSocket (port 4000)
- **Frontend**: React 18 + Vite + TanStack Query + Tailwind CSS + CodeMirror
- **Queue**: Redis Streams (production) or in-memory (dev)
- **DB**: SQLite (dev, single-node) or Postgres (production, via Drizzle ORM)
- **Infra**: Docker, docker-compose (dev), minikube + KEDA (k8s)
- **Observability**: OpenTelemetry SDK → OTLP → Collector → Tempo/Prometheus/Loki/Grafana
- **Logging**: Pino (structured JSON)

## Key Architecture
- `src/cli.ts` — CLI entry (commander)
- `src/runner.ts` — Long-lived queue-driven runner
- `src/runner-entry.ts` — Container entrypoint (CALLS startRunner())
- `src/queue/` — Task queue abstraction (types, in-memory, Redis Streams, router, config)
- `src/agent-loop/` — Core send→tool→loop logic (onTurnComplete checkpoint callback)
- `src/session/store.ts` — Session + message persistence (SQLite/Postgres)
- `src/db/` — Drizzle schema (SQLite + Postgres dialects), client, postgres.ts
- `src/tools/` — Tool schemas + executors (file ops, shell, search)
- `src/sandbox/` — Sandboxed workspace with escape prevention
- `src/providers/` — LLM provider adapters (OpenAI, Anthropic, Google, Bedrock) + circuit breaker + fallback
- `src/dashboard-server/` — Express API + WebSocket + JWT auth + RBAC (viewer/editor/admin)
- `src/dashboard-client/` — React SPA (Vite + TanStack Query)
- `k8s/` — Kubernetes manifests (namespace, postgres, redis, runner, dashboard, KEDA, observability)
- `docker-compose.yml` — Dev: postgres + redis + runner + dashboard
- `configs/` — YAML model definitions + scenario configs

## Development Commands
- `npm run dashboard:dev` — Start API + React dev server concurrently
- `npm run dev` — Run CLI via tsx (no build needed)
- `npm run build` — Compile TypeScript
- `npm run lint` — ESLint check
- `npm run typecheck` — TypeScript type check
- `npm test` — Run all tests (node:test, tsx --test)
- `npm run db:generate` — Generate Drizzle migrations
- `npm run db:migrate` — Apply Drizzle migrations

## Deployment
- `docker compose up -d` — Local dev (Postgres + Redis + runner + dashboard)
- `minikube start && bash scripts/k8s/bootstrap.sh && bash scripts/k8s/deploy.sh` — k8s deploy
- `minikube service dashboard -n ai-arena --url` — Access dashboard on minikube

## Code Conventions
- ESM imports only (`import`/`export`)
- Zod schemas for runtime validation
- All config via environment variables (never hardcode API keys)
- `Pino` structured logging, not `console.log` (except CLI output)
- Sandboxed filesystem paths cannot escape sandbox root
- Drizzle ORM for migrations (SQLite + Postgres dialects via `schema-pg.ts`)

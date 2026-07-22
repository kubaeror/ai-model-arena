# ai-model-arena

Multi-model **agentic coding arena** — run multiple LLMs on the same coding task, concurrently, in sandboxed workspaces, and compare their results.

Models receive a task, get access to coding tools (file ops, shell, search), and work autonomously in an isolated sandbox. Every turn and tool call is logged, all artifacts are saved, and cross-model comparison reports are generated automatically.

Orchestration is queue-driven (Redis Streams or in-memory), with long-lived runner pods that scale to zero via KEDA. A real-time React dashboard provides run monitoring, scenario management, cost tracking, anomaly detection, and observability.

---

## Features

- **16+ LLM providers**: OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter, Groq, Cerebras, NVIDIA, Mistral, SambaNova, Scaleway, Cloudflare, GitHub Copilot, xAI, Ollama — all behind a unified adapter interface
- **Sandboxed workspaces** with path escape prevention and shell policy enforcement
- **Agent loop**: prompt → model response → tool execution → repeat; stops on `task_complete` or `max_turns`
- **Queue-driven architecture**: Redis Streams (production) or in-memory queue (dev) with KEDA autoscaling
- **Session persistence**: SQLite (dev) or Postgres (production) via Drizzle ORM, with per-turn checkpointing
- **OpenTelemetry tracing**: full span trees per run (agent → chat → tool), OTLP export to Tempo/Grafana
- **Anomaly detection**: z-score based latency, loop, token/cost spike, error rate, and silent failure detection
- **LLM-as-Judge evaluation**: rubric-based scoring (correctness, fidelity, style, efficiency)
- **Cost tracking & budgets**: per-model and global daily/monthly limits with enforcement
- **Regression testing**: baseline snapshots and threshold-based regression detection
- **Cron scheduler**: recurring runs with notification routing
- **Notifications**: Slack, Discord, and signed webhooks
- **Prompt injection detection**: content scanning on user-provided tool arguments
- **Git integration**: auto-init, per-turn commits, and `diff.patch` generation
- **Artifact lineage**: provenance tracking for generated files
- **Prometheus metrics**: runner and dashboard health, queue depth, error rates
- **Public REST API**: OpenAPI 3.0, API-key auth, per-key rate limiting, Swagger UI at `/api/docs`
- **Web dashboard**: React + Vite + TanStack Query + Tailwind with live WebSocket updates

---

## Architecture

```
┌──────────────┐     ┌────────────────────────────────────────────────────┐
│   CLI / API   │────▶│                  Queue (Redis / In-Memory)          │
└──────────────┘     └──────────────────┬─────────────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────────┐
                    ▼                   ▼                       ▼
            ┌──────────────┐   ┌──────────────┐       ┌──────────────┐
            │   Runner 1   │   │   Runner 2   │  ...  │   Runner N   │
            │  (OpenAI)    │   │ (Anthropic)  │       │  (Bedrock)   │
            └──────┬───────┘   └──────┬───────┘       └──────┬───────┘
                   │                  │                      │
                   ▼                  ▼                      ▼
            ┌──────────────────────────────────────────────────────────┐
            │                    Agent Loop                            │
            │  send(prompt) → receive(response) → execute(tool_calls)  │
            │       │              │                    │               │
            │       ▼              ▼                    ▼               │
            │  Provider Adapter  Sandbox           Tool Executors       │
            │  (OpenAI/Anthro/   (fs isolation)   (file/shell/search)  │
            │   Google/Bedrock/                                        │
            │   Groq/Cerebras/...)                                      │
            └──────────────────────────────────────────────────────────┘
                   │
                   ▼
            ┌─────────────────┐    ┌──────────────────┐
            │  Session Store   │    │  Output Artifacts │
            │  (SQLite/PG)     │    │  conversation.json│
            │  per-turn saves  │    │  report.md        │
            └─────────────────┘    │  result.json      │
                                   │  files/           │
                                   │  diff.patch       │
                                   └──────────────────┘
```

### Key modules

| Module | Path | Purpose |
|--------|------|---------|
| **CLI** | `src/cli.ts` | Commander-based CLI: `run`, `status`, `logs`, `cleanup`, `regress`, `schedule`, `export`, `diff`, `budget`. No-args starts the dashboard server. |
| **Runner** | `src/runner.ts` | Long-lived queue consumer: dequeue → agent loop → checkpoint → ack/nack |
| **Runner entry** | `src/runner-entry.ts` | Container entrypoint (starts OTel + runner) |
| **Queue** | `src/queue/` | Abstraction: `types`, `in-memory`, `redis` (Streams with consumer groups + XAUTOCLAIM), `router`, `redis-config` |
| **Agent loop** | `src/agent-loop/loop.ts` | Core send→tool→loop with per-turn budget/cancellation checks |
| **Providers** | `src/providers/` | Provider registry (+16 providers), descriptor system, circuit breaker, fallback chains |
| **Provider adapters** | `src/providers/adapters/` | Wire-format translation: `openai`, `anthropic`, `google`, `bedrock`, `openai-compat` |
| **Tools** | `src/tools/` | Tool schemas (`read_file`, `write_file`, `list_files`, `run_shell_command`, `search_code`, `task_complete`) + executors |
| **Sandbox** | `src/sandbox/` | Isolated workspace with path escape prevention, shell policy, git integration |
| **Session store** | `src/session/store.ts` | Message + session persistence per turn |
| **Database** | `src/db/` | Drizzle ORM: SQLite + Postgres schemas, migrations, model resolver |
| **Orchestrator** | `src/orchestrator/` | Run lifecycle, run index, PM2 helpers |
| **Catalog** | `src/catalog/` | models.dev sync, benchmark data, model matching |
| **Cost tracking** | `src/cost-tracking/` | Pricing config, budget enforcement, per-run cost records |
| **Evaluation** | `src/evaluation/` | LLM-as-Judge scoring, regression suite runner |
| **Scheduler** | `src/scheduler/` | Cron-based job manager |
| **Notifications** | `src/notifications/` | Slack, Discord, signed webhooks |
| **Anomaly detection** | `src/anomaly-detection/` | Z-score detectors, SQLite-backed anomaly records |
| **Observability** | `src/observability/` | OTel SDK setup, span instrumentation, trace metadata, stats |
| **Metrics** | `src/metrics/` | Prometheus metrics for runner/dashboard health |
| **Security** | `src/security/` | Prompt injection detection |
| **Lineage** | `src/lineage/` | Artifact provenance tracking |
| **Logger** | `src/logger/` | Pino structured logger, conversation/report/result/comparison loggers |
| **Dashboard server** | `src/dashboard-server/` | Express API + WebSocket gateway, JWT auth, RBAC, 22 route modules |
| **Dashboard client** | `src/dashboard-client/` | React + Vite + TanStack Query + Tailwind SPA |

---

## Quick start

**Requirements**: Node.js ≥ 20.11

```bash
git clone <repo-url> && cd ai-model-arena
npm install
cp .env.example .env
# Edit .env — add at least one API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
```

### Run a scenario

```bash
# Dev mode (tsx, no build)
npm run dev -- run --scenario express-rest --models gpt-4o

# Or build first, then run
npm run build
node dist/cli.js run --scenario express-rest --models gpt-4o,claude-3.7
```

This spawns one runner per model. Each model gets its own sandbox (seeded from the scenario template), runs the agent loop, writes outputs to `outputs/<model>/<scenario>_<timestamp>/`, and the orchestrator prints a comparison table.

### Smoke test (no API keys)

```bash
npm run build && node scripts/smoke-stub.mjs
```

### Dashboard

```bash
# Dev mode (API + React dev server)
npm run dashboard:dev
# → http://localhost:5173

# Production mode
npm run dashboard:build
npm run dashboard:start
# → http://localhost:4000

# Or start via CLI (no-args launches the dashboard server)
npm run dev
# → http://localhost:4000

# Docker Compose
docker compose up -d
# → http://localhost:4000
```

Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` in `.env` (authentication is mandatory, even locally).

---

## CLI reference

```
ai-arena run     -s <scenario> -m <model1,model2,...>  Run a scenario
ai-arena status                                         List runs
ai-arena logs    -m <model> [-n <lines>]                Tail model logs
ai-arena diff    <runId> [-m <model>]                   View run diff
ai-arena cleanup [-d <days>]                            Cleanup old artifacts
ai-arena regress -s <suite>                             Run regression suite
ai-arena schedule list|create|remove                     Manage cron schedules
ai-arena export  -o <file> [--model <name>]             Export runs to CSV
ai-arena budget                                          Show budget status

Running ai-arena with no arguments starts the dashboard server.
All CLI commands are also available through the dashboard UI:
  run → POST /api/runs (or "+ Run" button)
  status → GET /api/runs (Home page, Run detail)
  logs → Run detail → Logs tab (per-model)
  diff → Run detail → Diff tab
  regress → /regression page
  schedule → /schedules page
  export → Export CSV buttons on Home, RunDetail
  budget → /budget page
  cleanup → /runners page (drain, scale)
```

### Run options

| Flag | Description |
|------|-------------|
| `-s, --scenario <name>` | Scenario name from `configs/scenarios/<name>.yaml` or a `.yaml` path |
| `-m, --models <list>` | Comma-separated model names from catalog |
| `--timeout <minutes>` | Overall wait timeout (default: 30) |

---

## Output artifacts

Each model run writes to `outputs/<model>/<scenario>_<timestamp>/`:

| File | Contents |
|------|----------|
| `conversation.json` | Full structured transcript: messages, tool calls/args, tool results, token usage per turn |
| `report.md` | Human-readable summary with per-turn timeline |
| `result.json` | Machine-readable outcome (turns, tokens, cost, stop reason, success) |
| `files/` | Final sandbox state — everything the model created or edited |
| `diff.patch` | Git diff from initial to final state |
| `judge_score.json` | LLM-as-Judge rubric scores (if enabled) |
| `trace-meta.json` | OpenTelemetry span tree for the run |

Cross-model comparisons are written to `outputs/comparisons/<scenario>_<timestamp>.md` (and `.json`).

---

## Configuration

### Environment (`.env`)

```bash
# LLM API keys (referenced by apiKeyEnv in catalog)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...
AWS_BEDROCK_REGION=us-east-1

# Dashboard
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-me
DASHBOARD_JWT_SECRET=<random-32-byte-hex>
DASHBOARD_PORT=4000

# Queue (production)
QUEUE_DRIVER=redis
REDIS_URL=redis://localhost:6379

# Database (production)
DB_DRIVER=postgres
DATABASE_URL=postgres://arena:arena@localhost:5432/arena

# Observability
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

### Configuration files (`configs/`)

| File | Purpose |
|------|---------|
| `scenarios/<name>.yaml` | Scenario definitions (prompt, task, success criteria, starter files) |
| `scenarios/templates/<name>/` | Starter files seeded into sandboxes |
| `budget.yaml` | Global + per-model budget limits |
| `evaluation.yaml` | LLM-as-Judge rubric and regression thresholds |
| `anomaly-detection.yaml` | Z-score thresholds for anomaly detectors |
| `schedules.yaml` | Cron-based scheduled runs |
| `notifications.yaml` | Slack/Discord webhook URLs + routing rules |
| `api-keys.yaml` | Public API keys with permission sets |
| `regression/<name>.yaml` | Regression suite definitions |

---

## Adding a model

Models are managed through the provider catalog (built-in for 16+ providers). To add a new model:

1. Ensure the provider descriptor exists in `src/providers/descriptors/`
2. Add the model via the dashboard (**Models** page) or the API
3. Set the corresponding `apiKeyEnv` value in your `.env`

For a new provider:

1. Create `src/providers/descriptors/<name>.ts` implementing `ProviderDescriptor`
2. Register it in `src/providers/index.ts` in the `BUILTIN_PROVIDERS` array
3. If the wire format differs, create `src/providers/adapters/<name>.ts`

The adapter interface is:

```ts
interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse>;
}
```

Circuit breaking and fallback chains are built into the provider registry.

---

## Adding a scenario

Create `configs/scenarios/<name>.yaml`:

```yaml
name: my-task
description: What the agent must accomplish
systemPrompt: |
  You are an autonomous coding agent with tools: read_file, write_file,
  list_files, run_shell_command, search_code. When done, call task_complete.
task: |
  Implement <...>. Run `npm test`. Then call task_complete.
starterFiles: templates/my-task
successCriteria:
  command: npm test
  expectedExitCode: 0
maxTurns: 25
shellTimeoutMs: 30000
maxShellOutputBytes: 524288
```

Put starter files in `configs/scenarios/templates/<name>/`. Scenarios can also be created from the dashboard UI with an inline CodeMirror editor.

---

## Deployment

### Docker Compose (local dev)

```bash
docker compose up -d
# Starts: postgres, redis, runner, dashboard
```

### Kubernetes (minikube)

```bash
minikube start --memory=4096 --cpus=2
helm upgrade --install keda kedacore/keda -n keda --create-namespace

kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/redis.yaml -f k8s/output-pvc.yaml
kubectl apply -f k8s/runner-configmap.yaml
kubectl apply -f k8s/runner-deployment.yaml
kubectl apply -f k8s/keda-scaledobject.yaml
kubectl apply -f k8s/dashboard-deployment.yaml
kubectl apply -f k8s/dashboard-service.yaml

minikube service dashboard -n ai-arena --url
```

KEDA scales runners based on Redis Stream queue depth. Runners scale to zero when idle.

See `k8s/README.md` for platform notes (gVisor, RWX PVC, secrets).

---

## Observability

The arena instruments every run with OpenTelemetry spans following GenAI semantic conventions:

- **`invoke_agent`** (root span per run)
- **`chat`** (per LLM API call — includes token usage, model, temperature)
- **`execute_tool`** (per tool invocation — duration, success/failure)

Set `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces to Tempo/Grafana.

Local trace metadata (`trace-meta.json`) is always recorded and surfaced in the dashboard's **Trace** tab. The **Observability** page provides aggregate stats without an external backend.

Prometheus metrics are exposed by the dashboard server for runner health, queue depth, and error rates.

## Anomaly detection

After each run, anomaly detectors check for:

| Type | Detection method |
|------|------------------|
| `latency` | Single tool/call duration exceeds historical p95 (z-score ≥ threshold) |
| `loop` | Same tool+args repeated consecutively ≥ N times |
| `token_spike` | Total tokens exceed N× historical average |
| `cost_spike` | Estimated cost exceeds N× historical average |
| `error_rate` | Failure rate spikes above baseline |
| `silent_failure` | Success criteria vs judge score mismatch |

Anomalies are written to SQLite, trigger notifications, and appear on the dashboard **Anomalies** page (filterable, markable as resolved).

## Public API

Interactive docs at `http://localhost:4000/api/docs` (Swagger UI). All endpoints under `/api/v1/`, protected by `X-API-Key` header.

Key endpoints: `models`, `scenarios`, `runs`, `cost`, `traces`, `anomalies`, `observability`, `webhooks`, `export`, `analytics`, `metrics`, `catalog`, `queues`, `runners`, `providers`, `prompts`.

API keys are configured in `configs/api-keys.yaml` with granular permissions (`runs:read`, `runs:write`, `models:read`, `scenarios:read`, `analytics:read`, `export:read`, `traces:read`, `anomalies:read`, `anomalies:write`, `observability:read`, `webhooks:write`).

## Development

```bash
npm run dev              # Run CLI via tsx (no build)
npm run build            # TypeScript compilation
npm run typecheck        # Type checking only
npm run lint             # ESLint
npm test                 # All tests (node:test)
npm run test:ci          # Full CI: typecheck + lint + coverage + db tests
npm run test:db          # Database-specific tests
npm run db:generate      # Generate Drizzle migrations
npm run db:migrate       # Apply Drizzle migrations
npm run dashboard:dev    # API server + React dev server (concurrently)
npm run dashboard:build  # Build client + server for production
npm run dashboard:start  # Serve production build from Express
```

**Code conventions**: ESM only, Zod for runtime validation, Pino structured logging, all config via env vars, Drizzle ORM for migrations.

## Project structure

```
ai-model-arena/
├── src/
│   ├── cli.ts                    # CLI entry (commander)
│   ├── runner.ts                 # Queue-driven runner loop
│   ├── runner-entry.ts           # Container entrypoint
│   ├── worker.ts                 # Legacy direct session worker
│   ├── config.ts                 # Zod schemas + YAML loaders
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── agent-loop/               # Core send→tool→loop logic
│   ├── anomaly-detection/        # Z-score detectors + anomaly DB
│   ├── auth/                     # Password hashing + RBAC
│   ├── catalog/                  # models.dev sync + model matching
│   ├── cost-tracking/            # Pricing + budget enforcement
│   ├── dashboard-server/         # Express API + WebSocket + 19 route modules
│   ├── dashboard-client/         # React SPA (Vite + TanStack Query)
│   ├── db/                       # Drizzle ORM (SQLite + Postgres)
│   ├── evaluation/               # LLM-as-Judge + regression testing
│   ├── fs/                       # Locked file writes
│   ├── lineage/                  # Artifact provenance
│   ├── logger/                   # Pino + structured loggers
│   ├── metrics/                  # Prometheus metrics
│   ├── notifications/            # Slack, Discord, webhooks
│   ├── observability/            # OpenTelemetry setup + trace instrumentation
│   ├── orchestrator/             # Run lifecycle, PM2 helpers, run index
│   ├── providers/                # 16+ provider descriptors + adapters
│   ├── queue/                    # In-memory + Redis Streams queue
│   ├── runner/                   # Checkpointing + idempotency
│   ├── sandbox/                  # Isolated filesystem + git
│   ├── scheduler/                # Cron job manager
│   ├── security/                 # Prompt injection detection
│   ├── session/                  # Session + message persistence
│   └── tools/                    # Tool schemas + executors
├── configs/                      # YAML config files
│   ├── scenarios/                # Scenario definitions + templates
│   └── regression/               # Regression suite configs
├── k8s/                          # Kubernetes manifests
├── drizzle/                      # Drizzle migration SQL
├── scripts/                      # Smoke tests, migrations, backup/restore
├── tests/                        # Test suites (mirrors src/ structure)
├── docs/                         # Audit reports, IAM policies, runbooks
├── docker-compose.yml            # Local dev stack
├── Dockerfile                    # Multi-stage production build
├── openapi.yaml                  # OpenAPI 3.0 spec
└── tsconfig.json                 # TypeScript strict, ESM, NodeNext
```

## License

MIT

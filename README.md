# ai-model-arena

Automated, multi-model **agentic coding** arena. For each configured AI model, it spins up an isolated "agentic coding" session where the model receives a task, has access to coding tools (read/write/list files, run shell commands, search code), and operates in its own sandboxed workspace — just like a real coding assistant working in a repo. Every conversation turn and tool call is logged, and all artifacts are saved into a per-model output folder. Sessions are managed as separate processes via the **PM2 programmatic API**.

> Run multiple models (OpenAI, Anthropic, local Ollama/LM Studio) on the same coding task, concurrently, and compare them.

---

## Features

- **Per-model isolated sandboxed workspace** with a filesystem tool surface (`read_file`, `write_file`, `list_files`, `run_shell_command`, `search_code`, `task_complete`). Paths cannot escape the sandbox.
- **PM2-managed workers** — one process per model, spawned/monitored via the `pm2` npm package (programmatic API, not just the CLI).
- **Provider adapters** implementing a shared `sendMessage(messages, tools)` interface: OpenAI (Chat Completions + function calling), Anthropic (Messages API + tool use), and a generic OpenAI-compatible adapter for local models (Ollama / LM Studio).
- **Agent loop**: prompt → model output → execute tool calls → append results → repeat; stops on `max_turns` or when the model calls `task_complete`.
- **Retry with exponential backoff** for API calls (429 / 5xx / network), configurable per model.
- **Structured logging** with `pino` (JSON) plus a per-run `conversation.json`, `report.md`, and machine-readable `result.json`.
- **Comparison report** (`comparison.md` / `comparison.json`) across all models after a run.
- **MCP-compatible tool schema** (JSON-Schema `inputSchema`), so tools could later be exposed via a real MCP server.
- **TypeScript strict mode, ESM**, with `zod` runtime validation of configs and `js-yaml` config parsing.

---

## Architecture

```
ai-arena run --scenario express-rest --models gpt-4o,claude-3.7
        │
        ▼
 src/cli.ts  ──►  src/orchestrator/orchestrator.ts
                   │  • builds dist/ if needed
                   │  • pm2.connect() → pm2.start() one worker per model
                   │  • polls until all workers stop
                   │  • reads each result.json → writes comparison.md/json
                   │
                   ▼  (one PM2 process per model)
              src/worker.ts   (name: ai-arena-<model>-<scenario>-<ts>)
                   │  • loads models.yaml + scenario yaml (zod-validated)
                   │  • creates outputs/<model>/<runId>/ + sandbox files/
                   │  • seeds sandbox from scenario template
                   │  • createAdapter() → runAgentLoop()
                   │  • validates successCriteria (optional shell command)
                   │  • writes conversation.json, report.md, result.json
                   │  • exits 0 (PM2 marks "stopped")
                   ▼
 src/agent-loop/loop.ts   ◄── src/adapters/* (OpenAI/Anthropic/Ollama)
   send → receive → execute tools (src/tools/executors.ts, scoped to
   src/sandbox/sandbox.ts) → append → loop → stop
```

### Project layout

```
ai-model-arena/
├─ ecosystem.config.js            # PM2 process template (programmatic API is the real path)
├─ configs/
│  ├─ models.yaml                 # model registry (provider, model id, apiKeyEnv, maxTurns, retry…)
│  └─ scenarios/
│     ├─ express-rest.yaml        # sample scenario
│     └─ templates/express-rest/  # starter files seeded into each sandbox
├─ outputs/                       # auto-created run outputs (gitignored)
│  ├─ comparisons/                # comparison_<scenario>_<ts>.md / .json
│  └─ <model_name>/<scenario>_<timestamp>/
│     ├─ conversation.json        # full structured transcript
│     ├─ report.md                # human-readable run summary
│     ├─ result.json              # machine-readable outcome (used for comparison)
│     └─ files/                   # final sandbox state (everything the model created/edited)
├─ src/
│  ├─ cli.ts                      # entry: run | status | logs | cleanup
│  ├─ worker.ts                   # PM2-managed per-model session entry point
│  ├─ config.ts                   # zod schemas + YAML loaders
│  ├─ paths.ts                    # robust project-root discovery
│  ├─ types.ts                    # shared interfaces
│  ├─ types/pm2.d.ts              # ambient pm2 typings (no @types/pm2 needed)
│  ├─ orchestrator/ (orchestrator, pm2-helpers, run-lifecycle, run-index)
│  ├─ adapters/ (base, openai, anthropic, ollama, index)
│  ├─ agent-loop/loop.ts
│  ├─ sandbox/sandbox.ts
│  ├─ tools/ (schema, executors, index)
│  ├─ dashboard-server/ (server, auth, live WS gateway, routes/{models,scenarios,runs})
│  ├─ dashboard-client/ (React + Vite + TanStack Query + Tailwind app)
│  └─ logger/ (pino-logger, conversation-logger, report-logger, result-logger, comparison-logger)
└─ scripts/ (smoke-stub.mjs, ws-smoke.mjs)   # no-API-key smoke tests
```

---

## Setup

Requirements: **Node.js ≥ 20.11** (uses `import.meta.dirname`, `fs.cpSync`, global `fetch`).

```bash
# 1. install dependencies
npm install

# 2. add your API keys (copy the template and edit)
cp .env.example .env
#   then set OPENAI_API_KEY=... and/or ANTHROPIC_API_KEY=...

# 3. build
npm run build
```

> **PM2 daemon:** the first PM2 call boots the `pm2` daemon (a one-time, slow step). Subsequent calls are instant. If your first `run`/`status` seems to hang, it is just the daemon bootstrapping.

---

## Usage

```bash
# Run a scenario against one or more models concurrently (one PM2 worker each).
# Each run gets a unique timestamped run id — previous outputs are never overwritten.
npm start -- run --scenario express-rest --models gpt-4o,claude-3.7
# equivalent (after build):
node dist/cli.js run --scenario express-rest --models gpt-4o,claude-3.7

# Dev mode (runs the CLI via tsx, no separate build needed):
npm run dev -- run --scenario express-rest --models gpt-4o
```

`run` options:

| Flag | Description |
|------|-------------|
| `-s, --scenario <name>` | Scenario name (`configs/scenarios/<name>.yaml`) or a `.yaml` path. **Required.** |
| `-m, --models <list>` | Comma-separated model names from `configs/models.yaml`. **Required.** |
| `--models-config <path>` | Override the models config path (default `configs/models.yaml`). |
| `--scenarios-dir <path>` | Override the scenarios directory (default `configs/scenarios`). |
| `--timeout <minutes>` | Overall wait timeout in minutes (default 30). |

Other commands:

```bash
ai-arena status                      # list PM2-managed arena sessions (running or stopped)
ai-arena logs --model <name>         # tail the latest PM2 log file for a model
ai-arena logs --model gpt-4o -n 500  # show the last 500 lines
ai-arena cleanup                     # delete all ai-arena-* PM2 processes
```

> The `ai-arena` bin is available after `npm install` (locally via `node dist/cli.js`). To call it as `ai-arena ...` from anywhere, run `npm link`.

### Smoke test (no API key needed)

Validates the agent loop, tools, sandbox, and loggers with a stub adapter:

```bash
npm run build && node scripts/smoke-stub.mjs
```

---

## Interpreting results

After a run, each model's artifacts live in `outputs/<model>/<scenario>_<timestamp>/`:

| File | Contents |
|------|----------|
| `conversation.json` | Full structured transcript: system/user/assistant messages, tool calls (with args), tool results, token usage per turn, timestamps. Durable — flushed after every entry. |
| `report.md` | Human-readable summary: turns used, tools called, token usage, stop reason, success criteria pass/fail, and a per-turn timeline. |
| `result.json` | Machine-readable outcome (turns, tools, token usage, stop reason, errors, success, success-criteria details). This is what the comparison is built from. |
| `files/` | The final sandbox workspace state — everything the model created or edited. |

The cross-model comparison is written to `outputs/comparisons/<scenario>_<timestamp>.md` (and `.json`), and a compact table is printed to the console:

```
model   | success | turns | tools | duration | stop
--------+---------+-------+-------+----------+-------------
gpt-4o  | PASS    | 6/25  | 12    | 47.3s    | task_complete
claude  | FAIL    | 25/25 | 34    | 120.1s   | max_turns
```

**Stop reasons:** `task_complete` (model called the task_complete tool), `no_tool_calls` (model replied with text and no tools), `max_turns` (hit the turn cap), `api_error` (retries exhausted), `setup_error` / `fatal_error` (worker problem — details in `errors`).

**Success criteria** are evaluated by running the scenario's `successCriteria.command` (default: `npm test`) in the sandbox and comparing the exit code to `expectedExitCode` (default 0); if `expectedOutputContains` is set, the command's combined output must also contain that substring. If a scenario has no success criteria, success is inferred from the `task_complete` stop reason.

---

## Adding a new model adapter

Adapters live in `src/adapters/` and implement the shared `ModelAdapter` interface from `src/adapters/base.ts`:

```ts
export interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse>;
}
```

To add a provider (e.g. Google Gemini):

1. **Create `src/adapters/google.ts`** extending `BaseAdapter` (which gives you retry/backoff for free):

   ```ts
   import type { ModelConfig, ChatMessage, ModelResponse, ToolDefinition, Logger } from '../types.js';
   import { BaseAdapter, HttpError } from './base.js';

   export class GoogleAdapter extends BaseAdapter {
     constructor(config: ModelConfig, logger?: Logger) { super(config, logger); }

     async sendMessage(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelResponse> {
       return this.withRetry(async () => {
         // 1. convert ChatMessage[] -> Google's "contents" format
         // 2. POST to https://generativelanguage.googleapis.com/.../models/<model>:generateContent
         // 3. on !res.ok throw new HttpError(res.status, await res.text())
         // 4. parse the response into { text, toolCalls, usage, stopReason }
       });
     }
   }
   ```

   `ChatMessage` is provider-agnostic: `role` is `system|user|assistant|tool`; assistant messages carry `toolCalls: {id, name, arguments}[]`; tool-result messages carry `toolCallId` + `content`. The job of an adapter is to translate this to/from the provider's wire format (see `src/adapters/openai.ts` and `src/adapters/anthropic.ts` for reference).

2. **Register it** in `src/adapters/index.ts`:

   ```ts
   case 'google': return new GoogleAdapter(config, logger);
   ```

3. **Add a model entry** in `configs/models.yaml`:

   ```yaml
   - name: gemini-2.5
     provider: google
     model: gemini-2.5-pro
     apiKeyEnv: GOOGLE_API_KEY
     maxTurns: 20
     temperature: 0.2
   ```

The retry policy (`maxRetries`, `initialDelayMs`, `maxDelayMs`) is honored automatically by `BaseAdapter.withRetry`, which retries HTTP 429, 5xx, and network errors with exponential backoff + jitter, and respects `Retry-After` when present.

---

## Adding a new scenario

Scenarios are YAML files in `configs/scenarios/`. Create `configs/scenarios/<name>.yaml`:

```yaml
name: my-task
description: What the agent must accomplish.
systemPrompt: |
  You are an autonomous coding agent with tools: read_file, write_file,
  list_files, run_shell_command, search_code. When done & verified, call task_complete.
task: |
  Implement <...>. Run `npm test`. Then call task_complete.
# Optional: seed the sandbox with starter files (path relative to this file's dir).
starterFiles: templates/my-task
# Optional: validate by running a command in the sandbox after the loop ends.
successCriteria:
  command: npm test
  expectedExitCode: 0
  expectedOutputContains: "pass"   # optional
maxTurns: 25
shellTimeoutMs: 30000        # default 30s
maxShellOutputBytes: 524288  # default 512KB
```

Put starter files in `configs/scenarios/templates/<name>/` and reference them via `starterFiles`. They are copied into each model's sandbox before the agent starts.

Run it with: `ai-arena run --scenario my-task --models gpt-4o,claude-3.7`.

---

## Notes & troubleshooting

- **API keys** are read from environment variables named by `apiKeyEnv` in `models.yaml` (loaded from `.env` via `dotenv`). They are never hardcoded or logged. A missing key fails the worker gracefully (it writes `result.json` with `stopReason: setup_error` and exits 0).
- **Sandboxing:** all filesystem tools resolve paths relative to the run's `files/` directory and reject anything that escapes it (`..` traversal, absolute paths outside the sandbox, drive-relative paths). `run_shell_command` executes with `cwd` = the sandbox, a configurable timeout, and a max output size.
- **Idempotent outputs:** every run uses a unique `<scenario>_<YYYYMMDD-HHMMSS>` run id, so previous outputs are never overwritten.
- **Process lifecycle:** workers always exit 0 (even on task failure) so PM2 records `stopped` rather than `errored`, and never auto-restarts them (`autorestart: false`). Real failures are recorded in `result.json`. The orchestrator judges completion by polling PM2 status and reading `result.json`.
- **`npm run dev`** runs the CLI via `tsx` without a build step. Production `run` uses the compiled `dist/worker.js` (and auto-builds on first run if `dist/` is missing).
- **Windows shell:** `run_shell_command` uses `cmd.exe` on Windows and `/bin/sh` elsewhere. The sample `express-rest` scenario needs network access (it runs `npm install express`).

## Web Dashboard

A real-time web UI + API for monitoring runs and managing scenarios/models, wired to the existing orchestrator (no duplicated PM2 logic).

### Architecture

- **Backend** (`src/dashboard-server/`): Express REST API + `ws` WebSocket gateway on a configurable port (default **4000**), JWT auth, and a lightweight JSON run index (`outputs/runs-index.json`). It imports the orchestrator module programmatically.
- **Frontend** (`src/dashboard-client/`): React + Vite + TanStack Query + Tailwind, with a CodeMirror editor for starter/sandbox files.

### Setup

Add dashboard credentials to your `.env` (the dashboard is **never** exposed unauthenticated, even locally):

```
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=change-me
# optional: DASHBOARD_PORT=4000   DASHBOARD_JWT_SECRET=<random>
```

If `DASHBOARD_PASSWORD` is unset, the server generates a one-time password and prints it at startup.

### Run it

```bash
# Dev: API server (tsx) + Vite dev server, concurrently
npm run dashboard:dev            # dashboard at http://localhost:5173, API proxied to :4000

# Production: build backend + client, then serve the built SPA from Express
npm run dashboard:build
npm run dashboard:start          # http://localhost:4000

# Or run it as a managed PM2 process (its own process, separate from workers)
pm2 start ecosystem.config.cjs   # name: ai-arena-dashboard
```

### What you can do in the UI

- **Live** — a grid of model cards with real-time PM2 status (online/stopped/errored), CPU, memory, uptime, restarts, and the running scenario/run. Updated over WebSocket (no polling).
- **Run detail** — the full conversation transcript (chat-style, auto-scrolling as turns stream in live), with expandable tool-call input/output, plus tabs for the **sandbox files** (CodeMirror viewer) and the **PM2 logs**. Stop/Restart controls.
- **Scenarios** — list, create, edit, delete. The create form has fields for name, system prompt, task, success criteria, max turns, and an **inline CodeMirror editor per starter file** — so you can create a scenario from the UI instead of hand-editing YAML. (Files are written to `configs/scenarios/templates/<name>/` and the YAML is written for you.)
- **Models** — add/edit/delete model configs. Only the **env-var name** holding a key is ever shown or stored; raw key values never appear anywhere in the UI or API.
- **Comparisons** — per-run, per-model table (turns, success/fail, tools, duration, stop reason) reusing the run index.
- **Run launcher** — multi-select models + scenario dropdown → launches a run (calls `POST /api/runs`, which reuses the orchestrator to spawn PM2 workers) and jumps to the new run's detail view.

### REST API (auth via `Authorization: Bearer <jwt>`)

`POST /api/auth/login` · `GET|POST|DELETE /api/models` · `GET|POST|PUT|DELETE /api/scenarios` · `POST /api/runs` · `GET /api/runs` · `GET /api/runs/:runId` · `GET /api/runs/:runId/models/:model/{conversation,report,files,files/*,logs}` · `POST /api/runs/:runId/{stop,restart}`

### WebSocket (`/ws?token=<jwt>`)

Server broadcasts `process_status` (every 2s), and per-subscribed-run `conversation_update` / `log_line` / `run_completed` events. Clients subscribe with `{type:"subscribe",runId}`. Workers stay stateless — the server reads/writes all state through `outputs/` and the run index, polling conversation/log files for new content.

### Creating a scenario from the UI (instead of YAML)

1. Open **Scenarios → New scenario**.
2. Fill name, system prompt, task, success criteria (e.g. `npm test`, exit 0), max turns.
3. Add starter files inline (path + CodeMirror content). They are seeded into every model's sandbox.
4. Save → the YAML is written to `configs/scenarios/<name>.yaml` and starter files to `configs/scenarios/templates/<name>/`.

## License

MIT

---

## Extended Features

### Cost Tracking & Budget Management

**Configuring Pricing** (`configs/pricing.yaml`):

```yaml
models:
  gpt-4o:
    input: 0.0025      # $/1K input tokens
    output: 0.01       # $/1K output tokens
    cached: 0.00125    # $/1K cached tokens (if applicable)
```

**Setting Budgets** (`configs/budget.yaml`):

```yaml
global:
  daily: 50       # Global daily limit in USD
  monthly: 500    # Global monthly limit

models:
  gpt-4o:
    daily: 20
    monthly: 150

thresholds:
  warn: 80        # Alert at 80% of limit
  block: 100      # Block new runs at 100%
```

**Budget enforcement**: Runs are blocked when limits are exceeded (use `--force-budget` to override).

---

### Git Integration

Each sandbox workspace is automatically initialized as a git repo:
- Initial commit captures starter files
- Per-turn commits track file modifications
- `diff.patch` generated at run completion showing all changes

**CLI**: View diff for any run:
```bash
ai-arena diff <runId> -m <model>
```

---

### LLM-as-Judge Evaluation

Configure a judge model in `configs/evaluation.yaml`:

```yaml
judge:
  model: gpt-4o
  enabled: true

rubric:
  correctness:
    description: "Code correctness"
    maxScore: 10
  fidelity:
    description: "Instruction fidelity"
    maxScore: 10
```

Judge scores are saved to `<run>/judge_score.json`.

---

### Regression Testing

Run regression suites against stored baselines:

```bash
ai-arena regress --suite <name>
```

Baselines are stored in `outputs/baselines/<model>/<scenario>.json`.

---

### Scheduling Runs

**Create a scheduled job** (`configs/schedules.yaml`):

```yaml
schedules:
  - id: nightly-regression
    scenario: express-rest
    models: [gpt-4o, claude-3.7]
    cron: "0 3 * * *"    # 3:00 AM daily
    enabled: true
    notifications:
      - slack-runs
```

**CLI commands**:
```bash
ai-arena schedule list
ai-arena schedule create -s <scenario> -m <models> -c "<cron>"
ai-arena schedule remove --id <id>
```

---

### Notifications

Configure webhooks in `configs/notifications.yaml`:

```yaml
channels:
  slack-runs:
    type: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
  discord-arena:
    type: discord
    webhookUrl: ${DISCORD_WEBHOOK_URL}

routing:
  onRunCompleted: [slack-runs]
  onBudgetThreshold: [slack-runs]
  onRegressionFailed: [slack-runs, discord-arena]
```

Set `SLACK_WEBHOOK_URL` and `DISCORD_WEBHOOK_URL` in your `.env`.

---

### Public API Authentication

Configure API keys in `configs/api-keys.yaml`:

```yaml
apiKeys:
  - key: ${ARENA_API_KEY_CI}
    name: CI Pipeline
    permissions:
      - runs:read
      - runs:write
      - models:read
    rateLimit: 100
```

Requests use `X-API-Key` header:
```bash
curl -H "X-API-Key: $ARENA_API_KEY_CI" http://localhost:4000/api/analytics/tools
```

Available permissions: `runs:read`, `runs:write`, `models:read`, `scenarios:read`, `analytics:read`, `export:read`.

---

### CSV Export

**CLI**:
```bash
ai-arena export --format csv --output runs.csv
ai-arena export -o runs.csv --model gpt-4o --from 2024-01-01
```

**API**:
- `GET /api/export/csv` — Export all runs
- `GET /api/runs/:runId/export/csv` — Export single run conversation

---

### Tool Analytics Dashboard

Navigate to **Analytics** in the dashboard to view:
- Tool call distribution (bar chart)
- Per-tool statistics (total, failed, average per run)
- Loop incident detection

Navigate to **Cost** for the cost leaderboard ranking models by cost per successful task.

---

### End-to-End Example

**1. Create a regression suite** (`configs/regression/default.yaml`):
```yaml
name: default
scenarios:
  - express-rest
baselineDir: outputs/baselines
```

**2. Schedule nightly runs** (`configs/schedules.yaml`):
```yaml
schedules:
  - id: nightly-regression
    scenario: express-rest
    models: [gpt-4o]
    cron: "0 3 * * *"
    notifications: [slack-runs]
```

**3. Configure Slack webhook** (`.env`):
```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
```

**4. Result**: Every night at 3 AM, runs execute and post results to Slack. Regressions trigger alerts.

---

## OpenTelemetry Observability

ai-model-arena instruments every agent run with OpenTelemetry spans using the
**GenAI semantic conventions**, so a full trace tree can be reconstructed and
viewed per run in any OTel-compatible backend.

### Spans

- `invoke_agent` (root, per run) — attributes: `gen_ai.system`, `gen_ai.request.model`, `ai_arena.run_id`, `ai_arena.scenario`, `ai_arena.model_config`.
- `chat` (per model API call) — attributes: `gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `duration`.
- `execute_tool` (per tool call) — attributes: `gen_ai.tool.name`, tool arguments (redacted/truncated), `duration_ms`, `tool.success`, `tool.error`.

Full prompt/completion content is captured into span attributes **only** when
`OTEL_CAPTURE_CONTENT=true` (off by default — may contain sensitive data and
increases payload size).

A lightweight local copy of each run's trace metadata is written to
`outputs/<model>/<runId>/trace-meta.json` (+ an `index.json` summary with
`trace_id`, `span_count`, `total_duration_ms`, `error_count`) so the dashboard
can link straight into Jaeger/Grafana and render an in-app waterfall without
querying the OTel backend.

### Start the local observability stack

```bash
docker compose -f docker-compose.observability.yml up -d
```

This brings up:
- **OTel Collector** on `:4318` (OTLP/HTTP) — receives traces from the arena.
- **Jaeger UI** on `http://localhost:16686` — browse traces per run.
- **Grafana** on `http://localhost:3000` — a pre-built *ai-model-arena Observability* dashboard (token volume, latency, error rate) with Jaeger as the auto-provisioned datasource.

Then point the arena at the collector in your `.env`:

```bash
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_TRACE_UI_BASE_URL=http://localhost:16686   # dashboard deep-links into Jaeger
```

To view a trace for a specific run: open the run in the dashboard and click the
**Trace** tab — it shows an in-app span waterfall and a deep-link into Jaeger
using the stored `trace_id`. You can also call `GET /api/v1/traces/:runId`.

## Anomaly Detection

A background analysis module runs after each completed run (and is also
triggerable over recent history) and flags anomalies using the collected
metrics + traces, with lightweight, explainable statistics (rolling mean +
standard deviation, z-score thresholds).

### Anomaly types

| Type | Trigger |
|------|---------|
| `latency` | A single tool/model call taking significantly longer than that model+tool's historical p95 (z-score ≥ threshold). |
| `loop` | Same tool+args combination repeated `consecutiveRepeats` (default 3) times consecutively. |
| `token_spike` | Total tokens in a run exceeding a configurable multiple of that model's historical average for the scenario. |
| `cost_spike` | Estimated cost exceeding a multiple of the historical average. |
| `error_rate` | Tool/API failure rate spiking above the model's historical baseline over the sliding window. |
| `silent_failure` | Success criteria passed but judge score unusually low (or failed but score unusually high) — a "criteria mismatch" for manual review. |

When an anomaly is detected, a record is written to SQLite
(`outputs/arena.db`, table `anomalies`: id, run_id, model, type, severity,
description, detected_at, resolved), a notification is dispatched via the
existing notifications module (`onAnomalyDetected` routing → Slack/Discord),
registered webhooks are fired, and the anomaly is surfaced on the dashboard
**Anomalies** page (filter by model/type/severity/resolved, mark
resolved/false-positive).

### Configure + tune thresholds

All thresholds live in `configs/anomaly-detection.yaml`:

```yaml
enabled: true
slidingWindow: 20          # recent runs feeding the rolling baselines
minSampleSize: 5           # require >= N historical samples before firing

latency:    { enabled: true, zScoreThreshold: 3, severity: high }
loop:       { enabled: true, consecutiveRepeats: 3, severity: medium }
tokenSpike: { enabled: true, multiple: 3, severity: high }
costSpike:  { enabled: true, multiple: 3, severity: high }
errorRate:  { enabled: true, zScoreThreshold: 3, severity: high }
silentFailure:
  enabled: true
  lowJudgeScore: 40
  highJudgeScore: 70
  severity: medium
```

Tuning: lower `zScoreThreshold`/`multiple` for more sensitivity (more alerts),
raise them to reduce noise; raise `minSampleSize` to avoid firing on sparse
history; widen `slidingWindow` to weight longer-term baselines.

## Webhooks

External systems can register a URL that receives signed POSTs on events
(`run_completed`, `anomaly_detected`, `budget_exceeded`), decoupling
notification logic from hardcoded Slack/Discord config:

```bash
curl -X POST http://localhost:4000/api/v1/webhooks \
  -H "X-API-Key: $ARENA_API_KEY_CI" -H "content-type: application/json" \
  -d '{"url":"https://example.com/hook","events":["anomaly_detected"]}'
```

Deliveries are HMAC-SHA256 signed with the registered secret in the
`x-arena-signature` header (`sha256=<hex>`).

## Public API

The full OpenAPI spec is at `openapi.yaml` and served interactively at
**`/api/docs`** (Swagger UI). All endpoints are versioned under `/api/v1/` and
protected by API-key auth (`X-API-Key`) + per-key rate limiting. New endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/traces/:runId` | Span metadata tree for a run (+ external trace URL). |
| GET | `/api/v1/anomalies` | List anomalies (model/type/severity/resolved/date filters). |
| GET | `/api/v1/anomalies/:id` | Full anomaly detail incl. related run + span data. |
| PATCH | `/api/v1/anomalies/:id` | Mark resolved / false positive. |
| GET | `/api/v1/observability/stats` | Avg/p95/p99 latency, error rates, rolling baselines. |
| GET | `/api/v1/observability/health` | Healthcheck (OTel exporter, SQLite, PM2). |
| POST | `/api/v1/webhooks` | Register a webhook subscription. |
| GET | `/api/v1/webhooks` | List webhooks. |
| DELETE | `/api/v1/webhooks/:id` | Remove a webhook. |

Existing endpoints (models, scenarios, runs, cost, tool analytics, export) are
all mirrored under `/api/v1/` as well. Permissions include `traces:read`,
`anomalies:read`, `anomalies:write`, `observability:read`, `webhooks:write`
(configured in `configs/api-keys.yaml`).

## End-to-End Example

```bash
# 1. Start the observability stack
docker compose -f docker-compose.observability.yml up -d

# 2. Configure the arena (.env)
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_TRACE_UI_BASE_URL=http://localhost:16686

# 3. Run a scenario
ai-arena run --scenario express-rest --models gpt-4o
```

Each model worker now emits a full trace tree. Open the run in the dashboard →
**Trace** tab, or browse it in Jaeger at
`http://localhost:16686/trace/<trace_id>` (the dashboard prints the link).

### Simulate an anomaly

To demonstrate the anomaly-detection + notification flow, throttle a mock model
so a single `chat` call takes far longer than its baseline (e.g. point a model
config at a slow/local endpoint that sleeps). After a few normal runs establish a
baseline, the throttled run will:

1. Produce a `latency` span well above mean + 3·std.
2. Trigger an anomaly record in `outputs/arena.db`.
3. Dispatch a Slack/Discord notification (`onAnomalyDetected`) + any registered
   webhooks.
4. Surface on the dashboard **Anomalies** page, where it can be marked
   resolved / false positive.

Verify programmatically:

```bash
curl -H "X-API-Key: $ARENA_API_KEY_CI" http://localhost:4000/api/v1/anomalies?resolved=false
curl http://localhost:4000/api/v1/observability/health   # OTel / SQLite / PM2 health
```





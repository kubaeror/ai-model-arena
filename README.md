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


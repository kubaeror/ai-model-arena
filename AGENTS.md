# AI Model Arena - Agent Instructions

## Project Overview
Multi-model agentic coding arena. TypeScript/Node.js monorepo with React dashboard.
Spawns isolated PM2 worker processes per model, each running an agentic coding loop with sandboxed tools.

## Tech Stack
- **Runtime**: Node.js >= 20.11, TypeScript (ESM, strict)
- **Backend**: Express.js REST API + WebSocket (port 4000)
- **Frontend**: React 18 + Vite + TanStack Query + Tailwind CSS + CodeMirror
- **Process**: Queue-based (Redis Streams or in-memory) + long-lived runner
- **Config**: YAML + Zod validation
- **Logging**: Pino (structured JSON)

## Key Architecture
- `src/cli.ts` — CLI entry (commander)
- `src/worker.ts` — PM2 worker (one per model per run)
- `src/orchestrator/` — Run management, lifecycle, PM2 helpers
- `src/adapters/` — LLM provider adapters (OpenAI, Anthropic, Ollama)
- `src/agent-loop/` — Core send→tool→loop logic
- `src/tools/` — Tool schemas + executors (file ops, shell, search)
- `src/sandbox/` — Sandboxed workspace with escape prevention
- `src/dashboard-server/` — Express API + WebSocket + JWT auth
- `src/dashboard-client/` — React SPA (separate Vite app)
- `configs/` — YAML model definitions + scenario configs

## Development Commands
- `npm run dev` — Start dashboard server
- `npm run build` — Compile TypeScript
- `npm run lint` — ESLint check
- `npm run typecheck` — TypeScript type check
- `npx tsx src/cli.ts` — Run CLI directly

## Code Conventions
- ESM imports only (`import`/`export`)
- Zod schemas for runtime validation
- All config via environment variables (never hardcode API keys)
- Workers always `exit(0)` — real failures in `result.json`
- Sandboxed filesystem paths cannot escape sandbox root
- Pino structured logging, not console.log

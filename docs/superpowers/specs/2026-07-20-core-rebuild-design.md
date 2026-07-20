# Core Rebuild + Models Database Design

**Date:** 2026-07-20
**Status:** Approved (brainstorming output)
**Supersedes:** prior `src/adapters/` switch-based provider layer, `configs/models.yaml`, `configs/pricing.yaml`

## Goal

Rebuild ai-model-arena's model/provider/metrics layer from scratch. Replace the 3-model hardcoded YAML + switch-based adapters with a plugin-style provider registry, a SQLite-backed models database auto-populated from `models.dev/api.json`, benchmark data merged from `modelbench.lol` and `api.zeroeval.com`, and arena runtime metrics (latency, TPS, cache hit rate) written back into the same DB. Expose all catalog + metrics data via OpenAPI endpoints.

Two independent subsystems; this spec covers subsystem 1 (core + models DB + metrics). Subsystem 2 (dashboard rework + graphs) gets a separate spec after this ships.

## Non-goals

- Dashboard frontend changes (subsystem 2).
- New scenarios or success-criteria logic.
- Rewriting sandbox, OTel tracing, anomaly detection, regression baselines, or auth (kept as-is).
- New CLI commands beyond what catalog sync requires.

## Architecture

**Approach A — Layered plugin registry.** `src/providers/` becomes a registry of provider descriptors (`id`, `env_var`, `auth_scheme`, `adapter` class). `createAdapter(providerId, modelId)` resolves the descriptor and instantiates the adapter. Four adapter classes cover the ~20 built-in providers from models.dev plus custom OpenAI-compatible providers:

- `OpenAICompatAdapter` — covers OpenAI, Ollama, OpenRouter, Groq, Cerebras, NVIDIA, Mistral, Scaleway, SambaNova, Cloudflare Workers AI, GitHub Copilot, xAI, and any user-defined OpenAI-compatible endpoint.
- `AnthropicAdapter` — native Messages API, extended thinking (`thinking.budget_tokens`), `cache_control` breakpoints.
- `GoogleAdapter` — native Gemini API.
- `BedrockAdapter` — Amazon Bedrock routing.

Built-in providers are loaded from `src/providers/descriptors/*.ts` at boot. Custom providers are loaded from the `providers` SQLite table (added via dashboard form or seeded from `configs/providers.yaml`). The existing PM2 worker, sandbox, agent-loop, OTel tracing, anomaly detection, and regression suite are preserved.

Catalog + benchmarks are fetched lazily on first server boot and refreshed on a 30-day cron. Arena run finalization writes per-model runtime metrics back into the `model_runtime_stats` table, so the dashboard can show catalog benchmarks and arena measurements side-by-side.

## File layout

```
src/
  providers/                                 # NEW — plugin registry
    index.ts                                 # built-in descriptor registry
    registry.ts                               # ProviderRegistry: list/get/createAdapter
    descriptors/                              # built-in provider metadata
      openai.ts, anthropic.ts, google.ts, bedrock.ts, openrouter.ts,
      groq.ts, cerebras.ts, nvidia.ts, mistral.ts, sambanova.ts,
      scaleway.ts, cloudflare.ts, github-copilot.ts, xai.ts, ollama.ts, ...
    adapters/
      base.ts                                 # ModelAdapter: sendMessage + sendMessageStream
      openai-compat.ts                        # covers ~15 OpenAI-compatible providers
      anthropic.ts                            # native messages API + extended thinking
      google.ts                               # native Gemini
      bedrock.ts
    custom.ts                                 # loads custom providers from DB
  catalog/
    sync.ts                                   # fetch models.dev → models table
    benchmarks.ts                             # fetch modelbench + zeroeval → benchmarks table
    cache.ts                                  # 30d TTL + lazy refresh on boot
    cron.ts                                   # node-cron schedule
  db/
    schema.ts, migrations.ts, client.ts       # SQLite (better-sqlite3)
  metrics/
    runtime.ts                                # latency p50/p95, TPS aggregation from trace-meta
    cache-metrics.ts                          # prompt cache token tracking
    writeback.ts                              # arena run finalize → model_runtime_stats
  (delete: src/adapters/, configs/models.yaml, configs/pricing.yaml)
  (keep: src/agent-loop/, src/sandbox/, src/orchestrator/, src/observability/,
         src/anomaly-detection/, src/evaluation/, src/tools/, src/worker.ts,
         src/dashboard-server/auth.ts, src/dashboard-server/auth-api.ts,
         src/dashboard-server/live.ts, src/dashboard-server/openapi.ts)
dashboard-server/routes/
  catalog.ts (NEW)                            # /api/models, /api/models/:id, /api/providers,
                                              # /api/benchmarks, /api/benchmarks/:model, /api/pricing
  metrics.ts (NEW)                            # /api/metrics/runtime, /api/metrics/tps, /api/cache/stats
  cache.ts (NEW)                              # /api/cache/refresh, /api/cache/leaderboard
openapi.yaml                                  # extended with all new endpoints
```

## Data model (SQLite, additive migrations on `outputs/arena.db`)

```sql
CREATE TABLE providers (
  id            TEXT PRIMARY KEY,            -- 'openai','anthropic','custom-foo'
  name          TEXT NOT NULL,
  api_base      TEXT,                         -- default base URL
  auth_scheme   TEXT NOT NULL,                -- 'bearer'|'x-api-key'|'google'|'bedrock'|'none'
  env_var       TEXT,                         -- 'OPENAI_API_KEY'
  is_builtin    INTEGER NOT NULL DEFAULT 0,
  adapter       TEXT NOT NULL,                -- 'openai-compat'|'anthropic'|'google'|'bedrock'
  header_name   TEXT,                         -- custom header for openai-compat
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE models (
  id              TEXT PRIMARY KEY,           -- canonical 'anthropic/claude-3.7-sonnet'
  name            TEXT NOT NULL,
  family          TEXT,
  provider_id     TEXT NOT NULL REFERENCES providers(id),
  release_date    TEXT,
  attachment      INTEGER NOT NULL DEFAULT 0,
  reasoning       INTEGER NOT NULL DEFAULT 0,
  temperature     INTEGER NOT NULL DEFAULT 0,
  tool_call       INTEGER NOT NULL DEFAULT 0,
  interleaved     TEXT,                        -- 'reasoning'|'reasoning_content'|null
  status          TEXT,                        -- 'alpha'|'beta'|'deprecated'|null
  context_limit   INTEGER,
  input_limit     INTEGER,
  output_limit    INTEGER,
  modalities      TEXT,                        -- JSON
  reasoning_options TEXT,                      -- JSON: [{type:'effort'|...}]
  source_json     TEXT,                         -- full models.dev payload
  last_synced_at  TEXT NOT NULL,
  UNIQUE(provider_id, name)
);

CREATE TABLE model_providers (
  model_id    TEXT NOT NULL REFERENCES models(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  api_model_id TEXT NOT NULL,                  -- provider-specific id e.g. 'gpt-4o'
  PRIMARY KEY (model_id, provider_id)
);

CREATE TABLE pricing (
  model_id        TEXT NOT NULL REFERENCES models(id),
  input           REAL,                        -- USD per 1M tokens
  output          REAL,
  cache_read      REAL,
  cache_write     REAL,
  tier_size       INTEGER,                     -- context tier size, nullable
  over_200k_input REAL, over_200k_output REAL,
  over_200k_cache_read REAL, over_200k_cache_write REAL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (model_id, tier_size)
);

CREATE TABLE benchmarks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id      TEXT NOT NULL REFERENCES models(id),
  benchmark     TEXT NOT NULL,                 -- 'SWE-bench','GPQA Diamond','Intelligence Index'
  source        TEXT NOT NULL,                 -- 'modelbench'|'zeroeval'
  score         REAL NOT NULL,
  measured_at   TEXT NOT NULL,
  source_url    TEXT,
  is_preferred  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_id, benchmark, source)
);

CREATE TABLE model_runtime_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id      TEXT NOT NULL REFERENCES models(id),
  run_id        TEXT NOT NULL,
  latency_p50_ms INTEGER, latency_p95_ms INTEGER,
  tps           REAL,
  ttft_ms       INTEGER,                       -- time to first token (streaming)
  cache_hit_rate REAL,                         -- 0..1
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  cost_usd      REAL,
  success       INTEGER NOT NULL,
  measured_at   TEXT NOT NULL,
  UNIQUE(model_id, run_id)
);

CREATE TABLE catalog_cache_state (
  source      TEXT PRIMARY KEY,               -- 'models.dev'|'modelbench'|'zeroeval'
  last_fetch  TEXT NOT NULL,
  last_status TEXT,                            -- 'ok'|'error'|'partial'
  last_error  TEXT,
  count        INTEGER,
  next_refresh TEXT NOT NULL
);
```

Indexes: `idx_models_provider ON models(provider_id)`, `idx_models_reasoning ON models(reasoning)`, `idx_benchmarks_model ON benchmarks(model_id, benchmark)`, `idx_runtime_model_date ON model_runtime_stats(model_id, measured_at)`.

Existing `anomalies` and `webhooks` tables are untouched.

## Components + data flow

### Boot sequence

```
server.ts on boot
  → run pending migrations (additive)
  → catalog_cache_state('models.dev') stale or missing?
       yes → fetchSync('models.dev')   (blocking, first-run only)
       no  → skip; cron refreshes in background
  → catalog_cache_state('modelbench') stale?  yes → fetchBenchmarks('modelbench')
  → catalog_cache_state('zeroeval') stale?    yes → fetchBenchmarks('zeroeval')
  → ProviderRegistry.loadBuiltins()          # static descriptors
  → ProviderRegistry.loadCustomFromDb()      # custom rows → descriptors
  → start cron (30d refresh for all three sources)
  → start Express server
```

First API request after boot triggers no extra work — catalog already in DB. Cache layer returns DB rows instantly; background cron keeps them fresh.

### Catalog sync (`src/catalog/sync.ts`)

```
fetchSync('models.dev'):
  resp = GET https://models.dev/api.json          # Record<providerId, Provider>
  for each providerId, provider in resp:
    upsert providers row (is_builtin=1, adapter inferred from id)
    for each modelId, model in provider.models:
      canonicalId = normalizeModelId(modelId, providerId)   # dedup key
      upsert models row (capabilities, limits, reasoning_options)
      upsert model_providers (canonicalId, providerId, modelId)
      upsert pricing row (input/output/cache_read/cache_write/tiers)
  mark catalog_cache_state('models.dev', ok, count, next=now+30d)
  on error → mark status='error', last_error, retry on next cron tick
```

### Benchmark sync (`src/catalog/benchmarks.ts`)

```
fetchBenchmarks('modelbench'):
  page through GET https://modelbench.lol/api/v1/models?limit=50
    &fields=slug,name,intelligence_score,coding_score,agentic_score,speed_tps,benchmark_data,source
  for each row:
    canonicalId = matchModelToCanonical(row.slug, row.name)
    for each benchmark in row.benchmark_data:
      upsert benchmarks (canonicalId, benchmark.name, 'modelbench', score, source_url)
    is_preferred = 1 for 'Intelligence Index','Coding Score','Agentic Score','Speed TPS'
  mark cache_state ok

fetchBenchmarks('zeroeval'):
  GET https://api.zeroeval.com/leaderboard/models/full
  for each row:
    canonicalId = matchModelToCanonical(row.model_name)
    for each benchmark key in row (swebench, gpqa, mmlu, ...):
      upsert benchmarks (canonicalId, normalizeBenchName(key), 'zeroeval', score)
  is_preferred = 0 by default for zeroeval (modelbench preferred for overlap)
  mark cache_state ok
```

**Dedup:** `UNIQUE(model_id, benchmark, source)` constraint. Same benchmark from two sources = two rows. `is_preferred` flag picks the winner for rankings. Default: modelbench preferred, zeroeval fills gaps for benchmarks modelbench doesn't cover.

`matchModelToCanonical()` fuzzy-matches by name + family; unmatched rows are logged to `catalog_cache_state.last_error` for manual review (not silently dropped).

### Provider registry (`src/providers/registry.ts`)

```ts
class ProviderRegistry {
  private descriptors = new Map<string, ProviderDescriptor>()

  register(d: ProviderDescriptor) { this.descriptors.set(d.id, d) }
  list() { return [...descriptors.values()] }
  get(id) { return descriptors.get(id) }
  createAdapter(providerId, modelId, opts): ModelAdapter {
    const d = this.descriptors.get(providerId)
    const AdapterClass = adapterClasses[d.adapter]
    return new AdapterClass(d, modelId, opts)
  }
  loadBuiltins() { builtins.forEach(d => this.register(d)) }
  async loadCustomFromDb(db) {
    const rows = db.query('SELECT * FROM providers WHERE is_builtin=0')
    rows.forEach(r => this.register(descriptorFromRow(r)))
  }
}
```

### Adapter interface (`src/providers/adapters/base.ts`)

```ts
interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse>
  sendMessageStream?(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk>
  supportsStreaming(): boolean
  supportsReasoning(): boolean
  supportsPromptCaching(): boolean
  buildCacheBreakpoints?(messages: ChatMessage[]): ChatMessage[]
}

interface StreamChunk {
  text?: string
  toolCallDelta?: ToolCallDelta
  usage?: TokenUsage
  cacheReadTokens?: number
  cacheWriteTokens?: number
  finishReason?: string
}

interface SendOpts {
  reasoning?: { type: 'effort' | 'toggle' | 'budget_tokens'; value?: string | number }
  temperature?: number
  maxTokens?: number
}
```

### Runtime metrics writeback (`src/metrics/writeback.ts`)

```
writeRunStats(runId):
  trace = readTraceMeta(runId)                # existing observability output
  result = readResultJson(runId)
  for each model in run:
    stats = {
      latency_p50, latency_p95: from trace span durations grouped by model
      tps: completion_tokens / (last_span_end - first_span_start) * 1000
      ttft_ms: first_token_time - chat_call_start (streaming only; null otherwise)
      cache_hit_rate: cache_read_tokens / total_input_tokens
      cache_read_tokens, cache_write_tokens: from result.tokenUsage
      cost_usd: from result.costUsd
      success: result.success
    }
    upsert model_runtime_stats (model_id, run_id, stats)
```

Triggered from `run-lifecycle.ts` `finalizeRunByRunId` (existing finalization hook), after `result.json` aggregation.

### Dashboard API (new routes, all added to `openapi.yaml`)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/api/models` | Catalog list (filters: provider, reasoning, tool_call, min_context, sort) | JWT or API key |
| GET | `/api/models/:id` | Full model: caps, pricing, benchmarks, runtime stats | JWT or API key |
| GET | `/api/providers` | All providers (builtin + custom) | JWT or API key |
| POST | `/api/providers` | Add custom OpenAI-compatible provider | JWT only |
| DELETE | `/api/providers/:id` | Remove custom (builtin not deletable) | JWT only |
| GET | `/api/benchmarks` | All benchmarks (filter by name, source, model) | JWT or API key |
| GET | `/api/benchmarks/:modelId` | Benchmarks for one model | JWT or API key |
| GET | `/api/pricing` | Pricing table (filter by model) | JWT or API key |
| GET | `/api/metrics/runtime` | Arena-measured stats (filter by model, date range) | JWT or API key |
| GET | `/api/metrics/tps` | TPS leaderboard (catalog + arena combined) | JWT or API key |
| GET | `/api/cache/stats` | Cache state per source (last_fetch, next_refresh, count, status) | JWT or API key |
| GET | `/api/cache/leaderboard` | Combined: catalog benchmarks + arena measurements side-by-side | JWT or API key |
| POST | `/api/cache/refresh` | Force refresh a source (`{source: 'models.dev'|'modelbench'|'zeroeval'}`) | JWT only |

All under `/api/v1/*` mirror with API-key auth (existing pattern). OpenAPI spec regenerated via `openapi.yaml` extension.

## Token caching + caching metrics

- **Provider prompt caching** only (not arena-level response memoization).
- Anthropic adapter: inserts `cache_control: {type: 'ephemeral'}` breakpoints at the last 1–4 message boundaries (configurable). Reads `cache_read_input_tokens` / `cache_creation_input_tokens` from response usage.
- OpenAI adapter: OpenAI returns `prompt_tokens_details.cached_tokens` automatically; adapter surfaces it.
- Google adapter: implicit context caching; adapter parses `cached_content_token_count`.
- Token tracking extended in `TokenUsage` type (`src/types.ts`): `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate` (computed).
- Per-run cache stats aggregated in `model_runtime_stats.cache_hit_rate` and `cache_read_tokens`/`cache_write_tokens` columns.

## TPS measurement (hybrid streaming with fallback)

- `ModelAdapter.sendMessageStream()` returns `AsyncIterable<StreamChunk>`.
- Streaming path: `tps = completion_tokens / (last_chunk_time - first_chunk_time) * 1000`, `ttft_ms = first_chunk_time - call_start`.
- Non-streaming fallback: `tps = completion_tokens / call_wall_clock_ms * 1000`, `ttft_ms = null`.
- Agent-loop calls `sendMessageStream` when `adapter.supportsStreaming() && model.tool_call` (streaming tools supported); else `sendMessage`.
- Stream errors mid-flight → agent-loop catches, falls back to non-streaming retry of same call.

## Error handling

- Catalog sync failure → `catalog_cache_state.last_status='error'`, `last_error` set, server still boots with stale data. Cron retries next tick. Dashboard `/api/cache/stats` surfaces failures.
- Partial benchmark match (row with no canonical model) → logged to `catalog_cache_state.last_error`, row skipped, sync continues.
- Provider adapter runtime failure → existing `BaseAdapter.withRetry` (429/5xx/network), `result.json` captures `stopReason:'fatal_error'`, worker still `exit(0)`.
- DB migration failure → server refuses to boot, logs migration error.
- Streaming fallback: if `sendMessageStream` errors mid-flight, agent-loop catches and retries via `sendMessage`.

## Testing

- **Unit**: `sync.ts` (mock fetch → assert upserts), `matchModelToCanonical` (fuzzy matching cases), `ProviderRegistry.createAdapter`, `writeback.ts` (trace fixture → stats row).
- **Integration**: in-memory SQLite, full sync from fixture JSON, assert all tables populated + dedup constraints hold.
- **Adapter contract tests**: each adapter against a mock HTTP server (mock server asserting payload shape + cache breakpoint placement + streaming chunk parse).
- **E2E**: spin one model on the express-rest scenario, assert `model_runtime_stats` row written.

## Migration path

1. Build new `src/providers/`, `src/catalog/`, `src/db/`, `src/metrics/` alongside existing code.
2. Migrate `outputs/arena.db` schema (additive migrations).
3. Worker + orchestrator switch from `createAdapter(modelCfg)` to `ProviderRegistry.createAdapter(providerId, modelId)`.
4. Delete `src/adapters/`, `configs/models.yaml`, `configs/pricing.yaml`.
5. Existing 3 models (gpt-4o, claude-3.7, ollama-llama3) re-emerge from models.dev sync automatically.

## Out of scope (subsystem 2)

- Dashboard frontend pages/components for catalog browsing.
- New graphs/charts on dashboard.
- Website rework / redesign.
- `free-coding-models`-style latency ping system (different scope from arena benchmarking).

## References

- models.dev schema: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/models-dev.ts`
- models.dev data: `https://models.dev/api.json`
- modelbench API docs: `https://modelbench.lol/api/docs`
- zeroeval leaderboard: `https://api.zeroeval.com/leaderboard/models/full`
- free-coding-models reference repo: `https://github.com/vava-nessa/free-coding-models`

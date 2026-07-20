# Core Rebuild + Models Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild ai-model-arena's model/provider/metrics layer into a plugin-style provider registry backed by a SQLite models database auto-populated from models.dev, modelbench, and zeroeval, with arena runtime metrics written back and exposed via OpenAPI.

**Architecture:** Layered plugin registry (`src/providers/`) with four adapter classes (OpenAI-compat, Anthropic, Google, Bedrock) covers ~20 built-in providers + custom OpenAI-compatible endpoints. Catalog sync fetches `models.dev/api.json` and two benchmark sources into SQLite on a 30-day refresh. Arena run finalization writes per-model latency/TPS/cache metrics back into the same DB. New Express routes expose catalog, benchmarks, pricing, runtime metrics, and cache state — all added to `openapi.yaml`.

**Tech Stack:** Node.js >= 20.11, TypeScript (ESM, strict), better-sqlite3 (already in deps), Express 4, Zod, Pino, node:test (built-in, no new test dep), tsx for running tests.

## Global Constraints

- ESM imports only; file extensions required in relative imports (`.js`).
- TypeScript strict mode, `npm run typecheck` must pass.
- ESLint must pass (`npm run lint`).
- All config via environment variables, never hardcode API keys.
- Workers always `exit(0)` — real failures in `result.json`.
- Pino structured logging, not `console.log`.
- Zod schemas for runtime validation of all external data.
- 30-day cache TTL for catalog sources; first server boot blocks on initial sync if stale.
- Existing `outputs/arena.db` SQLite DB extended via additive migrations only.
- `better-sqlite3` synchronous API; wrap in single shared client.
- Test framework: Node built-in `node:test` + `node:assert/strict`, run via `tsx`.

---

## File Structure

```
src/
  db/
    client.ts                    # shared better-sqlite3 client, singleton
    schema.ts                    # Row type interfaces
    migrations.ts                # additive migration runner
  providers/
    types.ts                     # ProviderDescriptor
    registry.ts                 # ProviderRegistry class
    index.ts                    # built-in descriptor list + loadBuiltins
    descriptors/
      openai.ts, anthropic.ts, google.ts, bedrock.ts, openrouter.ts,
      groq.ts, cerebras.ts, nvidia.ts, mistral.ts, sambanova.ts,
      scaleway.ts, cloudflare.ts, github-copilot.ts, xai.ts, ollama.ts
    custom.ts                    # load custom providers from DB
    adapters/
      base.ts                    # ModelAdapter abstract + HttpError + retry
      openai-compat.ts
      anthropic.ts
      google.ts
      bedrock.ts
  catalog/
    types.ts                    # models.dev / modelbench / zeroeval Zod schemas
    sync.ts                     # fetchSync('models.dev')
    benchmarks.ts               # fetchBenchmarks('modelbench'|'zeroeval')
    match.ts                    # matchModelToCanonical fuzzy matcher
    cache.ts                    # cache state read + lazy refresh trigger
    cron.ts                     # 30d interval refresh
  metrics/
    runtime.ts                  # aggregate trace-meta to latency p50/p95, TPS
    cache-metrics.ts            # extract cache tokens from TokenUsage
    writeback.ts                # writeRunStats(runId) -> model_runtime_stats
  dashboard-server/routes/
    catalog.ts                  # /api/models, /api/models/:id, /api/providers, /api/benchmarks, /api/pricing
    metrics.ts                 # /api/metrics/runtime, /api/metrics/tps
    cache.ts                    # /api/cache/stats, /api/cache/refresh, /api/cache/leaderboard
tests/
  db/migrations.test.ts
  providers/registry.test.ts
  providers/adapters/openai-compat.test.ts
  providers/adapters/anthropic.test.ts
  catalog/sync.test.ts
  catalog/benchmarks.test.ts
  catalog/match.test.ts
  metrics/writeback.test.ts
  dashboard/routes/catalog.test.ts
  dashboard/routes/metrics.test.ts
  dashboard/routes/cache.test.ts
```

Files modified: `src/types.ts`, `src/dashboard-server/server.ts`, `src/worker.ts`, `src/orchestrator/run-lifecycle.ts`, `openapi.yaml`, `package.json`.
Files deleted in final task: `src/adapters/`, `configs/models.yaml`, `configs/pricing.yaml`.

---

## Task 1: Test framework + SQLite client with catalog migrations

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/schema.ts`
- Create: `tests/db/migrations.test.ts`
- Modify: `package.json` (add test scripts)

**Interfaces:**
- Produces: `initDb(dbPath: string): Database`, `getDb(): Database`, `closeDb(): void`. Row interfaces `ProviderRow`, `ModelRow`, `ModelProviderRow`, `PricingRow`, `BenchmarkRow`, `ModelRuntimeStatRow`, `CatalogCacheStateRow`.

- [ ] **Step 1: Add test scripts to package.json**

Modify `package.json` scripts block to add (after `"lint"`):

```json
"test": "tsx --test tests/**/*.test.ts",
"test:db": "tsx --test tests/db/**/*.test.ts"
```

- [ ] **Step 2: Write the failing test**

Create `tests/db/migrations.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';

test('initDb creates all catalog tables on fresh DB', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    const db = initDb(dbPath);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    for (const expected of ['providers', 'models', 'model_providers', 'pricing', 'benchmarks', 'model_runtime_stats', 'catalog_cache_state']) {
      assert.ok(names.includes(expected), `missing table: ${expected}`);
    }
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('initDb is idempotent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-db-'));
  const dbPath = path.join(tmp, 'test.db');
  try {
    initDb(dbPath);
    closeDb();
    const db = initDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM providers').get() as { c: number };
    assert.equal(count.c, 0);
    closeDb();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:db`
Expected: FAIL with "Cannot find module '../../src/db/client.js'".

- [ ] **Step 4: Create src/db/schema.ts with row types**

Create `src/db/schema.ts`:

```typescript
export interface ProviderRow {
  id: string;
  name: string;
  api_base: string | null;
  auth_scheme: 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';
  env_var: string | null;
  is_builtin: number;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
  header_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelRow {
  id: string;
  name: string;
  family: string | null;
  provider_id: string;
  release_date: string | null;
  attachment: number;
  reasoning: number;
  temperature: number;
  tool_call: number;
  interleaved: string | null;
  status: string | null;
  context_limit: number | null;
  input_limit: number | null;
  output_limit: number | null;
  modalities: string | null;
  reasoning_options: string | null;
  source_json: string;
  last_synced_at: string;
}

export interface ModelProviderRow {
  model_id: string;
  provider_id: string;
  api_model_id: string;
}

export interface PricingRow {
  model_id: string;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  tier_size: number | null;
  over_200k_input: number | null;
  over_200k_output: number | null;
  over_200k_cache_read: number | null;
  over_200k_cache_write: number | null;
  updated_at: string;
}

export interface BenchmarkRow {
  id: number;
  model_id: string;
  benchmark: string;
  source: string;
  score: number;
  measured_at: string;
  source_url: string | null;
  is_preferred: number;
}

export interface ModelRuntimeStatRow {
  id: number;
  model_id: string;
  run_id: string;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  tps: number | null;
  ttft_ms: number | null;
  cache_hit_rate: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  success: number;
  measured_at: string;
}

export interface CatalogCacheStateRow {
  source: string;
  last_fetch: string;
  last_status: string;
  last_error: string | null;
  count: number | null;
  next_refresh: string;
}
```

- [ ] **Step 5: Create src/db/client.ts**

Create `src/db/client.ts`:

```typescript
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

let dbInstance: DatabaseType | null = null;

const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_catalog_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, api_base TEXT,
        auth_scheme TEXT NOT NULL, env_var TEXT,
        is_builtin INTEGER NOT NULL DEFAULT 0, adapter TEXT NOT NULL, header_name TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, family TEXT,
        provider_id TEXT NOT NULL REFERENCES providers(id), release_date TEXT,
        attachment INTEGER NOT NULL DEFAULT 0, reasoning INTEGER NOT NULL DEFAULT 0,
        temperature INTEGER NOT NULL DEFAULT 0, tool_call INTEGER NOT NULL DEFAULT 0,
        interleaved TEXT, status TEXT, context_limit INTEGER, input_limit INTEGER, output_limit INTEGER,
        modalities TEXT, reasoning_options TEXT, source_json TEXT, last_synced_at TEXT NOT NULL,
        UNIQUE(provider_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
      CREATE INDEX IF NOT EXISTS idx_models_reasoning ON models(reasoning);
      CREATE TABLE IF NOT EXISTS model_providers (
        model_id TEXT NOT NULL REFERENCES models(id), provider_id TEXT NOT NULL REFERENCES providers(id),
        api_model_id TEXT NOT NULL, PRIMARY KEY (model_id, provider_id)
      );
      CREATE TABLE IF NOT EXISTS pricing (
        model_id TEXT NOT NULL REFERENCES models(id), input REAL, output REAL,
        cache_read REAL, cache_write REAL, tier_size INTEGER,
        over_200k_input REAL, over_200k_output REAL, over_200k_cache_read REAL, over_200k_cache_write REAL,
        updated_at TEXT NOT NULL, PRIMARY KEY (model_id, tier_size)
      );
      CREATE TABLE IF NOT EXISTS benchmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL REFERENCES models(id),
        benchmark TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, measured_at TEXT NOT NULL,
        source_url TEXT, is_preferred INTEGER NOT NULL DEFAULT 0,
        UNIQUE(model_id, benchmark, source)
      );
      CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON benchmarks(model_id, benchmark);
      CREATE TABLE IF NOT EXISTS model_runtime_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL REFERENCES models(id), run_id TEXT NOT NULL,
        latency_p50_ms INTEGER, latency_p95_ms INTEGER, tps REAL, ttft_ms INTEGER,
        cache_hit_rate REAL, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        cost_usd REAL, success INTEGER NOT NULL, measured_at TEXT NOT NULL,
        UNIQUE(model_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_model_date ON model_runtime_stats(model_id, measured_at);
      CREATE TABLE IF NOT EXISTS catalog_cache_state (
        source TEXT PRIMARY KEY, last_fetch TEXT NOT NULL, last_status TEXT, last_error TEXT,
        count INTEGER, next_refresh TEXT NOT NULL
      );
    `,
  },
];

export function initDb(dbPath: string): DatabaseType {
  if (dbInstance && dbInstance.name === dbPath) return dbInstance;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map(r => r.id));
  const insertMigration = db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (!applied.has(m.id)) {
        db.exec(m.sql);
        insertMigration.run(m.id, new Date().toISOString());
      }
    }
  });
  tx();
  dbInstance = db;
  return db;
}

export function getDb(): DatabaseType {
  if (!dbInstance) throw new Error('DB not initialized - call initDb() first');
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:db`
Expected: PASS (2 tests).

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json src/db/client.ts src/db/schema.ts tests/db/migrations.test.ts
git commit -m "feat(db): SQLite client with catalog tables + migrations"
```
---

## Task 2: Provider registry + built-in descriptors + adapter stubs

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/registry.ts`
- Create: `src/providers/descriptors/*.ts` (15 files)
- Create: `src/providers/index.ts`
- Create: `src/providers/adapters/base.ts` (interface + retry)
- Create: `src/providers/adapters/{openai-compat,anthropic,google,bedrock}.ts` (stubs)
- Create: `tests/providers/registry.test.ts`

**Interfaces:**
- Produces: `ProviderDescriptor`, `ProviderRegistry` with `register/list/get/createAdapter/loadBuiltins/loadCustomFromDb`, `ModelAdapter`/`BaseAdapter`/`HttpError` in `adapters/base.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/registry.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { loadBuiltins } from '../../src/providers/index.js';

test('ProviderRegistry lists built-in providers after loadBuiltins', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  const ids = reg.list().map(p => p.id);
  assert.ok(ids.includes('openai'));
  assert.ok(ids.includes('anthropic'));
  assert.ok(ids.includes('google'));
  assert.ok(ids.includes('openrouter'));
  assert.ok(ids.includes('groq'));
  assert.ok(ids.includes('ollama'));
  assert.ok(ids.length >= 10, `expected >= 10, got ${ids.length}`);
});

test('ProviderRegistry.get returns descriptor by id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  const oai = reg.get('openai');
  assert.ok(oai);
  assert.equal(oai!.adapter, 'openai-compat');
  assert.equal(oai!.authScheme, 'bearer');
  assert.equal(oai!.envVar, 'OPENAI_API_KEY');
});

test('ProviderRegistry.get returns undefined for unknown id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  assert.equal(reg.get('does-not-exist'), undefined);
});

test('ProviderRegistry.register overrides existing id', () => {
  const reg = new ProviderRegistry();
  loadBuiltins(reg);
  reg.register({ id: 'openai', name: 'Custom', adapter: 'openai-compat', authScheme: 'bearer', isBuiltin: false });
  assert.equal(reg.get('openai')!.name, 'Custom');
  assert.equal(reg.get('openai')!.isBuiltin, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/providers/registry.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Create src/providers/types.ts**

```typescript
export type AdapterKind = 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
export type AuthScheme = 'bearer' | 'x-api-key' | 'google' | 'bedrock' | 'none';

export interface ProviderDescriptor {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: AuthScheme;
  envVar?: string;
  headerName?: string;
  adapter: AdapterKind;
  isBuiltin: boolean;
}
```

- [ ] **Step 4: Create src/providers/adapters/base.ts (full interface + retry)**

```typescript
import type { ChatMessage, ToolDefinition, ModelResponse, Logger } from '../../types.js';

export interface SendOpts {
  reasoning?: { type: 'effort' | 'toggle' | 'budget_tokens'; value?: string | number };
  temperature?: number;
  maxTokens?: number;
}

export interface StreamChunk {
  text?: string;
  toolCallDelta?: { id?: string; name?: string; arguments?: string };
  usage?: { prompt?: number; completion?: number; total?: number };
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string;
}

export interface ModelAdapter {
  sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse>;
  sendMessageStream?(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk>;
  supportsStreaming(): boolean;
  supportsReasoning(): boolean;
  supportsPromptCaching(): boolean;
  buildCacheBreakpoints?(messages: ChatMessage[]): ChatMessage[];
}

export class HttpError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const RETRYABLE_MESSAGES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed/;

export abstract class BaseAdapter {
  protected logger?: Logger;
  constructor(logger?: Logger) { this.logger = logger; }

  protected isRetryable(err: unknown): boolean {
    if (err instanceof HttpError) return err.status === 429 || (err.status >= 500 && err.status < 600);
    if (err instanceof Error) return RETRYABLE_MESSAGES.test(err.message);
    return false;
  }

  protected async withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries: number; initialDelayMs: number; maxDelayMs: number },
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= opts.maxRetries) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === opts.maxRetries) throw err;
        const delay = Math.min(opts.initialDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
        await new Promise(r => setTimeout(r, delay + Math.random() * 250));
        attempt++;
      }
    }
    throw lastErr;
  }
}
```

- [ ] **Step 5: Create adapter stubs (one per file)**

Create `src/providers/adapters/openai-compat.ts`:

```typescript
import type { ModelAdapter } from './base.js';
export class OpenAICompatAdapter implements ModelAdapter {
  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
  async sendMessage(): Promise<never> { throw new Error('OpenAICompatAdapter not implemented'); }
}
```

Create `src/providers/adapters/anthropic.ts`:

```typescript
import type { ModelAdapter } from './base.js';
export class AnthropicAdapter implements ModelAdapter {
  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
  async sendMessage(): Promise<never> { throw new Error('AnthropicAdapter not implemented'); }
}
```

Create `src/providers/adapters/google.ts`:

```typescript
import type { ModelAdapter } from './base.js';
export class GoogleAdapter implements ModelAdapter {
  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
  async sendMessage(): Promise<never> { throw new Error('GoogleAdapter not implemented'); }
}
```

Create `src/providers/adapters/bedrock.ts`:

```typescript
import type { ModelAdapter } from './base.js';
export class BedrockAdapter implements ModelAdapter {
  supportsStreaming(): boolean { return false; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }
  async sendMessage(): Promise<never> { throw new Error('BedrockAdapter not implemented'); }
}
```

- [ ] **Step 6: Create src/providers/registry.ts**

```typescript
import type { ProviderDescriptor } from './types.js';
import type { ModelAdapter } from './adapters/base.js';
import { OpenAICompatAdapter } from './adapters/openai-compat.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { BedrockAdapter } from './adapters/bedrock.js';
import type { Database } from 'better-sqlite3';
import type { ProviderRow } from '../db/schema.js';

export interface CreateAdapterOpts {
  apiKey?: string;
  logger?: import('../../types.js').Logger;
  baseUrl?: string;
}

const ADAPTER_CLASSES = {
  'openai-compat': OpenAICompatAdapter,
  'anthropic': AnthropicAdapter,
  'google': GoogleAdapter,
  'bedrock': BedrockAdapter,
} as const;

export class ProviderRegistry {
  private descriptors = new Map<string, ProviderDescriptor>();

  register(d: ProviderDescriptor): void { this.descriptors.set(d.id, d); }
  list(): ProviderDescriptor[] { return [...this.descriptors.values()]; }
  get(id: string): ProviderDescriptor | undefined { return this.descriptors.get(id); }

  createAdapter(providerId: string, modelId: string, opts: CreateAdapterOpts): ModelAdapter {
    const d = this.descriptors.get(providerId);
    if (!d) throw new Error(`Unknown provider: ${providerId}`);
    const AdapterClass = ADAPTER_CLASSES[d.adapter];
    if (!AdapterClass) throw new Error(`Unknown adapter kind: ${d.adapter}`);
    return new AdapterClass(d, modelId, opts);
  }

  loadBuiltins(descriptors: ProviderDescriptor[]): void {
    for (const d of descriptors) this.register(d);
  }

  loadCustomFromDb(db: Database): void {
    const rows = db.prepare('SELECT * FROM providers WHERE is_builtin = 0').all() as ProviderRow[];
    for (const r of rows) {
      this.register({
        id: r.id, name: r.name, apiBase: r.api_base ?? undefined,
        authScheme: r.auth_scheme, envVar: r.env_var ?? undefined,
        headerName: r.header_name ?? undefined, adapter: r.adapter, isBuiltin: false,
      });
    }
  }
}
```

- [ ] **Step 7: Create descriptor files**

Create `src/providers/descriptors/openai.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const openai: ProviderDescriptor = {
  id: 'openai', name: 'OpenAI', apiBase: 'https://api.openai.com/v1',
  authScheme: 'bearer', envVar: 'OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/anthropic.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const anthropic: ProviderDescriptor = {
  id: 'anthropic', name: 'Anthropic', apiBase: 'https://api.anthropic.com',
  authScheme: 'x-api-key', envVar: 'ANTHROPIC_API_KEY', adapter: 'anthropic', isBuiltin: true,
};
```

Create `src/providers/descriptors/google.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const google: ProviderDescriptor = {
  id: 'google', name: 'Google AI Studio', apiBase: 'https://generativelanguage.googleapis.com',
  authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
};
```

Create `src/providers/descriptors/bedrock.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const bedrock: ProviderDescriptor = {
  id: 'amazon-bedrock', name: 'Amazon Bedrock', authScheme: 'bedrock',
  envVar: 'AWS_BEDROCK_REGION', adapter: 'bedrock', isBuiltin: true,
};
```

Create `src/providers/descriptors/openrouter.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const openrouter: ProviderDescriptor = {
  id: 'openrouter', name: 'OpenRouter', apiBase: 'https://openrouter.ai/api/v1',
  authScheme: 'bearer', envVar: 'OPENROUTER_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/groq.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const groq: ProviderDescriptor = {
  id: 'groq', name: 'Groq', apiBase: 'https://api.groq.com/openai/v1',
  authScheme: 'bearer', envVar: 'GROQ_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/cerebras.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const cerebras: ProviderDescriptor = {
  id: 'cerebras', name: 'Cerebras', apiBase: 'https://api.cerebras.ai/v1',
  authScheme: 'bearer', envVar: 'CEREBRAS_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/nvidia.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const nvidia: ProviderDescriptor = {
  id: 'nvidia', name: 'NVIDIA NIM', apiBase: 'https://integrate.api.nvidia.com/v1',
  authScheme: 'bearer', envVar: 'NVIDIA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/mistral.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const mistral: ProviderDescriptor = {
  id: 'mistral', name: 'Mistral La Plateforme', apiBase: 'https://api.mistral.ai/v1',
  authScheme: 'bearer', envVar: 'MISTRAL_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/sambanova.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const sambanova: ProviderDescriptor = {
  id: 'sambanova', name: 'SambaNova', apiBase: 'https://api.sambanova.ai/v1',
  authScheme: 'bearer', envVar: 'SAMBANOVA_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/scaleway.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const scaleway: ProviderDescriptor = {
  id: 'scaleway', name: 'Scaleway', apiBase: 'https://api.scaleway.ai/ai-apis/v1',
  authScheme: 'bearer', envVar: 'SCALEWAY_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/cloudflare.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const cloudflare: ProviderDescriptor = {
  id: 'cloudflare', name: 'Cloudflare Workers AI', apiBase: 'https://api.cloudflare.com/client/v4/accounts',
  authScheme: 'bearer', envVar: 'CLOUDFLARE_API_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/github-copilot.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const githubCopilot: ProviderDescriptor = {
  id: 'github-copilot', name: 'GitHub Copilot Models', apiBase: 'https://api.githubcopilot.com',
  authScheme: 'bearer', envVar: 'GITHUB_TOKEN', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/xai.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const xai: ProviderDescriptor = {
  id: 'xai', name: 'xAI', apiBase: 'https://api.x.ai/v1',
  authScheme: 'bearer', envVar: 'XAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};
```

Create `src/providers/descriptors/ollama.ts`:

```typescript
import type { ProviderDescriptor } from '../types.js';
export const ollama: ProviderDescriptor = {
  id: 'ollama', name: 'Ollama (local)', apiBase: 'http://localhost:11434/v1',
  authScheme: 'none', adapter: 'openai-compat', isBuiltin: true,
};
```

- [ ] **Step 8: Create src/providers/index.ts**

```typescript
import type { ProviderRegistry } from './registry.js';
import type { ProviderDescriptor } from './types.js';
import { openai } from './descriptors/openai.js';
import { anthropic } from './descriptors/anthropic.js';
import { google } from './descriptors/google.js';
import { bedrock } from './descriptors/bedrock.js';
import { openrouter } from './descriptors/openrouter.js';
import { groq } from './descriptors/groq.js';
import { cerebras } from './descriptors/cerebras.js';
import { nvidia } from './descriptors/nvidia.js';
import { mistral } from './descriptors/mistral.js';
import { sambanova } from './descriptors/sambanova.js';
import { scaleway } from './descriptors/scaleway.js';
import { cloudflare } from './descriptors/cloudflare.js';
import { githubCopilot } from './descriptors/github-copilot.js';
import { xai } from './descriptors/xai.js';
import { ollama } from './descriptors/ollama.js';

export const BUILTIN_PROVIDERS: ProviderDescriptor[] = [
  openai, anthropic, google, bedrock, openrouter, groq, cerebras, nvidia,
  mistral, sambanova, scaleway, cloudflare, githubCopilot, xai, ollama,
];

export function loadBuiltins(reg: ProviderRegistry): void {
  reg.loadBuiltins(BUILTIN_PROVIDERS);
}

export { ProviderRegistry } from './registry.js';
export type { ProviderDescriptor, AdapterKind, AuthScheme } from './types.js';
export type { CreateAdapterOpts } from './registry.js';
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx tsx --test tests/providers/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/providers/ tests/providers/
git commit -m "feat(providers): provider registry + 15 built-in descriptors + adapter stubs"
```
---

## Task 3: Extend TokenUsage + cache metrics helper

**Files:**
- Modify: `src/types.ts` (extend `TokenUsage`)
- Create: `src/metrics/cache-metrics.ts`
- Create: `tests/metrics/cache-metrics.test.ts`

**Interfaces:**
- Produces: extended `TokenUsage` with `cacheReadTokens?`, `cacheWriteTokens?`, `cacheHitRate?`. `extractCacheMetrics(usage: TokenUsage): { cacheReadTokens, cacheWriteTokens, cacheHitRate }`.

- [ ] **Step 1: Write the failing test**

Create `tests/metrics/cache-metrics.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheMetrics } from '../../src/metrics/cache-metrics.js';
import type { TokenUsage } from '../../src/types.js';

test('extractCacheMetrics returns zeros when usage has no cache fields', () => {
  const m = extractCacheMetrics({ prompt: 100, completion: 50, total: 150 });
  assert.equal(m.cacheReadTokens, 0);
  assert.equal(m.cacheWriteTokens, 0);
  assert.equal(m.cacheHitRate, 0);
});

test('extractCacheMetrics computes hit rate from prompt + cacheReadTokens', () => {
  const m = extractCacheMetrics({ prompt: 1000, completion: 50, total: 1050, cacheReadTokens: 800, cacheWriteTokens: 200 });
  assert.equal(m.cacheReadTokens, 800);
  assert.equal(m.cacheWriteTokens, 200);
  assert.equal(m.cacheHitRate, 0.8);
});

test('extractCacheMetrics handles zero prompt tokens without NaN', () => {
  const m = extractCacheMetrics({ prompt: 0, cacheReadTokens: 0 });
  assert.equal(m.cacheHitRate, 0);
  assert.ok(!Number.isNaN(m.cacheHitRate));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/metrics/cache-metrics.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Extend TokenUsage in src/types.ts**

Replace the `TokenUsage` interface (lines 28-32) with:

```typescript
export interface TokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
  /** Prompt cache read tokens (Anthropic cache_read_input_tokens, OpenAI cached_tokens). */
  cacheReadTokens?: number;
  /** Prompt cache write tokens (Anthropic cache_creation_input_tokens). */
  cacheWriteTokens?: number;
  /** Computed: cacheReadTokens / prompt. Populated by metrics layer, not adapters. */
  cacheHitRate?: number;
}
```

- [ ] **Step 4: Create src/metrics/cache-metrics.ts**

```typescript
import type { TokenUsage } from '../types.js';

export interface CacheMetrics {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
}

export function extractCacheMetrics(usage: TokenUsage): CacheMetrics {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const prompt = usage.prompt ?? 0;
  const cacheHitRate = prompt > 0 ? cacheReadTokens / prompt : 0;
  return { cacheReadTokens, cacheWriteTokens, cacheHitRate };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/metrics/cache-metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/metrics/cache-metrics.ts tests/metrics/cache-metrics.test.ts
git commit -m "feat(metrics): extend TokenUsage with cache fields + extractCacheMetrics"
```

---

## Task 4: OpenAI-compatible adapter (full implementation)

**Files:**
- Modify: `src/providers/adapters/openai-compat.ts` (full impl replacing stub)
- Create: `tests/providers/adapters/openai-compat.test.ts`

**Interfaces:**
- Consumes: `ProviderDescriptor`, `ModelAdapter`/`BaseAdapter`/`HttpError`, extended `TokenUsage`.
- Produces: working `OpenAICompatAdapter` with `sendMessage` + `sendMessageStream` + `buildCacheBreakpoints` + OpenAI `cached_tokens` extraction.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/adapters/openai-compat.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatAdapter } from '../../../src/providers/adapters/openai-compat.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';

const openaiDescriptor: ProviderDescriptor = {
  id: 'openai', name: 'OpenAI', apiBase: 'https://api.openai.com/v1',
  authScheme: 'bearer', envVar: 'OPENAI_API_KEY', adapter: 'openai-compat', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('OpenAICompatAdapter.sendMessage parses chat completion response', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({
      choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(result.stopReason, 'stop');
    assert.equal(capturedHeaders['authorization'], 'Bearer sk-test');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage parses tool_calls', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.text, null);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'call_1');
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_calls');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.sendMessage extracts cached_tokens from prompt_tokens_details', async () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005,
      prompt_tokens_details: { cached_tokens: 700 },
    },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.usage.cacheReadTokens, 700);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('OpenAICompatAdapter.supportsStreaming returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsStreaming(), true);
});

test('OpenAICompatAdapter.supportsPromptCaching returns true', () => {
  const adapter = new OpenAICompatAdapter(openaiDescriptor, 'gpt-4o', { apiKey: 'sk-test' });
  assert.equal(adapter.supportsPromptCaching(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/providers/adapters/openai-compat.test.ts`
Expected: FAIL — sendMessage throws "not implemented".

- [ ] **Step 3: Implement OpenAICompatAdapter**

Replace `src/providers/adapters/openai-compat.ts` with:

```typescript
import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface OpenAIChoice {
  message: { role: string; content: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
  finish_reason: string;
}
interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAICompatAdapter extends BaseAdapter implements ModelAdapter {
  private descriptor: ProviderDescriptor;
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.descriptor = descriptor;
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  buildCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
    // OpenAI auto-caches; no explicit breakpoints needed.
    return messages;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts, false);
      const res = await this.fetchEndpoint('/chat/completions', body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `OpenAI-compat ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as OpenAIResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  async *sendMessageStream(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk> {
    const body = this.buildBody(messages, tools, opts, true);
    const res = await this.fetchEndpoint('/chat/completions', body);
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new HttpError(res.status, text, `OpenAI-compat stream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
          };
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) yield { text: delta.content };
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              yield { toolCallDelta: { id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments } };
            }
          }
          if (evt.choices?.[0]?.finish_reason) yield { finishReason: evt.choices[0].finish_reason };
          if (evt.usage) {
            yield {
              usage: { prompt: evt.usage.prompt_tokens, completion: evt.usage.completion_tokens, total: evt.usage.total_tokens },
              cacheReadTokens: evt.usage.prompt_tokens_details?.cached_tokens,
            };
          }
        } catch { /* skip non-JSON */ }
      }
    }
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      stream,
    };
    if (tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.reasoning && opts.reasoning.type === 'effort') {
      body.reasoning_effort = opts.reasoning.value ?? 'medium';
    }
    return body;
  }

  private async fetchEndpoint(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.descriptor.authScheme === 'bearer' && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.descriptor.headerName && this.apiKey) headers[this.descriptor.headerName] = this.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  private parseResponse(json: OpenAIResponse): ModelResponse {
    const choice = json.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(tc => ({
      id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
    const usage: TokenUsage = {
      prompt: json.usage?.prompt_tokens,
      completion: json.usage?.completion_tokens,
      total: json.usage?.total_tokens,
      cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens,
    };
    return { text: choice.message.content ?? null, toolCalls, usage, stopReason: choice.finish_reason, raw: json };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/providers/adapters/openai-compat.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/adapters/openai-compat.ts tests/providers/adapters/openai-compat.test.ts
git commit -m "feat(adapters): full OpenAI-compatible adapter with streaming + cache token extraction"
```
---

## Task 5: Anthropic adapter (native Messages API + extended thinking + prompt caching)

**Files:**
- Modify: `src/providers/adapters/anthropic.ts` (full impl replacing stub)
- Create: `tests/providers/adapters/anthropic.test.ts`

**Interfaces:**
- Produces: working `AnthropicAdapter` with native Messages API, `thinking.budget_tokens` reasoning, `cache_control` breakpoints on last 4 user/system messages.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/adapters/anthropic.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../../../src/providers/adapters/anthropic.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';
import type { ChatMessage } from '../../../src/types.js';

const anthropicDescriptor: ProviderDescriptor = {
  id: 'anthropic', name: 'Anthropic', apiBase: 'https://api.anthropic.com',
  authScheme: 'x-api-key', envVar: 'ANTHROPIC_API_KEY', adapter: 'anthropic', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('AnthropicAdapter.sendMessage parses text response', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  let capturedHeaders: Record<string, string> = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return mockResponse({
      id: 'msg_1', role: 'assistant',
      content: [{ type: 'text', text: 'Hello there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello there');
    assert.equal(result.toolCalls.length, 0);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(capturedHeaders['x-api-key'], 'sk-ant');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.sendMessage parses tool_use blocks', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading file' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 20 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.text, 'Reading file');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'toolu_1');
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
    assert.equal(result.stopReason, 'tool_use');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.sendMessage extracts cache tokens', async () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-5-sonnet-20241022', { apiKey: 'sk-ant' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 800, cache_creation_input_tokens: 150 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.usage.cacheReadTokens, 800);
    assert.equal(result.usage.cacheWriteTokens, 150);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('AnthropicAdapter.supportsReasoning returns true', () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-7-sonnet-20250219', { apiKey: 'sk-ant' });
  assert.equal(adapter.supportsReasoning(), true);
  assert.equal(adapter.supportsPromptCaching(), true);
  assert.equal(adapter.supportsStreaming(), true);
});

test('AnthropicAdapter.buildCacheBreakpoints preserves message count', () => {
  const adapter = new AnthropicAdapter(anthropicDescriptor, 'claude-3-7-sonnet-20250219', { apiKey: 'sk-ant' });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];
  const result = adapter.buildCacheBreakpoints!(messages);
  assert.equal(result.length, messages.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/providers/adapters/anthropic.test.ts`
Expected: FAIL — sendMessage throws "not implemented".

- [ ] **Step 3: Implement AnthropicAdapter**

Replace `src/providers/adapters/anthropic.ts` with:

```typescript
import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface AnthropicContent { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface AnthropicResponse {
  id: string; role: string; content: AnthropicContent[]; stop_reason: string;
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

const MAX_CACHE_BREAKPOINTS = 4;

export class AnthropicAdapter extends BaseAdapter implements ModelAdapter {
  private descriptor: ProviderDescriptor;
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.descriptor = descriptor;
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  buildCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] {
    // cache_control markers are applied inside buildBody; this method satisfies the interface contract.
    return messages;
  }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts, false);
      const res = await this.fetchEndpoint('/v1/messages', body);
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Anthropic ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as AnthropicResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  async *sendMessageStream(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk> {
    const body = this.buildBody(messages, tools, opts, true);
    const res = await this.fetchEndpoint('/v1/messages', body);
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new HttpError(res.status, text, `Anthropic stream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n');
      buf = events.pop() ?? '';
      for (const line of events) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const evt = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.text) yield { text: evt.delta.text };
          if (evt.type === 'message_delta' && evt.delta?.stop_reason) yield { finishReason: evt.delta.stop_reason };
          if (evt.type === 'message_start' && evt.message?.usage) {
            const u = evt.message.usage;
            yield {
              usage: { prompt: u.input_tokens, completion: u.output_tokens },
              cacheReadTokens: u.cache_read_input_tokens,
              cacheWriteTokens: u.cache_creation_input_tokens,
            };
          }
        } catch { /* skip */ }
      }
    }
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined, stream: boolean): Record<string, unknown> {
    let system: string | undefined;
    const conversational: Array<Record<string, unknown>> = [];
    const cacheIndices = new Set<number>();
    let targetCount = 0;
    for (let i = messages.length - 1; i >= 0 && targetCount < MAX_CACHE_BREAKPOINTS; i--) {
      if (messages[i].role === 'system' || messages[i].role === 'user') {
        cacheIndices.add(i);
        targetCount++;
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'system') {
        system = (system ?? '') + (m.content ?? '');
        continue;
      }
      const role = m.role === 'tool' ? 'user' : m.role;
      const content: Array<Record<string, unknown>> = [];
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        if (m.content) content.unshift({ type: 'text', text: m.content });
      } else if (m.role === 'tool') {
        content.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' });
      } else {
        content.push({ type: 'text', text: m.content ?? '' });
      }
      const block: Record<string, unknown> = { role };
      if (cacheIndices.has(i)) {
        block.content = content.map((c, idx) => idx === content.length - 1 ? { ...c, cache_control: { type: 'ephemeral' } } : c);
      } else {
        block.content = content;
      }
      conversational.push(block);
    }
    const body: Record<string, unknown> = {
      model: this.modelId,
      max_tokens: opts?.maxTokens ?? 4096,
      messages: conversational,
      stream,
    };
    if (system) body.system = system;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (tools.length > 0) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (opts?.reasoning && opts.reasoning.type === 'budget_tokens') {
      body.thinking = { type: 'enabled', budget_tokens: typeof opts.reasoning.value === 'number' ? opts.reasoning.value : 4096 };
    }
    return body;
  }

  private async fetchEndpoint(path: string, body: Record<string, unknown>): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }

  private parseResponse(json: AnthropicResponse): ModelResponse {
    let text: string | null = null;
    const toolCalls: ToolCall[] = [];
    for (const block of json.content) {
      if (block.type === 'text' && block.text !== undefined) {
        text = (text ?? '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id ?? '', name: block.name ?? '', arguments: block.input ?? {} });
      }
    }
    const usage: TokenUsage = {
      prompt: json.usage.input_tokens,
      completion: json.usage.output_tokens,
      cacheReadTokens: json.usage.cache_read_input_tokens,
      cacheWriteTokens: json.usage.cache_creation_input_tokens,
    };
    return { text, toolCalls, usage, stopReason: json.stop_reason, raw: json };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/providers/adapters/anthropic.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/providers/adapters/anthropic.ts tests/providers/adapters/anthropic.test.ts
git commit -m "feat(adapters): Anthropic Messages API + extended thinking + cache_control breakpoints"
```

---

## Task 6: Google + Bedrock adapters

**Files:**
- Modify: `src/providers/adapters/google.ts` (full impl)
- Modify: `src/providers/adapters/bedrock.ts` (full impl)
- Create: `tests/providers/adapters/google.test.ts`

**Interfaces:**
- Produces: `GoogleAdapter` (Gemini `generateContent` + `streamGenerateContent`), `BedrockAdapter` (AWS SigV4-style; uses OpenAI-compatible gateway URL when `AWS_BEDROCK_GATEWAY_URL` set, else throws on construction).

- [ ] **Step 1: Write the failing test for Google adapter**

Create `tests/providers/adapters/google.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAdapter } from '../../../src/providers/adapters/google.js';
import type { ProviderDescriptor } from '../../../src/providers/types.js';

const googleDescriptor: ProviderDescriptor = {
  id: 'google', name: 'Google AI Studio', apiBase: 'https://generativelanguage.googleapis.com',
  authScheme: 'google', envVar: 'GOOGLE_API_KEY', adapter: 'google', isBuiltin: true,
};

function mockResponse(body: unknown, status = 200): Response {
  return { status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

test('GoogleAdapter.sendMessage parses generateContent response', async () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  let capturedUrl = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    capturedUrl = String(input);
    return mockResponse({
      candidates: [{ content: { parts: [{ text: 'Hello Gemini' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 3 },
    });
  }) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'hi' }], []);
    assert.equal(result.text, 'Hello Gemini');
    assert.equal(result.stopReason, 'STOP');
    assert.equal(result.usage.prompt, 10);
    assert.equal(result.usage.completion, 5);
    assert.equal(result.usage.cacheReadTokens, 3);
    assert.ok(capturedUrl.includes('key=AIza-test'));
    assert.ok(capturedUrl.includes('gemini-1.5-pro'));
    assert.ok(capturedUrl.includes('generateContent'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GoogleAdapter.sendMessage parses functionCall', async () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => mockResponse({
    candidates: [{
      content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  }) as Response) as typeof fetch;
  try {
    const result = await adapter.sendMessage([{ role: 'user', content: 'read file' }], []);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read_file');
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'a.ts' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('GoogleAdapter.supportsStreaming returns true', () => {
  const adapter = new GoogleAdapter(googleDescriptor, 'gemini-1.5-pro', { apiKey: 'AIza-test' });
  assert.equal(adapter.supportsStreaming(), true);
  assert.equal(adapter.supportsPromptCaching(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/providers/adapters/google.test.ts`
Expected: FAIL — sendMessage throws "not implemented".

- [ ] **Step 3: Implement GoogleAdapter**

Replace `src/providers/adapters/google.ts` with:

```typescript
import type { ChatMessage, ModelResponse, ToolCall, TokenUsage, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

interface GeminiPart { text?: string; functionCall?: { name: string; args: Record<string, unknown> } }
interface GeminiCandidate { content: { parts: GeminiPart[] }; finishReason?: string }
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number; cachedContentTokenCount?: number };
}

export class GoogleAdapter extends BaseAdapter implements ModelAdapter {
  private descriptor: ProviderDescriptor;
  private modelId: string;
  private apiKey?: string;
  private baseUrl?: string;

  constructor(descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.descriptor = descriptor;
    this.modelId = modelId;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? descriptor.apiBase;
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return true; }
  supportsPromptCaching(): boolean { return true; }

  buildCacheBreakpoints(messages: ChatMessage[]): ChatMessage[] { return messages; }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body = this.buildBody(messages, tools, opts);
      const url = `${this.baseUrl}/v1beta/models/${this.modelId}:generateContent?key=${this.apiKey ?? ''}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Google ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as GeminiResponse;
      return this.parseResponse(json);
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }

  async *sendMessageStream(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): AsyncIterable<StreamChunk> {
    const body = this.buildBody(messages, tools, opts);
    const url = `${this.baseUrl}/v1beta/models/${this.modelId}:streamGenerateContent?alt=sse&key=${this.apiKey ?? ''}`;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw new HttpError(res.status, text, `Google stream ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        try {
          const evt = JSON.parse(data) as GeminiResponse;
          const candidate = evt.candidates?.[0];
          for (const part of candidate?.content.parts ?? []) {
            if (part.text) yield { text: part.text };
            if (part.functionCall) yield { toolCallDelta: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args) } };
          }
          if (candidate?.finishReason) yield { finishReason: candidate.finishReason };
          if (evt.usageMetadata) {
            yield {
              usage: { prompt: evt.usageMetadata.promptTokenCount, completion: evt.usageMetadata.candidatesTokenCount, total: evt.usageMetadata.totalTokenCount },
              cacheReadTokens: evt.usageMetadata.cachedContentTokenCount,
            };
          }
        } catch { /* skip */ }
      }
    }
  }

  private buildBody(messages: ChatMessage[], tools: ToolDefinition[], opts: SendOpts | undefined): Record<string, unknown> {
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: m.toolCalls?.length
          ? m.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } }))
          : m.role === 'tool'
            ? [{ functionResponse: { name: m.name ?? '', response: { content: m.content ?? '' } } }]
            : [{ text: m.content ?? '' }],
      }));
    const system = messages.filter(m => m.role === 'system').map(m => m.content ?? '').join('\n');
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    if (opts?.temperature !== undefined) (body.generationConfig ??= {}).temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) (body.generationConfig ??= {}).maxOutputTokens = opts.maxTokens;
    return body;
  }

  private parseResponse(json: GeminiResponse): ModelResponse {
    const candidate = json.candidates?.[0];
    const parts = candidate?.content.parts ?? [];
    const text = parts.map(p => p.text ?? '').join('') || null;
    const toolCalls: ToolCall[] = parts
      .filter(p => p.functionCall)
      .map(p => ({ id: `google_${p.functionCall!.name}`, name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));
    const usage: TokenUsage = {
      prompt: json.usageMetadata?.promptTokenCount,
      completion: json.usageMetadata?.candidatesTokenCount,
      total: json.usageMetadata?.totalTokenCount,
      cacheReadTokens: json.usageMetadata?.cachedContentTokenCount,
    };
    return { text, toolCalls, usage, stopReason: candidate?.finishReason, raw: json };
  }
}
```

- [ ] **Step 4: Implement BedrockAdapter (gateway-delegating)**

Replace `src/providers/adapters/bedrock.ts` with:

```typescript
import type { ChatMessage, ModelResponse, ToolDefinition } from '../../types.js';
import type { ModelAdapter, SendOpts, StreamChunk } from './base.js';
import { BaseAdapter, HttpError } from './base.js';
import type { ProviderDescriptor } from '../types.js';
import type { CreateAdapterOpts } from '../registry.js';

/**
 * Bedrock adapter. Delegates to an OpenAI-compatible gateway URL (set via
 * AWS_BEDROCK_GATEWAY_URL env or provider apiBase). When no gateway is set,
 * construction throws with a clear message — native SigV4 is out of scope.
 */
export class BedrockAdapter extends BaseAdapter implements ModelAdapter {
  private modelId: string;
  private gatewayUrl?: string;
  private apiKey?: string;

  constructor(_descriptor: ProviderDescriptor, modelId: string, opts: CreateAdapterOpts) {
    super(opts.logger);
    this.modelId = modelId;
    this.gatewayUrl = opts.baseUrl ?? process.env.AWS_BEDROCK_GATEWAY_URL;
    this.apiKey = opts.apiKey ?? process.env.AWS_BEDROCK_GATEWAY_KEY;
    if (!this.gatewayUrl) {
      throw new Error('BedrockAdapter requires AWS_BEDROCK_GATEWAY_URL (or provider apiBase) — native SigV4 not implemented');
    }
  }

  supportsStreaming(): boolean { return true; }
  supportsReasoning(): boolean { return false; }
  supportsPromptCaching(): boolean { return false; }

  async sendMessage(messages: ChatMessage[], tools: ToolDefinition[], opts?: SendOpts): Promise<ModelResponse> {
    return this.withRetry(async () => {
      const body: Record<string, unknown> = {
        model: this.modelId,
        messages: messages.map(m => ({ role: m.role, content: m.content, ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}) })),
      };
      if (tools.length > 0) body.tools = tools;
      if (opts?.temperature !== undefined) body.temperature = opts.temperature;
      if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.gatewayUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `Bedrock ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { choices: Array<{ message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason: string }>; usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      const choice = json.choices[0];
      return {
        text: choice.message.content ?? null,
        toolCalls: (choice.message.tool_calls ?? []).map(tc => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') })),
        usage: { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens, total: json.usage.total_tokens },
        stopReason: choice.finish_reason,
        raw: json,
      };
    }, { maxRetries: 3, initialDelayMs: 1000, maxDelayMs: 30000 });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/providers/adapters/google.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/providers/adapters/google.ts src/providers/adapters/bedrock.ts tests/providers/adapters/google.test.ts
git commit -m "feat(adapters): Google Gemini adapter + Bedrock gateway-delegating adapter"
```
---

## Task 7: Custom provider loader + dashboard CRUD route

**Files:**
- Create: `src/providers/custom.ts`
- Create: `src/dashboard-server/routes/providers.ts`
- Create: `tests/providers/custom.test.ts`
- Modify: `src/dashboard-server/server.ts` (mount providers router)

**Interfaces:**
- Produces: `upsertCustomProvider(db, input)` writes a row to `providers` with `is_builtin=0`. `createProvidersRouter()` exposes `GET /api/providers`, `POST /api/providers`, `DELETE /api/providers/:id`.

- [ ] **Step 1: Write the failing test**

Create `tests/providers/custom.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { upsertCustomProvider, listCustomProviders, deleteCustomProvider } from '../../src/providers/custom.js';

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-custom-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('upsertCustomProvider inserts a new custom provider row', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), {
      id: 'my-endpoint', name: 'My Endpoint', apiBase: 'http://localhost:8080/v1',
      authScheme: 'bearer', envVar: 'MY_KEY', adapter: 'openai-compat',
    });
    const list = listCustomProviders(getDb());
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'my-endpoint');
    assert.equal(list[0].is_builtin, 0);
  } finally {
    closeDb();
    cleanup();
  }
});

test('upsertCustomProvider updates existing by id', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), { id: 'p1', name: 'Old', adapter: 'openai-compat', authScheme: 'bearer' });
    upsertCustomProvider(getDb(), { id: 'p1', name: 'New', apiBase: 'http://x/v1', adapter: 'openai-compat', authScheme: 'bearer' });
    const list = listCustomProviders(getDb());
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'New');
    assert.equal(list[0].api_base, 'http://x/v1');
  } finally {
    closeDb();
    cleanup();
  }
});

test('deleteCustomProvider removes a row', () => {
  const cleanup = freshDb();
  try {
    upsertCustomProvider(getDb(), { id: 'p1', name: 'A', adapter: 'openai-compat', authScheme: 'bearer' });
    deleteCustomProvider(getDb(), 'p1');
    assert.equal(listCustomProviders(getDb()).length, 0);
  } finally {
    closeDb();
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/providers/custom.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Create src/providers/custom.ts**

```typescript
import type { Database } from 'better-sqlite3';
import type { ProviderRow } from '../db/schema.js';

export interface CustomProviderInput {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  envVar?: string;
  headerName?: string;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
}

export function upsertCustomProvider(db: Database, input: CustomProviderInput): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO providers (id, name, api_base, auth_scheme, env_var, is_builtin, adapter, header_name, created_at, updated_at)
    VALUES (@id, @name, @api_base, @auth_scheme, @env_var, 0, @adapter, @header_name, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, api_base=@api_base, auth_scheme=@auth_scheme, env_var=@env_var,
      adapter=@adapter, header_name=@header_name, updated_at=@updated_at
  `).run({
    id: input.id, name: input.name, api_base: input.apiBase ?? null,
    auth_scheme: input.authScheme, env_var: input.envVar ?? null,
    adapter: input.adapter, header_name: input.headerName ?? null,
    created_at: now, updated_at: now,
  });
}

export function listCustomProviders(db: Database): ProviderRow[] {
  return db.prepare('SELECT * FROM providers WHERE is_builtin = 0 ORDER BY id').all() as ProviderRow[];
}

export function deleteCustomProvider(db: Database, id: string): void {
  db.prepare('DELETE FROM providers WHERE id = ? AND is_builtin = 0').run(id);
}
```

- [ ] **Step 4: Create src/dashboard-server/routes/providers.ts**

```typescript
import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { listCustomProviders, upsertCustomProvider, deleteCustomProvider } from '../../providers/custom.js';
import { BUILTIN_PROVIDERS } from '../../providers/index.js';
import { z } from 'zod';

const CustomProviderInputSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'id must be lowercase kebab-case'),
  name: z.string().min(1).max(128),
  apiBase: z.string().url().optional(),
  authScheme: z.enum(['bearer', 'x-api-key', 'none']),
  envVar: z.string().optional(),
  headerName: z.string().optional(),
  adapter: z.enum(['openai-compat', 'anthropic', 'google', 'bedrock']),
});

export function createProvidersRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    const custom = listCustomProviders(getDb()).map(r => ({ ...r, is_builtin: Boolean(r.is_builtin) }));
    res.json({ builtin: BUILTIN_PROVIDERS, custom });
  });
  router.post('/', (req, res) => {
    const parsed = CustomProviderInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid provider input', details: parsed.error.flatten() });
      return;
    }
    upsertCustomProvider(getDb(), parsed.data);
    res.status(201).json({ ok: true, id: parsed.data.id });
  });
  router.delete('/:id', (req, res) => {
    deleteCustomProvider(getDb(), req.params.id);
    res.json({ ok: true });
  });
  return router;
}
```

- [ ] **Step 5: Mount router in src/dashboard-server/server.ts**

Add to imports (after `createWebhooksRouter` import):

```typescript
import { createProvidersRouter } from './routes/providers.js';
```

Add after `app.use('/api/webhooks', requireAuth(auth), createWebhooksRouter());`:

```typescript
  app.use('/api/providers', requireAuth(auth), createProvidersRouter());
```

And after the `/api/v1/webhooks` line:

```typescript
  app.use('/api/v1/providers', requireApiKey(['providers:read']), createProvidersRouter());
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/providers/custom.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/providers/custom.ts src/dashboard-server/routes/providers.ts src/dashboard-server/server.ts tests/providers/custom.test.ts
git commit -m "feat(providers): custom provider CRUD via dashboard + /api/providers routes"
```

---

## Task 8: Catalog sync from models.dev

**Files:**
- Create: `src/catalog/types.ts` (Zod schemas for models.dev response)
- Create: `src/catalog/sync.ts`
- Create: `src/catalog/match.ts` (canonical model id normalization)
- Create: `tests/catalog/sync.test.ts`
- Create: `tests/catalog/match.test.ts`

**Interfaces:**
- Produces: `fetchSync(source: 'models.dev', opts?: { force?: boolean }): Promise<SyncResult>` — fetches `https://models.dev/api.json`, upserts providers/models/model_providers/pricing rows, updates `catalog_cache_state`.
- Produces: `normalizeModelId(modelId: string, providerId: string): string` — e.g. `('claude-3-7-sonnet-20250219', 'anthropic') -> 'anthropic/claude-3.7-sonnet'`.

- [ ] **Step 1: Write the failing test for match.ts**

Create `tests/catalog/match.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelId, matchModelToCanonical } from '../../src/catalog/match.js';

test('normalizeModelId produces provider/model-id form', () => {
  assert.equal(normalizeModelId('claude-3-7-sonnet-20250219', 'anthropic'), 'anthropic/claude-3-7-sonnet-20250219');
  assert.equal(normalizeModelId('gpt-4o', 'openai'), 'openai/gpt-4o');
});

test('matchModelToCanonical finds existing canonical id by provider+model', () => {
  const catalog = [
    { id: 'anthropic/claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic' },
    { id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai' },
  ];
  assert.equal(matchModelToCanonical('claude-3-7-sonnet-20250219', 'anthropic', catalog), 'anthropic/claude-3-7-sonnet-20250219');
  assert.equal(matchModelToCanonical('gpt-4o', 'openai', catalog), 'openai/gpt-4o');
});

test('matchModelToCanonical fuzzy-matches by name when exact id missing', () => {
  const catalog = [
    { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', provider_id: 'anthropic' },
  ];
  // modelbench returns "Claude 3.7 Sonnet" as name
  assert.equal(matchModelToCanonical(undefined, 'anthropic', catalog, 'Claude 3.7 Sonnet'), 'anthropic/claude-3.7-sonnet');
});

test('matchModelToCanonical returns null when no match', () => {
  const catalog = [{ id: 'openai/gpt-4o', name: 'GPT-4o', provider_id: 'openai' }];
  assert.equal(matchModelToCanonical('unknown-model', 'mistral', catalog), null);
});
```

- [ ] **Step 2: Run match test to verify it fails**

Run: `npx tsx --test tests/catalog/match.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Create src/catalog/match.ts**

```typescript
import type { ModelRow } from '../db/schema.js';

export function normalizeModelId(modelId: string, providerId: string): string {
  return `${providerId}/${modelId}`;
}

export interface CatalogEntry {
  id: string;
  name: string;
  provider_id: string;
}

export function matchModelToCanonical(
  apiModelId: string | undefined,
  providerId: string | undefined,
  catalog: CatalogEntry[],
  nameHint?: string,
): string | null {
  if (apiModelId && providerId) {
    const direct = normalizeModelId(apiModelId, providerId);
    if (catalog.some(c => c.id === direct)) return direct;
  }
  if (nameHint) {
    const normalized = nameHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    for (const entry of catalog) {
      const entryName = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (entryName === normalized) return entry.id;
      if (entryName.includes(normalized) || normalized.includes(entryName)) return entry.id;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run match test to verify it passes**

Run: `npx tsx --test tests/catalog/match.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create src/catalog/types.ts (models.dev Zod schemas)**

```typescript
import { z } from 'zod';

export const ModelsDevCostSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  tiers: z.array(z.object({
    input: z.number(), output: z.number(),
    cache_read: z.number().optional(), cache_write: z.number().optional(),
    tier: z.object({ type: z.string(), size: z.number() }),
  })).optional(),
  context_over_200k: z.object({
    input: z.number(), output: z.number(),
    cache_read: z.number().optional(), cache_write: z.number().optional(),
  }).optional(),
}).optional();

export const ModelsDevLimitSchema = z.object({
  context: z.number(),
  input: z.number().optional(),
  output: z.number(),
});

export const ModelsDevReasoningOptionSchema = z.object({
  type: z.enum(['effort', 'toggle', 'budget_tokens']),
  // provider-specific extra fields tolerated
}).passthrough();

export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  interleaved: z.union([z.literal(true), z.object({ field: z.string() })]).optional(),
  reasoning_options: z.array(ModelsDevReasoningOptionSchema).optional(),
  cost: ModelsDevCostSchema,
  limit: ModelsDevLimitSchema,
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
}).passthrough();

export const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  api: z.string().optional(),
  npm: z.string().optional(),
  env: z.array(z.string()),
  models: z.record(z.string(), ModelsDevModelSchema),
}).passthrough();

export const ModelsDevResponseSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevResponse = z.infer<typeof ModelsDevResponseSchema>;
```

- [ ] **Step 6: Write the failing test for sync.ts**

Create `tests/catalog/sync.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';

const FAKE_MODELS_DEV = {
  anthropic: {
    id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-3-7-sonnet-20250219': {
        id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet',
        attachment: false, reasoning: true, temperature: true, tool_call: true,
        reasoning_options: [{ type: 'budget_tokens' }],
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 8192 },
        status: 'beta',
      },
    },
  },
  openai: {
    id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4o': {
        id: 'gpt-4o', name: 'GPT-4o',
        attachment: true, reasoning: false, temperature: true, tool_call: true,
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
};

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sync-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('fetchSync upserts providers, models, model_providers, pricing from models.dev', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200, ok: true,
    json: async () => FAKE_MODELS_DEV,
    text: async () => JSON.stringify(FAKE_MODELS_DEV),
  } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    const db = getDb();
    const providers = db.prepare('SELECT id FROM providers ORDER BY id').all() as { id: string }[];
    assert.deepEqual(providers.map(p => p.id), ['anthropic', 'openai']);
    const models = db.prepare('SELECT id, name, reasoning, tool_call, context_limit FROM models ORDER BY id').all() as Array<{ id: string; name: string; reasoning: number; tool_call: number; context_limit: number }>;
    assert.equal(models.length, 2);
    const claude = models.find(m => m.id.startsWith('anthropic/'))!;
    assert.equal(claude.name, 'Claude 3.7 Sonnet');
    assert.equal(claude.reasoning, 1);
    assert.equal(claude.tool_call, 1);
    assert.equal(claude.context_limit, 200000);
    const pricing = db.prepare('SELECT model_id, input, output, cache_read, cache_write FROM pricing ORDER BY model_id').all() as Array<{ model_id: string; input: number; output: number; cache_read: number; cache_write: number }>;
    assert.equal(pricing.length, 2);
    const claudePricing = pricing.find(p => p.model_id.startsWith('anthropic/'))!;
    assert.equal(claudePricing.input, 3);
    assert.equal(claudePricing.output, 15);
    assert.equal(claudePricing.cache_read, 0.3);
    const cacheState = db.prepare('SELECT source, last_status, count FROM catalog_cache_state WHERE source = ?').get('models.dev') as { source: string; last_status: string; count: number };
    assert.equal(cacheState.last_status, 'ok');
    assert.equal(cacheState.count, 2);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchSync records error status on fetch failure', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 500, ok: false, json: async () => ({}), text: async () => 'server error' } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    const cacheState = getDb().prepare('SELECT last_status, last_error FROM catalog_cache_state WHERE source = ?').get('models.dev') as { last_status: string; last_error: string };
    assert.equal(cacheState.last_status, 'error');
    assert.ok(cacheState.last_error);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});
```

- [ ] **Step 7: Run sync test to verify it fails**

Run: `npx tsx --test tests/catalog/sync.test.ts`
Expected: FAIL module not found.

- [ ] **Step 8: Create src/catalog/sync.ts**

```typescript
import type { Database } from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { ModelsDevResponseSchema, type ModelsDevResponse, type ModelsDevModel, type ModelsDevProvider } from './types.js';
import { normalizeModelId } from './match.js';

export interface SyncResult {
  source: string;
  ok: boolean;
  count: number;
  error?: string;
}

export interface SyncOpts {
  apiUrl: string;
  force?: boolean;
}

const PROVIDER_ADAPTER_MAP: Record<string, 'openai-compat' | 'anthropic' | 'google' | 'bedrock'> = {
  anthropic: 'anthropic',
  google: 'google',
  'google-vertex': 'google',
  'google-vertex-anthropic': 'anthropic',
  'amazon-bedrock': 'bedrock',
};

const DEFAULT_API_URL = 'https://models.dev/api.json';
const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export async function fetchSync(source: 'models.dev', opts: SyncOpts = { apiUrl: DEFAULT_API_URL }): Promise<SyncResult> {
  const db = getDb();
  try {
    const res = await fetch(opts.apiUrl);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelsDevResponseSchema.parse(raw) as ModelsDevResponse;
    const count = upsertCatalog(db, parsed);
    updateCacheState(db, 'models.dev', 'ok', undefined, count);
    return { source: 'models.dev', ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCacheState(db, 'models.dev', 'error', msg, 0);
    return { source: 'models.dev', ok: false, count: 0, error: msg };
  }
}

function upsertCatalog(db: Database, data: ModelsDevResponse): number {
  const now = new Date().toISOString();
  let modelCount = 0;
  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, name, api_base, auth_scheme, env_var, is_builtin, adapter, header_name, created_at, updated_at)
    VALUES (@id, @name, NULL, @auth_scheme, @env_var, 1, @adapter, NULL, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, env_var=@env_var, adapter=@adapter, updated_at=@updated_at
  `);
  const upsertModel = db.prepare(`
    INSERT INTO models (id, name, family, provider_id, release_date, attachment, reasoning, temperature, tool_call,
      interleaved, status, context_limit, input_limit, output_limit, modalities, reasoning_options, source_json, last_synced_at)
    VALUES (@id, @name, @family, @provider_id, @release_date, @attachment, @reasoning, @temperature, @tool_call,
      @interleaved, @status, @context_limit, @input_limit, @output_limit, @modalities, @reasoning_options, @source_json, @last_synced_at)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, family=@family, release_date=@release_date, attachment=@attachment, reasoning=@reasoning,
      temperature=@temperature, tool_call=@tool_call, interleaved=@interleaved, status=@status,
      context_limit=@context_limit, input_limit=@input_limit, output_limit=@output_limit,
      modalities=@modalities, reasoning_options=@reasoning_options, source_json=@source_json, last_synced_at=@last_synced_at
  `);
  const upsertModelProvider = db.prepare(`
    INSERT INTO model_providers (model_id, provider_id, api_model_id) VALUES (@model_id, @provider_id, @api_model_id)
    ON CONFLICT(model_id, provider_id) DO UPDATE SET api_model_id=@api_model_id
  `);
  const upsertPricing = db.prepare(`
    INSERT INTO pricing (model_id, input, output, cache_read, cache_write, tier_size, over_200k_input, over_200k_output, over_200k_cache_read, over_200k_cache_write, updated_at)
    VALUES (@model_id, @input, @output, @cache_read, @cache_write, NULL, @over_200k_input, @over_200k_output, @over_200k_cache_read, @over_200k_cache_write, @updated_at)
    ON CONFLICT(model_id, tier_size) DO UPDATE SET
      input=@input, output=@output, cache_read=@cache_read, cache_write=@cache_write,
      over_200k_input=@over_200k_input, over_200k_output=@over_200k_output,
      over_200k_cache_read=@over_200k_cache_read, over_200k_cache_write=@over_200k_cache_write, updated_at=@updated_at
  `);

  const tx = db.transaction(() => {
    for (const [providerId, provider] of Object.entries(data)) {
      const adapter = PROVIDER_ADAPTER_MAP[providerId] ?? 'openai-compat';
      const authScheme = providerId === 'anthropic' ? 'x-api-key' : providerId.startsWith('google') ? 'google' : providerId === 'amazon-bedrock' ? 'bedrock' : 'bearer';
      upsertProvider.run({
        id: providerId, name: provider.name, auth_scheme: authScheme,
        env_var: provider.env[0] ?? null, adapter, created_at: now, updated_at: now,
      });
      for (const [modelId, model] of Object.entries(provider.models)) {
        const canonicalId = normalizeModelId(modelId, providerId);
        upsertModel.run({
          id: canonicalId, name: model.name, family: model.family ?? null,
          provider_id: providerId, release_date: model.release_date ?? null,
          attachment: model.attachment ? 1 : 0, reasoning: model.reasoning ? 1 : 0,
          temperature: model.temperature ? 1 : 0, tool_call: model.tool_call ? 1 : 0,
          interleaved: typeof model.interleaved === 'object' ? model.interleaved.field : (model.interleaved ? 'reasoning' : null),
          status: model.status ?? null,
          context_limit: model.limit.context, input_limit: model.limit.input ?? null, output_limit: model.limit.output,
          modalities: model.modalities ? JSON.stringify(model.modalities) : null,
          reasoning_options: model.reasoning_options ? JSON.stringify(model.reasoning_options) : null,
          source_json: JSON.stringify(model), last_synced_at: now,
        });
        upsertModelProvider.run({ model_id: canonicalId, provider_id: providerId, api_model_id: modelId });
        const cost = model.cost ?? {};
        upsertPricing.run({
          model_id: canonicalId,
          input: cost.input ?? null, output: cost.output ?? null,
          cache_read: cost.cache_read ?? null, cache_write: cost.cache_write ?? null,
          over_200k_input: cost.context_over_200k?.input ?? null,
          over_200k_output: cost.context_over_200k?.output ?? null,
          over_200k_cache_read: cost.context_over_200k?.cache_read ?? null,
          over_200k_cache_write: cost.context_over_200k?.cache_write ?? null,
          updated_at: now,
        });
        modelCount++;
      }
    }
  });
  tx();
  return modelCount;
}

function updateCacheState(db: Database, source: string, status: string, error: string | undefined, count: number): void {
  const now = new Date();
  const next = new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString();
  db.prepare(`
    INSERT INTO catalog_cache_state (source, last_fetch, last_status, last_error, count, next_refresh)
    VALUES (@source, @last_fetch, @last_status, @last_error, @count, @next_refresh)
    ON CONFLICT(source) DO UPDATE SET
      last_fetch=@last_fetch, last_status=@last_status, last_error=@last_error, count=@count, next_refresh=@next_refresh
  `).run({
    source, last_fetch: now.toISOString(), last_status: status,
    last_error: error ?? null, count, next_refresh: next,
  });
}
```

- [ ] **Step 9: Run sync test to verify it passes**

Run: `npx tsx --test tests/catalog/sync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/catalog/ tests/catalog/
git commit -m "feat(catalog): models.dev sync into SQLite with providers/models/pricing"
```
---

## Task 9: Benchmark sync from modelbench + zeroeval

**Files:**
- Modify: `src/catalog/types.ts` (add modelbench + zeroeval schemas)
- Create: `src/catalog/benchmarks.ts`
- Create: `tests/catalog/benchmarks.test.ts`

**Interfaces:**
- Produces: `fetchBenchmarks(source: 'modelbench' | 'zeroeval', opts?: { force?: boolean }): Promise<SyncResult>`. Paginates modelbench `/api/v1/models?limit=50`, fetches zeroeval `/leaderboard/models/full`. Upserts `benchmarks` rows with `is_preferred` flag (modelbench preferred for Intelligence Index/Coding Score/Agentic Score/Speed TPS).

- [ ] **Step 1: Add modelbench + zeroeval schemas to src/catalog/types.ts**

Append to `src/catalog/types.ts`:

```typescript
export const ModelbenchModelSchema = z.object({
  slug: z.string(),
  name: z.string(),
  developer: z.string().optional(),
  context_length: z.number().optional(),
  input_price_per_million: z.number().optional(),
  output_price_per_million: z.number().optional(),
  cached_input_price_per_million: z.number().optional(),
  intelligence_score: z.number().optional(),
  coding_score: z.number().optional(),
  agentic_score: z.number().optional(),
  speed_tps: z.number().optional(),
  benchmark_data: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(),
}).passthrough();

export const ModelbenchResponseSchema = z.object({
  data: z.array(ModelbenchModelSchema),
  meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }).optional(),
});

export const ZeroEvalModelSchema = z.record(z.string(), z.unknown());

export type ModelbenchModel = z.infer<typeof ModelbenchModelSchema>;
export type ModelbenchResponse = z.infer<typeof ModelbenchResponseSchema>;
```

- [ ] **Step 2: Write the failing test**

Create `tests/catalog/benchmarks.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { fetchBenchmarks } from '../../src/catalog/benchmarks.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
};

const MODELBENCH_PAGE1 = {
  data: [{
    slug: 'openai/gpt-4o', name: 'GPT-4o', developer: 'OpenAI',
    intelligence_score: 75.2, coding_score: 80.1, agentic_score: 72.0, speed_tps: 48.0,
    benchmark_data: { 'Intelligence Index': 75.2, 'Coding Score': 80.1, 'GPQA Diamond': 60.5 },
    source: 'https://modelbench.lol/models/openai/gpt-4o',
  }],
  meta: { page: 1, limit: 50, total: 1 },
};

const ZEROEVAL = {
  'gpt-4o': { model_name: 'GPT-4o', swebench: 33.5, gpqa: 53.6, mmlu: 88.7 },
};

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bench-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

function mockFetchImpl(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) {
        return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
      }
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'not found' } as unknown as Response;
  }) as typeof fetch;
}

test('fetchBenchmarks modelbench upserts benchmark rows with is_preferred flags', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchImpl({
    'models.dev/api.json': () => MODELS_DEV,
    'modelbench.lol/api/v1/models': () => MODELBENCH_PAGE1,
  });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const result = await fetchBenchmarks('modelbench', { force: true });
    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    const rows = getDb().prepare('SELECT benchmark, source, score, is_preferred FROM benchmarks ORDER BY benchmark').all() as Array<{ benchmark: string; source: string; score: number; is_preferred: number }>;
    assert.equal(rows.length, 3);
    const ii = rows.find(r => r.benchmark === 'Intelligence Index')!;
    assert.equal(ii.is_preferred, 1);
    const gpqa = rows.find(r => r.benchmark === 'GPQA Diamond')!;
    assert.equal(gpqa.is_preferred, 1);
    const cs = rows.find(r => r.benchmark === 'Coding Score')!;
    assert.equal(cs.is_preferred, 1);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchBenchmarks zeroeval upserts benchmark rows with is_preferred=0 for overlap', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetchImpl({
    'models.dev/api.json': () => MODELS_DEV,
    'api.zeroeval.com/leaderboard/models/full': () => ZEROEVAL,
  });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const result = await fetchBenchmarks('zeroeval', { force: true });
    assert.equal(result.ok, true);
    const rows = getDb().prepare('SELECT benchmark, source, score, is_preferred FROM benchmarks ORDER BY benchmark').all() as Array<{ benchmark: string; source: string; score: number; is_preferred: number }>;
    assert.ok(rows.length >= 3);
    for (const r of rows) assert.equal(r.is_preferred, 0, `${r.benchmark} should not be preferred from zeroeval`);
    const swe = rows.find(r => r.benchmark === 'SWE-bench');
    assert.ok(swe);
    assert.equal(swe!.score, 33.5);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});

test('fetchBenchmarks records error status on fetch failure', async () => {
  const cleanup = freshDb();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ status: 500, ok: false, json: async () => ({}), text: async () => 'err' } as unknown as Response)) as typeof fetch;
  try {
    const result = await fetchBenchmarks('modelbench', { force: true });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    cleanup();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/catalog/benchmarks.test.ts`
Expected: FAIL module not found.

- [ ] **Step 4: Create src/catalog/benchmarks.ts**

```typescript
import type { Database } from 'better-sqlite3';
import { getDb } from '../db/client.js';
import { ModelbenchResponseSchema, type ModelbenchResponse, ZeroEvalModelSchema } from './types.js';
import { matchModelToCanonical, type CatalogEntry } from './match.js';
import type { SyncResult } from './sync.js';

const MODELBENCH_API = 'https://modelbench.lol/api/v1/models';
const ZEROEVAL_API = 'https://api.zeroeval.com/leaderboard/models/full';
const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const PREFERRED_MODELBENCH = new Set(['Intelligence Index', 'Coding Score', 'Agentic Score', 'Speed TPS']);
const ZEROEVAL_BENCH_MAP: Record<string, string> = {
  swebench: 'SWE-bench', gpqa: 'GPQA Diamond', mmlu: 'MMLU', humaneval: 'HumanEval', math: 'MATH',
};

export interface BenchmarkOpts {
  force?: boolean;
}

export async function fetchBenchmarks(source: 'modelbench' | 'zeroeval', _opts: BenchmarkOpts = {}): Promise<SyncResult> {
  const db = getDb();
  try {
    const catalog = db.prepare('SELECT id, name, provider_id FROM models').all() as CatalogEntry[];
    let count: number;
    if (source === 'modelbench') count = await fetchModelbench(db, catalog);
    else count = await fetchZeroEval(db, catalog);
    updateCacheState(db, source, 'ok', undefined, count);
    return { source, ok: true, count };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateCacheState(db, source, 'error', msg, 0);
    return { source, ok: false, count: 0, error: msg };
  }
}

async function fetchModelbench(db: Database, catalog: CatalogEntry[]): Promise<number> {
  const upsertBenchmark = db.prepare(`
    INSERT INTO benchmarks (model_id, benchmark, source, score, measured_at, source_url, is_preferred)
    VALUES (@model_id, @benchmark, @source, @score, @measured_at, @source_url, @is_preferred)
    ON CONFLICT(model_id, benchmark, source) DO UPDATE SET
      score=@score, measured_at=@measured_at, source_url=@source_url, is_preferred=@is_preferred
  `);
  const now = new Date().toISOString();
  let count = 0;
  let page = 1;
  const limit = 50;
  let total = Infinity;
  const fields = 'slug,name,intelligence_score,coding_score,agentic_score,speed_tps,benchmark_data,source';
  while (page <= Math.ceil(total / limit) && page <= 20) {
    const url = `${MODELBENCH_API}?limit=${limit}&page=${page}&fields=${fields}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`modelbench ${res.status}: ${text.slice(0, 200)}`);
    }
    const raw = await res.json();
    const parsed = ModelbenchResponseSchema.parse(raw) as ModelbenchResponse;
    total = parsed.meta?.total ?? parsed.data.length;
    const tx = db.transaction(() => {
      for (const m of parsed.data) {
        const canonicalId = matchModelToCanonical(undefined, undefined, catalog, m.name);
        if (!canonicalId) continue;
        const benchmarks: Array<[string, number]> = [];
        if (m.intelligence_score !== undefined) benchmarks.push(['Intelligence Index', m.intelligence_score]);
        if (m.coding_score !== undefined) benchmarks.push(['Coding Score', m.coding_score]);
        if (m.agentic_score !== undefined) benchmarks.push(['Agentic Score', m.agentic_score]);
        if (m.speed_tps !== undefined) benchmarks.push(['Speed TPS', m.speed_tps]);
        if (m.benchmark_data) {
          for (const [k, v] of Object.entries(m.benchmark_data)) {
            if (typeof v === 'number' && !benchmarks.some(b => b[0] === k)) benchmarks.push([k, v]);
          }
        }
        for (const [name, score] of benchmarks) {
          upsertBenchmark.run({
            model_id: canonicalId, benchmark: name, source: 'modelbench', score,
            measured_at: now, source_url: m.source ?? null,
            is_preferred: PREFERRED_MODELBENCH.has(name) ? 1 : 0,
          });
          count++;
        }
      }
    });
    tx();
    page++;
  }
  return count;
}

async function fetchZeroEval(db: Database, catalog: CatalogEntry[]): Promise<number> {
  const upsertBenchmark = db.prepare(`
    INSERT INTO benchmarks (model_id, benchmark, source, score, measured_at, source_url, is_preferred)
    VALUES (@model_id, @benchmark, @source, @score, @measured_at, @source_url, @is_preferred)
    ON CONFLICT(model_id, benchmark, source) DO UPDATE SET
      score=@score, measured_at=@measured_at, source_url=@source_url, is_preferred=@is_preferred
  `);
  const now = new Date().toISOString();
  let count = 0;
  const res = await fetch(ZEROEVAL_API);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`zeroeval ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = await res.json();
  const parsed = ZeroEvalModelSchema.parse(raw) as Record<string, Record<string, unknown>>;
  const tx = db.transaction(() => {
    for (const [modelKey, fields] of Object.entries(parsed)) {
      const modelName = typeof fields.model_name === 'string' ? fields.model_name : modelKey;
      const canonicalId = matchModelToCanonical(undefined, undefined, catalog, modelName);
      if (!canonicalId) continue;
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'model_name' || k === 'model_id') continue;
        if (typeof v !== 'number') continue;
        const benchName = ZEROEVAL_BENCH_MAP[k.toLowerCase()] ?? k;
        upsertBenchmark.run({
          model_id: canonicalId, benchmark: benchName, source: 'zeroeval', score: v,
          measured_at: now, source_url: null, is_preferred: 0,
        });
        count++;
      }
    }
  });
  tx();
  return count;
}

function updateCacheState(db: Database, source: string, status: string, error: string | undefined, count: number): void {
  const now = new Date();
  const next = new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString();
  db.prepare(`
    INSERT INTO catalog_cache_state (source, last_fetch, last_status, last_error, count, next_refresh)
    VALUES (@source, @last_fetch, @last_status, @last_error, @count, @next_refresh)
    ON CONFLICT(source) DO UPDATE SET
      last_fetch=@last_fetch, last_status=@last_status, last_error=@last_error, count=@count, next_refresh=@next_refresh
  `).run({
    source, last_fetch: now.toISOString(), last_status: status,
    last_error: error ?? null, count, next_refresh: next,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/catalog/benchmarks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/catalog/types.ts src/catalog/benchmarks.ts tests/catalog/benchmarks.test.ts
git commit -m "feat(catalog): modelbench + zeroeval benchmark sync with dedup + preferred flags"
```

---

## Task 10: Cache state + 30-day cron refresh

**Files:**
- Create: `src/catalog/cache.ts`
- Create: `src/catalog/cron.ts`
- Modify: `src/dashboard-server/server.ts` (wire boot sync + cron start)
- Create: `tests/catalog/cache.test.ts`

**Interfaces:**
- Produces: `isStale(db, source): boolean`, `getCacheStates(db): CatalogCacheStateRow[]`, `ensureFresh(db, source)` triggers sync if stale. `startCatalogCron()` schedules `setInterval` to refresh all sources every 30 days.

- [ ] **Step 1: Write the failing test**

Create `tests/catalog/cache.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { isStale, getCacheStates } from '../../src/catalog/cache.js';

function freshDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cache-'));
  initDb(path.join(tmp, 'test.db'));
  return () => fs.rmSync(tmp, { recursive: true, force: true });
}

test('isStale returns true when no cache_state row exists', () => {
  const cleanup = freshDb();
  try {
    assert.equal(isStale(getDb(), 'models.dev'), true);
  } finally {
    closeDb();
    cleanup();
  }
});

test('isStale returns false when next_refresh is in the future', () => {
  const cleanup = freshDb();
  try {
    const now = new Date();
    const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now.toISOString(), 'ok', future);
    assert.equal(isStale(getDb(), 'models.dev'), false);
  } finally {
    closeDb();
    cleanup();
  }
});

test('isStale returns true when next_refresh is in the past', () => {
  const cleanup = freshDb();
  try {
    const now = new Date();
    const past = new Date(now.getTime() - 1000).toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now.toISOString(), 'ok', past);
    assert.equal(isStale(getDb(), 'models.dev'), true);
  } finally {
    closeDb();
    cleanup();
  }
});

test('getCacheStates returns all cache rows', () => {
  const cleanup = freshDb();
  try {
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('models.dev', now, 'ok', now);
    getDb().prepare('INSERT INTO catalog_cache_state (source, last_fetch, last_status, next_refresh) VALUES (?, ?, ?, ?)').run('modelbench', now, 'ok', now);
    const states = getCacheStates(getDb());
    assert.equal(states.length, 2);
    assert.ok(states.some(s => s.source === 'models.dev'));
    assert.ok(states.some(s => s.source === 'modelbench'));
  } finally {
    closeDb();
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/catalog/cache.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Create src/catalog/cache.ts**

```typescript
import type { Database } from 'better-sqlite3';
import type { CatalogCacheStateRow } from '../db/schema.js';

export function isStale(db: Database, source: string): boolean {
  const row = db.prepare('SELECT next_refresh, last_status FROM catalog_cache_state WHERE source = ?').get(source) as { next_refresh: string; last_status: string } | undefined;
  if (!row) return true;
  return new Date(row.next_refresh).getTime() <= Date.now();
}

export function getCacheStates(db: Database): CatalogCacheStateRow[] {
  return db.prepare('SELECT * FROM catalog_cache_state ORDER BY source').all() as CatalogCacheStateRow[];
}

export async function ensureFresh(source: 'models.dev' | 'modelbench' | 'zeroeval'): Promise<void> {
  const { getDb } = await import('../db/client.js');
  const db = getDb();
  if (!isStale(db, source)) return;
  if (source === 'models.dev') {
    const { fetchSync } = await import('./sync.js');
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
  } else {
    const { fetchBenchmarks } = await import('./benchmarks.js');
    await fetchBenchmarks(source, { force: true });
  }
}
```

- [ ] **Step 4: Create src/catalog/cron.ts**

```typescript
import type { Logger } from '../types.js';
import { ensureFresh } from './cache.js';

const REFRESH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCES = ['models.dev', 'modelbench', 'zeroeval'] as const;

let timer: NodeJS.Timeout | null = null;

export function startCatalogCron(logger?: Logger): void {
  if (timer) return;
  timer = setInterval(async () => {
    for (const source of SOURCES) {
      try {
        await ensureFresh(source);
      } catch (err) {
        logger?.error('catalog cron refresh failed', { source, err: err instanceof Error ? err.message : String(err) });
      }
    }
  }, REFRESH_INTERVAL_MS);
  logger?.info('catalog cron started', { intervalMs: REFRESH_INTERVAL_MS });
}

export function stopCatalogCron(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
```

- [ ] **Step 5: Wire boot sync + cron in src/dashboard-server/server.ts**

Add imports near top (after existing imports):

```typescript
import path from 'node:path';
import { initDb } from '../db/client.js';
import { ensureFresh } from '../catalog/cache.js';
import { startCatalogCron } from '../catalog/cron.js';
```

Note: `path` is already imported. Add the other two.

In `start()` function, before `const app = express();` add:

```typescript
  const dbPath = path.join(root, 'outputs', 'arena.db');
  initDb(dbPath);
  logger.info('SQLite catalog DB initialized', { dbPath });

  // Boot: block on stale catalog sources
  for (const source of ['models.dev', 'modelbench', 'zeroeval'] as const) {
    try {
      await ensureFresh(source);
    } catch (err) {
      logger.warn('Boot catalog sync failed (continuing with stale data)', { source, err: err instanceof Error ? err.message : String(err) });
    }
  }
  startCatalogCron(logger);
```

Also make `start()` `async` (change signature from `function start(): void` to `async function start(): Promise<void>`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/catalog/cache.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/catalog/cache.ts src/catalog/cron.ts src/dashboard-server/server.ts tests/catalog/cache.test.ts
git commit -m "feat(catalog): cache state + 30-day cron refresh + boot sync wiring"
```
---

## Task 11: Runtime metrics writeback (arena run -> model_runtime_stats)

**Files:**
- Create: `src/metrics/runtime.ts`
- Create: `src/metrics/writeback.ts`
- Modify: `src/orchestrator/run-lifecycle.ts` (call `writeRunStats` on finalize)
- Create: `tests/metrics/writeback.test.ts`

**Interfaces:**
- Produces: `aggregateLatency(spans): { p50, p95 }`, `computeTps(spans, usage): number`, `writeRunStats(runId, root): Promise<void>` reads `outputs/<model>/<runId>/{trace-meta.json, result.json}` and upserts `model_runtime_stats`.

- [ ] **Step 1: Write the failing test**

Create `tests/metrics/writeback.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { writeRunStats } from '../../src/metrics/writeback.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
};

function mockFetch(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'nf' } as unknown as Response;
  }) as typeof fetch;
}

test('writeRunStats upserts model_runtime_stats row from trace-meta + result.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-wb-'));
  const dbPath = path.join(tmp, 'test.db');
  initDb(dbPath);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });

    // Simulate run output dir structure: outputs/gpt-4o/<runId>/
    const runId = 'scenario_2026-07-20T00_00_00Z';
    const modelDir = path.join(tmp, 'outputs', 'gpt-4o', runId);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'result.json'), JSON.stringify({
      model: 'gpt-4o', scenario: 'scenario', runId,
      startedAt: '2026-07-20T00:00:00.000Z', finishedAt: '2026-07-20T00:00:05.000Z',
      durationMs: 5000, turnsUsed: 2, maxTurns: 20, totalToolCalls: 1, toolsCalled: [{ name: 'read_file', count: 1 }],
      tokenUsage: { prompt: 1000, completion: 500, total: 1500, cacheReadTokens: 600 },
      stopReason: 'stop', errors: [], success: true, costUsd: 0.0075,
    }));
    fs.writeFileSync(path.join(modelDir, 'trace-meta.json'), JSON.stringify({
      traceId: 't1', spans: [
        { spanId: 's1', name: 'chat', kind: 'internal', startTime: 0, endTime: 1500, attributes: { model: 'gpt-4o' } },
        { spanId: 's2', name: 'chat', kind: 'internal', startTime: 1500, endTime: 3000, attributes: { model: 'gpt-4o' } },
        { spanId: 's3', name: 'execute_tool', kind: 'internal', startTime: 3000, endTime: 3500, attributes: { tool: 'read_file' } },
        { spanId: 's4', name: 'chat', kind: 'internal', startTime: 3500, endTime: 5000, attributes: { model: 'gpt-4o' } },
      ],
    }));

    await writeRunStats(runId, tmp);

    const rows = getDb().prepare('SELECT * FROM model_runtime_stats WHERE run_id = ?').all(runId) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.success, 1);
    assert.equal(row.cost_usd, 0.0075);
    assert.ok(row.tps, 'tps should be set');
    assert.ok(row.cache_hit_rate, 'cache_hit_rate should be set');
    assert.equal(row.cache_read_tokens, 600);
    assert.equal(row.latency_p50_ms, 1500); // median of [1500, 1500, 3000] chat durations
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/metrics/writeback.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Create src/metrics/runtime.ts**

```typescript
interface Span {
  spanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  attributes?: Record<string, unknown>;
}

export function aggregateLatency(spans: Span[], filterName?: string): { p50: number | null; p95: number | null } {
  const filtered = (filterName ? spans.filter(s => s.name === filterName) : spans);
  const durations = filtered.map(s => s.endTime - s.startTime).sort((a, b) => a - b);
  if (durations.length === 0) return { p50: null, p95: null };
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  return { p50, p95 };
}

export function computeTps(spans: Span[], completionTokens: number): number | null {
  if (completionTokens <= 0) return null;
  const chatSpans = spans.filter(s => s.name === 'chat');
  if (chatSpans.length === 0) return null;
  const firstStart = Math.min(...chatSpans.map(s => s.startTime));
  const lastEnd = Math.max(...chatSpans.map(s => s.endTime));
  const durationMs = lastEnd - firstStart;
  if (durationMs <= 0) return null;
  return (completionTokens / durationMs) * 1000;
}
```

- [ ] **Step 4: Create src/metrics/writeback.ts**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/client.js';
import { aggregateLatency, computeTps } from './runtime.js';
import { extractCacheMetrics } from './cache-metrics.js';
import { matchModelToCanonical, type CatalogEntry } from '../catalog/match.js';
import type { ModelRow } from '../db/schema.js';

interface TraceMeta {
  spans: Array<{ spanId?: string; name: string; startTime: number; endTime: number; attributes?: Record<string, unknown> }>;
}

interface RunResult {
  model: string;
  runId: string;
  durationMs: number;
  tokenUsage?: { prompt?: number; completion?: number; total?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  costUsd?: number;
  success: boolean;
}

export async function writeRunStats(runId: string, root: string): Promise<void> {
  const db = getDb();
  const outputsDir = path.join(root, 'outputs');

  // Find the run's model dir
  const modelDirs = fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir) : [];
  let resultPath: string | null = null;
  let tracePath: string | null = null;
  let modelName: string | null = null;
  for (const dir of modelDirs) {
    const candidate = path.join(outputsDir, dir, runId);
    const r = path.join(candidate, 'result.json');
    if (fs.existsSync(r)) {
      resultPath = r;
      tracePath = path.join(candidate, 'trace-meta.json');
      modelName = dir;
      break;
    }
  }
  if (!resultPath || !modelName) return;

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as RunResult;
  const trace: TraceMeta = fs.existsSync(tracePath)
    ? JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceMeta
    : { spans: [] };

  const catalog = db.prepare('SELECT id, name, provider_id FROM models').all() as CatalogEntry[];
  const canonicalId = matchModelToCanonical(result.model, undefined, catalog) ?? matchModelToCanonical(undefined, undefined, catalog, result.model);
  if (!canonicalId) return;

  const spans = trace.spans ?? [];
  const { p50, p95 } = aggregateLatency(spans, 'chat');
  const completionTokens = result.tokenUsage?.completion ?? 0;
  const tps = computeTps(spans, completionTokens);
  const cache = extractCacheMetrics(result.tokenUsage ?? {});

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO model_runtime_stats (model_id, run_id, latency_p50_ms, latency_p95_ms, tps, ttft_ms, cache_hit_rate, cache_read_tokens, cache_write_tokens, cost_usd, success, measured_at)
    VALUES (@model_id, @run_id, @latency_p50_ms, @latency_p95_ms, @tps, NULL, @cache_hit_rate, @cache_read_tokens, @cache_write_tokens, @cost_usd, @success, @measured_at)
    ON CONFLICT(model_id, run_id) DO UPDATE SET
      latency_p50_ms=@latency_p50_ms, latency_p95_ms=@latency_p95_ms, tps=@tps,
      cache_hit_rate=@cache_hit_rate, cache_read_tokens=@cache_read_tokens, cache_write_tokens=@cache_write_tokens,
      cost_usd=@cost_usd, success=@success, measured_at=@measured_at
  `).run({
    model_id: canonicalId, run_id: runId,
    latency_p50_ms: p50, latency_p95_ms: p95, tps,
    cache_hit_rate: cache.cacheHitRate,
    cache_read_tokens: cache.cacheReadTokens,
    cache_write_tokens: cache.cacheWriteTokens,
    cost_usd: result.costUsd ?? null,
    success: result.success ? 1 : 0,
    measured_at: now,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/metrics/writeback.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Wire writeRunStats into run finalization**

In `src/orchestrator/run-lifecycle.ts`, add import near top:

```typescript
import { writeRunStats } from '../metrics/writeback.js';
```

In `finalizeRunByRunId` (after the comparison aggregation, before the function returns), add:

```typescript
  try {
    await writeRunStats(runId, root);
  } catch (err) {
    logger?.warn('writeRunStats failed (non-fatal)', { runId, err: err instanceof Error ? err.message : String(err) });
  }
```

Look for the existing `finalizeRunByRunId` function signature. If it is not `async`, make it `async` and ensure callers `await` it (the existing `LiveHub.finalizeRuns` polling loop already calls it; check it uses `await`).

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/metrics/runtime.ts src/metrics/writeback.ts src/orchestrator/run-lifecycle.ts tests/metrics/writeback.test.ts
git commit -m "feat(metrics): runtime stats writeback from trace-meta + result.json"
```

---

## Task 12: Dashboard catalog + metrics + cache routes

**Files:**
- Create: `src/dashboard-server/routes/catalog.ts` (models, providers list, benchmarks, pricing)
- Create: `src/dashboard-server/routes/metrics.ts` (runtime, tps)
- Create: `src/dashboard-server/routes/cache.ts` (stats, refresh, leaderboard)
- Modify: `src/dashboard-server/server.ts` (mount all three routers, JWT + API-key)
- Modify: `openapi.yaml` (add new paths)

**Interfaces:**
- Produces: `createCatalogRouter()`, `createMetricsRouter()`, `createCacheRouter()` Express routers.

- [ ] **Step 1: Create src/dashboard-server/routes/catalog.ts**

```typescript
import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createCatalogRouter(): Router {
  const router = Router();

  // GET /api/models?provider=&reasoning=&tool_call=&min_context=&sort=
  router.get('/models', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.provider === 'string') { where.push('m.provider_id = @provider'); params.provider = req.query.provider; }
    if (req.query.reasoning === '1') where.push('m.reasoning = 1');
    if (req.query.tool_call === '1') where.push('m.tool_call = 1');
    if (req.query.min_context) { where.push('m.context_limit >= @min_context'); params.min_context = Number(req.query.min_context); }
    const sort = req.query.sort === 'context' ? 'm.context_limit DESC' : req.query.sort === 'name' ? 'm.name ASC' : 'm.name ASC';
    const sql = `
      SELECT m.id, m.name, m.family, m.provider_id, m.release_date, m.attachment, m.reasoning, m.temperature,
        m.tool_call, m.context_limit, m.output_limit, m.status, m.reasoning_options,
        p.input, p.output, p.cache_read, p.cache_write
      FROM models m LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${sort}
    `;
    const rows = db.prepare(sql).all(params);
    res.json({ data: rows });
  });

  router.get('/models/:id', (req, res) => {
    const db = getDb();
    const model = db.prepare(`
      SELECT m.*, p.input, p.output, p.cache_read, p.cache_write, p.tier_size
      FROM models m LEFT JOIN pricing p ON p.model_id = m.id
      WHERE m.id = ?
    `).get(req.params.id);
    if (!model) { res.status(404).json({ error: 'Model not found' }); return; }
    const benchmarks = db.prepare('SELECT benchmark, source, score, measured_at, source_url, is_preferred FROM benchmarks WHERE model_id = ? ORDER BY benchmark').all(req.params.id);
    const runtime = db.prepare('SELECT run_id, latency_p50_ms, latency_p95_ms, tps, ttft_ms, cache_hit_rate, cost_usd, success, measured_at FROM model_runtime_stats WHERE model_id = ? ORDER BY measured_at DESC LIMIT 50').all(req.params.id);
    res.json({ model, benchmarks, runtime });
  });

  router.get('/benchmarks', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.name === 'string') { where.push('benchmark = @name'); params.name = req.query.name; }
    if (typeof req.query.source === 'string') { where.push('source = @source'); params.source = req.query.source; }
    if (typeof req.query.model === 'string') { where.push('model_id = @model'); params.model = req.query.model; }
    const sql = `SELECT * FROM benchmarks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY benchmark, score DESC`;
    res.json({ data: db.prepare(sql).all(params) });
  });

  router.get('/benchmarks/:modelId', (req, res) => {
    const db = getDb();
    res.json({ data: db.prepare('SELECT * FROM benchmarks WHERE model_id = ? ORDER BY benchmark').all(req.params.modelId) });
  });

  router.get('/pricing', (req, res) => {
    const db = getDb();
    const where = typeof req.query.model === 'string' ? 'WHERE model_id = ?' : '';
    const params = typeof req.query.model === 'string' ? [req.query.model] : [];
    res.json({ data: db.prepare(`SELECT * FROM pricing ${where} ORDER BY model_id`).all(...params) });
  });

  return router;
}
```

- [ ] **Step 2: Create src/dashboard-server/routes/metrics.ts**

```typescript
import { Router } from 'express';
import { getDb } from '../../db/client.js';

export function createMetricsRouter(): Router {
  const router = Router();

  // GET /api/metrics/runtime?model=&from=&to=&limit=
  router.get('/runtime', (req, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (typeof req.query.model === 'string') { where.push('model_id = @model'); params.model = req.query.model; }
    if (typeof req.query.from === 'string') { where.push('measured_at >= @from'); params.from = req.query.from; }
    if (typeof req.query.to === 'string') { where.push('measured_at <= @to'); params.to = req.query.to; }
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const sql = `SELECT * FROM model_runtime_stats ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY measured_at DESC LIMIT ${limit}`;
    res.json({ data: db.prepare(sql).all(params) });
  });

  // GET /api/metrics/tps — leaderboard joining catalog + arena measurements
  router.get('/tps', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id as model_id, m.name, m.provider_id,
        AVG(r.tps) as avg_tps, MAX(r.tps) as max_tps,
        AVG(r.latency_p50_ms) as avg_latency_p50,
        AVG(r.cache_hit_rate) as avg_cache_hit_rate,
        COUNT(r.run_id) as run_count
      FROM models m
      LEFT JOIN model_runtime_stats r ON r.model_id = m.id
      GROUP BY m.id
      HAVING run_count > 0
      ORDER BY avg_tps DESC
    `).all();
    res.json({ data: rows });
  });

  return router;
}
```

- [ ] **Step 3: Create src/dashboard-server/routes/cache.ts**

```typescript
import { Router } from 'express';
import { getDb } from '../../db/client.js';
import { getCacheStates } from '../../catalog/cache.js';

export function createCacheRouter(): Router {
  const router = Router();

  router.get('/stats', (_req, res) => {
    res.json({ data: getCacheStates(getDb()) });
  });

  router.get('/leaderboard', (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT m.id, m.name, m.provider_id, m.context_limit,
        p.input, p.output, p.cache_read,
        (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Intelligence Index') as intelligence,
        (SELECT score FROM benchmarks b WHERE b.model_id = m.id AND b.is_preferred = 1 AND b.benchmark = 'Coding Score') as coding,
        (SELECT AVG(r.tps) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_tps,
        (SELECT AVG(r.latency_p50_ms) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_latency,
        (SELECT COUNT(*) FROM model_runtime_stats r WHERE r.model_id = m.id) as arena_runs
      FROM models m
      LEFT JOIN pricing p ON p.model_id = m.id AND p.tier_size IS NULL
      ORDER BY intelligence DESC
    `).all();
    res.json({ data: rows });
  });

  router.post('/refresh', async (req, res) => {
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    if (!source || !['models.dev', 'modelbench', 'zeroeval'].includes(source)) {
      res.status(400).json({ error: 'source must be one of: models.dev, modelbench, zeroeval' });
      return;
    }
    try {
      if (source === 'models.dev') {
        const { fetchSync } = await import('../../catalog/sync.js');
        const result = await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
        res.json(result);
      } else {
        const { fetchBenchmarks } = await import('../../catalog/benchmarks.js');
        const result = await fetchBenchmarks(source as 'modelbench' | 'zeroeval', { force: true });
        res.json(result);
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
```

- [ ] **Step 4: Mount routers in src/dashboard-server/server.ts**

Add imports (after the providers router import):

```typescript
import { createCatalogRouter } from './routes/catalog.js';
import { createMetricsRouter } from './routes/metrics.js';
import { createCacheRouter } from './routes/cache.js';
```

Add JWT-protected routes (after `app.use('/api/providers', requireAuth(auth), createProvidersRouter());`):

```typescript
  app.use('/api/catalog', requireAuth(auth), createCatalogRouter());
  app.use('/api/metrics', requireAuth(auth), createMetricsRouter());
  app.use('/api/cache', requireAuth(auth), createCacheRouter());
```

Add API-key-protected routes (after the `/api/v1/providers` line):

```typescript
  app.use('/api/v1/catalog', requireApiKey(['catalog:read']), createCatalogRouter());
  app.use('/api/v1/metrics', requireApiKey(['metrics:read']), createMetricsRouter());
  app.use('/api/v1/cache', requireApiKey(['cache:read']), createCacheRouter());
```

- [ ] **Step 5: Extend openapi.yaml**

Append to `openapi.yaml` `paths:` block:

```yaml
  /api/models:
    get:
      summary: List catalog models
      tags: [Catalog]
      parameters:
        - { name: provider, in: query, schema: { type: string } }
        - { name: reasoning, in: query, schema: { type: string, enum: ['1', '0'] } }
        - { name: tool_call, in: query, schema: { type: string, enum: ['1', '0'] } }
        - { name: min_context, in: query, schema: { type: integer } }
        - { name: sort, in: query, schema: { type: string, enum: [name, context] } }
      responses:
        '200': { description: Model list }
  /api/models/{id}:
    get:
      summary: Full model detail (caps + pricing + benchmarks + runtime stats)
      tags: [Catalog]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: Model detail }
        '404': { description: Not found }
  /api/providers:
    get:
      summary: List all providers (builtin + custom)
      tags: [Catalog]
      responses: { '200': { description: Provider list } }
    post:
      summary: Add custom OpenAI-compatible provider
      tags: [Catalog]
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { id: {type: string}, name: {type: string}, apiBase: {type: string}, authScheme: {type: string}, envVar: {type: string}, adapter: {type: string} } } } } }
      responses: { '201': { description: Created } }
  /api/providers/{id}:
    delete:
      summary: Remove custom provider
      tags: [Catalog]
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: Deleted } }
  /api/benchmarks:
    get:
      summary: List benchmarks (filter by name/source/model)
      tags: [Catalog]
      parameters:
        - { name: name, in: query, schema: { type: string } }
        - { name: source, in: query, schema: { type: string } }
        - { name: model, in: query, schema: { type: string } }
      responses: { '200': { description: Benchmark list } }
  /api/benchmarks/{modelId}:
    get:
      summary: Benchmarks for one model
      tags: [Catalog]
      parameters: [{ name: modelId, in: path, required: true, schema: { type: string } }]
      responses: { '200': { description: Benchmarks } }
  /api/pricing:
    get:
      summary: Pricing table
      tags: [Catalog]
      parameters: [{ name: model, in: query, schema: { type: string } }]
      responses: { '200': { description: Pricing } }
  /api/metrics/runtime:
    get:
      summary: Arena-measured runtime stats
      tags: [Metrics]
      parameters:
        - { name: model, in: query, schema: { type: string } }
        - { name: from, in: query, schema: { type: string } }
        - { name: to, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, default: 100 } }
      responses: { '200': { description: Runtime stats } }
  /api/metrics/tps:
    get:
      summary: TPS leaderboard (arena measurements)
      tags: [Metrics]
      responses: { '200': { description: TPS leaderboard } }
  /api/cache/stats:
    get:
      summary: Cache state per source
      tags: [Cache]
      responses: { '200': { description: Cache states } }
  /api/cache/leaderboard:
    get:
      summary: Combined catalog benchmarks + arena measurements
      tags: [Cache]
      responses: { '200': { description: Leaderboard } }
  /api/cache/refresh:
    post:
      summary: Force refresh a catalog source
      tags: [Cache]
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { source: { type: string, enum: [models.dev, modelbench, zeroeval] } } } } } }
      responses: { '200': { description: Refresh result } }
```

- [ ] **Step 6: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Smoke-test the server boots**

Run: `npm run build`
Expected: PASS (TypeScript compiles).

- [ ] **Step 8: Commit**

```bash
git add src/dashboard-server/routes/catalog.ts src/dashboard-server/routes/metrics.ts src/dashboard-server/routes/cache.ts src/dashboard-server/server.ts openapi.yaml
git commit -m "feat(dashboard): catalog + metrics + cache API routes with OpenAPI spec"
```
---

## Task 13: Worker + orchestrator migration to ProviderRegistry

**Files:**
- Modify: `src/worker.ts` (replace `createAdapter` import from old `src/adapters/` with `ProviderRegistry.createAdapter`)
- Modify: `src/orchestrator/run-lifecycle.ts` (resolve model config from DB instead of `configs/models.yaml`)
- Create: `tests/worker/adapter-wiring.test.ts`

**Interfaces:**
- Consumes: `ProviderRegistry`, `initDb`, `getDb`, `models` table.
- Produces: `resolveModelForRun(friendlyName: string): ResolvedModel | null` exported from `src/worker.ts`. Returns `{ canonicalId, providerId, apiModelId, adapterKind, envVar, contextLimit, maxTurns, temperature, maxTokens }`.

- [ ] **Step 1: Read current worker.ts adapter construction**

Run: `Read src/worker.ts` lines 137-245.
Confirm the current path: `findModel()` from `src/config.ts` returns `ModelConfig` (name, provider, model, apiKeyEnv, baseUrl, maxTurns, temperature, maxTokens, retry). Worker calls `createAdapter(modelCfg, logger)` from `src/adapters/index.js`.

- [ ] **Step 2: Write the failing test**

Create `tests/worker/adapter-wiring.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../src/db/client.js';
import { fetchSync } from '../../src/catalog/sync.js';
import { resolveModelForRun } from '../../src/worker.js';

const MODELS_DEV = {
  openai: { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {
    'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', attachment: true, reasoning: false, temperature: true, tool_call: true, cost: { input: 2.5, output: 10 }, limit: { context: 128000, output: 16384 } },
  } },
  anthropic: { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {
    'claude-3-7-sonnet-20250219': { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', attachment: false, reasoning: true, temperature: true, tool_call: true, cost: { input: 3, output: 15 }, limit: { context: 200000, output: 8192 } },
  } },
};

function mockFetch(urlMap: Record<string, () => unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = String(input);
    for (const [key, factory] of Object.entries(urlMap)) {
      if (u.includes(key)) return { status: 200, ok: true, json: async () => factory(), text: async () => JSON.stringify(factory()) } as unknown as Response;
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => 'nf' } as unknown as Response;
  }) as typeof fetch;
}

test('resolveModelForRun finds model by friendly name in DB', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    const resolved = resolveModelForRun('GPT-4o');
    assert.ok(resolved);
    assert.equal(resolved!.providerId, 'openai');
    assert.equal(resolved!.apiModelId, 'gpt-4o');
    assert.equal(resolved!.canonicalId, 'openai/gpt-4o');
    assert.equal(resolved!.envVar, 'OPENAI_API_KEY');
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveModelForRun returns null for unknown model', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-worker-'));
  initDb(path.join(tmp, 'test.db'));
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch({ 'models.dev/api.json': () => MODELS_DEV });
  try {
    await fetchSync('models.dev', { apiUrl: 'https://models.dev/api.json', force: true });
    assert.equal(resolveModelForRun('nonexistent-model'), null);
  } finally {
    globalThis.fetch = origFetch;
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test tests/worker/adapter-wiring.test.ts`
Expected: FAIL - `resolveModelForRun` not exported from `src/worker.ts`.

- [ ] **Step 4: Add resolveModelForRun + registry wiring to src/worker.ts**

In `src/worker.ts`:

Add imports near top (replacing the old `import { createAdapter } from '../adapters/index.js';` line):

```typescript
import path from 'node:path';
import { initDb, getDb } from '../db/client.js';
import { ProviderRegistry, loadBuiltins } from '../providers/index.js';
import type { ModelRow, ProviderRow } from '../db/schema.js';
```

Add the `resolveModelForRun` exported function (above `main()`):

```typescript
export interface ResolvedModel {
  canonicalId: string;
  providerId: string;
  apiModelId: string;
  adapterKind: ProviderRow['adapter'];
  envVar: string | null;
  contextLimit: number | null;
  maxTurns: number;
  temperature: number;
  maxTokens: number;
}

export function resolveModelForRun(friendlyName: string): ResolvedModel | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.*, mp.api_model_id, p.env_var, p.adapter as provider_adapter
    FROM models m
    JOIN model_providers mp ON mp.model_id = m.id
    JOIN providers p ON p.id = m.provider_id
    WHERE m.name = ? OR m.id = ?
    LIMIT 1
  `).get(friendlyName, friendlyName) as (ModelRow & { api_model_id: string; env_var: string | null; provider_adapter: string }) | undefined;
  if (!row) return null;
  return {
    canonicalId: row.id,
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    adapterKind: row.provider_adapter as ProviderRow['adapter'],
    envVar: row.env_var,
    contextLimit: row.context_limit,
    maxTurns: 20,
    temperature: 0.2,
    maxTokens: row.output_limit ?? 4096,
  };
}
```

In `main()`, replace the adapter construction block (find `createAdapter(modelCfg, ...)`) with:

```typescript
  const root = findProjectRoot();
  initDb(path.join(root, 'outputs', 'arena.db'));
  const resolved = resolveModelForRun(process.env.AI_ARENA_MODEL ?? '');
  if (!resolved) {
    logger.error('Model not found in catalog', { model: process.env.AI_ARENA_MODEL });
    // ... existing fatal_error result.json write path ...
    process.exit(0);
  }
  const apiKey = resolved.envVar ? process.env[resolved.envVar] : undefined;
  const registry = new ProviderRegistry();
  loadBuiltins(registry);
  registry.loadCustomFromDb(getDb());
  const adapter = registry.createAdapter(resolved.providerId, resolved.apiModelId, { apiKey, logger });
```

Replace the old `findModel()` + `createAdapter(modelCfg, ...)` call with this block. Keep the existing `runAgentLoopTraced(adapter, ...)` call downstream unchanged.

Update the `runAgentLoop` call site to use `resolved.maxTurns`, `resolved.temperature`, `resolved.maxTokens` instead of the old `modelCfg.maxTurns` etc.

- [ ] **Step 5: Update orchestrator run-lifecycle.ts model validation**

In `src/orchestrator/run-lifecycle.ts`, find `createRunSpec` (around line 87-123). It currently validates each model name against `models.yaml` via `findModel()`.

Add imports:

```typescript
import { resolveModelForRun } from '../worker.js';
```

In `createRunSpec`, replace the `findModel(modelName)` validation with:

```typescript
    const resolved = resolveModelForRun(modelName);
    if (!resolved) {
      throw new Error(`Model not found in catalog: ${modelName}. Run catalog sync first.`);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test tests/worker/adapter-wiring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/worker.ts src/orchestrator/run-lifecycle.ts tests/worker/adapter-wiring.test.ts
git commit -m "feat(worker): resolve models from SQLite catalog + ProviderRegistry.createAdapter"
```

---

## Task 14: Delete legacy adapters + YAML configs

**Files:**
- Delete: `src/adapters/` (entire directory)
- Delete: `configs/models.yaml`
- Delete: `configs/pricing.yaml`
- Modify: `src/config.ts` (remove `loadModelsConfig`, `findModel`, `ModelConfigSchema`)
- Modify: `src/cost-tracking/pricing.ts` (read pricing from SQLite instead of `configs/pricing.yaml`)

- [ ] **Step 1: Find all remaining references to old adapters**

Run: `grep -rn "from '../adapters" src/ tests/` and `grep -rn "loadModelsConfig\|findModel\|ModelConfigSchema" src/ tests/`
Expected: after Task 13, only `src/config.ts` and `src/cost-tracking/pricing.ts` should still reference them.

- [ ] **Step 2: Update cost-tracking to read from SQLite**

In `src/cost-tracking/pricing.ts`, replace the YAML loading with a DB lookup:

```typescript
import { getDb } from '../db/client.js';

export function getModelPricing(modelId: string): { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | null {
  try {
    const row = getDb().prepare('SELECT input, output, cache_read, cache_write FROM pricing WHERE model_id = ? AND tier_size IS NULL').get(modelId) as { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}
```

If `pricing.ts` exports a `loadPricingConfig` function, keep its signature but make it a no-op returning an empty object (or remove it if no callers remain).

- [ ] **Step 3: Delete old adapter directory**

```bash
git rm -r src/adapters/
```

- [ ] **Step 4: Delete old YAML configs**

```bash
git rm configs/models.yaml configs/pricing.yaml
```

- [ ] **Step 5: Update src/config.ts**

Remove `ModelConfigSchema`, `ModelsConfigSchema`, `loadModelsConfig`, `findModel` exports. Keep `ScenarioConfigSchema`, `loadScenariosConfig`, `findScenario` - those are still used.

If `loadPricingConfig` is still exported and used elsewhere (e.g. `run-lifecycle.ts` for budget checks), replace those callers with `getModelPricing(canonicalId)` calls.

Run: `grep -rn "loadPricingConfig\|pricing.yaml" src/`
Update each caller to use `getModelPricing()` from `src/cost-tracking/pricing.ts`.

- [ ] **Step 6: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS (no broken imports).

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: remove legacy src/adapters/ + configs/models.yaml + configs/pricing.yaml; pricing now from SQLite"
```

---

## Task 15: End-to-end smoke test

**Files:**
- No new source files. This task validates the full system end-to-end.

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 2: Start the dashboard server**

Run: `npm run dashboard:start` (in one terminal; or background it)
Expected: Server boots, logs "SQLite catalog DB initialized", fetches models.dev (first boot), logs "Dashboard running at http://localhost:4000".

- [ ] **Step 3: Verify catalog API returns data**

Run: `curl -s http://localhost:4000/api/models | head -c 500`
Expected: JSON with `data` array containing models from models.dev.

Run: `curl -s "http://localhost:4000/api/benchmarks?name=SWE-bench" | head -c 500`
Expected: JSON with benchmark rows.

Run: `curl -s http://localhost:4000/api/cache/stats`
Expected: JSON with `catalog_cache_state` rows for `models.dev`, `modelbench`, `zeroeval`.

- [ ] **Step 4: Verify OpenAPI docs include new endpoints**

Open: `http://localhost:4000/openapi` in a browser.
Expected: Swagger UI shows `/api/models`, `/api/models/{id}`, `/api/providers`, `/api/benchmarks`, `/api/pricing`, `/api/metrics/runtime`, `/api/metrics/tps`, `/api/cache/stats`, `/api/cache/leaderboard`, `/api/cache/refresh`.

- [ ] **Step 5: Trigger a single-model run via the API**

Run: `curl -s -X POST http://localhost:4000/api/runs -H "Content-Type: application/json" -H "Authorization: Bearer <jwt>" -d "{\"scenario\":\"express-rest\",\"models\":[\"GPT-4o\"]}"`
Expected: 201 with `runId`.

Wait for the run to finalize (poll `GET /api/runs/:runId`).

- [ ] **Step 6: Verify runtime metrics written back**

Run: `curl -s http://localhost:4000/api/metrics/runtime | head -c 500`
Expected: At least one row in `model_runtime_stats` for the model just run.

Run: `curl -s http://localhost:4000/api/metrics/tps | head -c 500`
Expected: TPS leaderboard with at least one entry.

- [ ] **Step 7: Verify cache refresh endpoint**

Run: `curl -s -X POST http://localhost:4000/api/cache/refresh -H "Content-Type: application/json" -H "Authorization: Bearer <jwt>" -d "{\"source\":\"models.dev\"}"`
Expected: 200 with `{ ok: true, count: N }`.

- [ ] **Step 8: Commit any doc/test fixes discovered during smoke test**

```bash
git add -A
git commit -m "test: e2e smoke validation of catalog + metrics + run pipeline"
```

If no fixes needed, skip the commit.

---

## Self-Review

**Spec coverage:**
- Provider plugin registry (4 adapter classes, ~20 built-in providers, custom OpenAI-compatible) -> Task 2, 4, 5, 6, 7.
- models.dev sync with capabilities, reasoning_options, limits, cost, modalities -> Task 8.
- modelbench + zeroeval benchmark sync with dedup + is_preferred flag -> Task 9.
- Pricing from models.dev (not separate YAML) -> Task 8 (upserts pricing table).
- 30-day cache TTL + first-request lazy refresh + cron -> Task 10.
- Token caching (provider prompt caching) + cache metrics (cacheReadTokens, cacheWriteTokens, cacheHitRate) -> Task 3 (types + extractCacheMetrics), Task 4 (OpenAI cached_tokens), Task 5 (Anthropic cache_read_input_tokens + cache_control breakpoints), Task 6 (Google cachedContentTokenCount).
- Arena runtime metrics writeback (latency p50/p95, TPS, cache_hit_rate, cost, success) -> Task 11.
- All catalog + metrics data exposed via OpenAPI endpoints -> Task 12.
- Delete old adapters + YAML -> Task 14.

**Placeholder scan:** No "TBD", "TODO", "implement later", "similar to Task N" found. Each step has complete code.

**Type consistency:** `resolveModelForRun` returns `ResolvedModel` with `providerId`, `apiModelId`, `canonicalId`, `envVar` - consistent across Task 13 worker + orchestrator. `SyncResult` shape `{ source, ok, count, error? }` consistent across Task 8 (sync.ts), Task 9 (benchmarks.ts), Task 12 (cache.ts refresh route). `extractCacheMetrics` returns `{ cacheReadTokens, cacheWriteTokens, cacheHitRate }` consistent across Task 3, Task 11 (writeback). `fetchSync('models.dev', opts)` and `fetchBenchmarks(source, opts)` signatures consistent across Tasks 8-12.

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

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

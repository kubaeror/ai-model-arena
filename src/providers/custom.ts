import type { ProviderRow } from '../db/schema.js';
import { getDrizzleDb } from '../db/index.js';
import { providers } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface CustomProviderInput {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  envVar?: string;
  headerName?: string;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
}

export async function upsertCustomProvider(input: CustomProviderInput): Promise<void> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.insert(providers).values({
    id: input.id, name: input.name,
    api_base: input.apiBase ?? null,
    auth_scheme: input.authScheme,
    env_var: input.envVar ?? null,
    is_builtin: 0, adapter: input.adapter,
    header_name: input.headerName ?? null,
    created_at: now, updated_at: now,
  }).onConflictDoUpdate({
    target: providers.id,
    set: {
      name: input.name, api_base: input.apiBase ?? null,
      auth_scheme: input.authScheme, env_var: input.envVar ?? null,
      adapter: input.adapter, header_name: input.headerName ?? null,
      updated_at: now,
    },
  });
}

export async function listCustomProviders(): Promise<ProviderRow[]> {
  const db = getDrizzleDb();
  return db.select().from(providers).where(eq(providers.is_builtin, 0)).orderBy(providers.id) as any;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(providers).where(and(eq(providers.id, id), eq(providers.is_builtin, 0)));
}

import type { ProviderRow } from '../db/schema.js';
import { getDrizzleDb } from '../db/index.js';
import { providers, provider_versions, model_providers } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import crypto from 'node:crypto';

interface CustomProviderInput {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  envVar?: string;
  headerName?: string;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
}

export async function upsertCustomProvider(
  input: CustomProviderInput,
  createdBy = 'system',
): Promise<void> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();

  // Get current version number
  const currentVersions = await db
    .select({ version: provider_versions.version })
    .from(provider_versions)
    .where(eq(provider_versions.provider_id, input.id))
    .orderBy(desc(provider_versions.version))
    .limit(1);
  const nextVersion = (currentVersions[0]?.version ?? 0) + 1;

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

  // Save immutable version snapshot
  await db.insert(provider_versions).values({
    id: crypto.randomUUID(),
    provider_id: input.id,
    version: nextVersion,
    name: input.name,
    api_base: input.apiBase ?? null,
    auth_scheme: input.authScheme,
    env_var: input.envVar ?? null,
    adapter: input.adapter,
    header_name: input.headerName ?? null,
    created_by: createdBy,
    created_at: now,
  });
}

export async function listCustomProviders(): Promise<ProviderRow[]> {
  const db = getDrizzleDb();
  return db.select().from(providers).where(eq(providers.is_builtin, 0)).orderBy(providers.id) as any;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const db = getDrizzleDb();
  await db.delete(provider_versions).where(eq(provider_versions.provider_id, id));
  await db.delete(model_providers).where(eq(model_providers.provider_id, id));
  await db.delete(providers).where(and(eq(providers.id, id), eq(providers.is_builtin, 0)));
}

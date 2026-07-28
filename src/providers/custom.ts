import type { ProviderRow } from '../db/schema.js';
import { getDrizzleDb } from '../db/index.js';
import { providers, provider_versions } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import crypto from 'node:crypto';

export interface CustomProviderInput {
  id: string;
  name: string;
  apiBase?: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  envVar?: string;
  headerName?: string;
  adapter: 'openai-compat' | 'anthropic' | 'google' | 'bedrock';
}

export interface CustomProviderVersion {
  id: string;
  providerId: string;
  version: number;
  name: string;
  apiBase: string | null;
  authScheme: string;
  envVar: string | null;
  adapter: string;
  headerName: string | null;
  createdBy: string;
  createdAt: string;
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
  await db.delete(providers).where(and(eq(providers.id, id), eq(providers.is_builtin, 0)));
}

export async function listCustomProviderVersions(providerId: string): Promise<CustomProviderVersion[]> {
  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(provider_versions)
    .where(eq(provider_versions.provider_id, providerId))
    .orderBy(desc(provider_versions.version));
  return rows.map((r: typeof rows[number]) => ({
    id: r.id,
    providerId: r.provider_id,
    version: r.version,
    name: r.name,
    apiBase: r.api_base,
    authScheme: r.auth_scheme,
    envVar: r.env_var,
    adapter: r.adapter,
    headerName: r.header_name,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export async function getProviderVersion(providerId: string, version: number): Promise<ProviderRow | null> {
  const db = getDrizzleDb();
  const rows = await db
    .select({
      id: provider_versions.provider_id,
      name: provider_versions.name,
      api_base: provider_versions.api_base,
      auth_scheme: provider_versions.auth_scheme,
      env_var: provider_versions.env_var,
      adapter: provider_versions.adapter,
      header_name: provider_versions.header_name,
      is_builtin: sql<number>`0`,
      created_at: provider_versions.created_at,
      updated_at: provider_versions.created_at,
    })
    .from(provider_versions)
    .where(and(
      eq(provider_versions.provider_id, providerId),
      eq(provider_versions.version, version),
    ))
    .limit(1) as any[];
  return rows[0] ?? null;
}

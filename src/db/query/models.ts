import { eq, and, sql, desc, asc, gte, like, getTableColumns } from 'drizzle-orm';
import { getDrizzleDb } from '../index.js';
import { models, model_providers, providers, pricing } from '../schema.js';
import type { DbModel } from '../schema.js';

// ── Models (for model-resolver) ───────────────────────────────────────────

export async function getModelByNameOrId(nameOrId: string): Promise<(DbModel & { api_model_id: string; env_var: string | null; provider_adapter: string }) | null> {
  const db = getDrizzleDb();
  const rows = await db.select({
    id: models.id, name: models.name, family: models.family,
    provider_id: models.provider_id, release_date: models.release_date,
    attachment: models.attachment, reasoning: models.reasoning,
    temperature: models.temperature, tool_call: models.tool_call,
    interleaved: models.interleaved, status: models.status,
    context_limit: models.context_limit, output_limit: models.output_limit,
    api_model_id: model_providers.api_model_id,
    env_var: providers.env_var,
    provider_adapter: providers.adapter,
  })
    .from(models)
    .innerJoin(model_providers, eq(model_providers.model_id, models.id))
    .innerJoin(providers, eq(providers.id, model_providers.provider_id))
    .where(sql`${models.name} = ${nameOrId} OR ${models.id} = ${nameOrId}`)
    .limit(1);
  return rows[0] as any;
}

// ── Models (catalog listing) ──────────────────────────────────────────────

export async function listModelsWithPricing(): Promise<any[]> {
  const db = getDrizzleDb();
  return db.select({
    id: models.id, name: models.name, family: models.family,
    provider_id: models.provider_id, reasoning: models.reasoning,
    tool_call: models.tool_call, context_limit: models.context_limit,
    output_limit: models.output_limit, status: models.status,
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), sql`${pricing.tier_size} = 0`))
    .orderBy(models.name) as any;
}

// ── Dashboard: catalog + model helpers ────────────────────────────────────

export async function listCatalogModels(filters: {
  provider?: string; reasoning?: boolean; toolCall?: boolean;
  minContext?: number; sort?: string; q?: string;
}): Promise<any[]> {
  const db = getDrizzleDb();
  const conds: any[] = [];
  if (filters.provider) conds.push(eq(models.provider_id, filters.provider));
  if (filters.reasoning) conds.push(eq(models.reasoning, 1));
  if (filters.toolCall) conds.push(eq(models.tool_call, 1));
  if (filters.minContext != null) conds.push(gte(models.context_limit, filters.minContext));
  if (filters.q) conds.push(like(sql`lower(${models.name})`, `%${filters.q.toLowerCase()}%`));
  const order = filters.sort === 'context' ? desc(models.context_limit) : asc(models.name);
  return db.select({
    id: models.id, name: models.name, family: models.family, provider_id: models.provider_id,
    release_date: models.release_date, attachment: models.attachment, reasoning: models.reasoning,
    temperature: models.temperature, tool_call: models.tool_call,
    context_limit: models.context_limit, output_limit: models.output_limit,
    status: models.status, reasoning_options: models.reasoning_options,
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(order) as any;
}

export async function getModelDetail(modelId: string): Promise<any[]> {
  const db = getDrizzleDb();
  return db.select({
    ...getTableColumns(models),
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
    tier_size: pricing.tier_size,
  })
    .from(models)
    .leftJoin(pricing, and(eq(pricing.model_id, models.id), eq(pricing.tier_size, 0)))
    .where(eq(models.id, modelId)) as any;
}

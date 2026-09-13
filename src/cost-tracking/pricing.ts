import { getDrizzleDb, getDriver } from '../db/index.js';
import { pricing, models } from '../db/schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { type ModelPricing, type CostTokenUsage, type CostBreakdown } from './types.js';
import type { TokenUsage } from '../types.js';

interface PricingRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

interface Over200kRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

const pricingCache = new Map<string, PricingRow>();

/** Cache key includes the DB identity so tests and DB swaps never serve stale cross-DB entries. */
function cacheKey(modelId: string): string {
  return `${getDriver()}|${modelId}`;
}

/** Look up per-model pricing from the SQLite catalog. Returns null if not found. */
export async function getModelPricing(modelId: string): Promise<PricingRow | null> {
  try {
    const key = cacheKey(modelId);
    const cached = pricingCache.get(key);
    if (cached !== undefined) return cached;
    const result = await queryModelPricing(modelId);
    if (result) pricingCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

async function queryModelPricing(modelId: string): Promise<PricingRow | null> {
  const db = getDrizzleDb();
  const rows = await db.select({
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.tier_size} = 0`)).limit(1) as PricingRow[];
  let direct = rows[0] ?? null;
  if (direct && (direct.input != null || direct.output != null)) return direct;
  // Fall back: treat `modelId` as a friendly name and resolve via the catalog.
  const modelRows = await db.select({ id: models.id }).from(models).where(sql`${models.name} = ${modelId} OR ${models.id} = ${modelId}`).limit(1);
  if (!modelRows.length) return null;
  const fallback = await db.select({
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  }).from(pricing).where(and(eq(pricing.model_id, modelRows[0].id), sql`${pricing.tier_size} = 0`)).limit(1) as PricingRow[];
  return fallback[0] ?? null;
}

export async function getPricing(modelName: string): Promise<ModelPricing | undefined> {
  const p = await getModelPricing(modelName);
  if (!p) return undefined;
  return {
    input: p.input ?? 0,
    output: p.output ?? 0,
    cached: p.cache_read ?? p.cache_write ?? 0,
    cache_write: p.cache_write ?? 0,
  };
}

export async function computeCost(modelName: string, usage: CostTokenUsage): Promise<CostBreakdown> {
  const row = await getModelPricing(modelName);
  if (!row) {
    return { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  }

  const promptTokens = usage.prompt ?? 0;
  const completionTokens = usage.completion ?? 0;
  const cachedTokens = usage.cached ?? 0;
  const cacheWriteTokens = usage.cacheWrite ?? 0;

  // Tier selection is per request, not per run: callers must pass one call's
  // usage (see computeTotalCost), or a run's calls would all pay the premium.
  const isOver200k = promptTokens + completionTokens > 200_000;
  const tieredPricing = isOver200k ? await getTieredPricing(modelName) : null;

  const inputPrice = tieredPricing?.input ?? row.input ?? 0;
  const outputPrice = tieredPricing?.output ?? row.output ?? 0;
  // Cache prices are optional in the catalog. A token category with no price
  // (including no tier price) is billed as ordinary input rather than zeroed
  // out by a defaulted cache price.
  const cacheReadPrice = tieredPricing?.cache_read ?? row.cache_read ?? row.cache_write;
  const cacheWritePrice = tieredPricing?.cache_write ?? row.cache_write;
  // `prompt` counts every input token; priced cache tokens are billed at their
  // own price, so only the remainder pays the input price. Clamped so a provider
  // reporting cache tokens additively cannot drive the remainder negative.
  const inputTokens = Math.max(0,
    promptTokens
    - (cacheReadPrice != null ? cachedTokens : 0)
    - (cacheWritePrice != null ? cacheWriteTokens : 0));

  // Catalog prices are USD per 1M tokens (models.dev convention).
  const inputCost = (inputTokens / 1_000_000) * inputPrice;
  const outputCost = (completionTokens / 1_000_000) * outputPrice;
  const cachedCost = cacheReadPrice != null ? (cachedTokens / 1_000_000) * cacheReadPrice : 0;
  const cacheWriteCost = cacheWritePrice != null ? (cacheWriteTokens / 1_000_000) * cacheWritePrice : 0;

  return {
    inputCost,
    outputCost,
    cachedCost: cachedCost + cacheWriteCost,
    total: inputCost + outputCost + cachedCost + cacheWriteCost,
  };
}

/** Map the loop's canonical TokenUsage onto the billing shape. */
function toCostUsage(usage: TokenUsage): CostTokenUsage {
  return {
    prompt: usage.prompt ?? 0,
    completion: usage.completion ?? 0,
    cached: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
  };
}

/**
 * Total cost for a run: sum each model call's cost so the over-200k tier is
 * applied per request. Falls back to the aggregate usage when no per-call list
 * exists (e.g. resumed legacy runs that predate usagePerCall).
 */
export async function computeTotalCost(
  modelName: string,
  perCallUsage: TokenUsage[] | undefined,
  aggregateUsage: TokenUsage,
): Promise<CostBreakdown> {
  const calls = perCallUsage && perCallUsage.length > 0 ? perCallUsage : [aggregateUsage];
  const total: CostBreakdown = { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  for (const usage of calls) {
    const cost = await computeCost(modelName, toCostUsage(usage));
    total.inputCost += cost.inputCost;
    total.outputCost += cost.outputCost;
    total.cachedCost += cost.cachedCost;
    total.total += cost.total;
  }
  return total;
}

async function getTieredPricing(modelId: string): Promise<{ input: number; output: number; cache_read: number | null; cache_write: number | null } | null> {
  try {
    const db = getDrizzleDb();
    const rows = await db.select({
      input: pricing.over_200k_input,
      output: pricing.over_200k_output,
      cache_read: pricing.over_200k_cache_read,
      cache_write: pricing.over_200k_cache_write,
    }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.over_200k_input} IS NOT NULL`)).limit(1) as Over200kRow[];
    const row = rows[0];
    if (!row || row.input == null) return null;
    let output = row.output;
    if (output == null) {
      // Prefer the largest tier's output price over falling back to the input price.
      const tierRows = await db.select({ output: pricing.output })
        .from(pricing)
        .where(and(eq(pricing.model_id, modelId), sql`${pricing.tier_size} > 200000`))
        .orderBy(desc(pricing.tier_size))
        .limit(1) as Array<{ output: number | null }>;
      output = tierRows[0]?.output ?? row.input;
    }
    return {
      input: row.input,
      output: output ?? row.input,
      cache_read: row.cache_read,
      cache_write: row.cache_write,
    };
  } catch {
    return null;
  }
}

/** Clear the in-memory pricing cache so subsequent lookups re-read the catalog. */
export function resetPricingCache(): void {
  pricingCache.clear();
}

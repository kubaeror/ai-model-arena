import { getDrizzleDb, getDb } from '../db/index.js';
import { pricing, models } from '../db/schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import { type ModelPricing, type CostTokenUsage, type CostBreakdown } from './types.js';

interface PricingRow {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

const pricingCache = new Map<string, PricingRow>();

/** Cache key includes the DB identity so tests and DB swaps never serve stale cross-DB entries. */
function cacheKey(modelId: string): string {
  try {
    return `${getDb().name}|${modelId}`;
  } catch {
    return `postgres|${modelId}`;
  }
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
  }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.tier_size} = 0`)).limit(1) as any[];
  let direct = rows[0] as PricingRow | null;
  if (direct && (direct.input != null || direct.output != null)) return direct;
  // Fall back: treat `modelId` as a friendly name and resolve via the catalog.
  const modelRows = await db.select({ id: models.id }).from(models).where(sql`${models.name} = ${modelId} OR ${models.id} = ${modelId}`).limit(1);
  if (!modelRows.length) return null;
  const fallback = await db.select({
    input: pricing.input, output: pricing.output,
    cache_read: pricing.cache_read, cache_write: pricing.cache_write,
  }).from(pricing).where(and(eq(pricing.model_id, modelRows[0].id), sql`${pricing.tier_size} = 0`)).limit(1) as any[];
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
  const pricingData = await getPricing(modelName);
  if (!pricingData) {
    return { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  }

  const totalTokens = (usage.prompt ?? 0) + (usage.completion ?? 0);
  const isOver200k = totalTokens > 200_000;
  const tieredPricing = isOver200k ? await getTieredPricing(modelName) : null;

  const inputPrice = tieredPricing?.input ?? pricingData.input;
  const outputPrice = tieredPricing?.output ?? pricingData.output;
  const cachedPrice = tieredPricing?.cache_read ?? pricingData.cached;

  const inputCost = ((usage.prompt ?? 0) / 1000) * inputPrice;
  const outputCost = ((usage.completion ?? 0) / 1000) * outputPrice;
  const cachedCost = ((usage.cached ?? 0) / 1000) * cachedPrice;

  return {
    inputCost,
    outputCost,
    cachedCost,
    total: inputCost + outputCost + cachedCost,
  };
}

async function getTieredPricing(modelId: string): Promise<{ input: number; output: number; cache_read: number | null } | null> {
  try {
    const db = getDrizzleDb();
    const rows = await db.select({
      input: pricing.over_200k_input,
      output: pricing.over_200k_output,
      cache_read: pricing.over_200k_cache_read,
    }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.over_200k_input} IS NOT NULL`)).limit(1) as any[];
    if (!rows.length || rows[0].input == null) return null;
    let output = rows[0].output as number | null;
    if (output == null) {
      // Prefer the largest tier's output price over falling back to the input price.
      const tierRows = await db.select({ output: pricing.output })
        .from(pricing)
        .where(and(eq(pricing.model_id, modelId), sql`${pricing.tier_size} > 200000`))
        .orderBy(desc(pricing.tier_size))
        .limit(1) as any[];
      output = tierRows[0]?.output ?? rows[0].input;
    }
    return {
      input: rows[0].input,
      output: output ?? rows[0].input,
      cache_read: rows[0].cache_read as number | null,
    };
  } catch {
    return null;
  }
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Clear the in-memory pricing cache so subsequent lookups re-read the catalog. */
export function resetPricingCache(): void {
  pricingCache.clear();
}

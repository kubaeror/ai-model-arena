import { getDrizzleDb } from '../db/index.js';
import { pricing, models } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { type ModelPricing, type CostTokenUsage, type CostBreakdown } from './types.js';

/** Look up per-model pricing from the SQLite catalog. Returns null if not found. */
export async function getModelPricing(modelId: string): Promise<{ input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | null> {
  try {
    const db = getDrizzleDb();
    const rows = await db.select({
      input: pricing.input, output: pricing.output,
      cache_read: pricing.cache_read, cache_write: pricing.cache_write,
    }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.tier_size} IS NULL`)).limit(1) as any[];
    let direct = rows[0] as { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | null;
    if (direct && (direct.input != null || direct.output != null)) return direct;
    // Fall back: treat `modelId` as a friendly name and resolve via the catalog.
    const modelRows = await db.select({ id: models.id }).from(models).where(sql`${models.name} = ${modelId} OR ${models.id} = ${modelId}`).limit(1);
    if (!modelRows.length) return null;
    const fallback = await db.select({
      input: pricing.input, output: pricing.output,
      cache_read: pricing.cache_read, cache_write: pricing.cache_write,
    }).from(pricing).where(and(eq(pricing.model_id, modelRows[0].id), sql`${pricing.tier_size} IS NULL`)).limit(1) as any[];
    return fallback[0] ?? null;
  } catch {
    return null;
  }
}

export async function getPricing(modelName: string): Promise<ModelPricing | undefined> {
  const p = await getModelPricing(modelName);
  if (!p) return undefined;
  return {
    input: p.input ?? 0,
    output: p.output ?? 0,
    cached: p.cache_read ?? 0,
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
  const cachedPrice = tieredPricing?.cache_read ?? (pricingData.cached ?? 0);

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

async function getTieredPricing(modelId: string): Promise<{ input: number; output: number; cache_read: number } | null> {
  try {
    const db = getDrizzleDb();
    const rows = await db.select({
      input: pricing.over_200k_input,
      output: pricing.over_200k_output,
      cache_read: pricing.over_200k_cache_read,
    }).from(pricing).where(and(eq(pricing.model_id, modelId), sql`${pricing.over_200k_input} IS NOT NULL`)).limit(1) as any[];
    if (!rows.length || rows[0].input == null) return null;
    return {
      input: rows[0].input,
      output: rows[0].output ?? rows[0].input,
      cache_read: rows[0].cache_read ?? 0,
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

/** No-op — pricing is sourced exclusively from SQLite. Retained for import compatibility. */
export function resetPricingCache(): void {}

import { type ModelPricing, type TokenUsage, type CostBreakdown } from './types.js';
import { getDb } from '../db/index.js';

/** Look up per-model pricing from the SQLite catalog. Returns null if not found. */
export function getModelPricing(modelId: string): { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | null {
  try {
    const db = getDb();
    const direct = db.prepare('SELECT input, output, cache_read, cache_write FROM pricing WHERE model_id = ? AND tier_size IS NULL').get(modelId) as { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | undefined;
    if (direct) return direct;
    // Fall back: treat `modelId` as a friendly name and resolve via the catalog.
    const row = db.prepare('SELECT id FROM models WHERE name = ? OR id = ? LIMIT 1').get(modelId, modelId) as { id: string } | undefined;
    if (!row) return null;
    const fallback = db.prepare('SELECT input, output, cache_read, cache_write FROM pricing WHERE model_id = ? AND tier_size IS NULL').get(row.id) as { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null } | undefined;
    return fallback ?? null;
  } catch {
    return null;
  }
}

export function getPricing(modelName: string): ModelPricing | undefined {
  const p = getModelPricing(modelName);
  if (!p) return undefined;
  return {
    input: p.input ?? 0,
    output: p.output ?? 0,
    cached: p.cache_read ?? 0,
  };
}

export function computeCost(modelName: string, usage: TokenUsage): CostBreakdown {
  const pricing = getPricing(modelName);
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  }

  const totalTokens = (usage.prompt ?? 0) + (usage.completion ?? 0);
  // Use tiered pricing if context exceeds 200K tokens and tiered rates exist
  const isOver200k = totalTokens > 200_000;
  const tieredPricing = isOver200k ? getTieredPricing(modelName) : null;

  const inputPrice = tieredPricing?.input ?? pricing.input;
  const outputPrice = tieredPricing?.output ?? pricing.output;
  const cachedPrice = tieredPricing?.cache_read ?? (pricing.cached ?? 0);

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

function getTieredPricing(modelId: string): { input: number; output: number; cache_read: number } | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT over_200k_input, over_200k_output, over_200k_cache_read FROM pricing WHERE model_id = ? AND over_200k_input IS NOT NULL LIMIT 1',
    ).get(modelId) as Record<string, number | null> | undefined;
    if (!row || row.over_200k_input == null) return null;
    return {
      input: row.over_200k_input,
      output: row.over_200k_output ?? row.over_200k_input,
      cache_read: row.over_200k_cache_read ?? 0,
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

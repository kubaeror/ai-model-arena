import { type ModelPricing, type TokenUsage, type CostBreakdown } from './types.js';
import { getDb } from '../db/client.js';

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

  const inputCost = ((usage.prompt ?? 0) / 1000) * pricing.input;
  const outputCost = ((usage.completion ?? 0) / 1000) * pricing.output;
  const cachedCost = ((usage.cached ?? 0) / 1000) * (pricing.cached ?? 0);

  return {
    inputCost,
    outputCost,
    cachedCost,
    total: inputCost + outputCost + cachedCost,
  };
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** No-op — pricing is sourced exclusively from SQLite. Retained for import compatibility. */
export function resetPricingCache(): void {}

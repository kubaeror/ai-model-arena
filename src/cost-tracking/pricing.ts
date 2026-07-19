import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Logger } from '../types.js';
import { PricingConfigSchema, type PricingConfig, type ModelPricing, type TokenUsage, type CostBreakdown } from './types.js';

let pricingConfig: PricingConfig | null = null;

export function loadPricingConfig(configPath: string, logger?: Logger): PricingConfig {
  if (pricingConfig) return pricingConfig;
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback: PricingConfig = { models: {} };
    logger?.warn(`Pricing config not found at ${resolvedPath}, using empty config`);
    pricingConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = yaml.load(content);
  const validated = PricingConfigSchema.parse(parsed);
  pricingConfig = validated;
  return validated;
}

export function getPricing(modelName: string): ModelPricing | undefined {
  if (!pricingConfig) return undefined;
  return pricingConfig.models[modelName];
}

export function computeCost(modelName: string, usage: TokenUsage): CostBreakdown {
  const pricing = getPricing(modelName);
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, cachedCost: 0, total: 0 };
  }
  
  const inputCost = (usage.prompt / 1000) * pricing.input;
  const outputCost = (usage.completion / 1000) * pricing.output;
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

export function resetPricingCache(): void {
  pricingConfig = null;
}

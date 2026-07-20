export * from './types.js';
export { getPricing, computeCost, formatCost, resetPricingCache } from './pricing.js';
export { 
  loadBudgetConfig, 
  checkBudget, 
  addSpend, 
  saveBudgetState, 
  getBudgetStatus, 
  resetBudgetCache 
} from './budget.js';

import type { TokenUsage } from './types.js';

export function tokenUsageFromPartial(partial: { prompt?: number; completion?: number; total?: number; cached?: number }): TokenUsage {
  return {
    prompt: partial.prompt ?? 0,
    completion: partial.completion ?? 0,
    cached: partial.cached ?? 0,
  };
}

export function sumTokenUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      prompt: acc.prompt + (u.prompt ?? 0),
      completion: acc.completion + (u.completion ?? 0),
      cached: (acc.cached ?? 0) + (u.cached ?? 0),
    }),
    { prompt: 0, completion: 0, cached: 0 }
  );
}

export function ensureTokenUsage(tu?: TokenUsage): TokenUsage {
  return {
    prompt: tu?.prompt ?? 0,
    completion: tu?.completion ?? 0,
    cached: tu?.cached ?? 0,
  };
}

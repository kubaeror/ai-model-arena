export * from './types.js';
export { getPricing, computeCost, formatCost, resetPricingCache } from './pricing.js';
export { 
  loadBudgetConfig, 
  checkBudget, 
  addSpend, 
  saveBudgetState, 
  getBudgetStatus,
  reserveBudget,
  releaseReservation,
  resetBudgetCache 
} from './budget.js';

import type { CostTokenUsage } from './types.js';

export function tokenUsageFromPartial(partial: { prompt?: number; completion?: number; total?: number; cached?: number }): CostTokenUsage {
  return {
    prompt: partial.prompt ?? 0,
    completion: partial.completion ?? 0,
    cached: partial.cached ?? 0,
  };
}

export function sumTokenUsage(usages: CostTokenUsage[]): CostTokenUsage {
  return usages.reduce(
    (acc, u) => ({
      prompt: acc.prompt + (u.prompt ?? 0),
      completion: acc.completion + (u.completion ?? 0),
      cached: (acc.cached ?? 0) + (u.cached ?? 0),
    }),
    { prompt: 0, completion: 0, cached: 0 }
  );
}

export function ensureTokenUsage(tu?: CostTokenUsage): CostTokenUsage {
  return {
    prompt: tu?.prompt ?? 0,
    completion: tu?.completion ?? 0,
    cached: tu?.cached ?? 0,
  };
}

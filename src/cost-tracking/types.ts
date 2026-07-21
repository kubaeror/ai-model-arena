import { z } from 'zod';

export const PricingSchema = z.record(z.string(), z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cached: z.number().min(0).optional().default(0),
}));

export const PricingConfigSchema = z.object({
  models: PricingSchema,
});

export const BudgetThresholdsSchema = z.object({
  warn: z.number().min(0).max(100).default(80),
  block: z.number().min(0).max(100).default(100),
});

export const ModelBudgetSchema = z.object({
  daily: z.number().min(0).nullable().optional(),
  monthly: z.number().min(0).nullable().optional(),
});

export const BudgetConfigSchema = z.object({
  global: z.object({
    daily: z.number().min(0).nullable().optional(),
    monthly: z.number().min(0).nullable().optional(),
  }).optional(),
  models: z.record(z.string(), ModelBudgetSchema).optional(),
  thresholds: BudgetThresholdsSchema.optional(),
  stateFile: z.string().default('outputs/.budget-state.json'),
});

export type PricingConfig = z.output<typeof PricingConfigSchema>;
export type BudgetConfig = z.output<typeof BudgetConfigSchema>;
export type ModelPricing = z.output<typeof PricingSchema>[string];

export interface BudgetState {
  global: {
    daily: Record<string, number>;
    monthly: Record<string, number>;
  };
  models: Record<string, {
    daily: Record<string, number>;
    monthly: Record<string, number>;
  }>;
  lastReset: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  cached?: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cachedCost: number;
  total: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  spentUsd: number;
  limitUsd: number | null;
  percentUsed: number;
}

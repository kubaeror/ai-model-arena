import { z } from 'zod';

export const RubricItemSchema = z.object({
  description: z.string(),
  maxScore: z.number().min(0).max(10),
});

export const RubricSchema = z.record(z.string(), RubricItemSchema);

export const JudgeConfigSchema = z.object({
  model: z.string().default('gpt-4o'),
  enabled: z.boolean().default(true),
});

export const RegressionThresholdsSchema = z.object({
  scoreDrop: z.number().min(0).default(1.0),
  tokenIncrease: z.number().min(0).default(0.5),
  timeIncrease: z.number().min(0).default(0.5),
});

export const RegressionConfigSchema = z.object({
  baselineDir: z.string().default('outputs/baselines'),
  thresholds: RegressionThresholdsSchema.optional(),
  failOnRegression: z.boolean().default(true),
});

export const EvaluationConfigSchema = z.object({
  judge: JudgeConfigSchema.optional(),
  rubric: RubricSchema.optional(),
  regression: RegressionConfigSchema.optional(),
});

export type Rubric = z.output<typeof RubricSchema>;
export type EvaluationConfig = z.output<typeof EvaluationConfigSchema>;

export interface JudgeScore {
  category: string;
  score: number;
  /** Optional — scoring falls back to a plain mean when absent. */
  maxScore?: number;
  reasoning?: string;
}

export interface JudgeResult {
  model: string;
  runId: string;
  scores: JudgeScore[];
  averageScore: number;
  summary: string;
  judgedAt: string;
  judgeModel: string;
}

export interface BaselineSnapshot {
  runId: string;
  model: string;
  scenario: string;
  timestamp: string;
  metrics: {
    averageScore: number;
    totalTokens: number;
    durationMs: number;
    success: boolean;
  };
}

export interface RegressionResult {
  passed: boolean;
  regressions: Array<{
    metric: string;
    baseline: number;
    current: number;
    change: number;
    threshold: number;
  }>;
}

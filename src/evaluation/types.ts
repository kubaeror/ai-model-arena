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

export const RollbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  failPrompt: z.string().optional(),
});

export const EvaluationConfigSchema = z.object({
  judge: JudgeConfigSchema.optional(),
  rubric: RubricSchema.optional(),
  regression: RegressionConfigSchema.optional(),
  rollback: RollbackConfigSchema.optional(),
});

export type RubricItem = z.infer<typeof RubricItemSchema>;
export type Rubric = z.infer<typeof RubricSchema>;
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;
export type RegressionConfig = z.infer<typeof RegressionConfigSchema>;

export interface JudgeScore {
  category: string;
  score: number;
  maxScore: number;
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

export type { JudgeResult as JudgeResultType };

export interface ObjectiveMetrics {
  accepted_change_rate: number;
  turns_used: number;
  max_turns: number;
  turns_remaining: number;
  turn_efficiency: number;
  cycle_time_seconds: number;
  tool_call_stats: {
    total: number;
    failed: number;
    redundant: number;
    loops: number;
    validation_errors: number;
  };
  success: boolean;
  cost_usd: number;
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

export interface ToolCallRecord {
  turn: number;
  name: string;
  arguments: Record<string, unknown>;
  success: boolean;
}

export interface LoopDetection {
  type: 'back_to_back' | 'cycle';
  turns: number[];
  tools: string[];
  description: string;
}

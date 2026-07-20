import { z } from 'zod';

export const RegressionSuiteConfigSchema = z.object({
  models: z.array(z.string()).min(1),
  scenarios: z.array(z.string()).min(1),
  baselineDir: z.string().default('outputs/baselines'),
  thresholds: z.object({
    scoreDrop: z.number().default(1.0),
    tokenIncrease: z.number().default(0.5),
    timeIncrease: z.number().default(0.5),
  }).default({}),
});
export type RegressionSuiteConfig = z.infer<typeof RegressionSuiteConfigSchema>;

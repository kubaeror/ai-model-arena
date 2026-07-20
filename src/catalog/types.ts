import { z } from 'zod';

export const ModelsDevCostSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  tiers: z.array(z.object({
    input: z.number(), output: z.number(),
    cache_read: z.number().optional(), cache_write: z.number().optional(),
    tier: z.object({ type: z.string(), size: z.number() }),
  })).optional(),
  context_over_200k: z.object({
    input: z.number(), output: z.number(),
    cache_read: z.number().optional(), cache_write: z.number().optional(),
  }).optional(),
}).optional();

export const ModelsDevLimitSchema = z.object({
  context: z.number(),
  input: z.number().optional(),
  output: z.number(),
});

export const ModelsDevReasoningOptionSchema = z.object({
  type: z.enum(['effort', 'toggle', 'budget_tokens']),
  // provider-specific extra fields tolerated
}).passthrough();

export const ModelsDevModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string().optional(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  interleaved: z.union([z.literal(true), z.object({ field: z.string() })]).optional(),
  reasoning_options: z.array(ModelsDevReasoningOptionSchema).optional(),
  cost: ModelsDevCostSchema,
  limit: ModelsDevLimitSchema,
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
  status: z.enum(['alpha', 'beta', 'deprecated']).optional(),
}).passthrough();

export const ModelsDevProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  api: z.string().optional(),
  npm: z.string().optional(),
  env: z.array(z.string()),
  models: z.record(z.string(), ModelsDevModelSchema),
}).passthrough();

export const ModelsDevResponseSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevResponse = z.infer<typeof ModelsDevResponseSchema>;

export const ModelbenchModelSchema = z.object({
  slug: z.string(),
  name: z.string(),
  developer: z.string().optional(),
  context_length: z.number().optional(),
  input_price_per_million: z.number().optional(),
  output_price_per_million: z.number().optional(),
  cached_input_price_per_million: z.number().optional(),
  intelligence_score: z.number().optional(),
  coding_score: z.number().optional(),
  agentic_score: z.number().optional(),
  speed_tps: z.number().optional(),
  benchmark_data: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(),
}).passthrough();

export const ModelbenchResponseSchema = z.object({
  data: z.array(ModelbenchModelSchema),
  meta: z.object({ page: z.number(), limit: z.number(), total: z.number() }).optional(),
});

export const ZeroEvalModelSchema = z.record(z.string(), z.unknown());

export type ModelbenchModel = z.infer<typeof ModelbenchModelSchema>;
export type ModelbenchResponse = z.infer<typeof ModelbenchResponseSchema>;

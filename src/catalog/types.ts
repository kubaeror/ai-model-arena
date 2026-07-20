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

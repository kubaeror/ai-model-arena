import { z } from 'zod/v4';

export function validateArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(args);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: `Invalid arguments: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
}

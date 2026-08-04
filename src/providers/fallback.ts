import { z } from 'zod/v4';

export interface FallbackConfig {
  primary: { provider: string; model: string; };
  fallbacks: Array<{ provider: string; model: string; }>;
}

const FallbackConfigSchema = z.object({
  primary: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  fallbacks: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).default([]),
});

/**
 * Load a fallback chain from ARENA_FALLBACK_CHAIN (JSON):
 *   {"primary":{"provider":"openai","model":"gpt-4o"},
 *    "fallbacks":[{"provider":"anthropic","model":"claude-sonnet-4"}]}
 * Returns undefined when unset or malformed (fail open: no fallback).
 */
export function loadFallbackChainFromEnv(): FallbackConfig | undefined {
  const raw = process.env.ARENA_FALLBACK_CHAIN;
  if (!raw) return undefined;
  try {
    return FallbackConfigSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function resolveFallback(
  current: { provider: string; model: string; },
  chain: FallbackConfig,
): { provider: string; model: string; } | null {
  const all = [chain.primary, ...chain.fallbacks];
  const idx = all.findIndex(f => f.provider === current.provider && f.model === current.model);
  if (idx < 0 || idx >= all.length - 1) return null;
  return all[idx + 1]!;
}

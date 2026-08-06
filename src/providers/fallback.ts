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

/** Default number of fallback hops when ARENA_MAX_FALLBACK_HOPS is unset. */
const DEFAULT_MAX_FALLBACK_HOPS = 3;

/** Upper bound for ARENA_MAX_FALLBACK_HOPS. */
const MAX_FALLBACK_HOPS_CAP = 10;

/**
 * Resolve the fallback hop limit from ARENA_MAX_FALLBACK_HOPS.
 * Parses the env value as an integer (default 3 on missing/empty/unparseable)
 * and clamps it to [0, 10]. 0 disables fallback entirely.
 */
export function resolveMaxFallbackHops(raw: string | undefined = process.env.ARENA_MAX_FALLBACK_HOPS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_FALLBACK_HOPS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_MAX_FALLBACK_HOPS;
  return Math.min(MAX_FALLBACK_HOPS_CAP, Math.max(0, parsed));
}

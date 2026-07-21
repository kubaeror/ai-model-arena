export interface FallbackConfig {
  primary: { provider: string; model: string; };
  fallbacks: Array<{ provider: string; model: string; }>;
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

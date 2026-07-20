import type { TokenUsage } from '../types.js';

export interface CacheMetrics {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
}

export function extractCacheMetrics(usage: TokenUsage): CacheMetrics {
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const prompt = usage.prompt ?? 0;
  const cacheHitRate = prompt > 0 ? cacheReadTokens / prompt : 0;
  return { cacheReadTokens, cacheWriteTokens, cacheHitRate };
}

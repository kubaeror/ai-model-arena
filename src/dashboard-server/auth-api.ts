import path from 'node:path';
import { z } from 'zod';
import type { Response, NextFunction, Request } from 'express';
import type { Logger } from '../types.js';
import { loadYamlConfigSync } from '../config-loader.js';
import type { ApiKeysConfig, ApiKeyPermission, RequestContext, RateLimitState } from './auth-api-types.js';
import { ApiKeysConfigSchema } from './auth-api-types.js';
import { timingSafeEqual } from '../auth/timing-safe.js';

const rateLimitStore = new Map<string, RateLimitState>();
let apiKeysConfig: ApiKeysConfig | null = null;
let apiKeyMap: Map<string, RequestContext> | null = null;
let rateLimitPrunerStarted = false;
let rateLimitPrunerHandle: NodeJS.Timeout | null = null;

// Env expansion happens inside the shared loader; the permissive schema keeps
// empty-key entries parseable so the filter below can drop them pre-validation
// (matching the original order: filter before ApiKeysConfigSchema.parse).
const RawApiKeysConfigSchema = z.unknown();
const API_KEYS_FALLBACK: ApiKeysConfig = { apiKeys: [] };

export function loadApiKeysConfig(configPath: string, logger?: Logger): ApiKeysConfig {
  if (apiKeysConfig) return apiKeysConfig;

  const loaded = loadYamlConfigSync({
    filePath: configPath,
    schema: RawApiKeysConfigSchema,
    fallback: API_KEYS_FALLBACK,
    expandEnv: true,
    logger,
    missingMessage: `API keys config not found at ${path.resolve(configPath)}, API key auth disabled`,
  });

  // The loader returns the fallback by reference when the file is missing;
  // in that case keep the original semantics (no apiKeyMap, no pruner).
  if (loaded === API_KEYS_FALLBACK) {
    apiKeysConfig = API_KEYS_FALLBACK;
    return API_KEYS_FALLBACK;
  }

  const raw = loaded as { apiKeys?: unknown[] } | null;
  // Drop API-key entries whose `key` resolved to null/empty (env var unset)
  // instead of crashing the server — an unset key is simply not registered.
  const apiKeys = Array.isArray(raw?.apiKeys)
    ? raw!.apiKeys.filter((entry): entry is Record<string, unknown> => {
        if (!entry || typeof entry !== 'object') return false;
        const k = (entry as Record<string, unknown>).key;
        return typeof k === 'string' && k.length > 0;
      })
    : [];
  const validated = ApiKeysConfigSchema.parse({ apiKeys });
  apiKeysConfig = validated;
  apiKeyMap = new Map(
    validated.apiKeys.map((k) => [k.key, {
      keyName: k.name,
      permissions: k.permissions,
      rateLimit: k.rateLimit,
    }]),
  );
  if (!rateLimitPrunerStarted) {
    rateLimitPrunerStarted = true;
    rateLimitPrunerHandle = setInterval(() => {
      const currentBucket = Math.floor(Date.now() / 60_000);
      for (const key of rateLimitStore.keys()) {
        const parts = key.split(':');
        const bucket = Number(parts[parts.length - 1]);
        if (bucket < currentBucket - 2) rateLimitStore.delete(key);
      }
    }, 120_000);
    rateLimitPrunerHandle.unref();
  }
  return validated;
}

function findApiKey(key: string): RequestContext | null {
  if (!apiKeyMap) return null;
  let found: RequestContext | null = null;
  // Always iterate all entries for timing-safety (no early-exit on match).
  for (const [storedKey, ctx] of apiKeyMap) {
    if (timingSafeEqual(key, storedKey)) found = ctx;
  }
  return found;
}

function checkPermission(ctx: RequestContext, permission: ApiKeyPermission): boolean {
  return ctx.permissions.includes(permission);
}

function checkRateLimit(ctx: RequestContext): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const key = `${ctx.keyName}:${minuteBucket}`;

  const state = rateLimitStore.get(key);
  if (!state) {
    rateLimitStore.set(key, { count: 0, resetAt: now + 60000 });
  }

  const currentState = rateLimitStore.get(key)!;
  const remaining = Math.max(0, ctx.rateLimit - currentState.count);
  const resetIn = Math.max(0, currentState.resetAt - now);

  if (currentState.count >= ctx.rateLimit) {
    return { allowed: false, remaining: 0, resetIn };
  }

  currentState.count++;
  return { allowed: true, remaining: remaining - 1, resetIn };
}

function useRedisRateLimiting(): boolean {
  return process.env.QUEUE_DRIVER === 'redis';
}

async function redisCheckRateLimit(ctx: RequestContext): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  try {
    const { redisCheckRateLimit } = await import('./rate-limit-redis.js');
    return await redisCheckRateLimit(ctx.keyName, ctx.rateLimit, 60_000);
  } catch {
    return checkRateLimit(ctx);
  }
}

export function requireApiKey(permissions: ApiKeyPermission[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = (req.headers as Record<string, string | string[] | undefined>)['x-api-key'];
    const apiKey = typeof authHeader === 'string' ? authHeader : Array.isArray(authHeader) ? authHeader[0] ?? '' : '';
    
    if (!apiKey) {
      res.status(401).json({ error: 'X-API-Key header required' });
      return;
    }
    
    const ctx = findApiKey(apiKey);
    if (!ctx) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    
    for (const perm of permissions) {
      if (!checkPermission(ctx, perm)) {
        res.status(403).json({ error: `Missing permission: ${perm}` });
        return;
      }
    }
    
    const rateLimit = useRedisRateLimiting()
      ? await redisCheckRateLimit(ctx)
      : checkRateLimit(ctx);
    if (!rateLimit.allowed) {
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rateLimit.resetIn });
      return;
    }
    
    res.setHeader('X-RateLimit-Remaining', String(rateLimit.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetIn / 1000)));
    
    (req as unknown as Record<string, unknown>).apiKey = ctx;
    next();
  };
}

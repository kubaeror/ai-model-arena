import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import type { Response, NextFunction, Request } from 'express';
import type { Logger } from '../types.js';
import type { ApiKeysConfig, ApiKeyPermission, RequestContext, RateLimitState } from './auth-api-types.js';
import { ApiKeysConfigSchema } from './auth-api-types.js';

function timingSafeEqualStr(a: string, b: string): boolean {
  const key = Buffer.alloc(32, 0);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const rateLimitStore = new Map<string, RateLimitState>();
let apiKeysConfig: ApiKeysConfig | null = null;
let apiKeyMap: Map<string, RequestContext> | null = null;
let rateLimitPrunerStarted = false;
let rateLimitPrunerHandle: NodeJS.Timeout | null = null;

function expandEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

export function loadApiKeysConfig(configPath: string, logger?: Logger): ApiKeysConfig {
  if (apiKeysConfig) return apiKeysConfig;
  
  const resolvedPath = path.resolve(configPath);
  if (!fs.existsSync(resolvedPath)) {
    const fallback = ApiKeysConfigSchema.parse({ apiKeys: [] });
    logger?.warn(`API keys config not found at ${resolvedPath}, API key auth disabled`);
    apiKeysConfig = fallback;
    return fallback;
  }
  
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const expanded = expandEnvVars(content);
  const rawParsed = yaml.load(expanded) as { apiKeys?: unknown[] } | null;
  // Drop API-key entries whose `key` resolved to null/empty (env var unset)
  // instead of crashing the server — an unset key is simply not registered.
  const apiKeys = Array.isArray(rawParsed?.apiKeys)
    ? rawParsed!.apiKeys.filter((entry): entry is Record<string, unknown> => {
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
    if (timingSafeEqualStr(key, storedKey)) found = ctx;
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

export function requireApiKey(permissions: ApiKeyPermission[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
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
    
    const rateLimit = checkRateLimit(ctx);
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

export function resetApiKeysCache(): void {
  apiKeysConfig = null;
  apiKeyMap = null;
  rateLimitStore.clear();
  rateLimitPrunerStarted = false;
  if (rateLimitPrunerHandle) {
    clearInterval(rateLimitPrunerHandle);
    rateLimitPrunerHandle = null;
  }
}
